import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')
const review = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', root), 'utf8')
const sidePanelStart = panel.indexOf('{selectedPo && (')
assert.notEqual(sidePanelStart, -1, 'split-pane selectedPo no encontrado')
const sidePanel = panel.slice(sidePanelStart)

test('supplier review is isolated from the legacy PO form', () => {
  assert.match(panel, /status === 'ENVIADA_PROVEEDOR'[\s\S]*?Revisar confirmación/)
  assert.match(panel, /view === 'supplier-review'/)
  assert.match(review, /getPurchaseOrderSupplierReviewComparison/)
  assert.match(review, /updateSentPurchaseOrderReview/)
  assert.doesNotMatch(review, /createPurchaseOrder|handleSubmit/)
})

test('EMITIDA can be marked as sent without implementing confirmation', () => {
  assert.match(sidePanel, /detail\.po\.status === 'EMITIDA'[\s\S]*?handleMarkSentToSupplier\(detail\.po\.id\)[\s\S]*?Marcar enviada al proveedor/)
  assert.match(sidePanel, /detail\.po\.status === 'ENVIADA_PROVEEDOR'[\s\S]*?Revisar confirmación/)
  assert.match(panel, /handleMarkSentToSupplier[\s\S]*?updatePurchaseOrderStatus\(poId, 'ENVIADA_PROVEEDOR'\)/)
  assert.match(panel, /Confirmas que esta orden de compra ya fue enviada al proveedor\?/)
  assert.match(panel, /delete detailCacheRef\.current\[poId\]/)
  assert.match(panel, /await load\(\)/)
  assert.match(panel, /await getPurchaseOrderDetail\(poId\)/)
  assert.match(panel, /setDetail\(updatedDetail\)[\s\S]*?setSelectedPo\(updatedDetail\.po as PurchaseOrder\)/)
  assert.match(panel, /CONFIRMADA:.*Confirmada/)
  assert.doesNotMatch(panel, /Confirmar OC/)
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

test('supplier review summary reflects live totals only while dirty', () => {
  assert.match(review, /const displayCurrentTotal = dirty \? preview\.total : summary\.current_grand_total/)
  assert.match(review, /const displayDifference = displayCurrentTotal - summary\.original_grand_total/)
  assert.match(review, /signedCurrency\(displayDifference, po\.currency\)/)
  assert.match(review, /pending && <span[^>]*>Sin guardar<\/span>/)
  assert.doesNotMatch(review, /summary\.total_difference/)
  assert.match(review, /updateSentPurchaseOrderReview\(poId, payload\)/)
})

test('panel invalidates detail cache and reloads the listing after save', () => {
  assert.match(panel, /delete detailCacheRef\.current\[poId\]/)
  assert.match(panel, /await load\(\)/)
})
