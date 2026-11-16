import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const identity = { user: { id: 'user' }, companyId: 'company', effectiveRole: 'ADMIN', isOperatorBodega: false }

async function loadAction({ initial = identity, final = initial, result = [], reject = false } = {}) {
  const source = await readFile(new URL('./location-lookup-action.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const calls = []
  let authCount = 0
  const modules = {
    '@/app/actions/logistica/authorization': { requireWmsPermission: async () => ++authCount === 1 ? initial : final },
    './geocode-cache.server': { resolvePreparationGeocoding: async (ids, options) => { calls.push({ ids, options }); if (reject) throw new Error('dato privado'); return result } },
  }
  const nativeRequire = createRequire(import.meta.url)
  const exports = {}
  new Function('require', 'exports', compiled)(name => Object.hasOwn(modules, name) ? modules[name] : nativeRequire(name), exports)
  return { action: exports.resolveLocationAction, calls, source }
}

function result(overrides = {}) {
  return { stopId: 'stop-existing', cardIds: ['card-existing'], status: 'CACHE_MISS', geocodingStatus: null, location: null, unverifiedCandidate: null, providerResult: null, ...overrides }
}

test('acción autenticada limita a una parada y devuelve candidatos sin campos sensibles', async () => {
  const item = result({ providerResult: { classification: 'APPROXIMATE', status: 'APPROXIMATE', location: null, candidates: [{ coordinates: [-71.6, -35.4], communeMatches: true }], error: null, secret: 'no-exponer', matchedAddress: 'no-exponer' } })
  const { action, calls } = await loadAction({ result: [item] })
  const output = await action(['card-existing'])
  assert.deepEqual(calls, [{ ids: ['card-existing'], options: { maxStops: 1 } }])
  assert.equal(output.ok, true)
  assert.equal(output.results[0].status, 'APPROXIMATE')
  assert.equal(output.results[0].providerClassification, 'APPROXIMATE')
  assert.equal(output.results[0].recognizedLocation, null)
  assert.deepEqual(output.results[0].candidates, [{ coordinates: [-71.6, -35.4], communeMatches: true }])
  assert.equal(JSON.stringify(output).includes('no-exponer'), false)
})

test('solo EXACT reconocido expone ubicación para mapa; caché permanece candidata', async () => {
  const location = { coordinates: [-71.6, -35.4], verification: 'COORDINATE_VERIFIED', source: 'fixture', classification: 'RECOGNIZED', physicalAccessVerified: false }
  const exact = result({ providerResult: { classification: 'EXACT', status: 'RECOGNIZED', location, candidates: [], error: null } })
  const untrusted = result({ providerResult: { classification: 'APPROXIMATE', status: 'APPROXIMATE', location, candidates: [], error: null } })
  const cached = result({ status: 'CACHE_RESOLVED', geocodingStatus: 'REVIEW_REQUIRED', unverifiedCandidate: { coordinates: [-71.5, -35.3], usable: false, physicalAccessVerified: false } })
  const { action } = await loadAction({ result: [exact, untrusted, cached] })
  const output = await action(['card-existing'])
  assert.deepEqual(output.results[0].recognizedLocation, location)
  assert.equal(output.results[1].recognizedLocation, null)
  assert.equal(output.results[2].recognizedLocation, null)
  assert.deepEqual(output.results[2].candidates, [{ coordinates: [-71.5, -35.3], communeMatches: null }])
})

test('errores o cambios de identidad y empresa no devuelven resultados', async () => {
  for (const options of [{ reject: true }, { final: { ...identity, companyId: 'other' } }, { final: { ...identity, user: { id: 'other' } } }]) {
    const { action } = await loadAction({ ...options, result: [result()] })
    const output = await action(['card-existing'])
    assert.equal(output.ok, false)
    assert.equal('results' in output, false)
    assert.equal(JSON.stringify(output).includes('dato privado'), false)
  }
})

test('el fallo de caché expone solo categoría y código de la Edge, sin datos privados', async () => {
  const item = result({ status: 'CACHE_UNAVAILABLE', geocodingStatus: 'ERROR', cacheFailure: { category: 'EDGE_ERROR', edgeCode: 'CACHE_LOOKUP_FAILED', httpStatus: 502, privateDetail: 'no-exponer' } })
  const { action } = await loadAction({ result: [item] })
  const output = await action(['card-existing'])
  assert.equal(output.ok, true)
  assert.equal(output.results[0].error, 'EDGE_ERROR · CACHE_LOOKUP_FAILED · HTTP 502')
  assert.equal(JSON.stringify(output).includes('no-exponer'), false)
})
