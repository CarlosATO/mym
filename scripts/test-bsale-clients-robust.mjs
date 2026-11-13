import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import crypto from 'node:crypto'
import { clientsRetryAfterMs, fetchBsaleClientsPage } from '../src/lib/integraciones/bsale-clients-fetch.ts'

function load(path, modules, extra = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, { exports, require: name => { if (!(name in modules)) throw new Error(`Unexpected import: ${name}`); return modules[name] }, console, process: { env: {} }, Date, Number, Error, setTimeout, ...extra })
  return exports
}

test('429 respeta Retry-After, limita reintentos y permite recuperación posterior', async () => {
  let now = 0, calls = 0
  const waits = []
  const fetcher = async () => {
    calls++
    return calls < 3 ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : Response.json({ count: 0, items: [] })
  }
  const result = await fetchBsaleClientsPage({ url: 'https://mock.invalid', token: 'mock', deadlineAt: 20_000, fetcher, now: () => now, sleep: async ms => { waits.push(ms); now += ms } })
  assert.equal(result.count, 0)
  assert.deepEqual(waits, [3000, 3000])
  assert.equal(clientsRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000)
  calls = 0
  await assert.rejects(fetchBsaleClientsPage({ url: 'https://mock.invalid', token: 'mock', deadlineAt: 100_000, now: () => 0, sleep: async () => {}, fetcher: async () => { calls++; return new Response('', { status: 429 }) } }), /RATE_LIMIT_RETRIES_EXHAUSTED/)
  assert.equal(calls, 5)
  await assert.rejects(fetchBsaleClientsPage({ url: 'https://mock.invalid', token: 'mock', deadlineAt: 1000, now: () => 0, sleep: async () => {}, fetcher: async () => new Response('', { status: 429, headers: { 'Retry-After': '2' } }) }), /RATE_LIMIT_DEADLINE_EXCEEDED/)
})

test('timeout de conexión y de lectura finalizan sin red real', async () => {
  await assert.rejects(fetchBsaleClientsPage({ url: 'https://mock.invalid', token: 'mock', deadlineAt: Date.now() + 15, fetcher: async () => new Promise(() => {}) }), /FETCH_TIMEOUT/)
  await assert.rejects(fetchBsaleClientsPage({ url: 'https://mock.invalid', token: 'mock', deadlineAt: Date.now() + 15, fetcher: async () => ({ ok: true, status: 200, json: async () => new Promise(() => {}) }) }), /FETCH_TIMEOUT/)
})

test('finishSyncRun estricto rechaza fallos o ausencia de registro', async () => {
  let readError = false, updateError = false, missing = false
  const admin = { schema: () => ({ from: () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: readError ? null : { started_at: new Date().toISOString(), metadata: {} }, error: readError ? { message: 'read failed' } : null }) }) }),
    update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: missing ? null : { id: 'run' }, error: updateError ? { message: 'write failed' } : null }) }) }) }),
  }) }) }
  const { finishSyncRun } = load('../src/lib/integraciones/sync-core.ts', { '@supabase/supabase-js': { createClient: () => admin } })
  readError = true; await assert.rejects(finishSyncRun({ runId: 'run', status: 'SUCCESS', strict: true }), /read failed/)
  readError = false; updateError = true; await assert.rejects(finishSyncRun({ runId: 'run', status: 'SUCCESS', strict: true }), /write failed/)
  updateError = false; missing = true; await assert.rejects(finishSyncRun({ runId: 'run', status: 'SUCCESS', strict: true }), /run not found/)
  missing = false; await finishSyncRun({ runId: 'run', status: 'SUCCESS', strict: true })
})

test('el lock se libera solo cuando pertenece al run actual', async () => {
  let owner = 'other', filters = []
  const query = {
    delete() { return this }, eq(key, value) { filters.push([key, value]); return this },
    select() { return this }, async maybeSingle() { return { data: owner === 'run-1' ? { id: 'lock' } : null, error: null } },
  }
  const admin = { schema: () => ({ from: () => query }) }
  const { releaseSyncLock } = load('../src/lib/integraciones/sync-core.ts', { '@supabase/supabase-js': { createClient: () => admin } })
  await assert.rejects(releaseSyncLock('company', 'BSALE', 'clients', 'run-1'), /ownership lost/)
  assert.deepEqual(filters.at(-1), ['sync_run_id', 'run-1'])
  owner = 'run-1'; filters = []
  await releaseSyncLock('company', 'BSALE', 'clients', 'run-1')
  assert.deepEqual(filters.at(-1), ['sync_run_id', 'run-1'])
})

test('sync conserva error, libera su lock y posterior recuperación actualiza ambos estados', async () => {
  let fetchError = null, finishSuccessError = false, locked = true, nextId = 0, uncertainWrite = false, boundedFetch
  const outcomes = [], releases = [], persisted = []
  let blocked = true
  const page = async () => {
    if (fetchError) throw new Error(fetchError)
    return { count: 1, items: [{ id: 1, code: '1', company: 'Test', state: 0, commerciallyBlocked: blocked }] }
  }
  const query = (schema, table) => ({
    select() { return this }, eq() { return this }, in() { return this },
    then(resolve, reject) {
      const data = table === 'bsale_clients' ? [{ bsale_client_id: 1 }] : []
      return Promise.resolve({ data, error: null }).then(resolve, reject)
    },
    async upsert(records) {
      if (uncertainWrite) await boundedFetch('https://mock.invalid', { method: 'POST' })
      if (schema === 'integraciones' && table === 'bsale_clients') persisted.push(...records)
      return { error: null }
    },
    async insert() { return { error: null } },
    update() { return this },
  })
  const admin = {
    schema: schema => ({
      from: table => query(schema, table),
      rpc: async (fn, params) => {
        if (fn === 'get_server_timestamp') {
          return { data: new Date().toISOString(), error: null }
        }
        if (fn === 'upsert_bsale_clients_sync') {
          if (uncertainWrite) await boundedFetch('https://mock.invalid', { method: 'POST' })
          if (schema === 'integraciones' && params?.p_clients) {
            persisted.push(...params.p_clients)
          }
          return { data: params?.p_clients?.length ?? 0, error: null }
        }
        return { data: null, error: new Error(`Unknown RPC ${fn}`) }
      },
    }),
  }
  const modules = {
    '@supabase/supabase-js': { createClient: (_url, _key, options) => { boundedFetch = options.global.fetch; return admin } }, crypto,
    './sync-core': {
      createSyncRun: async () => `run-${++nextId}`,
      tryAcquireSyncLock: async ({ syncRunId }) => { assert.ok(syncRunId); return locked },
      releaseSyncLock: async (_company, _provider, _entity, runId) => { releases.push(runId) },
      recordSyncError: async () => {},
      finishSyncRun: async input => { assert.equal(input.strict, true); outcomes.push(input.status); if (finishSuccessError && input.status === 'SUCCESS') throw new Error('persist failed') },
    },
    '@/lib/bsale/company-config': { getBsaleConfigForCompany: () => ({ baseUrl: 'https://mock.invalid', accessToken: 'mock' }) },
    './bsale-clients-sync-logic': { canDeactivateAbsentClients: () => false, getAbsentBsaleClientIds: () => [] },
    './bsale-client-commercial-normalization': { normalizeBsaleClientCommercialFields: () => ({}) },
    './bsale-clients-fetch': { fetchBsaleClientsPage: page },
  }
  const { syncBsaleClients } = load('../src/lib/integraciones/bsale-clients-sync.ts', modules, { AbortSignal, fetch: async () => { throw new Error('write connection lost') } })
  const options = { companyId: 'company', triggerType: 'SCHEDULED' }
  fetchError = 'BSALE_CLIENTS_RATE_LIMIT_RETRIES_EXHAUSTED'
  assert.equal((await syncBsaleClients(options)).status, 'FAILED')
  assert.deepEqual(outcomes, ['FAILED']); assert.deepEqual(releases, ['run-1'])
  fetchError = 'BSALE_CLIENTS_FETCH_TIMEOUT'
  assert.equal((await syncBsaleClients(options)).status, 'FAILED')
  assert.equal(outcomes.at(-1), 'FAILED'); assert.equal(releases.at(-1), 'run-2')
  fetchError = null; finishSuccessError = true
  assert.equal((await syncBsaleClients(options)).status, 'FAILED')
  assert.deepEqual(outcomes.slice(-2), ['SUCCESS', 'FAILED']); assert.equal(releases.at(-1), 'run-3')
  finishSuccessError = false; blocked = false
  assert.equal((await syncBsaleClients(options)).status, 'SUCCESS')
  assert.equal(persisted[0].raw_payload.commerciallyBlocked, true)
  assert.equal(persisted.at(-1).raw_payload.commerciallyBlocked, false)
  assert.equal(releases.at(-1), 'run-4')
  locked = false
  assert.equal((await syncBsaleClients(options)).status, 'SKIPPED')
  assert.equal(outcomes.at(-1), 'SKIPPED'); assert.equal(releases.length, 4)
  locked = true; uncertainWrite = true
  assert.equal((await syncBsaleClients(options)).status, 'FAILED')
  assert.equal(outcomes.at(-1), 'FAILED')
  assert.equal(releases.length, 4, 'no libera el lock si una escritura podría seguir en curso')
})

test('endpoint distingue estados y rechaza secreto ausente o inválido', async () => {
  let status = 'SUCCESS', calls = 0
  const env = { CRON_SECRET: 'secret' }
  const modules = {
    'next/server': { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } },
    '@/lib/integraciones/bsale-clients-sync': { syncBsaleClients: async () => { calls++; return { status } } },
  }
  const route = load('../src/app/api/integraciones/bsale/clients/sync/route.ts', modules, { process: { env } })
  const request = token => ({ headers: { get: name => name === 'authorization' ? token : null } })
  assert.equal((await route.POST(request('wrong'))).status, 401)
  for (const [value, http] of [['SUCCESS', 200], ['FAILED', 500], ['SKIPPED', 409]]) {
    status = value
    const response = await route.POST(request('Bearer secret'))
    assert.equal(response.status, http); assert.equal(response.body.status, value)
  }
  delete env.CRON_SECRET
  assert.equal((await route.POST(request('Bearer undefined'))).status, 500)
  assert.equal(calls, 3)
})
