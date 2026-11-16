import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptVroomResponse, presentVroomLeg } from './vroom-adapter.ts'

const bindings = [
  { type: 'job', id: 1, stopId: 'curico', geocoding: 'STREET_AND_NUMBER_MATCH' },
  { type: 'job', id: 2, stopId: 'hospital', geocoding: 'CANDIDATE_PENDING' },
]

// Reconstrucción a partir de los valores redondeados comunicados; las
// coordenadas son ilustrativas, no una copia del JSON original de VROOM.
function example() {
  return { code: 0, unassigned: [], routes: [{ vehicle: 1, steps: [
    { type: 'start', location: [-71.66, -35.43], distance: 0, duration: 0, service: 0, setup: 0, waiting_time: 0 },
    { type: 'job', id: 1, location: [-71.24, -34.98], distance: 66200, duration: 2640, service: 1200, setup: 0, waiting_time: 0 },
    { type: 'job', id: 2, location: [-71.65, -35.44], distance: 130100, duration: 5040, service: 1200, setup: 0, waiting_time: 0 },
    { type: 'end', location: [-71.66, -35.43], distance: 132300, duration: 5220, service: 0, setup: 0, waiting_time: 0 },
  ] }] }
}

test('trayecto Talca–Curicó–Hospital–Talca: diferencias en unidades originales y servicio independiente', () => {
  const result = adaptVroomResponse(example(), bindings)
  assert.equal(result.status, 'READY')
  const legs = result.routes[0].legs
  assert.deepEqual(legs.map(x => x.distanceMeters), [66200, 63900, 2200])
  assert.deepEqual(legs.map(x => x.drivingSeconds), [2640, 2400, 180])
  assert.deepEqual(legs.map(x => x.cumulativeDrivingSeconds), [2640, 5040, 5220])
  assert.deepEqual(legs.map(x => x.cumulativeServiceSeconds), [1200, 2400, 2400])
  assert.equal(presentVroomLeg(legs[2]).cumulativeDrivingMinutes, 87)
  assert.equal(presentVroomLeg(legs[2]).cumulativeServiceMinutes, 40)
  assert.equal(presentVroomLeg(legs[1]).distanceKm, 63.9)
  assert.equal(legs[0].to.stopId, 'curico')
  assert.equal(legs[1].to.geocoding, 'CANDIDATE_PENDING')
})

test('regresión HeiGIT/VROOM: conducción y atención sin duplicar servicios en arrival', () => {
  // Los valores numéricos son los informados por el proveedor; las coordenadas
  // son ilustrativas porque no se incluyeron en los datos proporcionados.
  const input = {
    code: 0,
    summary: { distance: 132288, duration: 5240, service: 2400 },
    unassigned: [],
    routes: [{ vehicle: 1, steps: [
      { type: 'start', location: [-71.66, -35.43], distance: 0, duration: 0, service: 0, arrival: 0, setup: 0, waiting_time: 0 },
      { type: 'job', id: 2, location: [-71.24, -34.98], distance: 66237, duration: 2650, service: 1200, arrival: 2650, setup: 0, waiting_time: 0 },
      { type: 'job', id: 1, location: [-71.65, -35.44], distance: 130140, duration: 5040, service: 1200, arrival: 6240, setup: 0, waiting_time: 0 },
      { type: 'end', location: [-71.66, -35.43], distance: 132288, duration: 5240, service: 0, arrival: 7640, setup: 0, waiting_time: 0 },
    ] }],
  }
  const result = adaptVroomResponse(input, bindings)
  assert.equal(result.status, 'READY')
  assert.deepEqual(result.unassigned, [])
  assert.equal(result.routes.length, 1)
  const route = result.routes[0]
  assert.equal(route.vehicleId, 1)
  const legs = route.legs
  assert.deepEqual(legs.map(leg => leg.distanceMeters), [66237, 63903, 2148])
  assert.deepEqual(legs.map(leg => leg.cumulativeDistanceMeters), [66237, 130140, 132288])
  assert.deepEqual(legs.map(leg => leg.drivingSeconds), [2650, 2390, 200])
  assert.deepEqual(legs.map(leg => leg.cumulativeDrivingSeconds), [2650, 5040, 5240])
  assert.deepEqual(legs.slice(0, 2).map(leg => leg.to.id), [2, 1])
  assert.deepEqual(legs.map(leg => leg.serviceSecondsAtDestination), [1200, 1200, 0])
  assert.deepEqual(legs.map(leg => leg.cumulativeServiceSeconds), [1200, 2400, 2400])
  assert.equal(legs[2].cumulativeDistanceMeters, input.summary.distance)
  assert.equal(legs[2].cumulativeDrivingSeconds, input.summary.duration)
  assert.equal(legs[2].cumulativeServiceSeconds, input.summary.service)
  assert.equal(legs[2].cumulativeDrivingSeconds + legs[2].cumulativeServiceSeconds, 7640)
  // En este caso sin espera ni setup, arrival incluye solo servicios previos.
  assert.deepEqual(legs.map(leg => leg.cumulativeDrivingSeconds + leg.cumulativeServiceSeconds - leg.serviceSecondsAtDestination), input.routes[0].steps.slice(1).map(step => step.arrival))
  assert.equal(input.routes[0].steps[0].arrival, 0)
})

test('separa servicio, preparación y espera incluso con servicio en el primer paso', () => {
  const input = example()
  input.routes[0].steps[0].service = 30
  input.routes[0].steps[1].setup = 15
  input.routes[0].steps[1].waiting_time = 45
  const route = adaptVroomResponse(input, bindings).routes[0]
  assert.equal(route.initialServiceSeconds, 30)
  assert.equal(route.legs[0].cumulativeServiceSeconds, 1230)
  assert.equal(route.legs[0].drivingSeconds, 2640)
  assert.equal(route.legs[0].setupSecondsAtDestination, 15)
  assert.equal(route.legs[0].waitingSecondsAtDestination, 45)
})

test('paradas no asignadas se identifican sin perder clasificación de geocodificación', () => {
  const input = example()
  input.routes[0].steps.splice(2, 1)
  input.unassigned.push({ type: 'job', id: 2 })
  const result = adaptVroomResponse(input, bindings)
  assert.equal(result.status, 'UNASSIGNED')
  assert.deepEqual(result.unassigned, [{ ...bindings[1] }])
  assert.equal(result.routes[0].legs.length, 2)
})

test('distancia ausente, pasos ausentes o tarea omitida producen estado incompleto sin tramos', () => {
  const missingDistance = example()
  delete missingDistance.routes[0].steps[1].distance
  const result = adaptVroomResponse(missingDistance, bindings)
  assert.equal(result.status, 'INCOMPLETE')
  assert.deepEqual(result.routes, [])
  assert.ok(result.issues.some(i => i.code === 'INCOMPLETE_RESPONSE' && i.path.endsWith('.distance')))
  assert.equal(adaptVroomResponse({ code: 0, routes: [], unassigned: [] }, []).status, 'INCOMPLETE')
  const missingTask = example()
  missingTask.routes[0].steps.splice(2, 1)
  assert.ok(adaptVroomResponse(missingTask, bindings).issues.some(i => i.code === 'MISSING_TASK'))
})

test('rechaza coordenadas inválidas, métricas negativas y acumulados decrecientes', () => {
  for (const [modify, code] of [
    [step => { step.location = [181, -35] }, 'INVALID_COORDINATES'],
    [step => { step.distance = -1 }, 'NEGATIVE_VALUE'],
    [step => { step.distance = 1 }, 'DECREASING_ACCUMULATIVE'],
    [step => { step.duration = 1 }, 'DECREASING_ACCUMULATIVE'],
    [step => { step.service = -1 }, 'NEGATIVE_VALUE'],
  ]) {
    const input = example()
    modify(input.routes[0].steps[2])
    const result = adaptVroomResponse(input, bindings)
    assert.equal(result.status, 'INVALID')
    assert.ok(result.issues.some(issue => issue.code === code))
    assert.deepEqual(result.routes, [])
  }
})

test('rechaza identidades duplicadas y errores del proveedor', () => {
  const input = example()
  input.routes[0].steps[2].id = 1
  assert.ok(adaptVroomResponse(input, bindings).issues.some(i => i.code === 'DUPLICATE_IDENTIFIER'))
  assert.ok(adaptVroomResponse(example(), [bindings[0], bindings[0]]).issues.some(i => i.code === 'DUPLICATE_IDENTIFIER'))
  assert.equal(adaptVroomResponse({ code: 3, error: 'routing error' }, []).status, 'INVALID')
  const unknown = example()
  unknown.routes[0].steps[1].id = 99
  assert.ok(adaptVroomResponse(unknown, bindings).issues.some(i => i.code === 'UNKNOWN_TASK'))
})

test('una clasificación de revisión se transporta sin afirmar verificación física', () => {
  const updated = [{ ...bindings[0], geocoding: 'REVIEW_REQUIRED' }, bindings[1]]
  const destination = adaptVroomResponse(example(), updated).routes[0].legs[0].to
  assert.equal(destination.geocoding, 'REVIEW_REQUIRED')
  assert.equal('physicallyVerified' in destination, false)
})

test('admite vehículos múltiples y la solución sin rutas si todas las tareas están no asignadas', () => {
  const input = example()
  const [start, first, second, end] = input.routes[0].steps
  input.routes = [
    { vehicle: 1, steps: [start, first] },
    { vehicle: 2, steps: [{ ...start }, { ...second, distance: 100, duration: 10 }, { ...end, distance: 200, duration: 20 }] },
  ]
  const result = adaptVroomResponse(input, bindings)
  assert.equal(result.status, 'READY')
  assert.deepEqual(result.routes.map(r => r.vehicleId), [1, 2])
  assert.equal(result.routes[1].legs[1].distanceMeters, 100)
  const unassigned = adaptVroomResponse({ code: 0, routes: [], unassigned: bindings.map(({ type, id }) => ({ type, id })) }, bindings)
  assert.equal(unassigned.status, 'UNASSIGNED')
  assert.equal(unassigned.unassigned.length, 2)
  input.routes[1].vehicle = 1
  assert.ok(adaptVroomResponse(input, bindings).issues.some(i => i.code === 'DUPLICATE_IDENTIFIER'))
})
