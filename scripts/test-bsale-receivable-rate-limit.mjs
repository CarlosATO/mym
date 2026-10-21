import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  classifySnapshotError,
  parseRetryAfter,
  selectPendingClientIds,
  snapshotReceivablesBatch,
} from '../src/lib/integraciones/bsale-receivable-snapshot.ts'

const companyId = 'd1000000-0000-0000-0000-000000000001'
const runnerSource = readFileSync(new URL('../src/lib/integraciones/bsale-receivable-snapshot-runner.ts', import.meta.url), 'utf8')
const snapshotSource = readFileSync(new URL('../src/lib/integraciones/bsale-receivable-snapshot.ts', import.meta.url), 'utf8')
const routeSource = readFileSync(new URL('../src/app/api/cron/receivables-snapshot/route.ts', import.meta.url), 'utf8')
const workflowSource = readFileSync(new URL('../.github/workflows/bsale-replenishment-sync.yml', import.meta.url), 'utf8')

class FakeDb {
  constructor(clientIds) {
    this.nextRun = 1
    this.run = null
    this.clients = clientIds.map(clientId => ({ bsale_client_id: clientId, raw_payload: null }))
    this.clientRows = []
    this.documentRows = []
    this.updates = []
  }

  schema() {
    return { from: table => new FakeQuery(this, table) }
  }
}

class FakeQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.operation = null
    this.payload = null
    this.filters = new Map()
    this.start = 0
    this.end = Number.MAX_SAFE_INTEGER
  }

  select() { if (!this.operation) this.operation = 'select'; return this }
  insert(payload) { this.operation = 'insert'; this.payload = payload; return this }
  update(payload) { this.operation = 'update'; this.payload = payload; return this }
  eq(column, value) { this.filters.set(column, value); return this }
  in() { return this }
  order() { return this }
  range(start, end) { this.start = start; this.end = end; return this }
  single() { return Promise.resolve(this.resolve(true)) }
  maybeSingle() { return Promise.resolve(this.resolve(false)) }
  then(resolve, reject) { return Promise.resolve(this.resolve(false)).then(resolve, reject) }

  resolve(single) {
    if (this.table === 'bsale_receivable_snapshot_runs' && this.operation === 'insert') {
      this.db.run = {
        id: `run-${this.db.nextRun++}`,
        company_id: this.payload.company_id,
        snapshot_at: this.payload.snapshot_at,
        snapshot_date: this.payload.snapshot_date,
        status: this.payload.status,
        clients_total: this.payload.clients_total,
        clients_success: 0,
        clients_unqueryable: 0,
        clients_error: 0,
        documents_total: 0,
        total_amount_owed: 0,
        coverage_percent: null,
      }
      return { data: { id: this.db.run.id }, error: null }
    }
    if (this.table === 'bsale_receivable_snapshot_runs' && this.operation === 'select') {
      return { data: this.db.run, error: null }
    }
    if (this.table === 'bsale_receivable_snapshot_runs' && this.operation === 'update') {
      Object.assign(this.db.run, this.payload)
      this.db.updates.push({ ...this.payload })
      return { data: null, error: null }
    }
    if (this.table === 'bsale_receivable_snapshot_clients' && this.operation === 'select') {
      if (this.filters.has('run_id')) return { data: this.db.clientRows.filter(row => row.run_id === this.filters.get('run_id')).slice(this.start, this.end + 1).map(row => ({ client_id: row.client_id, result: row.result })), error: null }
      const clientId = Number(this.filters.get('bsale_client_id'))
      return { data: this.db.clients.find(client => client.bsale_client_id === clientId) ?? null, error: null }
    }
    if (this.table === 'bsale_clients' && this.operation === 'select') {
      const clientId = Number(this.filters.get('bsale_client_id'))
      return { data: this.db.clients.find(client => client.bsale_client_id === clientId) ?? null, error: null }
    }
    if (this.table === 'bsale_receivable_snapshot_clients' && this.operation === 'insert') {
      this.db.clientRows.push(...(Array.isArray(this.payload) ? this.payload : [this.payload]))
      return { data: null, error: null }
    }
    if (this.table === 'bsale_receivable_snapshot_documents' && this.operation === 'select') {
      return { data: this.db.documentRows.filter(row => row.run_id === this.filters.get('run_id')).slice(this.start, this.end + 1).map(row => ({ total_amount_owed: row.total_amount_owed })), error: null }
    }
    if (this.table === 'bsale_receivable_snapshot_documents' && this.operation === 'insert') {
      this.db.documentRows.push(...(Array.isArray(this.payload) ? this.payload : [this.payload]))
      return { data: null, error: null }
    }
    return { data: single ? null : [], error: null }
  }
}

function rateLimitError() {
  return new Error('Bsale HTTP 429: {"error":"rate limit exceeded","retry_after":60}')
}

test('HTTP 200 persists SUCCESS and HTTP 400 invalid client remains unqueryable', async () => {
  const db = new FakeDb([1, 2])
  const result = await snapshotReceivablesBatch({
    db,
    companyId,
    clientIds: [1, 2],
    limit: 20,
    fetchJson: async path => {
      if (path.includes('clientid=2')) throw new Error('Bsale HTTP 400: invalid client code or id')
      return { overdue_documents: [], upcoming_documents: [] }
    },
  })

  assert.equal(result.status, 'COMPLETED')
  assert.deepEqual(db.clientRows.map(row => [row.client_id, row.result]), [[1, 'SUCCESS'], [2, 'UNPAID_DOCUMENTS_CLIENT_INVALID']])
})

test('429 pauses globally without persisting or processing the following client', async () => {
  const db = new FakeDb([1, 2, 3])
  const requested = []
  const result = await snapshotReceivablesBatch({
    db,
    companyId,
    clientIds: [1, 2, 3],
    limit: 20,
    fetchJson: async path => {
      requested.push(Number(path.match(/clientid=(\d+)/)[1]))
      throw rateLimitError()
    },
  })

  assert.deepEqual(requested, [1])
  assert.equal(db.clientRows.length, 0)
  assert.equal(result.status, 'RUNNING')
  assert.deepEqual(result.remainingClientIds, [1, 2, 3])
  assert.deepEqual(result.rateLimited, { retryAfterSeconds: 60 })
  assert.equal(db.run.status, 'RUNNING')
  assert.equal(db.run.clients_error, 0)
  assert.equal(db.run.error_summary.code, 'TRANSIENT_GLOBAL_RATE_LIMIT')
})

test('resume retries the same client first and does not duplicate processed clients', async () => {
  const db = new FakeDb([1, 2, 3])
  let shouldRateLimit = true
  const requested = []
  const fetchJson = async path => {
    const clientId = Number(path.match(/clientid=(\d+)/)[1])
    requested.push(clientId)
    if (shouldRateLimit) throw rateLimitError()
    return { overdue_documents: [], upcoming_documents: [] }
  }

  const paused = await snapshotReceivablesBatch({ db, companyId, clientIds: [1, 2, 3], limit: 20, fetchJson })
  shouldRateLimit = false
  const resumed = await snapshotReceivablesBatch({ db, companyId, clientIds: [1, 2, 3], runId: paused.runId, limit: 20, fetchJson })
  await assert.rejects(
    snapshotReceivablesBatch({ db, companyId, clientIds: [1, 2, 3], runId: paused.runId, limit: 20, fetchJson }),
    /no está RUNNING/,
  )

  assert.deepEqual(requested, [1, 1, 2, 3])
  assert.equal(db.clientRows.length, 3)
  assert.equal(new Set(db.clientRows.map(row => row.client_id)).size, 3)
  assert.equal(resumed.status, 'COMPLETED')
  assert.equal(db.run.error_summary, null)
})

test('resume reconciles stale run counters with all persisted client and document rows', async () => {
  const db = new FakeDb([1, 2, 3, 4])
  db.run = {
    id: 'interrupted-run', company_id: companyId, status: 'RUNNING',
    clients_total: 4, clients_success: 1, clients_unqueryable: 0,
    clients_error: 0, documents_total: 1, total_amount_owed: 10,
  }
  db.clientRows.push(
    { run_id: 'interrupted-run', company_id: companyId, client_id: 1, result: 'SUCCESS' },
    { run_id: 'interrupted-run', company_id: companyId, client_id: 2, result: 'SUCCESS' },
  )
  db.documentRows.push(
    { run_id: 'interrupted-run', total_amount_owed: 10 },
    { run_id: 'interrupted-run', total_amount_owed: 20 },
  )
  const requested = []
  const resumed = await snapshotReceivablesBatch({
    db, companyId, clientIds: [1, 2, 3, 4], runId: 'interrupted-run', limit: 20,
    fetchJson: async path => {
      const clientId = Number(path.match(/clientid=(\d+)/)[1])
      requested.push(clientId)
      return { overdue_documents: [{ id: 100 + clientId, totalAmountOwed: clientId * 10 }], upcoming_documents: [] }
    },
  })
  assert.deepEqual(requested, [3, 4])
  assert.equal(resumed.status, 'COMPLETED')
  assert.equal(db.run.clients_success, 4)
  assert.equal(db.run.documents_total, 4)
  assert.equal(db.run.total_amount_owed, 100)
  assert.equal(db.run.coverage_percent, 100)
  assert.equal(db.clientRows.length, 4)
  assert.equal(db.documentRows.length, 4)
  assert.deepEqual(resumed.remainingClientIds, [])
})

test('resume reconciles persisted counters even when Bsale responds with 429', async () => {
  const db = new FakeDb([1, 2, 3])
  db.run = {
    id: 'paused-run', company_id: companyId, status: 'RUNNING',
    clients_total: 3, clients_success: 1, clients_unqueryable: 0,
    clients_error: 0, documents_total: 1, total_amount_owed: 10,
  }
  db.clientRows.push(
    { run_id: 'paused-run', company_id: companyId, client_id: 1, result: 'SUCCESS' },
    { run_id: 'paused-run', company_id: companyId, client_id: 2, result: 'SUCCESS' },
  )
  db.documentRows.push(
    { run_id: 'paused-run', total_amount_owed: 10 },
    { run_id: 'paused-run', total_amount_owed: 20 },
  )
  const resumed = await snapshotReceivablesBatch({
    db, companyId, clientIds: [1, 2, 3], runId: 'paused-run', limit: 20,
    fetchJson: async () => { throw rateLimitError() },
  })
  assert.equal(resumed.status, 'RUNNING')
  assert.equal(db.run.clients_success, 2)
  assert.equal(db.run.documents_total, 2)
  assert.equal(db.run.total_amount_owed, 30)
  assert.deepEqual(resumed.remainingClientIds, [3])
  assert.deepEqual(resumed.rateLimited, { retryAfterSeconds: 60 })
})

test('resume paginates more than 1000 persisted clients without duplicating any', async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => index + 1)
  const db = new FakeDb(ids)
  db.run = {
    id: 'large-interrupted-run', company_id: companyId, status: 'RUNNING',
    clients_total: ids.length, clients_success: 900, clients_unqueryable: 0,
    clients_error: 0, documents_total: 0, total_amount_owed: 0,
  }
  db.clientRows = ids.slice(0, 1000).map(clientId => ({
    run_id: 'large-interrupted-run', company_id: companyId, client_id: clientId, result: 'SUCCESS',
  }))
  const requested = []
  const result = await snapshotReceivablesBatch({
    db, companyId, clientIds: ids, runId: 'large-interrupted-run', limit: 20,
    fetchJson: async path => {
      requested.push(Number(path.split('clientid=')[1]))
      return { overdue_documents: [], upcoming_documents: [] }
    },
  })
  assert.deepEqual(requested, [1001])
  assert.equal(result.status, 'COMPLETED')
  assert.equal(db.run.clients_success, 1001)
  assert.equal(db.clientRows.length, 1001)
})

test('non-429 HTTP errors preserve HTTP_ERROR semantics', async () => {
  assert.deepEqual(classifySnapshotError(new Error('Bsale HTTP 500: unavailable')), {
    httpStatus: 500,
    isRateLimited: false,
    retryAfterSeconds: null,
    result: 'HTTP_ERROR',
    errorCode: 'BSALE_HTTP_500',
    errorMessage: 'Bsale HTTP 500: unavailable',
  })
})

test('Retry-After accepts seconds and HTTP dates', () => {
  const now = new Date('2026-10-15T00:00:00Z')
  assert.equal(parseRetryAfter('60', now), 60)
  assert.equal(parseRetryAfter('Thu, 15 Oct 2026 00:01:15 GMT', now), 75)
  assert.equal(parseRetryAfter('invalid', now), null)
})

test('pending selection is ordered, bounded, and resumes from unprocessed clients', () => {
  assert.deepEqual(selectPendingClientIds([3, 1, 2, 1], [1], 20), [2, 3])
  assert.deepEqual(selectPendingClientIds([1, 2, 3], [1], 1), [2])
})

test('runner is sequential, releases its lock, and pauses instead of looping after 429', () => {
  assert.match(snapshotSource, /for \(const clientId of batchClientIds\)/)
  assert.match(runnerSource, /await snapshotReceivablesBatch\(/)
  assert.match(runnerSource, /await releaseLock\(db, SNAPSHOT_LOCK_NAME, lockRunId\)/)
  assert.match(runnerSource, /!batchResult\.rateLimited/)
  assert.match(routeSource, /status: 202/)
  assert.match(routeSource, /describeSnapshotError\(error\)/)
  assert.match(routeSource, /console\.error\('\[receivables-snapshot\] Execution failed'/)
})

test('workflow cooldown stays within the ten-minute job budget', () => {
  assert.match(workflowSource, /sleep 60/)
  assert.match(workflowSource, /--max-time 525/)
  assert.match(workflowSource, /timeout-minutes: 35/)
  assert.match(workflowSource, /max_snapshot_attempts=3/)
  assert.match(workflowSource, /for snapshot_attempt in \$\(seq 1 \"\$max_snapshot_attempts\"\)/)
  assert.match(workflowSource, /min_retry_after=5/)
  assert.match(workflowSource, /max_retry_after=180/)
  assert.ok(60 + (3 * 525) + (2 * 180) < 35 * 60)
})

test('workflow consumes normalized Retry-After and falls back safely', () => {
  assert.match(workflowSource, /\.rateLimited\.retryAfterSeconds \/\/ empty/)
  assert.match(workflowSource, /retry_after=60/)
  assert.match(workflowSource, /sleep \"\$retry_after\"/)
  assert.match(workflowSource, /Snapshot CxC rate-limited\. Retry in/)
  assert.match(workflowSource, /Snapshot remains RUNNING and will resume on next scheduled execution\./)
})
