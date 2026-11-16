import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const MYM = 'd1000000-0000-0000-0000-000000000001'

async function loadEdge(features) {
  const source = await readFile(new URL('../../../supabase/functions/rutas-heigit-resolve/index.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const nativeRequire = createRequire(import.meta.url)
  const requests = []
  const fakeFetch = async url => {
    requests.push(new URL(url))
    return new Response(JSON.stringify({ features }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const modules = { 'npm:@supabase/server@1': { withSupabase: (_settings, handler) => handler } }
  const exports = {}
  new Function('require', 'exports', 'Deno', 'fetch', compiled)(name => Object.hasOwn(modules, name) ? modules[name] : nativeRequire(name), exports, { env: { get: () => 'fixture' } }, fakeFetch)
  return { edge: exports.default, requests }
}

function feature({ street, number = null, layer = 'street', accuracy = 'centroid', matchType = 'exact', longitude = -72.1, confidence = 1, locality = 'Chillán' }) {
  return { geometry: { coordinates: [longitude, -36.6] }, properties: { country_a: 'CL', locality, street, housenumber: number, layer, accuracy, match_type: matchType, confidence } }
}

async function consult(edge, address, commune = 'chillán') {
  const request = new Request('https://fixture.invalid', { method: 'POST', body: JSON.stringify({ company_id: MYM, destinations: [{ country_code: 'CL', commune_key: commune, address_key: address }] }) })
  const response = await edge.fetch(request)
  assert.equal(response.status, 200)
  return (await response.json()).results[0]
}

test('NV 5387 conserva numeral y comuna en la consulta y compara coincidencia exacta', async () => {
  const { edge, requests } = await loadEdge([feature({ street: 'Balmaceda', number: '541', layer: 'address', accuracy: 'point', locality: 'San Carlos' })])
  const result = await consult(edge, 'balmaceda #541', 'san carlos')
  assert.equal(requests[0].searchParams.get('text'), 'balmaceda #541, san carlos, Chile')
  assert.equal(result.classification, 'EXACT')
})

test('la consulta incluye comuna y país una sola vez sin alterar la clave original', async () => {
  for (const address of ['av ficticia 1440, chillán', 'av ficticia 1440, chillán, chile', 'av ficticia 1440']) {
    const { edge, requests } = await loadEdge([])
    const result = await consult(edge, address)
    assert.equal(requests[0].searchParams.get('text'), 'av ficticia 1440, chillán, Chile')
    assert.equal(result.address_key, address)
    assert.equal(result.commune_key, 'chillán')
    assert.equal(result.classification, 'NOT_FOUND')
  }
})

test('segmentos de calle y números diferentes permanecen ambiguos aunque confidence sea alto', async () => {
  const features = [
    feature({ street: 'Avenida Ficticia' }),
    feature({ street: 'Avenida Otra' }),
    ...['1695', '20', '32'].map((number, index) => feature({ street: 'Avenida Ficticia', number, layer: 'address', accuracy: 'point', matchType: 'fallback', confidence: 0.8, longitude: -72.11 - index / 100 }))
  ]
  const { edge } = await loadEdge(features)
  const result = await consult(edge, 'av ficticia 1440, chillán')
  assert.equal(result.classification, 'AMBIGUOUS')
  assert.equal(result.candidates.length, 5)
  assert.ok(result.candidates.every(candidate => !candidate.exact_geographic_match))
  assert.equal(result.coordinates, null)
})

test('un candidato exacto exige calle, número y comuna; dos puntos exactos son ambiguos', async () => {
  const one = feature({ street: 'Avenida Ficticia', number: '1440', layer: 'address', accuracy: 'point' })
  const single = await loadEdge([one])
  assert.equal((await consult(single.edge, 'av ficticia 1440, chillán')).classification, 'EXACT')
  const multiple = await loadEdge([one, feature({ street: 'Avenida Ficticia', number: '1440', layer: 'address', accuracy: 'point', longitude: -72.2 })])
  const ambiguous = await consult(multiple.edge, 'av ficticia 1440, chillán')
  assert.equal(ambiguous.classification, 'AMBIGUOUS')
  assert.equal(ambiguous.coordinates, null)
})
