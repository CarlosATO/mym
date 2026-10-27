import type { CommercialComparisonResult, PreparationCommercialVersion } from './preparation-commercial-version'

const preparationVersionModulePath = './preparation-commercial-version.ts'

export type PreparationDetectionCardStatus = 'PENDING_ROUTE_PREP' | 'IN_PREPARATION' | 'IN_AUDIT' | 'AUDITED' | string

export type PreparationDetectionCardIdentity = {
  companyId: string
  cardId: string
  status: PreparationDetectionCardStatus
  canonicalToken: string | null
  historicalBsaleId: number | null
  currentBsaleId: number | null
  folio: string | null
}

export type PreparationDetectionRequest = {
  card: PreparationDetectionCardIdentity
  knownVersion: PreparationCommercialVersion | null
}

export type PreparationDetectorStatus = 'UNCHANGED' | 'CHANGED' | 'UNAVAILABLE' | 'INCOMPLETE' | 'AMBIGUOUS' | 'NOT_APPLICABLE'

export type PreparationDetectorResult = {
  status: PreparationDetectorStatus
  card: PreparationDetectionCardIdentity
  knownVersion: PreparationCommercialVersion | null
  currentVersion: PreparationCommercialVersion | null
  comparison: CommercialComparisonResult | null
  verifiedAt: string | null
  verificationSource: 'LIVE_BSALE' | 'CACHE' | 'NONE'
  detail: string
  errorCode?: 'AUTHORIZATION_REQUIRED' | 'BSale_UNAVAILABLE' | 'DOCUMENT_NOT_FOUND' | 'DOCUMENT_INCOMPLETE' | 'IDENTITY_AMBIGUOUS' | 'COMPARISON_AMBIGUOUS'
}

export type PreparationCommercialProviderErrorCode = 'UNAVAILABLE' | 'INCOMPLETE' | 'AMBIGUOUS' | 'NOT_FOUND'

export class PreparationCommercialProviderError extends Error {
  readonly code: PreparationCommercialProviderErrorCode

  constructor(code: PreparationCommercialProviderErrorCode, message: string) {
    super(message)
    this.name = 'PreparationCommercialProviderError'
    this.code = code
  }
}

export type PreparationCommercialProvider = {
  getCurrentVersion: (identity: PreparationDetectionCardIdentity, signal: AbortSignal) => Promise<PreparationCommercialVersion>
}

export type PreparationCommercialDetectorOptions = {
  provider: PreparationCommercialProvider
  authorize: (companyId: string) => Promise<void> | void
  now?: () => Date
  cacheTtlMs?: number
  timeoutMs?: number
  useCache?: boolean
}

type CachedDetection = {
  version: PreparationCommercialVersion
  verifiedAt: string
  expiresAt: number
}

const detectionCache = new Map<string, CachedDetection>()
const detectionInFlight = new Map<string, Promise<CachedDetection>>()

function cacheKey(card: PreparationDetectionCardIdentity): string {
  return `${card.companyId}:${card.canonicalToken ?? `folio:${card.folio ?? 'unknown'}`}`
}

function notApplicable(request: PreparationDetectionRequest, detail: string): PreparationDetectorResult {
  return {
    status: 'NOT_APPLICABLE', card: request.card, knownVersion: request.knownVersion,
    currentVersion: null, comparison: null, verifiedAt: null, verificationSource: 'NONE', detail,
  }
}

function baseResult(request: PreparationDetectionRequest, status: PreparationDetectorStatus, detail: string): PreparationDetectorResult {
  return {
    status, card: request.card, knownVersion: request.knownVersion, currentVersion: null,
    comparison: null, verifiedAt: null, verificationSource: 'NONE', detail,
  }
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

async function resolveCachedOrLive(
  request: PreparationDetectionRequest,
  options: PreparationCommercialDetectorOptions,
): Promise<{ version: PreparationCommercialVersion; verifiedAt: string; source: 'LIVE_BSALE' | 'CACHE' }> {
  const key = cacheKey(request.card)
  const now = (options.now ?? (() => new Date()))().getTime()
  const useCache = options.useCache !== false
  const cached = useCache ? detectionCache.get(key) : null
  if (cached && cached.expiresAt > now) {
    return { version: cached.version, verifiedAt: cached.verifiedAt, source: 'CACHE' }
  }

  const existing = detectionInFlight.get(key)
  if (existing) {
    const result = await existing
    return { version: result.version, verifiedAt: result.verifiedAt, source: 'CACHE' }
  }

  const timeout = withTimeout(options.timeoutMs ?? 15_000)
  const requestPromise = (async () => {
    try {
      const version = await options.provider.getCurrentVersion(request.card, timeout.signal)
      const verifiedAt = (options.now ?? (() => new Date()))().toISOString()
      const entry = { version, verifiedAt, expiresAt: Date.parse(verifiedAt) + (options.cacheTtlMs ?? 30_000) }
      if (useCache) detectionCache.set(key, entry)
      return entry
    } finally {
      timeout.cancel()
    }
  })()
  detectionInFlight.set(key, requestPromise)
  try {
    const result = await requestPromise
    return { version: result.version, verifiedAt: result.verifiedAt, source: 'LIVE_BSALE' }
  } finally {
    detectionInFlight.delete(key)
  }
}

export function clearPreparationCommercialDetectorCache(): void {
  detectionCache.clear()
  detectionInFlight.clear()
}

export async function detectPreparationCommercialChange(
  request: PreparationDetectionRequest,
  options: PreparationCommercialDetectorOptions,
): Promise<PreparationDetectorResult> {
  if (request.card.status === 'IN_AUDIT' || request.card.status === 'AUDITED' || request.card.status === 'INVOICED_READY_FOR_ROUTE') {
    return notApplicable(request, 'La tarjeta ya está en Auditoría o en un estado posterior.')
  }
  if (!request.card.companyId || !request.card.cardId || !request.card.canonicalToken || !request.card.folio) {
    return { ...baseResult(request, 'AMBIGUOUS', 'La identidad de la tarjeta está incompleta.'), errorCode: 'IDENTITY_AMBIGUOUS' }
  }
  if (!request.knownVersion) {
    return { ...baseResult(request, 'INCOMPLETE', 'No existe una versión conocida para comparar.'), errorCode: 'DOCUMENT_INCOMPLETE' }
  }
  try {
    await options.authorize(request.card.companyId)
  } catch (error) {
    return { ...baseResult(request, 'AMBIGUOUS', error instanceof Error ? error.message : 'No se pudo validar la autorización.'), errorCode: 'AUTHORIZATION_REQUIRED' }
  }

  let live: { version: PreparationCommercialVersion; verifiedAt: string; source: 'LIVE_BSALE' | 'CACHE' }
  try {
    live = await resolveCachedOrLive(request, options)
  } catch (error) {
    const providerError = error instanceof PreparationCommercialProviderError || (error && typeof error === 'object' && 'code' in error)
      ? error as { code?: string }
      : null
    const status = providerError?.code === 'NOT_FOUND' ? 'INCOMPLETE' : providerError?.code === 'AMBIGUOUS' ? 'AMBIGUOUS' : providerError?.code === 'INCOMPLETE' ? 'INCOMPLETE' : 'UNAVAILABLE'
    const errorCode = status === 'UNAVAILABLE' ? 'BSale_UNAVAILABLE' : status === 'AMBIGUOUS' ? 'IDENTITY_AMBIGUOUS' : 'DOCUMENT_INCOMPLETE'
    return { ...baseResult(request, status, error instanceof Error ? error.message : 'No se pudo consultar Bsale.'), errorCode }
  }

  const { compareCommercialVersions } = await import(preparationVersionModulePath)
  const comparison = compareCommercialVersions(request.knownVersion, live.version)
  if (!comparison.sameIdentity) {
    return { status: 'AMBIGUOUS', card: request.card, knownVersion: request.knownVersion, currentVersion: live.version, comparison, verifiedAt: live.verifiedAt, verificationSource: live.source, detail: 'La respuesta de Bsale no pertenece al token canónico esperado.', errorCode: 'IDENTITY_AMBIGUOUS' }
  }
  if (comparison.conflicts.length > 0) {
    return { status: 'AMBIGUOUS', card: request.card, knownVersion: request.knownVersion, currentVersion: live.version, comparison, verifiedAt: live.verifiedAt, verificationSource: live.source, detail: 'La comparación contiene emparejamientos ambiguos.', errorCode: 'COMPARISON_AMBIGUOUS' }
  }
  return {
    status: comparison.contentEquivalent ? 'UNCHANGED' : 'CHANGED', card: request.card,
    knownVersion: request.knownVersion, currentVersion: live.version, comparison,
    verifiedAt: live.verifiedAt, verificationSource: live.source,
    detail: comparison.contentEquivalent ? 'La versión vigente es comercialmente equivalente.' : 'Se detectaron modificaciones comerciales.',
  }
}
