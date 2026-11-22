import assert from 'node:assert/strict'
import test from 'node:test'
import { suggestServiceDueDate } from '../src/modules/cuentas-por-pagar/validation-rules.ts'

test('sugiere vencimiento con días de crédito y fecha civil válidos', () => {
  assert.equal(suggestServiceDueDate('2024-02-01', 30), '2024-03-02')
  assert.equal(suggestServiceDueDate('2024-02-29', 1), '2024-03-01')
})

test('no sugiere fechas sin información confiable', () => {
  for (const days of [null, undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(suggestServiceDueDate('2024-02-01', days), '')
  }
  assert.equal(suggestServiceDueDate('2024-02-30', 30), '')
})
