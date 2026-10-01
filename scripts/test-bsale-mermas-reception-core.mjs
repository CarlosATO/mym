import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFefoSnapshot,
  buildReceptionPayload,
  executeBsaleReception,
  executeBsaleReceptionWorkflow,
  localApplicationPendingResult,
  weightedUnitCost,
} from '../src/lib/integraciones/bsale-mermas-reception-core.ts'

const line = (overrides = {}) => ({
  variantId: 1021,
  quantity: 4,
  expirationDate: '2026-10-01',
  lot: 'A',
  requestId: null,
  requestLineId: null,
  sourceMovementId: null,
  sourceConsumptionId: null,
  sourceDetailId: null,
  unitCost: 615,
  ...overrides,
})

test('FEFO consumes earliest expiry and preserves the cost snapshot', () => {
  const snapshot = buildFefoSnapshot('MER-2026-000011', 7, 'Regularización', [{ variantId: 1021, quantity: 5 }], [
    line({ quantity: 2, expirationDate: '2026-12-01', lot: 'B', unitCost: 700 }),
    line({ quantity: 4, expirationDate: '2026-10-01', lot: 'A', unitCost: 615 }),
  ])
  assert.deepEqual(snapshot.lines.map(item => [item.quantity, item.lot]), [[4, 'A'], [1, 'B']])
  assert.deepEqual(buildReceptionPayload(snapshot).details, [
    { quantity: 4, variantId: 1021, cost: 615 },
    { quantity: 1, variantId: 1021, cost: 700 },
  ])
})

test('partial regularization consumes only the selected quantity from one MER', () => {
  const snapshot = buildFefoSnapshot('MER-GENERIC-1', 7, 'Ajuste parcial', [{ variantId: 1021, quantity: 2 }], [
    line({ quantity: 5, requestId: 'mer-a', requestLineId: 'line-a' }),
  ])
  assert.equal(snapshot.lines.reduce((sum, item) => sum + item.quantity, 0), 2)
  assert.equal(snapshot.lines[0].requestId, 'mer-a')
  assert.equal(snapshot.lines[0].requestLineId, 'line-a')
})

test('one regularization can consume multiple MER sources and variants', () => {
  const snapshot = buildFefoSnapshot('MER-GENERIC-2', 7, 'Ajuste múltiple', [
    { variantId: 1021, quantity: 6 },
    { variantId: 2042, quantity: 1 },
  ], [
    line({ quantity: 5, requestId: 'mer-a', requestLineId: 'line-a', expirationDate: '2026-10-01' }),
    line({ quantity: 4, requestId: 'mer-b', requestLineId: 'line-b', expirationDate: '2026-11-01' }),
    line({ variantId: 2042, quantity: 2, requestId: 'mer-c', requestLineId: 'line-c' }),
  ])
  assert.deepEqual(snapshot.lines.map(item => [item.variantId, item.quantity, item.requestId, item.requestLineId]), [
    [1021, 5, 'mer-a', 'line-a'],
    [1021, 1, 'mer-b', 'line-b'],
    [2042, 1, 'mer-c', 'line-c'],
  ])
  assert.equal('requestId' in buildReceptionPayload(snapshot), false)
})

test('weighted historical cost is quantity weighted', () => {
  assert.equal(weightedUnitCost([{ quantity: 4, unitCost: 615 }, { quantity: 1, unitCost: 700 }]), 632)
})

test('post is not retried and a successful response is verified remotely', async () => {
  let posts = 0
  const result = await executeBsaleReception({
    correlationCode: 'MER-2026-000011',
    officeId: 7,
    reason: 'Regularización',
    lines: [line()],
  }, {
    createReception: async () => { posts += 1; return { id: 91 } },
    getReception: async () => ({ id: 91, office: { id: 7 } }),
    getDetails: async () => [{ variant: { id: 1021 }, quantity: 4, cost: 615 }],
  })
  assert.deepEqual(result, { status: 'CONFIRMED', receptionId: 91 })
  assert.equal(posts, 1)
})

test('verification mismatch requires reconciliation', async () => {
  const result = await executeBsaleReception({ correlationCode: 'MER-2026-000011', officeId: 7, reason: 'x', lines: [line()] }, {
    createReception: async () => ({ id: 91 }),
    getReception: async () => ({ id: 91, office: { id: 7 } }),
    getDetails: async () => [{ variant: { id: 1021 }, quantity: 3, cost: 615 }],
  })
  assert.equal(result.status, 'RECONCILIATION_REQUIRED')
})

test('timeout-like POST failure requires reconciliation instead of a blind retry', async () => {
  const error = Object.assign(new Error('timeout'), { status: 408 })
  const result = await executeBsaleReception({ correlationCode: 'MER-2026-000011', officeId: 7, reason: 'x', lines: [line()] }, {
    createReception: async () => { throw error },
    getReception: async () => ({ id: 1 }),
    getDetails: async () => [],
  })
  assert.equal(result.status, 'RECONCILIATION_REQUIRED')
})

test('a concurrent worker does not POST after the operation was claimed elsewhere', async () => {
  let posts = 0
  const result = await executeBsaleReceptionWorkflow({
    prepare: async () => ({ operationId: 'op-1', status: 'PREPARED', receptionId: null, error: null, payload: null }),
    claim: async () => ({ claimed: false, current: { operationId: 'op-1', status: 'SENDING', receptionId: null, error: null, payload: null } }),
    loadSnapshot: async () => { throw new Error('No debe cargar el snapshot') },
    finish: async () => { throw new Error('No debe cerrar la operación') },
    bsale: {
      createReception: async () => { posts += 1; return { id: 1 } },
      getReception: async () => ({ id: 1 }),
      getDetails: async () => [],
    },
  })
  assert.equal(result.status, 'SENDING')
  assert.equal(posts, 0)
})

test('terminal and sending states never POST on idempotent re-execution', async () => {
  for (const status of ['CONFIRMED', 'SENDING', 'RECONCILIATION_REQUIRED', 'FAILED']) {
    let posts = 0
    const result = await executeBsaleReceptionWorkflow({
      prepare: async () => ({ operationId: 'same-key', status, receptionId: status === 'CONFIRMED' ? 91 : null, error: status === 'FAILED' ? 'failed' : null, payload: null }),
      claim: async () => { throw new Error('No debe reclamar un estado existente') },
      loadSnapshot: async () => { throw new Error('No debe cargar snapshot') },
      finish: async () => { throw new Error('No debe cerrar operación') },
      bsale: {
        createReception: async () => { posts += 1; return { id: 91 } },
        getReception: async () => ({ id: 91 }),
        getDetails: async () => [],
      },
    })
    assert.equal(posts, 0)
    assert.equal(result.status, status === 'CONFIRMED' ? 'CONFIRMED' : status)
  }
})

test('confirmed local application failure is a distinct pending state', () => {
  assert.deepEqual(localApplicationPendingResult({ operationId: 'op-1', status: 'CONFIRMED', receptionId: 91, error: null, payload: null }, new Error('local RPC failed')), {
    status: 'LOCAL_APPLICATION_PENDING', operationId: 'op-1', receptionId: 91, error: 'local RPC failed',
  })
})

test('same idempotency key prepares once and makes at most one POST', async () => {
  let posts = 0
  let first = true
  const dependencies = () => executeBsaleReceptionWorkflow({
    prepare: async () => first
      ? { operationId: 'same-key', status: 'PREPARED', receptionId: null, error: null, payload: null }
      : { operationId: 'same-key', status: 'CONFIRMED', receptionId: 91, error: null, payload: null },
    claim: async () => ({ claimed: true }),
    loadSnapshot: async () => ({ correlationCode: 'REG-1', officeId: 7, reason: 'x', lines: [line()] }),
    finish: async () => { first = false; return { operationId: 'same-key', status: 'CONFIRMED', receptionId: 91, error: null, payload: null } },
    bsale: {
      createReception: async () => { posts += 1; return { id: 91 } },
      getReception: async () => ({ id: 91, office: { id: 7 } }),
      getDetails: async () => [{ variant: { id: 1021 }, quantity: 4, cost: 615 }],
    },
  })
  assert.equal((await dependencies()).status, 'CONFIRMED')
  assert.equal((await dependencies()).status, 'CONFIRMED')
  assert.equal(posts, 1)
})
