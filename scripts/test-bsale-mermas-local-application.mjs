import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMermaLocalAllocationPlan } from '../src/lib/integraciones/bsale-mermas-local-application-core.ts'

const line = (id, variantId, quantity, overrides = {}) => ({
  id, variantId, quantity, createdAt: `2026-10-01T00:00:0${id}Z`, expirationDate: '2026-12-01', lot: null, hasEvidence: true, ...overrides,
})

test('allocates one confirmed detail to one request line', () => {
  assert.deepEqual(buildMermaLocalAllocationPlan([line('1', 100, 2)], [{ detailId: 555, variantId: 100, quantity: 2 }]), [
    { detailId: 555, requestLineId: '1', quantity: 2, expirationDate: '2026-12-01', lot: null },
  ])
})

test('splits one Bsale detail across same-variant request lines', () => {
  assert.deepEqual(buildMermaLocalAllocationPlan([line('1', 100, 2), line('2', 100, 3)], [{ detailId: 555, variantId: 100, quantity: 5 }]).map(item => item.quantity), [2, 3])
})

test('distributes multiple details into one request line', () => {
  assert.deepEqual(buildMermaLocalAllocationPlan([line('1', 100, 5)], [{ detailId: 555, variantId: 100, quantity: 4 }, { detailId: 556, variantId: 100, quantity: 1 }]).map(item => [item.detailId, item.quantity]), [[555, 4], [556, 1]])
})

test('supports multiple variants and copies expiry/lot from request lines', () => {
  const allocations = buildMermaLocalAllocationPlan([
    line('1', 100, 2, { expirationDate: '2026-12-01', lot: 'A' }),
    line('2', 200, 1, { expirationDate: '2027-01-01', lot: 'B' }),
  ], [{ detailId: 555, variantId: 100, quantity: 2 }, { detailId: 556, variantId: 200, quantity: 1 }])
  assert.deepEqual(allocations.map(item => [item.expirationDate, item.lot]), [['2026-12-01', 'A'], ['2027-01-01', 'B']])
})

test('rejects aggregate mismatch, missing evidence and missing expiry before writes', () => {
  assert.throws(() => buildMermaLocalAllocationPlan([line('1', 100, 3)], [{ detailId: 555, variantId: 100, quantity: 2 }]), /cantidades/)
  assert.throws(() => buildMermaLocalAllocationPlan([line('1', 100, 2, { hasEvidence: false })], [{ detailId: 555, variantId: 100, quantity: 2 }]), /evidencia/)
  assert.throws(() => buildMermaLocalAllocationPlan([line('1', 100, 2, { expirationDate: null })], [{ detailId: 555, variantId: 100, quantity: 2 }]), /vencimiento/)
})

test('preserves stable created_at/id ordering', () => {
  const allocations = buildMermaLocalAllocationPlan([
    line('b', 100, 2, { createdAt: '2026-10-01T00:00:00Z' }),
    line('a', 100, 2, { createdAt: '2026-10-01T00:00:00Z' }),
  ], [{ detailId: 555, variantId: 100, quantity: 4 }])
  assert.deepEqual(allocations.map(item => item.requestLineId), ['a', 'b'])
})
