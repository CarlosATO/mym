import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCivilDate, formatInstantInSantiago } from '../src/lib/datetime.ts'

test('formats civil dates without timezone conversion', () => {
  assert.equal(formatCivilDate('2026-08-19'), '19-08-2026')
  assert.equal(formatCivilDate('2026-01-19'), '19-01-2026')
  assert.equal(formatCivilDate('2026-08-19', 'short'), '19 ago 2026')
})

test('formats instants in America/Santiago', () => {
  assert.match(formatInstantInSantiago('2026-08-19T03:30:00Z'), /18-08-2026.*23:30/)
  assert.match(formatInstantInSantiago('2026-08-19T04:30:00Z'), /19-08-2026.*00:30/)
  assert.match(formatInstantInSantiago('2026-01-19T03:30:00Z'), /19-01-2026.*00:30/)
})
