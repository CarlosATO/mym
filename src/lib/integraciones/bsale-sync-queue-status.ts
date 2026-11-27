import { createAdminClient } from '@/lib/supabase/admin'
import {
  getBsaleSyncRolloutConfig,
  type BsaleSyncOperationKind,
} from '@/lib/integraciones/bsale-sync-coordinator'
import type { BsaleSyncQueueStatus } from '@/lib/integraciones/bsale-sync-queue'
import {
  ensureBsaleSyncQueueRuntimeRegistered,
  startBsaleSyncQueueServerSupervisor,
  stopBsaleSyncQueueServerSupervisor,
} from '@/lib/integraciones/bsale-sync-queue-runtime'

export const PREPARATION_BOARD_QUEUE_OPERATIONS: readonly BsaleSyncOperationKind[] = [
  'WAREHOUSE_MANUAL',
  'WAREHOUSE_OPERATIONAL',
  'WAREHOUSE_INCREMENTAL',
  'OPERATIONAL_PREP_SYNC',
]

export const PREPARATION_CARD_QUEUE_OPERATIONS: readonly BsaleSyncOperationKind[] = [
  'CARD_SYNC',
  'AUDIT_SYNC',
  'INCIDENT_SYNC',
]

const ALL_PREPARATION_OPERATIONS: readonly BsaleSyncOperationKind[] = [
  ...PREPARATION_BOARD_QUEUE_OPERATIONS,
  ...PREPARATION_CARD_QUEUE_OPERATIONS,
]

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isMissingBsaleQueueMigrationError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /PGRST202|PGRST205|42883|42P01|bsale_sync_queue|recover_bsale_sync_queue_v1/i.test(msg)
    && /does not exist|Could not find the|schema cache/i.test(msg)
}

export function extractCardIdFromResourceKey(resourceKey: string | null | undefined): string | null {
  if (!resourceKey || typeof resourceKey !== 'string') return null
  if (!resourceKey.startsWith('card:')) return null
  const cardId = resourceKey.slice('card:'.length).trim()
  return cardId || null
}

export interface ActiveBsaleSyncOperationMatch {
  active: true
  source: 'QUEUE' | 'LOCK'
  requestId: string | null
  status: 'PENDING' | 'RUNNING'
  operationKind: BsaleSyncOperationKind
  resourceKey: string | null
  coalescedCount: number
  availableAt: string | null
  startedAt: string | null
}

export interface PreparationTrackedQueueRequestSnapshot {
  id: string
  operationKind: BsaleSyncOperationKind
  resourceKey: string | null
  cardId: string | null
  status: BsaleSyncQueueStatus
  coalescedCount: number
  attemptCount: number
  maxAttempts: number
  syncRunId: string | null
  enqueuedAt: string
  availableAt: string
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  resultSummary: Record<string, unknown> | null
}

export interface PreparationCardActiveSyncEntry {
  cardId: string
  requestId: string | null
  operationKind: 'CARD_SYNC' | 'AUDIT_SYNC' | 'INCIDENT_SYNC'
  status: 'PENDING' | 'RUNNING'
  enqueuedAt: string | null
  startedAt: string | null
}

export interface PreparationSyncQueueSnapshot {
  queueAvailable: boolean
  serverNow: string
  boardSync: {
    requestId: string | null
    operationKind: BsaleSyncOperationKind
    status: 'PENDING' | 'RUNNING'
    enqueuedAt: string | null
    availableAt: string | null
    startedAt: string | null
    coalescedCount: number
  } | null
  activeLockRunning: boolean
  cardSyncsByCardId: Record<string, PreparationCardActiveSyncEntry>
  trackedRequests: Record<string, PreparationTrackedQueueRequestSnapshot>
}

/**
 * Comprueba en PostgreSQL si ya existe una operación equivalente en estado PENDING o RUNNING
 * (ya sea en `integraciones.bsale_sync_queue` o con lease vigente en `integraciones.bsale_sync_locks`),
 * impidiendo solicitudes duplicadas incluso ante recargas de pantalla o múltiples pestañas.
 */
export async function findActiveBsaleSyncOperation(params: {
  companyId: string
  operationKinds: readonly BsaleSyncOperationKind[]
  resourceKey?: string | null
}): Promise<ActiveBsaleSyncOperationMatch | null> {
  if (!params.companyId || params.operationKinds.length === 0) return null
  const rollout = getBsaleSyncRolloutConfig()
  if (!rollout.coordinatorEnabled) return null

  const admin = createAdminClient()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const normalizedResource = params.resourceKey?.trim() ? params.resourceKey.trim() : null

  if (rollout.queueEnabled) {
    try {
      let query = admin
        .schema('integraciones')
        .from('bsale_sync_queue')
        .select('id, operation_kind, resource_key, status, coalesced_count, available_at, started_at, lease_expires_at, enqueued_at')
        .eq('company_id', params.companyId)
        .in('operation_kind', [...params.operationKinds])
        .in('status', ['PENDING', 'RUNNING'])
        .order('enqueued_at', { ascending: true })

      query = normalizedResource === null
        ? query.is('resource_key', null)
        : query.eq('resource_key', normalizedResource)

      const { data: queueRows, error: queueError } = await query
      if (queueError) {
        if (!isMissingBsaleQueueMigrationError(queueError)) {
          console.error('[bsale-sync-queue-status] Error consultando cola activa:', queueError.message)
        }
      } else if (queueRows && queueRows.length > 0) {
        let needsDrainNudge = false
        for (const row of queueRows) {
          if (row.status === 'RUNNING') {
            const leaseMs = row.lease_expires_at ? Date.parse(String(row.lease_expires_at)) : NaN
            if (Number.isFinite(leaseMs) && leaseMs <= nowMs) {
              // Lease vencido: activar recuperación automática y continuar evaluando
              needsDrainNudge = true
              continue
            }
            return {
              active: true,
              source: 'QUEUE',
              requestId: String(row.id),
              status: 'RUNNING',
              operationKind: String(row.operation_kind) as BsaleSyncOperationKind,
              resourceKey: row.resource_key == null ? null : String(row.resource_key),
              coalescedCount: Number(row.coalesced_count ?? 1),
              availableAt: row.available_at == null ? null : String(row.available_at),
              startedAt: row.started_at == null ? null : String(row.started_at),
            }
          }
        }

        const pendingRow = queueRows.find(r => r.status === 'PENDING')
        if (pendingRow) {
          const availMs = pendingRow.available_at ? Date.parse(String(pendingRow.available_at)) : 0
          if (!Number.isFinite(availMs) || availMs <= nowMs) {
            needsDrainNudge = true
          }
          if (needsDrainNudge && rollout.supervisorEnabled) {
            startBsaleSyncQueueServerSupervisor()
            ensureBsaleSyncQueueRuntimeRegistered().triggerBackgroundDrain()
          }
          return {
            active: true,
            source: 'QUEUE',
            requestId: String(pendingRow.id),
            status: 'PENDING',
            operationKind: String(pendingRow.operation_kind) as BsaleSyncOperationKind,
            resourceKey: pendingRow.resource_key == null ? null : String(pendingRow.resource_key),
            coalescedCount: Number(pendingRow.coalesced_count ?? 1),
            availableAt: pendingRow.available_at == null ? null : String(pendingRow.available_at),
            startedAt: null,
          }
        }

        if (needsDrainNudge && rollout.supervisorEnabled) {
          startBsaleSyncQueueServerSupervisor()
          ensureBsaleSyncQueueRuntimeRegistered().triggerBackgroundDrain()
        }
      }
    } catch (err) {
      if (!isMissingBsaleQueueMigrationError(err)) {
        console.error('[bsale-sync-queue-status] Excepción consultando cola activa:', err)
      }
    }
  }

  try {
    let lockQuery = admin
      .schema('integraciones')
      .from('bsale_sync_locks')
      .select('lock_name, operation_kind, resource_key, acquired_at, expires_at, metadata')
      .eq('company_id', params.companyId)
      .in('operation_kind', [...params.operationKinds])
      .gt('expires_at', nowIso)

    lockQuery = normalizedResource === null
      ? lockQuery.is('resource_key', null)
      : lockQuery.eq('resource_key', normalizedResource)

    const { data: lockRows, error: lockError } = await lockQuery.limit(1)
    if (!lockError && lockRows && lockRows.length > 0) {
      const lock = lockRows[0]
      const meta = (lock.metadata && typeof lock.metadata === 'object' ? lock.metadata : {}) as Record<string, unknown>
      const queueReqId = typeof meta.queue_request_id === 'string' ? meta.queue_request_id : null
      return {
        active: true,
        source: 'LOCK',
        requestId: queueReqId,
        status: 'RUNNING',
        operationKind: String(lock.operation_kind) as BsaleSyncOperationKind,
        resourceKey: lock.resource_key == null ? null : String(lock.resource_key),
        coalescedCount: 1,
        availableAt: null,
        startedAt: lock.acquired_at == null ? null : String(lock.acquired_at),
      }
    }
  } catch {
    // Si las columnas extendidas de SYNC-01 aún no están en una BD antigua, degradar limpiamente.
  }

  return null
}

function mapQueueRowToTrackedSnapshot(row: Record<string, unknown>): PreparationTrackedQueueRequestSnapshot {
  const resourceKey = row.resource_key == null ? null : String(row.resource_key)
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>
  const cardIdFromPayload = typeof payload.cardId === 'string' ? payload.cardId : null
  return {
    id: String(row.id),
    operationKind: String(row.operation_kind) as BsaleSyncOperationKind,
    resourceKey,
    cardId: extractCardIdFromResourceKey(resourceKey) ?? cardIdFromPayload,
    status: String(row.status) as BsaleSyncQueueStatus,
    coalescedCount: Number(row.coalesced_count ?? 1),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    syncRunId: row.sync_run_id == null ? null : String(row.sync_run_id),
    enqueuedAt: String(row.enqueued_at),
    availableAt: String(row.available_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
    lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
    lastErrorMessage: row.last_error_message == null ? null : String(row.last_error_message),
    resultSummary: row.result_summary && typeof row.result_summary === 'object'
      ? (row.result_summary as Record<string, unknown>)
      : null,
  }
}

/**
 * Obtiene una instantánea real de las sincronizaciones en espera, en ejecución y recientemente
 * finalizadas/fallidas para Preparación de Pedidos, e impulsa el drenaje automático si hay
 * elementos ejecutables pendientes o con lease vencido.
 */
export async function readPreparationSyncQueueSnapshotForCompany(params: {
  companyId: string
  trackedRequestIds?: readonly string[]
}): Promise<PreparationSyncQueueSnapshot> {
  const nowMs = Date.now()
  const serverNow = new Date(nowMs).toISOString()
  const emptySnapshot: PreparationSyncQueueSnapshot = {
    queueAvailable: false,
    serverNow,
    boardSync: null,
    activeLockRunning: false,
    cardSyncsByCardId: {},
    trackedRequests: {},
  }

  if (!params.companyId) return emptySnapshot

  const rollout = getBsaleSyncRolloutConfig()
  const admin = createAdminClient()
  const validTrackedIds = [...new Set((params.trackedRequestIds ?? []).filter(id => UUID_PATTERN.test(id)))].slice(0, 50)

  let queueAvailable = rollout.queueEnabled
  let activeQueueRows: Array<Record<string, unknown>> = []
  let trackedRows: Array<Record<string, unknown>> = []
  let activeLocks: Array<Record<string, unknown>> = []

  const selectCols = 'id, operation_kind, resource_key, status, coalesced_count, attempt_count, max_attempts, sync_run_id, payload, enqueued_at, available_at, started_at, lease_expires_at, completed_at, cancelled_at, last_error_code, last_error_message, result_summary'

  if (rollout.queueEnabled) {
    const [activeRes, trackedRes] = await Promise.all([
      admin
        .schema('integraciones')
        .from('bsale_sync_queue')
        .select(selectCols)
        .eq('company_id', params.companyId)
        .in('operation_kind', [...ALL_PREPARATION_OPERATIONS])
        .in('status', ['PENDING', 'RUNNING'])
        .order('enqueued_at', { ascending: true }),
      validTrackedIds.length > 0
        ? admin
            .schema('integraciones')
            .from('bsale_sync_queue')
            .select(selectCols)
            .eq('company_id', params.companyId)
            .in('id', validTrackedIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    if (activeRes.error) {
      if (isMissingBsaleQueueMigrationError(activeRes.error)) {
        queueAvailable = false
      } else {
        console.error('[bsale-sync-queue-status] Error leyendo solicitudes activas:', activeRes.error.message)
      }
    } else {
      activeQueueRows = (activeRes.data ?? []) as Array<Record<string, unknown>>
    }

    if (!trackedRes.error && trackedRes.data) {
      trackedRows = trackedRes.data as Array<Record<string, unknown>>
    }
  }

  if (rollout.coordinatorEnabled) {
    const { data: locksData, error: locksErr } = await admin
      .schema('integraciones')
      .from('bsale_sync_locks')
      .select('lock_name, operation_kind, resource_key, acquired_at, expires_at, metadata')
      .eq('company_id', params.companyId)
      .gt('expires_at', serverNow)

    if (!locksErr && locksData) {
      activeLocks = locksData as Array<Record<string, unknown>>
    }
  }

  const trackedRequests: Record<string, PreparationTrackedQueueRequestSnapshot> = {}
  for (const row of [...activeQueueRows, ...trackedRows]) {
    const mapped = mapQueueRowToTrackedSnapshot(row)
    trackedRequests[mapped.id] = mapped
  }

  let shouldNudgeDrain = false
  let boardSync: PreparationSyncQueueSnapshot['boardSync'] = null
  const cardSyncsByCardId: Record<string, PreparationCardActiveSyncEntry> = {}

  for (const row of activeQueueRows) {
    const status = String(row.status) as 'PENDING' | 'RUNNING'
    const opKind = String(row.operation_kind) as BsaleSyncOperationKind
    const leaseMs = row.lease_expires_at ? Date.parse(String(row.lease_expires_at)) : NaN
    const availMs = row.available_at ? Date.parse(String(row.available_at)) : 0

    if (status === 'RUNNING' && Number.isFinite(leaseMs) && leaseMs <= nowMs) {
      shouldNudgeDrain = true
      continue
    }
    if (status === 'PENDING' && (!Number.isFinite(availMs) || availMs <= nowMs)) {
      shouldNudgeDrain = true
    }

    if ((PREPARATION_BOARD_QUEUE_OPERATIONS as readonly string[]).includes(opKind)) {
      // RUNNING tiene precedencia sobre PENDING; entre dos iguales preferimosWAREHOUSE_MANUAL o la más antigua
      if (!boardSync || (boardSync.status === 'PENDING' && status === 'RUNNING') || (boardSync.operationKind !== 'WAREHOUSE_MANUAL' && opKind === 'WAREHOUSE_MANUAL' && boardSync.status === status)) {
        boardSync = {
          requestId: String(row.id),
          operationKind: opKind,
          status,
          enqueuedAt: row.enqueued_at == null ? null : String(row.enqueued_at),
          availableAt: row.available_at == null ? null : String(row.available_at),
          startedAt: row.started_at == null ? null : String(row.started_at),
          coalescedCount: Number(row.coalesced_count ?? 1),
        }
      }
    } else if ((PREPARATION_CARD_QUEUE_OPERATIONS as readonly string[]).includes(opKind)) {
      const resourceKey = row.resource_key == null ? null : String(row.resource_key)
      const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>
      const cardId = extractCardIdFromResourceKey(resourceKey) ?? (typeof payload.cardId === 'string' ? payload.cardId : null)
      if (cardId) {
        const existing = cardSyncsByCardId[cardId]
        if (!existing || (existing.status === 'PENDING' && status === 'RUNNING')) {
          cardSyncsByCardId[cardId] = {
            cardId,
            requestId: String(row.id),
            operationKind: opKind as 'CARD_SYNC' | 'AUDIT_SYNC' | 'INCIDENT_SYNC',
            status,
            enqueuedAt: row.enqueued_at == null ? null : String(row.enqueued_at),
            startedAt: row.started_at == null ? null : String(row.started_at),
          }
        }
      }
    }
  }

  let activeLockRunning = false
  for (const lock of activeLocks) {
    const opKind = lock.operation_kind == null ? null : (String(lock.operation_kind) as BsaleSyncOperationKind)
    const resourceKey = lock.resource_key == null ? null : String(lock.resource_key)
    const meta = (lock.metadata && typeof lock.metadata === 'object' ? lock.metadata : {}) as Record<string, unknown>
    const queueReqId = typeof meta.queue_request_id === 'string' ? meta.queue_request_id : null

    if (opKind && (PREPARATION_BOARD_QUEUE_OPERATIONS as readonly string[]).includes(opKind)) {
      activeLockRunning = true
      if (!boardSync || boardSync.status === 'PENDING') {
        boardSync = {
          requestId: queueReqId ?? boardSync?.requestId ?? null,
          operationKind: opKind,
          status: 'RUNNING',
          enqueuedAt: boardSync?.enqueuedAt ?? null,
          availableAt: null,
          startedAt: lock.acquired_at == null ? null : String(lock.acquired_at),
          coalescedCount: boardSync?.coalescedCount ?? 1,
        }
      }
    } else if (opKind && (PREPARATION_CARD_QUEUE_OPERATIONS as readonly string[]).includes(opKind)) {
      const cardId = extractCardIdFromResourceKey(resourceKey)
      if (cardId && (!cardSyncsByCardId[cardId] || cardSyncsByCardId[cardId].status === 'PENDING')) {
        cardSyncsByCardId[cardId] = {
          cardId,
          requestId: queueReqId ?? cardSyncsByCardId[cardId]?.requestId ?? null,
          operationKind: opKind as 'CARD_SYNC' | 'AUDIT_SYNC' | 'INCIDENT_SYNC',
          status: 'RUNNING',
          enqueuedAt: cardSyncsByCardId[cardId]?.enqueuedAt ?? null,
          startedAt: lock.acquired_at == null ? null : String(lock.acquired_at),
        }
      }
    }
  }

  if (!rollout.supervisorEnabled) {
    stopBsaleSyncQueueServerSupervisor()
  } else if (queueAvailable && rollout.queueEnabled) {
    startBsaleSyncQueueServerSupervisor()
    if (shouldNudgeDrain) {
      ensureBsaleSyncQueueRuntimeRegistered().triggerBackgroundDrain()
    }
  }

  return {
    queueAvailable,
    serverNow,
    boardSync,
    activeLockRunning,
    cardSyncsByCardId,
    trackedRequests,
  }
}
