import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return nextResolve(`${specifier}.ts`, context)
  }
} })
const vroom = await import('./vroom-adapter.ts')
const preparation = await import('./preparation-adapter.ts')
const grouping = await import('./delivery-stops.ts')
const geographicContract = await import('./geocoding-contract.ts')
const MYM = 'd1000000-0000-0000-0000-000000000001'
const SECRET = 'sb_secret_fixture_no_real'
const URL_FIXTURE = 'https://oekmztbfasmildyuajji.supabase.co'

function ready(id, address = `calle ficticia ${id}`, commune = 'talca', companyId = MYM) {
  return { cardIds: [`card-${id}`], geographic: { stopId: `stop-${id}`, status: 'READY', countrySource: 'MYM_DOMESTIC_POLICY', cacheKey: { companyId, countryCode: 'CL', communeKey: commune, addressKey: address }, streetKey: 'calle ficticia', numberKey: String(id), originals: [], reason: null } }
}
function review(id) {
  return { cardIds: [`card-${id}`], geographic: { stopId: `stop-${id}`, status: 'REVIEW_REQUIRED', countrySource: 'MYM_DOMESTIC_POLICY', cacheKey: null, streetKey: null, numberKey: null, originals: [], reason: 'ADDRESS_NOT_SPECIFIC' } }
}
function authorization(stops, overrides = {}) {
  return { companyId: MYM, userId: 'usuario', stops, unresolved: [], ...overrides }
}
function row(destination, overrides = {}) {
  return { ...destination, status: 'RESOLVED', coordinates: [-71.6, -35.4], accuracy_label: 'address', provider: 'fixture', provider_place_id: null, matched_address: 'dato privado de fixture', fetched_at: '2020-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', ...overrides }
}
function ok(companyId, cached = []) {
  return new Response(JSON.stringify({ ok: true, code: 'CACHE_LOOKUP_COMPLETE', company_id: companyId, matched: cached.length, cached, writes: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
}
function resolverAnswer(destination, classification = 'EXACT', overrides = {}) {
  const number = destination.address_key.match(/\d+$/)?.[0] ?? '1'
  const coordinates = [-71.6, -35.4]
  return {
    ...destination, classification, coordinates: classification === 'EXACT' ? coordinates : null, physical_access_verified: false,
    candidates: classification === 'EXACT' ? [{ coordinates, locality: 'Talca', street: 'Calle Ficticia', housenumber: number, layer: 'address', match_type: 'exact', accuracy: 'point', country_matches: true, commune_matches: true, street_number_matches: true, exact_geographic_match: true }] : [],
    ...overrides,
  }
}
function resolverOk(results, overrides = {}) {
  return new Response(JSON.stringify({ ok: true, code: 'GEOCODE_BATCH_COMPLETE', company_id: MYM, provider: 'HEIGIT_PELIAS', results, requests_to_provider: results.length, writes: 0, ...overrides }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function loadCache({ authorized = authorization([ready(1)]), authorizeError, authorizeImpl, fetchImpl, env = { NEXT_PUBLIC_SUPABASE_URL: URL_FIXTURE, SUPABASE_SECRET_KEY: SECRET }, timer, onAuthorize } = {}) {
  const source = await readFile(new URL('./geocode-cache.server.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const calls = []
  const modules = {
    'server-only': {},
    './authorize-geocoding.server': {
      MYM_PREPARATION_COMPANY_ID: MYM,
      authorizePreparationGeocoding: async ids => {
        onAuthorize?.(ids)
        if (authorizeError) throw new Error('No se pudo autorizar la solicitud de geocodificación.')
        return authorizeImpl ? authorizeImpl(ids) : authorized
      },
    },
    './vroom-adapter': vroom,
    './geocoding-contract': geographicContract,
  }
  const nativeRequire = createRequire(import.meta.url)
  const localRequire = name => Object.hasOwn(modules, name) ? modules[name] : nativeRequire(name)
  const fakeFetch = async (url, options) => {
    calls.push({ url, options })
    return fetchImpl ? fetchImpl(url, options) : ok(MYM)
  }
  const exports = {}
  new Function('require', 'exports', 'process', 'fetch', 'setTimeout', 'clearTimeout', compiled)(localRequire, exports, { env }, fakeFetch, timer?.setTimeout ?? setTimeout, timer?.clearTimeout ?? clearTimeout)
  return { lookup: exports.lookupPreparationGeocodeCache, resolve: exports.resolvePreparationGeocoding, calls, source }
}

async function createRealAuthorization(cards) {
  const source = await readFile(new URL('./authorize-geocoding.server.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const identity = { user: { id: 'usuario-fixture' }, companyId: MYM, companyName: 'MYM', effectiveRole: 'ADMIN', isOperatorBodega: false }
  const modules = {
    'server-only': {},
    '@/app/actions/logistica/authorization': { requireWmsPermission: async () => identity, requirePreparationCardAccess: async () => {} },
    '@/app/actions/logistica/sales-order-preparation': { getSalesOrderPreparationBoard: async () => ({ data: cards, error: null, isOperatorBodega: false }) },
    './preparation-adapter': preparation,
    './delivery-stops': grouping,
    './geocoding-contract': geographicContract,
  }
  const nativeRequire = createRequire(import.meta.url)
  const exports = {}
  new Function('require', 'exports', compiled)(name => Object.hasOwn(modules, name) ? modules[name] : nativeRequire(name), exports)
  return exports.authorizePreparationGeocoding
}

async function loadLocalCacheEdge() {
  const source = await readFile(new URL('../../../supabase/functions/rutas-geocode-cache-lookup/index.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText
  const calls = []
  const fakePostgres = () => ({
    json: value => ({ jsonParameter: true, value }),
    unsafe: async (_query, parameters) => {
      const input = parameters[1]?.jsonParameter ? parameters[1].value : parameters[1]
      // postgres.js serializa JSONB con JSON.stringify: una cadena pre-serializada
      // llega a PostgreSQL como string, mientras sql.json(arreglo) llega como array.
      const decoded = JSON.parse(JSON.stringify(input))
      if (!Array.isArray(decoded)) throw new Error('22023')
      calls.push(decoded.length)
      return []
    },
    end: async () => {},
  })
  const modules = {
    'npm:@supabase/server@1': { withSupabase: (_options, handler) => handler },
    'npm:postgres@3.4.5': { __esModule: true, default: fakePostgres },
  }
  const nativeRequire = createRequire(import.meta.url)
  const exports = {}
  new Function('require', 'exports', 'Deno', compiled)(name => Object.hasOwn(modules, name) ? modules[name] : nativeRequire(name), exports, { env: { get: () => 'fixture' } })
  return { edge: exports.default, calls }
}

test('resultado vigente conserva evidencia sin promover coordenadas al mapa ni exponer credenciales', async () => {
  const { lookup, calls, source } = await loadCache({ fetchImpl: (_url, options) => ok(MYM, [row(JSON.parse(options.body).destinations[0])]) })
  const result = await lookup(['card-1'])
  assert.equal(result[0].status, 'CACHE_RESOLVED')
  assert.equal(result[0].geocodingStatus, 'REVIEW_REQUIRED')
  assert.equal(result[0].location, null)
  assert.deepEqual(result[0].unverifiedCandidate.coordinates, [-71.6, -35.4])
  assert.equal(result[0].unverifiedCandidate.usable, false)
  assert.equal(result[0].unverifiedCandidate.physicalAccessVerified, false)
  assert.equal(calls[0].options.headers.apikey, SECRET)
  assert.equal(calls[0].options.headers.authorization, undefined)
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.equal(JSON.stringify(result).includes('dato privado de fixture'), false)
  assert.match(source, /^import 'server-only'/)
  assert.doesNotMatch(source, /console\.|['"]use server['"]/)
})

test('consulta parte de la frontera real de Preparación y no incluye otras tarjetas', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const extra = '22222222-2222-4222-8222-222222222222'
  const card = (cardId, nvId, address) => ({ card_id: cardId, company_id: MYM, nv_bsale_id: nvId, nv_folio: String(nvId), client_name: 'Cliente ficticio', client_id: 1, address_raw: address, normalized_city: 'Talca', municipality_raw: 'Talca', city_raw: null, seller_name: 'Ana', total_quantity: 1, gross_amount: 119, total_amount: 119, net_amount: 100, tax_amount: 19, invoice_folio: null, status: 'PENDING_ROUTE_PREP' })
  const authorizeImpl = await createRealAuthorization([card(id, 1, 'Calle Ficticia 123'), card(extra, 2, 'Otra Calle 456')])
  const { lookup, calls } = await loadCache({ authorizeImpl })
  const results = await lookup([id])
  const request = JSON.parse(calls[0].options.body)
  assert.equal(request.company_id, MYM)
  assert.deepEqual(request.destinations, [{ country_code: 'CL', commune_key: 'talca', address_key: 'calle ficticia 123' }])
  assert.deepEqual(results[0].cardIds, [id])
  assert.equal(results[0].status, 'CACHE_MISS')
  await assert.rejects(lookup(['33333333-3333-4333-8333-333333333333']), /No se pudo autorizar/)
  assert.equal(calls.length, 1)
})

test('más de 100 tarjetas pasan por la autorización real y se reparten en lotes de caché', async () => {
  const ids = Array.from({ length: 105 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
  const cards = ids.map((cardId, index) => ({ card_id: cardId, company_id: MYM, nv_bsale_id: index + 1, nv_folio: String(index + 1), client_name: 'Cliente ficticio', client_id: index + 1, address_raw: `Calle Ficticia ${index + 1}`, normalized_city: 'Talca', municipality_raw: 'Talca', city_raw: null, seller_name: 'Ana', total_quantity: 1, gross_amount: 119, total_amount: 119, net_amount: 100, tax_amount: 19, invoice_folio: null, status: 'PENDING_ROUTE_PREP' }))
  const authorizeImpl = await createRealAuthorization(cards)
  const authorized = await authorizeImpl(ids)
  const { lookup, calls } = await loadCache({ authorizeImpl })
  const results = await lookup(ids)
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body).destinations.length), [100, 5])
  assert.deepEqual(results.map(result => result.stopId), authorized.stops.map(stop => stop.geographic.stopId))
  assert.deepEqual(new Set(results.flatMap(result => result.cardIds)), new Set(ids))
  assert.equal(results.length, 105)
  assert.ok(results.every(result => result.status === 'CACHE_MISS'))
})

test('caché vacía y ausencia de una clave se distinguen de NOT_FOUND del proveedor', async () => {
  const authorized = authorization([ready(1), ready(2)])
  const { lookup } = await loadCache({ authorized, fetchImpl: (_url, options) => {
    const destinations = JSON.parse(options.body).destinations
    return ok(MYM, [row(destinations[1], { status: 'NOT_FOUND', coordinates: null })])
  } })
  const result = await lookup(['one', 'two'])
  assert.deepEqual(result.map(item => item.status), ['CACHE_MISS', 'CACHE_NOT_FOUND'])
  assert.deepEqual(result.map(item => item.geocodingStatus), [null, 'NOT_FOUND'])
  assert.ok(result.every(item => item.location === null))
})

test('la Edge local envía un arreglo JSONB y una caché vacía continúa hacia el resolver', async () => {
  const { edge, calls: databaseCalls } = await loadLocalCacheEdge()
  const { resolve, calls } = await loadCache({ fetchImpl: (url, options) => {
    if (url.endsWith('/rutas-geocode-cache-lookup')) return edge.fetch(new Request(url, options))
    const destinations = JSON.parse(options.body).destinations
    return resolverOk(destinations.map(destination => resolverAnswer(destination, 'NOT_FOUND')))
  } })
  const [result] = await resolve(['fixture'])
  assert.deepEqual(databaseCalls, [1])
  assert.equal(result.status, 'CACHE_MISS')
  assert.equal(result.providerResult.classification, 'NOT_FOUND')
  assert.equal(calls.filter(call => call.url.endsWith('/rutas-heigit-resolve')).length, 1)
})

test('deduplica claves y asocia resultados fuera de orden a cada parada', async () => {
  const authorized = authorization([ready(1, 'calle ficticia 1'), ready(2, 'calle ficticia 2'), ready(3, 'calle ficticia 1')])
  const { lookup, calls } = await loadCache({ authorized, fetchImpl: (_url, options) => {
    const destinations = JSON.parse(options.body).destinations
    return ok(MYM, [row(destinations[1], { status: 'AMBIGUOUS', coordinates: null }), row(destinations[0])])
  } })
  const result = await lookup(['1', '2', '3'])
  assert.equal(JSON.parse(calls[0].options.body).destinations.length, 2)
  assert.deepEqual(result.map(item => item.stopId), ['stop-1', 'stop-2', 'stop-3'])
  assert.deepEqual(result.map(item => item.status), ['CACHE_RESOLVED', 'CACHE_AMBIGUOUS', 'CACHE_RESOLVED'])
  assert.equal(result[1].geocodingStatus, 'AMBIGUOUS')
  assert.equal(result[1].location, null)
})

test('vencidos se ignoran y REVIEW_REQUIRED nunca se envía a la caché', async () => {
  const authorized = authorization([ready(1), review(2)], { unresolved: [{ cardId: 'card-3', issues: ['MISSING_ADDRESS'] }] })
  const { lookup, calls } = await loadCache({ authorized, fetchImpl: (_url, options) => ok(MYM, [row(JSON.parse(options.body).destinations[0], { fetched_at: '2000-01-01T00:00:00.000Z', expires_at: '2001-01-01T00:00:00.000Z' })]) })
  const result = await lookup(['1', '2', '3'])
  assert.deepEqual(result.map(item => item.status), ['CACHE_MISS', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED'])
  assert.equal(result[1].reviewReason, 'ADDRESS_NOT_SPECIFIC')
  assert.deepEqual(result[2].issues, ['MISSING_ADDRESS'])
  assert.equal(JSON.parse(calls[0].options.body).destinations.length, 1)
})

test('ninguna clave se consulta si todas las paradas requieren revisión', async () => {
  const { lookup, calls } = await loadCache({ authorized: authorization([review(1)]) })
  assert.equal((await lookup(['1']))[0].status, 'REVIEW_REQUIRED')
  assert.equal(calls.length, 0)
})

test('bloquea empresa ajena, clave cruzada y autorización rechazada antes del transporte', async () => {
  for (const authorized of [authorization([ready(1, undefined, undefined, 'otra')]), authorization([ready(1, undefined, undefined, 'otra')], { companyId: 'otra' })]) {
    const { lookup, calls } = await loadCache({ authorized })
    await assert.rejects(lookup(['1']), /No se pudo autorizar/)
    assert.equal(calls.length, 0)
  }
  const { lookup, calls } = await loadCache({ authorizeError: true })
  await assert.rejects(lookup(['1']), /No se pudo autorizar/)
  assert.equal(calls.length, 0)
})

test('autenticación fallida, configuración ausente y servicio no disponible retornan CACHE_UNAVAILABLE', async () => {
  for (const options of [
    { fetchImpl: () => new Response('', { status: 401 }) },
    { fetchImpl: () => { throw new Error('detalle sensible') } },
    { env: { NEXT_PUBLIC_SUPABASE_URL: URL_FIXTURE } },
    { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://otro.supabase.co', SUPABASE_SECRET_KEY: SECRET } },
    { env: { NEXT_PUBLIC_SUPABASE_URL: URL_FIXTURE, SUPABASE_SECRET_KEY: 'service-role-no-valida' } },
  ]) {
    const { lookup } = await loadCache(options)
    const result = await lookup(['1'])
    assert.equal(result[0].status, 'CACHE_UNAVAILABLE')
    assert.equal(result[0].geocodingStatus, 'ERROR')
    assert.equal(JSON.stringify(result).includes('detalle sensible'), false)
  }
})

test('timeout retorna un estado controlado incluso si el transporte ignora abort', async () => {
  const timer = { setTimeout: callback => { queueMicrotask(callback); return 1 }, clearTimeout: () => {} }
  const { lookup } = await loadCache({ timer, fetchImpl: () => new Promise(() => {}) })
  assert.equal((await lookup(['1']))[0].status, 'CACHE_UNAVAILABLE')
})

test('distingue configuración, credenciales, timeout, transporte y fallo explícito de la Edge', async () => {
  const timer = { setTimeout: callback => { queueMicrotask(callback); return 1 }, clearTimeout: () => {} }
  const fixtures = [
    [{ env: { NEXT_PUBLIC_SUPABASE_URL: URL_FIXTURE } }, { category: 'CONFIGURATION' }],
    [{ fetchImpl: () => new Response('{}', { status: 401 }) }, { category: 'AUTHENTICATION', httpStatus: 401 }],
    [{ timer, fetchImpl: () => new Promise(() => {}) }, { category: 'TIMEOUT' }],
    [{ fetchImpl: () => { throw new Error('información no pública') } }, { category: 'TRANSPORT' }],
    [{ fetchImpl: () => new Response(JSON.stringify({ code: 'CACHE_LOOKUP_FAILED' }), { status: 502 }) }, { category: 'EDGE_ERROR', httpStatus: 502, edgeCode: 'CACHE_LOOKUP_FAILED' }],
    [{ fetchImpl: () => new Response('no-json', { status: 200 }) }, { category: 'INVALID_RESPONSE' }],
  ]
  for (const [options, expected] of fixtures) {
    const { resolve, calls } = await loadCache(options)
    const [result] = await resolve(['fixture'])
    assert.equal(result.status, 'CACHE_UNAVAILABLE')
    assert.deepEqual(result.cacheFailure, expected)
    assert.equal(result.providerResult, null)
    assert.ok(calls.every(call => !call.url.endsWith('/rutas-heigit-resolve')))
    assert.equal(JSON.stringify(result).includes('información no pública'), false)
  }
})

test('rechaza respuestas malformadas, duplicadas, cruzadas o con coordenadas incompatibles', async () => {
  const fixtures = [
    () => new Response('no-json', { status: 200 }),
    destination => ok('otra', [row(destination)]),
    destination => ok(MYM, [row(destination, { company_id: 'otra' })]),
    destination => ok(MYM, [row(destination, { coordinates: [181, -35] })]),
    destination => ok(MYM, [row(destination, { expires_at: 'sin fecha' })]),
    destination => ok(MYM, [row(destination), row(destination)]),
    destination => ok(MYM, [row(destination, { status: 'AMBIGUOUS' })]),
    () => ok(MYM, [{ country_code: 'CL' }]),
  ]
  for (const makeResponse of fixtures) {
    const { lookup } = await loadCache({ fetchImpl: (_url, options) => makeResponse(JSON.parse(options.body).destinations[0]) })
    const result = await lookup(['1'])
    assert.equal(result[0].status, 'CACHE_UNAVAILABLE')
    assert.equal(result[0].location, null)
  }
})

test('más de 100 destinos se dividen por cantidad y bytes sin perder orden ni asociación', async () => {
  // La comprobación de bytes también cubre claves largas con caracteres multibyte.
  const stops = Array.from({ length: 205 }, (_, index) => ready(index + 1, `calle ${index} ${'ñ'.repeat(260)} 123`))
  const { lookup, calls } = await loadCache({ authorized: authorization(stops), fetchImpl: (_url, options) => {
    const destinations = JSON.parse(options.body).destinations
    return ok(MYM, destinations.map(destination => row(destination, { status: 'NOT_FOUND', coordinates: null })).reverse())
  } })
  const result = await lookup(['fixture'])
  assert.ok(calls.length >= 3)
  assert.equal(calls.reduce((total, call) => total + JSON.parse(call.options.body).destinations.length, 0), 205)
  assert.ok(calls.every(call => JSON.parse(call.options.body).destinations.length <= 100 && new TextEncoder().encode(call.options.body).length <= 40_000))
  assert.deepEqual(result.map(item => item.stopId), stops.map(stop => stop.geographic.stopId))
  assert.ok(result.every(item => item.status === 'CACHE_NOT_FOUND'))
})

test('solo CACHE_MISS se envía a resolver tras autorización y caché; conserva coincidencias vigentes', async () => {
  const authorized = authorization([ready(1), ready(2), ready(3), ready(4), review(5)])
  const { resolve, calls } = await loadCache({ authorized, fetchImpl: (url, options) => {
    const { destinations } = JSON.parse(options.body)
    if (url.endsWith('/rutas-geocode-cache-lookup')) return ok(MYM, [row(destinations[0]), row(destinations[1], { status: 'AMBIGUOUS', coordinates: null }), row(destinations[2], { status: 'NOT_FOUND', coordinates: null })])
    return resolverOk(destinations.map(destination => resolverAnswer(destination)))
  } })
  const result = await resolve(['1', '2', '3', '4', '5'])
  assert.deepEqual(result.map(item => item.status), ['CACHE_RESOLVED', 'CACHE_AMBIGUOUS', 'CACHE_NOT_FOUND', 'CACHE_MISS', 'REVIEW_REQUIRED'])
  assert.deepEqual(result.slice(0, 3).map(item => item.providerResult), [null, null, null])
  assert.equal(result[4].providerResult, null)
  assert.equal(result[3].providerResult.classification, 'EXACT')
  assert.equal(result[3].providerResult.status, 'RECOGNIZED')
  assert.deepEqual(result[3].providerResult.location.coordinates, [-71.6, -35.4])
  assert.equal(result[3].providerResult.location.physicalAccessVerified, false)
  assert.equal(calls.length, 2)
  assert.equal(JSON.parse(calls[1].options.body).destinations.length, 1)
  assert.equal(JSON.parse(calls[1].options.body).destinations[0].address_key, 'calle ficticia 4')
  assert.equal(calls[1].options.headers.apikey, SECRET)
  assert.equal(calls[1].options.redirect, 'error')
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test('clasificaciones aproximadas, ambiguas y errores del proveedor nunca producen ubicaciones utilizables', async () => {
  const cases = [
    ['APPROXIMATE', 'APPROXIMATE'], ['AMBIGUOUS', 'AMBIGUOUS'], ['NOT_FOUND', 'NOT_FOUND'],
    ['PROVIDER_RATE_LIMITED', 'ERROR'], ['PROVIDER_AUTH_FAILED', 'ERROR'], ['PROVIDER_UNAVAILABLE', 'ERROR'],
  ]
  const authorized = authorization(cases.map((_, index) => ready(index + 1)))
  const { resolve } = await loadCache({ authorized, fetchImpl: (url, options) => {
    if (url.endsWith('/rutas-geocode-cache-lookup')) return ok(MYM)
    const destinations = JSON.parse(options.body).destinations
    return resolverOk(destinations.map((destination, index) => resolverAnswer(destination, cases[index][0])))
  } })
  const result = await resolve(['fixture'])
  assert.deepEqual(result.map(item => item.providerResult.classification), cases.map(item => item[0]))
  assert.deepEqual(result.map(item => item.providerResult.status), cases.map(item => item[1]))
  assert.ok(result.every(item => item.providerResult.location === null))
})

test('candidatos aproximados o ambiguos se conservan como datos de revisión, sin marcador', async () => {
  for (const classification of ['APPROXIMATE', 'AMBIGUOUS']) {
    const { resolve } = await loadCache({ fetchImpl: (url, options) => {
      if (url.endsWith('/rutas-geocode-cache-lookup')) return ok(MYM)
      const destination = JSON.parse(options.body).destinations[0]
      return resolverOk([resolverAnswer(destination, classification, {
        candidates: [
          { coordinates: [-71.6, -35.4], country_matches: true, commune_matches: true, matched_address: 'calle provista', street: 'Calle Provista', housenumber: '100', locality: 'Talca', accuracy: 'point', confidence: 0.9 },
          { coordinates: [-71.5, -35.3], country_matches: true, commune_matches: false },
          { coordinates: [181, 0], country_matches: true, commune_matches: true },
        ],
        secret_privado: 'no exponer',
      })])
    } })
    const result = (await resolve(['fixture']))[0].providerResult
    assert.equal(result.classification, classification)
    assert.equal(result.location, null)
    assert.deepEqual(result.candidates, [
      { coordinates: [-71.6, -35.4], communeMatches: true, matchedAddress: 'calle provista', street: 'Calle Provista', housenumber: '100', locality: 'Talca', accuracy: 'point', confidence: 0.9 },
      { coordinates: [-71.5, -35.3], communeMatches: false },
    ])
    assert.equal(JSON.stringify(result).includes('no exponer'), false)
  }
})

test('el consumidor manual limita a una parada antes de acceder a caché o proveedor', async () => {
  const { resolve, calls } = await loadCache({ authorized: authorization([ready(1), ready(2)]) })
  await assert.rejects(resolve(['1', '2'], { maxStops: 1 }), /No se pudo autorizar/)
  assert.equal(calls.length, 0)
})

test('EXACT del proveedor requiere evidencia coherente y una coincidencia canónica independiente', async () => {
  const { resolve } = await loadCache({ fetchImpl: (url, options) => {
    if (url.endsWith('/rutas-geocode-cache-lookup')) return ok(MYM)
    const destination = JSON.parse(options.body).destinations[0]
    const candidate = resolverAnswer(destination).candidates[0]
    return resolverOk([resolverAnswer(destination, 'EXACT', { candidates: [{ ...candidate, street: 'Calle Distinta' }] })])
  } })
  const result = (await resolve(['fixture']))[0].providerResult
  assert.equal(result.classification, 'EXACT')
  assert.equal(result.status, 'REVIEW_REQUIRED')
  assert.equal(result.location, null)
  assert.match(result.diagnosticReason, /calle o número/)
})

test('falla de caché, autorización o revisión pendiente nunca dispara resolución externa', async () => {
  const options = [
    { authorized: authorization([ready(1)]), fetchImpl: () => new Response('', { status: 503 }) },
    { authorized: authorization([review(1)]) },
    { authorizeError: true },
  ]
  for (const option of options) {
    const { resolve, calls } = await loadCache(option)
    if (option.authorizeError) await assert.rejects(resolve(['1']), /No se pudo autorizar/)
    else {
      const result = await resolve(['1'])
      assert.equal(result[0].providerResult, null)
    }
    assert.ok(calls.every(call => !call.url.endsWith('/rutas-heigit-resolve')))
  }
})

test('resolver deduplica, divide lotes de 10 y asocia respuestas fuera de orden', async () => {
  const stops = Array.from({ length: 25 }, (_, index) => ready(index + 1))
  stops.push(ready(26, 'calle ficticia 1'))
  const { resolve, calls } = await loadCache({ authorized: authorization(stops), fetchImpl: (url, options) => {
    if (url.endsWith('/rutas-geocode-cache-lookup')) return ok(MYM)
    const destinations = JSON.parse(options.body).destinations
    return resolverOk(destinations.map(destination => resolverAnswer(destination, 'NOT_FOUND')).reverse())
  } })
  const results = await resolve(['fixture'])
  const providerCalls = calls.filter(call => call.url.endsWith('/rutas-heigit-resolve'))
  assert.deepEqual(providerCalls.map(call => JSON.parse(call.options.body).destinations.length).sort((a, b) => b - a), [10, 10, 5])
  assert.ok(providerCalls.every(call => new TextEncoder().encode(call.options.body).length <= 15_000))
  assert.deepEqual(results.map(result => result.stopId), stops.map(stop => stop.geographic.stopId))
  assert.ok(results.every(result => result.providerResult.classification === 'NOT_FOUND'))
})

test('resolver maneja fallo HTTP, timeout y respuesta cruzada sin exponer detalles ni coordenadas', async () => {
  const timer = { setTimeout: (callback, ms) => { if (ms === 50_000) queueMicrotask(callback); return 1 }, clearTimeout: () => {} }
  const variants = [
    { resolver: () => new Response('', { status: 401 }), error: 'EDGE_UNAVAILABLE' },
    { resolver: () => new Promise(() => {}), error: 'EDGE_UNAVAILABLE', timer },
    { resolver: destination => resolverOk([resolverAnswer(destination)], { company_id: 'empresa-ajena' }), error: 'INVALID_RESPONSE' },
    { resolver: destination => resolverOk([resolverAnswer({ ...destination, address_key: 'otra 123' })]), error: 'INVALID_RESPONSE' },
  ]
  for (const variant of variants) {
    const { resolve } = await loadCache({ timer: variant.timer, fetchImpl: (url, options) => {
      if (url.endsWith('/rutas-geocode-cache-lookup')) return ok(MYM)
      return variant.resolver(JSON.parse(options.body).destinations[0])
    } })
    const result = (await resolve(['fixture']))[0].providerResult
    assert.equal(result.status, 'ERROR')
    assert.equal(result.error, variant.error)
    assert.equal(result.location, null)
  }
})
