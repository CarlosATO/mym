import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function loadModule(path, mockedModules = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const exports = {}
  const moduleContext = {
    exports,
    require: name => {
      if (name in mockedModules) return mockedModules[name]
      throw new Error(`Unexpected import in test: ${name}`)
    },
    console,
    process: { env: {} },
    Date,
    Number,
    Error,
    String,
    Boolean,
    AbortSignal,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
  }

  vm.runInNewContext(compiled, moduleContext)
  return exports
}

// BsaleApiError mock
class MockBsaleApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'BsaleApiError'
    this.status = status
  }
}

const normalizationModule = loadModule(
  '../src/lib/integraciones/bsale-client-commercial-normalization.ts',
  {}
)
const { parseCommerciallyBlocked } = normalizationModule

const mockedBaseModules = {
  '@/lib/supabase/server': { createClient: async () => ({}) },
  '@/lib/supabase/admin': { createAdminClient: () => ({}) },
  '@/lib/bsale/client': {
    bsaleFetchResourceForCompany: async () => ({}),
    BsaleApiError: MockBsaleApiError,
  },
  '@/lib/integraciones/bsale-client-commercial-normalization': normalizationModule,
  './authorization': {
    requireWmsPermission: async () => ({
      companyId: 'company-1',
      isOperatorBodega: false,
      user: { id: 'user-1' },
    }),
  },
}

const { executeVerifyCardClientCommercial } = loadModule(
  '../src/app/actions/logistica/sales-order-client-commercial-verification.ts',
  mockedBaseModules
)

function createMockDb({
  card = {
    id: 'card-1',
    company_id: 'company-1',
    status: 'IN_PREPARATION',
    bsale_nv_id: 5001,
    bsale_nv_folio: '5001',
    canonical_bsale_token: 'token-abc',
    current_bsale_nv_id: 5002,
  },
  canonicalDoc = { current_bsale_id: 5002, client_id: 101 },
  doc = { client_id: 101 },
  existingClient = {
    id: 'client-row-1',
    raw_payload: { id: 101, commerciallyBlocked: true },
    last_sync_at: '2026-11-10T00:00:00Z',
  },
  cardError = null,
  readClientError = null,
  serverTimestamp = '2026-11-13T12:00:00.000Z',
  serverTimestampError = null,
  rpcData = null,
  rpcError = null,
  onRpc = () => {},
  onDirectWrite = () => {},
} = {}) {
  const rpcCalls = []
  const directWrites = []

  const userDb = {
    schema: schemaName => ({
      from: tableName => ({
        select: () => ({
          eq: (f1, v1) => ({
            eq: (f2, v2) => ({
              maybeSingle: async () => {
                if (tableName === 'sales_order_preparation_cards') {
                  return { data: cardError ? null : card, error: cardError }
                }
                if (tableName === 'vw_bsale_sales_order_documents_canonical') {
                  return { data: canonicalDoc, error: null }
                }
                if (tableName === 'bsale_documents') {
                  return { data: doc, error: null }
                }
                return { data: null, error: null }
              },
            }),
            maybeSingle: async () => {
              if (tableName === 'bsale_documents') return { data: doc, error: null }
              return { data: null, error: null }
            },
          }),
        }),
      }),
    }),
  }

  const adminDb = {
    schema: schemaName => ({
      from: tableName => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (readClientError) return { data: null, error: readClientError }
                return { data: existingClient, error: null }
              },
            }),
          }),
        }),
        update: payload => {
          directWrites.push({ action: 'update', tableName, payload })
          onDirectWrite({ action: 'update', tableName, payload })
          return {
            eq: () => Promise.resolve({ error: null }),
          }
        },
        insert: payload => {
          directWrites.push({ action: 'insert', tableName, payload })
          onDirectWrite({ action: 'insert', tableName, payload })
          return Promise.resolve({ error: null })
        },
      }),
      rpc: (rpcName, rpcParams) => {
        rpcCalls.push({ name: rpcName, params: rpcParams })
        onRpc(rpcName, rpcParams)
        if (rpcName === 'get_server_timestamp') {
          return Promise.resolve({
            data: serverTimestampError ? null : serverTimestamp,
            error: serverTimestampError,
          })
        }
        if (rpcName === 'update_bsale_client_commercial_status') {
          if (rpcError) {
            return Promise.resolve({ data: null, error: rpcError })
          }
          if (rpcData !== null) {
            return Promise.resolve({ data: rpcData, error: null })
          }
          // Default: returns applied = true matching params
          return Promise.resolve({
            data: {
              id: existingClient?.id ?? 'generated-uuid-1',
              company_id: rpcParams?.p_company_id,
              bsale_client_id: rpcParams?.p_bsale_client_id,
              commercially_blocked: rpcParams?.p_commercially_blocked,
              commercial_observed_at: rpcParams?.p_observed_at,
              applied: true,
            },
            error: null,
          })
        }
        return Promise.resolve({ data: null, error: new Error(`Unknown RPC ${rpcName}`) })
      },
    }),
  }

  return { userDb, adminDb, rpcCalls, directWrites }
}

test('parseCommerciallyBlocked reconoce variantes booleanas y numéricas', () => {
  assert.equal(parseCommerciallyBlocked(true), true)
  assert.equal(parseCommerciallyBlocked(1), true)
  assert.equal(parseCommerciallyBlocked('1'), true)
  assert.equal(parseCommerciallyBlocked('true'), true)

  assert.equal(parseCommerciallyBlocked(false), false)
  assert.equal(parseCommerciallyBlocked(0), false)
  assert.equal(parseCommerciallyBlocked('0'), false)
  assert.equal(parseCommerciallyBlocked('false'), false)

  assert.equal(parseCommerciallyBlocked(null), null)
  assert.equal(parseCommerciallyBlocked(undefined), null)
  assert.equal(parseCommerciallyBlocked('otro'), null)
})

test('1. Cliente pasa de bloqueado a desbloqueado: invoca RPC atómica con applied=true y reporta UNBLOCKED', async () => {
  const { userDb, adminDb, rpcCalls, directWrites } = createMockDb({
    existingClient: {
      id: 'row-1',
      raw_payload: { id: 101, name: 'Empresa SpA', commerciallyBlocked: true },
      last_sync_at: '2026-11-01T10:00:00Z',
    },
    serverTimestamp: '2026-11-13T12:00:00.000Z',
  })

  let bsaleCalls = []
  const fetchBsaleResource = async options => {
    bsaleCalls.push(options)
    return { id: 101, company: 'Empresa SpA', commerciallyBlocked: false }
  }

  const result = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource,
  })

  assert.equal(result.error, null)
  assert.equal(result.data?.cardId, 'card-1')
  assert.equal(result.data?.clientId, 101)
  assert.equal(result.data?.status, 'UNBLOCKED')
  assert.equal(result.data?.commerciallyBlocked, false)
  assert.equal(result.data?.verifiedAt, '2026-11-13T12:00:00.000Z')
  assert.equal(result.data?.previousStatus, 'BLOCKED')
  assert.equal(result.data?.applied, true)

  // Cero escrituras directas INSERT o UPDATE sobre integraciones.bsale_clients
  assert.equal(directWrites.length, 0, 'No debe ejecutar INSERT/UPDATE directos')

  // RPCs invocadas en el orden correcto
  assert.equal(rpcCalls.length, 2)
  assert.equal(rpcCalls[0].name, 'get_server_timestamp')
  assert.equal(rpcCalls[1].name, 'update_bsale_client_commercial_status')
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[1].params)), {
    p_company_id: 'company-1',
    p_bsale_client_id: 101,
    p_commercially_blocked: false,
    p_observed_at: '2026-11-13T12:00:00.000Z',
    p_raw_client: { id: 101, company: 'Empresa SpA', commerciallyBlocked: false },
  })
})

test('2. Cliente pasa de desbloqueado a bloqueado: invoca RPC atómica y reporta BLOCKED', async () => {
  const { userDb, adminDb, rpcCalls, directWrites } = createMockDb({
    existingClient: {
      id: 'row-1',
      raw_payload: { id: 101, commerciallyBlocked: false },
      last_sync_at: '2026-11-01T10:00:00Z',
    },
    serverTimestamp: '2026-11-13T12:01:00.000Z',
  })

  const fetchBsaleResource = async () => ({ id: 101, commerciallyBlocked: true })

  const result = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource,
  })

  assert.equal(result.error, null)
  assert.equal(result.data?.status, 'BLOCKED')
  assert.equal(result.data?.previousStatus, 'UNBLOCKED')
  assert.equal(result.data?.commerciallyBlocked, true)
  assert.equal(result.data?.applied, true)
  assert.equal(directWrites.length, 0)

  assert.equal(rpcCalls[1].name, 'update_bsale_client_commercial_status')
  assert.equal(rpcCalls[1].params.p_commercially_blocked, true)
  assert.equal(rpcCalls[1].params.p_observed_at, '2026-11-13T12:01:00.000Z')
})

test('3. Cliente continúa bloqueado: conserva BLOCKED y actualiza marca mediante RPC', async () => {
  const { userDb, adminDb, rpcCalls, directWrites } = createMockDb({
    existingClient: {
      id: 'row-1',
      raw_payload: { id: 101, commerciallyBlocked: true },
      last_sync_at: '2026-11-01T10:00:00Z',
    },
    serverTimestamp: '2026-11-13T12:05:00.000Z',
  })

  const fetchBsaleResource = async () => ({ id: 101, commerciallyBlocked: 1 })

  const result = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource,
  })

  assert.equal(result.error, null)
  assert.equal(result.data?.status, 'BLOCKED')
  assert.equal(result.data?.previousStatus, 'BLOCKED')
  assert.equal(result.data?.commerciallyBlocked, true)
  assert.equal(result.data?.applied, true)
  assert.equal(directWrites.length, 0)
  assert.equal(rpcCalls[1].params.p_commercially_blocked, true)
})

test('4. Bsale responde 429, error o timeout: no asume desbloqueado y NO invoca RPC de actualización', async () => {
  const { userDb, adminDb, rpcCalls, directWrites } = createMockDb({
    existingClient: {
      id: 'row-1',
      raw_payload: { id: 101, commerciallyBlocked: true },
    },
    serverTimestamp: '2026-11-13T12:10:00.000Z',
  })

  // Subcaso 4a: HTTP 429
  const rateLimitFetch = async () => {
    throw new MockBsaleApiError(429, 'Rate limit exceeded')
  }

  const res429 = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource: rateLimitFetch,
  })

  assert.equal(res429.data?.status, 'UNKNOWN')
  assert.equal(res429.data?.previousStatus, 'BLOCKED')
  assert.equal(res429.data?.commerciallyBlocked, null)
  assert.match(res429.error, /Rate limit exceeded/)
  assert.equal(directWrites.length, 0)
  // Verificamos que get_server_timestamp fue llamado pero update_bsale_client_commercial_status NUNCA
  assert.equal(rpcCalls.some(c => c.name === 'update_bsale_client_commercial_status'), false)

  // Subcaso 4b: Timeout
  const timeoutFetch = async () => {
    throw new Error('BSALE_FETCH_TIMEOUT')
  }

  const resTimeout = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource: timeoutFetch,
  })

  assert.equal(resTimeout.data?.status, 'UNKNOWN')
  assert.equal(resTimeout.data?.previousStatus, 'BLOCKED')
  assert.match(resTimeout.error, /BSALE_FETCH_TIMEOUT/)
  assert.equal(directWrites.length, 0)
  assert.equal(rpcCalls.some(c => c.name === 'update_bsale_client_commercial_status'), false)
})

test('5. Cliente no coincide o commerciallyBlocked ausente/no reconocido: no asume habilitado y NO invoca RPC', async () => {
  const { userDb, adminDb, rpcCalls, directWrites } = createMockDb({
    existingClient: {
      id: 'row-1',
      raw_payload: { id: 101, commerciallyBlocked: true },
    },
  })

  // Subcaso 5a: ID devuelto no coincide (ej: 999 !== 101)
  const mismatchFetch = async () => ({ id: 999, commerciallyBlocked: false })

  const resMismatch = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource: mismatchFetch,
  })

  assert.equal(resMismatch.data?.status, 'UNKNOWN')
  assert.match(resMismatch.error, /no coincide/)
  assert.equal(directWrites.length, 0)
  assert.equal(rpcCalls.some(c => c.name === 'update_bsale_client_commercial_status'), false)

  // Subcaso 5b: commerciallyBlocked ausente o valor no reconocido
  const unrecognizedFetch = async () => ({ id: 101, commerciallyBlocked: 'DESCONOCIDO' })

  const resUnrecognized = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource: unrecognizedFetch,
  })

  assert.equal(resUnrecognized.data?.status, 'UNKNOWN')
  assert.match(resUnrecognized.error, /valor reconocido/)
  assert.equal(directWrites.length, 0)
  assert.equal(rpcCalls.some(c => c.name === 'update_bsale_client_commercial_status'), false)
})

test('6. Usuario sin autorización o rol Operador Bodega: rechaza antes de consultar BD o Bsale', async () => {
  let bsaleCalled = false
  const fetchBsaleResource = async () => {
    bsaleCalled = true
    return { id: 101, commerciallyBlocked: false }
  }

  // Subcaso 6a: Error de autorización
  const unauthRes = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => {
      throw new Error('No autorizado para esta operación')
    },
    fetchBsaleResource,
  })
  assert.equal(unauthRes.data, null)
  assert.match(unauthRes.error, /No autorizado/)
  assert.equal(bsaleCalled, false)

  // Subcaso 6b: Rol Operador Bodega (no autorizado para información comercial)
  const bodegaRes = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: true, user: { id: 'u2' } }),
    fetchBsaleResource,
  })
  assert.equal(bodegaRes.data, null)
  assert.match(bodegaRes.error, /información comercial/)
  assert.equal(bsaleCalled, false)

  // Subcaso 6c: Tarjeta de otra empresa o inexistente
  const { userDb, adminDb, rpcCalls } = createMockDb({ card: null })
  const otherCompanyRes = await executeVerifyCardClientCommercial('card-other', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource,
  })
  assert.equal(otherCompanyRes.data, null)
  assert.match(otherCompanyRes.error, /Tarjeta no encontrada/)
  assert.equal(bsaleCalled, false)
  assert.equal(rpcCalls.length, 0)
})

test('7. Error en ejecución de la RPC update_bsale_client_commercial_status: no asume desbloqueado', async () => {
  const { userDb, adminDb } = createMockDb({
    existingClient: {
      id: 'row-1',
      raw_payload: { id: 101, commerciallyBlocked: true },
    },
    rpcError: { message: 'Database lock wait timeout in RPC' },
  })

  const fetchBsaleResource = async () => ({ id: 101, commerciallyBlocked: false })

  const result = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource,
  })

  assert.equal(result.data, null, 'NO debe informar resultado exitoso si falló la RPC atómica')
  assert.match(result.error, /Error al persistir actualización atómica/)
  assert.match(result.error, /Database lock wait timeout/)
})

test('8. Una verificación consulta un solo cliente y llamadas concurrentes se deduplican en vuelo', async () => {
  const { userDb, adminDb, rpcCalls } = createMockDb()
  let bsaleCalls = 0
  const requestedPaths = []

  const slowFetchBsaleResource = async options => {
    bsaleCalls++
    requestedPaths.push(options.path)
    await new Promise(resolve => setTimeout(resolve, 30))
    return { id: 101, commerciallyBlocked: false }
  }

  // Disparar dos llamadas simultáneas para la misma tarjeta y cliente
  const [res1, res2] = await Promise.all([
    executeVerifyCardClientCommercial('card-1', {
      authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
      getUserDb: async () => userDb,
      getAdminDb: () => adminDb,
      fetchBsaleResource: slowFetchBsaleResource,
    }),
    executeVerifyCardClientCommercial('card-1', {
      authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
      getUserDb: async () => userDb,
      getAdminDb: () => adminDb,
      fetchBsaleResource: slowFetchBsaleResource,
    }),
  ])

  // Ambas llamadas devuelven el resultado esperado
  assert.equal(res1.data?.status, 'UNBLOCKED')
  assert.equal(res2.data?.status, 'UNBLOCKED')

  // Solo se realizó 1 consulta a Bsale para ese cliente específico
  assert.equal(bsaleCalls, 1, 'In-flight coalescing evitó peticiones concurrentes duplicadas')
  assert.deepEqual(requestedPaths, ['/clients/101.json'])

  // Se ejecutó get_server_timestamp una sola vez y update_bsale_client_commercial_status una sola vez
  const tsCalls = rpcCalls.filter(c => c.name === 'get_server_timestamp')
  const updateCalls = rpcCalls.filter(c => c.name === 'update_bsale_client_commercial_status')
  assert.equal(tsCalls.length, 1)
  assert.equal(updateCalls.length, 1)
})

test('9. Respuesta tardía descartada (applied = false): retorna estado prevalente de BD y advierte descarte', async () => {
  const { userDb, adminDb } = createMockDb({
    existingClient: {
      id: 'row-1',
      raw_payload: { id: 101, commerciallyBlocked: true },
      last_sync_at: '2026-11-13T12:05:00.000Z',
    },
    // La RPC detecta que existe una marca posterior y retorna applied = false conservando el estado prevalente (BLOCKED)
    rpcData: {
      id: 'row-1',
      company_id: 'company-1',
      bsale_client_id: 101,
      commercially_blocked: true,
      commercial_observed_at: '2026-11-13T12:05:00.000Z',
      applied: false,
    },
  })

  // Bsale respondió desbloqueado tarde
  const fetchBsaleResource = async () => ({ id: 101, commerciallyBlocked: false })

  const result = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource,
  })

  // Debe retornar applied = false y estado prevalente BLOCKED de la BD
  assert.equal(result.data?.applied, false)
  assert.equal(result.data?.status, 'BLOCKED')
  assert.equal(result.data?.commerciallyBlocked, true)
  assert.equal(result.data?.verifiedAt, '2026-11-13T12:05:00.000Z')
  assert.match(result.error, /Observación comercial descartada: existe una actualización más reciente/)
})

test('10. Error al obtener timestamp de PostgreSQL (get_server_timestamp): aborta antes de consultar Bsale', async () => {
  let bsaleCalled = false
  const fetchBsaleResource = async () => {
    bsaleCalled = true
    return { id: 101, commerciallyBlocked: false }
  }

  const { userDb, adminDb, rpcCalls } = createMockDb({
    serverTimestampError: { message: 'Connection to database terminated abruptly' },
  })

  const result = await executeVerifyCardClientCommercial('card-1', {
    authorize: async () => ({ companyId: 'company-1', isOperatorBodega: false, user: { id: 'u1' } }),
    getUserDb: async () => userDb,
    getAdminDb: () => adminDb,
    fetchBsaleResource,
  })

  assert.equal(result.data, null)
  assert.match(result.error, /Error al obtener marca temporal del servidor/)
  assert.match(result.error, /Connection to database terminated abruptly/)
  assert.equal(bsaleCalled, false, 'NO debe consultar Bsale si falló la marca temporal del servidor')
  assert.equal(rpcCalls.some(c => c.name === 'update_bsale_client_commercial_status'), false)
})
