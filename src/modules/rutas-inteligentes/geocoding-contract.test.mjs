import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return nextResolve(`${specifier}.ts`, context)
  }
} })

const { prepareGeocodingStop, adaptSimulatedGeocodingResponse, normalizeGeographicText, normalizeGeographicCountry } = await import('./geocoding-contract.ts')
const { buildDeliveryStops } = await import('./delivery-stops.ts')
const { getVerifiedStopLocation } = await import('./route-scenario.ts')

function delivery(id, overrides = {}) {
  return {
    stopId: `preparation:${id}`, source: { type: 'PREPARATION', recordId: String(id) }, documents: [{ type: 'SALES_ORDER', system: 'BSALE', id, folio: String(id) }],
    routeGuide: { guideId: null, itemId: null, lineNumber: null }, customer: { id: 5, name: 'Cliente ficticio' },
    destination: { address: '  Avenida  Árbol  123 ', commune: ' Ñuñoa ', city: null, addressSource: 'PREPARATION_CARD', communeSource: 'MUNICIPALITY_RAW', completeness: 'COMPLETE' },
    commercial: { netAmount: null, taxAmount: null, grossAmount: null, totalAmount: null, profitability: { availability: 'MISSING', costStatus: null, estimatedGrossProfit: null, estimatedMarginPct: null, costCoveragePct: null, salesNetTotal: null, coveredSalesNet: null, uncoveredSalesNet: null } },
    ...overrides,
  }
}

function stopFor(deliveries = [delivery(1)]) {
  const result = buildDeliveryStops(deliveries)
  assert.equal(result.stops.length, 1)
  return result.stops[0]
}

function prepare(stop = stopFor(), companyId = 'company-a', scope = 'MYM_DOMESTIC') {
  return prepareGeocodingStop({ companyId, stop, scope })
}

function response(prepared, overrides = {}) {
  return {
    stopId: prepared.stopId, cacheKey: { ...prepared.cacheKey }, provider: 'proveedor simulado', outcome: 'CANDIDATES',
    candidates: [{ countryCode: 'CL', commune: 'Ñuñoa', street: 'Avenida Árbol', number: '123', precision: 'ADDRESS', coordinates: [-70.6, -33.4] }], ...overrides,
  }
}

test('normalización conserva originales y procedencia; CL requiere ámbito doméstico explícito', () => {
  const first = delivery(1)
  const second = delivery(2, { destination: { ...first.destination, address: 'AVENIDA ÁRBOL 123', commune: 'ÑUÑOA' } })
  const stop = stopFor([first, second])
  const result = prepare(stop)
  assert.equal(result.status, 'READY')
  assert.equal(result.countrySource, 'MYM_DOMESTIC_POLICY')
  assert.deepEqual(result.cacheKey, { companyId: 'company-a', countryCode: 'CL', communeKey: 'ñuñoa', addressKey: 'avenida árbol 123' })
  assert.equal(result.streetKey, 'avenida árbol')
  assert.equal(result.numberKey, '123')
  assert.equal(result.originals[0].address, '  Avenida  Árbol  123 ')
  assert.equal(result.originals[0].communeSource, 'MUNICIPALITY_RAW')
  assert.equal(result.originals[1].address, 'AVENIDA ÁRBOL 123')
  assert.notEqual(result.stopId, result.cacheKey.addressKey)
  assert.equal(prepare(stop, 'company-a', 'UNKNOWN').reason, 'DOMESTIC_SCOPE_REQUIRED')
  assert.equal(prepare(stop, 'company-a', 'US').status, 'REVIEW_REQUIRED')
  assert.equal(normalizeGeographicText(' N\u0303UÑOA '), 'ñuñoa')
  assert.equal(normalizeGeographicText({ value: 'Dirección' }), null)
  assert.equal(normalizeGeographicCountry(' cl '), 'CL')
  assert.equal(normalizeGeographicCountry('Argentina'), null)
  assert.equal(normalizeGeographicCountry(null), null)
})

test('no completa números ausentes ni acepta comunas de ciudad o destinos contradictorios', () => {
  const stop = stopFor()
  const missing = { ...stop, normalizedAddress: 'avenida árbol', deliveries: [{ ...stop.deliveries[0], destination: { ...stop.deliveries[0].destination, address: 'Avenida Árbol' } }] }
  assert.equal(prepare(missing).reason, 'ADDRESS_NOT_SPECIFIC')
  const missingCommune = { ...stop, deliveries: [{ ...stop.deliveries[0], destination: { ...stop.deliveries[0].destination, commune: null, completeness: 'INCOMPLETE' } }] }
  assert.equal(prepare(missingCommune).reason, 'INCOMPLETE_DESTINATION')
  const city = { ...stop, deliveries: [{ ...stop.deliveries[0], destination: { ...stop.deliveries[0].destination, communeSource: 'CITY_RAW' } }] }
  assert.equal(prepare(city).reason, 'INCOMPLETE_DESTINATION')
  const different = { ...stop, deliveries: [stop.deliveries[0], { ...delivery(2), destination: { ...delivery(2).destination, commune: 'Providencia' } }] }
  assert.equal(prepare(different).reason, 'INCONSISTENT_DESTINATIONS')
})

test('acepta calle y número seguidos de la misma comuna conservando la dirección de la NV', () => {
  const base = delivery(1)
  for (const address of ['Av los Puelches 1440, Chillán', 'AV LOS PUELCHES 1440 , CHILLA\u0301N', 'Av los Puelches 1440, Chillán, Chile']) {
    const item = { ...base, destination: { ...base.destination, address, commune: 'Chillán' } }
    const prepared = prepare(stopFor([item]))
    assert.equal(prepared.status, 'READY')
    assert.equal(prepared.originals[0].address, address)
    assert.equal(prepared.cacheKey.addressKey, normalizeGeographicText(address))
    assert.equal(prepared.cacheKey.communeKey, 'chillán')
    assert.equal(prepared.streetKey, 'av los puelches')
    assert.equal(prepared.numberKey, '1440')
  }
})

test('NV 5387 y variantes de numeral conservan la dirección y comparan calle, número y comuna', () => {
  const base = delivery(5387)
  for (const address of ['BALMACEDA #541', 'Balmaceda # 541', 'Balmaceda#541', 'Balmaceda #541, San Carlos', 'Balmaceda #541, San Carlos, Chile']) {
    const item = { ...base, destination: { ...base.destination, address, commune: 'San Carlos' } }
    const prepared = prepare(stopFor([item]))
    assert.equal(prepared.status, 'READY', address)
    assert.equal(prepared.originals[0].address, address)
    assert.equal(prepared.cacheKey.addressKey, normalizeGeographicText(address))
    assert.equal(prepared.cacheKey.communeKey, 'san carlos')
    assert.equal(prepared.streetKey, 'balmaceda')
    assert.equal(prepared.numberKey, '541')
    const candidate = { countryCode: 'CL', commune: 'San Carlos', street: 'Balmaceda', number: '541', precision: 'ADDRESS', coordinates: [-71.9, -36.4] }
    assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [candidate] })).status, 'RECOGNIZED')
    assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [{ ...candidate, number: '542' }] })).status, 'REVIEW_REQUIRED')
    assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [{ ...candidate, commune: 'Otra' }] })).status, 'REVIEW_REQUIRED')
  }
})

test('numeral sin número inequívoco o con comuna contradictoria sigue bloqueado', () => {
  const base = delivery(1)
  for (const address of ['Balmaceda #', 'Balmaceda # S/N', 'Balmaceda # por confirmar', 'Balmaceda #541-543', 'Balmaceda ##541', 'Balmaceda #541, Chillán']) {
    const item = { ...base, destination: { ...base.destination, address, commune: 'San Carlos' } }
    const grouped = buildDeliveryStops([item])
    if (grouped.stops.length) assert.equal(prepare(grouped.stops[0]).status, 'REVIEW_REQUIRED', address)
    else assert.equal(grouped.unresolved.length, 1, address)
  }
})

test('reconoce número domiciliario con locales, esquinas, villas y referencias sin alterar el original', () => {
  const base = delivery(1)
  const cases = [
    ['Avda. Alonso de Ercilla 2780 local 10', 'San Carlos', 'avda. alonso de ercilla', '2780'],
    ['Isabel Riquelme #931 local 45', 'Chillán', 'isabel riquelme', '931'],
    ['18 poniente #0756 esquina pasaje 27 y media sur', 'Talca', '18 poniente', '0756'],
    ['Caupolicán 187 Quillón', 'Quillón', 'caupolicán', '187'],
    ['5 poniente 1737 Doña Ignacia', 'Talca', '5 poniente', '1737'],
    ['Pasaje Los Robles 120, Villa Las Rosas, Talca', 'Talca', 'pasaje los robles', '120'],
    ['Los Aromos 120 villa los robles', 'Talca', 'los aromos', '120'],
    ['Avenida Sur 120, local 10, Talca', 'Talca', 'avenida sur', '120'],
  ]
  for (const [address, commune, street, number] of cases) {
    const item = { ...base, destination: { ...base.destination, address, commune } }
    const prepared = prepare(stopFor([item]))
    assert.equal(prepared.status, 'READY', address)
    assert.equal(prepared.streetKey, street, address)
    assert.equal(prepared.numberKey, number, address)
    assert.equal(prepared.cacheKey.addressKey, normalizeGeographicText(address))
    assert.equal(prepared.cacheKey.communeKey, normalizeGeographicText(commune))
    assert.equal(prepared.originals[0].address, address)
  }
})

test('no confunde números de viviendas o referencias con numeración domiciliaria inequívoca', () => {
  const base = delivery(1)
  for (const address of ['Pasaje Los Robles local 10', 'Villa Las Rosas casa 12', 'Calle Norte 12 sur 45', 'Calle Central 120 local', 'Calle Central 120 esquina', 'Calle Central 120, Talca', 'Calle Central 120 local 10 12']) {
    const item = { ...base, destination: { ...base.destination, address, commune: 'San Carlos' } }
    const grouped = buildDeliveryStops([item])
    if (grouped.stops.length) assert.equal(prepare(grouped.stops[0]).status, 'REVIEW_REQUIRED', address)
    else assert.equal(grouped.unresolved.length, 1, address)
  }
})

test('la validación del candidato usa la calle y número sin el sufijo de comuna', () => {
  const base = delivery(1)
  const item = { ...base, destination: { ...base.destination, address: 'Av los Puelches 1440, Chillán', commune: 'Chillán' } }
  const prepared = prepare(stopFor([item]))
  const provider = response(prepared, { candidates: [{ countryCode: 'CL', commune: 'Chillán', street: 'Av los Puelches', number: '1440', precision: 'ADDRESS', coordinates: [-72.1, -36.6] }] })
  const result = adaptSimulatedGeocodingResponse(prepared, provider)
  assert.equal(result.status, 'RECOGNIZED')
  assert.deepEqual(result.location.coordinates, [-72.1, -36.6])
  assert.equal(result.location.physicalAccessVerified, false)
})

test('Av y Avenida coinciden solo si también coinciden calle completa, número y comuna', () => {
  const base = delivery(1)
  const item = { ...base, destination: { ...base.destination, address: 'Av los Puelches 1440, Chillán', commune: 'Chillán' } }
  const prepared = prepare(stopFor([item]))
  const exact = { countryCode: 'CL', commune: 'Chillán', street: 'Avenida Los Puelches', number: '1440', precision: 'ADDRESS', coordinates: [-72.1, -36.6] }
  assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [exact] })).status, 'RECOGNIZED')
  assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [{ ...exact, number: '1695' }] })).status, 'REVIEW_REQUIRED')
  assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [{ ...exact, street: 'Avenida Los Corregidores' }] })).status, 'REVIEW_REQUIRED')
  assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [{ ...exact, commune: 'Otra comuna' }] })).status, 'REVIEW_REQUIRED')
  assert.equal(prepared.cacheKey.addressKey, 'av los puelches 1440, chillán')
})

test('rechaza sufijos de comuna contradictorios y direcciones sin número', () => {
  const base = delivery(1)
  for (const address of ['Av los Puelches, Chillán', 'Chillán', 'Av los Puelches 1440, Talca', 'Av los Puelches 1440, Chillán, Perú', 'Av los Puelches 1440, oficina 2, Chillán']) {
    const item = { ...base, destination: { ...base.destination, address, commune: 'Chillán' } }
    const grouped = buildDeliveryStops([item])
    if (grouped.stops.length) assert.equal(prepare(grouped.stops[0]).status, 'REVIEW_REQUIRED')
    else assert.equal(grouped.unresolved.length, 1)
  }
})

test('una coincidencia de calle, número y comuna propone ubicación sin verificar acceso físico', () => {
  const prepared = prepare()
  const result = adaptSimulatedGeocodingResponse(prepared, response(prepared))
  assert.equal(result.status, 'RECOGNIZED')
  assert.equal(result.location.physicalAccessVerified, false)
  assert.equal(result.location.classification, 'RECOGNIZED')
  assert.deepEqual(getVerifiedStopLocation(result.location), [-70.6, -33.4])
})

test('coincidencias aproximadas, múltiples o incompletas nunca generan marcadores', () => {
  const prepared = prepare()
  const exact = response(prepared).candidates[0]
  const fixtures = [
    [{ ...exact, precision: 'APPROXIMATE' }, 'APPROXIMATE'],
    [{ ...exact, commune: 'Providencia' }, 'REVIEW_REQUIRED'],
    [{ ...exact, countryCode: 'AR' }, 'REVIEW_REQUIRED'],
    [{ ...exact, number: null }, 'REVIEW_REQUIRED'],
    [{ ...exact, number: '124' }, 'REVIEW_REQUIRED'],
    [{ ...exact, street: 'Avenida Arbol' }, 'REVIEW_REQUIRED'],
    [{ ...exact, coordinates: [181, 0] }, 'REVIEW_REQUIRED'],
    [{ ...exact, precision: 'UNKNOWN' }, 'REVIEW_REQUIRED'],
  ]
  for (const [candidate, status] of fixtures) {
    const result = adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [candidate] }))
    assert.equal(result.status, status)
    assert.equal(result.location, null)
  }
  assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [exact, exact] })).status, 'AMBIGUOUS')
  assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { candidates: [] })).status, 'NOT_FOUND')
})

test('error de proveedor es distinto de no encontrada y no entrega coordenadas', () => {
  const prepared = prepare()
  const error = adaptSimulatedGeocodingResponse(prepared, response(prepared, { outcome: 'ERROR', candidates: [] }))
  assert.equal(error.status, 'ERROR')
  assert.equal(error.location, null)
  assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { outcome: 'NOT_FOUND', candidates: [] })).status, 'NOT_FOUND')
  assert.equal(adaptSimulatedGeocodingResponse(prepared, response(prepared, { outcome: 'NOT_FOUND' })).status, 'ERROR')
  const incomplete = prepare(stopFor(), 'company-a', 'UNKNOWN')
  assert.equal(adaptSimulatedGeocodingResponse(incomplete, response(prepared)).status, 'REVIEW_REQUIRED')
})

test('claves y respuestas separan empresas, paradas y cambios de dirección', () => {
  const stop = stopFor()
  const a = prepare(stop, 'company-a')
  const b = prepare(stop, 'company-b')
  assert.notDeepEqual(a.cacheKey, b.cacheKey)
  assert.equal(a.stopId, b.stopId)
  assert.equal(adaptSimulatedGeocodingResponse(b, response(a)).status, 'ERROR')
  assert.equal(adaptSimulatedGeocodingResponse(a, response(a, { stopId: 'otra-parada' })).status, 'ERROR')
  assert.equal(adaptSimulatedGeocodingResponse(a, response(a, { cacheKey: { ...a.cacheKey, addressKey: 'otra 123' } })).status, 'ERROR')
  assert.equal(prepare(stop, '').reason, 'COMPANY_REQUIRED')
})
