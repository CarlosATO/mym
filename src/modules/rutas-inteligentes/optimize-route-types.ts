export type OptimizedStop = {
  stopId: string | null
  cardIds: string[]
  locationStatus: string
  coordinates: readonly [number, number] | null
  diagnostic: {
    authorized: true
    heigit: 'RESPONDED' | 'NOT_QUERIED' | 'UNKNOWN'
    classification: string | null
    accepted: boolean
    reason: string
    sentToVroom: boolean
  }
}

export type OptimizeRouteResult =
  | { ok: false; code: string; message: string }
  | {
      ok: true
      complete: boolean
      stops: OptimizedStop[]
      pending: OptimizedStop[]
      unassigned: OptimizedStop[]
      route: null | {
        encodedGeometry: string
        geometryEncoding: 'polyline'
        distanceMeters: number
        travelSeconds: number
        orderedStops: Array<OptimizedStop & { sequence: number }>
      }
    }
