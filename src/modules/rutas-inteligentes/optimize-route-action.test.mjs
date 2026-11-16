import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const company = 'd1000000-0000-0000-0000-000000000001'
const identity = { user: { id: 'user' }, companyId: company, effectiveRole: 'ADMIN', isOperatorBodega: false }
const location = { coordinates: [-71.6, -35.4], verification: 'COORDINATE_VERIFIED', source: 'fixture' }
const exact = { classification: 'EXACT', status: 'RECOGNIZED', location }
const item = (stopId, cardIds, providerResult = null, status = 'CACHE_MISS') => ({ stopId, cardIds, providerResult, status })

async function load({ results, reply, auth = () => identity }) {
  const source = await readFile(new URL('./optimize-route-action.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const calls = []
  let authCalls = 0
  const modules = {
    '@/app/actions/logistica/authorization': { requireWmsPermission: async () => auth(++authCalls) },
    './authorize-geocoding.server': { MYM_PREPARATION_COMPANY_ID: company },
    './geocode-cache.server': { resolvePreparationGeocoding: async (ids, options) => { calls.push({ ids, options }); return results } },
    './route-scenario': { getVerifiedStopLocation: value => value?.verification === 'COORDINATE_VERIFIED' ? value.coordinates : null },
  }
  const nativeRequire = createRequire(import.meta.url)
  const exports = {}
  const mockFetch = async (url, options) => {
    const request = JSON.parse(options.body)
    calls.push({ url, options, request })
    return { ok: true, json: async () => reply(request) }
  }
  const env = { env: { SUPABASE_SECRET_KEY: 'sb_secret_test' } }
  new Function('require', 'exports', 'fetch', 'process', compiled)(name => Object.hasOwn(modules, name) ? modules[name] : nativeRequire(name), exports, mockFetch, env)
  return { action: exports.optimizePreparationRouteAction, calls }
}

test('traduce IDs opacos, respeta orden original y conserva la geometría y el orden optimizado', async () => {
  const { action, calls } = await load({
    results: [item('stop:direccion-privada', ['card-b'], exact), item('stop:otra-direccion', ['card-a'], exact)],
    reply: request => ({ ok: true, company_id: company, included_stop_count: 2, routed_stop_count: 2, pending_stop_ids: [], unassigned_stop_ids: [], complete: true, route: { encoded_geometry: 'abcd', geometry_encoding: 'polyline', distance_meters: 123, travel_seconds: 45, ordered_stops: [...request.stops].reverse().map((stop, index) => ({ ...stop, sequence: index + 1 })) } }),
  })
  const result = await action(['card-a', 'card-b'])
  assert.equal(result.ok, true)
  assert.deepEqual(result.stops.map(stop => stop.cardIds), [['card-a'], ['card-b']])
  assert.deepEqual(result.route.orderedStops.map(stop => stop.cardIds), [['card-b'], ['card-a']])
  assert.equal(result.route.encodedGeometry, 'abcd')
  assert.equal(result.route.distanceMeters, 123)
  assert.equal(result.route.travelSeconds, 45)
  const wire = calls[1].request
  assert.equal(wire.included_stop_ids.length, 2)
  assert.equal(new Set(wire.included_stop_ids).size, 2)
  assert.doesNotMatch(JSON.stringify(wire), /card-|direccion/)
  assert.deepEqual(calls[0].options, { maxStops: 45 })
})

test('caché y candidatos provisionales quedan pendientes; distingue no asignadas', async () => {
  const { action, calls } = await load({
    results: [item('stop:a', ['a'], exact), item('stop:b', ['b'], { classification: 'APPROXIMATE', status: 'APPROXIMATE', location }), item(null, ['c'], null, 'REVIEW_REQUIRED'), item('stop:d', ['d'], null, 'CACHE_RESOLVED')],
    reply: request => ({ ok: true, company_id: company, included_stop_count: 4, routed_stop_count: 0, pending_stop_ids: request.included_stop_ids.slice(1), unassigned_stop_ids: [request.included_stop_ids[0]], complete: false, route: null }),
  })
  const result = await action(['a', 'b', 'c', 'd'])
  assert.equal(result.ok, true)
  assert.equal(result.complete, false)
  assert.deepEqual(result.pending.map(stop => stop.cardIds[0]), ['b', 'c', 'd'])
  assert.deepEqual(result.unassigned.map(stop => stop.cardIds[0]), ['a'])
  assert.equal(calls[1].request.stops.length, 1)
})

test('rechaza respuestas inconsistentes y cambios de autorización', async () => {
  const malformed = await load({ results: [item('stop:a', ['a'], exact)], reply: () => ({ ok: true, company_id: company, included_stop_count: 1, routed_stop_count: 0, pending_stop_ids: [], unassigned_stop_ids: [], complete: true, route: null }) })
  assert.equal((await malformed.action(['a'])).ok, false)
  const revoked = await load({ results: [item('stop:a', ['a'], exact)], auth: count => count === 1 ? identity : { ...identity, user: { id: 'other' } }, reply: () => { throw new Error('must not call') } })
  assert.equal((await revoked.action(['a'])).code, 'UNAUTHORIZED')
  assert.equal(revoked.calls.length, 1)
})

test('sin sesión, sin permiso o con empresa ajena no se consulta ni se entrega diagnóstico', async () => {
  for (const auth of [
    () => { throw new Error('Sin sesión') },
    () => { throw new Error('Sin permiso') },
    () => ({ ...identity, companyId: 'otra-empresa' }),
  ]) {
    const { action, calls } = await load({ results: [item('stop:a', ['a'], exact)], auth, reply: () => { throw new Error('No debe consultar VROOM') } })
    const result = await action(['a'])
    assert.equal(result.ok, false)
    assert.equal('stops' in result, false)
    assert.equal('diagnostic' in result, false)
    assert.equal(calls.length, 0)
  }
})

test('diagnostica resultados exactos rechazados, caché y paradas compartidas sin consultas adicionales', async () => {
  const rejected = { classification: 'EXACT', status: 'REVIEW_REQUIRED', location: null, diagnosticReason: 'EXACT rechazado: calle o número no coinciden en la validación local.' }
  const { action, calls } = await load({
    results: [item('stop:a', ['a', 'b'], rejected), item('stop:c', ['c'], null, 'CACHE_RESOLVED'), item('stop:d', ['d'], exact)],
    reply: request => ({ ok: true, company_id: company, included_stop_count: 3, routed_stop_count: 0, pending_stop_ids: request.included_stop_ids.slice(0, 2), unassigned_stop_ids: [request.included_stop_ids[2]], complete: false, route: null }),
  })
  const result = await action(['a', 'b', 'c', 'd'])
  assert.equal(result.ok, true)
  assert.deepEqual(result.stops[0].cardIds, ['a', 'b'])
  assert.equal(result.stops[0].diagnostic.heigit, 'RESPONDED')
  assert.equal(result.stops[0].diagnostic.classification, 'EXACT')
  assert.equal(result.stops[0].diagnostic.accepted, false)
  assert.match(result.stops[0].diagnostic.reason, /calle o número/)
  assert.equal(result.stops[1].diagnostic.heigit, 'NOT_QUERIED')
  assert.equal(result.stops[1].diagnostic.sentToVroom, false)
  assert.equal(result.stops[2].diagnostic.sentToVroom, true)
  assert.equal(calls.length, 2)
})
