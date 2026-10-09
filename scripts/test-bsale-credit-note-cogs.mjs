import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCreditNoteCogs } from '../src/lib/integraciones/bsale-credit-note-cogs.ts'

const base = (overrides = {}) => ({
  bsale_credit_note_id: 1,
  bsale_return_id: 10,
  referenced_document_id: 20,
  price_adjustment: false,
  ...overrides,
})

const detail = (overrides = {}) => ({
  bsale_return_id: 10,
  bsale_return_detail_id: 100,
  bsale_document_detail_id: 1000,
  quantity: 2,
  quantity_dev_stock: 2,
  variant_cost: 12.5,
  ...overrides,
})

const resolve = (returns, details = [detail()], ids = new Set([1000])) => resolveCreditNoteCogs({
  creditNoteId: 1,
  returns,
  detailsByReturnId: new Map(details.length ? [[10, details]] : []),
  resolvableDocumentDetailIds: ids,
})

test('resolves physical return with Decimal multiplication', () => {
  const result = resolve([base()], [detail({ quantity_dev_stock: 3, quantity: 3, variant_cost: 12.345 })])
  assert.equal(result.resolution_status, 'RESOLVED_PHYSICAL_RETURN')
  assert.equal(result.reversal_cogs, '37.05')
})

test('resolves price adjustment without COGS reversal', () => {
  const result = resolve([base({ price_adjustment: true })], [detail({ quantity_dev_stock: 0, variant_cost: 0 })])
  assert.equal(result.resolution_status, 'RESOLVED_PRICE_ADJUSTMENT')
  assert.equal(result.reversal_cogs, '0')
})

test('resolves return without stock reentry', () => {
  const result = resolve([base()], [detail({ quantity_dev_stock: 0, variant_cost: 20 })])
  assert.equal(result.resolution_status, 'RESOLVED_NO_STOCK_REENTRY')
  assert.equal(result.reversal_cogs, '0')
})

test('resolves mixed details at detail level', () => {
  const result = resolve([base()], [detail(), detail({ bsale_return_detail_id: 101, quantity: 2, quantity_dev_stock: 0, variant_cost: 0 })])
  assert.equal(result.resolution_status, 'RESOLVED_MIXED')
  assert.equal(result.reversal_cogs, '25')
})

test('resolves missing return and missing reference', () => {
  assert.equal(resolve([]).resolution_status, 'MISSING_RETURN')
  const missingReference = resolve([base({ referenced_document_id: null })])
  assert.equal(missingReference.resolution_status, 'MISSING_REFERENCE')
  assert.equal(missingReference.reversal_cogs, '0')
  assert.equal(missingReference.details[0].semantic_status, 'AMBIGUOUS')
  assert.equal(missingReference.details[0].reversal_cogs, '0')
})

test('rejects unresolved, contradictory and multiple-return cases', () => {
  const unresolved = resolve([base()], [detail({ bsale_document_detail_id: 9999 })])
  assert.equal(unresolved.resolution_status, 'AMBIGUOUS')
  assert.equal(unresolved.reversal_cogs, '0')
  const multiple = resolve([base(), base({ bsale_return_id: 11 })])
  assert.equal(multiple.resolution_status, 'AMBIGUOUS')
  assert.equal(multiple.details[0].reversal_cogs, '0')
  const contradictory = resolve([base()], [detail({ quantity: 1, quantity_dev_stock: 2 })])
  assert.equal(contradictory.resolution_status, 'AMBIGUOUS')
})

test('never uses variantStock or quantity when quantityDevStock differs', () => {
  const result = resolve([base()], [detail({ quantity: 10, quantity_dev_stock: 2, variant_cost: 7.5, variant_stock: 999 })])
  assert.equal(result.reversal_cogs, '15')
})
