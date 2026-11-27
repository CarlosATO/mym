import { createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { createBsalePreparationCommercialProvider } from '@/lib/logistica/preparation-commercial-bsale-provider'
import { detectPreparationCommercialChange } from '@/lib/logistica/preparation-commercial-detector'
import {
  preparationCommercialLineFromSnapshot,
  type PreparationCommercialLineInput,
  type PreparationCommercialVersion,
} from '@/lib/logistica/preparation-commercial-version'
import { compareAuditedCommercialLines } from '@/lib/logistica/preparation-audit-commercial-verification'
import { evaluatePostSyncAuditTransition } from '@/modules/logistica/preparacion-pedidos/preparation-line-validation'
import type { SalesOrderPreparationLine } from '@/app/actions/logistica/sales-order-preparation'
import { hydrateBsaleDocumentsById, mapBsaleDocument, mapBsaleDocumentDetails } from '@/lib/integraciones/bsale-document-hydration'
import {
  composeBsaleProtectedSignal,
  getBsaleSyncRolloutConfig,
} from '@/lib/integraciones/bsale-sync-coordinator'
import {
  getGlobalBsaleSyncQueueManager,
  type BsaleSyncQueueManager,
  type BsaleSyncQueuedRequest,
} from '@/lib/integraciones/bsale-sync-queue'

type GlobalBsaleSyncQueueRuntimeState = {
  executorsRegistered: boolean
  bootTimer: ReturnType<typeof setTimeout> | null
  supervisorTimer: ReturnType<typeof setInterval> | null
  supervisorStarted: boolean
  migrationMissingLogged: boolean
}

const GLOBAL_BSALE_RUNTIME_STATE_KEY = '__mymBsaleSyncQueueRuntimeState__' as const

function getRuntimeState(): GlobalBsaleSyncQueueRuntimeState {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_BSALE_RUNTIME_STATE_KEY] || typeof g[GLOBAL_BSALE_RUNTIME_STATE_KEY] !== 'object') {
    g[GLOBAL_BSALE_RUNTIME_STATE_KEY] = {
      executorsRegistered: false,
      bootTimer: null,
      supervisorTimer: null,
      supervisorStarted: false,
      migrationMissingLogged: false,
    } satisfies GlobalBsaleSyncQueueRuntimeState
  }
  return g[GLOBAL_BSALE_RUNTIME_STATE_KEY] as GlobalBsaleSyncQueueRuntimeState
}

const SUPERVISOR_BOOT_DELAY_MS = 1_500
const SUPERVISOR_SWEEP_INTERVAL_MS = 15_000

function isMissingMigrationError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /PGRST202|42883|42P01|recover_bsale_sync_queue_v1|bsale_sync_queue/i.test(msg)
    && /does not exist|Could not find the function/i.test(msg)
}

function isMissingOptionalReconciliationSchemaError(error: unknown): boolean {
  if (!error) return false
  const errObj = error as { code?: unknown; message?: unknown }
  const code = typeof errObj.code === 'string' ? errObj.code : ''
  const msg = typeof errObj.message === 'string' ? errObj.message : String(error)
  return ['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(code)
    || (/does not exist|Could not find the|schema cache/i.test(msg)
      && /sales_order_preparation_lines|sales_order_preparation_commercial_versions|sales_order_audit_lines|sales_order_audit_incidents|move_sales_order_preparation_card|record_sales_order_audit_commercial_verification_v1|package_count/i.test(msg))
}

function hashJsonSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function buildSnapshotCommercialVersion(
  card: {
    bsale_nv_id: number
    current_bsale_nv_id: number | null
    bsale_nv_folio: string | null
    canonical_bsale_token: string | null
  },
  lines: Array<{ source_snapshot?: Record<string, unknown> | null }>,
): PreparationCommercialVersion | null {
  if (!card.canonical_bsale_token || !card.bsale_nv_folio || lines.length === 0) return null
  const snapshots = lines.map(line => line.source_snapshot ?? null)
  if (snapshots.some(snapshot => !snapshot)) return null
  const completeSnapshots = snapshots as Array<Record<string, unknown>>
  const versionLines: PreparationCommercialLineInput[] = completeSnapshots.map(preparationCommercialLineFromSnapshot)
  const sumField = (field: string): number | null => {
    const vals = completeSnapshots.map(s => {
      const raw = s[field]
      if (raw == null || raw === '') return null
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    })
    return vals.some(v => v == null) ? null : vals.reduce<number>((acc, v) => acc + (v ?? 0), 0)
  }
  return {
    identity: {
      canonicalToken: card.canonical_bsale_token,
      historicalBsaleId: Number(card.bsale_nv_id),
      currentBsaleId: Number(card.current_bsale_nv_id ?? card.bsale_nv_id),
      folio: card.bsale_nv_folio,
    },
    physicalId: Number(card.bsale_nv_id),
    generationDate: null,
    emissionDate: null,
    lines: versionLines,
    netAmount: sumField('line_net_amount'),
    taxAmount: sumField('line_tax_amount'),
    totalAmount: sumField('line_gross_amount'),
  }
}

/**
 * Revalida sin cookies de navegador (mediante service_role en PostgreSQL) que la
 * empresa esté activa y que el usuario solicitante conserve acceso activo y permiso
 * específico en esa empresa antes de ejecutar una operación encolada.
 */
async function assertQueuedScopeAndUserAuthorization(params: {
  companyId: string
  requestedBy: string | null
  requireUser: boolean
  requiredPermissions?: string[]
}): Promise<void> {
  const admin = createAdminClient()

  const { data: company, error: companyErr } = await admin
    .schema('core')
    .from('companies')
    .select('id, is_active')
    .eq('id', params.companyId)
    .maybeSingle()

  if (companyErr || !company || company.is_active === false) {
    throw new Error(`BSALE_QUEUE_COMPANY_INACTIVE: la empresa ${params.companyId} no está disponible.`)
  }

  if (params.requireUser && !params.requestedBy) {
    throw new Error('BSALE_QUEUE_USER_REQUIRED: la solicitud individual requiere usuario autorizado (requested_by).')
  }

  if (!params.requestedBy) {
    return
  }

  const [{ data: userProfile, error: userErr }, { data: accessRow, error: accessErr }] = await Promise.all([
    admin
      .from('users')
      .select('id, is_active, deleted_at')
      .eq('id', params.requestedBy)
      .maybeSingle(),
    admin
      .schema('core')
      .from('user_company_access')
      .select('role, is_active')
      .eq('user_id', params.requestedBy)
      .eq('company_id', params.companyId)
      .eq('is_active', true)
      .maybeSingle(),
  ])

  if (userErr || !userProfile || !userProfile.is_active || userProfile.deleted_at) {
    throw new Error('BSALE_QUEUE_USER_INACTIVE: el usuario solicitante ya no se encuentra activo.')
  }

  if (accessErr || !accessRow) {
    throw new Error('BSALE_QUEUE_USER_COMPANY_REVOKED: el usuario solicitante ya no pertenece a la empresa activa.')
  }

  for (const permCode of params.requiredPermissions ?? []) {
    const { data: allowed, error: permErr } = await admin.rpc('user_has_permission', {
      p_user_id: params.requestedBy,
      p_permission_code: permCode,
    })
    if (permErr || allowed !== true) {
      throw new Error(`BSALE_QUEUE_PERMISSION_DENIED: usuario sin permiso requerido (${permCode}).`)
    }
  }
}

async function executeQueuedSingleCardMirrorSync(request: BsaleSyncQueuedRequest): Promise<{
  syncRunId: string | null
  summary: Record<string, unknown>
}> {
  const requiredPermissions = request.operationKind === 'AUDIT_SYNC'
    ? ['module.logistica.view', 'logistica.audit.manage']
    : ['module.logistica.view', 'logistica.preparation.manage']

  await assertQueuedScopeAndUserAuthorization({
    companyId: request.companyId,
    requestedBy: request.requestedBy,
    requireUser: true,
    requiredPermissions,
  })

  const admin = createAdminClient()
  const cardId = typeof request.payload?.cardId === 'string' ? request.payload.cardId : null
  const incidentId = typeof request.payload?.incidentId === 'string' ? request.payload.incidentId : null

  let resolvedCardId = cardId
  if (request.operationKind === 'INCIDENT_SYNC') {
    if (!incidentId) throw new Error('INCIDENT_SYNC en cola requiere incidentId.')
    const { data: inc } = await admin.schema('logistica')
      .from('sales_order_preparation_incidents')
      .select('id, card_id, status')
      .eq('id', incidentId)
      .eq('company_id', request.companyId)
      .maybeSingle()
    if (!inc || inc.status !== 'OPEN') {
      return {
        syncRunId: null,
        summary: { skipped: 'INCIDENT_NOT_OPEN', incidentId, companyId: request.companyId, requestedBy: request.requestedBy },
      }
    }
    resolvedCardId = String(inc.card_id)
  }

  if (!resolvedCardId) {
    throw new Error(`${request.operationKind} en cola requiere cardId.`)
  }

  const { data: card, error: cardError } = await admin.schema('logistica')
    .from('sales_order_preparation_cards')
    .select('id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id')
    .eq('id', resolvedCardId)
    .eq('company_id', request.companyId)
    .maybeSingle()

  if (cardError || !card) {
    return {
      syncRunId: null,
      summary: { skipped: 'CARD_NOT_FOUND', cardId: resolvedCardId, companyId: request.companyId, requestedBy: request.requestedBy },
    }
  }

  if (request.operationKind === 'CARD_SYNC' && card.status !== 'IN_PREPARATION') {
    return {
      syncRunId: null,
      summary: { skipped: 'CARD_LEFT_PREPARATION', cardStatus: card.status, companyId: request.companyId, requestedBy: request.requestedBy },
    }
  }

  if (request.operationKind === 'AUDIT_SYNC') {
    if (card.status !== 'IN_AUDIT') {
      return {
        syncRunId: null,
        summary: { skipped: 'CARD_LEFT_AUDIT', cardStatus: card.status, companyId: request.companyId, requestedBy: request.requestedBy },
      }
    }
    const { data: openAudit, error: openAuditError } = await admin.schema('logistica')
      .from('sales_order_audits')
      .select('id, status, locked_by_user_id')
      .eq('company_id', request.companyId)
      .eq('card_id', card.id)
      .eq('status', 'OPEN')
      .order('cycle_no', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (openAuditError || !openAudit) {
      return {
        syncRunId: null,
        summary: { skipped: 'AUDIT_NOT_OPEN', companyId: request.companyId, requestedBy: request.requestedBy },
      }
    }

    if (openAudit.locked_by_user_id && String(openAudit.locked_by_user_id) !== request.requestedBy) {
      return {
        syncRunId: null,
        summary: { skipped: 'AUDIT_ASSIGNED_TO_OTHER_USER', companyId: request.companyId, requestedBy: request.requestedBy },
      }
    }
  }

  if (!card.canonical_bsale_token || !card.bsale_nv_folio) {
    throw new Error('Identidad canónica de la Nota de Venta incompleta.')
  }

  const { data: runData, error: runError } = await admin.schema('integraciones')
    .from('bsale_sync_runs')
    .insert({
      company_id: request.companyId,
      status: 'STARTED',
      trigger: 'MANUAL',
    })
    .select('id')
    .single()

  if (runError || !runData) {
    throw new Error(runError?.message ?? 'No se pudo iniciar bsale_sync_runs para solicitud en cola.')
  }
  const runId = String(runData.id)

  try {
    const identity = {
      companyId: request.companyId,
      cardId: String(card.id),
      status: String(card.status),
      canonicalToken: String(card.canonical_bsale_token),
      historicalBsaleId: Number(card.bsale_nv_id),
      currentBsaleId: card.current_bsale_nv_id == null ? null : Number(card.current_bsale_nv_id),
      folio: String(card.bsale_nv_folio),
    }

    // Exclusivamente lecturas GET contra Bsale; jamás emite facturas ni escrituras tributarias.
    const protectedSignal = composeBsaleProtectedSignal({ timeoutMs: 30_000 })
    const live = await createBsalePreparationCommercialProvider().getCurrentVersion(
      identity,
      protectedSignal ?? AbortSignal.timeout(30_000),
    )
    const currentBsaleNvId = live.identity.currentBsaleId

    const hydrated = await hydrateBsaleDocumentsById(admin, request.companyId, [currentBsaleNvId], null, undefined, false)
    const document = hydrated[0]
    if (!document || Number(document.document.id) !== currentBsaleNvId || document.details.length !== live.lines.length) {
      throw new Error('La lectura de la Nota de Venta desde Bsale quedó incompleta.')
    }

    const documentSnapshot = mapBsaleDocument(request.companyId, runId, document.document) as Record<string, unknown>
    const detailSnapshots = mapBsaleDocumentDetails(request.companyId, runId, currentBsaleNvId, document.details) as Array<Record<string, unknown>>
    const { data: replacement, error: replaceError } = await admin.schema('integraciones').rpc('replace_bsale_document_snapshot_v1', {
      p_company_id: request.companyId,
      p_run_id: runId,
      p_document: documentSnapshot,
      p_details: detailSnapshots,
    })
    if (replaceError) {
      throw new Error(`No se pudo reemplazar atómicamente el espejo Bsale: ${replaceError.message}`)
    }
    const repObj = (replacement ?? {}) as Record<string, unknown>
    if (Number(repObj.document_id) !== currentBsaleNvId) {
      throw new Error('La actualización del espejo Bsale no quedó consistente para esta corrida.')
    }

    let pointerQuery = admin.schema('logistica')
      .from('sales_order_preparation_cards')
      .update({ current_bsale_nv_id: currentBsaleNvId, updated_at: new Date().toISOString() })
      .eq('id', card.id)
      .eq('company_id', request.companyId)

    if (request.operationKind === 'CARD_SYNC') {
      pointerQuery = pointerQuery.eq('status', 'IN_PREPARATION')
    } else if (request.operationKind === 'AUDIT_SYNC') {
      pointerQuery = pointerQuery.eq('status', 'IN_AUDIT')
    }

    const { error: pointerError } = await pointerQuery
    if (pointerError) {
      throw new Error(`Error actualizando current_bsale_nv_id: ${pointerError.message}`)
    }

    const syncedAt = new Date().toISOString()
    const previousBsaleNvId = card.current_bsale_nv_id == null ? Number(card.bsale_nv_id) : Number(card.current_bsale_nv_id)
    const substitutedDocument = previousBsaleNvId !== currentBsaleNvId
    const folio = String(card.bsale_nv_folio ?? '')

    if (request.operationKind === 'INCIDENT_SYNC') {
      const { error: verifyErr } = await admin.schema('logistica').rpc('verify_open_preparation_incidents_v1', {
        p_company_id: request.companyId,
        p_bsale_nv_ids: [currentBsaleNvId],
      })
      if (verifyErr) {
        throw new Error(`No se pudo verificar la incidencia tras sincronización: ${verifyErr.message}`)
      }
      const { data: refreshedIncident } = incidentId
        ? await admin.schema('logistica')
          .from('sales_order_preparation_incidents')
          .select('status, verification_status')
          .eq('id', incidentId)
          .eq('company_id', request.companyId)
          .maybeSingle()
        : { data: null }
      const incidentResolved = refreshedIncident?.status === 'RESOLVED' && refreshedIncident?.verification_status === 'MATCHED'
      return {
        syncRunId: runId,
        summary: {
          reconciled: true,
          companyId: request.companyId,
          requestedBy: request.requestedBy,
          cardId: card.id,
          incidentId,
          nvFolio: folio,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount: detailSnapshots.length,
          incidentResolved,
          incidentMessage: incidentResolved
            ? 'La conciliación comercial de la incidencia fue exitosa.'
            : 'La Nota de Venta todavía presenta diferencias con lo preparado/auditado.',
        },
      }
    }

    if (request.operationKind === 'CARD_SYNC') {
      const syncSummary = substitutedDocument
        ? `NV #${folio} sincronizada desde Bsale (nueva versión documental #${currentBsaleNvId}).`
        : `NV #${folio} sincronizada desde Bsale (${detailSnapshots.length} ${detailSnapshots.length === 1 ? 'línea' : 'líneas'}).`

      const [linesRes, incidentsRes, acceptedVersionRes] = await Promise.all([
        admin.schema('logistica')
          .from('sales_order_preparation_lines')
          .select('id, company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id, sku, product_name, requested_quantity, prepared_quantity, line_status, excluded_from_dispatch, confirmed_by, confirmed_at, source_snapshot')
          .eq('company_id', request.companyId)
          .eq('card_id', card.id)
          .is('retired_at', null)
          .order('bsale_detail_id', { ascending: true }),
        admin.schema('logistica')
          .from('sales_order_preparation_incidents')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', request.companyId)
          .eq('card_id', card.id)
          .eq('status', 'OPEN'),
        admin.schema('logistica')
          .from('sales_order_preparation_commercial_versions')
          .select('version_snapshot')
          .eq('company_id', request.companyId)
          .eq('card_id', card.id)
          .order('sequence_no', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])

      if (
        isMissingOptionalReconciliationSchemaError(linesRes.error)
        || isMissingOptionalReconciliationSchemaError(acceptedVersionRes.error)
      ) {
        return {
          syncRunId: runId,
          summary: {
            reconciled: false,
            companyId: request.companyId,
            requestedBy: request.requestedBy,
            cardId: card.id,
            nvFolio: folio,
            previousBsaleNvId,
            currentBsaleNvId,
            substitutedDocument,
            detailCount: detailSnapshots.length,
          },
        }
      }

      if (linesRes.error || incidentsRes.error || acceptedVersionRes.error) {
        const reasonMsg = linesRes.error?.message
          ?? incidentsRes.error?.message
          ?? acceptedVersionRes.error?.message
          ?? 'No se pudo verificar el estado operativo de las líneas.'
        throw new Error(`No se pudo completar la reconciliación: ${reasonMsg}`)
      }

      const rawLines = (linesRes.data ?? []) as Array<Record<string, unknown> & { source_snapshot?: Record<string, unknown> | null }>
      const storedVersionRaw = (acceptedVersionRes.data as { version_snapshot?: unknown } | null)?.version_snapshot
      const storedVersion = storedVersionRaw && typeof storedVersionRaw === 'object' && Array.isArray((storedVersionRaw as PreparationCommercialVersion).lines)
        ? (storedVersionRaw as PreparationCommercialVersion)
        : null
      const knownVersion = storedVersion ?? buildSnapshotCommercialVersion(
        {
          bsale_nv_id: Number(card.bsale_nv_id),
          current_bsale_nv_id: currentBsaleNvId,
          bsale_nv_folio: folio,
          canonical_bsale_token: String(card.canonical_bsale_token),
        },
        rawLines,
      )

      const detection = await detectPreparationCommercialChange(
        {
          card: {
            ...identity,
            currentBsaleId: currentBsaleNvId,
          },
          knownVersion,
        },
        {
          provider: { getCurrentVersion: async () => live },
          authorize: () => undefined,
          useCache: false,
        },
      )

      const decision = evaluatePostSyncAuditTransition({
        cardStatus: 'IN_PREPARATION',
        lines: rawLines as unknown as SalesOrderPreparationLine[],
        openCommercialIncidentCount: incidentsRes.count ?? 0,
        commercialAlertStatus: detection.status,
        commercialVerificationSource: detection.verificationSource,
        commercialDetail: detection.detail ?? null,
      })

      let cardResult: Record<string, unknown>
      if (!decision.shouldAdvanceToAudit) {
        cardResult = {
          ok: true,
          status: 'SYNCED',
          cardId: String(card.id),
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
        }
      } else {
        const { data: actorProfile } = await admin
          .from('users')
          .select('nombre, apellido, email')
          .eq('id', request.requestedBy!)
          .maybeSingle()
        const actorName = actorProfile
          ? (`${actorProfile.nombre ?? ''} ${actorProfile.apellido ?? ''}`.trim() || String(actorProfile.email ?? request.requestedBy))
          : String(request.requestedBy)

        const moveRpc = await admin.schema('logistica').rpc('move_sales_order_preparation_card', {
          p_company_id: request.companyId,
          p_card_id: card.id,
          p_to_status: 'IN_AUDIT',
          p_observation: 'Avance automático a Auditoría tras sincronización en cola y conciliación completa con Bsale.',
          p_user_id: request.requestedBy,
          p_user_name: actorName,
        })

        if (isMissingOptionalReconciliationSchemaError(moveRpc.error)) {
          return {
            syncRunId: runId,
            summary: {
              reconciled: false,
              companyId: request.companyId,
              requestedBy: request.requestedBy,
              cardId: card.id,
              nvFolio: folio,
              previousBsaleNvId,
              currentBsaleNvId,
              substitutedDocument,
              detailCount: detailSnapshots.length,
            },
          }
        }

        if (moveRpc.error) {
          const blockMessage = moveRpc.error.message || 'No se cumplieron todas las condiciones para avanzar a Auditoría.'
          cardResult = {
            ok: true,
            status: 'SYNCED',
            cardId: String(card.id),
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
          }
        } else {
          cardResult = {
            ok: true,
            status: 'SYNCED_AND_MOVED_TO_AUDIT',
            cardId: String(card.id),
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
              ? `NV #${folio} sincronizada (versión #${currentBsaleNvId}), conciliada y enviada automáticamente a Auditoría.`
              : `NV #${folio} sincronizada, conciliada y enviada automáticamente a Auditoría.`,
          }
        }
      }

      return {
        syncRunId: runId,
        summary: {
          reconciled: true,
          companyId: request.companyId,
          requestedBy: request.requestedBy,
          cardId: card.id,
          nvFolio: folio,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount: detailSnapshots.length,
          cardResult,
        },
      }
    }

    if (request.operationKind === 'AUDIT_SYNC') {
      const { data: openAudit } = await admin.schema('logistica')
        .from('sales_order_audits')
        .select('id, status, locked_by_user_id')
        .eq('company_id', request.companyId)
        .eq('card_id', card.id)
        .eq('status', 'OPEN')
        .order('cycle_no', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!openAudit) {
        return {
          syncRunId: runId,
          summary: {
            skipped: 'AUDIT_NOT_OPEN',
            companyId: request.companyId,
            requestedBy: request.requestedBy,
            cardId: card.id,
          },
        }
      }

      const auditId = String(openAudit.id)
      const [auditLinesRes, storedVersionRes, auditPkgRes, openIncidentsRes] = await Promise.all([
        admin.schema('logistica')
          .from('sales_order_audit_lines')
          .select('bsale_detail_id, bsale_variant_id, sku, product_name, audit_quantity, line_status')
          .eq('audit_id', auditId)
          .eq('card_id', card.id)
          .eq('company_id', request.companyId)
          .order('bsale_detail_id', { ascending: true }),
        admin.schema('logistica')
          .from('sales_order_preparation_commercial_versions')
          .select('version_snapshot')
          .eq('company_id', request.companyId)
          .eq('card_id', card.id)
          .order('sequence_no', { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin.schema('logistica')
          .from('sales_order_audits')
          .select('package_count')
          .eq('id', auditId)
          .eq('company_id', request.companyId)
          .maybeSingle(),
        admin.schema('logistica')
          .from('sales_order_audit_incidents')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', request.companyId)
          .eq('audit_id', auditId)
          .eq('status', 'OPEN'),
      ])

      if (
        isMissingOptionalReconciliationSchemaError(auditLinesRes.error)
        || isMissingOptionalReconciliationSchemaError(storedVersionRes.error)
        || isMissingOptionalReconciliationSchemaError(auditPkgRes.error)
        || isMissingOptionalReconciliationSchemaError(openIncidentsRes.error)
      ) {
        return {
          syncRunId: runId,
          summary: {
            reconciled: false,
            companyId: request.companyId,
            requestedBy: request.requestedBy,
            cardId: card.id,
            auditId,
            nvFolio: folio,
            previousBsaleNvId,
            currentBsaleNvId,
            substitutedDocument,
            detailCount: detailSnapshots.length,
          },
        }
      }

      const openIncidents = openIncidentsRes.count ?? 0
      if (auditLinesRes.error || storedVersionRes.error || auditPkgRes.error || openIncidentsRes.error) {
        const errMsg = auditLinesRes.error?.message ?? storedVersionRes.error?.message ?? auditPkgRes.error?.message ?? openIncidentsRes.error?.message ?? 'sin respuesta'
        throw new Error(`No se pudo completar la verificación de auditoría: ${errMsg}`)
      }

      const rawAuditLines = (auditLinesRes.data ?? []) as Array<{
        bsale_detail_id: number
        bsale_variant_id: number | null
        sku: string | null
        product_name: string
        audit_quantity: number | null
        line_status?: string | null
      }>
      const auditedLines = rawAuditLines.map(row => ({
        bsale_detail_id: Number(row.bsale_detail_id),
        bsale_variant_id: row.bsale_variant_id == null ? null : Number(row.bsale_variant_id),
        sku: row.sku ?? null,
        product_name: String(row.product_name ?? ''),
        audit_quantity: row.audit_quantity == null ? NaN : Number(row.audit_quantity),
      }))
      const acceptedRaw = (storedVersionRes.data as { version_snapshot?: unknown } | null)?.version_snapshot
      const acceptedVersion = acceptedRaw && typeof acceptedRaw === 'object' && Array.isArray((acceptedRaw as PreparationCommercialVersion).lines)
        ? (acceptedRaw as PreparationCommercialVersion)
        : null
      const baseSnapshot = {
        cardId: String(card.id),
        auditId,
        identity: { ...identity, currentBsaleId: currentBsaleNvId },
        auditedLines,
        acceptedVersion,
      }

      let commercialVerification: Record<string, unknown> | null = null
      let verificationErrMsg: string | null = null

      if (auditedLines.length === 0 || auditedLines.some(line => !Number.isFinite(line.audit_quantity))) {
        const blockedSnapshot = { ...baseSnapshot, status: 'BLOCKED' }
        const persistRes = await admin.schema('logistica').rpc('record_sales_order_audit_commercial_verification_v1', {
          p_company_id: request.companyId,
          p_card_id: card.id,
          p_audit_id: auditId,
          p_status: 'BLOCKED',
          p_current_bsale_nv_id: currentBsaleNvId,
          p_canonical_bsale_token: card.canonical_bsale_token,
          p_reason: 'AUDIT_COMMERCIAL_IDENTITY_INCOMPLETE',
          p_fingerprint: hashJsonSha256(blockedSnapshot),
          p_snapshot: blockedSnapshot,
          p_differences: [],
        })
        if (isMissingOptionalReconciliationSchemaError(persistRes.error)) {
          return {
            syncRunId: runId,
            summary: {
              reconciled: false,
              companyId: request.companyId,
              requestedBy: request.requestedBy,
              cardId: card.id,
              auditId,
              nvFolio: folio,
              previousBsaleNvId,
              currentBsaleNvId,
              substitutedDocument,
              detailCount: detailSnapshots.length,
            },
          }
        }
        if (persistRes.error || !persistRes.data) {
          verificationErrMsg = persistRes.error?.message ?? 'No se pudo registrar la verificación comercial.'
        } else {
          commercialVerification = persistRes.data as Record<string, unknown>
        }
      } else {
        const comparison = compareAuditedCommercialLines(
          auditedLines as Array<typeof auditedLines[number] & { audit_quantity: number }>,
          live,
          acceptedVersion,
        )
        const verSnapshot = { ...baseSnapshot, currentVersion: live, comparison, status: comparison.status }
        const persistRes = await admin.schema('logistica').rpc('record_sales_order_audit_commercial_verification_v1', {
          p_company_id: request.companyId,
          p_card_id: card.id,
          p_audit_id: auditId,
          p_status: comparison.status,
          p_current_bsale_nv_id: currentBsaleNvId,
          p_canonical_bsale_token: live.identity.canonicalToken,
          p_reason: comparison.status === 'READY_TO_INVOICE' ? 'COMMERCIAL_MATCHED' : 'COMMERCIAL_DIFFERENCES_FOUND',
          p_fingerprint: hashJsonSha256(verSnapshot),
          p_snapshot: verSnapshot,
          p_differences: comparison.differences,
        })
        if (isMissingOptionalReconciliationSchemaError(persistRes.error)) {
          return {
            syncRunId: runId,
            summary: {
              reconciled: false,
              companyId: request.companyId,
              requestedBy: request.requestedBy,
              cardId: card.id,
              auditId,
              nvFolio: folio,
              previousBsaleNvId,
              currentBsaleNvId,
              substitutedDocument,
              detailCount: detailSnapshots.length,
            },
          }
        }
        if (persistRes.error || !persistRes.data) {
          verificationErrMsg = persistRes.error?.message ?? 'No se pudo registrar la verificación comercial.'
        } else {
          commercialVerification = persistRes.data as Record<string, unknown>
        }
      }

      const pendingAuditLines = rawAuditLines.filter(l => l.line_status === 'PENDING' || l.audit_quantity == null).length
      if (verificationErrMsg || !commercialVerification) {
        throw new Error(`No se pudo registrar la verificación comercial: ${verificationErrMsg ?? 'sin respuesta'}`)
      }
      const packageCount = Number((auditPkgRes.data as { package_count?: unknown } | null)?.package_count ?? 0)
      const physicalBlockers: string[] = []
      if (pendingAuditLines > 0) {
        physicalBlockers.push(`Faltan ${pendingAuditLines} líneas por auditar.`)
      }
      if (openIncidents > 0) {
        physicalBlockers.push(`Existen ${openIncidents} incidencias de auditoría abiertas.`)
      }
      if (!Number.isFinite(packageCount) || packageCount < 1) {
        physicalBlockers.push('La cantidad de bultos es obligatoria para finalizar Auditoría.')
      }
      const physicalCanFinalize = physicalBlockers.length === 0

      let auditResult: Record<string, unknown>
      if (verificationErrMsg || !commercialVerification) {
        auditResult = {
          ok: true,
          status: 'SYNCED_PENDING',
          cardId: String(card.id),
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
          message: `NV #${folio} sincronizada, pero no se pudo completar la verificación comercial: ${verificationErrMsg || 'sin respuesta'}. La auditoría permanece abierta.`,
        }
      } else {
        const verStatus = String(commercialVerification.status ?? '')
        const verDiffs = Array.isArray(commercialVerification.differences) ? commercialVerification.differences : []
        const commercialConforming = verStatus === 'READY_TO_INVOICE' && verDiffs.length === 0
        const canFinalize = commercialConforming && physicalCanFinalize

        if (canFinalize) {
          auditResult = {
            ok: true,
            status: 'SYNCED_READY',
            cardId: String(card.id),
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
            message: `NV #${folio} sincronizada y conforme con Bsale. Ya puedes continuar con «Revisar cierre» para finalizar la Auditoría.`,
          }
        } else {
          const pendingParts: string[] = []
          if (verStatus === 'INCIDENTS') {
            pendingParts.push(`persisten ${verDiffs.length} diferencia${verDiffs.length === 1 ? '' : 's'} comercial${verDiffs.length === 1 ? '' : 'es'} en Bsale`)
          } else if (verStatus === 'BLOCKED') {
            pendingParts.push(`verificación comercial bloqueada (${String(commercialVerification.reason ?? 'BLOCKED')})`)
          }
          if (openIncidents > 0) {
            pendingParts.push(`${openIncidents} incidencia${openIncidents === 1 ? '' : 's'} física${openIncidents === 1 ? '' : 's'} abierta${openIncidents === 1 ? '' : 's'}`)
          }
          if (!physicalCanFinalize && physicalBlockers.length > 0 && openIncidents === 0) {
            pendingParts.push(physicalBlockers[0])
          }

          auditResult = {
            ok: true,
            status: 'SYNCED_PENDING',
            cardId: String(card.id),
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
              ? `NV #${folio} sincronizada. La auditoría permanece abierta: ${pendingParts.join('; ')}.`
              : `NV #${folio} sincronizada. La auditoría permanece abierta hasta completar las validaciones de cierre.`,
          }
        }
      }

      return {
        syncRunId: runId,
        summary: {
          reconciled: true,
          companyId: request.companyId,
          requestedBy: request.requestedBy,
          cardId: card.id,
          auditId,
          nvFolio: folio,
          previousBsaleNvId,
          currentBsaleNvId,
          substitutedDocument,
          detailCount: detailSnapshots.length,
          auditResult,
        },
      }
    }

    return {
      syncRunId: runId,
      summary: {
        companyId: request.companyId,
        requestedBy: request.requestedBy,
        cardId: card.id,
        nvFolio: folio,
        previousBsaleNvId,
        currentBsaleNvId,
        substitutedDocument,
        detailCount: detailSnapshots.length,
      },
    }
  } catch (error) {
    await admin.schema('integraciones')
      .from('bsale_sync_runs')
      .update({
        status: 'FAILED',
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : String(error),
      })
      .eq('id', runId)
    throw error
  }
}

export function ensureBsaleSyncQueueRuntimeRegistered(): BsaleSyncQueueManager {
  const manager = getGlobalBsaleSyncQueueManager()
  const state = getRuntimeState()
  if (state.executorsRegistered) return manager
  state.executorsRegistered = true

  manager.registerExecutor('REPLENISHMENT_SYNC', async (request) => {
    await assertQueuedScopeAndUserAuthorization({
      companyId: request.companyId,
      requestedBy: request.requestedBy,
      requireUser: false,
    })
    const { runReplenishmentBsaleSync } = await import('@/app/actions/integraciones/bsale-sync')
    const res = await runReplenishmentBsaleSync(request.companyId, request.triggerType || 'SCHEDULED', {
      fromQueueWorker: true,
    })
    if (!res.success) {
      throw new Error(res.error || `REPLENISHMENT_SYNC finalizó con estado ${res.status}`)
    }
    return {
      syncRunId: res.runId ?? null,
      summary: { status: res.status, companyId: request.companyId, requestedBy: request.requestedBy },
    }
  })

  manager.registerExecutor('WAREHOUSE_MANUAL', async (request) => {
    await assertQueuedScopeAndUserAuthorization({
      companyId: request.companyId,
      requestedBy: request.requestedBy,
      requireUser: false,
    })
    const { runManualWarehouseBsaleRefresh } = await import('@/app/actions/integraciones/bsale-sync')
    const res = await runManualWarehouseBsaleRefresh(request.companyId, { fromQueueWorker: true })
    if (!res.success) {
      throw new Error(res.error || `WAREHOUSE_MANUAL finalizó con estado ${res.status ?? 'FAILED'}`)
    }
    return {
      summary: { ...(res.counts ?? {}), companyId: request.companyId, requestedBy: request.requestedBy },
    }
  })

  manager.registerExecutor('WAREHOUSE_INCREMENTAL', async (request) => {
    await assertQueuedScopeAndUserAuthorization({
      companyId: request.companyId,
      requestedBy: request.requestedBy,
      requireUser: false,
    })
    const { runIncrementalWarehouseBsaleRefresh } = await import('@/app/actions/integraciones/bsale-sync')
    const res = await runIncrementalWarehouseBsaleRefresh(request.companyId, { fromQueueWorker: true })
    if (!res.success) {
      throw new Error(res.error || 'WAREHOUSE_INCREMENTAL falló')
    }
    return {
      summary: { ...(res.counts ?? {}), companyId: request.companyId, requestedBy: request.requestedBy },
    }
  })

  manager.registerExecutor('WAREHOUSE_OPERATIONAL', async (request) => {
    await assertQueuedScopeAndUserAuthorization({
      companyId: request.companyId,
      requestedBy: request.requestedBy,
      requireUser: false,
    })
    const { runOperationalWarehouseBsaleRefresh } = await import('@/app/actions/integraciones/bsale-sync')
    const closureDocsRepairDays = typeof request.payload?.closureDocsRepairDays === 'number'
      ? request.payload.closureDocsRepairDays
      : undefined
    const res = await runOperationalWarehouseBsaleRefresh(request.companyId, {
      closureDocsRepairDays,
      fromQueueWorker: true,
    })
    if (!res.success) {
      throw new Error(res.error || 'WAREHOUSE_OPERATIONAL falló')
    }
    return {
      summary: { ...(res.counts ?? {}), companyId: request.companyId, requestedBy: request.requestedBy },
    }
  })

  manager.registerExecutor('OPERATIONAL_PREP_SYNC', async (request) => {
    await assertQueuedScopeAndUserAuthorization({
      companyId: request.companyId,
      requestedBy: request.requestedBy,
      requireUser: false,
    })
    const { syncBsaleSalesOrdersForPreparation } = await import('@/app/actions/integraciones/bsale-sync')
    const res = await syncBsaleSalesOrdersForPreparation(request.companyId, {
      trigger: request.triggerType === 'WAREHOUSE_INCREMENTAL' ? 'WAREHOUSE_INCREMENTAL' : 'WAREHOUSE_OPERATIONAL',
      discoverRecent: request.payload?.discoverRecent !== false,
      refreshActiveBoard: request.payload?.refreshActiveBoard !== false,
      closureDocsRepairDays: typeof request.payload?.closureDocsRepairDays === 'number'
        ? request.payload.closureDocsRepairDays
        : 90,
      fromQueueWorker: true,
    })
    if (!res.success) {
      throw new Error(res.error || 'OPERATIONAL_PREP_SYNC falló')
    }
    return {
      summary: { ...(res.counts ?? {}), companyId: request.companyId, requestedBy: request.requestedBy },
    }
  })

  manager.registerExecutor('WAREHOUSE_FULL_REFRESH', async (request) => {
    await assertQueuedScopeAndUserAuthorization({
      companyId: request.companyId,
      requestedBy: request.requestedBy,
      requireUser: false,
    })
    const { runFullWarehouseBsaleRefresh } = await import('@/app/actions/integraciones/bsale-sync')
    const res = await runFullWarehouseBsaleRefresh(request.companyId, { fromQueueWorker: true })
    if (!res.success && res.status === 'FAILED') {
      throw new Error(res.error || 'WAREHOUSE_FULL_REFRESH falló')
    }
    return {
      syncRunId: res.runId ?? null,
      summary: { status: res.status, companyId: request.companyId, requestedBy: request.requestedBy, ...(res.metrics ?? {}) },
    }
  })

  const executeReconciledCardSync: typeof executeQueuedSingleCardMirrorSync = async request => {
    const result = await executeQueuedSingleCardMirrorSync(request)
    if (!result.summary.skipped && result.summary.reconciled !== true) {
      throw new Error('No se pudo completar la reconciliación individual de la solicitud.')
    }
    return result
  }
  manager.registerExecutor('CARD_SYNC', executeReconciledCardSync)
  manager.registerExecutor('INCIDENT_SYNC', executeReconciledCardSync)
  manager.registerExecutor('AUDIT_SYNC', executeReconciledCardSync)

  return manager
}

export function startBsaleSyncQueueServerSupervisor() {
  const state = getRuntimeState()
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return
  if (!getBsaleSyncRolloutConfig().supervisorEnabled) {
    if (state.supervisorStarted) stopBsaleSyncQueueServerSupervisor()
    return
  }
  if (state.supervisorStarted) return

  state.supervisorStarted = true
  const manager = ensureBsaleSyncQueueRuntimeRegistered()

  const runSafeSweep = () => {
    if (!getBsaleSyncRolloutConfig().supervisorEnabled) {
      stopBsaleSyncQueueServerSupervisor()
      return
    }
    void manager.drain().catch(error => {
      if (isMissingMigrationError(error)) {
        if (!state.migrationMissingLogged) {
          state.migrationMissingLogged = true
          console.warn('[bsale-sync-queue-supervisor] Migración de cola Bsale aún no aplicada; supervisor en espera pasiva.')
        }
        return
      }
      console.error('[bsale-sync-queue-supervisor] Error en barrido periódico:', error)
    })
  }

  state.bootTimer = setTimeout(() => {
    state.bootTimer = null
    runSafeSweep()
  }, SUPERVISOR_BOOT_DELAY_MS)
  state.bootTimer.unref?.()

  state.supervisorTimer = setInterval(runSafeSweep, SUPERVISOR_SWEEP_INTERVAL_MS)
  state.supervisorTimer.unref?.()
}

export function stopBsaleSyncQueueServerSupervisor() {
  const state = getRuntimeState()
  if (state.bootTimer) {
    clearTimeout(state.bootTimer)
    state.bootTimer = null
  }
  if (state.supervisorTimer) {
    clearInterval(state.supervisorTimer)
    state.supervisorTimer = null
  }
  state.supervisorStarted = false
}

export function resetBsaleSyncQueueRuntimeForTests() {
  stopBsaleSyncQueueServerSupervisor()
  const state = getRuntimeState()
  state.executorsRegistered = false
  state.migrationMissingLogged = false
}
