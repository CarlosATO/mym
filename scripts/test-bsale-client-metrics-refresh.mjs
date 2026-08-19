import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { canRefreshClientMetricsSnapshot } from '../src/lib/integraciones/client-metrics-refresh-policy.ts'

const orchestrator = await readFile(new URL('../src/app/actions/integraciones/bsale-sync.ts', import.meta.url), 'utf8')

test('successful commercial path refreshes once after orphan hydration', () => {
  assert.equal(canRefreshClientMetricsSnapshot(true), true)
  assert.equal((orchestrator.match(/await refreshClientMetricsSnapshot\(companyId\)/g) || []).length, 1)
  assert.ok(orchestrator.indexOf('hydrateOrphanClients(companyId, runId)') < orchestrator.indexOf('await refreshClientMetricsSnapshot(companyId)'))
})

test('required commercial failure prevents refresh', () => {
  assert.equal(canRefreshClientMetricsSnapshot(false), false)
  assert.match(orchestrator, /commercialSyncConsistent = false/)
})

test('refresh failure becomes FAILED instead of a clean success', () => {
  const refreshCall = orchestrator.indexOf('await refreshClientMetricsSnapshot(companyId)')
  const failureHandling = orchestrator.indexOf("finalStatus = 'FAILED';", refreshCall)
  assert.ok(failureHandling > refreshCall)
})
