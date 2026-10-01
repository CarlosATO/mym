import assert from 'node:assert/strict'
import test from 'node:test'
import { createAndProcessMermaRequest } from '../src/lib/integraciones/bsale-mermas-workflow-core.ts'

const request = { lines: [], evidence: [], sessionId: 'session', sessionToken: 'token', finalizeToken: 'finalize' }
const created = { requestId: 'request-1', requestCode: 'MER-0001' }

function dependencies(overrides = {}) {
  return {
    create: async () => created,
    executeOutbound: async () => ({ status: 'SENDING', operationId: 'operation-1' }),
    applyLocal: async () => ({ status: 'FINALIZADA', operationId: 'operation-1', consumptionId: 42 }),
    ...overrides,
  }
}

test('creation failure is the only non-persisted outcome', async () => {
  const result = await createAndProcessMermaRequest(request, dependencies({ create: async () => { throw new Error('invalid evidence') } }))
  assert.deepEqual(result, { outcome: 'NOT_CREATED', requestPersisted: false, error: 'invalid evidence' })
})

test('confirmed outbound and finalized local application complete the workflow', async () => {
  const result = await createAndProcessMermaRequest(request, dependencies({
    executeOutbound: async () => ({ status: 'CONFIRMED', operationId: 'operation-1', consumptionId: 42 }),
  }))
  assert.deepEqual(result, { outcome: 'FINALIZED', requestPersisted: true, ...created, operationId: 'operation-1', consumptionId: 42 })
})

test('certain Bsale failure preserves the request and does not apply locally', async () => {
  let applied = false
  const result = await createAndProcessMermaRequest(request, dependencies({
    executeOutbound: async () => ({ status: 'FAILED', operationId: 'operation-1', error: 'stock insufficient' }),
    applyLocal: async () => { applied = true; throw new Error('must not run') },
  }))
  assert.deepEqual(result, { outcome: 'BSALE_FAILED', requestPersisted: true, ...created, operationId: 'operation-1', error: 'stock insufficient' })
  assert.equal(applied, false)
})

test('reconciliation-required and sending states are preserved without retry', async () => {
  let executeCalls = 0
  const make = (status) => createAndProcessMermaRequest(request, dependencies({
    executeOutbound: async () => { executeCalls += 1; return status },
  }))
  const reconciliation = await make({ status: 'RECONCILIATION_REQUIRED', operationId: 'operation-1', error: 'unknown response' })
  const sending = await make({ status: 'SENDING', operationId: 'operation-2' })
  assert.equal(reconciliation.outcome, 'RECONCILIATION_REQUIRED')
  assert.equal(reconciliation.requestPersisted, true)
  assert.deepEqual(sending, { outcome: 'SENDING', requestPersisted: true, ...created, operationId: 'operation-2' })
  assert.equal(executeCalls, 2)
})

test('confirmed outbound with local failure remains pending and keeps consumption id', async () => {
  let applyCalls = 0
  const result = await createAndProcessMermaRequest(request, dependencies({
    executeOutbound: async () => ({ status: 'CONFIRMED', operationId: 'operation-1', consumptionId: 42 }),
    applyLocal: async () => { applyCalls += 1; throw new Error('database unavailable') },
  }))
  assert.deepEqual(result, { outcome: 'LOCAL_APPLICATION_PENDING', requestPersisted: true, ...created, operationId: 'operation-1', consumptionId: 42, error: 'database unavailable' })
  assert.equal(applyCalls, 1)
})

test('already applied local operation is finalized idempotently', async () => {
  const result = await createAndProcessMermaRequest(request, dependencies({
    executeOutbound: async () => ({ status: 'CONFIRMED', operationId: 'operation-1', consumptionId: 42 }),
    applyLocal: async () => ({ status: 'FINALIZADA', operationId: 'operation-1', consumptionId: 42 }),
  }))
  assert.equal(result.outcome, 'FINALIZED')
  assert.equal(result.requestPersisted, true)
})

test('unexpected post-creation errors never become NOT_CREATED', async () => {
  const result = await createAndProcessMermaRequest(request, dependencies({
    executeOutbound: async () => { throw new Error('state unavailable') },
  }))
  assert.equal(result.outcome, 'RECONCILIATION_REQUIRED')
  assert.equal(result.requestPersisted, true)
})

test('workflow doubles do not make Bsale HTTP calls', async () => {
  let posts = 0
  await createAndProcessMermaRequest(request, dependencies({
    executeOutbound: async () => ({ status: 'CONFIRMED', operationId: 'operation-1', consumptionId: 42 }),
    applyLocal: async () => { posts += 0; return { status: 'FINALIZADA', operationId: 'operation-1', consumptionId: 42 } },
  }))
  assert.equal(posts, 0)
})
