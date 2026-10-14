import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { calculatePurchaseOrderLineTotals, calculatePurchaseOrderTotals } from '../src/lib/adquisiciones/purchase-order-totals.ts'

const panel = await readFile(new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url), 'utf8')

test('calcula una línea sin descuento', () => {
  assert.deepEqual(calculatePurchaseOrderLineTotals({
    quantity: 10,
    unit_price: 1000,
    discount_percent: 0,
    tax_rate: 19,
  }), {
    gross_amount: 10000,
    discount_amount: 0,
    net_amount: 10000,
    tax_amount: 1900,
    line_total: 11900,
  })
})

test('calcula una línea con descuento porcentual', () => {
  assert.deepEqual(calculatePurchaseOrderLineTotals({
    quantity: 10,
    unit_price: 1000,
    discount_percent: 10,
    tax_rate: 19,
  }), {
    gross_amount: 10000,
    discount_amount: 1000,
    net_amount: 9000,
    tax_amount: 1710,
    line_total: 10710,
  })
})

test('calcula el caso real de revisión de proveedor', () => {
  const totals = calculatePurchaseOrderTotals([{
    quantity: 15,
    unit_price: 8091,
    discount_percent: 10,
    tax_rate: 19,
  }])

  assert.equal(totals.gross_total, 121365)
  assert.equal(totals.discount_total, 12136.5)
  assert.equal(totals.net_total, 109228.5)
  assert.equal(totals.tax_total, 20753.42)
  assert.equal(totals.grand_total, 129981.92)
})

test('acumula varias líneas sin mezclar bruto y neto', () => {
  assert.deepEqual(calculatePurchaseOrderTotals([
    { quantity: 2, unit_price: 5000, discount_percent: 0, tax_rate: 19 },
    { quantity: 3, unit_price: 10000, discount_percent: 10, tax_rate: 19 },
  ]), {
    gross_total: 40000,
    discount_total: 3000,
    net_total: 37000,
    tax_total: 7030,
    grand_total: 44030,
  })
})

test('construye el preview PDF con los importes netos de la misma fórmula', () => {
  assert.match(panel, /net_total: netTotal/)
  assert.match(panel, /discount_total: discountTotal/)
  assert.match(panel, /tax_total: taxTotal/)
  assert.match(panel, /grand_total: grandTotal/)
  assert.match(panel, /line_total: lineTotals\.line_total/)
  assert.doesNotMatch(panel, /line_total: it\.quantity \* it\.unit_price/)
})
