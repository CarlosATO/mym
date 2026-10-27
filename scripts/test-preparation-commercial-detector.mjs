import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearPreparationCommercialDetectorCache,
  detectPreparationCommercialChange,
  PreparationCommercialProviderError,
} from '../src/lib/logistica/preparation-commercial-detector.ts'
import { createBsalePreparationCommercialProvider } from '../src/lib/logistica/preparation-commercial-bsale-provider.ts'

const identity = (companyId = 'company-a', token = 'token-5129', physicalId = 92706) => ({
  companyId, cardId: `${companyId}-card`, status: 'IN_PREPARATION', canonicalToken: token,
  historicalBsaleId: 92706, currentBsaleId: physicalId, folio: '5129',
})

const line = (variantId, sku, quantity, lineNumber, extra = {}) => ({
  variantId, sku, productName: sku, quantity, lineNumber, unitNetValue: 1000, lineNetAmount: quantity * 1000, ...extra,
})

const version = (physicalId, lines, totalAmount = 0, token = 'token-5129') => ({
  identity: { canonicalToken: token, historicalBsaleId: 92706, currentBsaleId: physicalId, folio: '5129' },
  physicalId, lines, netAmount: totalAmount, taxAmount: 0, totalAmount,
})

function providerFor(versionOrError, delay = 0) {
  let calls = 0
  return {
    provider: {
      async getCurrentVersion() {
        calls += 1
        if (delay) await new Promise(resolve => setTimeout(resolve, delay))
        if (versionOrError instanceof Error) throw versionOrError
        return versionOrError
      },
    },
    calls: () => calls,
  }
}

const authorize = () => {}

test('NV 5129 devuelve CHANGED con dos agregados, una baja y total +16.893', async () => {
  clearPreparationCommercialDetectorCache()
  const known = version(92706, [
    line(1, 'SKU-1', 1, 1), line(2, 'SKU-2', 2, 2), line(3, 'SKU-3', 1, 3), line(4, 'SKU-4', 1, 4),
    line(5, 'SKU-5', 1, 5), line(6, 'SKU-6', 1, 6), line(7, 'SKU-7', 1, 7), line(8, 'MGMYM', 1, 8),
  ], 237162)
  const current = version(92714, [
    line(1, 'SKU-1', 1, 1), line(2, 'SKU-2', 2, 2), line(3, 'SKU-3', 1, 3), line(4, 'SKU-4', 1, 4),
    line(5, 'SKU-5', 1, 5), line(6, 'SKU-6', 1, 6), line(7, 'SKU-7', 1, 7), line(9, 'MUESTRA', 1, 9), line(10, 'PW12401', 1, 10),
  ], 254055)
  const result = await detectPreparationCommercialChange({ card: identity('company-a', 'd6fc7d5b5c21'), knownVersion: known }, { provider: providerFor(current).provider, authorize, useCache: false })
  assert.equal(result.status, 'CHANGED')
  assert.equal(result.currentVersion?.physicalId, 92714)
  assert.equal(result.comparison?.differences.filter(item => item.kind === 'ADDED').length, 2)
  assert.equal(result.comparison?.differences.filter(item => item.kind === 'REMOVED').length, 1)
  assert.equal(result.comparison?.totals.totalDelta, 16893)
})

test('contenido idéntico con nuevo ID físico devuelve UNCHANGED', async () => {
  clearPreparationCommercialDetectorCache()
  const known = version(92706, [line(1, 'A', 1, 1)], 1000)
  const current = version(92714, [line(1, 'A', 1, 1)], 1000)
  const result = await detectPreparationCommercialChange({ card: identity(), knownVersion: known }, { provider: providerFor(current).provider, authorize, useCache: false })
  assert.equal(result.status, 'UNCHANGED')
})

test('propaga CHANGED para alta, baja y cantidades', async () => {
  clearPreparationCommercialDetectorCache()
  const known = version(1, [line(1, 'A', 1, 1), line(2, 'B', 4, 2)])
  const current = version(2, [line(1, 'A', 3, 1), line(3, 'C', 1, 3)])
  const result = await detectPreparationCommercialChange({ card: identity(), knownVersion: known }, { provider: providerFor(current).provider, authorize, useCache: false })
  assert.equal(result.status, 'CHANGED')
  assert.equal(result.comparison?.differences.some(item => item.kind === 'QUANTITY_INCREASED'), true)
  assert.equal(result.comparison?.differences.some(item => item.kind === 'REMOVED'), true)
  assert.equal(result.comparison?.differences.some(item => item.kind === 'ADDED'), true)
})

test('Bsale no disponible devuelve UNAVAILABLE y no se confunde con UNCHANGED', async () => {
  clearPreparationCommercialDetectorCache()
  const error = new PreparationCommercialProviderError('UNAVAILABLE', 'timeout')
  const result = await detectPreparationCommercialChange({ card: identity(), knownVersion: version(1, [line(1, 'A', 1, 1)]) }, { provider: providerFor(error).provider, authorize, useCache: false })
  assert.equal(result.status, 'UNAVAILABLE')
  assert.equal(result.currentVersion, null)
})

test('respuesta incompleta devuelve INCOMPLETE', async () => {
  clearPreparationCommercialDetectorCache()
  const result = await detectPreparationCommercialChange({ card: identity(), knownVersion: version(1, [line(1, 'A', 1, 1)]) }, { provider: providerFor(new PreparationCommercialProviderError('INCOMPLETE', 'faltan detalles')).provider, authorize, useCache: false })
  assert.equal(result.status, 'INCOMPLETE')
})

test('identidad ambigua devuelve AMBIGUOUS', async () => {
  clearPreparationCommercialDetectorCache()
  const current = version(2, [line(1, 'A', 1, 1)], 0, 'other-token')
  const result = await detectPreparationCommercialChange({ card: identity(), knownVersion: version(1, [line(1, 'A', 1, 1)]) }, { provider: providerFor(current).provider, authorize, useCache: false })
  assert.equal(result.status, 'AMBIGUOUS')
})

test('IN_AUDIT y AUDITED devuelven NOT_APPLICABLE sin consultar Bsale', async () => {
  clearPreparationCommercialDetectorCache()
  const simulated = providerFor(version(2, [line(1, 'A', 1, 1)]))
  for (const status of ['IN_AUDIT', 'AUDITED']) {
    const result = await detectPreparationCommercialChange({ card: { ...identity(), status }, knownVersion: version(1, [line(1, 'A', 1, 1)]) }, { provider: simulated.provider, authorize, useCache: false })
    assert.equal(result.status, 'NOT_APPLICABLE')
  }
  assert.equal(simulated.calls(), 0)
})

test('dos solicitudes concurrentes al mismo documento comparten la consulta', async () => {
  clearPreparationCommercialDetectorCache()
  const current = version(2, [line(1, 'A', 1, 1)])
  const simulated = providerFor(current, 20)
  const request = { card: identity(), knownVersion: version(1, [line(1, 'A', 1, 1)]) }
  const [first, second] = await Promise.all([
    detectPreparationCommercialChange(request, { provider: simulated.provider, authorize }),
    detectPreparationCommercialChange(request, { provider: simulated.provider, authorize }),
  ])
  assert.equal(first.status, 'UNCHANGED')
  assert.equal(second.status, 'UNCHANGED')
  assert.equal(simulated.calls(), 1)
})

test('el cache queda aislado por empresa', async () => {
  clearPreparationCommercialDetectorCache()
  const first = providerFor(version(2, [line(1, 'A', 1, 1)]))
  const second = providerFor(version(3, [line(1, 'A', 1, 1)]))
  const known = version(1, [line(1, 'A', 1, 1)])
  await detectPreparationCommercialChange({ card: identity('company-a'), knownVersion: known }, { provider: first.provider, authorize })
  await detectPreparationCommercialChange({ card: identity('company-b'), knownVersion: known }, { provider: second.provider, authorize })
  assert.equal(first.calls(), 1)
  assert.equal(second.calls(), 1)
})

test('autorización, empresa y versión conocida son obligatorias', async () => {
  clearPreparationCommercialDetectorCache()
  const known = version(1, [line(1, 'A', 1, 1)])
  const unauthorized = await detectPreparationCommercialChange({ card: identity(), knownVersion: known }, { provider: providerFor(known).provider, authorize: () => { throw new Error('no autorizado') }, useCache: false })
  assert.equal(unauthorized.status, 'AMBIGUOUS')
  const incompleteIdentity = await detectPreparationCommercialChange({ card: { ...identity(), canonicalToken: null }, knownVersion: known }, { provider: providerFor(known).provider, authorize, useCache: false })
  assert.equal(incompleteIdentity.status, 'AMBIGUOUS')
  const incompleteVersion = await detectPreparationCommercialChange({ card: identity(), knownVersion: null }, { provider: providerFor(known).provider, authorize, useCache: false })
  assert.equal(incompleteVersion.status, 'INCOMPLETE')
})

test('el proveedor Bsale localiza por folio y token, y selecciona la versión física más reciente', async () => {
  const calls = []
  const provider = createBsalePreparationCommercialProvider({
    async fetchPage(request) {
      calls.push(request)
      if (request.path === '/documents.json') {
        return {
          count: 2,
          items: [
            { id: 92706, number: 5129, documentTypeId: 23, token: 'd6fc7d5b5c21', state: 0, generationDate: 100, totalAmount: 1, details: [{ id: 1, variantId: 1, variantCode: 'A', quantity: 1 }] },
            { id: 92714, number: 5129, documentTypeId: 23, token: 'd6fc7d5b5c21', state: 0, generationDate: 200, totalAmount: 2, details: [{ id: 2, variantId: 1, variantCode: 'A', quantity: 2 }] },
          ],
        }
      }
      throw new Error('no debería solicitar detalles expandidos')
    },
  })
  const current = await provider.getCurrentVersion({ ...identity('company-a', 'd6fc7d5b5c21'), status: 'PENDING_ROUTE_PREP' }, new AbortController().signal)
  assert.equal(current.physicalId, 92714)
  assert.equal(current.lines[0].quantity, 2)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.number, '5129')
})

test('el proveedor marca detalles incompletos en lugar de fabricar una versión', async () => {
  const provider = createBsalePreparationCommercialProvider({
    async fetchPage(request) {
      if (request.path === '/documents.json') return { count: 1, items: [{ id: 92714, number: 5129, documentTypeId: 23, token: 'd6fc7d5b5c21', state: 0, details: { count: 2, items: [{ id: 1, quantity: 1 }] } }] }
      return { count: 2, items: [{ id: 1, quantity: 1 }] }
    },
  })
  await assert.rejects(
    provider.getCurrentVersion({ ...identity('company-a', 'd6fc7d5b5c21'), status: 'PENDING_ROUTE_PREP' }, new AbortController().signal),
    error => error.code === 'INCOMPLETE',
  )
})

test('el proveedor usa el nombre normalizado completo del producto y conserva la presentación', async () => {
  const provider = createBsalePreparationCommercialProvider({
    async fetchPage(request) {
      if (request.path === '/documents.json') {
        return {
          count: 1,
          items: [{
            id: 92714, number: 5129, documentTypeId: 23, token: 'd6fc7d5b5c21', state: 0,
            generationDate: 200, details: [
              { id: 335939, variantId: 5729, variantCode: 'MUESTRA', description: 'MUESTRAS', quantity: 1 },
              { id: 335940, variantId: 3184, variantCode: 'PW12401', description: 'AZUL', quantity: 1 },
            ],
          }],
        }
      }
      throw new Error('no debería solicitar detalles expandidos')
    },
    async resolveProductNames() {
      return {
        5729: 'SURTIDOS MUESTRAS',
        3184: 'PAWISE 3 EN 1 CAMA/MANTA/COJIN AZUL',
      }
    },
  })

  const current = await provider.getCurrentVersion({ ...identity('company-a', 'd6fc7d5b5c21'), status: 'IN_PREPARATION' }, new AbortController().signal)
  assert.deepEqual(current.lines.map(line => [line.sku, line.productName]), [
    ['MUESTRA', 'SURTIDOS MUESTRAS'],
    ['PW12401', 'PAWISE 3 EN 1 CAMA/MANTA/COJIN AZUL'],
  ])
})
