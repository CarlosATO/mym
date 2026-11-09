import assert from 'node:assert/strict'
import test from 'node:test'
import { compareAuditedCommercialLines } from '../src/lib/logistica/preparation-audit-commercial-verification.ts'

const identity = (currentBsaleId = 101) => ({ canonicalToken: 'token-1', historicalBsaleId: 100, currentBsaleId, folio: 'NV-1' })
const line = (variantId, sku, quantity, extra = {}) => ({ detailId: variantId, variantId, sku, productName: sku, quantity, unitNetValue: 1000, lineNetAmount: quantity * 1000, lineTaxAmount: quantity * 190, lineGrossAmount: quantity * 1190, ...extra })
const version = (lines, overrides = {}) => ({ identity: identity(overrides.physicalId ?? 101), physicalId: overrides.physicalId ?? 101, lines, netAmount: 1000, taxAmount: 190, totalAmount: 1190, ...overrides })
const audited = (variantId, sku, quantity) => ({ bsale_detail_id: variantId, bsale_variant_id: variantId, sku, product_name: sku, audit_quantity: quantity })

test('sin diferencias comerciales queda READY_TO_INVOICE', () => {
  const current = version([line(10, 'SKU-10', 2)])
  const result = compareAuditedCommercialLines([audited(10, 'SKU-10', 2)], current, current)
  assert.equal(result.status, 'READY_TO_INVOICE')
  assert.deepEqual(result.differences, [])
})

test('detecta cantidades y productos agregados o eliminados', () => {
  const accepted = version([line(10, 'SKU-10', 2), line(20, 'SKU-20', 1)])
  const current = version([line(10, 'SKU-10', 1), line(30, 'SKU-30', 1)])
  const result = compareAuditedCommercialLines([audited(10, 'SKU-10', 2)], current, accepted)
  assert.equal(result.status, 'INCIDENTS')
  assert.ok(result.differences.some(item => item.kind === 'QUANTITY_MISMATCH'))
  assert.ok(result.differences.some(item => item.kind === 'REMOVED' && item.identity === 'VARIANT:20'))
  assert.ok(result.differences.some(item => item.kind === 'ADDED' && item.identity === 'VARIANT:30'))
})

test('detecta cambio de precio con igual SKU y cantidad', () => {
  const accepted = version([line(10, 'SKU-10', 2, { unitNetValue: 1000, lineNetAmount: 2000, lineGrossAmount: 2380 })], { totalAmount: 2380 })
  const current = version([line(10, 'SKU-10', 2, { unitNetValue: 1200, lineNetAmount: 2400, lineGrossAmount: 2856 })], { totalAmount: 2856 })
  const result = compareAuditedCommercialLines([audited(10, 'SKU-10', 2)], current, accepted)
  assert.equal(result.status, 'INCIDENTS')
  assert.ok(result.differences.some(item => item.kind === 'VALUE_CHANGED' && item.changedFields?.includes('unitNetValue')))
  assert.ok(result.differences.some(item => item.kind === 'TOTAL_CHANGED' && item.changedFields?.includes('totalAmount')))
})

test('un nuevo detailId no genera diferencia si la identidad y valores no cambian', () => {
  const accepted = version([line(10, 'SKU-10', 2, { detailId: 1 })])
  const current = version([line(10, 'SKU-10', 2, { detailId: 999 })])
  const result = compareAuditedCommercialLines([audited(10, 'SKU-10', 2)], current, accepted)
  assert.equal(result.status, 'READY_TO_INVOICE')
  assert.deepEqual(result.differences, [])
})

test('un cambio de nombre descriptivo no genera diferencia comercial', () => {
  const accepted = version([line(10, 'SKU-10', 2, { productName: 'Nombre anterior' })])
  const current = version([line(10, 'SKU-10', 2, { productName: 'Nombre catálogo' })])
  const result = compareAuditedCommercialLines([audited(10, 'SKU-10', 2)], current, accepted)
  assert.equal(result.status, 'READY_TO_INVOICE')
  assert.deepEqual(result.differences, [])
})
