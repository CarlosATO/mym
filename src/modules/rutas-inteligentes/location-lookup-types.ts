import type { GeocodeCacheStatus, ProviderClassification, GeocodeCandidate } from './geocode-cache.server'
import type { GeocodingStatus, ProposedMapLocation } from './geocoding-contract'

/** La caché no conserva evidencia de coincidencia de comuna. */
export type LocationCandidateDetail = Omit<GeocodeCandidate, 'communeMatches'> & { communeMatches: boolean | null }

export type LocationLookupItem = {
  stopId: string | null
  cardIds: string[]
  cacheStatus: GeocodeCacheStatus
  status: GeocodingStatus | null
  providerClassification: ProviderClassification | null
  error: string | null
  candidates: LocationCandidateDetail[]
  recognizedLocation: ProposedMapLocation | null
}

export type LocationLookupResponse = { ok: true; results: LocationLookupItem[] } | { ok: false; error: string }
