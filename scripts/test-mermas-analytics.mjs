import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateMermasAnalytics } from '../src/lib/integraciones/mermas-analytics.ts'

const labels = new Map([[6200, { sku: '1021', name: 'DIP DOG POLLO 60GR' }]])
const base = {
  from: '2026-10-01', to: '2026-10-31', previousFrom: '2026-09-01', previousTo: '2026-09-30', labels,
}
const gross = (overrides = {}) => ({ consumptionId: 2615, detailId: 16651, variantId: 6200, requestId: 'request-1', date: '2026-10-01', quantity: 1, cost: 615, ...overrides })
const returned = (overrides = {}) => ({ sourceConsumptionId: 2615, sourceDetailId: 16651, variantId: 6200, requestId: 'request-1', date: '2026-10-01', quantity: 1, unitCost: 615, ...overrides })

test('gross without return remains net gross', () => {
  const result = calculateMermasAnalytics({ ...base, grossLines: [gross()], returnLines: [] })
  assert.deepEqual([result.totals.gross_units, result.totals.returned_units, result.totals.net_units, result.totals.net_cost], [1, 0, 1, 615])
})

test('controlled 1021 return makes gross 615 and net zero', () => {
  const result = calculateMermasAnalytics({ ...base, grossLines: [gross()], returnLines: [returned()] })
  assert.deepEqual([result.totals.gross_units, result.totals.gross_cost, result.totals.returned_units, result.totals.returned_cost, result.totals.net_units, result.totals.net_cost], [1, 615, 1, 615, 0, 0])
})

test('partial and multiple returns subtract snapshot costs exactly', () => {
  const result = calculateMermasAnalytics({ ...base, grossLines: [gross({ quantity: 4, cost: 100 })], returnLines: [returned({ quantity: 1, unitCost: 100 }), returned({ quantity: 2, unitCost: 110 })] })
  assert.deepEqual([result.totals.gross_units, result.totals.returned_units, result.totals.net_units, result.totals.returned_cost, result.totals.net_cost], [4, 3, 1, 320, 80])
})

test('multi-MER lines reconcile independently', () => {
  const result = calculateMermasAnalytics({ ...base, grossLines: [gross({ consumptionId: 1, detailId: 1, quantity: 1, cost: 10 }), gross({ consumptionId: 2, detailId: 2, quantity: 2, cost: 20 })], returnLines: [returned({ sourceConsumptionId: 2, sourceDetailId: 2, quantity: 1, unitCost: 20 })] })
  assert.deepEqual([result.totals.gross_units, result.totals.returned_units, result.totals.net_units, result.totals.net_cost], [3, 1, 2, 30])
})

test('a return in a later period is negative in that period and uses sending date', () => {
  const result = calculateMermasAnalytics({ ...base, grossLines: [gross({ date: '2026-09-30' })], returnLines: [returned({ date: '2026-10-02' })] })
  assert.deepEqual([result.totals.gross_units, result.totals.returned_units, result.totals.net_units, result.totals.net_cost, result.totals.previous_net_cost], [0, 1, -1, -615, 615])
  assert.equal(result.monthly[0].month, '2026-10')
})

test('returned units above gross are reported as an inconsistency', () => {
  const result = calculateMermasAnalytics({ ...base, grossLines: [gross({ quantity: 1 })], returnLines: [returned({ quantity: 2 })] })
  assert.equal(result.totals.inconsistencies.length, 1)
  assert.equal(result.totals.net_units, -1)
})
