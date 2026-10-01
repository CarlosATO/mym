import assert from 'node:assert/strict'
import test from 'node:test'
import { filterExcludedMermaReceptionIds } from '../src/lib/integraciones/merma-reception-exclusion-core.ts'

test('only structured Merma reception IDs are excluded', () => {
  assert.deepEqual(filterExcludedMermaReceptionIds([100, 11336, 200], new Set([11336])), [100, 200])
})

test('ordinary OTRO receptions are not excluded by document type', () => {
  assert.deepEqual(filterExcludedMermaReceptionIds([100], new Set()), [100])
})

test('a reconciliation-required reception ID is excluded when present in the source set', () => {
  assert.deepEqual(filterExcludedMermaReceptionIds([11336], new Set([11336])), [])
})
