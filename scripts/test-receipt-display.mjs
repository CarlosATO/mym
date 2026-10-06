import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCivilDate, formatInstantInSantiago } from '../src/lib/datetime.ts'
import { enrichReceiptItemsWithProducts, receiptItemSku } from '../src/lib/logistica/receipt-display.ts'

test('receipt product display uses the real SKU from products', () => {
  const items = enrichReceiptItemsWithProducts([
    { item_type: 'PRODUCT', product_id: 'e7224490-uuid', sku: null },
    { item_type: 'SERVICE', product_id: null, sku: null },
  ], [{ id: 'e7224490-uuid', sku: '43160' }])
  assert.equal(items[0].sku, '43160')
  assert.equal(receiptItemSku(items[0]), '43160')
  assert.equal(receiptItemSku({ item_type: 'PRODUCT', product_id: 'e7224490-uuid' }), '—')
  assert.equal(receiptItemSku(items[1]), '—')
})

test('DATE-only values do not shift by timezone', () => {
  assert.equal(formatCivilDate('2026-12-31'), '31-12-2026')
  assert.equal(formatCivilDate('2027-12-31'), '31-12-2027')
})

test('timestamptz remains an instant formatted in Santiago', () => {
  assert.match(formatInstantInSantiago('2026-12-31T15:00:00.000Z'), /31-12-2026/)
})
