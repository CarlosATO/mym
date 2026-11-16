'use server'

import { requireWmsPermission } from '@/app/actions/logistica/authorization'
import { resolvePreparationGeocoding } from './geocode-cache.server'
import type { LocationLookupItem, LocationLookupResponse } from './location-lookup-types'

/** Acción manual: datos mínimos para las tarjetas ya autorizadas, sin claves ni direcciones nuevas. */
export async function resolveLocationAction(cardIds: string[]): Promise<LocationLookupResponse> {
  try {
    const before = await requireWmsPermission('module.logistica.view')
    const resolved = await resolvePreparationGeocoding(cardIds, { maxStops: 1 })
    const after = await requireWmsPermission('module.logistica.view')
    if (before.user.id !== after.user.id || before.companyId !== after.companyId || before.effectiveRole !== after.effectiveRole || before.isOperatorBodega !== after.isOperatorBodega) throw new Error('No autorizado')
    const results: LocationLookupItem[] = resolved.map(item => {
      const provider = item.providerResult
      const cached = item.unverifiedCandidate
      return {
        stopId: item.stopId,
        cardIds: [...item.cardIds],
        cacheStatus: item.status,
        status: provider?.status ?? item.geocodingStatus,
        providerClassification: provider?.classification ?? null,
        error: provider?.error ?? (item.status === 'CACHE_UNAVAILABLE' ? [item.cacheFailure?.category ?? 'CACHE_UNAVAILABLE', item.cacheFailure?.edgeCode, item.cacheFailure?.httpStatus != null ? `HTTP ${item.cacheFailure.httpStatus}` : null].filter(Boolean).join(' · ') : item.reviewReason ?? item.issues?.join(', ') ?? null),
        candidates: provider?.candidates.map(candidate => ({
          coordinates: candidate.coordinates,
          communeMatches: candidate.communeMatches,
          ...(candidate.matchedAddress ? { matchedAddress: candidate.matchedAddress } : {}),
          ...(candidate.street ? { street: candidate.street } : {}),
          ...(candidate.housenumber ? { housenumber: candidate.housenumber } : {}),
          ...(candidate.locality ? { locality: candidate.locality } : {}),
          ...(candidate.accuracy ? { accuracy: candidate.accuracy } : {}),
          ...(candidate.confidence != null ? { confidence: candidate.confidence } : {}),
        })) ?? (cached ? [{
          coordinates: cached.coordinates,
          communeMatches: null,
          ...(cached.accuracyLabel ? { accuracy: cached.accuracyLabel } : {}),
        }] : []),
        recognizedLocation: provider?.status === 'RECOGNIZED' && provider.classification === 'EXACT' ? provider.location : null,
      }
    })
    return { ok: true, results }
  } catch {
    return { ok: false, error: 'No se pudo consultar la ubicación. Revisa el acceso, la empresa activa y los datos de la parada.' }
  }
}
