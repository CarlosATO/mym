import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const action = await readFile(new URL('../src/app/actions/adquisiciones/purchase-units.ts', import.meta.url), 'utf8')
const source = action.replace(/^import .*$/gm, '')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const prefix = `const { createClient, createSupabaseClient, getActiveCompanyId } = globalThis.__salesTest;\n`
const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003']
const products = [
  { id: ids[0], company_id: 'company', is_active: true, sales_unit: null, purchase_unit: 'CAJA' },
  { id: ids[1], company_id: 'company', is_active: true, sales_unit: null, purchase_unit: null },
  { id: ids[2], company_id: 'other', is_active: true, sales_unit: null },
]
const classifiers = [{ classifier_type: 'SALES_UNIT', normalized_name: 'UNIDAD', name: 'UNIDAD', is_active: true }]
let allowed = true
let rpcCalls = []
let rpcResponse = { data: null, error: null }
function query(table) {
  let filters = [], update = null
  const q = {
    select() { return q }, eq(key, value) { filters.push(row => row[key] === value); return q },
    in(key, values) { filters.push(row => values.includes(row[key])); return q },
    or() { return q }, limit() { return q }, update(values) { update = values; return q },
    then(resolve, reject) {
      const rows = (table === 'products' ? products : classifiers).filter(row => filters.every(f => f(row)))
      if (update) rows.forEach(row => Object.assign(row, update))
      return Promise.resolve({ data: rows.map(row => ({ ...row })), error: null }).then(resolve, reject)
    },
  }
  return q
}
globalThis.__salesTest = {
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) }, rpc: async () => ({ data: allowed, error: null }) }),
  createSupabaseClient: () => ({ from: query, rpc: async (name, args) => { rpcCalls.push({ name, args }); return rpcResponse } }),
  getActiveCompanyId: async () => 'company',
}
const { updateSalesUnits, saveUnitConfiguration, updatePurchaseUnitsBulk } = await import(`data:text/javascript;base64,${Buffer.from(prefix + js).toString('base64')}`)

test('bulk purchase update passes all valid IDs and verifies the database count', async () => {
  rpcCalls = []
  const mappingIds = Array.from({ length: 500 }, (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`)
  rpcResponse = { data: 500, error: null }
  const result = await updatePurchaseUnitsBulk({ mappingIds, purchaseUnit: 'CAJA', purchaseUnitFactor: 12 })
  assert.equal(result.updated, 500)
  assert.equal(rpcCalls.length, 1)
  assert.equal(rpcCalls[0].name, 'update_purchase_units_bulk')
  assert.deepEqual(rpcCalls[0].args.p_mapping_ids, mappingIds)
  assert.equal(rpcCalls[0].args.p_company_id, 'company')
  assert.equal(rpcCalls[0].args.p_user_id, 'user')
  rpcResponse = { data: 499, error: null }
  assert.ok((await updatePurchaseUnitsBulk({ mappingIds, purchaseUnit: 'CAJA', purchaseUnitFactor: 12 })).error)
  rpcResponse = { data: null, error: { message: 'transaction rolled back' } }
  assert.ok((await updatePurchaseUnitsBulk({ mappingIds, purchaseUnit: 'CAJA', purchaseUnitFactor: 12 })).error)
  rpcResponse = { data: null, error: null }
})

test('bulk purchase rejects excessive, malformed or duplicate IDs and invalid factors before the RPC', async () => {
  rpcCalls = []
  for (const mappingIds of [Array(501).fill(ids[0]), [ids[0], ids[0]], ['invalid'], []]) {
    assert.ok((await updatePurchaseUnitsBulk({ mappingIds, purchaseUnit: 'CAJA', purchaseUnitFactor: 1 })).error)
  }
  for (const purchaseUnitFactor of [0, -1, 1.5]) {
    assert.ok((await updatePurchaseUnitsBulk({ mappingIds: [ids[0]], purchaseUnit: 'CAJA', purchaseUnitFactor })).error)
  }
  assert.equal(rpcCalls.length, 0)
})

test('bulk SQL checks the affected count and raises on discrepancy', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20261124130000_adquisiciones_sales_unit_factor.sql', import.meta.url), 'utf8')
  const bulk = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION adquisiciones.update_purchase_units_bulk'))
  assert.match(bulk, /WHERE company_id = p_company_id AND is_active AND id = ANY\(p_mapping_ids\)/)
  assert.match(bulk, /GET DIAGNOSTICS v_updated = ROW_COUNT/)
  assert.match(bulk, /IF v_updated <> cardinality\(p_mapping_ids\) THEN\s+RAISE EXCEPTION/)
  assert.match(bulk, /FROM PUBLIC, anon, authenticated/)
  assert.match(bulk, /TO service_role/)
})

test('joint save sends only modified fields in one transactional call', async () => {
  rpcCalls = []
  const result = await saveUnitConfiguration({ productIds: [ids[0]], mappingId: ids[1], purchaseUnit: 'CAJA', purchaseFactor: 12, salesFactor: 2 })
  assert.equal(result.success, true)
  assert.equal(rpcCalls.length, 1)
  assert.equal(rpcCalls[0].name, 'save_purchase_unit_configuration')
  assert.equal(rpcCalls[0].args.p_purchase_factor, 12)
  assert.equal(rpcCalls[0].args.p_sales_factor, 2)
  await saveUnitConfiguration({ productIds: [ids[0], ids[1], ids[1]], salesFactor: 3 })
  assert.equal(rpcCalls[1].args.p_product_ids.length, 2)
  assert.equal(rpcCalls[1].args.p_purchase_unit, null)
  assert.equal(rpcCalls[1].args.p_purchase_factor, null)
})

test('invalid sale and purchase factors never reach the database', async () => {
  rpcCalls = []
  for (const factor of [0, -1, 1.5, NaN]) {
    assert.ok((await saveUnitConfiguration({ productIds: [ids[0]], salesFactor: factor })).error)
    assert.ok((await saveUnitConfiguration({ productIds: [ids[0]], mappingId: ids[1], purchaseFactor: factor })).error)
  }
  assert.equal(rpcCalls.length, 0)
})

test('migration performs both updates inside a single service-only function', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20261124130000_adquisiciones_sales_unit_factor.sql', import.meta.url), 'utf8')
  assert.match(migration, /sales_unit_factor integer NOT NULL DEFAULT 1/)
  assert.match(migration, /CHECK \(sales_unit_factor >= 1\)/)
  assert.match(migration, /UPDATE adquisiciones\.product_supplier_mappings[\s\S]*UPDATE adquisiciones\.products/)
  assert.match(migration, /FROM PUBLIC, anon, authenticated/)
  assert.match(migration, /TO service_role/)
})

test('individual and bulk sales changes persist on products without changing purchase configuration', async () => {
  assert.equal((await updateSalesUnits({ productIds: [ids[0]], salesUnit: 'unidad' })).success, true)
  assert.equal(products[0].sales_unit, 'UNIDAD')
  assert.equal(products[0].purchase_unit, 'CAJA')
  const result = await updateSalesUnits({ productIds: [ids[0], ids[1], ids[1]], salesUnit: 'UNIDAD' })
  assert.equal(result.updated, 2)
  assert.equal(products[1].sales_unit, 'UNIDAD')
  assert.equal(products[1].purchase_unit, null)
})

test('rejects foreign products, invalid units, excessive selections and missing permissions', async () => {
  assert.ok((await updateSalesUnits({ productIds: [ids[0], ids[2]], salesUnit: 'UNIDAD' })).error)
  assert.equal(products[2].sales_unit, null)
  assert.ok((await updateSalesUnits({ productIds: [ids[0]], salesUnit: 'INEXISTENTE' })).error)
  assert.ok((await updateSalesUnits({ productIds: Array(501).fill(ids[0]), salesUnit: 'UNIDAD' })).error)
  allowed = false
  assert.ok((await updateSalesUnits({ productIds: [ids[0]], salesUnit: 'UNIDAD' })).error)
  allowed = true
})

test('catalog and Bsale synchronization retain the same sales-unit field', async () => {
  const catalog = await readFile(new URL('../src/app/actions/adquisiciones/products.ts', import.meta.url), 'utf8')
  const sync = await readFile(new URL('../src/lib/integraciones/bsale-products-sync.ts', import.meta.url), 'utf8')
  const rpc = await readFile(new URL('../supabase/migrations/20260922100000_bsale_pack_classification.sql', import.meta.url), 'utf8')
  assert.match(catalog, /sales_unit: v\(formData\.get\('sales_unit'\)/)
  assert.doesNotMatch(sync, /sales_unit/)
  assert.doesNotMatch(rpc.slice(0, rpc.indexOf('CREATE OR REPLACE FUNCTION mermas.')), /sales_unit/)
})
