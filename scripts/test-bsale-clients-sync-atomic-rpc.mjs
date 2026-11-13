import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import crypto from 'node:crypto'

function loadModule(path, mockedModules, extraContext = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const exports = {}
  vm.runInNewContext(compiled, {
    exports,
    require: name => {
      if (!(name in mockedModules)) throw new Error(`Unexpected import: ${name}`)
      return mockedModules[name]
    },
    console,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' } },
    Date,
    Number,
    Error,
    String,
    Boolean,
    Set,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    ...extraContext,
  })
  return exports
}

function computeHashNode(payload) {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex')
}

function createSyncMockHarness({
  clients = [
    { id: 101, code: '11.111.111-1', company: 'Empresa Alpha SpA', state: 0, commerciallyBlocked: false },
    { id: 102, code: '22.222.222-2', firstName: 'Juan', lastName: 'Perez', state: 0, commerciallyBlocked: true },
  ],
  serverTimestamp = '2026-11-13T12:00:00.000Z',
  serverTimestampError = null,
  rpcUpsertError = null,
  lockAcquired = true,
  uncertainWrite = false,
  existingCustomers = [],
} = {}) {
  const rpcCalls = []
  const directUpserts = []
  const syncRunsCreated = []
  const syncRunsFinished = []
  const syncErrorsRecorded = []
  const locksReleased = []
  const commercialCustomersUpserted = []
  const commercialCustomersInserted = []

  let boundedFetchMock = null

  const admin = {
    schema: schemaName => ({
      from: tableName => ({
        select: (columns = '*') => ({
          eq: (f1, v1) => ({
            eq: (f2, v2) => {
              if (tableName === 'bsale_payment_types') {
                return Promise.resolve({ data: [{ bsale_id: 1, name: 'Efectivo' }], error: null })
              }
              if (tableName === 'bsale_sale_conditions') {
                return Promise.resolve({ data: [{ bsale_id: 1, name: 'Contado' }], error: null })
              }
              return Promise.resolve({ data: [], error: null })
            },
            in: (f2, vals) => {
              if (tableName === 'customers') {
                return Promise.resolve({ data: existingCustomers, error: null })
              }
              return Promise.resolve({ data: [], error: null })
            },
          }),
        }),
        upsert: (records, opts) => {
          directUpserts.push({ schema: schemaName, table: tableName, records, opts })
          if (tableName === 'customers') {
            commercialCustomersUpserted.push(...records)
          }
          return Promise.resolve({ error: null })
        },
        insert: records => {
          if (tableName === 'customers') {
            commercialCustomersInserted.push(...records)
          }
          return Promise.resolve({ error: null })
        },
        update: payload => ({
          eq: () => ({
            in: () => Promise.resolve({ error: null }),
          }),
        }),
      }),
      rpc: async (functionName, params) => {
        rpcCalls.push({ name: functionName, params })
        if (functionName === 'get_server_timestamp') {
          return Promise.resolve({
            data: serverTimestampError ? null : serverTimestamp,
            error: serverTimestampError,
          })
        }
        if (functionName === 'upsert_bsale_clients_sync') {
          if (uncertainWrite && boundedFetchMock) {
            await boundedFetchMock('https://mock.invalid', { method: 'POST' })
          }
          if (rpcUpsertError) {
            return Promise.resolve({ data: null, error: rpcUpsertError })
          }
          return Promise.resolve({
            data: Array.isArray(params?.p_clients) ? params.p_clients.length : 0,
            error: null,
          })
        }
        return Promise.resolve({ data: null, error: new Error(`Unknown RPC: ${functionName}`) })
      },
    }),
  }

  const mockedModules = {
    '@supabase/supabase-js': {
      createClient: (_url, _key, options) => {
        boundedFetchMock = options?.global?.fetch
        return admin
      },
    },
    crypto,
    './sync-core': {
      createSyncRun: async options => {
        const id = `run-${syncRunsCreated.length + 1}`
        syncRunsCreated.push({ id, ...options })
        return id
      },
      tryAcquireSyncLock: async options => {
        return lockAcquired
      },
      releaseSyncLock: async (companyId, provider, entity, runId) => {
        locksReleased.push({ companyId, provider, entity, runId })
      },
      recordSyncError: async options => {
        syncErrorsRecorded.push(options)
      },
      finishSyncRun: async options => {
        syncRunsFinished.push(options)
      },
    },
    '@/lib/bsale/company-config': {
      getBsaleConfigForCompany: () => ({ baseUrl: 'https://mock.bsale.io', accessToken: 'mock-token' }),
    },
    './bsale-clients-sync-logic': {
      canDeactivateAbsentClients: () => false,
      getAbsentBsaleClientIds: () => [],
    },
    './bsale-client-commercial-normalization': {
      normalizeBsaleClientCommercialFields: client => ({
        region: 'Metropolitana',
        price_list_id: 1,
        price_list_name: 'Lista Base',
        payment_type_id: 1,
        payment_type_name: 'Efectivo',
        sale_condition_id: 1,
        sale_condition_name: 'Contado',
        has_credit: false,
        credit_limit: 0,
      }),
    },
    './bsale-clients-fetch': {
      fetchBsaleClientsPage: async () => ({
        count: clients.length,
        items: clients,
      }),
    },
  }

  const { syncBsaleClients } = loadModule(
    '../src/lib/integraciones/bsale-clients-sync.ts',
    mockedModules,
    {
      AbortSignal,
      fetch: async (input, init) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method !== 'GET') {
          throw new Error('Connection timeout during write POST')
        }
        return { ok: true, status: 200 }
      },
    }
  )

  return {
    syncBsaleClients,
    rpcCalls,
    directUpserts,
    syncRunsCreated,
    syncRunsFinished,
    syncErrorsRecorded,
    locksReleased,
    commercialCustomersUpserted,
    commercialCustomersInserted,
  }
}

// ==============================================================================
// Pruebas de Integración con Mocks
// ==============================================================================

test('1. Sincronización masiva exitosa: utiliza RPC atómica upsert_bsale_clients_sync y completa flujo', async () => {
  const clients = [
    { id: 201, code: '12345678-9', company: 'Comercial Petgroup SpA', state: 0, commerciallyBlocked: false },
    { id: 202, code: '98765432-1', firstName: 'Carlos', lastName: 'Alegria', state: 0, commerciallyBlocked: true },
  ]

  const harness = createSyncMockHarness({ clients })
  const result = await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'SCHEDULED',
  })

  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.stats.bsaleFetched, 2)
  assert.equal(result.stats.errorCount, 0)

  // Verificación de invocación a RPC atómica
  const rpcUpsertCalls = harness.rpcCalls.filter(c => c.name === 'upsert_bsale_clients_sync')
  assert.equal(rpcUpsertCalls.length, 1, 'Debe invocar upsert_bsale_clients_sync')
  assert.equal(rpcUpsertCalls[0].params.p_company_id, 'company-uuid-1')
  assert.equal(rpcUpsertCalls[0].params.p_sync_run_id, 'run-1')
  assert.equal(rpcUpsertCalls[0].params.p_snapshot_started_at, null)
  assert.equal(rpcUpsertCalls[0].params.p_clients.length, 2)

  // Cero escrituras directas sobre integraciones.bsale_clients
  const directClientsUpserts = harness.directUpserts.filter(u => u.table === 'bsale_clients')
  assert.equal(directClientsUpserts.length, 0, 'NUNCA debe llamar a from(bsale_clients).upsert')

  // Verificación de lock liberado normalmente
  assert.equal(harness.locksReleased.length, 1)
  assert.equal(harness.locksReleased[0].runId, 'run-1')

  // finishSyncRun completado con status SUCCESS
  assert.equal(harness.syncRunsFinished.length, 1)
  assert.equal(harness.syncRunsFinished[0].status, 'SUCCESS')
})

test('2. Uso correcto de runId y marca temporal: p_sync_run_id se transfiere a la RPC', async () => {
  const harness = createSyncMockHarness()
  await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'MANUAL',
    requestedBy: 'user-admin',
  })

  const rpcUpsert = harness.rpcCalls.find(c => c.name === 'upsert_bsale_clients_sync')
  assert.ok(rpcUpsert)
  assert.equal(rpcUpsert.params.p_sync_run_id, 'run-1')
  // Con runId, la RPC lee started_at desde integraciones.sync_runs directamente
  assert.equal(rpcUpsert.params.p_snapshot_started_at, null)
})

test('3. Preservación estricta de payload_hash original calculado en Node', async () => {
  const client = { id: 301, code: '77.777.777-7', company: 'Veterinaria Sur Ltda', state: 0, commerciallyBlocked: false }
  const expectedHash = computeHashNode(client)

  const harness = createSyncMockHarness({ clients: [client] })
  await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'SCHEDULED',
  })

  const rpcUpsert = harness.rpcCalls.find(c => c.name === 'upsert_bsale_clients_sync')
  assert.ok(rpcUpsert)
  const sentClient = rpcUpsert.params.p_clients[0]

  assert.equal(sentClient.bsale_client_id, 301)
  assert.equal(sentClient.payload_hash, expectedHash, 'payload_hash debe coincidir exactamente con computeHashNode')
  assert.deepEqual(sentClient.raw_payload, client, 'raw_payload debe conservarse intacto')
  assert.equal(sentClient.business_name, 'Veterinaria Sur Ltda')
})

test('4. Ejecución sin runId: obtiene get_server_timestamp de PostgreSQL antes de descargar clientes', async () => {
  const serverTimestamp = '2026-11-13T11:59:59.000Z'
  const harness = createSyncMockHarness({ serverTimestamp })

  const result = await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'SCHEDULED',
    skipRunCreation: true,
  })

  assert.equal(result.status, 'SUCCESS')

  // Verificamos que se invocó get_server_timestamp
  const rpcTimestampCalls = harness.rpcCalls.filter(c => c.name === 'get_server_timestamp')
  assert.equal(rpcTimestampCalls.length, 1, 'Debe llamar a get_server_timestamp cuando no hay runId')

  // Verificamos que upsert_bsale_clients_sync recibió p_snapshot_started_at y p_sync_run_id null
  const rpcUpsert = harness.rpcCalls.find(c => c.name === 'upsert_bsale_clients_sync')
  assert.ok(rpcUpsert)
  assert.equal(rpcUpsert.params.p_sync_run_id, null)
  assert.equal(rpcUpsert.params.p_snapshot_started_at, '2026-11-13T11:59:59.000Z')

  // Verificamos el orden: get_server_timestamp ocurrió ANTES de upsert_bsale_clients_sync
  const tsIndex = harness.rpcCalls.findIndex(c => c.name === 'get_server_timestamp')
  const upsertIndex = harness.rpcCalls.findIndex(c => c.name === 'upsert_bsale_clients_sync')
  assert.ok(tsIndex < upsertIndex, 'get_server_timestamp debe ejecutarse antes de la descarga y persistencia')
})

test('5. Fallo de RPC: registra error, detiene sync y NUNCA recurre a upsert directo inseguro', async () => {
  const harness = createSyncMockHarness({
    rpcUpsertError: { message: 'function integraciones.upsert_bsale_clients_sync does not exist' },
  })

  const result = await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'SCHEDULED',
  })

  // Status general FAILED
  assert.equal(result.status, 'FAILED')
  assert.match(result.message, /Error en RPC upsert_bsale_clients_sync/)

  // CERO intentos de usar from('bsale_clients').upsert() como fallback inseguro
  const directClientsUpserts = harness.directUpserts.filter(u => u.table === 'bsale_clients')
  assert.equal(directClientsUpserts.length, 0, 'Bajo ninguna circunstancia debe hacer fallback a upsert directo')

  // Error registrado en integraciones.sync_errors
  assert.ok(harness.syncErrorsRecorded.length >= 1, 'Debe registrar el error de sincronización')
  assert.match(harness.syncErrorsRecorded[0].errorMessage, /upsert_bsale_clients_sync/)

  // Run finalizado como FAILED
  assert.equal(harness.syncRunsFinished.at(-1)?.status, 'FAILED')

  // Lock liberado normalmente tras fallo controlado
  assert.equal(harness.locksReleased.length, 1)
})

test('6. Dry-run: procesa y reporta sin ejecutar escrituras en RPC ni clientes', async () => {
  const harness = createSyncMockHarness()
  const result = await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'MANUAL',
    isDryRun: true,
  })

  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.isDryRun, true)
  assert.equal(result.stats.bsaleFetched, 2)

  // Cero llamadas a RPC upsert
  const rpcUpsert = harness.rpcCalls.find(c => c.name === 'upsert_bsale_clients_sync')
  assert.equal(rpcUpsert, undefined, 'Dry-run no debe invocar la RPC')

  // Cero escrituras directas
  assert.equal(harness.directUpserts.length, 0)
  assert.equal(harness.commercialCustomersInserted.length, 0)
  assert.equal(harness.commercialCustomersUpserted.length, 0)
})

test('7. Conservación de controles: Lock ocupado salta la ejecución con status SKIPPED', async () => {
  const harness = createSyncMockHarness({ lockAcquired: false })
  const result = await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'SCHEDULED',
  })

  assert.equal(result.status, 'SKIPPED')
  assert.equal(harness.syncRunsFinished[0]?.status, 'SKIPPED')
  assert.equal(harness.rpcCalls.length, 0, 'No debe consultar ni escribir nada')
})

test('8. Conservación de controles: Escritura incierta conserva el lock hasta vencimiento', async () => {
  const harness = createSyncMockHarness({ uncertainWrite: true })
  const result = await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'SCHEDULED',
  })

  assert.equal(result.status, 'FAILED')
  // Lock NO debe ser liberado si el resultado de escritura fue incierto
  assert.equal(harness.locksReleased.length, 0, 'No libera el lock cuando dbWriteOutcomeUnknown es true')
})

test('9. Mantener intactas las actualizaciones de comercial.customers y clientes ausentes', async () => {
  const clients = [
    { id: 401, code: '1-9', company: 'Cliente Existente SpA', state: 0 },
    { id: 402, code: '2-7', company: 'Cliente Nuevo SpA', state: 0 },
  ]

  const existingCustomers = [
    { id: 'cust-uuid-401', bsale_client_id: 401, notes: 'Nota existente', fantasy_name: 'Fantasia 401' },
  ]

  const harness = createSyncMockHarness({ clients, existingCustomers })
  const result = await harness.syncBsaleClients({
    companyId: 'company-uuid-1',
    triggerType: 'SCHEDULED',
  })

  assert.equal(result.status, 'SUCCESS')

  // Verificamos que cliente 401 fue actualizado en comercial.customers preservando notas
  assert.equal(harness.commercialCustomersUpserted.length, 1)
  assert.equal(harness.commercialCustomersUpserted[0].id, 'cust-uuid-401')
  assert.equal(harness.commercialCustomersUpserted[0].notes, 'Nota existente')

  // Verificamos que cliente 402 fue insertado en comercial.customers
  assert.equal(harness.commercialCustomersInserted.length, 1)
  assert.equal(harness.commercialCustomersInserted[0].bsale_client_id, 402)
})
