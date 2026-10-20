import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const route = await readFile(new URL('src/app/api/cron/bsale-receptions/route.ts', root), 'utf8')
const workflow = await readFile(new URL('.github/workflows/bsale-replenishment-sync.yml', root), 'utf8')
const syncSource = await readFile(new URL('src/lib/integraciones/bsale-receptions-sync.ts', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

test('A. el cron existente llama syncBsaleReceptions', () => {
  assert.match(workflow, /api\/cron\/bsale-receptions/)
  assert.match(route, /syncBsaleReceptions/)
})

test('B. usa trigger programado, no manual, y sin fechas manuales', () => {
  assert.match(route, /trigger: 'SCHEDULED'/)
  assert.doesNotMatch(route, /dateFrom|dateTo|allowLargeBackfill/)
})

test('C. el proceso usa watermark y overlap', () => {
  assert.match(syncSource, /watermark_admission_date/)
  assert.match(syncSource, /OVERLAP_DAYS = 3/)
  assert.match(syncSource, /planReceptionWindow/)
})

test('D. mantiene lock y cooldown', () => {
  assert.match(syncSource, /tryAcquireSyncLock/)
  assert.match(syncSource, /COOLDOWN_MINUTES = 10/)
  assert.match(syncSource, /SKIPPED_LOCKED/)
  assert.match(syncSource, /SKIPPED_FRESH/)
})

test('E. no hay ejecución duplicada desde el workflow', () => {
  assert.equal((workflow.match(/api\/cron\/bsale-receptions/g) ?? []).length, 1)
  assert.match(workflow, /concurrency:/)
  assert.match(workflow, /needs: sync/)
})

test('F. un fallo se registra y devuelve error', () => {
  assert.match(syncSource, /status: 'FAILED'/)
  assert.match(syncSource, /finish\(runId, 'FAILED'/)
  assert.match(route, /status === 'FAILED'/)
  assert.match(route, /status: 500/)
})

test('G. corre como job separado del warehouse operativo', () => {
  assert.match(workflow, /^  receptions:/m)
  assert.match(workflow, /needs: sync/)
  assert.match(workflow, /if: always\(\)/)
  assert.doesNotMatch(route, /warehouse|operational|preparation/i)
})

test('H. script registrado', () => {
  assert.equal(
    packageJson.scripts['test:bsale-sync-repair'],
    'node --experimental-strip-types --test scripts/test-bsale-products-mirror-sync.mjs scripts/test-bsale-receptions-scheduled.mjs',
  )
})
