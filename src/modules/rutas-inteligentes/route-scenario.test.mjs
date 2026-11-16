import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return nextResolve(`${specifier}.ts`, context)
  }
} })

const { createRouteScenario, updateRouteScenario, getVerifiedStopLocation, getScenarioMapStops } = await import('./route-scenario.ts')
const { loadMapLibre } = await import('./maplibre-loader.ts')
const stops = [{ id: 'stop:a' }, { id: 'stop:b' }, { id: 'stop:c' }]
const apply = (state, ...actions) => actions.reduce(updateRouteScenario, state)

test('el cargador resuelve las clases de MapLibre sin acceder a la red', async () => {
  const library = await loadMapLibre()
  assert.equal(typeof library.Map, 'function')
  assert.equal(typeof library.Marker, 'function')
  assert.equal(typeof library.LngLatBounds, 'function')
})

test('selección múltiple, exclusión y reincorporación conservan bodega y escenario original', () => {
  const initial = createRouteScenario(stops)
  const selected = apply(initial, { type: 'TOGGLE_SELECTION', stopId: 'stop:a' }, { type: 'TOGGLE_SELECTION', stopId: 'stop:b' })
  assert.deepEqual([...selected.selectedIds], ['stop:a', 'stop:b'])
  assert.equal(selected.revision, 0)
  const excluded = apply(selected, { type: 'EXCLUDE_SELECTED' })
  assert.deepEqual([...excluded.excludedIds], ['stop:a', 'stop:b'])
  assert.equal(excluded.revision, 1)
  assert.equal(excluded.selectedIds.size, 0)
  assert.equal(initial.excludedIds.size, 0)
  assert.deepEqual(excluded.vehicle.start, [-71.6741499, -35.51824])
  assert.deepEqual(excluded.vehicle.end, excluded.vehicle.start)
  const included = apply(excluded, { type: 'TOGGLE_SELECTION', stopId: 'stop:a' }, { type: 'INCLUDE_SELECTED' })
  assert.deepEqual([...included.excludedIds], ['stop:b'])
  assert.equal(included.revision, 2)
  const restored = apply(included, { type: 'RESTORE' })
  assert.equal(restored.excludedIds.size, 0)
  assert.equal(restored.selectedIds.size, 0)
  assert.equal(restored.revision, 3)
  assert.deepEqual(restored.vehicle, initial.vehicle)
})

test('seleccionar todas, limpiar y restaurar no omiten el origen ni recalculan al seleccionar', () => {
  const initial = createRouteScenario(stops)
  const selected = updateRouteScenario(initial, { type: 'SELECT_ALL' })
  assert.equal(selected.selectedIds.size, 3)
  assert.equal(updateRouteScenario(selected, { type: 'CLEAR_SELECTION' }).revision, 0)
  const excluded = updateRouteScenario(selected, { type: 'EXCLUDE_SELECTED' })
  assert.equal(excluded.excludedIds.size, 3)
  const restored = updateRouteScenario(excluded, { type: 'RESTORE' })
  assert.equal(restored.excludedIds.size, 0)
  assert.equal(updateRouteScenario(restored, { type: 'RESTORE' }).revision, restored.revision)
  assert.deepEqual(restored.vehicle.end, restored.vehicle.start)
})

test('la bodega y los identificadores ajenos no pueden seleccionarse ni excluirse', () => {
  const initial = createRouteScenario(stops)
  assert.equal(updateRouteScenario(initial, { type: 'TOGGLE_SELECTION', stopId: 'warehouse' }), initial)
  assert.throws(() => createRouteScenario([{ id: 'warehouse' }]), /inválidos/)
  assert.throws(() => createRouteScenario([{ id: 'stop:a' }, { id: 'stop:a' }]), /duplicados/)
  const hostile = { ...initial, selectedIds: new Set(['warehouse', 'stop:a']) }
  const result = updateRouteScenario(hostile, { type: 'EXCLUDE_SELECTED' })
  assert.deepEqual([...result.excludedIds], ['stop:a'])
  assert.deepEqual(result.vehicle.end, result.vehicle.start)
})

test('solo coordenadas verificadas y válidas pueden representarse en el mapa', () => {
  assert.deepEqual(getVerifiedStopLocation({ coordinates: [-71.2, -35.4], verification: 'COORDINATE_VERIFIED', source: 'confirmación' }), [-71.2, -35.4])
  assert.equal(getVerifiedStopLocation(undefined), null)
  assert.equal(getVerifiedStopLocation({ coordinates: [181, 0], verification: 'COORDINATE_VERIFIED', source: 'confirmación' }), null)
  assert.equal(getVerifiedStopLocation({ coordinates: [-71, -35], verification: 'CANDIDATE_PENDING', source: 'pelias' }), null)
  assert.equal(getVerifiedStopLocation({ coordinates: [-71, -35], verification: 'COORDINATE_VERIFIED', source: ' ' }), null)
})

test('los marcadores reflejan la selección y exclusión del mismo escenario', () => {
  const locations = {
    'stop:a': { coordinates: [-71.2, -35.4], verification: 'COORDINATE_VERIFIED', source: 'confirmación' },
    'stop:b': { coordinates: [-71.3, -35.5], verification: 'CANDIDATE_PENDING', source: 'pelias' },
  }
  const initial = createRouteScenario(stops)
  const selected = updateRouteScenario(initial, { type: 'TOGGLE_SELECTION', stopId: 'stop:a' })
  assert.deepEqual(getScenarioMapStops(stops, locations, selected), [{ id: 'stop:a', label: '1', coordinates: [-71.2, -35.4], selected: true, excluded: false }])
  const excluded = updateRouteScenario(selected, { type: 'EXCLUDE_SELECTED' })
  assert.equal(excluded.excludedIds.has('stop:a'), true)
  assert.deepEqual(getScenarioMapStops(stops, locations, excluded), [{ id: 'stop:a', label: '1', coordinates: [-71.2, -35.4], selected: false, excluded: true }])
  const restored = updateRouteScenario(excluded, { type: 'RESTORE' })
  assert.equal(getScenarioMapStops(stops, locations, restored)[0].excluded, false)
})
