import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-analysis-panel.tsx', import.meta.url), 'utf8')
const derive = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/replenishment-derive.ts', import.meta.url), 'utf8')

test('Monto confirmado usa el catálogo canónico y no el costo analítico', () => {
  assert.match(panel, /getPurchaseOrderProductCatalogCached\(\)/)
  assert.match(panel, /canonicalCostBySku/)
  assert.match(panel, /last_purchase_unit_cost/)
  assert.match(panel, /confirmedCost: row\.confirmedQty \* canonicalCostForSku\(costs, row\.sku\.SKU\)/)
  assert.match(panel, /r\.confirmedCost = r\.confirmedQty \* canonicalCostForSku\(canonicalCostBySku\.current, r\.sku\.SKU\)/)
  assert.match(panel, /const effectiveCost = useMemo\(\(\) => effectiveRows\.reduce\(\(a, r\) => a \+ r\.confirmedCost, 0\)/)
  assert.doesNotMatch(panel, /r\.confirmedCost = r\.confirmedQty \* r\.sku\.costo_unitario/)
  assert.match(panel, /r\.sku\.costo_unitario/)
  assert.match(derive, /confirmedCost: 0/)
  assert.doesNotMatch(derive, /confirmedCost: suggestedQty \* sku\.costo_unitario/)
})

test('Cambio de período preserva cantidad manual y recalcula con costo canónico', () => {
  assert.match(panel, /const pricedRows = applyCanonicalCosts\(newRows, canonicalCostBySku\.current\)/)
  assert.match(panel, /confirmedQty: previous\.confirmedQty, confirmedCost: previous\.confirmedQty \* canonicalCostForSku\(canonicalCostBySku\.current, row\.sku\.SKU\)/)
})

test('Exportación de compra usa el mismo costo canónico y deja cero sin historial', () => {
  assert.match(panel, /const unitCost = canonicalCostForSku\(canonicalCostBySku\.current, r\.sku\.SKU\)/)
  assert.match(panel, /subtotal: r\.confirmedQty \* unitCost/)
  assert.match(panel, /noCost: unitCost === 0/)
})
