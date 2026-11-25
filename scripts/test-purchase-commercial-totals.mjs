import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateCommercialDraftLineTotals as line, calculateCommercialDraftTotals as totals } from '../src/lib/adquisiciones/purchase-commercial-totals.ts'

test('fractional cents reconcile each service line and header', () => {
  const item = { quantity: 1, unit_price: 0.025, discount_percent: 0, tax_rate: 19 }
  assert.deepEqual(line(item), { gross_amount: 0.03, discount_amount: 0, net_amount: 0.03, tax_amount: 0.01, line_total: 0.04 })
  assert.deepEqual(totals([item, item]), { gross_total: 0.06, discount_total: 0, net_total: 0.06, tax_total: 0.02, grand_total: 0.08 })
})

test('commercial exact price, traditional product, discounts, exempt and services', () => {
  const items = [
    { quantity: 600, unit_price: 1666.6667, commercial_factor: 6, commercial_price_raw: '10000', discount_percent: 10, tax_rate: 19 },
    { quantity: 2, unit_price: 100, discount_percent: 0, discount_unit_amount: 10, tax_rate: 19 },
    { quantity: 1, unit_price: 5, commercial_factor: 1, commercial_price_raw: '5', discount_percent: 0, tax_rate: 0 },
  ]
  assert.equal(line(items[0]).gross_amount, 1000000)
  assert.deepEqual(totals(items), { gross_total: 1000205, discount_total: 100020, net_total: 900185, tax_total: 171034.2, grand_total: 1071219.2 })
  assert.deepEqual(line({ quantity: 1, unit_price: 0.055, discount_percent: 50, tax_rate: 0 }), { gross_amount: 0.06, discount_amount: 0.03, net_amount: 0.03, tax_amount: 0, line_total: 0.03 })
  assert.deepEqual(totals([{ quantity: 1, unit_price: 0.055, discount_percent: 50, tax_rate: 0 }, { quantity: 2, unit_price: 0.025, commercial_factor: 1, commercial_price_raw: '0.025', discount_percent: 0, discount_unit_amount: 0.01, tax_rate: 19 }]), { gross_total: 0.11, discount_total: 0.05, net_total: 0.06, tax_total: 0.01, grand_total: 0.07 })
})
