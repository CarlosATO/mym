import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return nextResolve(`${specifier}.ts`, context)
  }
} })

const { MYM_WAREHOUSE_ORIGIN, VROOM_UNITS, createVroomRoundTripVehicle, validateVroomRoundTripVehicle } = await import('./warehouse-origin.ts')

test('origen conserva coordenadas, procedencia y acceso vehicular no confirmado', () => {
  assert.equal(MYM_WAREHOUSE_ORIGIN.name, 'Bodega operativa MYM — Fundo El Trapiche')
  assert.match(MYM_WAREHOUSE_ORIGIN.address, /Ruta 5 Sur.*Parcela 15.*500 metros/)
  assert.equal(MYM_WAREHOUSE_ORIGIN.latitude, -35.5182400)
  assert.equal(MYM_WAREHOUSE_ORIGIN.longitude, -71.6741499)
  assert.equal(MYM_WAREHOUSE_ORIGIN.source, 'USER_GOOGLE_MAPS_DESTINATION')
  assert.equal(MYM_WAREHOUSE_ORIGIN.vehicleAccess, 'NOT_PHYSICALLY_CONFIRMED')
  assert.equal(MYM_WAREHOUSE_ORIGIN.returnToOrigin, true)
  assert.deepEqual(VROOM_UNITS, { coordinates: 'decimal_degrees', distance: 'meters', duration: 'seconds' })
})

test('vehículo VROOM siempre inicia y vuelve a la bodega en orden longitud, latitud', () => {
  const vehicle = createVroomRoundTripVehicle(1)
  assert.deepEqual(vehicle, { id: 1, start: [-71.6741499, -35.5182400], end: [-71.6741499, -35.5182400] })
  assert.doesNotThrow(() => validateVroomRoundTripVehicle(vehicle))
  assert.equal(Object.isFrozen(vehicle), true)
  assert.equal(Object.isFrozen(vehicle.end), true)
  assert.throws(() => { vehicle.end[0] = 0 }, TypeError)
})

test('rechaza retorno ausente, diferente, coordenadas intercambiadas o inválidas', () => {
  const vehicle = createVroomRoundTripVehicle(2)
  assert.throws(() => validateVroomRoundTripVehicle({ id: 2, start: vehicle.start }), /retorno requieren/i)
  assert.throws(() => validateVroomRoundTripVehicle({ ...vehicle, end: [-71, -35] }), /deben coincidir/)
  assert.throws(() => validateVroomRoundTripVehicle({ ...vehicle, start: [-35.51824, -71.6741499], end: [-35.51824, -71.6741499] }), /deben coincidir/)
  for (const coordinate of [[181, 0], [0, -91], [NaN, 0], [0, Infinity], ['-71', -35], [0], null]) {
    assert.throws(() => validateVroomRoundTripVehicle({ ...vehicle, end: coordinate }), /coordenadas válidas/)
  }
  assert.throws(() => createVroomRoundTripVehicle(-1), /Identificador/)
})

test('origen rechaza unidades, coordenadas y política de retorno inválidas', () => {
  assert.throws(() => createVroomRoundTripVehicle(1, { ...MYM_WAREHOUSE_ORIGIN, coordinateUnit: 'radians' }), /grados decimales/)
  assert.throws(() => createVroomRoundTripVehicle(1, { ...MYM_WAREHOUSE_ORIGIN, latitude: 91 }), /Coordenadas/)
  assert.throws(() => createVroomRoundTripVehicle(1, { ...MYM_WAREHOUSE_ORIGIN, longitude: 'invalid' }), /Coordenadas/)
  assert.throws(() => createVroomRoundTripVehicle(1, { ...MYM_WAREHOUSE_ORIGIN, returnToOrigin: false }), /retorno.*obligatorio/i)
  const withoutReturn = { ...MYM_WAREHOUSE_ORIGIN }
  delete withoutReturn.returnToOrigin
  assert.throws(() => createVroomRoundTripVehicle(1, withoutReturn), /retorno.*obligatorio/i)
})
