import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findPreviousClosedOverdue,
  receivablesEvolutionRate,
} from '../src/lib/control-financiero/receivables-metrics.ts'

test('calculates improvement when overdue cartera decreases', () => {
  assert.equal(receivablesEvolutionRate('30000000', '27000000'), 10)
})

test('calculates deterioration when overdue cartera increases', () => {
  assert.equal(receivablesEvolutionRate('27000000', '30000000'), -11.11111111111111)
})

test('returns zero when overdue cartera is unchanged', () => {
  assert.equal(receivablesEvolutionRate('30000000', '30000000'), 0)
})

test('returns null for zero denominator or unavailable values', () => {
  assert.equal(receivablesEvolutionRate('0', '100'), null)
  assert.equal(receivablesEvolutionRate(null, '100'), null)
})

test('ACTUAL uses the latest closed month before the cutoff', () => {
  const months = [
    { month: 1, overdue_amount: '100' },
    { month: 9, overdue_amount: '90' },
    { month: 10, overdue_amount: '80' },
  ]
  assert.equal(findPreviousClosedOverdue(months, '2026-10-06'), '90')
  assert.equal(receivablesEvolutionRate(findPreviousClosedOverdue(months, '2026-10-06'), '70'), 22.22222222222222)
})

test('January has no previous monthly reference', () => {
  assert.equal(findPreviousClosedOverdue([{ month: 1, overdue_amount: '100' }], '2026-01-31'), null)
})
