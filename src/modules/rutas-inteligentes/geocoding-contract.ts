import type { PotentialStop } from './delivery-stops'
import type { EvaluationDelivery } from './types'
import type { VerifiedStopLocation } from './route-scenario'
import { isVroomLocation, type VroomPoint } from './vroom-adapter'

export type GeocodingStatus = 'RECOGNIZED' | 'APPROXIMATE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'REVIEW_REQUIRED' | 'ERROR'

/** No registrar ni enviar estas claves a logs: contienen direcciones. */
export type GeographicCacheKey = Readonly<{
  companyId: string
  countryCode: 'CL'
  communeKey: string
  addressKey: string
}>

export type GeographicOriginal = Readonly<{
  source: EvaluationDelivery['source']
  address: string | null
  commune: string | null
  addressSource: EvaluationDelivery['destination']['addressSource']
  communeSource: EvaluationDelivery['destination']['communeSource']
}>

type PreparationBase = {
  stopId: PotentialStop['id']
  originals: GeographicOriginal[]
  /** El país se asigna solo con una declaración explícita del ámbito doméstico. */
  countrySource: 'MYM_DOMESTIC_POLICY' | null
}
export type PreparedGeocodingStop = PreparationBase & (
  | { status: 'READY'; cacheKey: GeographicCacheKey; streetKey: string; numberKey: string; reason: null }
  | { status: 'REVIEW_REQUIRED'; cacheKey: null; streetKey: null; numberKey: null; reason: 'COMPANY_REQUIRED' | 'DOMESTIC_SCOPE_REQUIRED' | 'MISSING_DELIVERY' | 'INCOMPLETE_DESTINATION' | 'INCONSISTENT_DESTINATIONS' | 'ADDRESS_NOT_SPECIFIC' | 'KEY_TOO_LONG' }
)

export type GeocodingCandidate = Readonly<{
  countryCode: string | null
  commune: string | null
  street: string | null
  number: string | null
  precision: 'ADDRESS' | 'APPROXIMATE' | 'UNKNOWN'
  coordinates: VroomPoint['location'] | null
}>

/** Forma normalizada simulada; no se asume que sea la respuesta nativa de un proveedor. */
export type SimulatedGeocodingResponse = Readonly<{
  stopId: string
  cacheKey: GeographicCacheKey
  provider: string
  outcome: 'CANDIDATES' | 'NOT_FOUND' | 'ERROR'
  candidates: readonly GeocodingCandidate[]
}>

export type ProposedMapLocation = VerifiedStopLocation & {
  classification: 'RECOGNIZED'
  physicalAccessVerified: false
}
export type GeocodingResult = {
  stopId: string
  status: GeocodingStatus
  location: ProposedMapLocation | null
}

/** Conserva acentos, signos y abreviaturas; no transforma objetos en texto. */
export function normalizeGeographicText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('es-CL') || null
}

/** Normaliza únicamente códigos explícitos de dos letras; no infiere el país. */
export function normalizeGeographicCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) ? code : null
}

/** Equivalencia acotada solo para comparar la abreviatura de avenida. */
function normalizeStreetForComparison(value: unknown): string | null {
  const text = normalizeGeographicText(value)
  return text?.replace(/^(?:av|avd|avda)\.?\s+/u, 'avenida ') ?? null
}

function parseSpecificAddress(addressKey: string, communeKey: string): { streetKey: string; numberKey: string } | 'INCONSISTENT_DESTINATIONS' | null {
  // La dirección completa se conserva en la clave y los originales.
  const parts = addressKey.split(',').map(part => part.trim())
  if (parts.some(part => !part)) return null
  if (parts.length > 1 && parts[parts.length - 1] === 'chile') {
    if (parts.length < 3 || parts[parts.length - 2] !== communeKey) return 'INCONSISTENT_DESTINATIONS'
    parts.pop()
  }
  if (parts.length > 1 && parts[parts.length - 1] === communeKey) parts.pop()
  // Solo se admiten complementos explícitos después de una coma. No se asume
  // que una comuna distinta o un texto libre sea un complemento de dirección.
  if (parts.slice(1).some(part => !/^(?:local\s+\d+[\p{L}]?|(?:esquina|villa|poblaci[oó]n)\s+.+)$/u.test(part))) return 'INCONSISTENT_DESTINATIONS'
  // El primer número después de un nombre de calle es el candidato; si el
  // resto es ambiguo no se prueba con un número posterior (local, pasaje, etc.).
  const match = parts[0].match(/^(.+?\p{L}.*?)\s*(?:#\s*|\s+)(\d+[\p{L}]?)(?=$|\s)(.*)$/u)
  if (!match || match[1].includes('#') || /(?:^|\s)(?:local|casa|vivienda|departamento|depto|oficina)\s*$/u.test(match[1]) || /\b(?:s\s*\/\s*n|sin\s+n[uú]mero|por\s+confirmar)\b/iu.test(addressKey)) return null
  const suffix = match[3].trim()
  if (suffix && suffix !== communeKey
    && !/^local\s+\d+[\p{L}]?$/u.test(suffix)
    && !/^(?:esquina|villa|poblaci[oó]n)\s+\p{L}[\p{L}\p{N}\s.\-#]*$/u.test(suffix)
    && !/^\p{L}[\p{L}.\-]*(?:\s+\p{L}[\p{L}.\-]*)+$/u.test(suffix)
  ) return null
  return { streetKey: match[1].trim(), numberKey: match[2] }
}

export function prepareGeocodingStop(params: {
  companyId: string
  stop: PotentialStop
  /** Lo afirma el consumidor; no se infiere desde el texto de dirección. */
  scope: 'MYM_DOMESTIC' | 'UNKNOWN'
}): PreparedGeocodingStop {
  const { companyId, stop, scope } = params
  const originals: GeographicOriginal[] = stop.deliveries.map(delivery => ({
    source: { ...delivery.source },
    address: delivery.destination.address,
    commune: delivery.destination.commune,
    addressSource: delivery.destination.addressSource,
    communeSource: delivery.destination.communeSource,
  }))
  const countrySource = scope === 'MYM_DOMESTIC' ? 'MYM_DOMESTIC_POLICY' : null
  const base = { stopId: stop.id, originals, countrySource } as const
  const review = (reason: Extract<PreparedGeocodingStop, { status: 'REVIEW_REQUIRED' }>['reason']): PreparedGeocodingStop => ({ ...base, status: 'REVIEW_REQUIRED', cacheKey: null, streetKey: null, numberKey: null, reason })
  if (typeof companyId !== 'string' || !companyId.trim()) return review('COMPANY_REQUIRED')
  if (scope !== 'MYM_DOMESTIC') return review('DOMESTIC_SCOPE_REQUIRED')
  if (!stop.deliveries.length) return review('MISSING_DELIVERY')
  const first = stop.deliveries[0].destination
  const addressKey = normalizeGeographicText(first.address)
  const communeKey = normalizeGeographicText(first.commune)
  if (!addressKey || !communeKey || stop.deliveries.some(delivery =>
    delivery.destination.completeness !== 'COMPLETE' || delivery.destination.addressSource === 'UNKNOWN'
    || delivery.destination.communeSource === 'CITY_RAW' || delivery.destination.communeSource === 'UNKNOWN'
    || Boolean(delivery.invalidSourceFields?.length)
  )) return review('INCOMPLETE_DESTINATION')
  if (addressKey.length > 300 || communeKey.length > 120) return review('KEY_TOO_LONG')
  if (normalizeGeographicText(stop.normalizedAddress) !== addressKey || normalizeGeographicText(stop.normalizedCommune) !== communeKey
    || stop.deliveries.some(delivery => normalizeGeographicText(delivery.destination.address) !== addressKey || normalizeGeographicText(delivery.destination.commune) !== communeKey)
  ) return review('INCONSISTENT_DESTINATIONS')
  const parsed = parseSpecificAddress(addressKey, communeKey)
  if (parsed === 'INCONSISTENT_DESTINATIONS') return review('INCONSISTENT_DESTINATIONS')
  if (!parsed || /^(?:sin comuna|desconocida|por confirmar)$/u.test(communeKey)) return review('ADDRESS_NOT_SPECIFIC')
  return { ...base, status: 'READY', cacheKey: { companyId: companyId.trim(), countryCode: 'CL', communeKey, addressKey }, ...parsed, reason: null }
}

/** Solo propone marcadores con evidencia estructurada; no confirma acceso físico. */
export function adaptSimulatedGeocodingResponse(prepared: PreparedGeocodingStop, response: SimulatedGeocodingResponse): GeocodingResult {
  const result = (status: GeocodingStatus, location: ProposedMapLocation | null = null): GeocodingResult => ({ stopId: prepared.stopId, status, location })
  if (prepared.status !== 'READY') return result('REVIEW_REQUIRED')
  if (!response || response.stopId !== prepared.stopId || !response.cacheKey
    || response.cacheKey.companyId !== prepared.cacheKey.companyId || response.cacheKey.countryCode !== prepared.cacheKey.countryCode
    || response.cacheKey.communeKey !== prepared.cacheKey.communeKey || response.cacheKey.addressKey !== prepared.cacheKey.addressKey
    || typeof response.provider !== 'string' || !response.provider.trim() || !Array.isArray(response.candidates)
  ) return result('ERROR')
  if (response.outcome === 'ERROR') return result('ERROR')
  if (response.outcome === 'NOT_FOUND') return response.candidates.length === 0 ? result('NOT_FOUND') : result('ERROR')
  if (response.outcome !== 'CANDIDATES') return result('ERROR')
  if (response.candidates.length === 0) return result('NOT_FOUND')
  if (response.candidates.length > 1) return result('AMBIGUOUS')
  const candidate = response.candidates[0]
  if (!candidate || normalizeGeographicCountry(candidate.countryCode) !== prepared.cacheKey.countryCode || normalizeGeographicText(candidate.commune) !== prepared.cacheKey.communeKey) return result('REVIEW_REQUIRED')
  if (candidate.precision === 'APPROXIMATE') return result('APPROXIMATE')
  if (candidate.precision !== 'ADDRESS' || normalizeStreetForComparison(candidate.street) !== normalizeStreetForComparison(prepared.streetKey) || normalizeGeographicText(candidate.number) !== prepared.numberKey || !isVroomLocation(candidate.coordinates)) return result('REVIEW_REQUIRED')
  return result('RECOGNIZED', { coordinates: [candidate.coordinates[0], candidate.coordinates[1]], verification: 'COORDINATE_VERIFIED', source: response.provider.trim(), classification: 'RECOGNIZED', physicalAccessVerified: false })
}
