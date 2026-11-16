import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return nextResolve(`${specifier}.ts`, context)
  }
} })

const { adaptFilteredPreparationCards } = await import('./preparation-adapter.ts')
const { buildDeliveryStops } = await import('./delivery-stops.ts')
const { matchesPreparationSearch, matchesPreparationComunaFilter, matchesPreparationSellerFilter } = await import('../logistica/preparacion-pedidos/preparation-board-utils.ts')
const boardUtils = await import('../logistica/preparacion-pedidos/preparation-board-utils.ts')
const profitabilityUtils = await import('../logistica/preparacion-pedidos/preparation-profitability.ts')
const presentationUtils = await import('./stop-presentation.ts')
const scenarioUtils = await import('./route-scenario.ts')
const geometryUtils = await import('./decode-route-geometry.ts')

async function loadDialogComponents(testState) {
  const source = await readFile(new URL('./preliminary-route-dialog.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const nativeRequire = createRequire(import.meta.url)
  const react = nativeRequire('react')
  const jsxRuntime = nativeRequire('react/jsx-runtime')
  let nullStateIndex = 0
  const captureInput = render => (type, props, key) => {
    if (testState && type === 'input' && props['aria-label']?.startsWith('Seleccionar parada ')) testState.onListSelection = props.onChange
    if (testState && type === 'button' && ['Consultar ubicación', 'Consultar de nuevo'].includes(props.children)) testState.onLookup = props.onClick
    if (testState && type === 'button' && ['Previsualizar en mapa', 'Previsualizando en mapa'].includes(props.children)) testState.onPreview = props.onClick
    return render(type, props, key)
  }
  const modules = {
    ...(testState ? {
      react: {
        ...react,
        useState: initial => typeof initial === 'function'
          ? [testState.scenario, update => { testState.scenario = update(testState.scenario) }]
          : initial === null
            ? (nullStateIndex++ % 2 === 0
              ? [testState.optimization ?? null, update => { testState.optimization = typeof update === 'function' ? update(testState.optimization ?? null) : update }]
              : [(testState.previewCandidate ??= null), update => { testState.previewCandidate = typeof update === 'function' ? update(testState.previewCandidate ?? null) : update }])
            : [(testState.locationStates ??= {}), update => { testState.locationStates = update(testState.locationStates ?? {}) }],
      },
      'react/jsx-runtime': { ...jsxRuntime, jsx: captureInput(jsxRuntime.jsx), jsxs: captureInput(jsxRuntime.jsxs) },
    } : {}),
    '@/components/ui/dialog': {},
    '@/modules/logistica/preparacion-pedidos/preparation-board-utils': boardUtils,
    '@/modules/logistica/preparacion-pedidos/preparation-profitability': profitabilityUtils,
    './preparation-adapter': { adaptFilteredPreparationCards },
    './delivery-stops': { buildDeliveryStops },
    './stop-presentation': presentationUtils,
    './route-scenario': scenarioUtils,
    './route-map': { RouteMap: ({ stops, onToggleSelection, previewCandidate }) => {
      if (testState) { testState.mapStops = stops; testState.onMapSelection = onToggleSelection; testState.mapPreview = previewCandidate }
      return createElement('div', { 'data-map-stops': stops.map(stop => stop.id).join(','), 'data-preview': previewCandidate ? previewCandidate.label : '' })
    } },
    './location-lookup-action': { resolveLocationAction: async ids => testState?.lookup ? testState.lookup(ids) : { ok: false, error: 'fixture' } },
    './optimize-route-action': { optimizePreparationRouteAction: async () => ({ ok: false, code: 'fixture', message: 'fixture' }) },
    './decode-route-geometry': geometryUtils,
  }
  const localRequire = name => Object.hasOwn(modules, name) ? modules[name] : nativeRequire(name)
  const exports = {}
  new Function('require', 'exports', compiled)(localRequire, exports)
  return exports
}

async function renderStopCard(stop, warningsByCardId = {}) {
  const components = await loadDialogComponents()
  return renderToStaticMarkup(createElement(components.PotentialStopCard, { stop, index: 0, warningsByCardId }))
}

test('diagnóstico cuenta cada tarjeta compartida y distingue aceptación, HeiGIT y envío', async () => {
  const { RouteGeocodingDiagnostics } = await loadDialogComponents()
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards: [card(1), card(2)], profitabilityByNv: {} })
  const diagnostic = { authorized: true, heigit: 'RESPONDED', classification: 'EXACT', accepted: false, reason: 'Calle no coincide', sentToVroom: false }
  const result = { ok: true, stops: [{ cardIds: ['card-1', 'card-2'], diagnostic }] }
  const html = renderToStaticMarkup(createElement(RouteGeocodingDiagnostics, { result, deliveries: evaluation.deliveries }))
  assert.match(html, /2 tarjetas/)
  assert.match(html, /<strong>2<\/strong> · Calle no coincide/)
  assert.equal((html.match(/Autorizada: sí/g) ?? []).length, 2)
  assert.match(html, /HeiGIT: respondió · EXACT/)
  assert.match(html, /Coordenadas enviadas a VROOM: no/)
})

test('escenario monta diagnóstico antes de la lista con 23 pendientes y sin ruta', async () => {
  const cards = Array.from({ length: 23 }, (_, index) => card(index + 1, { address_raw: `Calle ${index + 101}` }))
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards: cards, profitabilityByNv: {} })
  const { stops, unresolved } = buildDeliveryStops(evaluation.deliveries)
  const diagnostic = { authorized: true, heigit: 'RESPONDED', classification: 'NOT_FOUND', accepted: false, reason: 'Sin coincidencia exacta', sentToVroom: false }
  const results = stops.map(stop => ({ stopId: stop.id, cardIds: stop.deliveries.map(delivery => delivery.source.recordId), coordinates: null, locationStatus: 'NOT_FOUND', diagnostic }))
  const ids = stops.flatMap(stop => stop.deliveries.map(delivery => delivery.source.recordId))
  const testState = { scenario: scenarioUtils.createRouteScenario(stops), optimization: { key: JSON.stringify(ids), result: { ok: true, complete: false, stops: results, pending: results, unassigned: [], route: null } } }
  const { ScenarioWorkspace } = await loadDialogComponents(testState)
  const html = renderToStaticMarkup(createElement(ScenarioWorkspace, { stops, unresolved, routeWarningsByCardId: {}, locationsByStopId: {} }))
  assert.match(html, /Sin paradas localizadas; ruta no disponible/)
  assert.match(html, /Diagnóstico de geocodificación · 23 tarjetas/)
  assert.match(html, /<strong>23<\/strong> · Sin coincidencia exacta/)
  assert.equal((html.match(/Coordenadas enviadas a VROOM: no/g) ?? []).length, 23)
  assert.ok(html.indexOf('Diagnóstico de geocodificación · 23 tarjetas') < html.indexOf('aria-label="Lista de paradas"'))
})

test('diagnóstico permanece desplegable durante carga y error', async () => {
  const { RouteGeocodingDiagnostics } = await loadDialogComponents()
  for (const result of [null, { ok: false, code: 'UNAUTHORIZED', message: 'Sin acceso' }]) {
    const html = renderToStaticMarkup(createElement(RouteGeocodingDiagnostics, { result, deliveries: [] }))
    assert.match(html, /<details/)
    assert.match(html, /Diagnóstico de geocodificación/)
  }
})

function card(id, overrides = {}) {
  return { card_id: `card-${id}`, company_id: 'company', nv_bsale_id: id, nv_folio: String(id), client_name: 'Cliente', client_id: 1, address_raw: 'Calle 123', normalized_city: 'Talca', municipality_raw: null, city_raw: null, seller_name: 'Ana', total_quantity: 1, gross_amount: 119, total_amount: 119, net_amount: 100, tax_amount: 19, invoice_folio: null, ...overrides }
}

test('filtros actuales alimentan la simulación completa y mantienen entregas por revisar', () => {
  const cards = [card(1), card(2), card(3, { address_raw: null }), card(4, { seller_name: 'Bea' })]
  const filteredCards = cards.filter(item => matchesPreparationSearch(item, 'cliente') && matchesPreparationComunaFilter(item, new Set(['talca'])) && matchesPreparationSellerFilter(item, 'ana'))
  const result = adaptFilteredPreparationCards({ companyId: 'company', filteredCards, profitabilityByNv: {} })
  const stops = buildDeliveryStops(result.deliveries)
  assert.equal(result.commercialSummary.documentCount, 3)
  assert.equal(result.commercialSummary.profitability.availability, 'MISSING')
  assert.equal(stops.stops.length, 1)
  assert.deepEqual(stops.stops[0].deliveries.map(item => item.source.recordId), ['card-1', 'card-2'])
  assert.equal(stops.unresolved[0].delivery.source.recordId, 'card-3')
  assert.ok(stops.unresolved[0].issues.includes('MISSING_ADDRESS'))
  const afterFilterChange = adaptFilteredPreparationCards({ companyId: 'company', filteredCards: cards.filter(item => matchesPreparationSellerFilter(item, 'bea')), profitabilityByNv: {} })
  assert.deepEqual(afterFilterChange.deliveries.map(item => item.source.recordId), ['card-4'])
})

test('panel conecta el diálogo a filteredCards y la vista utiliza ambos adaptadores', async () => {
  const panel = await readFile(new URL('../logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', import.meta.url), 'utf8')
  const dialog = await readFile(new URL('./preliminary-route-dialog.tsx', import.meta.url), 'utf8')
  assert.match(panel, /<PreliminaryRouteDialog[\s\S]*?filteredCards=\{filteredCards\}/)
  assert.match(panel, /<PreparationBreadcrumbIndicators action=\{[\s\S]*?Evaluar ruta/)
  assert.match(dialog, /adaptFilteredPreparationCards\(\{ companyId, filteredCards, profitabilityByNv \}\)/)
  assert.match(dialog, /buildDeliveryStops\(evaluation\.deliveries\)/)
  assert.match(dialog, /Simulación de ruta para las NV del filtro activo/)
  assert.match(dialog, /profitabilityLoading[\s\S]*profitabilityError/)
})

test('el folio numérico de la vista estándar se conserva como referencia documental', () => {
  const filteredCards = [card(1, { nv_folio: 5172 }), card(2, { nv_folio: ' 5173 ', invoice_folio: 9812 })]
  const result = adaptFilteredPreparationCards({ companyId: 'company', filteredCards, profitabilityByNv: {} })
  assert.deepEqual(result.deliveries.map(item => item.documents[0].folio), ['5172', '5173'])
  assert.equal(result.deliveries[1].documents[1].folio, '9812')
  assert.equal(buildDeliveryStops(result.deliveries).stops.length, 1)
})

test('datos incompatibles e incompletos se señalan por tarjeta sin inventar destinos', () => {
  const filteredCards = [
    card(1, { nv_folio: 5172 }),
    card(2, { nv_folio: 5173, address_raw: { street: 'Calle 123' }, invoice_folio: { number: 40 } }),
    card(3, { nv_folio: 5174, normalized_city: 3, municipality_raw: 'Talca', client_name: { name: 'Cliente' } }),
    card(4, { nv_folio: 5175, address_raw: null }),
    card(5, { nv_folio: { number: 5176 } }),
  ]
  const result = adaptFilteredPreparationCards({ companyId: 'company', filteredCards, profitabilityByNv: {} })
  const stops = buildDeliveryStops(result.deliveries)
  assert.equal(result.commercialSummary.documentCount, 5)
  assert.deepEqual(stops.stops.flatMap(stop => stop.deliveries.map(item => item.source.recordId)), ['card-1'])
  const byId = Object.fromEntries(stops.unresolved.map(item => [item.delivery.source.recordId, item]))
  assert.deepEqual(byId['card-2'].delivery.invalidSourceFields, ['address_raw', 'invoice_folio'])
  assert.equal(byId['card-2'].delivery.destination.address, null)
  assert.equal(byId['card-2'].delivery.documents.length, 1)
  assert.ok(byId['card-2'].issues.includes('INVALID_SOURCE_FIELD'))
  assert.ok(byId['card-2'].issues.includes('MISSING_ADDRESS'))
  assert.deepEqual(byId['card-3'].delivery.invalidSourceFields, ['normalized_city', 'client_name'])
  assert.equal(byId['card-3'].delivery.destination.commune, 'Talca')
  assert.equal(byId['card-3'].delivery.customer.name, null)
  assert.ok(byId['card-4'].issues.includes('MISSING_ADDRESS'))
  assert.deepEqual(byId['card-5'].delivery.invalidSourceFields, ['nv_folio'])
  assert.equal(byId['card-5'].delivery.documents[0].folio, null)
  assert.equal(byId['card-5'].delivery.documents[0].id, 5)
})

test('tarjeta compacta muestra cliente y dirección una vez, ambas NV, factura y estado compartido', async () => {
  const filteredCards = [card(1, { nv_folio: '5398', invoice_folio: '1200' }), card(2, { nv_folio: '5386' })]
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards, profitabilityByNv: {} })
  const [stop] = buildDeliveryStops(evaluation.deliveries).stops
  const html = await renderStopCard(stop, { 'card-1': ['Etapa pendiente'], 'card-2': ['Etapa pendiente'] })
  assert.equal(html.split('Cliente').length - 1, 1)
  assert.equal(html.split('Calle 123 · Talca').length - 1, 1)
  assert.match(html, /NV #5398/)
  assert.match(html, /NV #5386/)
  assert.match(html, /Factura #1200/)
  assert.match(html, /3 documentos/)
  assert.equal(html.split('Etapa pendiente').length - 1, 1)
  assert.match(html, /<details class=/)
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/)
  assert.match(html, /Ver detalle por documento/)
})

test('la tarjeta conserva estados distintos y paradas separadas por dirección', async () => {
  const filteredCards = [card(1, { nv_folio: '5398' }), card(2, { nv_folio: '5386' }), card(3, { address_raw: 'Calle 456' })]
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards, profitabilityByNv: {} })
  const stops = buildDeliveryStops(evaluation.deliveries).stops
  assert.equal(stops.length, 2)
  const stop = stops.find(item => item.deliveries.length === 2)
  const presented = presentationUtils.presentPotentialStop(stop, { 'card-1': ['En preparación'], 'card-2': ['Facturada', 'Incidencia abierta'] })
  assert.deepEqual(presented.commonWarnings, [])
  assert.deepEqual(presented.rows.map(row => row.individualWarnings), [['En preparación'], ['Facturada', 'Incidencia abierta']])
  const html = await renderStopCard(stop, { 'card-1': ['En preparación'], 'card-2': ['Facturada', 'Incidencia abierta'] })
  assert.match(html, /En preparación/)
  assert.match(html, /Facturada/)
  assert.match(html, /Incidencia abierta/)
  assert.match(html, /Neto:.*Impuesto:.*Bruto:.*Total:/)
  const other = await renderStopCard(stops.find(item => item.deliveries.length === 1))
  assert.match(other, /Calle 456 · Talca/)
  assert.doesNotMatch(other, /Calle 123 · Talca/)
})

test('una factura compartida mantiene sus vínculos sin aumentar el conteo de documentos', () => {
  const filteredCards = [card(1, { read_model_invoice_bsale_id: 20, read_model_invoice_folio: '1200' }), card(2, { read_model_invoice_bsale_id: 20, read_model_invoice_folio: '1200' })]
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards, profitabilityByNv: {} })
  const [stop] = buildDeliveryStops(evaluation.deliveries).stops
  const presented = presentationUtils.presentPotentialStop(stop, {})
  assert.equal(presented.documentCount, 3)
  assert.deepEqual(presented.rows.map(row => row.documents.map(item => item.label)), [['NV #1', 'Factura #1200'], ['NV #2', 'Factura #1200']])
})

test('el escenario muestra solo coordenadas verificadas y conserva pendientes en la lista', async () => {
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards: [card(1), card(2, { address_raw: 'Calle 456' }), card(3, { address_raw: null })], profitabilityByNv: {} })
  const { stops, unresolved } = buildDeliveryStops(evaluation.deliveries)
  const components = await loadDialogComponents()
  const html = renderToStaticMarkup(createElement(components.ScenarioWorkspace, {
    stops, unresolved, routeWarningsByCardId: {},
    locationsByStopId: { [stops[0].id]: { coordinates: [-71.2, -35.4], verification: 'COORDINATE_VERIFIED', source: 'confirmación' } },
  }))
  assert.match(html, /Escenario original/)
  assert.match(html, /Ubicaciones pendientes \(1\)/)
  assert.match(html, /Entregas por revisar y ubicar \(1\)/)
  assert.match(html, /Seleccionar todas/)
  assert.match(html, /Excluir seleccionadas/)
  assert.match(html, /Reincorporar seleccionadas/)
  assert.match(html, /Restaurar escenario original/)
  assert.equal((html.match(/aria-label="Seleccionar parada /g) ?? []).length, 2)
  const mapAttributes = html.match(/data-map-stops="([^"]*)"/)[1]
  assert.equal(mapAttributes, stops[0].id.replaceAll('&', '&amp;').replaceAll('"', '&quot;'))
})

test('selección en lista y marcador comparte el mismo estado de escenario', async () => {
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards: [card(1)], profitabilityByNv: {} })
  const { stops, unresolved } = buildDeliveryStops(evaluation.deliveries)
  const testState = { scenario: scenarioUtils.createRouteScenario(stops) }
  const components = await loadDialogComponents(testState)
  const props = { stops, unresolved, routeWarningsByCardId: {}, locationsByStopId: { [stops[0].id]: { coordinates: [-71.2, -35.4], verification: 'COORDINATE_VERIFIED', source: 'confirmación' } } }
  const render = () => renderToStaticMarkup(createElement(components.ScenarioWorkspace, props))
  render()
  assert.equal(testState.mapStops[0].selected, false)
  testState.onListSelection()
  let html = render()
  assert.equal(testState.mapStops[0].selected, true)
  assert.match(html, /aria-pressed="true"/)
  testState.onMapSelection(stops[0].id)
  html = render()
  assert.equal(testState.mapStops[0].selected, false)
  assert.match(html, /aria-pressed="false"/)
  assert.equal(testState.scenario.selectedIds.size, 0)
})

test('la ubicación se consulta solo manualmente, evita duplicados en vuelo y mantiene candidatos fuera del mapa', async () => {
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards: [card(1)], profitabilityByNv: {} })
  const { stops, unresolved } = buildDeliveryStops(evaluation.deliveries)
  let calls = 0
  let finish
  const testState = { scenario: scenarioUtils.createRouteScenario(stops), lookup: ids => {
    calls++
    assert.deepEqual(ids, ['card-1'])
    return new Promise(resolve => { finish = resolve })
  } }
  const components = await loadDialogComponents(testState)
  const props = { stops, unresolved, routeWarningsByCardId: {}, locationsByStopId: {} }
  const render = () => renderToStaticMarkup(createElement(components.ScenarioWorkspace, props))
  render()
  assert.equal(calls, 0)
  testState.onLookup()
  testState.onLookup()
  assert.equal(calls, 1)
  assert.match(render(), /Consultando ubicación/)
  finish({ ok: true, results: [{ stopId: stops[0].id, cardIds: ['card-1'], cacheStatus: 'CACHE_MISS', status: 'APPROXIMATE', providerClassification: 'APPROXIMATE', error: null, candidates: [{ coordinates: [-71.6, -35.4], communeMatches: true }], recognizedLocation: null }] })
  await new Promise(resolve => setImmediate(resolve))
  const html = render()
  assert.match(html, /Aproximada · requiere revisión/)
  assert.match(html, /lat -35\.4, lon -71\.6/)
  assert.equal(testState.mapStops.length, 0)
  assert.match(html, /Consultar de nuevo/)
})

test('la coincidencia exacta aceptada entra al mapa y una respuesta obsoleta no se aplica', async () => {
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards: [card(1)], profitabilityByNv: {} })
  const { stops, unresolved } = buildDeliveryStops(evaluation.deliveries)
  const location = { coordinates: [-71.6, -35.4], verification: 'COORDINATE_VERIFIED', source: 'fixture', classification: 'RECOGNIZED', physicalAccessVerified: false }
  let response = { ok: true, results: [{ stopId: stops[0].id, cardIds: ['card-1'], cacheStatus: 'CACHE_MISS', status: 'RECOGNIZED', providerClassification: 'EXACT', error: null, candidates: [], recognizedLocation: location }] }
  const testState = { scenario: scenarioUtils.createRouteScenario(stops), lookup: async () => response }
  const components = await loadDialogComponents(testState)
  const props = { stops, unresolved, routeWarningsByCardId: {}, locationsByStopId: {} }
  const render = () => renderToStaticMarkup(createElement(components.ScenarioWorkspace, props))
  render()
  testState.onLookup()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(render(), /Exacta · acceso físico no confirmado/)
  assert.equal(testState.mapStops.length, 1)
  response = { ...response, results: [{ ...response.results[0], stopId: 'otra-parada' }] }
  testState.onLookup()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(render(), /La parada cambió/)
})

test('previsualizar un candidato de parada ambigua centra el mapa con marcador provisional sin modificar paradas ni persistir', async () => {
  const evaluation = adaptFilteredPreparationCards({ companyId: 'company', filteredCards: [card(1)], profitabilityByNv: {} })
  const { stops, unresolved } = buildDeliveryStops(evaluation.deliveries)
  const candidate = {
    coordinates: [-72.0848, -36.6155],
    communeMatches: true,
    matchedAddress: 'Av Los Puelches 1440, Chillán',
    street: 'Av Los Puelches',
    housenumber: '1440',
    locality: 'Chillán',
    accuracy: 'point',
    confidence: 0.85,
  }
  const response = {
    ok: true,
    results: [{
      stopId: stops[0].id,
      cardIds: ['card-1'],
      cacheStatus: 'CACHE_MISS',
      status: 'AMBIGUOUS',
      providerClassification: 'AMBIGUOUS',
      error: null,
      candidates: [candidate],
      recognizedLocation: null,
    }],
  }
  const testState = { scenario: scenarioUtils.createRouteScenario(stops), lookup: async () => response }
  const components = await loadDialogComponents(testState)
  const props = { stops, unresolved, routeWarningsByCardId: {}, locationsByStopId: {} }
  const render = () => renderToStaticMarkup(createElement(components.ScenarioWorkspace, props))

  render()
  testState.onLookup()
  await new Promise(resolve => setImmediate(resolve))

  const html = render()
  assert.match(html, /Ambigua · requiere revisión/)
  assert.match(html, /Previsualizar en mapa/)
  assert.match(html, /Dirección devuelta:.*Av Los Puelches 1440, Chillán/)
  assert.match(html, /Calle y número:.*Av Los Puelches 1440/)
  assert.match(html, /Comuna:.*Chillán/)
  assert.match(html, /Precisión:.*point/)
  assert.match(html, /Confianza:.*85%/)
  assert.match(html, /Marcador provisional · No confirma acceso vehicular, no modifica la NV ni persiste coordenadas/)
  assert.equal(testState.previewCandidate, null)
  assert.equal(testState.mapStops.length, 0)

  // Seleccionar candidato para previsualización
  testState.onPreview()
  const previewHtml = render()
  assert.match(previewHtml, /Previsualizando en mapa/)
  assert.match(previewHtml, /Previsualizando:.*Parada 1 · Candidata 1 \(provisional\)/)
  assert.deepEqual(testState.mapPreview.coordinates, [-72.0848, -36.6155])
  assert.equal(testState.mapPreview.label, 'Parada 1 · Candidata 1 (provisional)')
  assert.equal(testState.mapPreview.address, 'Av Los Puelches 1440, Chillán')
  // Confirmed map stops remains 0 (does not promote candidate to confirmed stop)
  assert.equal(testState.mapStops.length, 0)

  // Deseleccionar vuelve a limpiar la previsualización
  testState.onPreview()
  render()
  assert.equal(testState.mapPreview, null)
  assert.equal(testState.previewCandidate, null)
})
