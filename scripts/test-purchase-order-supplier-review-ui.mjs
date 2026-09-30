import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')
const review = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', root), 'utf8')

test('supplier review is isolated from the legacy PO form', () => {
  assert.match(panel, /status === 'ENVIADA_PROVEEDOR'[\s\S]*?Revisar confirmación/)
  assert.match(panel, /view === 'supplier-review'/)
  assert.match(review, /getPurchaseOrderSupplierReviewComparison/)
  assert.match(review, /updateSentPurchaseOrderReview/)
  assert.doesNotMatch(review, /createPurchaseOrder|handleSubmit/)
})

test('supplier review handles complete payloads and comparison states', () => {
  for (const field of ['item_id', 'item_type', 'product_id', 'quantity', 'unit_price', 'discount_percent', 'tax_rate', 'notes']) {
    assert.match(review, new RegExp(field))
  }
  for (const status of ['SIN_CAMBIOS', 'MODIFICADA', 'ELIMINADA', 'AGREGADA']) assert.match(review, new RegExp(status))
  assert.match(review, /changed_fields/)
  assert.match(review, /Productos no disponibles \/ eliminados/)
  assert.match(review, /item_id: line\.item_id\?\.startsWith\('new-'\) \? null/)
  assert.match(review, /unitPrice = Number\(newUnitPrice\)|newUnitPrice/)
  assert.match(review, /newUnitPrice.*'0'|unit_price: unitPrice/)
  assert.match(review, /unit_price === 0.*Precio pendiente/)
  assert.match(review, /lines\.length === 0/)
  assert.match(review, /Cambios sin guardar/)
  assert.match(review, /confirm\('Hay cambios sin guardar\./)
  assert.doesNotMatch(review, /Confirmar OC/)
})

test('panel invalidates detail cache and reloads the listing after save', () => {
  assert.match(panel, /delete detailCacheRef\.current\[poId\]/)
  assert.match(panel, /await load\(\)/)
})
