import test from 'node:test'
import assert from 'node:assert/strict'
import { calculatePurchaseOrderLineTotals, calculatePurchaseOrderTotals } from '../src/lib/adquisiciones/purchase-order-totals.ts'

const baseLine = {
  quantity: 10,
  unit_price: 1000,
  discount_percent: 0,
  tax_rate: 19,
}

test('calculates percentage discount', () => {
  assert.deepEqual(calculatePurchaseOrderLineTotals({ ...baseLine, discount_percent: 10 }), {
    gross_amount: 10000,
    discount_amount: 1000,
    net_amount: 9000,
    tax_amount: 1710,
    line_total: 10710,
  })
})

test('calculates unit discount and defaults missing unit discount to zero', () => {
  assert.deepEqual(
    calculatePurchaseOrderLineTotals({
      ...baseLine,
      discount_unit_amount: 100,
    }),
    {
      gross_amount: 10000,
      discount_amount: 1000,
      net_amount: 9000,
      tax_amount: 1710,
      line_total: 10710,
    },
  )
  assert.equal(calculatePurchaseOrderLineTotals(baseLine).discount_amount, 0)
})

test('percentage discount takes precedence if transient UI state has both values', () => {
  assert.equal(
    calculatePurchaseOrderLineTotals({
      ...baseLine,
      discount_percent: 10,
      discount_unit_amount: 100,
    }).discount_amount,
    1000,
  )
})

test('sums percentage, unit and undiscounted lines', () => {
  const totals = calculatePurchaseOrderTotals([{ ...baseLine, discount_percent: 10 }, { ...baseLine, discount_unit_amount: 100 }, { ...baseLine }])
  assert.deepEqual(totals, {
    gross_total: 30000,
    discount_total: 2000,
    net_total: 28000,
    tax_total: 5320,
    grand_total: 33320,
  })
})
