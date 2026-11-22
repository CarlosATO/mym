import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateServiceAmounts, formatServiceAmount } from '../src/modules/cuentas-por-pagar/service-rules.ts'

test('calcula desde neto o total y muestra pesos con dos decimales', () => {
  const expected = { netAmount: 100000, taxAmount: 19000, totalAmount: 119000 }
  assert.deepEqual(calculateServiceAmounts('100000', 'net', 'taxable'), expected)
  assert.deepEqual(calculateServiceAmounts('$119.000,00', 'total', 'taxable'), expected)
  assert.equal(formatServiceAmount(expected.netAmount), '$100.000,00')
  assert.equal(formatServiceAmount(expected.taxAmount), '$19.000,00')
  assert.equal(formatServiceAmount(expected.totalAmount), '$119.000,00')
})

test('factura exenta y cambios sucesivos de fuente y tipo tributario', () => {
  assert.deepEqual(calculateServiceAmounts('100000', 'net', 'exempt'), { netAmount: 100000, taxAmount: 0, totalAmount: 100000 })
  assert.deepEqual(calculateServiceAmounts('119000', 'total', 'exempt'), { netAmount: 119000, taxAmount: 0, totalAmount: 119000 })
  assert.deepEqual(calculateServiceAmounts('119000', 'total', 'taxable'), { netAmount: 100000, taxAmount: 19000, totalAmount: 119000 })
  assert.deepEqual(calculateServiceAmounts('200000', 'net', 'taxable'), { netAmount: 200000, taxAmount: 38000, totalAmount: 238000 })
  assert.deepEqual(calculateServiceAmounts('119000', 'total', 'taxable'), { netAmount: 100000, taxAmount: 19000, totalAmount: 119000 })
})

test('mantiene precisión de centavos y redondea de forma consistente', () => {
  assert.deepEqual(calculateServiceAmounts('100,01', 'net', 'taxable'), { netAmount: 100.01, taxAmount: 19, totalAmount: 119.01 })
  assert.deepEqual(calculateServiceAmounts('119,01', 'total', 'taxable'), { netAmount: 100.01, taxAmount: 19, totalAmount: 119.01 })
  assert.deepEqual(calculateServiceAmounts('0,03', 'net', 'taxable'), { netAmount: 0.03, taxAmount: 0.01, totalAmount: 0.04 })
})

test('borrado, cero y entradas inválidas no conservan importes anteriores', () => {
  assert.deepEqual(calculateServiceAmounts('', 'total', 'taxable'), { netAmount: null, taxAmount: null, totalAmount: null })
  assert.deepEqual(calculateServiceAmounts('0', 'net', 'taxable'), { netAmount: 0, taxAmount: 0, totalAmount: 0 })
  for (const text of ['-1', 'abc', '1,234', '1.2', '999999999999999999999']) {
    const result = calculateServiceAmounts(text, 'net', 'taxable')
    assert.ok(Number.isNaN(result.netAmount) && Number.isNaN(result.taxAmount) && Number.isNaN(result.totalAmount), text)
  }
})
