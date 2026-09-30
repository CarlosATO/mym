import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')
const screen = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-order-supplier-review.tsx', import.meta.url), 'utf8')

test('supplier review is only accessible for ENVIADA_PROVEEDOR', () => {
  assert.match(panel, /detail\.po\.status === 'ENVIADA_PROVEEDOR'/)
  assert.match(panel, /Revisar confirmación/)
  assert.match(panel, /view === 'supplier-review'/)
})

test('supplier review uses comparison and update actions without the create flow', () => {
  assert.match(screen, /getPurchaseOrderSupplierReviewComparison/)
  assert.match(screen, /updateSentPurchaseOrderReview/)
  assert.match(screen, /items: lines\.map\(line =>/)
  assert.doesNotMatch(screen, /createPurchaseOrder/)
  assert.match(screen, /item_id: line\.item_id/)
  assert.match(screen, /unit_price: line\.unit_price/)
  assert.match(screen, /tax_rate: line\.tax_rate/)
})

test('supplier review renders comparison states, removed products, catalog additions, and zero prices', () => {
  assert.match(screen, /SIN_CAMBIOS/)
  assert.match(screen, /MODIFICADA/)
  assert.match(screen, /AGREGADA/)
  assert.match(screen, /Productos no disponibles \/ eliminados/)
  assert.match(screen, /getPurchaseOrderProductCatalogCached/)
  assert.match(screen, /item_id: null/)
  assert.match(screen, /Precio pendiente/)
  assert.match(screen, /changed_fields/)
  assert.doesNotMatch(screen, /Confirmar OC/)
})

test('save refreshes comparison and invalidates the detail cache', () => {
  assert.match(screen, /await loadComparison\(\)/)
  assert.match(panel, /delete detailCacheRef\.current\[poId\]/)
  assert.match(panel, /delete pendingRequestsRef\.current\[poId\]/)
  assert.match(panel, /await load\(\)/)
})
