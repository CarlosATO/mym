import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  formatPriceDisplay,
  parseCurrencyDecimal,
  validatePriceDecimal,
} from '../src/lib/adquisiciones/purchase-order-decimal.ts'

const panel = await readFile(
  new URL('../src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', import.meta.url),
  'utf8'
)

test('accepts valid decimal price formats with comma, period, thousands and currency symbol', () => {
  const cases = [
    { input: '1250,50', expected: 1250.5 },
    { input: '1250.50', expected: 1250.5 },
    { input: '1.250,50', expected: 1250.5 },
    { input: '$ 1.250,50', expected: 1250.5 },
    { input: '$1.250,50', expected: 1250.5 },
    { input: '875,12', expected: 875.12 },
    { input: '0,99', expected: 0.99 },
    { input: '0.99', expected: 0.99 },
    { input: 1250.5, expected: 1250.5 },
    { input: 875.12, expected: 875.12 },
    { input: 0.99, expected: 0.99 },
  ]

  for (const { input, expected } of cases) {
    const res = validatePriceDecimal(input, 2)
    assert.equal(res.isValid, true, `Expected ${input} to be valid`)
    assert.equal(res.value, expected, `Expected parsed value for ${input} to be ${expected}`)
  }
})

test('rejects values with more than 2 decimals without silent rounding', () => {
  const precisionCases = [
    { input: '1250,567', rawVal: 1250.567 },
    { input: '1250.567', rawVal: 1250.567 },
    { input: '875,125', rawVal: 875.125 },
    { input: '0,999', rawVal: 0.999 },
    { input: '10.1234', rawVal: 10.1234 },
  ]

  for (const { input, rawVal } of precisionCases) {
    const res = validatePriceDecimal(input, 2)
    assert.equal(res.isValid, false, `Expected ${input} to be rejected for exceeding 2 decimals`)
    assert.equal(res.error, 'EXCEEDS_MAX_DECIMALS')
    assert.equal(res.errorMessage, 'El valor no puede tener más de 2 decimales')
    assert.equal(res.value, rawVal, 'Raw numeric value must be preserved without rounding')
    assert.notEqual(res.value, Math.round(rawVal * 100) / 100, 'Must NOT be silently rounded')
    // parseCurrencyDecimal must return null on invalid precision
    assert.equal(parseCurrencyDecimal(input, 2), null)
  }
})

test('rejects empty or invalid inputs without converting to zero', () => {
  const emptyCases = ['', '   ', null, undefined]
  for (const input of emptyCases) {
    const res = validatePriceDecimal(input, 2)
    assert.equal(res.isValid, false)
    assert.equal(res.isEmpty, true)
    assert.equal(res.error, 'EMPTY')
    assert.equal(res.value, null, 'Empty inputs must not be converted to 0')
  }

  const invalidCases = ['abc', '12a34', '-500', '12..34', '12,,34', '..', ',,']
  for (const input of invalidCases) {
    const res = validatePriceDecimal(input, 2)
    assert.equal(res.isValid, false, `Expected ${input} to be invalid`)
    assert.equal(res.value, null, 'Invalid inputs must not be converted to 0')
  }
})

test('parseCurrencyDecimal returns null for invalid inputs and correct number for valid inputs', () => {
  assert.equal(parseCurrencyDecimal('1250,50'), 1250.5)
  assert.equal(parseCurrencyDecimal('875,12'), 875.12)
  assert.equal(parseCurrencyDecimal('0,99'), 0.99)
  assert.equal(parseCurrencyDecimal('1250,567'), null)
  assert.equal(parseCurrencyDecimal(''), null)
  assert.equal(parseCurrencyDecimal('invalid'), null)
})

test('formatPriceDisplay handles integers and decimal prices cleanly in CLP', () => {
  assert.equal(formatPriceDisplay(1250), '$1.250')
  assert.equal(formatPriceDisplay(1250.5), '$1.250,50')
  assert.equal(formatPriceDisplay(875.12), '$875,12')
  assert.equal(formatPriceDisplay(0.99), '$0,99')
})

test('purchase-orders-panel does not use step="1" for prices and supports decimal inputs', () => {
  // Confirm validatePriceDecimal is imported and used
  assert.match(panel, /import \{ validatePriceDecimal, parseCurrencyDecimal \} from '@\/lib\/adquisiciones\/purchase-order-decimal'/)

  // No step="1" on price fields
  assert.doesNotMatch(panel, /pendingUnitPrice[^>]*step="1"/)
  assert.doesNotMatch(panel, /it\.unit_price[^>]*step="1"/)
  assert.doesNotMatch(panel, /serviceDraft\.unitPrice[^>]*step="1"/)

  // Inputs have step="0.01" and inputMode="decimal"
  assert.match(panel, /inputMode="decimal"/)
  assert.match(panel, /step="0\.01"/)

  // Form does not have noValidate
  assert.doesNotMatch(panel, /<form[^>]*\bnoValidate\b/)

  // raw_unit_price and raw_discount_unit_amount exist on line items
  assert.match(panel, /raw_unit_price\?: string/)
  assert.match(panel, /raw_discount_unit_amount\?: string/)

  // Submission validation asserts line price validity
  assert.match(panel, /validatePriceDecimal\(rawVal, 2\)/)
})
