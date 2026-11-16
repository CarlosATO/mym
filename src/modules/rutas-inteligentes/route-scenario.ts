import type { PotentialStop } from './delivery-stops'
import { createVroomRoundTripVehicle, type VroomRoundTripVehicle } from './warehouse-origin'
import { isVroomLocation, type VroomPoint } from './vroom-adapter'

/** Coordenadas explícitamente verificadas por una fuente futura, no estimadas. */
export type VerifiedStopLocation = {
  coordinates: VroomPoint['location']
  verification: 'COORDINATE_VERIFIED'
  source: string
}
export type RouteScenario = {
  vehicle: VroomRoundTripVehicle
  stopIds: ReadonlySet<string>
  selectedIds: ReadonlySet<string>
  excludedIds: ReadonlySet<string>
  /** Solo cambia cuando cambia el conjunto incluido, para un recálculo futuro. */
  revision: number
}
export type ScenarioAction =
  | { type: 'TOGGLE_SELECTION'; stopId: string }
  | { type: 'SELECT_ALL' }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'EXCLUDE_SELECTED' }
  | { type: 'INCLUDE_SELECTED' }
  | { type: 'RESTORE' }

export type ScenarioMapStop = {
  id: string
  label: string
  coordinates: VroomPoint['location']
  selected: boolean
  excluded: boolean
}

export function getVerifiedStopLocation(value: VerifiedStopLocation | undefined): VroomPoint['location'] | null {
  if (!value || value.verification !== 'COORDINATE_VERIFIED' || typeof value.source !== 'string' || !value.source.trim() || !isVroomLocation(value.coordinates)) return null
  return value.coordinates
}

export function getScenarioMapStops(stops: readonly Pick<PotentialStop, 'id'>[], locations: Readonly<Record<string, VerifiedStopLocation | undefined>>, scenario: RouteScenario): ScenarioMapStop[] {
  return stops.flatMap((stop, index) => {
    const coordinates = getVerifiedStopLocation(locations[stop.id])
    if (!scenario.stopIds.has(stop.id) || !coordinates) return []
    return [{ id: stop.id, label: String(index + 1), coordinates, selected: scenario.selectedIds.has(stop.id), excluded: scenario.excludedIds.has(stop.id) }]
  })
}

export function createRouteScenario(stops: readonly Pick<PotentialStop, 'id'>[]): RouteScenario {
  const ids = stops.map(stop => stop.id)
  if (ids.some(id => typeof id !== 'string' || !id.startsWith('stop:')) || new Set(ids).size !== ids.length) throw new Error('Identificadores de paradas inválidos o duplicados')
  return { vehicle: createVroomRoundTripVehicle(0), stopIds: new Set(ids), selectedIds: new Set(), excludedIds: new Set(), revision: 0 }
}

export function updateRouteScenario(state: RouteScenario, action: ScenarioAction): RouteScenario {
  if (action.type === 'TOGGLE_SELECTION') {
    if (!state.stopIds.has(action.stopId)) return state
    const selectedIds = new Set(state.selectedIds)
    if (selectedIds.has(action.stopId)) selectedIds.delete(action.stopId)
    else selectedIds.add(action.stopId)
    return { ...state, selectedIds }
  }
  if (action.type === 'SELECT_ALL') return { ...state, selectedIds: new Set(state.stopIds) }
  if (action.type === 'CLEAR_SELECTION') return { ...state, selectedIds: new Set() }
  if (action.type === 'RESTORE') {
    return { ...state, selectedIds: new Set(), excludedIds: new Set(), revision: state.revision + (state.excludedIds.size ? 1 : 0) }
  }
  const excludedIds = new Set(state.excludedIds)
  let changed = false
  for (const id of state.selectedIds) {
    if (!state.stopIds.has(id)) continue
    if (action.type === 'EXCLUDE_SELECTED' && !excludedIds.has(id)) { excludedIds.add(id); changed = true }
    if (action.type === 'INCLUDE_SELECTED' && excludedIds.has(id)) { excludedIds.delete(id); changed = true }
  }
  return { ...state, excludedIds, selectedIds: new Set(), revision: state.revision + (changed ? 1 : 0) }
}
