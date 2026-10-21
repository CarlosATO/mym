import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyReceivablesSnapshotExecution,
  RECEIVABLES_SNAPSHOT_GRACE_MS,
} from '../src/lib/integraciones/receivables-snapshot-execution-state.ts'

const now = new Date('2026-10-21T15:00:00Z')
const old = '2026-10-21T13:25:34Z'
const recent = '2026-10-21T14:59:01Z'
const base = {
  runStatus: 'RUNNING',
  snapshotAt: old,
  lastProgressAt: old,
  lastRateLimitAt: null,
  hasLiveLock: false,
  rateLimited: false,
  now,
}

test('non-running and completed runs never permit resume', () => {
  assert.equal(classifyReceivablesSnapshotExecution({ ...base, runStatus: null }), 'IDLE')
  assert.equal(classifyReceivablesSnapshotExecution({ ...base, runStatus: 'COMPLETED' }), 'IDLE')
  assert.equal(classifyReceivablesSnapshotExecution({ ...base, runStatus: 'FAILED' }), 'IDLE')
})

test('a valid worker or dispatch lock prevents duplicate synchronization', () => {
  assert.equal(classifyReceivablesSnapshotExecution({ ...base, hasLiveLock: true }), 'ACTIVE')
})

test('recent progress protects newly started or momentarily unlocked jobs', () => {
  assert.equal(classifyReceivablesSnapshotExecution({ ...base, snapshotAt: recent }), 'ACTIVE')
  assert.equal(classifyReceivablesSnapshotExecution({ ...base, lastProgressAt: recent }), 'ACTIVE')
  assert.equal(classifyReceivablesSnapshotExecution({
    ...base, snapshotAt: new Date(now.getTime() - RECEIVABLES_SNAPSHOT_GRACE_MS + 1000).toISOString(),
  }), 'ACTIVE')
})

test('abandoned run with no live lock is interrupted and can be resumed', () => {
  assert.equal(classifyReceivablesSnapshotExecution(base), 'INTERRUPTED')
  assert.equal(classifyReceivablesSnapshotExecution({
    ...base, snapshotAt: new Date(now.getTime() - RECEIVABLES_SNAPSHOT_GRACE_MS).toISOString(),
    lastProgressAt: null,
  }), 'INTERRUPTED')
})

test('provider rate limit retains pause semantics and grace before resuming', () => {
  assert.equal(classifyReceivablesSnapshotExecution({ ...base, rateLimited: true }), 'PAUSED')
  assert.equal(classifyReceivablesSnapshotExecution({
    ...base, rateLimited: true, lastRateLimitAt: recent,
  }), 'ACTIVE')
})

test('missing or invalid timing data fails closed rather than authorizing resume', () => {
  assert.equal(classifyReceivablesSnapshotExecution({
    ...base, snapshotAt: null, lastProgressAt: null,
  }), 'ACTIVE')
  assert.equal(classifyReceivablesSnapshotExecution({
    ...base, snapshotAt: 'bad timestamp', lastProgressAt: null,
  }), 'ACTIVE')
})
