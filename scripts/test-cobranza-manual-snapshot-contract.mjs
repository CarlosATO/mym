import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/comercial/cobranza-snapshot.ts', import.meta.url), 'utf8')
const control = await readFile(new URL('../src/modules/analisis-comercial/components/cobranza-snapshot-control.tsx', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/app/dashboard/analisis-comercial/cobranza/page.tsx', import.meta.url), 'utf8')
const view = await readFile(new URL('../src/modules/analisis-comercial/views/cobranza.tsx', import.meta.url), 'utf8')
const workflow = await readFile(new URL('../.github/workflows/bsale-replenishment-sync.yml', import.meta.url), 'utf8')
const runner = await readFile(new URL('../src/lib/integraciones/bsale-receivable-snapshot-runner.ts', import.meta.url), 'utf8')

test('el trigger manual sólo despacha el modo snapshot_only', () => {
  assert.match(action, /actions\/workflows\/\$\{WORKFLOW_FILE\}\/dispatches/)
  assert.match(action, /snapshot_only: 'true'/)
  assert.match(action, /manual_claim_id: claimId/)
  assert.doesNotMatch(action, /forceSyncBsaleReplenishment/)
  assert.doesNotMatch(action, /runReplenishmentBsaleSync/)
  assert.match(action, /MANUAL_DISPATCH_LOCK_NAME/)
  assert.match(action, /\.insert\(/)
  assert.match(action, /claimError\.code === '23505'/)
  assert.match(action, /MANUAL_DISPATCH_LOCK_TTL_MINUTES/)
})

test('el workflow omite sync general para el trigger CxC manual', () => {
  assert.match(workflow, /inputs\.snapshot_only != true/)
  assert.match(workflow, /needs\.sync\.result == 'success' \|\| inputs\.snapshot_only == true \|\| inputs\.snapshot_only == 'true'/)
  assert.match(workflow, /type: boolean/)
  assert.match(workflow, /SNAPSHOT_ONLY: \$\{\{ inputs\.snapshot_only \}\}/)
  assert.match(workflow, /Snapshot-only execution: no general sync cooldown required\./)
  assert.match(workflow, /X-CxC-Snapshot-Only: \$\{SNAPSHOT_ONLY\}/)
  assert.match(workflow, /X-CxC-Manual-Claim-ID: \$\{MANUAL_CLAIM_ID\}/)
})

test('el snapshot independiente reutiliza runner, lock y run existente', () => {
  assert.match(runner, /latestRunningSnapshot/)
  assert.match(runner, /snapshotReceivablesBatch\(/)
  assert.match(runner, /runId: currentRunId/)
  assert.match(runner, /acquireLock\(db, SNAPSHOT_LOCK_NAME/)
  assert.match(runner, /releaseLock\(db, SNAPSHOT_LOCK_NAME/)
  assert.match(runner, /consumeManualDispatchClaim/)
  assert.match(runner, /eq\('run_id', claimId\)/)
})

test('el estado de UI se lee desde runs de Supabase y expone progreso/rate limit', () => {
  assert.match(action, /bsale_receivable_snapshot_runs/)
  for (const field of ['lastCompletedAt', 'activeRunId', 'clientsTotal', 'clientsProcessed', 'clientsError', 'rateLimited', 'retryAfterSeconds', 'updatedAt']) {
    assert.match(action, new RegExp(field))
  }
  assert.doesNotMatch(control, /bsaleFetch|unpaid_documents|baseUrl|accessToken/)
})

test('la UI hace polling controlado, bloquea doble ejecución y refresca al finalizar', () => {
  assert.match(control, /POLL_MS = 7000/)
  assert.match(control, /setInterval\(\(\) => \{ void refresh\(\) \}, POLL_MS\)/)
  assert.match(control, /disabled=\{running\}/)
  assert.match(control, /router\.refresh\(\)/)
  assert.match(control, /BSale solicitó una pausa/)
})

test('Cobranzas recibe estado inicial sin cambiar su fuente de datos', () => {
  assert.match(page, /getReceivablesSnapshotStatus\(\)/)
  assert.match(page, /snapshotStatus/)
  assert.match(view, /CobranzaSnapshotControl/)
  assert.match(view, /formatReceivablesSnapshotAt\(data\.snapshot_at\)/)
})
