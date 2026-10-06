import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyBsaleMermaConsumption } from '../src/lib/integraciones/bsale-mermas-exclusion-core.ts'

const excluded = new Set([2620])

test('excluded type-2 consumption is rejected before ingestion', () => {
  assert.deepEqual(classifyBsaleMermaConsumption(2620, 2, excluded), {
    accepted: false,
    excluded: true,
  })
})

test('verified type-4 consumption 2621 does not require an exclusion', () => {
  assert.deepEqual(classifyBsaleMermaConsumption(2621, 4, excluded), {
    accepted: false,
    excluded: false,
  })
})

test('non-excluded type-2 consumption remains accepted', () => {
  assert.deepEqual(classifyBsaleMermaConsumption(2622, 2, excluded), {
    accepted: true,
    excluded: false,
  })
})
