import type { PotentialStop } from './delivery-stops'

/** Clasificación textual; ninguna de estas categorías verifica físicamente la entrega. */
export type GeocodingClassification = 'STREET_AND_NUMBER_MATCH' | 'CANDIDATE_PENDING' | 'REVIEW_REQUIRED'
export type VroomTaskType = 'job' | 'pickup' | 'delivery'
export type VroomBinding = {
  type: VroomTaskType
  id: number
  stopId: PotentialStop['id']
  geocoding: GeocodingClassification
}

export type VroomIssueCode =
  | 'PROVIDER_ERROR' | 'INCOMPLETE_RESPONSE' | 'INVALID_VALUE' | 'INVALID_COORDINATES'
  | 'NEGATIVE_VALUE' | 'DECREASING_ACCUMULATIVE' | 'DUPLICATE_IDENTIFIER'
  | 'UNKNOWN_TASK' | 'MISSING_TASK' | 'UNASSIGNED_TASK'
export type VroomIssue = { code: VroomIssueCode; path: string }
export type VroomPoint = {
  type: 'start' | VroomTaskType | 'break' | 'end'
  id: number | null
  /** Orden original VROOM: longitud, latitud. */
  location: readonly [number, number]
  stopId: string | null
  geocoding: GeocodingClassification | null
}

/** Coordenadas VROOM en grados decimales, en orden [longitud, latitud]. */
export function isVroomLocation(value: unknown): value is VroomPoint['location'] {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'number' && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
    && typeof value[1] === 'number' && Number.isFinite(value[1]) && Math.abs(value[1]) <= 90
}
export type VroomLeg = {
  from: VroomPoint
  to: VroomPoint
  distanceMeters: number
  cumulativeDistanceMeters: number
  drivingSeconds: number
  cumulativeDrivingSeconds: number
  serviceSecondsAtDestination: number
  cumulativeServiceSeconds: number
  setupSecondsAtDestination: number
  waitingSecondsAtDestination: number
}
export type VroomRoute = {
  vehicleId: number
  initialPoint: VroomPoint
  initialServiceSeconds: number
  initialSetupSeconds: number
  initialWaitingSeconds: number
  legs: VroomLeg[]
}
export type VroomAdaptation = {
  status: 'READY' | 'UNASSIGNED' | 'INCOMPLETE' | 'INVALID'
  issues: VroomIssue[]
  unassigned: Array<{ type: VroomTaskType; id: number; stopId: string; geocoding: GeocodingClassification }>
  routes: VroomRoute[]
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
const taskType = (value: unknown): value is VroomTaskType => value === 'job' || value === 'pickup' || value === 'delivery'
const identifier = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const taskKey = (type: VroomTaskType, id: number) => `${type}:${id}`

/**
 * VROOM: distancia acumulada en metros; duration es solo conducción acumulada
 * en segundos. service, setup y waiting_time son segundos en cada paso.
 * Si faltan o son inconsistentes los datos, no se devuelven tramos parciales.
 */
export function adaptVroomResponse(response: unknown, bindings: readonly VroomBinding[]): VroomAdaptation {
  const issues: VroomIssue[] = []
  const unassigned: VroomAdaptation['unassigned'] = []
  const routes: VroomRoute[] = []
  const issue = (code: VroomIssueCode, path: string) => issues.push({ code, path })
  const bindingMap = new Map<string, VroomBinding>()
  const stopIds = new Set<string>()
  const classifications = new Set<GeocodingClassification>(['STREET_AND_NUMBER_MATCH', 'CANDIDATE_PENDING', 'REVIEW_REQUIRED'])
  for (const [index, binding] of bindings.entries()) {
    if (!taskType(binding.type) || !identifier(binding.id) || typeof binding.stopId !== 'string' || !binding.stopId.trim() || !classifications.has(binding.geocoding)) {
      issue('INVALID_VALUE', `bindings[${index}]`)
      continue
    }
    const key = taskKey(binding.type, binding.id)
    if (bindingMap.has(key) || stopIds.has(binding.stopId)) issue('DUPLICATE_IDENTIFIER', `bindings[${index}]`)
    bindingMap.set(key, binding)
    stopIds.add(binding.stopId)
  }
  const root = record(response)
  if (!root || typeof root.code !== 'number') issue('INCOMPLETE_RESPONSE', 'code')
  else if (root.code !== 0) issue('PROVIDER_ERROR', 'code')
  if (!root || !Array.isArray(root.routes)) issue('INCOMPLETE_RESPONSE', 'routes')
  if (!root || !Array.isArray(root.unassigned)) issue('INCOMPLETE_RESPONSE', 'unassigned')
  const seenTasks = new Set<string>()
  const vehicles = new Set<number>()
  const resolveTask = (type: VroomTaskType, id: unknown, path: string): VroomBinding | null => {
    if (!identifier(id)) { issue('INVALID_VALUE', `${path}.id`); return null }
    const key = taskKey(type, id)
    if (seenTasks.has(key)) issue('DUPLICATE_IDENTIFIER', path)
    seenTasks.add(key)
    const binding = bindingMap.get(key)
    if (!binding) { issue('UNKNOWN_TASK', path); return null }
    return binding
  }
  if (Array.isArray(root?.unassigned)) root.unassigned.forEach((raw, index) => {
    const item = record(raw)
    const path = `unassigned[${index}]`
    if (!item || !taskType(item.type)) { issue('INVALID_VALUE', path); return }
    const binding = resolveTask(item.type, item.id, path)
    if (binding) {
      unassigned.push({ type: binding.type, id: binding.id, stopId: binding.stopId, geocoding: binding.geocoding })
      issue('UNASSIGNED_TASK', path)
    }
  })
  const numeric = (value: unknown, path: string): number | null => {
    if (value == null) { issue('INCOMPLETE_RESPONSE', path); return null }
    if (typeof value !== 'number' || !Number.isFinite(value)) { issue('INVALID_VALUE', path); return null }
    if (value < 0) { issue('NEGATIVE_VALUE', path); return null }
    return value
  }
  if (Array.isArray(root?.routes)) root.routes.forEach((rawRoute, routeIndex) => {
    const route = record(rawRoute)
    const path = `routes[${routeIndex}]`
    if (!route || !identifier(route.vehicle)) { issue('INVALID_VALUE', `${path}.vehicle`); return }
    const vehicleId = route.vehicle
    if (vehicles.has(vehicleId)) issue('DUPLICATE_IDENTIFIER', `${path}.vehicle`)
    vehicles.add(vehicleId)
    if (!Array.isArray(route.steps) || route.steps.length === 0) { issue('INCOMPLETE_RESPONSE', `${path}.steps`); return }
    let previous: { point: VroomPoint; distance: number; duration: number } | null = null
    let cumulativeService = 0
    let initialPoint: VroomPoint | null = null
    let initialService = 0, initialSetup = 0, initialWaiting = 0
    const legs: VroomLeg[] = []
    const breaks = new Set<number>()
    route.steps.forEach((rawStep: unknown, stepIndex: number) => {
      const step = record(rawStep)
      const stepPath = `${path}.steps[${stepIndex}]`
      if (!step || !(step.type === 'start' || step.type === 'end' || step.type === 'break' || taskType(step.type))) { issue('INVALID_VALUE', `${stepPath}.type`); return }
      const binding = taskType(step.type) ? resolveTask(step.type, step.id, stepPath) : null
      if (step.type === 'break') {
        if (!identifier(step.id)) issue('INVALID_VALUE', `${stepPath}.id`)
        else {
          if (breaks.has(step.id)) issue('DUPLICATE_IDENTIFIER', `${stepPath}.id`)
          breaks.add(step.id)
        }
      }
      const location = step.location
      if (location == null) issue('INCOMPLETE_RESPONSE', `${stepPath}.location`)
      else if (!isVroomLocation(location)) issue('INVALID_COORDINATES', `${stepPath}.location`)
      const distance = numeric(step.distance, `${stepPath}.distance`)
      const duration = numeric(step.duration, `${stepPath}.duration`)
      const service = numeric(step.service, `${stepPath}.service`)
      const setup = numeric(step.setup, `${stepPath}.setup`)
      const waiting = numeric(step.waiting_time, `${stepPath}.waiting_time`)
      if (!isVroomLocation(location) || distance === null || duration === null || service === null || setup === null || waiting === null) return
      const point: VroomPoint = { type: step.type, id: identifier(step.id) ? step.id : null, location: [location[0], location[1]], stopId: binding?.stopId ?? null, geocoding: binding?.geocoding ?? null }
      cumulativeService += service
      if (stepIndex === 0) {
        if (distance !== 0 || duration !== 0) issue('INVALID_VALUE', stepPath)
        initialPoint = point
        initialService = service
        initialSetup = setup
        initialWaiting = waiting
      } else if (previous) {
        if (distance < previous.distance) issue('DECREASING_ACCUMULATIVE', `${stepPath}.distance`)
        if (duration < previous.duration) issue('DECREASING_ACCUMULATIVE', `${stepPath}.duration`)
        legs.push({ from: previous.point, to: point, distanceMeters: distance - previous.distance, cumulativeDistanceMeters: distance, drivingSeconds: duration - previous.duration, cumulativeDrivingSeconds: duration, serviceSecondsAtDestination: service, cumulativeServiceSeconds: cumulativeService, setupSecondsAtDestination: setup, waitingSecondsAtDestination: waiting })
      }
      previous = { point, distance, duration }
    })
    if (initialPoint) routes.push({ vehicleId, initialPoint, initialServiceSeconds: initialService, initialSetupSeconds: initialSetup, initialWaitingSeconds: initialWaiting, legs })
  })
  for (const key of bindingMap.keys()) if (!seenTasks.has(key)) issue('MISSING_TASK', `bindings.${key}`)
  if (Array.isArray(root?.routes) && root.routes.length === 0 && unassigned.length === 0) issue('INCOMPLETE_RESPONSE', 'routes')
  const invalid = issues.some(item => !['INCOMPLETE_RESPONSE', 'MISSING_TASK', 'UNASSIGNED_TASK'].includes(item.code))
  const incomplete = issues.some(item => item.code === 'INCOMPLETE_RESPONSE' || item.code === 'MISSING_TASK')
  const status = invalid ? 'INVALID' : incomplete ? 'INCOMPLETE' : unassigned.length ? 'UNASSIGNED' : 'READY'
  return { status, issues, unassigned, routes: invalid || incomplete ? [] : routes }
}

/** Conversiones explícitas para presentación; el modelo conserva metros y segundos. */
export function presentVroomLeg(leg: VroomLeg) {
  return {
    distanceKm: leg.distanceMeters / 1000,
    cumulativeDistanceKm: leg.cumulativeDistanceMeters / 1000,
    drivingMinutes: leg.drivingSeconds / 60,
    cumulativeDrivingMinutes: leg.cumulativeDrivingSeconds / 60,
    serviceMinutesAtDestination: leg.serviceSecondsAtDestination / 60,
    cumulativeServiceMinutes: leg.cumulativeServiceSeconds / 60,
    setupMinutesAtDestination: leg.setupSecondsAtDestination / 60,
    waitingMinutesAtDestination: leg.waitingSecondsAtDestination / 60,
  }
}
