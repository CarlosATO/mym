import 'server-only'

import { requirePreparationCardAccess, requireWmsPermission, type WmsAuthorization } from '@/app/actions/logistica/authorization'
import { getSalesOrderPreparationBoard } from '@/app/actions/logistica/sales-order-preparation'
import { adaptFilteredPreparationCards } from './preparation-adapter'
import { buildDeliveryStops, type DeliveryIssue } from './delivery-stops'
import { normalizeGeographicText, prepareGeocodingStop, type PreparedGeocodingStop } from './geocoding-contract'

// Sigue acotado, pero permite dividir más de 100 destinos en lotes de caché.
const MAX_REQUESTED_CARDS = 300
const CARD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DENIED = 'No se pudo autorizar la solicitud de geocodificación.'
// UUID confirmado para el flujo de reparto MYM; no define la identidad global de la empresa.
export const MYM_PREPARATION_COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'

/** Contiene direcciones: uso exclusivo en servidor; no serializar ni registrar. */
export type AuthorizedGeocodingRequest = {
  companyId: string
  userId: string
  stops: Array<{ cardIds: string[]; geographic: PreparedGeocodingStop }>
  unresolved: Array<{ cardId: string; issues: DeliveryIssue[] }>
}

function sameAuthorization(a: WmsAuthorization, b: WmsAuthorization): boolean {
  return a.user.id === b.user.id && a.companyId === b.companyId
    && a.effectiveRole === b.effectiveRole && a.isOperatorBodega === b.isOperatorBodega
}

/**
 * Solo para consumidores de servidor: no es una Server Action ni un endpoint.
 * El navegador no aporta empresa, direcciones, coordenadas ni ámbito de país.
 */
export async function authorizePreparationGeocoding(cardIds: readonly string[]): Promise<AuthorizedGeocodingRequest> {
  try {
    if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > MAX_REQUESTED_CARDS) throw new Error(DENIED)
    const ids: string[] = []
    const requested = new Set<string>()
    for (const value of cardIds) {
      if (typeof value !== 'string' || !CARD_ID_PATTERN.test(value)) throw new Error(DENIED)
      const id = value.toLowerCase()
      if (requested.has(id)) throw new Error(DENIED)
      requested.add(id)
      ids.push(id)
    }

    const auth = await requireWmsPermission('module.logistica.view')
    const board = await getSalesOrderPreparationBoard(auth.companyId)
    if (board.error || board.isOperatorBodega !== auth.isOperatorBodega) throw new Error(DENIED)
    const cardsById = new Map<string, typeof board.data[number]>()
    for (const card of board.data) {
      const id = typeof card.card_id === 'string' ? card.card_id.toLowerCase() : ''
      if (!requested.has(id)) continue
      if (card.company_id !== auth.companyId || cardsById.has(id)) throw new Error(DENIED)
      cardsById.set(id, card)
    }
    if (cardsById.size !== ids.length) throw new Error(DENIED)

    // Mantiene la restricción individual por etapa y rol del tablero existente.
    // Los lotes acotan la concurrencia de las lecturas para operadores.
    for (let index = 0; index < ids.length; index += 10) {
      await Promise.all(ids.slice(index, index + 10).map(id => requirePreparationCardAccess(auth, id)))
    }
    const cards = ids.map(id => cardsById.get(id)!)
    const evaluation = adaptFilteredPreparationCards({ companyId: auth.companyId, filteredCards: cards, profitabilityByNv: {} })
    if (evaluation.companyId !== auth.companyId || evaluation.origin !== 'PREPARATION' || evaluation.deliveries.length !== ids.length) throw new Error(DENIED)
    const evaluatedIds = new Set<string>()
    for (const delivery of evaluation.deliveries) {
      if (delivery.source.type !== 'PREPARATION' || typeof delivery.source.recordId !== 'string') throw new Error(DENIED)
      const id = delivery.source.recordId.toLowerCase()
      if (!requested.has(id) || evaluatedIds.has(id)) throw new Error(DENIED)
      evaluatedIds.add(id)
    }
    const grouped = buildDeliveryStops(evaluation.deliveries)
    const scope = auth.companyId === MYM_PREPARATION_COMPANY_ID ? 'MYM_DOMESTIC' : 'UNKNOWN'
    const stops = grouped.stops.map(stop => {
      const geographic = prepareGeocodingStop({ companyId: auth.companyId, stop, scope })
      const conflictingCommune = stop.deliveries.some(delivery => {
        const card = cardsById.get(delivery.source.recordId.toLowerCase())
        const normalized = normalizeGeographicText(card?.normalized_city)
        const municipality = normalizeGeographicText(card?.municipality_raw)
        return normalized !== null && municipality !== null && normalized !== municipality
      })
      return {
        cardIds: stop.deliveries.map(delivery => delivery.source.recordId),
        geographic: geographic.status === 'READY' && conflictingCommune
          ? { ...geographic, status: 'REVIEW_REQUIRED' as const, cacheKey: null, streetKey: null, numberKey: null, reason: 'INCONSISTENT_DESTINATIONS' as const }
          : geographic,
      }
    })
    const unresolved = grouped.unresolved.map(item => ({ cardId: item.delivery.source.recordId, issues: item.issues }))

    const finalAuth = await requireWmsPermission('module.logistica.view')
    if (!sameAuthorization(auth, finalAuth)) throw new Error(DENIED)
    return { companyId: auth.companyId, userId: auth.user.id, stops, unresolved }
  } catch {
    // No distinguir IDs ajenos, inexistentes o inaccesibles ni exponer datos de origen.
    throw new Error(DENIED)
  }
}
