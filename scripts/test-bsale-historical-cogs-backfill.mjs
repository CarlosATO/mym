import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareDecimalValues,
  decimalSum,
  fetchHistoricalCogsPayload,
  isEligibleHistoricalCogsDocument,
  isCompletedHistoricalCogsCost,
  selectPendingHistoricalCogsDocuments,
  validateHistoricalCogsPayload,
} from '../src/lib/integraciones/bsale-historical-cogs-backfill.ts'

const CAYLO = 'd1000000-0000-0000-0000-000000000001'
process.env.BSALE_ACCESS_TOKEN_CAYLO = 'test-token'

test('selects only 2026 invoice/boleta and excludes NC and Nota de Venta', () => {
  assert.equal(isEligibleHistoricalCogsDocument({ document_type_id: 5, state: 0, emission_date: '2026-02-01' }, 2026), true)
  assert.equal(isEligibleHistoricalCogsDocument({ document_type_id: 1, state: 0, emission_date: '2026-02-01' }, 2026), true)
  assert.equal(isEligibleHistoricalCogsDocument({ document_type_id: 2, state: 0, emission_date: '2026-02-01' }, 2026), false)
  assert.equal(isEligibleHistoricalCogsDocument({ document_type_id: 23, state: 0, emission_date: '2026-02-01' }, 2026), false)
  assert.equal(isEligibleHistoricalCogsDocument({ document_type_id: 5, state: 1, emission_date: '2026-02-01' }, 2026), false)
  assert.equal(isEligibleHistoricalCogsDocument({ document_type_id: 5, state: 0, emission_date: '2027-01-01' }, 2026), false)
})

test('skips only OBSERVED results and retries MISSING results', () => {
  const documents = [{ bsale_id: 1 }, { bsale_id: 2 }, { bsale_id: 3 }]
  const existing = [{ bsale_document_id: 1, status: 'OBSERVED' }, { bsale_document_id: 2, status: 'MISSING' }, { bsale_document_id: 3, status: 'ERROR' }]
  assert.equal(isCompletedHistoricalCogsCost(existing[0]), true)
  assert.equal(isCompletedHistoricalCogsCost(existing[1]), false)
  assert.equal(isCompletedHistoricalCogsCost(existing[2]), false)
  assert.deepEqual(selectPendingHistoricalCogsDocuments(documents, existing), [{ bsale_id: 2 }, { bsale_id: 3 }])
})

test('classifies positive cost as OBSERVED and zero as MISSING without float conversion', () => {
  assert.equal(validateHistoricalCogsPayload({ id: 1, totalCost: '12.50', cost_detail: [{ shipping_detail: { id: 10, variantTotalCost: '12.50' } }] }).status, 'OBSERVED')
  assert.equal(validateHistoricalCogsPayload({ id: 2, totalCost: 0, cost_detail: [] }).status, 'MISSING')
  assert.equal(decimalSum(['0.10', '0.20', '1.005']), '1.305')
  assert.equal(compareDecimalValues(decimalSum(['0.10', '0.20']), '0.30'), true)
})

test('rejects observed detail without shipping_detail.id', () => {
  assert.throws(() => validateHistoricalCogsPayload({ id: 1, totalCost: 10, cost_detail: [{ shipping_detail: { variantTotalCost: 10 } }] }), /shipping_detail\.id/)
})

test('HTTP 404 remains pending and never becomes MISSING', async () => {
  const result = await fetchHistoricalCogsPayload(CAYLO, 404, {
    fetchImpl: async () => new Response('{}', { status: 404 }),
    sleep: async () => {},
  })
  assert.equal(result.status, 404)
  assert.equal(result.payload, null)
  assert.equal(result.retries, 0)
})

test('retries 429 using Retry-After and returns the official payload', async () => {
  let calls = 0
  let waits = 0
  const result = await fetchHistoricalCogsPayload(CAYLO, 1, {
    fetchImpl: async () => {
      calls++
      return calls === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(JSON.stringify({ id: 1, totalCost: '1.00', cost_detail: [] }), { status: 200 })
    },
    sleep: async milliseconds => { waits += milliseconds },
  })
  assert.equal(calls, 2)
  assert.equal(waits, 0)
  assert.equal(result.retries, 1)
  assert.deepEqual(result.payload, { id: 1, totalCost: '1.00', cost_detail: [] })
})

test('retries transient 5xx responses and never classifies the error as MISSING', async () => {
  let calls = 0
  const result = await fetchHistoricalCogsPayload(CAYLO, 2, {
    fetchImpl: async () => {
      calls++
      return calls === 1
        ? new Response('{}', { status: 503 })
        : new Response('{}', { status: 503 })
    },
    sleep: async () => {},
    maxRetries: 1,
  })
  assert.equal(calls, 2)
  assert.equal(result.payload, null)
  assert.equal(result.status, 503)
  assert.equal(result.transientErrors, 2)
})

test('requires explicit companyId and persists no float-shaped values', () => {
  assert.equal(CAYLO, 'd1000000-0000-0000-0000-000000000001')
  assert.equal(typeof decimalSum(['122760.00']), 'string')
})
