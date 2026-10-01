import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMermaBsaleNote,
  buildMermaBsalePayload,
  executeBsaleMermaOutbound,
  executeMermaBsaleOutboundWorkflow,
} from '../src/lib/integraciones/bsale-mermas-outbound-core.ts'

const input = {
  requestCode: 'MER-0007',
  officeId: 11,
  lines: [
    { variantId: 20, quantity: 2, reason: 'Vencimiento', expirationDate: '2026-10-01' },
    { variantId: 21, quantity: 1.5, reason: 'Vencimiento', expirationDate: '2026-10-01' },
  ],
}

test('builds deterministic Bsale payload for type Mermas', () => {
  assert.equal(buildMermaBsaleNote(input.requestCode, input.lines), 'Mermas PetGroup MER-0007 | Vencimiento')
  assert.deepEqual(buildMermaBsalePayload(input), {
    note: 'Mermas PetGroup MER-0007 | Vencimiento',
    officeId: 11,
    consumptionTypeId: 2,
    details: [{ quantity: 2, variantId: 20 }, { quantity: 1.5, variantId: 21 }],
  })
  assert.ok(buildMermaBsaleNote('X'.repeat(200), [{ ...input.lines[0], reason: 'R'.repeat(200) }]).length <= 100)
})

test('does not retry a failed POST and requires reconciliation', async () => {
  let posts = 0
  const result = await executeBsaleMermaOutbound(input, {
    createConsumption: async () => {
      posts += 1
      throw new Error('timeout')
    },
    getConsumption: async () => { throw new Error('must not verify') },
    getDetails: async () => { throw new Error('must not verify') },
  })
  assert.equal(posts, 1)
  assert.deepEqual(result, { status: 'RECONCILIATION_REQUIRED', error: 'timeout' })
})

test('classifies deterministic Bsale 422 errors as failed', async () => {
  const error = Object.assign(new Error('stock insuficiente'), { status: 422 })
  const result = await executeBsaleMermaOutbound(input, {
    createConsumption: async () => { throw error },
    getConsumption: async () => { throw new Error('must not verify') },
    getDetails: async () => { throw new Error('must not verify') },
  })
  assert.deepEqual(result, { status: 'FAILED', error: 'stock insuficiente' })
})

for (const status of [401, 403]) {
  test(`classifies Bsale ${status} errors as failed`, async () => {
    const result = await executeBsaleMermaOutbound(input, {
      createConsumption: async () => { throw Object.assign(new Error('denied'), { status }) },
      getConsumption: async () => { throw new Error('must not verify') },
      getDetails: async () => { throw new Error('must not verify') },
    })
    assert.equal(result.status, 'FAILED')
  })
}

for (const status of [429, 500, 503]) {
  test(`classifies Bsale ${status} errors as reconciliation`, async () => {
    const result = await executeBsaleMermaOutbound(input, {
      createConsumption: async () => { throw Object.assign(new Error('uncertain'), { status }) },
      getConsumption: async () => { throw new Error('must not verify') },
      getDetails: async () => { throw new Error('must not verify') },
    })
    assert.equal(result.status, 'RECONCILIATION_REQUIRED')
  })
}

test('classifies timeout and network TypeError as reconciliation', async () => {
  for (const error of [new Error('timeout'), new TypeError('network')]) {
    const result = await executeBsaleMermaOutbound(input, {
      createConsumption: async () => { throw error },
      getConsumption: async () => { throw new Error('must not verify') },
      getDetails: async () => { throw new Error('must not verify') },
    })
    assert.equal(result.status, 'RECONCILIATION_REQUIRED')
  }
})

test('confirms only after header and detail verification', async () => {
  const result = await executeBsaleMermaOutbound(input, {
    createConsumption: async payload => {
      assert.equal(payload.consumptionTypeId, 2)
      return { id: 88 }
    },
    getConsumption: async () => ({ id: 88, consumptionTypeId: 2, office: { id: 11 } }),
    getDetails: async () => [
      { variant: { id: 20 }, quantity: 2 },
      { variant: { id: 21 }, quantity: 1.5 },
    ],
  })
  assert.deepEqual(result, { status: 'CONFIRMED', consumptionId: 88 })
})

test('confirms when Bsale splits details but aggregates match', async () => {
  const result = await executeBsaleMermaOutbound({
    ...input,
    lines: [{ ...input.lines[0], quantity: 3 }],
  }, {
    createConsumption: async () => ({ id: 89 }),
    getConsumption: async () => ({ id: 89, consumptionTypeId: 2, office: { id: 11 } }),
    getDetails: async () => [
      { variant: { id: 20 }, quantity: 1 },
      { variant: { id: 20 }, quantity: 2 },
    ],
  })
  assert.deepEqual(result, { status: 'CONFIRMED', consumptionId: 89 })
})

test('requires reconciliation when Bsale verification differs', async () => {
  const result = await executeBsaleMermaOutbound(input, {
    createConsumption: async () => ({ id: 88 }),
    getConsumption: async () => ({ id: 88, consumptionTypeId: 1, office: { id: 11 } }),
    getDetails: async () => [],
  })
  assert.equal(result.status, 'RECONCILIATION_REQUIRED')
})

test('requires reconciliation when POST has no consumption ID', async () => {
  const result = await executeBsaleMermaOutbound(input, {
    createConsumption: async () => ({}),
    getConsumption: async () => { throw new Error('must not verify') },
    getDetails: async () => { throw new Error('must not verify') },
  })
  assert.equal(result.status, 'RECONCILIATION_REQUIRED')
})

test('requires reconciliation when GET header fails after POST', async () => {
  const result = await executeBsaleMermaOutbound(input, {
    createConsumption: async () => ({ id: 90 }),
    getConsumption: async () => { throw new Error('GET unavailable') },
    getDetails: async () => [],
  })
  assert.equal(result.status, 'RECONCILIATION_REQUIRED')
})

function workflowHarness(initialStatus = 'PREPARED') {
  const state = {
    operationId: 'operation-1',
    status: initialStatus,
    consumptionId: initialStatus === 'CONFIRMED' ? 91 : null,
    error: initialStatus === 'FAILED' ? 'previous failure' : null,
  }
  let posts = 0
  return {
    get posts() { return posts },
    dependencies: {
      prepare: async () => ({ ...state }),
      claim: async () => {
        if (state.status !== 'PREPARED') return { claimed: false, current: { ...state } }
        state.status = 'SENDING'
        return { claimed: true }
      },
      loadRequest: async () => input,
      finish: async (_operationId, result) => {
        state.status = result.status
        state.consumptionId = result.status === 'CONFIRMED' ? result.consumptionId : null
        state.error = result.status === 'CONFIRMED' ? null : result.error
        return { ...state }
      },
      bsale: {
        createConsumption: async () => { posts += 1; return { id: 91 } },
        getConsumption: async () => ({ id: 91, consumptionTypeId: 2, office: { id: 11 } }),
        getDetails: async () => input.lines.map(line => ({ variant: { id: line.variantId }, quantity: line.quantity })),
      },
    },
  }
}

test('normal workflow is PREPARED to SENDING to CONFIRMED', async () => {
  const harness = workflowHarness()
  const result = await executeMermaBsaleOutboundWorkflow(harness.dependencies)
  assert.deepEqual(result, { status: 'CONFIRMED', operationId: 'operation-1', consumptionId: 91 })
  assert.equal(harness.posts, 1)
})

test('concurrent executions produce only one POST', async () => {
  const harness = workflowHarness()
  const results = await Promise.all([
    executeMermaBsaleOutboundWorkflow(harness.dependencies),
    executeMermaBsaleOutboundWorkflow(harness.dependencies),
  ])
  assert.equal(harness.posts, 1)
  assert.deepEqual(results.map(result => result.status).sort(), ['CONFIRMED', 'SENDING'])
})

for (const status of ['CONFIRMED', 'SENDING', 'RECONCILIATION_REQUIRED', 'FAILED']) {
  test(`does not POST when operation is already ${status}`, async () => {
    const harness = workflowHarness(status)
    const result = await executeMermaBsaleOutboundWorkflow(harness.dependencies)
    assert.equal(harness.posts, 0)
    assert.equal(result.status, status === 'CONFIRMED' ? 'CONFIRMED' : status)
  })
}
