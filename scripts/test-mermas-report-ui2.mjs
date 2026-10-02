import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getImpactPercentage,
  getMonthlyDisplayState,
  getRecoveryRate,
  isFullyRecoveredProduct,
} from '../src/modules/logistica/mermas/mermas-report-utils.ts'

test('recovery rate handles zero, partial, and full recovery', () => {
  assert.equal(getRecoveryRate(0, 0), null)
  assert.equal(getRecoveryRate(1000, 250), 25)
  assert.equal(getRecoveryRate(615, 615), 100)
})

test('monthly display preserves negative cross-period net', () => {
  const state = getMonthlyDisplayState({
    month: '2026-10', gross_cost: 0, gross_units: 0,
    returned_cost: 615, returned_units: 1, net_cost: -615, net_units: -1,
  })
  assert.equal(state.net_cost, -615)
  assert.equal(state.isCrossPeriodRecovery, true)
})

test('fully recovered product remains identifiable', () => {
  assert.equal(isFullyRecoveredProduct({ gross_units: 1, returned_units: 1, net_units: 0, net_cost: 0 }), true)
  assert.equal(isFullyRecoveredProduct({ gross_units: 2, returned_units: 1, net_units: 1, net_cost: 615 }), false)
})

test('impact percentage uses net total and has no base at zero', () => {
  assert.equal(getImpactPercentage(250, 1000), 25)
  assert.equal(getImpactPercentage(-615, 1000), -61.5)
  assert.equal(getImpactPercentage(250, 0), null)
})
