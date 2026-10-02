import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/adquisiciones/purchase-orders.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-analysis-panel.tsx', import.meta.url), 'utf8')
const preparation = action.slice(action.indexOf('export async function prepareReplenishmentPurchaseOrder'))
const panelPreparation = panel.slice(panel.indexOf('async function handlePreparePurchaseOrder'))
  .split('async function handlePrepareExcelPurchaseOrder')[0]

test('Reposición resuelve el costo canónico server-side por empresa y variante', () => {
  assert.match(preparation, /bsale_variant_id/)
  assert.match(preparation, /\.select\('id, sku, description, unit_of_measure, tax_rate, bsale_variant_id'\)/)
  assert.match(preparation, /vw_bsale_variant_last_purchase_cost/)
  assert.match(preparation, /\.eq\('company_id', companyId\)/)
  assert.match(preparation, /\.in\('bsale_variant_id', ids\)/)
  assert.match(preparation, /for \(let offset = 0; offset < variantIds\.length; offset \+= 500\)/)
  assert.match(preparation, /\.select\('bsale_variant_id, last_purchase_cost'\)/)
  assert.match(preparation, /Number\.isFinite\(cost\) && cost > 0/)
  assert.match(preparation, /typeof variantId === 'number' && Number\.isFinite\(variantId\)/)
  const variantIdsBlock = preparation.slice(preparation.indexOf('const variantIds'), preparation.indexOf("const integrations = db.schema('integraciones')"))
  assert.doesNotMatch(variantIdsBlock, /undefined/)
  assert.match(preparation, /unit_price: .*\? 0 : canonicalCostByVariant\.get\(entry\.product\.bsale_variant_id\) \?\? 0/)
  assert.match(preparation, /reference_unit_cost: .*\? 0 : canonicalCostByVariant\.get\(entry\.product\.bsale_variant_id\) \?\? 0/)
  assert.doesNotMatch(preparation, /average_cost|bsale_variant_costs|product_supplier_mappings\.unit_cost/)
  assert.match(preparation, /code: 'CANONICAL_COST_LOOKUP_FAILED'/)
  assert.match(panel, /No se pudieron obtener los costos de compra\. Intenta nuevamente\./)
})

test('El request de Reposición no envía el costo analítico y el análisis lo conserva', () => {
  assert.doesNotMatch(panelPreparation, /reference_unit_cost/)
  assert.match(panelPreparation, /sku: r\.sku\.SKU/)
  assert.match(panelPreparation, /product_name: getProductName\(r\.sku\)/)
  assert.match(panelPreparation, /quantity: r\.confirmedQty/)
  assert.match(panel, /r\.sku\.costo_unitario/)
})
