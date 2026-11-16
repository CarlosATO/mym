import { isVroomLocation, type VroomPoint } from './vroom-adapter'

export type WarehouseOrigin = Readonly<{
  name: string
  address: string
  latitude: number
  longitude: number
  coordinateUnit: 'decimal_degrees'
  source: 'USER_GOOGLE_MAPS_DESTINATION'
  vehicleAccess: 'NOT_PHYSICALLY_CONFIRMED'
  returnToOrigin: true
}>

/** Punto entregado por el usuario, no una ubicación de acceso verificada. */
export const MYM_WAREHOUSE_ORIGIN: WarehouseOrigin = Object.freeze({
  name: 'Bodega operativa MYM — Fundo El Trapiche',
  address: 'Ruta 5 Sur, Fundo El Trapiche, Parcela 15, aproximadamente 500 metros desde la pasarela.',
  latitude: -35.5182400,
  longitude: -71.6741499,
  coordinateUnit: 'decimal_degrees',
  source: 'USER_GOOGLE_MAPS_DESTINATION',
  vehicleAccess: 'NOT_PHYSICALLY_CONFIRMED',
  returnToOrigin: true,
})

/** Las coordenadas van en grados, las distancias en metros y los tiempos en segundos. */
export const VROOM_UNITS = Object.freeze({ coordinates: 'decimal_degrees', distance: 'meters', duration: 'seconds' } as const)

export type VroomRoundTripVehicle = Readonly<{
  id: number
  start: VroomPoint['location']
  end: VroomPoint['location']
}>

function originLocation(origin: WarehouseOrigin): VroomPoint['location'] {
  if (!origin || origin.coordinateUnit !== VROOM_UNITS.coordinates) throw new Error('Unidad de coordenadas inválida; se requieren grados decimales')
  if (origin.returnToOrigin !== true) throw new Error('El retorno a la bodega es obligatorio')
  const location: VroomPoint['location'] = [origin.longitude, origin.latitude]
  if (!isVroomLocation(location)) throw new Error('Coordenadas de bodega inválidas')
  return location
}

/** Verifica también que el regreso corresponda a la bodega indicada. */
export function validateVroomRoundTripVehicle(vehicle: unknown, origin: WarehouseOrigin = MYM_WAREHOUSE_ORIGIN): asserts vehicle is VroomRoundTripVehicle {
  const expected = originLocation(origin)
  if (!vehicle || typeof vehicle !== 'object') throw new Error('Vehículo VROOM inválido')
  const candidate = vehicle as Record<string, unknown>
  if (typeof candidate.id !== 'number' || !Number.isSafeInteger(candidate.id) || candidate.id < 0) throw new Error('Identificador de vehículo inválido')
  if (!isVroomLocation(candidate.start) || !isVroomLocation(candidate.end)) throw new Error('Origen y retorno requieren coordenadas válidas')
  if (candidate.start[0] !== expected[0] || candidate.start[1] !== expected[1] || candidate.end[0] !== expected[0] || candidate.end[1] !== expected[1]) {
    throw new Error('El origen y el retorno deben coincidir con la bodega')
  }
}

/** Construye únicamente el contrato de vehículo; no realiza solicitudes. */
export function createVroomRoundTripVehicle(id: number, origin: WarehouseOrigin = MYM_WAREHOUSE_ORIGIN): VroomRoundTripVehicle {
  const [longitude, latitude] = originLocation(origin)
  const vehicle = Object.freeze({
    id,
    start: Object.freeze([longitude, latitude] as const),
    end: Object.freeze([longitude, latitude] as const),
  })
  validateVroomRoundTripVehicle(vehicle, origin)
  return vehicle
}
