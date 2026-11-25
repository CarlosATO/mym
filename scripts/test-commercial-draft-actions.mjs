import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = (await readFile(new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
globalThis.__draftActions = {
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) } }),
  getActiveCompanyId: async () => 'company',
  createSupabaseClient: () => globalThis.__draftClient ? globalThis.__draftClient() : ({ rpc: (...args) => globalThis.__draftRpc(...args) }),
}
const prefix = 'const {createClient,getActiveCompanyId,createSupabaseClient}=globalThis.__draftActions;\n'
const actions = await import(`data:text/javascript;base64,${Buffer.from(prefix + js).toString('base64')}`)

test('save forwards stable request identity and server errors without creating a second request', async () => {
  let calls = 0
  globalThis.__draftRpc = async (name, args) => {
    calls++
    assert.equal(name, 'save_commercial_draft_request')
    assert.equal(args.p_request_id, 'request')
    assert.equal(args.p_company_id, 'company')
    return { data: null, error: { code: 'P0001', message: 'El borrador cambió en otra sesión' } }
  }
  const response = await actions.saveCommercialDraft({ poId: 'po', requestId: 'request', revision: 4, data: { supplier_id: 'supplier', issue_date: '2026-11-24', items: [] } })
  assert.equal(calls, 1)
  assert.equal(response.definite, true)
  assert.match(response.error, /cambió/)
})

test('recovery retains line ID and exact commercial price, and detects concurrent edits', async () => {
  let revision = 3
  globalThis.__draftRpc = async name => {
    if (name === 'get_purchase_order_detail') return { data: { po: { id: 'po', status: 'BORRADOR', source_type: 'MANUAL' }, items: [{ id: 'line', quantity: 600, unit_price: 1666.6667, discount_percent: 10 }] }, error: null }
    assert.equal(name, 'get_commercial_draft_snapshots')
    return { data: { revision, lines: [{ id: 'line', purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, product_supplier_mapping_id: 'mapping', commercial_unit_price_snapshot: '10000.0000' }] }, error: null }
  }
  const recovered = await actions.getCommercialDraftDetail('po')
  assert.equal(recovered.data.detail.items[0].id, 'line')
  assert.equal(recovered.data.detail.items[0].commercial_unit_price_snapshot, '10000.0000')
  assert.equal(recovered.data.detail.items[0].discount_percent, 10)
  assert.equal(recovered.data.managed, true)
  let reads = 0
  const previous = globalThis.__draftRpc
  globalThis.__draftRpc = async (...args) => { if (args[0] === 'get_commercial_draft_snapshots' && ++reads === 2) revision++; return previous(...args) }
  assert.match((await actions.getCommercialDraftDetail('po')).error, /cambió durante la lectura/)
})

test('traditional manual drafts remain traditional; captured snapshots remain protected', async () => {
  let factor = null
  globalThis.__draftRpc = async name => name === 'get_purchase_order_detail'
    ? { data: { po: { id: 'po', status: 'BORRADOR', source_type: 'MANUAL' }, items: [{ id: 'line' }] }, error: null }
    : { data: { revision: 0, lines: [{ id: 'line', purchase_unit_snapshot: null, purchase_unit_factor_snapshot: factor, product_supplier_mapping_id: null, commercial_unit_price_snapshot: null }] }, error: null }
  assert.equal((await actions.getCommercialDraftDetail('po')).data.managed, false)
  factor = 1
  assert.equal((await actions.getCommercialDraftDetail('po')).data.managed, true)
})

test('the editor applies the managed classification and requires a saved revision for emission', async () => {
  const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /setIsCommercialDraft\(loaded\.data\.managed\)/)
  assert.match(panel, /setCommercialRevision\(loaded\.data\.managed \? loaded\.data\.revision : null\)/)
  assert.match(panel, /commercialRevision === null \|\| commercialChangesPending/)
  assert.match(panel, /await emitCommercialDraft\(editId, commercialRevision\)/)
})

test('emission forwards authenticated actor, company and revision to the RPC', async () => {
  globalThis.__draftRpc = async (name, args) => {
    assert.equal(name, 'emit_commercial_purchase_draft')
    assert.deepEqual(args, { p_po_id: 'po', p_expected_revision: 4, p_user_id: 'user', p_company_id: 'company' })
    return { data: { success: true, po_id: 'po', status: 'EMITIDA' }, error: null }
  }
  assert.equal((await actions.emitCommercialDraft('po', 4)).data.status, 'EMITIDA')
})

test('commercial send forwards the authenticated actor and company', async () => {
  globalThis.__draftRpc = async (name, args) => {
    assert.equal(name, 'send_commercial_purchase_order')
    assert.deepEqual(args, { p_po_id: 'po', p_user_id: 'user', p_company_id: 'company' })
    return { data: { success: true, po_id: 'po', status: 'ENVIADA_PROVEEDOR' }, error: null }
  }
  assert.equal((await actions.markCommercialOrderSent('po')).data.status, 'ENVIADA_PROVEEDOR')
})

test('issued detail identifies commercial orders and blocks when metadata is unavailable', async () => {
  let revision = 1, lookupError = false
  globalThis.__draftClient = () => ({
    rpc: async () => ({ data: { po: { id: 'po', status: 'EMITIDA' }, items: [] }, error: null }),
    from: table => {
      const query = { select: () => query, eq: () => query, not: () => query,
        maybeSingle: async () => ({ data: lookupError ? null : { commercial_draft_revision: revision }, error: lookupError ? {} : null }),
        limit: async () => ({ data: [], error: null }) }
      assert.ok(table === 'purchase_orders' || table === 'purchase_order_items')
      return query
    },
  })
  try {
    assert.equal((await actions.getPurchaseOrderDetail('po')).po.commercial_managed, true)
    revision = 0
    assert.equal((await actions.getPurchaseOrderDetail('po')).po.commercial_managed, false)
    lookupError = true
    assert.equal((await actions.getPurchaseOrderDetail('po')).po.commercial_managed, null)
  } finally { delete globalThis.__draftClient }
})
