'use server'

import { requireWmsPermission } from './authorization'
import { getSalesOrderPreparationCommercialAlert } from './sales-order-preparation-commercial'
import { moveSalesOrderPreparationCard, type SalesOrderPreparationLine } from './sales-order-preparation'
import { getSalesOrderAuditFinalizationStatus } from './sales-order-audit'
import { verifySalesOrderAuditCommercial, type SalesOrderAuditCommercialVerification } from './sales-order-audit-commercial'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createBsalePreparationCommercialProvider } from '@/lib/logistica/preparation-commercial-bsale-provider'
import { hydrateBsaleDocumentsById, mapBsaleDocument, mapBsaleDocumentDetails } from '@/lib/integraciones/bsale-document-hydration'
import { acquireSyncLock as acquireOperationalBsaleSyncLock, releaseSyncLock as releaseOperationalBsaleSyncLock } from '@/app/actions/integraciones/bsale-sync'
import { assertActiveBsaleCoordinatorLease, composeBsaleProtectedSignal, getBsaleSyncRolloutConfig } from '@/lib/integraciones/bsale-sync-coordinator'
import { ensureBsaleSyncQueueRuntimeRegistered } from '@/lib/integraciones/bsale-sync-queue-runtime'
import { findActiveBsaleSyncOperation, PREPARATION_CARD_QUEUE_OPERATIONS } from '@/lib/integraciones/bsale-sync-queue-status'
import { evaluatePostSyncAuditTransition } from '@/modules/logistica/preparacion-pedidos/preparation-line-validation'

type IncidentSyncStatus = 'RESOLVED' | 'PENDING' | 'UNABLE_TO_VERIFY' | 'ALREADY_RESOLVED'

export type PreparationIncidentSyncResult = {
  status: IncidentSyncStatus
  incidentId: string
  cardId: string | null
  currentBsaleNvId: number | null
  syncRunId: string | null
  verification: Record<string, unknown> | null
  differences: Array<Record<string, unknown>>
  message: string
  queued?: boolean
  queueRequestId?: string | null
  queueStatus?: 'PENDING' | 'RUNNING' | null
  deduplicated?: boolean
}

export type PreparationCardSyncStatus =
  | 'SYNCED'
  | 'SYNCED_AND_MOVED_TO_AUDIT'
  | 'CONFLICT'
  | 'IN_PROGRESS'
  | 'INVALID_STATE'
  | 'ERROR'

export type PreparationCardSyncResult = {
  ok: boolean
  status: PreparationCardSyncStatus
  cardId: string
  previousBsaleNvId: number | null
  currentBsaleNvId: number | null
  substitutedDocument: boolean
  detailCount: number
  syncRunId: string | null
  syncedAt: string | null
  autoMovedToAudit: boolean
  blockReason: string | null
  blockMessage: string | null
  message: string
  queued?: boolean
  queueRequestId?: string | null
  queueStatus?: 'PENDING' | 'RUNNING' | null
  deduplicated?: boolean
}

const inFlightCardSyncs = new Set<string>()

type CardRow = {
  id: string
  company_id: string
  status: string
  bsale_nv_id: number
  bsale_nv_folio: string | null
  canonical_bsale_token: string | null
  current_bsale_nv_id: number | null
}

type IncidentRow = { id: string; card_id: string; company_id: string; status: string }

function result(status: IncidentSyncStatus, incidentId: string, cardId: string | null, currentBsaleNvId: number | null, syncRunId: string | null, message: string, verification: Record<string, unknown> | null = null, differences: Array<Record<string, unknown>> = []): PreparationIncidentSyncResult {
  return { status, incidentId, cardId, currentBsaleNvId, syncRunId, verification, differences, message }
}

async function createBsaleRun(companyId: string): Promise<string> {
  const db = createAdminClient()
  const { data, error } = await db.schema('integraciones').from('bsale_sync_runs').insert({
    company_id: companyId,
    status: 'STARTED',
    trigger: 'MANUAL',
  }).select('id').single()
  if (error || !data) throw new Error(error?.message ?? 'No se pudo iniciar la sincronización Bsale.')
  return String(data.id)
}

async function finishBsaleRun(runId: string, status: 'COMPLETED' | 'FAILED', errorMessage: string | null, detailsCount = 0) {
  const db = createAdminClient()
  await db.schema('integraciones').from('bsale_sync_runs').update({
    status,
    completed_at: new Date().toISOString(),
    documents_count: status === 'COMPLETED' ? 1 : 0,
    document_details_count: detailsCount,
    error_message: errorMessage,
  }).eq('id', runId)
}

async function replaceBsaleDocumentSnapshot(companyId: string, runId: string, document: Record<string, unknown>, details: Array<Record<string, unknown>>) {
  assertActiveBsaleCoordinatorLease()
  const { data, error } = await createAdminClient().schema('integraciones').rpc('replace_bsale_document_snapshot_v1', {
    p_company_id: companyId,
    p_run_id: runId,
    p_document: document,
    p_details: details,
  })
  if (error) throw new Error(`No se pudo reemplazar atómicamente el espejo Bsale: ${error.message}`)
  return data as Record<string, unknown>
}

async function loadDifferences(companyId: string, cardId: string, documentId: number) {
  const db = createAdminClient()
  const [{ data: prepared }, { data: current }] = await Promise.all([
    db.schema('logistica').from('sales_order_preparation_lines').select('sku, bsale_variant_id, prepared_quantity').eq('company_id', companyId).eq('card_id', cardId).is('retired_at', null),
    db.schema('integraciones').from('bsale_document_details').select('bsale_id, variant_id, variant_code, quantity').eq('company_id', companyId).eq('bsale_document_id', documentId),
  ])
  const key = (row: Record<string, unknown>) => {
    const sku = String(row.sku ?? row.variant_code ?? '').trim().toUpperCase()
    return sku ? `SKU:${sku}` : row.bsale_variant_id ?? row.variant_id ? `VARIANT:${row.bsale_variant_id ?? row.variant_id}` : null
  }
  const quantities = (rows: Record<string, unknown>[], field: string) => {
    const map = new Map<string, number>()
    for (const row of rows) {
      const identity = key(row)
      if (!identity) continue
      map.set(identity, (map.get(identity) ?? 0) + Number(row[field] ?? 0))
    }
    return map
  }
  const expected = quantities((prepared ?? []) as Record<string, unknown>[], 'prepared_quantity')
  const observed = quantities((current ?? []) as Record<string, unknown>[], 'quantity')
  return [...new Set([...expected.keys(), ...observed.keys()])]
    .sort()
    .filter(identity => (expected.get(identity) ?? 0) !== (observed.get(identity) ?? 0))
    .map(identity => ({ identity, preparedQuantity: expected.get(identity) ?? 0, bsaleQuantity: observed.get(identity) ?? 0, difference: (observed.get(identity) ?? 0) - (expected.get(identity) ?? 0) }))
}

export async function syncSalesOrderPreparationIncident(incidentId: string): Promise<PreparationIncidentSyncResult> {
  let auth
  try {
    auth = await requireWmsPermission('logistica.preparation.manage')
  } catch (error) {
    return result('UNABLE_TO_VERIFY', incidentId, null, null, null, error instanceof Error ? error.message : 'No autorizado para gestionar incidencias.')
  }

  const db = await createClient()
  const { data: incident, error: incidentError } = await db.schema('logistica').from('sales_order_preparation_incidents').select('id, card_id, company_id, status').eq('id', incidentId).eq('company_id', auth.companyId).maybeSingle()
  if (incidentError || !incident) return result('UNABLE_TO_VERIFY', incidentId, null, null, null, 'No se encontró la incidencia en la empresa activa.')
  const row = incident as IncidentRow
  if (row.status !== 'OPEN') return result('ALREADY_RESOLVED', incidentId, row.card_id, null, null, 'La incidencia ya no está abierta; se conserva su historial.')

  const { data: card, error: cardError } = await db.schema('logistica').from('sales_order_preparation_cards').select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id').eq('id', row.card_id).eq('company_id', auth.companyId).maybeSingle()
  if (cardError || !card) return result('UNABLE_TO_VERIFY', incidentId, row.card_id, null, null, 'No se pudo identificar la tarjeta original.')
  const cardRow = card as CardRow
  if (!cardRow.canonical_bsale_token || !cardRow.bsale_nv_folio) return result('UNABLE_TO_VERIFY', incidentId, cardRow.id, null, null, 'La identidad canónica de la Nota de Venta está incompleta.')

  const activeCardOp = await findActiveBsaleSyncOperation({
    companyId: auth.companyId,
    operationKinds: PREPARATION_CARD_QUEUE_OPERATIONS,
    resourceKey: `card:${cardRow.id}`,
  })
  if (activeCardOp) {
    return {
      ...result(
        'UNABLE_TO_VERIFY',
        incidentId,
        cardRow.id,
        cardRow.current_bsale_nv_id,
        null,
        activeCardOp.status === 'PENDING'
          ? 'Esta Nota de Venta ya tiene una sincronización en espera; se ejecutará automáticamente.'
          : 'Esta Nota de Venta ya se está sincronizando con Bsale.',
      ),
      queued: activeCardOp.status === 'PENDING',
      queueRequestId: activeCardOp.requestId,
      queueStatus: activeCardOp.status,
      deduplicated: true,
    }
  }

  const incidentInFlightKey = `incident:${auth.companyId}:${cardRow.id}`
  if (inFlightCardSyncs.has(incidentInFlightKey) || inFlightCardSyncs.has(`${auth.companyId}:${cardRow.id}`)) {
    return {
      ...result(
        'UNABLE_TO_VERIFY',
        incidentId,
        cardRow.id,
        cardRow.current_bsale_nv_id,
        null,
        'Esta Nota de Venta ya se está sincronizando con Bsale.',
      ),
      queued: false,
      queueRequestId: null,
      queueStatus: 'RUNNING',
      deduplicated: true,
    }
  }

  inFlightCardSyncs.add(incidentInFlightKey)
  let runId: string | null = null
  let operationalLockAcquired = false
  try {
    runId = await createBsaleRun(auth.companyId)
    const operationalLockName = 'bsale_operational_prep_sync'
    operationalLockAcquired = await acquireOperationalBsaleSyncLock(auth.companyId, operationalLockName, runId, 10, {
      operationKind: 'INCIDENT_SYNC',
      resourceKey: `card:${cardRow.id}`,
    })
    if (!operationalLockAcquired) {
      const enqueued = getBsaleSyncRolloutConfig().queueEnabled
        ? await ensureBsaleSyncQueueRuntimeRegistered().enqueue({
          companyId: auth.companyId,
          operationKind: 'INCIDENT_SYNC',
          lockName: operationalLockName,
          resourceKey: `card:${cardRow.id}`,
          requestedBy: auth.user.id,
          triggerType: 'MANUAL',
          ttlSeconds: 10 * 60,
          payload: { incidentId, cardId: cardRow.id },
        }).catch(() => null)
        : null
      const alreadyRunning = Boolean(enqueued?.alreadyRunning)
      await finishBsaleRun(runId, 'FAILED', alreadyRunning
        ? 'Esta Nota de Venta ya se está sincronizando con Bsale.'
        : 'Ya existe una sincronización de Notas de Venta en curso. Solicitud encolada.')
      return {
        ...result(
          'UNABLE_TO_VERIFY',
          incidentId,
          cardRow.id,
          cardRow.current_bsale_nv_id,
          runId,
          alreadyRunning
            ? 'Esta Nota de Venta ya se está sincronizando con Bsale.'
            : 'Ya existe una sincronización de Notas de Venta en curso. Tu solicitud quedó en espera y se ejecutará automáticamente.',
        ),
        queued: Boolean(enqueued?.enqueued),
        queueRequestId: enqueued?.requestId ?? null,
        queueStatus: enqueued?.enqueued ? 'PENDING' : (alreadyRunning ? 'RUNNING' : null),
        deduplicated: Boolean(enqueued?.deduplicated),
      }
    }
    const identity = { companyId: auth.companyId, cardId: cardRow.id, status: cardRow.status, canonicalToken: cardRow.canonical_bsale_token, historicalBsaleId: cardRow.bsale_nv_id, currentBsaleId: cardRow.current_bsale_nv_id, folio: cardRow.bsale_nv_folio }
    const live = await createBsalePreparationCommercialProvider().getCurrentVersion(identity, composeBsaleProtectedSignal({ signal: AbortSignal.timeout(30_000) }) ?? AbortSignal.timeout(30_000))
    const currentBsaleNvId = live.identity.currentBsaleId
    const hydrated = await hydrateBsaleDocumentsById(createAdminClient(), auth.companyId, [currentBsaleNvId], null, undefined, false)
    const document = hydrated[0]
    if (!document || Number(document.document.id) !== currentBsaleNvId || document.details.length !== live.lines.length) throw new Error('La sincronización de la NV quedó incompleta.')
    const documentSnapshot = mapBsaleDocument(auth.companyId, runId, document.document) as Record<string, unknown>
    const detailSnapshots = mapBsaleDocumentDetails(auth.companyId, runId, currentBsaleNvId, document.details) as Array<Record<string, unknown>>
    const replacement = await replaceBsaleDocumentSnapshot(auth.companyId, runId, documentSnapshot, detailSnapshots)
    const admin = createAdminClient()
    const { error: pointerError } = await admin.schema('logistica').from('sales_order_preparation_cards').update({ current_bsale_nv_id: currentBsaleNvId, updated_at: new Date().toISOString() }).eq('id', cardRow.id).eq('company_id', auth.companyId)
    if (pointerError) throw new Error(`No se pudo actualizar la versión canónica de la tarjeta: ${pointerError.message}`)
    const { data: mirror } = await admin.schema('integraciones').from('bsale_documents').select('bsale_sync_run_id').eq('company_id', auth.companyId).eq('bsale_id', currentBsaleNvId).maybeSingle()
    const { data: mirrorDetails } = await admin.schema('integraciones').from('bsale_document_details').select('bsale_sync_run_id').eq('company_id', auth.companyId).eq('bsale_document_id', currentBsaleNvId)
    if (replacement.document_id !== currentBsaleNvId || mirror?.bsale_sync_run_id !== runId || (mirrorDetails ?? []).some(detail => detail.bsale_sync_run_id !== runId)) throw new Error('La cabecera y las líneas no pertenecen a una misma corrida completa.')
    const { data: verification, error: verificationError } = await admin.schema('logistica').rpc('verify_open_preparation_incidents_v1', { p_company_id: auth.companyId, p_bsale_nv_ids: [currentBsaleNvId] })
    if (verificationError) throw new Error(`No se pudo verificar la incidencia: ${verificationError.message}`)
    const { data: refreshed } = await admin.schema('logistica').from('sales_order_preparation_incidents').select('status, verification_status').eq('id', incidentId).maybeSingle()
    const differences = await loadDifferences(auth.companyId, cardRow.id, currentBsaleNvId)
    if (refreshed?.status === 'RESOLVED' && refreshed.verification_status === 'MATCHED') return result('RESOLVED', incidentId, cardRow.id, currentBsaleNvId, runId, 'La conciliación comercial fue exitosa.', verification as Record<string, unknown>)
    return result('PENDING', incidentId, cardRow.id, currentBsaleNvId, runId, 'La Nota de Venta todavía presenta diferencias con lo preparado/auditado.', verification as Record<string, unknown>, differences)
  } catch (error) {
    if (runId) await finishBsaleRun(runId, 'FAILED', error instanceof Error ? error.message : 'Error de sincronización.')
    return result('UNABLE_TO_VERIFY', incidentId, cardRow.id, cardRow.current_bsale_nv_id, runId, error instanceof Error ? error.message : 'La comprobación no pudo completarse.')
  } finally {
    if (operationalLockAcquired && runId) await releaseOperationalBsaleSyncLock(auth.companyId, 'bsale_operational_prep_sync', runId)
    inFlightCardSyncs.delete(incidentInFlightKey)
  }
}

function cardSyncResult(
  params: Omit<PreparationCardSyncResult, 'autoMovedToAudit' | 'blockReason' | 'blockMessage'> & {
    autoMovedToAudit?: boolean
    blockReason?: string | null
    blockMessage?: string | null
  },
): PreparationCardSyncResult {
  return {
    ...params,
    autoMovedToAudit: params.autoMovedToAudit ?? false,
    blockReason: params.blockReason ?? null,
    blockMessage: params.blockMessage ?? null,
  }
}

/**
 * Bloques 2A + 2B: sincronización puntual y manual de UNA Nota de Venta en Preparación,
 * seguida de reconciliación oficial (reutilizando Bloque 1) y avance automático a
 * Auditoría únicamente cuando el pedido está 100% conforme.
 * No altera sincronizaciones globales, crons ni cursores, y jamás acepta diferencias
 * comerciales, cierra incidencias ni confirma líneas físicas automáticamente.
 */
export async function syncSalesOrderPreparationCardFromBsale(cardId: string): Promise<PreparationCardSyncResult> {
  let auth: Awaited<ReturnType<typeof requireWmsPermission>>
  try {
    auth = await requireWmsPermission('logistica.preparation.manage')
  } catch (error) {
    return cardSyncResult({
      ok: false,
      status: 'ERROR',
      cardId,
      previousBsaleNvId: null,
      currentBsaleNvId: null,
      substitutedDocument: false,
      detailCount: 0,
      syncRunId: null,
      syncedAt: null,
      message: error instanceof Error ? error.message : 'No autorizado para sincronizar Notas de Venta.',
    })
  }

  const inFlightKey = `${auth.companyId}:${cardId}`
  if (inFlightCardSyncs.has(inFlightKey)) {
    return cardSyncResult({
      ok: false,
      status: 'IN_PROGRESS',
      cardId,
      previousBsaleNvId: null,
      currentBsaleNvId: null,
      substitutedDocument: false,
      detailCount: 0,
      syncRunId: null,
      syncedAt: null,
      queued: false,
      queueRequestId: null,
      queueStatus: 'RUNNING',
      deduplicated: true,
      message: 'Esta Nota de Venta ya se está sincronizando con Bsale.',
    })
  }

  inFlightCardSyncs.add(inFlightKey)
  let runId: string | null = null
  let runCompleted = false
  let operationalLockAcquired = false
  let previousBsaleNvId: number | null = null

  try {
    const db = await createClient()
    const { data: card, error: cardError } = await db.schema('logistica')
      .from('sales_order_preparation_cards')
      .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id')
      .eq('id', cardId)
      .eq('company_id', auth.companyId)
      .maybeSingle()

    if (cardError || !card) {
      return cardSyncResult({
        ok: false,
        status: 'ERROR',
        cardId,
        previousBsaleNvId: null,
        currentBsaleNvId: null,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        message: 'No se encontró la tarjeta en la empresa activa.',
      })
    }

    const cardRow = card as CardRow
    previousBsaleNvId = cardRow.current_bsale_nv_id ?? cardRow.bsale_nv_id

    if (cardRow.status !== 'IN_PREPARATION') {
      return cardSyncResult({
        ok: false,
        status: 'INVALID_STATE',
        cardId: cardRow.id,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        message: 'La sincronización individual solo aplica a tarjetas en estado En preparación.',
      })
    }

    if (!cardRow.canonical_bsale_token || !cardRow.bsale_nv_folio) {
      return cardSyncResult({
        ok: false,
        status: 'INVALID_STATE',
        cardId: cardRow.id,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        message: 'La identidad documental de esta Nota de Venta está incompleta y no puede sincronizarse automáticamente.',
      })
    }

    const activeCardOp = await findActiveBsaleSyncOperation({
      companyId: auth.companyId,
      operationKinds: PREPARATION_CARD_QUEUE_OPERATIONS,
      resourceKey: `card:${cardRow.id}`,
    })
    if (activeCardOp) {
      return cardSyncResult({
        ok: false,
        status: activeCardOp.status === 'RUNNING' ? 'IN_PROGRESS' : 'CONFLICT',
        cardId: cardRow.id,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        queued: activeCardOp.status === 'PENDING',
        queueRequestId: activeCardOp.requestId,
        queueStatus: activeCardOp.status,
        deduplicated: true,
        message: activeCardOp.status === 'PENDING'
          ? 'Esta Nota de Venta ya tiene una solicitud en espera y se procesará automáticamente.'
          : 'Esta Nota de Venta ya se está sincronizando con Bsale.',
      })
    }

    runId = await createBsaleRun(auth.companyId)

    const operationalLockName = 'bsale_operational_prep_sync'
    operationalLockAcquired = await acquireOperationalBsaleSyncLock(auth.companyId, operationalLockName, runId, 10, {
      operationKind: 'CARD_SYNC',
      resourceKey: `card:${cardRow.id}`,
    })
    if (!operationalLockAcquired) {
      const enqueued = getBsaleSyncRolloutConfig().queueEnabled
        ? await ensureBsaleSyncQueueRuntimeRegistered().enqueue({
          companyId: auth.companyId,
          operationKind: 'CARD_SYNC',
          lockName: operationalLockName,
          resourceKey: `card:${cardRow.id}`,
          requestedBy: auth.user.id,
          triggerType: 'MANUAL',
          ttlSeconds: 10 * 60,
          payload: { cardId: cardRow.id },
        }).catch(() => null)
        : null
      const alreadyRunning = Boolean(enqueued?.alreadyRunning)
      await finishBsaleRun(runId, 'FAILED', alreadyRunning
        ? 'Esta Nota de Venta ya se está sincronizando con Bsale.'
        : 'Sincronización operativa de Bsale en curso.')
      runCompleted = true
      return cardSyncResult({
        ok: false,
        status: alreadyRunning ? 'IN_PROGRESS' : 'CONFLICT',
        cardId: cardRow.id,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: runId,
        syncedAt: null,
        queued: Boolean(enqueued?.enqueued),
        queueRequestId: enqueued?.requestId ?? null,
        queueStatus: enqueued?.enqueued ? 'PENDING' : (alreadyRunning ? 'RUNNING' : null),
        deduplicated: Boolean(enqueued?.deduplicated),
        message: alreadyRunning
          ? 'Esta Nota de Venta ya se está sincronizando con Bsale.'
          : 'Ya existe una sincronización de Bsale en curso. La solicitud quedó en espera y se procesará automáticamente.',
      })
    }

    const identity = {
      companyId: auth.companyId,
      cardId: cardRow.id,
      status: cardRow.status,
      canonicalToken: cardRow.canonical_bsale_token,
      historicalBsaleId: cardRow.bsale_nv_id,
      currentBsaleId: cardRow.current_bsale_nv_id,
      folio: cardRow.bsale_nv_folio,
    }
    const live = await createBsalePreparationCommercialProvider().getCurrentVersion(identity, composeBsaleProtectedSignal({ signal: AbortSignal.timeout(30_000) }) ?? AbortSignal.timeout(30_000))
    const currentBsaleNvId = live.identity.currentBsaleId

    const admin = createAdminClient()
    const hydrated = await hydrateBsaleDocumentsById(admin, auth.companyId, [currentBsaleNvId], null, undefined, false)
    const document = hydrated[0]
    if (!document || Number(document.document.id) !== currentBsaleNvId || document.details.length !== live.lines.length) {
      throw new Error('La lectura de la Nota de Venta desde Bsale quedó incompleta. No se modificó el estado local.')
    }

    const documentSnapshot = mapBsaleDocument(auth.companyId, runId, document.document) as Record<string, unknown>
    const detailSnapshots = mapBsaleDocumentDetails(auth.companyId, runId, currentBsaleNvId, document.details) as Array<Record<string, unknown>>
    const replacement = await replaceBsaleDocumentSnapshot(auth.companyId, runId, documentSnapshot, detailSnapshots)
    runCompleted = true

    const syncedAt = new Date().toISOString()
    let updatedCardRow: { id: string; status: string } | null = null
    let pointerError: { message: string } | null = null

    for (let attempt = 0; attempt < 3; attempt++) {
      const pointerRes = await admin.schema('logistica')
        .from('sales_order_preparation_cards')
        .update({ current_bsale_nv_id: currentBsaleNvId, updated_at: syncedAt })
        .eq('id', cardRow.id)
        .eq('company_id', auth.companyId)
        .eq('status', 'IN_PREPARATION')
        .select('id, status')
        .maybeSingle()

      updatedCardRow = pointerRes.data as { id: string; status: string } | null
      pointerError = pointerRes.error
      if (!pointerError) break
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }

    if (pointerError) {
      throw new Error(`No se pudo actualizar la referencia vigente de la tarjeta tras reintentos: ${pointerError.message}. Vuelve a pulsar «Sincronizar» para completar la actualización.`)
    }
    if (!updatedCardRow || updatedCardRow.status !== 'IN_PREPARATION') {
      return cardSyncResult({
        ok: false,
        status: 'INVALID_STATE',
        cardId: cardRow.id,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument: previousBsaleNvId !== null && previousBsaleNvId !== currentBsaleNvId,
        detailCount: detailSnapshots.length,
        syncRunId: runId,
        syncedAt,
        message: 'La tarjeta cambió de estado mientras se sincronizaba y no fue modificada.',
      })
    }

    const { data: mirror } = await admin.schema('integraciones')
      .from('bsale_documents')
      .select('bsale_sync_run_id')
      .eq('company_id', auth.companyId)
      .eq('bsale_id', currentBsaleNvId)
      .maybeSingle()
    const { data: mirrorDetails } = await admin.schema('integraciones')
      .from('bsale_document_details')
      .select('bsale_sync_run_id')
      .eq('company_id', auth.companyId)
      .eq('bsale_document_id', currentBsaleNvId)

    if (
      replacement.document_id !== currentBsaleNvId
      || mirror?.bsale_sync_run_id !== runId
      || (mirrorDetails ?? []).some(detail => detail.bsale_sync_run_id !== runId)
    ) {
      throw new Error('La actualización del espejo Bsale no quedó consistente para esta corrida.')
    }

    // Liberar el lock de sincronización Bsale antes de la reconciliación/transición;
    // inFlightCardSyncs permanece activo para impedir ejecuciones duplicadas en esta tarjeta.
    if (operationalLockAcquired && runId) {
      await releaseOperationalBsaleSyncLock(auth.companyId, 'bsale_operational_prep_sync', runId)
      operationalLockAcquired = false
    }

    const substitutedDocument = previousBsaleNvId !== null && previousBsaleNvId !== currentBsaleNvId
    const syncSummary = substitutedDocument
      ? `NV #${cardRow.bsale_nv_folio} sincronizada desde Bsale (nueva versión documental #${currentBsaleNvId}).`
      : `NV #${cardRow.bsale_nv_folio} sincronizada desde Bsale (${detailSnapshots.length} ${detailSnapshots.length === 1 ? 'línea' : 'líneas'}).`

    // Bloque 2B: reconciliación posterior a sincronización usando únicamente las
    // validaciones oficiales vigentes (líneas persistidas, incidencias abiertas y
    // verificación comercial en vivo sin caché).
    const [{ data: activeLines, error: linesError }, { count: openIncidentCount, error: incidentsError }, commercialAlertRes] = await Promise.all([
      admin.schema('logistica')
        .from('sales_order_preparation_lines')
        .select('id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id, sku, product_name, requested_quantity, prepared_quantity, line_status, excluded_from_dispatch, confirmed_by, confirmed_at')
        .eq('company_id', auth.companyId)
        .eq('card_id', cardRow.id)
        .is('retired_at', null),
      admin.schema('logistica')
        .from('sales_order_preparation_incidents')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', auth.companyId)
        .eq('card_id', cardRow.id)
        .eq('status', 'OPEN'),
      getSalesOrderPreparationCommercialAlert(cardRow.id, { bypassCache: true }),
    ])

    if (linesError || incidentsError) {
      const reasonMsg = linesError?.message ?? incidentsError?.message ?? 'No se pudo verificar el estado operativo de las líneas.'
      return cardSyncResult({
        ok: true,
        status: 'SYNCED',
        cardId: cardRow.id,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument,
        detailCount: detailSnapshots.length,
        syncRunId: runId,
        syncedAt,
        autoMovedToAudit: false,
        blockReason: 'RECONCILIATION_READ_ERROR',
        blockMessage: reasonMsg,
        message: `${syncSummary} Permanece En preparación: ${reasonMsg}`,
      })
    }

    const decision = evaluatePostSyncAuditTransition({
      cardStatus: updatedCardRow.status,
      lines: (activeLines ?? []) as SalesOrderPreparationLine[],
      openCommercialIncidentCount: openIncidentCount ?? 0,
      commercialAlertStatus: commercialAlertRes.data?.status ?? 'UNAVAILABLE',
      commercialVerificationSource: commercialAlertRes.data?.verificationSource ?? 'NONE',
      commercialDetail: commercialAlertRes.error ?? commercialAlertRes.data?.detail ?? null,
    })

    if (!decision.shouldAdvanceToAudit) {
      return cardSyncResult({
        ok: true,
        status: 'SYNCED',
        cardId: cardRow.id,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument,
        detailCount: detailSnapshots.length,
        syncRunId: runId,
        syncedAt,
        autoMovedToAudit: false,
        blockReason: decision.reason,
        blockMessage: decision.message,
        message: decision.message ? `${syncSummary} Permanece En preparación: ${decision.message}` : `${syncSummary} Permanece En preparación.`,
      })
    }

    // Reutilizar la transición oficial del Bloque 1 (revalida permisos, verificación
    // comercial en vivo y RPC logistica.move_sales_order_preparation_card con FOR UPDATE).
    const moveResult = await moveSalesOrderPreparationCard({
      cardId: cardRow.id,
      toStatus: 'IN_AUDIT',
      observation: 'Avance automático a Auditoría tras sincronización y conciliación completa con Bsale.',
    })

    if (!moveResult.ok) {
      const blockMessage = moveResult.error || 'No se cumplieron todas las condiciones para avanzar a Auditoría.'
      return cardSyncResult({
        ok: true,
        status: 'SYNCED',
        cardId: cardRow.id,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument,
        detailCount: detailSnapshots.length,
        syncRunId: runId,
        syncedAt,
        autoMovedToAudit: false,
        blockReason: 'TRANSITION_GUARD_BLOCKED',
        blockMessage,
        message: `${syncSummary} Permanece En preparación: ${blockMessage}`,
      })
    }

    return cardSyncResult({
      ok: true,
      status: 'SYNCED_AND_MOVED_TO_AUDIT',
      cardId: cardRow.id,
      previousBsaleNvId,
      currentBsaleNvId,
      substitutedDocument,
      detailCount: detailSnapshots.length,
      syncRunId: runId,
      syncedAt,
      autoMovedToAudit: true,
      blockReason: null,
      blockMessage: null,
      message: substitutedDocument
        ? `NV #${cardRow.bsale_nv_folio} sincronizada (versión #${currentBsaleNvId}), conciliada y enviada automáticamente a Auditoría.`
        : `NV #${cardRow.bsale_nv_folio} sincronizada, conciliada y enviada automáticamente a Auditoría.`,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'No se pudo sincronizar la Nota de Venta desde Bsale.'
    if (runId && !runCompleted) {
      await finishBsaleRun(runId, 'FAILED', errorMessage)
    }
    return cardSyncResult({
      ok: false,
      status: 'ERROR',
      cardId,
      previousBsaleNvId,
      currentBsaleNvId: previousBsaleNvId,
      substitutedDocument: false,
      detailCount: 0,
      syncRunId: runId,
      syncedAt: null,
      message: errorMessage,
    })
  } finally {
    if (operationalLockAcquired && runId) {
      await releaseOperationalBsaleSyncLock(auth.companyId, 'bsale_operational_prep_sync', runId)
    }
    inFlightCardSyncs.delete(inFlightKey)
  }
}

export type AuditCardSyncStatus =
  | 'SYNCED_READY'
  | 'SYNCED_PENDING'
  | 'CONFLICT'
  | 'IN_PROGRESS'
  | 'INVALID_STATE'
  | 'ERROR'

export type AuditCardSyncResult = {
  ok: boolean
  status: AuditCardSyncStatus
  cardId: string
  auditId: string | null
  previousBsaleNvId: number | null
  currentBsaleNvId: number | null
  substitutedDocument: boolean
  detailCount: number
  syncRunId: string | null
  syncedAt: string | null
  commercialVerification: SalesOrderAuditCommercialVerification | null
  openAuditIncidentsCount: number
  canFinalize: boolean
  message: string
  queued?: boolean
  queueRequestId?: string | null
  queueStatus?: 'PENDING' | 'RUNNING' | null
  deduplicated?: boolean
}

function auditSyncResult(params: AuditCardSyncResult): AuditCardSyncResult {
  return params
}

/**
 * Bloque 3A: sincronización puntual de UNA Nota de Venta en Auditoría (IN_AUDIT).
 * Reutiliza la infraestructura individual de Bsale (2A/2B) y la verificación comercial
 * oficial de Auditoría (verifySalesOrderAuditCommercial), respetando permisos y bloqueos
 * de Auditoría. Jamás altera cantidades auditadas, incidencias físicas, fotos/evidencias
 * ni auditorías finalizadas (AUDITED), y jamás finaliza automáticamente.
 */
export async function syncSalesOrderAuditCardFromBsale(cardId: string): Promise<AuditCardSyncResult> {
  let auth: Awaited<ReturnType<typeof requireWmsPermission>>
  try {
    auth = await requireWmsPermission('logistica.audit.manage')
  } catch (error) {
    return auditSyncResult({
      ok: false,
      status: 'ERROR',
      cardId,
      auditId: null,
      previousBsaleNvId: null,
      currentBsaleNvId: null,
      substitutedDocument: false,
      detailCount: 0,
      syncRunId: null,
      syncedAt: null,
      commercialVerification: null,
      openAuditIncidentsCount: 0,
      canFinalize: false,
      message: error instanceof Error ? error.message : 'No autorizado para sincronizar en Auditoría.',
    })
  }

  const inFlightKey = `audit:${auth.companyId}:${cardId}`
  if (inFlightCardSyncs.has(inFlightKey)) {
    return auditSyncResult({
      ok: false,
      status: 'IN_PROGRESS',
      cardId,
      auditId: null,
      previousBsaleNvId: null,
      currentBsaleNvId: null,
      substitutedDocument: false,
      detailCount: 0,
      syncRunId: null,
      syncedAt: null,
      commercialVerification: null,
      openAuditIncidentsCount: 0,
      canFinalize: false,
      queued: false,
      queueRequestId: null,
      queueStatus: 'RUNNING',
      deduplicated: true,
      message: 'Esta Nota de Venta en Auditoría ya se está sincronizando con Bsale.',
    })
  }

  inFlightCardSyncs.add(inFlightKey)
  let runId: string | null = null
  let runCompleted = false
  let operationalLockAcquired = false
  let previousBsaleNvId: number | null = null
  let auditId: string | null = null

  try {
    const db = await createClient()
    const { data: card, error: cardError } = await db.schema('logistica')
      .from('sales_order_preparation_cards')
      .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id')
      .eq('id', cardId)
      .eq('company_id', auth.companyId)
      .maybeSingle()

    if (cardError || !card) {
      return auditSyncResult({
        ok: false,
        status: 'ERROR',
        cardId,
        auditId: null,
        previousBsaleNvId: null,
        currentBsaleNvId: null,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        commercialVerification: null,
        openAuditIncidentsCount: 0,
        canFinalize: false,
        message: 'No se encontró la tarjeta en la empresa activa.',
      })
    }

    const cardRow = card as CardRow
    previousBsaleNvId = cardRow.current_bsale_nv_id ?? cardRow.bsale_nv_id

    if (cardRow.status !== 'IN_AUDIT') {
      return auditSyncResult({
        ok: false,
        status: 'INVALID_STATE',
        cardId: cardRow.id,
        auditId: null,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        commercialVerification: null,
        openAuditIncidentsCount: 0,
        canFinalize: false,
        message: cardRow.status === 'AUDITED'
          ? 'La Auditoría ya fue finalizada y no puede modificarse ni sincronizarse.'
          : 'La sincronización de Auditoría solo aplica a tarjetas en estado En auditoría.',
      })
    }

    if (!cardRow.canonical_bsale_token || !cardRow.bsale_nv_folio) {
      return auditSyncResult({
        ok: false,
        status: 'INVALID_STATE',
        cardId: cardRow.id,
        auditId: null,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        commercialVerification: null,
        openAuditIncidentsCount: 0,
        canFinalize: false,
        message: 'La identidad documental de esta Nota de Venta está incompleta.',
      })
    }

    const admin = createAdminClient()
    const { data: openAudit, error: openAuditError } = await admin.schema('logistica')
      .from('sales_order_audits')
      .select('id, status, locked_by_user_id')
      .eq('company_id', auth.companyId)
      .eq('card_id', cardRow.id)
      .eq('status', 'OPEN')
      .order('cycle_no', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (openAuditError || !openAudit) {
      return auditSyncResult({
        ok: false,
        status: 'INVALID_STATE',
        cardId: cardRow.id,
        auditId: null,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        commercialVerification: null,
        openAuditIncidentsCount: 0,
        canFinalize: false,
        message: 'La Auditoría aún no ha sido tomada o ya fue cerrada.',
      })
    }

    auditId = String(openAudit.id)
    if (openAudit.locked_by_user_id && String(openAudit.locked_by_user_id) !== auth.user.id) {
      return auditSyncResult({
        ok: false,
        status: 'INVALID_STATE',
        cardId: cardRow.id,
        auditId,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        commercialVerification: null,
        openAuditIncidentsCount: 0,
        canFinalize: false,
        message: 'Esta Auditoría está asignada a otro usuario. Solo el auditor responsable puede sincronizarla.',
      })
    }

    const activeAuditCardOp = await findActiveBsaleSyncOperation({
      companyId: auth.companyId,
      operationKinds: PREPARATION_CARD_QUEUE_OPERATIONS,
      resourceKey: `card:${cardRow.id}`,
    })
    if (activeAuditCardOp) {
      return auditSyncResult({
        ok: false,
        status: activeAuditCardOp.status === 'RUNNING' ? 'IN_PROGRESS' : 'CONFLICT',
        cardId: cardRow.id,
        auditId,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: null,
        syncedAt: null,
        commercialVerification: null,
        openAuditIncidentsCount: 0,
        canFinalize: false,
        queued: activeAuditCardOp.status === 'PENDING',
        queueRequestId: activeAuditCardOp.requestId,
        queueStatus: activeAuditCardOp.status,
        deduplicated: true,
        message: activeAuditCardOp.status === 'PENDING'
          ? 'Esta Nota de Venta en Auditoría ya tiene una solicitud en espera y se procesará automáticamente.'
          : 'Esta Nota de Venta en Auditoría ya se está sincronizando con Bsale.',
      })
    }

    runId = await createBsaleRun(auth.companyId)
    const operationalLockName = 'bsale_operational_prep_sync'
    operationalLockAcquired = await acquireOperationalBsaleSyncLock(auth.companyId, operationalLockName, runId, 10, {
      operationKind: 'AUDIT_SYNC',
      resourceKey: `card:${cardRow.id}`,
    })
    if (!operationalLockAcquired) {
      const enqueued = getBsaleSyncRolloutConfig().queueEnabled
        ? await ensureBsaleSyncQueueRuntimeRegistered().enqueue({
          companyId: auth.companyId,
          operationKind: 'AUDIT_SYNC',
          lockName: operationalLockName,
          resourceKey: `card:${cardRow.id}`,
          requestedBy: auth.user.id,
          triggerType: 'MANUAL',
          ttlSeconds: 10 * 60,
          payload: { cardId: cardRow.id, auditId },
        }).catch(() => null)
        : null
      const alreadyRunning = Boolean(enqueued?.alreadyRunning)
      await finishBsaleRun(runId, 'FAILED', alreadyRunning
        ? 'Esta Nota de Venta en Auditoría ya se está sincronizando con Bsale.'
        : 'Sincronización operativa de Bsale en curso.')
      runCompleted = true
      return auditSyncResult({
        ok: false,
        status: alreadyRunning ? 'IN_PROGRESS' : 'CONFLICT',
        cardId: cardRow.id,
        auditId,
        previousBsaleNvId,
        currentBsaleNvId: previousBsaleNvId,
        substitutedDocument: false,
        detailCount: 0,
        syncRunId: runId,
        syncedAt: null,
        commercialVerification: null,
        openAuditIncidentsCount: 0,
        canFinalize: false,
        queued: Boolean(enqueued?.enqueued),
        queueRequestId: enqueued?.requestId ?? null,
        queueStatus: enqueued?.enqueued ? 'PENDING' : (alreadyRunning ? 'RUNNING' : null),
        deduplicated: Boolean(enqueued?.deduplicated),
        message: alreadyRunning
          ? 'Esta Nota de Venta en Auditoría ya se está sincronizando con Bsale.'
          : 'Ya existe una sincronización de Bsale en curso. La solicitud quedó en espera y se procesará automáticamente.',
      })
    }

    const identity = {
      companyId: auth.companyId,
      cardId: cardRow.id,
      status: cardRow.status,
      canonicalToken: cardRow.canonical_bsale_token,
      historicalBsaleId: cardRow.bsale_nv_id,
      currentBsaleId: cardRow.current_bsale_nv_id,
      folio: cardRow.bsale_nv_folio,
    }
    const live = await createBsalePreparationCommercialProvider().getCurrentVersion(identity, composeBsaleProtectedSignal({ signal: AbortSignal.timeout(30_000) }) ?? AbortSignal.timeout(30_000))
    const currentBsaleNvId = live.identity.currentBsaleId

    const hydrated = await hydrateBsaleDocumentsById(admin, auth.companyId, [currentBsaleNvId], null, undefined, false)
    const document = hydrated[0]
    if (!document || Number(document.document.id) !== currentBsaleNvId || document.details.length !== live.lines.length) {
      throw new Error('La lectura de la Nota de Venta desde Bsale quedó incompleta. No se modificó el estado local.')
    }

    const documentSnapshot = mapBsaleDocument(auth.companyId, runId, document.document) as Record<string, unknown>
    const detailSnapshots = mapBsaleDocumentDetails(auth.companyId, runId, currentBsaleNvId, document.details) as Array<Record<string, unknown>>
    const replacement = await replaceBsaleDocumentSnapshot(auth.companyId, runId, documentSnapshot, detailSnapshots)
    runCompleted = true

    const syncedAt = new Date().toISOString()
    let updatedCardRow: { id: string; status: string } | null = null
    let pointerError: { message: string } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const pointerRes = await admin.schema('logistica')
        .from('sales_order_preparation_cards')
        .update({ current_bsale_nv_id: currentBsaleNvId, updated_at: syncedAt })
        .eq('id', cardRow.id)
        .eq('company_id', auth.companyId)
        .eq('status', 'IN_AUDIT')
        .select('id, status')
        .maybeSingle()

      updatedCardRow = pointerRes.data as { id: string; status: string } | null
      pointerError = pointerRes.error
      if (!pointerError) break
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }

    if (pointerError) {
      throw new Error(`No se pudo actualizar la referencia vigente de la tarjeta tras reintentos: ${pointerError.message}. Vuelve a pulsar «Sincronizar».`)
    }
    if (!updatedCardRow || updatedCardRow.status !== 'IN_AUDIT') {
      return auditSyncResult({
        ok: false,
        status: 'INVALID_STATE',
        cardId: cardRow.id,
        auditId,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument: previousBsaleNvId !== null && previousBsaleNvId !== currentBsaleNvId,
        detailCount: detailSnapshots.length,
        syncRunId: runId,
        syncedAt,
        commercialVerification: null,
        openAuditIncidentsCount: 0,
        canFinalize: false,
        message: 'La tarjeta salió de Auditoría mientras se sincronizaba y no fue modificada.',
      })
    }

    if (replacement.document_id !== currentBsaleNvId) {
      throw new Error('La actualización del espejo Bsale no quedó consistente para esta corrida.')
    }

    if (operationalLockAcquired && runId) {
      await releaseOperationalBsaleSyncLock(auth.companyId, 'bsale_operational_prep_sync', runId)
      operationalLockAcquired = false
    }

    const substitutedDocument = previousBsaleNvId !== null && previousBsaleNvId !== currentBsaleNvId

    // Reutilizar la verificación comercial oficial de Auditoría y la lectura de pre-cierre
    // sin alterar cantidades auditadas, incidencias físicas, fotos ni finalizar automáticamente.
    const [commercialRes, finalizationRes, { count: openAuditIncidentsCount }] = await Promise.all([
      verifySalesOrderAuditCommercial({
        auditId,
        cardId: cardRow.id,
        companyId: auth.companyId,
      }),
      getSalesOrderAuditFinalizationStatus(auditId),
      admin.schema('logistica')
        .from('sales_order_audit_incidents')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', auth.companyId)
        .eq('audit_id', auditId)
        .eq('status', 'OPEN'),
    ])

    const commercialVerification = commercialRes.data
    const openIncidents = openAuditIncidentsCount ?? 0
    const physicalCanFinalize = Boolean(finalizationRes.data?.can_finalize)

    if (commercialRes.error || !commercialVerification) {
      return auditSyncResult({
        ok: true,
        status: 'SYNCED_PENDING',
        cardId: cardRow.id,
        auditId,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument,
        detailCount: detailSnapshots.length,
        syncRunId: runId,
        syncedAt,
        commercialVerification: null,
        openAuditIncidentsCount: openIncidents,
        canFinalize: false,
        message: `NV #${cardRow.bsale_nv_folio} sincronizada, pero no se pudo completar la verificación comercial: ${commercialRes.error || 'sin respuesta'}. La auditoría permanece abierta.`,
      })
    }

    const commercialConforming = commercialVerification.status === 'READY_TO_INVOICE' && commercialVerification.differences.length === 0
    const canFinalize = commercialConforming && physicalCanFinalize

    if (canFinalize) {
      return auditSyncResult({
        ok: true,
        status: 'SYNCED_READY',
        cardId: cardRow.id,
        auditId,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument,
        detailCount: detailSnapshots.length,
        syncRunId: runId,
        syncedAt,
        commercialVerification,
        openAuditIncidentsCount: openIncidents,
        canFinalize: true,
        message: `NV #${cardRow.bsale_nv_folio} sincronizada y conforme con Bsale. Ya puedes continuar con «Revisar cierre» para finalizar la Auditoría.`,
      })
    }

    const pendingParts: string[] = []
    if (commercialVerification.status === 'INCIDENTS') {
      pendingParts.push(`persisten ${commercialVerification.differences.length} diferencia${commercialVerification.differences.length === 1 ? '' : 's'} comercial${commercialVerification.differences.length === 1 ? '' : 'es'} en Bsale`)
    } else if (commercialVerification.status === 'BLOCKED') {
      pendingParts.push(`verificación comercial bloqueada (${commercialVerification.reason})`)
    }
    if (openIncidents > 0) {
      pendingParts.push(`${openIncidents} incidencia${openIncidents === 1 ? '' : 's'} física${openIncidents === 1 ? '' : 's'} abierta${openIncidents === 1 ? '' : 's'}`)
    }
    if (!physicalCanFinalize && finalizationRes.data?.blockers?.length) {
      pendingParts.push(finalizationRes.data.blockers[0].message)
    }

    return auditSyncResult({
      ok: true,
      status: 'SYNCED_PENDING',
      cardId: cardRow.id,
      auditId,
      previousBsaleNvId,
      currentBsaleNvId,
      substitutedDocument,
      detailCount: detailSnapshots.length,
      syncRunId: runId,
      syncedAt,
      commercialVerification,
      openAuditIncidentsCount: openIncidents,
      canFinalize: false,
      message: pendingParts.length > 0
        ? `NV #${cardRow.bsale_nv_folio} sincronizada. La auditoría permanece abierta: ${pendingParts.join('; ')}.`
        : `NV #${cardRow.bsale_nv_folio} sincronizada. La auditoría permanece abierta hasta completar las validaciones de cierre.`,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'No se pudo sincronizar la Nota de Venta en Auditoría.'
    if (runId && !runCompleted) {
      await finishBsaleRun(runId, 'FAILED', errorMessage)
    }
    return auditSyncResult({
      ok: false,
      status: 'ERROR',
      cardId,
      auditId,
      previousBsaleNvId,
      currentBsaleNvId: previousBsaleNvId,
      substitutedDocument: false,
      detailCount: 0,
      syncRunId: runId,
      syncedAt: null,
      commercialVerification: null,
      openAuditIncidentsCount: 0,
      canFinalize: false,
      message: errorMessage,
    })
  } finally {
    if (operationalLockAcquired && runId) {
      await releaseOperationalBsaleSyncLock(auth.companyId, 'bsale_operational_prep_sync', runId)
    }
    inFlightCardSyncs.delete(inFlightKey)
  }
}
