'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { bsaleFetchResourceForCompany, BsaleApiError } from '@/lib/bsale/client'
import { parseCommerciallyBlocked } from '@/lib/integraciones/bsale-client-commercial-normalization'
import { requireWmsPermission, type WmsAuthorization } from './authorization'

export type ClientCommercialStatus = 'BLOCKED' | 'UNBLOCKED' | 'UNKNOWN'

export type VerifyCardClientCommercialData = {
  cardId: string
  clientId: number
  status: ClientCommercialStatus
  commerciallyBlocked: boolean | null
  verifiedAt: string
  previousStatus?: ClientCommercialStatus
  applied?: boolean
}

export type VerifyCardClientCommercialResult = {
  data: VerifyCardClientCommercialData | null
  error: string | null
}

export type VerifyCardClientCommercialDeps = {
  authorize?: () => Promise<WmsAuthorization>
  getUserDb?: () => Promise<any>
  getAdminDb?: () => any
  fetchBsaleResource?: <T>(options: {
    companyId: string
    path: string
    params?: Record<string, string | number | undefined>
    signal?: AbortSignal
    cache?: RequestCache
  }) => Promise<T>
  now?: () => string
  timeoutMs?: number
}

// In-flight coalescing para evitar llamadas duplicadas concurrentes por empresa y cliente
const inFlightVerifications = new Map<string, Promise<VerifyCardClientCommercialResult>>()

export async function executeVerifyCardClientCommercial(
  cardId: string,
  deps?: VerifyCardClientCommercialDeps
): Promise<VerifyCardClientCommercialResult> {
  if (!cardId || typeof cardId !== 'string' || cardId.trim() === '') {
    return { data: null, error: 'Identificador de tarjeta inválido.' }
  }

  // 1. Validar sesión, empresa activa y permisos de gestión comercial/logística
  let auth: WmsAuthorization
  try {
    if (deps?.authorize) {
      auth = await deps.authorize()
    } else {
      try {
        auth = await requireWmsPermission('logistica.preparation.manage')
      } catch {
        auth = await requireWmsPermission('logistica.audit.manage')
      }
    }
  } catch (authError) {
    return {
      data: null,
      error: authError instanceof Error ? authError.message : 'No autorizado para consultar el estado comercial.',
    }
  }

  if (auth.isOperatorBodega) {
    return { data: null, error: 'No autorizado para información comercial.' }
  }

  const userDb = deps?.getUserDb ? await deps.getUserDb() : await createClient()

  // 2. Resolver tarjeta y verificar pertenencia a la empresa activa
  const { data: card, error: cardError } = await userDb
    .schema('logistica')
    .from('sales_order_preparation_cards')
    .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id')
    .eq('id', cardId)
    .eq('company_id', auth.companyId)
    .maybeSingle()

  if (cardError || !card) {
    return {
      data: null,
      error: cardError?.message ?? 'Tarjeta no encontrada o no pertenece a la empresa activa.',
    }
  }

  // 3. Resolver internamente la Nota de Venta vigente y el client_id asociado
  let currentNvId: number | null = Number(card.current_bsale_nv_id ?? card.bsale_nv_id)
  let clientId: number | null = null

  if (card.canonical_bsale_token) {
    const { data: canonicalDoc } = await userDb
      .schema('integraciones')
      .from('vw_bsale_sales_order_documents_canonical')
      .select('current_bsale_id, client_id')
      .eq('company_id', auth.companyId)
      .eq('canonical_bsale_token', card.canonical_bsale_token)
      .maybeSingle()

    if (canonicalDoc) {
      if (canonicalDoc.current_bsale_id != null) currentNvId = Number(canonicalDoc.current_bsale_id)
      if (canonicalDoc.client_id != null) clientId = Number(canonicalDoc.client_id)
    }
  }

  if (!clientId && currentNvId != null && Number.isSafeInteger(currentNvId) && currentNvId > 0) {
    const { data: doc } = await userDb
      .schema('integraciones')
      .from('bsale_documents')
      .select('client_id')
      .eq('company_id', auth.companyId)
      .eq('bsale_id', currentNvId)
      .maybeSingle()

    if (doc?.client_id != null) clientId = Number(doc.client_id)
  }

  if (!clientId && card.bsale_nv_id != null && Number(card.bsale_nv_id) !== currentNvId) {
    const { data: origDoc } = await userDb
      .schema('integraciones')
      .from('bsale_documents')
      .select('client_id')
      .eq('company_id', auth.companyId)
      .eq('bsale_id', card.bsale_nv_id)
      .maybeSingle()

    if (origDoc?.client_id != null) clientId = Number(origDoc.client_id)
  }

  if (!clientId || !Number.isSafeInteger(clientId) || clientId <= 0) {
    return {
      data: null,
      error: 'No se pudo resolver el cliente de la Nota de Venta asociada a la tarjeta.',
    }
  }

  // 4. In-flight coalescing para evitar llamadas concurrentes idénticas
  const flightKey = `${auth.companyId}:${clientId}`
  const existingFlight = inFlightVerifications.get(flightKey)
  if (existingFlight) {
    return await existingFlight
  }

  const timeoutMs = deps?.timeoutMs ?? 15_000
  const fetchResource = deps?.fetchBsaleResource ?? bsaleFetchResourceForCompany
  const adminDb = deps?.getAdminDb ? deps.getAdminDb() : createAdminClient()
  const now = deps?.now ?? (() => new Date().toISOString())

  const executionPromise = (async (): Promise<VerifyCardClientCommercialResult> => {
    // 5. Obtener estado previo registrado en integraciones.bsale_clients
    const { data: existingClient, error: readClientError } = await adminDb
      .schema('integraciones')
      .from('bsale_clients')
      .select('id, raw_payload, last_sync_at')
      .eq('company_id', auth.companyId)
      .eq('bsale_client_id', clientId)
      .maybeSingle()

    if (readClientError) {
      return {
        data: null,
        error: `Error al leer cliente local: ${readClientError.message}`,
      }
    }

    const previousRaw = existingClient?.raw_payload?.commerciallyBlocked
    const previousParsed = parseCommerciallyBlocked(previousRaw)
    const previousStatus: ClientCommercialStatus =
      previousParsed === true ? 'BLOCKED' : previousParsed === false ? 'UNBLOCKED' : 'UNKNOWN'

    // 6. Obtener marca temporal comparable desde PostgreSQL antes de consultar Bsale
    const { data: serverTimestamp, error: tsError } = await adminDb
      .schema('integraciones')
      .rpc('get_server_timestamp')

    if (tsError || !serverTimestamp) {
      return {
        data: null,
        error: `Error al obtener marca temporal del servidor: ${tsError?.message ?? 'Sin respuesta de PostgreSQL'}`,
      }
    }

    // 7. Consultar exclusivamente este cliente en Bsale con timeout controlado
    let bsaleClient: Record<string, unknown>
    try {
      bsaleClient = await fetchResource<Record<string, unknown>>({
        companyId: auth.companyId,
        path: `/clients/${clientId}.json`,
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      })
    } catch (fetchError: unknown) {
      const message =
        fetchError instanceof BsaleApiError
          ? `Error Bsale (${fetchError.status}): ${fetchError.message}`
          : fetchError instanceof Error
          ? fetchError.message
          : 'Error de comunicación con Bsale'

      // Si falla Bsale: no alterar la base de datos y no asumir que está desbloqueado
      return {
        data: {
          cardId,
          clientId,
          status: 'UNKNOWN',
          commerciallyBlocked: null,
          verifiedAt: serverTimestamp,
          previousStatus,
        },
        error: message,
      }
    }

    // 8. Validar respuesta de Bsale y valor reconocido de commerciallyBlocked
    if (!bsaleClient || typeof bsaleClient !== 'object') {
      return {
        data: {
          cardId,
          clientId,
          status: 'UNKNOWN',
          commerciallyBlocked: null,
          verifiedAt: serverTimestamp,
          previousStatus,
        },
        error: 'Respuesta inválida de Bsale: no es un objeto.',
      }
    }

    const returnedId = Number(bsaleClient.id)
    if (!Number.isSafeInteger(returnedId) || returnedId !== clientId) {
      return {
        data: {
          cardId,
          clientId,
          status: 'UNKNOWN',
          commerciallyBlocked: null,
          verifiedAt: serverTimestamp,
          previousStatus,
        },
        error: `El cliente devuelto por Bsale (id: ${returnedId}) no coincide con el cliente solicitado (id: ${clientId}).`,
      }
    }

    const rawBlocked = bsaleClient.commerciallyBlocked
    const isBlocked = parseCommerciallyBlocked(rawBlocked)
    if (isBlocked === null) {
      return {
        data: {
          cardId,
          clientId,
          status: 'UNKNOWN',
          commerciallyBlocked: null,
          verifiedAt: serverTimestamp,
          previousStatus,
        },
        error: 'La respuesta de Bsale no contiene un valor reconocido para commerciallyBlocked.',
      }
    }

    // 9. Actualización atómica en integraciones.bsale_clients mediante función RPC
    // Se elimina cualquier INSERT/UPDATE directo. La RPC gestiona monotonicidad y concurrencia.
    const { data: rpcData, error: rpcError } = await adminDb
      .schema('integraciones')
      .rpc('update_bsale_client_commercial_status', {
        p_company_id: auth.companyId,
        p_bsale_client_id: clientId,
        p_commercially_blocked: isBlocked,
        p_observed_at: serverTimestamp,
        p_raw_client: bsaleClient,
      })

    if (rpcError || !rpcData) {
      return {
        data: null,
        error: `Error al persistir actualización atómica en bsale_clients: ${rpcError?.message ?? 'Sin respuesta de la base de datos'}`,
      }
    }

    const parsedRpc: {
      id?: string
      company_id?: string
      bsale_client_id?: number
      commercially_blocked?: boolean | null
      commerciallyBlocked?: boolean | null
      commercial_observed_at?: string | null
      commercialObservedAt?: string | null
      last_seen_at?: string | null
      last_sync_at?: string | null
      applied?: boolean
    } = typeof rpcData === 'string' ? JSON.parse(rpcData) : rpcData

    const applied = parsedRpc.applied === true
    const effectiveVerifiedAt = parsedRpc.commercial_observed_at ?? serverTimestamp

    if (!applied) {
      // Conflicto de orden temporal: la respuesta tardía no sobrescribe un estado más reciente registrado en BD
      const prevailingBlocked =
        parsedRpc.commercially_blocked !== undefined
          ? parsedRpc.commercially_blocked
          : parsedRpc.commerciallyBlocked !== undefined
          ? parsedRpc.commerciallyBlocked
          : null

      const prevailingStatus: ClientCommercialStatus =
        prevailingBlocked === true ? 'BLOCKED' : prevailingBlocked === false ? 'UNBLOCKED' : 'UNKNOWN'

      return {
        data: {
          cardId,
          clientId,
          status: prevailingStatus,
          commerciallyBlocked: prevailingBlocked,
          verifiedAt: effectiveVerifiedAt,
          previousStatus,
          applied: false,
        },
        error: 'Observación comercial descartada: existe una actualización más reciente en la base de datos.',
      }
    }

    const newStatus: ClientCommercialStatus = isBlocked ? 'BLOCKED' : 'UNBLOCKED'

    return {
      data: {
        cardId,
        clientId,
        status: newStatus,
        commerciallyBlocked: isBlocked,
        verifiedAt: effectiveVerifiedAt,
        previousStatus,
        applied: true,
      },
      error: null,
    }
  })()

  inFlightVerifications.set(flightKey, executionPromise)
  try {
    return await executionPromise
  } finally {
    inFlightVerifications.delete(flightKey)
  }
}

/**
 * Server Action pública invocable desde clientes Next.js.
 * Recibe únicamente `cardId` para impedir suplantación de client_id.
 */
export async function verifyCardClientCommercialStatus(
  cardId: string
): Promise<VerifyCardClientCommercialResult> {
  return executeVerifyCardClientCommercial(cardId)
}

