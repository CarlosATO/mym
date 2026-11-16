import 'server-only'

import { authorizePreparationGeocoding, MYM_PREPARATION_COMPANY_ID, type AuthorizedGeocodingRequest } from './authorize-geocoding.server'
import type { DeliveryIssue } from './delivery-stops'
import { adaptSimulatedGeocodingResponse, type GeocodingStatus, type GeographicCacheKey, type PreparedGeocodingStop, type ProposedMapLocation } from './geocoding-contract'
import { isVroomLocation, type VroomPoint } from './vroom-adapter'

export type GeocodeCacheStatus = 'CACHE_RESOLVED' | 'CACHE_AMBIGUOUS' | 'CACHE_NOT_FOUND' | 'CACHE_MISS' | 'REVIEW_REQUIRED' | 'CACHE_UNAVAILABLE'
export type CacheFailure = {
  category: 'CONFIGURATION' | 'AUTHENTICATION' | 'TIMEOUT' | 'TRANSPORT' | 'EDGE_ERROR' | 'INVALID_RESPONSE'
  httpStatus?: number
  edgeCode?: 'CACHE_LOOKUP_FAILED' | 'DATABASE_UNAVAILABLE' | 'INVALID_REQUEST' | 'METHOD_NOT_ALLOWED'
}
export type GeocodeCacheResult = {
  stopId: string | null
  cardIds: string[]
  status: GeocodeCacheStatus
  geocodingStatus: GeocodingStatus | null
  /** Nunca se promueve directamente una fila RESOLVED al contrato del mapa. */
  location: null
  unverifiedCandidate: null | {
    coordinates: VroomPoint['location']
    usable: false
    physicalAccessVerified: false
    accuracyLabel: string | null
    provider: string
    expiresAt: string
  }
  reviewReason?: Extract<PreparedGeocodingStop, { status: 'REVIEW_REQUIRED' }>['reason']
  issues?: DeliveryIssue[]
  cacheFailure?: CacheFailure
}

export type ProviderClassification = 'EXACT' | 'APPROXIMATE' | 'AMBIGUOUS' | 'NOT_FOUND' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_AUTH_FAILED' | 'PROVIDER_UNAVAILABLE'
export type GeocodeCandidate = {
  coordinates: VroomPoint['location']
  communeMatches: boolean
  matchedAddress?: string | null
  street?: string | null
  housenumber?: string | null
  locality?: string | null
  accuracy?: string | null
  confidence?: number | null
}
export type PreparationGeocodeResult = GeocodeCacheResult & {
  providerResult: null | {
    classification: ProviderClassification | null
    status: GeocodingStatus
    location: ProposedMapLocation | null
    candidates: GeocodeCandidate[]
    error: 'INVALID_DESTINATION' | 'EDGE_UNAVAILABLE' | 'INVALID_RESPONSE' | null
    diagnosticReason?: string
  }
}

type CacheOutcome = Pick<GeocodeCacheResult, 'status' | 'geocodingStatus' | 'location' | 'unverifiedCandidate'> & { validUntil?: number; cacheFailure?: CacheFailure }
type WireDestination = { country_code: 'CL'; commune_key: string; address_key: string }
const MAX_DESTINATIONS = 100
const MAX_BODY_BYTES = 40_000
const TIMEOUT_MS = 9_000
const RESOLVER_TIMEOUT_MS = 50_000
const MAX_RESOLVER_DESTINATIONS = 10
const MAX_RESOLVER_BODY_BYTES = 15_000
const EXPECTED_HOST = 'oekmztbfasmildyuajji.supabase.co'
const UNAVAILABLE: CacheOutcome = { status: 'CACHE_UNAVAILABLE', geocodingStatus: 'ERROR', location: null, unverifiedCandidate: null, cacheFailure: { category: 'INVALID_RESPONSE' } }
const MISS: CacheOutcome = { status: 'CACHE_MISS', geocodingStatus: null, location: null, unverifiedCandidate: null }
const REVIEW: CacheOutcome = { status: 'REVIEW_REQUIRED', geocodingStatus: 'REVIEW_REQUIRED', location: null, unverifiedCandidate: null }

function cacheKey(key: GeographicCacheKey): string {
  return JSON.stringify([key.companyId, key.countryCode, key.communeKey, key.addressKey])
}

function wireDestination(key: GeographicCacheKey): WireDestination {
  return { country_code: key.countryCode, commune_key: key.communeKey, address_key: key.addressKey }
}

function bodyFor(companyId: string, destinations: WireDestination[]): string {
  return JSON.stringify({ company_id: companyId, destinations })
}

function getEdgeConfig(): { url: string; secret: string } | null {
  const secret = process.env.SUPABASE_SECRET_KEY?.trim()
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (!secret?.startsWith('sb_secret_') || !base) return null
  try {
    const parsed = new URL(base)
    if (parsed.protocol !== 'https:' || parsed.hostname !== EXPECTED_HOST || parsed.port || parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) return null
    return { url: `${parsed.origin}/functions/v1/rutas-geocode-cache-lookup`, secret }
  } catch {
    return null
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseCacheRow(row: Record<string, unknown>, now: number): CacheOutcome {
  const expiresAt = parseTimestamp(row.expires_at)
  const fetchedAt = parseTimestamp(row.fetched_at)
  if (expiresAt === null || fetchedAt === null || expiresAt <= fetchedAt) return UNAVAILABLE
  if (expiresAt <= now) return MISS
  if (typeof row.provider !== 'string' || !row.provider.trim()) return UNAVAILABLE
  if (row.accuracy_label != null && typeof row.accuracy_label !== 'string') return UNAVAILABLE
  if (row.status === 'AMBIGUOUS' && row.coordinates === null) return { ...MISS, status: 'CACHE_AMBIGUOUS', geocodingStatus: 'AMBIGUOUS', validUntil: expiresAt }
  if (row.status === 'NOT_FOUND' && row.coordinates === null) return { ...MISS, status: 'CACHE_NOT_FOUND', geocodingStatus: 'NOT_FOUND', validUntil: expiresAt }
  if (row.status !== 'RESOLVED' || !isVroomLocation(row.coordinates)) return UNAVAILABLE
  return {
    status: 'CACHE_RESOLVED',
    // La caché no contiene evidencia estructurada suficiente de calle/número/comuna.
    geocodingStatus: 'REVIEW_REQUIRED',
    location: null,
    validUntil: expiresAt,
    unverifiedCandidate: { coordinates: [row.coordinates[0], row.coordinates[1]], usable: false, physicalAccessVerified: false, accuracyLabel: typeof row.accuracy_label === 'string' ? row.accuracy_label : null, provider: row.provider, expiresAt: row.expires_at as string },
  }
}

async function fetchBatch(companyId: string, entries: Array<{ key: GeographicCacheKey; wire: WireDestination }>, config: { url: string; secret: string }): Promise<Map<string, CacheOutcome>> {
  const unavailable = (failure: CacheFailure = { category: 'INVALID_RESPONSE' }) => new Map(entries.map(entry => [cacheKey(entry.key), { ...UNAVAILABLE, cacheFailure: failure }]))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('timeout')) }, TIMEOUT_MS)
    })
    const request = (async () => {
      const response = await fetch(config.url, { method: 'POST', headers: { apikey: config.secret, 'content-type': 'application/json' }, body: bodyFor(companyId, entries.map(entry => entry.wire)), signal: controller.signal, cache: 'no-store', redirect: 'error' })
      const payload: unknown = await response.json().catch(() => null)
      return { response, payload }
    })()
    const { response, payload } = await Promise.race([request, timeout])
    if (!response.ok) {
      const rawCode = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).code : null
      const edgeCode = rawCode === 'CACHE_LOOKUP_FAILED' || rawCode === 'DATABASE_UNAVAILABLE' || rawCode === 'INVALID_REQUEST' || rawCode === 'METHOD_NOT_ALLOWED' ? rawCode : undefined
      return unavailable({ category: response.status === 401 || response.status === 403 ? 'AUTHENTICATION' : 'EDGE_ERROR', httpStatus: response.status, ...(edgeCode ? { edgeCode } : {}) })
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unavailable()
    const data = payload as Record<string, unknown>
    if (data.ok !== true || data.code !== 'CACHE_LOOKUP_COMPLETE' || data.company_id !== companyId || !Array.isArray(data.cached) || data.cached.length > MAX_DESTINATIONS || data.matched !== data.cached.length) return unavailable()
    const result = new Map(entries.map(entry => [cacheKey(entry.key), MISS]))
    const seen = new Set<string>()
    const now = Date.now()
    for (const raw of data.cached) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable()
      const row = raw as Record<string, unknown>
      if (row.company_id != null && row.company_id !== companyId) return unavailable()
      if (typeof row.country_code !== 'string' || typeof row.commune_key !== 'string' || typeof row.address_key !== 'string') return unavailable()
      const key = JSON.stringify([companyId, row.country_code, row.commune_key, row.address_key])
      if (!result.has(key)) continue
      if (seen.has(key)) { result.set(key, UNAVAILABLE); continue }
      seen.add(key)
      result.set(key, parseCacheRow(row, now))
    }
    return result
  } catch {
    return unavailable({ category: timedOut ? 'TIMEOUT' : 'TRANSPORT' })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}

/**
 * Entrada exclusiva de servidor: autoriza las tarjetas antes de cualquier lectura.
 * El resultado y sus IDs pueden contener direcciones: no serializar ni registrar.
 */
async function lookupAuthorizedGeocodeCache(authorized: AuthorizedGeocodingRequest): Promise<GeocodeCacheResult[]> {
  const entries = new Map<string, { key: GeographicCacheKey; wire: WireDestination }>()
  for (const stop of authorized.stops) {
    const geographic = stop.geographic
    if (geographic.status !== 'READY') continue
    const key = geographic.cacheKey
    // La función privada solo sirve al flujo MYM; rechazar inconsistencias antes de enviar.
    if (authorized.companyId !== MYM_PREPARATION_COMPANY_ID || key.companyId !== authorized.companyId || key.countryCode !== 'CL' || geographic.countrySource !== 'MYM_DOMESTIC_POLICY') throw new Error('No se pudo autorizar la solicitud de geocodificación.')
    entries.set(cacheKey(key), { key, wire: wireDestination(key) })
  }

  const outcomes = new Map<string, CacheOutcome>()
  const config = getEdgeConfig()
  const unique = [...entries.values()]
  if (!config) {
    for (const entry of unique) outcomes.set(cacheKey(entry.key), { ...UNAVAILABLE, cacheFailure: { category: 'CONFIGURATION' } })
  } else {
    let batch: typeof unique = []
    for (const entry of unique) {
      const candidate = [...batch, entry]
      const size = new TextEncoder().encode(bodyFor(authorized.companyId, candidate.map(item => item.wire))).length
      if (batch.length && (candidate.length > MAX_DESTINATIONS || size > MAX_BODY_BYTES)) {
        for (const [key, value] of await fetchBatch(authorized.companyId, batch, config)) outcomes.set(key, value)
        batch = []
      }
      batch.push(entry)
    }
    if (batch.length) for (const [key, value] of await fetchBatch(authorized.companyId, batch, config)) outcomes.set(key, value)
  }

  return [
    ...authorized.stops.map(stop => {
      const geographic = stop.geographic
      const found = geographic.status === 'READY' ? outcomes.get(cacheKey(geographic.cacheKey)) ?? UNAVAILABLE : REVIEW
      const outcome = found.validUntil !== undefined && found.validUntil <= Date.now() ? MISS : found
      return { stopId: geographic.stopId, cardIds: [...stop.cardIds], status: outcome.status, geocodingStatus: outcome.geocodingStatus, location: outcome.location, unverifiedCandidate: outcome.unverifiedCandidate, ...(outcome.cacheFailure ? { cacheFailure: outcome.cacheFailure } : {}), ...(geographic.status === 'REVIEW_REQUIRED' ? { reviewReason: geographic.reason } : {}) }
    }),
    ...authorized.unresolved.map(item => ({ stopId: null, cardIds: [item.cardId], ...REVIEW, issues: [...item.issues] })),
  ]
}

/** Consulta solo la caché de las tarjetas autorizadas; no accede a HeiGIT. */
export async function lookupPreparationGeocodeCache(cardIds: readonly string[]): Promise<GeocodeCacheResult[]> {
  return lookupAuthorizedGeocodeCache(await authorizePreparationGeocoding(cardIds))
}

type ReadyGeographic = Extract<PreparedGeocodingStop, { status: 'READY' }>
type ProviderOutcome = NonNullable<PreparationGeocodeResult['providerResult']>
type ResolverEntry = { key: GeographicCacheKey; wire: WireDestination }
type ResolverAnswer = { classification: ProviderClassification; row: Record<string, unknown> } | { error: NonNullable<ProviderOutcome['error']> }
const PROVIDER_CLASSIFICATIONS = new Set<ProviderClassification>(['EXACT', 'APPROXIMATE', 'AMBIGUOUS', 'NOT_FOUND', 'PROVIDER_RATE_LIMITED', 'PROVIDER_AUTH_FAILED', 'PROVIDER_UNAVAILABLE'])

function validResolverDestination(destination: WireDestination): boolean {
  return destination.country_code === 'CL'
    && typeof destination.commune_key === 'string' && destination.commune_key.length > 0 && destination.commune_key.length <= 120
    && destination.commune_key === destination.commune_key.trim()
    && typeof destination.address_key === 'string' && destination.address_key.length > 0 && destination.address_key.length <= 300
    && destination.address_key === destination.address_key.trim()
    && !/[\u0000-\u001f\u007f]/u.test(destination.commune_key + destination.address_key)
}

async function fetchResolverBatch(companyId: string, entries: ResolverEntry[], config: { url: string; secret: string }): Promise<Map<string, ResolverAnswer>> {
  const failed = (error: NonNullable<ProviderOutcome['error']>) => new Map(entries.map(entry => [cacheKey(entry.key), { error } as ResolverAnswer]))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, RESOLVER_TIMEOUT_MS)
    })
    const request = (async () => {
      const url = new URL('/functions/v1/rutas-heigit-resolve', config.url).href
      const response = await fetch(url, { method: 'POST', headers: { apikey: config.secret, 'content-type': 'application/json' }, body: bodyFor(companyId, entries.map(entry => entry.wire)), signal: controller.signal, cache: 'no-store', redirect: 'error' })
      if (!response.ok) throw new Error('unavailable')
      return response.json() as Promise<unknown>
    })()
    const payload = await Promise.race([request, timeout])
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failed('INVALID_RESPONSE')
    const data = payload as Record<string, unknown>
    if (data.ok !== true || data.code !== 'GEOCODE_BATCH_COMPLETE' || data.company_id !== companyId || data.provider !== 'HEIGIT_PELIAS' || data.writes !== 0 || data.requests_to_provider !== entries.length || !Array.isArray(data.results) || data.results.length !== entries.length) return failed('INVALID_RESPONSE')
    const result = failed('INVALID_RESPONSE')
    const seen = new Set<string>()
    for (const raw of data.results) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failed('INVALID_RESPONSE')
      const row = raw as Record<string, unknown>
      if (row.company_id != null && row.company_id !== companyId) return failed('INVALID_RESPONSE')
      if (typeof row.country_code !== 'string' || typeof row.commune_key !== 'string' || typeof row.address_key !== 'string') return failed('INVALID_RESPONSE')
      const key = JSON.stringify([companyId, row.country_code, row.commune_key, row.address_key])
      if (!result.has(key) || seen.has(key)) return failed('INVALID_RESPONSE')
      seen.add(key)
      if (typeof row.classification !== 'string' || !PROVIDER_CLASSIFICATIONS.has(row.classification as ProviderClassification) || row.physical_access_verified !== false || !Array.isArray(row.candidates) || row.candidates.length > 5) return failed('INVALID_RESPONSE')
      result.set(key, { classification: row.classification as ProviderClassification, row })
    }
    return result
  } catch {
    return failed('EDGE_UNAVAILABLE')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}

function interpretResolverAnswer(prepared: ReadyGeographic, answer: ResolverAnswer): ProviderOutcome {
  if ('error' in answer) return { classification: null, status: 'ERROR', location: null, candidates: [], error: answer.error }
  const { classification, row } = answer
  const candidates: GeocodeCandidate[] = (row.candidates as unknown[]).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const candidate = value as Record<string, unknown>
    if (!isVroomLocation(candidate.coordinates) || candidate.country_matches !== true || typeof candidate.commune_matches !== 'boolean') return []
    const matchedAddress = typeof candidate.matched_address === 'string' && candidate.matched_address.trim() ? candidate.matched_address.trim() : null
    const street = typeof candidate.street === 'string' && candidate.street.trim() ? candidate.street.trim() : null
    const housenumber = typeof candidate.housenumber === 'string' && candidate.housenumber.trim() ? candidate.housenumber.trim() : null
    const locality = typeof candidate.locality === 'string' && candidate.locality.trim() ? candidate.locality.trim() : null
    const accuracy = typeof candidate.accuracy === 'string' && candidate.accuracy.trim() ? candidate.accuracy.trim() : null
    const confidence = typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1 ? candidate.confidence : null
    return [{
      coordinates: [candidate.coordinates[0], candidate.coordinates[1]] as const,
      communeMatches: candidate.commune_matches,
      ...(matchedAddress ? { matchedAddress } : {}),
      ...(street ? { street } : {}),
      ...(housenumber ? { housenumber } : {}),
      ...(locality ? { locality } : {}),
      ...(accuracy ? { accuracy } : {}),
      ...(confidence != null ? { confidence } : {}),
    }]
  })
  const result = (status: GeocodingStatus, location: ProposedMapLocation | null = null, diagnosticReason?: string): ProviderOutcome => ({ classification, status, location, candidates, error: null, ...(diagnosticReason ? { diagnosticReason } : {}) })
  if (classification === 'PROVIDER_RATE_LIMITED' || classification === 'PROVIDER_AUTH_FAILED' || classification === 'PROVIDER_UNAVAILABLE') return result('ERROR')
  if (classification === 'APPROXIMATE' || classification === 'AMBIGUOUS' || classification === 'NOT_FOUND') {
    if (row.coordinates !== null) return { classification, status: 'ERROR', location: null, candidates: [], error: 'INVALID_RESPONSE' }
    const rawCandidates = row.candidates as Array<Record<string, unknown>>
    const valid = rawCandidates.filter(candidate => candidate && typeof candidate === 'object')
    return result(classification, null, `Clasificación ${classification}; candidatos: ${rawCandidates.length}; comuna coincidente: ${valid.filter(c => c.commune_matches === true).length}; calle y número coincidentes: ${valid.filter(c => c.street_number_matches === true).length}; capa address: ${valid.filter(c => c.layer === 'address').length}; fallback: ${valid.filter(c => typeof c.match_type === 'string' && c.match_type.toLowerCase() === 'fallback').length}; centroide/interpolada: ${valid.filter(c => typeof c.accuracy === 'string' && ['centroid', 'interpolated'].includes(c.accuracy.toLowerCase())).length}; coincidencias exactas: ${valid.filter(c => c.exact_geographic_match === true).length}.`)
  }
  if (!isVroomLocation(row.coordinates)) return result('REVIEW_REQUIRED', null, 'EXACT sin coordenadas válidas en la respuesta.')
  const coordinates = row.coordinates
  const exact = (row.candidates as unknown[]).filter(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && (candidate as Record<string, unknown>).exact_geographic_match === true) as Record<string, unknown>[]
  if (!exact.length) return result('REVIEW_REQUIRED', null, 'EXACT sin candidato marcado como coincidencia geográfica exacta.')
  for (const candidate of exact) {
    if (!isVroomLocation(candidate.coordinates) || candidate.coordinates[0] !== coordinates[0] || candidate.coordinates[1] !== coordinates[1]
      || candidate.country_matches !== true || candidate.commune_matches !== true || candidate.street_number_matches !== true
      || candidate.layer !== 'address' || (typeof candidate.match_type === 'string' && candidate.match_type.toLowerCase() === 'fallback')
      || (typeof candidate.accuracy === 'string' && ['centroid', 'interpolated'].includes(candidate.accuracy.toLowerCase()))
    ) return result('REVIEW_REQUIRED', null, 'EXACT con evidencia inconsistente: coordenadas, país, comuna, calle y número, capa o precisión.')
    const checked = adaptSimulatedGeocodingResponse(prepared, {
      stopId: prepared.stopId, cacheKey: prepared.cacheKey, provider: 'HEIGIT_PELIAS', outcome: 'CANDIDATES',
      candidates: [{ countryCode: 'CL', commune: typeof candidate.locality === 'string' ? candidate.locality : null, street: typeof candidate.street === 'string' ? candidate.street : null, number: typeof candidate.housenumber === 'string' ? candidate.housenumber : null, precision: 'ADDRESS', coordinates: candidate.coordinates }],
    })
    if (checked.status !== 'RECOGNIZED' || !checked.location) {
      const commune = typeof candidate.locality === 'string' ? candidate.locality.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('es-CL') : null
      return result('REVIEW_REQUIRED', null, commune !== prepared.cacheKey.communeKey ? 'EXACT rechazado: la comuna devuelta no coincide en la validación local.' : 'EXACT rechazado: calle o número no coinciden en la validación local.')
    }
  }
  const accepted = adaptSimulatedGeocodingResponse(prepared, {
    stopId: prepared.stopId, cacheKey: prepared.cacheKey, provider: 'HEIGIT_PELIAS', outcome: 'CANDIDATES',
    candidates: [{ countryCode: 'CL', commune: exact[0].locality as string, street: exact[0].street as string, number: exact[0].housenumber as string, precision: 'ADDRESS', coordinates }],
  })
  return result(accepted.status, accepted.location)
}

/** Flujo privado de Preparación: solo resuelve claves autorizadas sin caché vigente. */
export async function resolvePreparationGeocoding(cardIds: readonly string[], options?: { maxStops?: number }): Promise<PreparationGeocodeResult[]> {
  const authorized = await authorizePreparationGeocoding(cardIds)
  if (options?.maxStops != null && (authorized.stops.length + authorized.unresolved.length > options.maxStops || !Number.isSafeInteger(options.maxStops) || options.maxStops < 1)) throw new Error('No se pudo autorizar la solicitud de geocodificación.')
  const cached = await lookupAuthorizedGeocodeCache(authorized)
  const geographicByStop = new Map(authorized.stops.map(stop => [stop.geographic.stopId, stop.geographic]))
  const entries = new Map<string, ResolverEntry>()
  const answers = new Map<string, ResolverAnswer>()
  for (const item of cached) {
    if (item.status !== 'CACHE_MISS' || !item.stopId) continue
    const geographic = geographicByStop.get(item.stopId)
    if (!geographic || geographic.status !== 'READY' || authorized.companyId !== MYM_PREPARATION_COMPANY_ID || geographic.cacheKey.companyId !== authorized.companyId || geographic.countrySource !== 'MYM_DOMESTIC_POLICY') continue
    const entry = { key: geographic.cacheKey, wire: wireDestination(geographic.cacheKey) }
    const key = cacheKey(entry.key)
    if (!validResolverDestination(entry.wire) || new TextEncoder().encode(bodyFor(authorized.companyId, [entry.wire])).length > MAX_RESOLVER_BODY_BYTES) answers.set(key, { error: 'INVALID_DESTINATION' })
    else entries.set(key, entry)
  }
  const config = getEdgeConfig()
  const batches: ResolverEntry[][] = []
  let batch: ResolverEntry[] = []
  for (const entry of entries.values()) {
    const candidate = [...batch, entry]
    const size = new TextEncoder().encode(bodyFor(authorized.companyId, candidate.map(item => item.wire))).length
    if (batch.length && (candidate.length > MAX_RESOLVER_DESTINATIONS || size > MAX_RESOLVER_BODY_BYTES)) { batches.push(batch); batch = [] }
    batch.push(entry)
  }
  if (batch.length) batches.push(batch)
  if (!config) {
    for (const entry of entries.values()) answers.set(cacheKey(entry.key), { error: 'EDGE_UNAVAILABLE' })
  } else {
    // Dos lotes en paralelo como máximo; la Edge Function limita su propia concurrencia.
    for (let index = 0; index < batches.length; index += 2) {
      const results = await Promise.all(batches.slice(index, index + 2).map(items => fetchResolverBatch(authorized.companyId, items, config)))
      for (const result of results) for (const [key, value] of result) answers.set(key, value)
    }
  }
  return cached.map(item => {
    if (item.status !== 'CACHE_MISS' || !item.stopId) return { ...item, providerResult: null }
    const geographic = geographicByStop.get(item.stopId)
    if (!geographic || geographic.status !== 'READY') return { ...item, providerResult: { classification: null, status: 'ERROR', location: null, candidates: [], error: 'INVALID_DESTINATION' } }
    const answer = answers.get(cacheKey(geographic.cacheKey)) ?? { error: 'INVALID_DESTINATION' as const }
    return { ...item, providerResult: interpretResolverAnswer(geographic, answer) }
  })
}
