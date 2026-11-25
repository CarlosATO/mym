import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { getPurchaseOrderDiscountPayload } from '../src/lib/adquisiciones/purchase-order-discounts.ts'

const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')
const source = panel.slice(panel.indexOf('  function commercialSnapshot('), panel.indexOf('  const [items, setItems]'))
const js = ts.transpileModule(`${source}\nexport { hasCommercialChanges }`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
globalThis.__purchaseDiscountPayload = getPurchaseOrderDiscountPayload
const { hasCommercialChanges } = await import(`data:text/javascript;base64,${Buffer.from('const getPurchaseOrderDiscountPayload=globalThis.__purchaseDiscountPayload;\n' + js).toString('base64')}`)

test('compares persisted fields instead of transient display details', () => {
  const form = { issue_date: '2026-11-25', required_date: '', supplier_id: 's', warehouse_id: 'w', currency: 'CLP', payment_terms: '', authorized_by: '', notes: '' }
  const item = { persistedId: 'i', tempId: 'one', item_type: 'PRODUCT', product_id: 'p', description: 'Producto', unit: 'UNIDAD', warehouse_id: '', quantity: 600, unit_price: 1666.6667, commercial_factor: 6, commercial_price_raw: '10000.0000', discount_percent: 0, discount_unit_amount: 0, tax_rate: 19, notes: '' }
  const baseline = JSON.stringify({ form, items: [item] })
  assert.equal(hasCommercialChanges(baseline, form, [{ ...item, tempId: 'other', raw_unit_price: '1666.6667', commercial_price_raw: '010000,00', reference_unit_cost: 4 }]), false)
  assert.equal(hasCommercialChanges(baseline, form, [{ ...item, quantity: 606 }]), true)
  assert.equal(hasCommercialChanges(baseline, form, [{ ...item, commercial_price_raw: '10000.0001' }]), true)
  assert.equal(hasCommercialChanges(baseline, { ...form, notes: 'Cambio' }, [item]), true)
  assert.equal(hasCommercialChanges(null, form, [item]), true)
})

test('refresh is targeted and pending save retries take priority over no-op detection', () => {
  const sync = panel.slice(panel.indexOf('  async function syncCommercialOrder('), panel.indexOf('  const load = useCallback('))
  assert.match(sync, /delete detailCacheRef\.current\[poId\]/)
  assert.match(sync, /getPurchaseOrderDetail\(poId\)/)
  assert.doesNotMatch(sync, /purchaseOrderInvoiceCacheRef\.current\.clear/)
  assert.match(panel, /if \(previous\) \{[\s\S]*?\} else \{\s*if \(isCommercialDraft && !commercialChangesPending\)/)
  assert.match(panel, /detail\.po\.commercial_managed == null\).*?return/)
  assert.match(panel, /detail\.po\.commercial_managed \? await markCommercialOrderSent\(poId\) : await updatePurchaseOrderStatus\(poId, 'ENVIADA_PROVEEDOR'\)/)
})
