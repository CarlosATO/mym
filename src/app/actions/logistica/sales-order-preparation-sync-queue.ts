'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireWmsPermission } from './authorization'
import { moveSalesOrderPreparationCard, type SalesOrderPreparationLine } from './sales-order-preparation'
import { getSalesOrderPreparationCommercialAlert } from './sales-order-preparation-commercial'
import { getSalesOrderAuditFinalizationStatus } from './sales-order-audit'
import { verifySalesOrderAuditCommercial } from './sales-order-audit-commercial'
import type {
  AuditCardSyncResult,
  PreparationCardSyncResult,
} from './sales-order-preparation-incident-sync'
import { evaluatePostSyncAuditTransition } from '@/modules/logistica/preparacion-pedidos/preparation-line-validation'
import {
  extractCardIdFromResourceKey,
  readPreparationSyncQueueSnapshotForCompany,
  type PreparationSyncQueueSnapshot,
} from '@/lib/integraciones/bsale-sync-queue-status'

export async function getPreparationSyncQueueSnapshot(params?: {
  trackedRequestIds?: string[]
}): Promise<{ data: PreparationSyncQueueSnapshot | null; error: string | null }> {
  try {
    const auth = await requireWmsPermission('module.logistica.view')
    const snapshot = await readPreparationSyncQueueSnapshotForCompany({
      companyId: auth.companyId,
      trackedRequestIds: params?.trackedRequestIds ?? [],
    })
    return { data: snapshot, error: null }
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : 'No se pudo consultar el estado de sincronización.',
    }
  }
}

export type FinalizeQueuedPreparationSyncResult =
  | {
    ok: true
    kind: 'CARD_SYNC'
    skipped: null
    cardResult: PreparationCardSyncResult
  }
  | {
    ok: true
    kind: 'AUDIT_SYNC'
    skipped: null
    auditResult: AuditCardSyncResult
  }
  | {
    ok: true
    kind: 'INCIDENT_SYNC'
    skipped: null
    cardId: string | null
    incidentResolved: boolean
    message: string
  }
  | {
    ok: false
    kind: string
    skipped: string | null
    message: string
  }

/**
 * Ejecuta la reconciliación operativa oficial posterior a que una solicitud individual
 * (`CARD_SYNC`, `AUDIT_SYNC` o `INCIDENT_SYNC`) haya completado (`COMPLETED`) su
 * actualización atómica del espejo Bsale dentro de `integraciones.bsale_sync_queue`.
 */
export async function finalizeCompletedQueuedPreparationSync(
  requestId: string,
): Promise<FinalizeQueuedPreparationSyncResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId || '')) {
    return { ok: false, kind: 'UNKNOWN', skipped: null, message: 'Identificador de solicitud en cola inválido.' }
  }

  let viewAuth: Awaited<ReturnType<typeof requireWmsPermission>>
  try {
    viewAuth = await requireWmsPermission('module.logistica.view')
  } catch (error) {
    return {
      ok: false,
      kind: 'UNKNOWN',
      skipped: null,
      message: error instanceof Error ? error.message : 'No autorizado.',
    }
  }

  const admin = createAdminClient()
  const { data: queueRow, error: queueError } = await admin
    .schema('integraciones')
    .from('bsale_sync_queue')
    .select('id, company_id, operation_kind, resource_key, status, sync_run_id, payload, completed_at, result_summary, last_error_message')
    .eq('id', requestId)
    .eq('company_id', viewAuth.companyId)
    .maybeSingle()

  if (queueError || !queueRow) {
    return {
      ok: false,
      kind: 'UNKNOWN',
      skipped: null,
      message: queueError?.message ?? 'No se encontró la solicitud de sincronización en la empresa activa.',
    }
  }

  const kind = String(queueRow.operation_kind)
  if (queueRow.status !== 'COMPLETED') {
    return {
      ok: false,
      kind,
      skipped: null,
      message: queueRow.last_error_message
        ? String(queueRow.last_error_message)
        : `La solicitud aún no ha finalizado exitosamente (estado: ${String(queueRow.status)}).`,
    }
  }

  const summary = (queueRow.result_summary && typeof queueRow.result_summary === 'object'
    ? queueRow.result_summary
    : {}) as Record<string, unknown>
  const payload = (queueRow.payload && typeof queueRow.payload === 'object'
    ? queueRow.payload
    : {}) as Record<string, unknown>

  if (typeof summary.skipped === 'string' && summary.skipped) {
    const skipped = summary.skipped
    const messageByReason: Record<string, string> = {
      CARD_LEFT_PREPARATION: 'La tarjeta salió de Preparación antes de ejecutarse la sincronización en cola.',
      CARD_LEFT_AUDIT: 'La tarjeta salió de Auditoría antes de ejecutarse la sincronización en cola.',
      AUDIT_NOT_OPEN: 'La Auditoría ya no se encuentra abierta.',
      AUDIT_ASSIGNED_TO_OTHER_USER: 'La Auditoría pasó a otro usuario antes de ejecutarse la sincronización en cola.',
      CARD_NOT_FOUND: 'No se encontró la tarjeta asociada a la solicitud en cola.',
      INCIDENT_NOT_OPEN: 'La incidencia comercial ya no se encontraba abierta.',
    }
    return {
      ok: false,
      kind,
      skipped,
      message: messageByReason[skipped] ?? `Solicitud omitida (${skipped}).`,
    }
  }

  const cardId = (typeof summary.cardId === 'string' ? summary.cardId : null)
    ?? extractCardIdFromResourceKey(queueRow.resource_key == null ? null : String(queueRow.resource_key))
    ?? (typeof payload.cardId === 'string' ? payload.cardId : null)

  const syncRunId = queueRow.sync_run_id == null ? null : String(queueRow.sync_run_id)
  const syncedAt = queueRow.completed_at == null ? new Date().toISOString() : String(queueRow.completed_at)

  if (kind === 'CARD_SYNC') {
    await requireWmsPermission('logistica.preparation.manage')
    if (summary.reconciled === true && summary.cardResult && typeof summary.cardResult === 'object') {
      return {
        ok: true,
        kind: 'CARD_SYNC',
        skipped: null,
        cardResult: summary.cardResult as PreparationCardSyncResult,
      }
    }
    if (!cardId) {
      return { ok: false, kind, skipped: null, message: 'Solicitud CARD_SYNC sin tarjeta asociada.' }
    }

    const { data: card, error: cardErr } = await admin
      .schema('logistica')
      .from('sales_order_preparation_cards')
      .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, current_bsale_nv_id')
      .eq('id', cardId)
      .eq('company_id', viewAuth.companyId)
      .maybeSingle()

    if (cardErr || !card) {
      return { ok: false, kind, skipped: null, message: 'No se encontró la tarjeta tras completar la sincronización.' }
    }

    const currentBsaleNvId = typeof summary.currentBsaleNvId === 'number'
      ? summary.currentBsaleNvId
      : Number(card.current_bsale_nv_id ?? card.bsale_nv_id)
    const previousBsaleNvId = typeof summary.previousBsaleNvId === 'number'
      ? summary.previousBsaleNvId
      : Number(card.bsale_nv_id)
    const detailCount = typeof summary.detailCount === 'number' ? summary.detailCount : 0
    const substitutedDocument = Boolean(summary.substitutedDocument) || (previousBsaleNvId !== currentBsaleNvId)
    const folio = String(card.bsale_nv_folio ?? summary.nvFolio ?? '')

    if (card.status !== 'IN_PREPARATION') {
      return {
        ok: true,
        kind: 'CARD_SYNC',
        skipped: null,
        cardResult: {
          ok: true,
          status: card.status === 'IN_AUDIT' ? 'SYNCED_AND_MOVED_TO_AUDIT' : 'SYNCED',
          cardId,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount,
          syncRunId,
          syncedAt,
          autoMovedToAudit: card.status === 'IN_AUDIT',
          blockReason: null,
          blockMessage: null,
          message: `NV #${folio} sincronizada desde Bsale.`,
        },
      }
    }

    const syncSummary = substitutedDocument
      ? `NV #${folio} sincronizada desde Bsale (nueva versión documental #${currentBsaleNvId}).`
      : `NV #${folio} sincronizada desde Bsale (${detailCount} ${detailCount === 1 ? 'línea' : 'líneas'}).`

    const [{ data: activeLines, error: linesError }, { count: openIncidentCount, error: incidentsError }, commercialAlertRes] = await Promise.all([
      admin
        .schema('logistica')
        .from('sales_order_preparation_lines')
        .select('id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id, sku, product_name, requested_quantity, prepared_quantity, line_status, excluded_from_dispatch, confirmed_by, confirmed_at')
        .eq('company_id', viewAuth.companyId)
        .eq('card_id', cardId)
        .is('retired_at', null),
      admin
        .schema('logistica')
        .from('sales_order_preparation_incidents')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', viewAuth.companyId)
        .eq('card_id', cardId)
        .eq('status', 'OPEN'),
      getSalesOrderPreparationCommercialAlert(cardId, { bypassCache: true }),
    ])

    if (linesError || incidentsError) {
      const reasonMsg = linesError?.message ?? incidentsError?.message ?? 'No se pudo verificar el estado operativo de las líneas.'
      return {
        ok: true,
        kind: 'CARD_SYNC',
        skipped: null,
        cardResult: {
          ok: true,
          status: 'SYNCED',
          cardId,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount,
          syncRunId,
          syncedAt,
          autoMovedToAudit: false,
          blockReason: 'RECONCILIATION_READ_ERROR',
          blockMessage: reasonMsg,
          message: `${syncSummary} Permanece En preparación: ${reasonMsg}`,
        },
      }
    }

    const decision = evaluatePostSyncAuditTransition({
      cardStatus: String(card.status),
      lines: (activeLines ?? []) as SalesOrderPreparationLine[],
      openCommercialIncidentCount: openIncidentCount ?? 0,
      commercialAlertStatus: commercialAlertRes.data?.status ?? 'UNAVAILABLE',
      commercialVerificationSource: commercialAlertRes.data?.verificationSource ?? 'NONE',
      commercialDetail: commercialAlertRes.error ?? commercialAlertRes.data?.detail ?? null,
    })

    if (!decision.shouldAdvanceToAudit) {
      return {
        ok: true,
        kind: 'CARD_SYNC',
        skipped: null,
        cardResult: {
          ok: true,
          status: 'SYNCED',
          cardId,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount,
          syncRunId,
          syncedAt,
          autoMovedToAudit: false,
          blockReason: decision.reason,
          blockMessage: decision.message,
          message: decision.message ? `${syncSummary} Permanece En preparación: ${decision.message}` : `${syncSummary} Permanece En preparación.`,
        },
      }
    }

    const moveResult = await moveSalesOrderPreparationCard({
      cardId,
      toStatus: 'IN_AUDIT',
      observation: 'Avance automático a Auditoría tras sincronización en cola y conciliación completa con Bsale.',
    })

    if (!moveResult.ok) {
      const blockMessage = moveResult.error || 'No se cumplieron todas las condiciones para avanzar a Auditoría.'
      return {
        ok: true,
        kind: 'CARD_SYNC',
        skipped: null,
        cardResult: {
          ok: true,
          status: 'SYNCED',
          cardId,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount,
          syncRunId,
          syncedAt,
          autoMovedToAudit: false,
          blockReason: 'TRANSITION_GUARD_BLOCKED',
          blockMessage,
          message: `${syncSummary} Permanece En preparación: ${blockMessage}`,
        },
      }
    }

    return {
      ok: true,
      kind: 'CARD_SYNC',
      skipped: null,
      cardResult: {
        ok: true,
        status: 'SYNCED_AND_MOVED_TO_AUDIT',
        cardId,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument,
        detailCount,
        syncRunId,
        syncedAt,
        autoMovedToAudit: true,
        blockReason: null,
        blockMessage: null,
        message: substitutedDocument
          ? `NV #${folio} sincronizada (versión #${currentBsaleNvId}), conciliada y enviada automáticamente a Auditoría.`
          : `NV #${folio} sincronizada, conciliada y enviada automáticamente a Auditoría.`,
      },
    }
  }

  if (kind === 'AUDIT_SYNC') {
    await requireWmsPermission('logistica.audit.manage')
    if (summary.reconciled === true && summary.auditResult && typeof summary.auditResult === 'object') {
      return {
        ok: true,
        kind: 'AUDIT_SYNC',
        skipped: null,
        auditResult: summary.auditResult as AuditCardSyncResult,
      }
    }
    if (!cardId) {
      return { ok: false, kind, skipped: null, message: 'Solicitud AUDIT_SYNC sin tarjeta asociada.' }
    }

    const [{ data: card }, { data: openAudit }] = await Promise.all([
      admin
        .schema('logistica')
        .from('sales_order_preparation_cards')
        .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, current_bsale_nv_id')
        .eq('id', cardId)
        .eq('company_id', viewAuth.companyId)
        .maybeSingle(),
      admin
        .schema('logistica')
        .from('sales_order_audits')
        .select('id, status, locked_by_user_id')
        .eq('company_id', viewAuth.companyId)
        .eq('card_id', cardId)
        .eq('status', 'OPEN')
        .order('cycle_no', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    if (!card || card.status !== 'IN_AUDIT' || !openAudit) {
      return {
        ok: false,
        kind,
        skipped: 'AUDIT_NOT_OPEN',
        message: 'La Auditoría ya no se encuentra abierta para verificación.',
      }
    }

    const auditId = String(openAudit.id)
    const folio = String(card.bsale_nv_folio ?? summary.nvFolio ?? '')
    const currentBsaleNvId = typeof summary.currentBsaleNvId === 'number'
      ? summary.currentBsaleNvId
      : Number(card.current_bsale_nv_id ?? card.bsale_nv_id)
    const previousBsaleNvId = typeof summary.previousBsaleNvId === 'number'
      ? summary.previousBsaleNvId
      : Number(card.bsale_nv_id)
    const detailCount = typeof summary.detailCount === 'number' ? summary.detailCount : 0
    const substitutedDocument = Boolean(summary.substitutedDocument) || (previousBsaleNvId !== currentBsaleNvId)

    const [commercialRes, finalizationRes, { count: openAuditIncidentsCount }] = await Promise.all([
      verifySalesOrderAuditCommercial({
        auditId,
        cardId,
        companyId: viewAuth.companyId,
      }),
      getSalesOrderAuditFinalizationStatus(auditId),
      admin
        .schema('logistica')
        .from('sales_order_audit_incidents')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', viewAuth.companyId)
        .eq('audit_id', auditId)
        .eq('status', 'OPEN'),
    ])

    const commercialVerification = commercialRes.data
    const openIncidents = openAuditIncidentsCount ?? 0
    const physicalCanFinalize = Boolean(finalizationRes.data?.can_finalize)

    if (commercialRes.error || !commercialVerification) {
      return {
        ok: true,
        kind: 'AUDIT_SYNC',
        skipped: null,
        auditResult: {
          ok: true,
          status: 'SYNCED_PENDING',
          cardId,
          auditId,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount,
          syncRunId,
          syncedAt,
          commercialVerification: null,
          openAuditIncidentsCount: openIncidents,
          canFinalize: false,
          message: `NV #${folio} sincronizada, pero no se pudo completar la verificación comercial: ${commercialRes.error || 'sin respuesta'}. La auditoría permanece abierta.`,
        },
      }
    }

    const commercialConforming = commercialVerification.status === 'READY_TO_INVOICE' && commercialVerification.differences.length === 0
    const canFinalize = commercialConforming && physicalCanFinalize

    if (canFinalize) {
      return {
        ok: true,
        kind: 'AUDIT_SYNC',
        skipped: null,
        auditResult: {
          ok: true,
          status: 'SYNCED_READY',
          cardId,
          auditId,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount,
          syncRunId,
          syncedAt,
          commercialVerification,
          openAuditIncidentsCount: openIncidents,
          canFinalize: true,
          message: `NV #${folio} sincronizada y conforme con Bsale. Ya puedes continuar con «Revisar cierre» para finalizar la Auditoría.`,
        },
      }
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

    return {
      ok: true,
      kind: 'AUDIT_SYNC',
      skipped: null,
      auditResult: {
        ok: true,
        status: 'SYNCED_PENDING',
        cardId,
        auditId,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument,
        detailCount,
        syncRunId,
        syncedAt,
        commercialVerification,
        openAuditIncidentsCount: openIncidents,
        canFinalize: false,
        message: pendingParts.length > 0
          ? `NV #${folio} sincronizada. La auditoría permanece abierta: ${pendingParts.join('; ')}.`
          : `NV #${folio} sincronizada. La auditoría permanece abierta hasta completar las validaciones de cierre.`,
      },
    }
  }

  if (kind === 'INCIDENT_SYNC') {
    if (summary.reconciled === true && typeof summary.incidentResolved === 'boolean') {
      return {
        ok: true,
        kind: 'INCIDENT_SYNC',
        skipped: null,
        cardId,
        incidentResolved: summary.incidentResolved,
        message: typeof summary.incidentMessage === 'string' && summary.incidentMessage
          ? summary.incidentMessage
          : (summary.incidentResolved
            ? 'La conciliación comercial de la incidencia fue exitosa.'
            : 'La Nota de Venta todavía presenta diferencias con lo preparado/auditado.'),
      }
    }
    const incidentId = typeof payload.incidentId === 'string' ? payload.incidentId : null
    if (!incidentId) {
      return { ok: true, kind: 'INCIDENT_SYNC', skipped: null, cardId, incidentResolved: false, message: 'Incidencia sincronizada desde Bsale.' }
    }
    const { data: refreshed } = await admin
      .schema('logistica')
      .from('sales_order_preparation_incidents')
      .select('status, verification_status')
      .eq('id', incidentId)
      .eq('company_id', viewAuth.companyId)
      .maybeSingle()

    const resolved = refreshed?.status === 'RESOLVED' && refreshed?.verification_status === 'MATCHED'
    return {
      ok: true,
      kind: 'INCIDENT_SYNC',
      skipped: null,
      cardId,
      incidentResolved: resolved,
      message: resolved
        ? 'La conciliación comercial de la incidencia fue exitosa.'
        : 'La Nota de Venta todavía presenta diferencias con lo preparado/auditado.',
    }
  }

  return { ok: false, kind, skipped: null, message: `Operación ${kind} no requiere reconciliación individual.` }
}
