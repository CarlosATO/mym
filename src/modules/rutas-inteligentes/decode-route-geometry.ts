import { isVroomLocation } from './vroom-adapter'

/** VROOM/OSRM polyline, precisión 1e-5, convertido a [longitud, latitud]. */
export function decodeRouteGeometry(encoded: string): Array<[number, number]> {
  const result: Array<[number, number]> = []
  let index = 0, latitude = 0, longitude = 0
  function readDelta(): number {
    let value = 0, shift = 0
    while (index < encoded.length && shift <= 30) {
      const chunk = encoded.charCodeAt(index++) - 63
      if (chunk < 0 || chunk > 63) throw new Error('Geometría inválida')
      value |= (chunk & 31) << shift
      if (chunk < 32) return value & 1 ? ~(value >> 1) : value >> 1
      shift += 5
    }
    throw new Error('Geometría incompleta')
  }
  while (index < encoded.length) {
    latitude += readDelta()
    longitude += readDelta()
    const point: [number, number] = [longitude / 1e5, latitude / 1e5]
    if (!isVroomLocation(point)) throw new Error('Coordenadas inválidas')
    result.push(point)
  }
  if (result.length < 2) throw new Error('Geometría incompleta')
  return result
}
