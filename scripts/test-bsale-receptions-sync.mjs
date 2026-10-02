import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = await readFile(new URL('../src/lib/integraciones/bsale-receptions-sync.ts', import.meta.url), 'utf8')
const harnessSource = source.replace(
  /^import \{ createClient \} from '@supabase\/supabase-js'[\s\S]*?\} from '\.\/sync-core'\n/m,
  `const createClient = () => ({})
const createSyncRun = async () => 'stub-run'
const finishSyncRun = async () => undefined
const releaseSyncLock = async () => undefined
const tryAcquireSyncLock = async () => true
`,
)
const harnessDirectory = await mkdtemp(join(tmpdir(), 'bsale-receptions-sync-'))
const harnessPath = join(harnessDirectory, 'bsale-receptions-sync.ts')
await writeFile(harnessPath, harnessSource)
const { syncBsaleReceptionsDelta, chunk } = await import(pathToFileURL(harnessPath).href)
await rm(harnessDirectory, { recursive: true, force: true })

test('define delta con overlap de tres días y watermark persistente', () => {
  assert.match(source, /params\.overlapDays \?\? OVERLAP_DAYS/)
  assert.match(source, /watermark_admission_date: window\.to/)
  assert.match(source, /eq\('status', 'SUCCESS'\)/)
})

test('no inventa un delta inicial y permite backfill explícito', () => {
  assert.match(source, /if \(!params\.watermark\) return null/)
  assert.match(source, /backfill: true/)
  assert.match(source, /params\.to > params\.today/)
})

test('aplica cooldown y lock antes de tocar Bsale', () => {
  assert.match(source, /COOLDOWN_MINUTES = 10/)
  assert.match(source, /status: 'SKIPPED_FRESH'/)
  assert.match(source, /status: 'SKIPPED_LOCKED'/)
  assert.ok(source.indexOf('isWithinCooldown') < source.indexOf('acquire(options.companyId'))
})

test('divide persistencia en chunks pequeños', () => {
  assert.match(source, /HEADER_CHUNK_SIZE = 250/)
  assert.match(source, /DETAIL_CHUNK_SIZE = 500/)
  assert.match(source, /onConflict: 'company_id,bsale_id'/)
  assert.doesNotMatch(source, /upsert\(allDetails/)
})

test('no inventa métricas insert/update', () => {
  assert.match(source, /insertedCount: 0/)
  assert.match(source, /updatedCount: 0/)
  assert.match(source, /rows_processed: counts\.receptions_fetched \+ counts\.details_fetched/)
  assert.match(source, /rows_upserted: number/)
})

function dependencies(overrides = {}) {
  const state = {
    acquired: 0,
    released: 0,
    created: 0,
    fetchedHeaders: 0,
    fetchedDetails: 0,
    finished: [],
    createdMetadata: null,
    headerPayloads: [],
    detailPayloads: [],
  }
  const deps = {
    now: () => new Date('2026-10-02T12:00:00Z'),
    getLastSuccessfulRun: async () => null,
    acquireLock: async () => { state.acquired++; return true },
    releaseLock: async () => { state.released++ },
    createRun: async (_companyId, _trigger, metadata) => { state.created++; state.createdMetadata = metadata; return 'run-1' },
    finishRun: async (_runId, status, metadata, message) => { state.finished.push({ status, metadata, message }) },
    fetchHeaders: async () => { state.fetchedHeaders++; return [{ id: 1, admissionDate: 1790899200 }] },
    fetchDetails: async () => { state.fetchedDetails++; return [{ id: 10, quantity: 2, cost: 100, variant: { id: 7 } }] },
    resolveVariantCodes: async (_companyId, ids) => new Map(ids.map(id => [id, `SKU-${id}`])),
    upsertHeaders: async rows => { state.headerPayloads.push(...rows) },
    upsertDetails: async rows => { state.detailPayloads.push(...rows) },
    ...overrides,
  }
  return { deps, state }
}

const run = (options, deps) => syncBsaleReceptionsDelta({ companyId: 'company-a', trigger: 'CLI', dependencies: deps, ...options })

test('sin watermark no llama Bsale ni adquiere lock', async () => {
  const { deps, state } = dependencies()
  const result = await run({}, deps)
  assert.equal(result.status, 'NO_WATERMARK')
  assert.equal(state.acquired, 0)
  assert.equal(state.fetchedHeaders, 0)
})

test('success reciente devuelve SKIPPED_FRESH sin Bsale ni lock', async () => {
  const { deps, state } = dependencies({ getLastSuccessfulRun: async () => ({ finished_at: '2026-10-02T11:55:00Z', metadata: { watermark_admission_date: '2026-10-01' } }) })
  const result = await run({}, deps)
  assert.equal(result.status, 'SKIPPED_FRESH')
  assert.equal(state.acquired, 0)
  assert.equal(state.fetchedHeaders, 0)
})

test('lock ocupado no crea run ni llama Bsale', async () => {
  const { deps, state } = dependencies({
    getLastSuccessfulRun: async () => ({ metadata: { watermark_admission_date: '2026-10-01' } }),
    acquireLock: async () => { state.acquired++; return false },
  })
  const result = await run({}, deps)
  assert.equal(result.status, 'SKIPPED_LOCKED')
  assert.equal(state.created, 0)
  assert.equal(state.fetchedHeaders, 0)
})

test('delta normal calcula ventana, termina SUCCESS y avanza watermark', async () => {
  const { deps, state } = dependencies({ getLastSuccessfulRun: async () => ({ metadata: { watermark_admission_date: '2026-10-01' } }) })
  const result = await run({}, deps)
  assert.deepEqual(result.window, { from: '2026-09-28', to: '2026-10-02', backfill: false })
  assert.equal(result.status, 'SUCCESS')
  assert.equal(state.finished[0].status, 'SUCCESS')
  assert.equal(state.finished[0].metadata.watermark_admission_date, '2026-10-02')
})

test('el watermark solo existe después de SUCCESS, incluso con merge de metadata', async () => {
  const success = dependencies({ getLastSuccessfulRun: async () => ({ metadata: { watermark_admission_date: '2026-10-01' } }) })
  await run({}, success.deps)
  assert.equal('watermark_admission_date' in success.state.createdMetadata, false)
  assert.equal(success.state.finished[0].metadata.watermark_admission_date, '2026-10-02')
  assert.equal({ ...success.state.createdMetadata, ...success.state.finished[0].metadata }.watermark_admission_date, '2026-10-02')

  const failed = dependencies({
    getLastSuccessfulRun: async () => ({ metadata: { watermark_admission_date: '2026-10-01' } }),
    fetchHeaders: async () => { throw new Error('header failure') },
  })
  await run({}, failed.deps)
  assert.equal('watermark_admission_date' in failed.state.createdMetadata, false)
  assert.equal('watermark_admission_date' in failed.state.finished[0].metadata, false)
  assert.equal('watermark_admission_date' in { ...failed.state.createdMetadata, ...failed.state.finished[0].metadata }, false)
})

test('backfill explícito ignora cooldown pero respeta lock', async () => {
  const { deps, state } = dependencies({ getLastSuccessfulRun: async () => ({ finished_at: '2026-10-02T11:55:00Z', metadata: { watermark_admission_date: '2026-10-01' } }) })
  const result = await run({ from: '2026-09-01', to: '2026-09-02' }, deps)
  assert.equal(result.window.backfill, true)
  assert.equal(state.acquired, 1)
  assert.equal(state.created, 1)
})

test('error leyendo detalles termina FAILED y no marca SUCCESS', async () => {
  const { deps, state } = dependencies({
    getLastSuccessfulRun: async () => ({ metadata: { watermark_admission_date: '2026-10-01' } }),
    fetchDetails: async () => { throw new Error('detail failure') },
  })
  const result = await run({}, deps)
  assert.equal(result.status, 'FAILED')
  assert.deepEqual(state.finished.map(item => item.status), ['FAILED'])
  assert.equal('watermark_admission_date' in state.finished[0].metadata, false)
})

test('release lock siempre ocurre en SUCCESS y FAILED', async () => {
  const success = dependencies({ getLastSuccessfulRun: async () => ({ metadata: { watermark_admission_date: '2026-10-01' } }) })
  await run({}, success.deps)
  assert.equal(success.state.released, 1)
  const failed = dependencies({ getLastSuccessfulRun: async () => ({ metadata: { watermark_admission_date: '2026-10-01' } }), fetchHeaders: async () => { throw new Error('header failure') } })
  await run({}, failed.deps)
  assert.equal(failed.state.released, 1)
})

test('touched variants son IDs únicos y los payloads no contienen la FK histórica', async () => {
  const { deps, state } = dependencies({
    getLastSuccessfulRun: async () => ({ metadata: { watermark_admission_date: '2026-10-01' } }),
    fetchHeaders: async () => [{ id: 1 }, { id: 2 }],
    fetchDetails: async (_companyId, id) => [{ id: id * 10, variant: { id: 7 } }, { id: id * 10 + 1, variant: { id: id === 1 ? 8 : 7 } }],
  })
  const result = await run({}, deps)
  assert.deepEqual(result.touchedVariantIds, [7, 8])
  assert.equal(result.touchedVariantCount, 2)
  assert.ok(state.headerPayloads.every(row => !('bsale_sync_run_id' in row)))
  assert.ok(state.detailPayloads.every(row => !('bsale_sync_run_id' in row)))
})

test('chunk real respeta 250 cabeceras y 500 detalles', () => {
  assert.equal(chunk(Array.from({ length: 501 }), 250).length, 3)
  assert.equal(chunk(Array.from({ length: 1001 }), 500).length, 3)
})
