import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
  BsaleRateLimitError,
  BsaleSyncLeaseLostError,
  buildBsaleSyncRequestContract,
  createSupabaseBsaleSyncCoordinatorStore,
  getBsaleSyncRolloutConfig,
  getIncompatibleLockNames,
  onBsaleCoordinatorLockReleased,
  parseBsaleRetryAfterSeconds,
  runWithBsaleSyncCoordinator,
  type BsaleSyncCoordinatorStore,
  type BsaleSyncLease,
  type BsaleSyncOperationKind,
  type BsaleSyncPriority,
// @ts-expect-error Standalone Node strip-types runner resolves explicit source extension.
} from './bsale-sync-coordinator.ts'

export type BsaleSyncQueueStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export const QUEUEABLE_BSALE_SYNC_OPERATIONS: ReadonlySet<BsaleSyncOperationKind> = new Set([
  'REPLENISHMENT_SYNC',
  'OPERATIONAL_PREP_SYNC',
  'WAREHOUSE_INCREMENTAL',
  'WAREHOUSE_OPERATIONAL',
  'WAREHOUSE_MANUAL',
  'WAREHOUSE_FULL_REFRESH',
  'CARD_SYNC',
  'INCIDENT_SYNC',
  'AUDIT_SYNC',
  'COBRANZA_SNAPSHOT',
])

const FORBIDDEN_TAX_WRITE_PATTERNS = /INVOICE|FACTUR|BOLETA|CREDIT_NOTE|NOTA_CREDITO|DISPATCH_GUIDE|GUIA_DESPACHO|EMIT|PAYMENT_POST/i

export class BsaleSyncQueueForbiddenOperationError extends Error {
  readonly code = 'BSALE_QUEUE_FORBIDDEN_TAX_WRITE'

  constructor(operationKind: string) {
    super(
      `BSALE_QUEUE_FORBIDDEN_TAX_WRITE: la operación "${operationKind}" no puede encolarse. ` +
      'Las emisiones de facturas y escrituras tributarias en Bsale siempre deben ejecutarse de forma síncrona e inmediata.',
    )
    this.name = 'BsaleSyncQueueForbiddenOperationError'
  }
}

export function assertQueueableBsaleOperation(operationKind: string): asserts operationKind is BsaleSyncOperationKind {
  if (FORBIDDEN_TAX_WRITE_PATTERNS.test(operationKind) || !QUEUEABLE_BSALE_SYNC_OPERATIONS.has(operationKind as BsaleSyncOperationKind)) {
    throw new BsaleSyncQueueForbiddenOperationError(operationKind)
  }
}

export interface BsaleSyncQueuedRequest {
  id: string
  companyId: string
  credentialScope: string
  operationKind: BsaleSyncOperationKind
  lockName: string
  resourceKey: string | null
  dedupeKey: string
  status: BsaleSyncQueueStatus
  priority: BsaleSyncPriority
  priorityWeight: number
  coalescedCount: number
  attemptCount: number
  maxAttempts: number
  ttlSeconds: number
  triggerType: string
  requestedBy: string | null
  payload: Record<string, unknown>
  enqueuedAt: string
  startedAt: string | null
}

export interface BsaleSyncEnqueueResult {
  enqueued: boolean
  alreadyRunning?: boolean
  deduplicated: boolean
  requestId: string | null
  status: BsaleSyncQueueStatus
  dedupeKey: string
  credentialScope: string
  coalescedCount: number
  availableAt: string
}

export interface BsaleSyncClaimResult {
  claimed: true
  serverNow: string
  lease: {
    ownerToken: string
    lockName: string
    expiresAt: string
    serverNow: string
  }
  request: BsaleSyncQueuedRequest
}

export interface BsaleSyncQueueStore {
  coordinatorStore: BsaleSyncCoordinatorStore
  enqueue: (params: {
    companyId: string
    credentialScope: string
    operationKind: BsaleSyncOperationKind
    lockName: string
    incompatibleLockNames: string[]
    resourceKey: string | null
    priority: BsaleSyncPriority
    priorityWeight: number
    ttlSeconds: number
    maxAttempts: number
    triggerType: string
    requestedBy: string | null
    payload: Record<string, unknown>
    delaySeconds?: number
  }) => Promise<BsaleSyncEnqueueResult>
  recover: () => Promise<{
    recoveredToPending: number
    failedExhausted: number
    cancelledSuperseded: number
  }>
  claimNext: (params: {
    workerId: string
    credentialScope?: string | null
    maxStarvationSeconds?: number
    agingStepSeconds?: number
  }) => Promise<
    | BsaleSyncClaimResult
    | { claimed: false; serverNow?: string; nextAvailableAt?: string | null }
  >
  complete: (params: {
    requestId: string
    companyId: string
    lockName: string
    credentialScope: string
    ownerToken: string
    durationMs: number
    syncRunId?: string | null
    resultSummary?: Record<string, unknown>
  }) => Promise<{ completed: boolean; status?: BsaleSyncQueueStatus; reason?: string }>
  failOrRetry: (params: {
    requestId: string
    companyId: string
    lockName: string
    credentialScope: string
    ownerToken: string
    errorCode: string
    errorMessage: string
    retryable: boolean
    httpStatus?: number | null
    retryAfterSeconds?: number | null
    durationMs: number
    syncRunId?: string | null
    resultSummary?: Record<string, unknown> | null
  }) => Promise<{
    updated: boolean
    status?: BsaleSyncQueueStatus
    nextAvailableAt?: string | null
    backoffSeconds?: number | null
    reason?: string
  }>
  cancel: (params: {
    requestId: string
    companyId: string
    reason?: string
  }) => Promise<{ cancelled: boolean; reason?: string }>
}

export interface BsaleSyncQueueExecutionOutcome {
  syncRunId?: string | null
  summary?: Record<string, unknown>
}

export type BsaleSyncQueueExecutor = (
  request: BsaleSyncQueuedRequest,
  lease: BsaleSyncLease,
) => Promise<BsaleSyncQueueExecutionOutcome | void>

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

let customQueueStoreOverride: BsaleSyncQueueStore | null = null

export function setCustomBsaleSyncQueueStoreForTests(store: BsaleSyncQueueStore | null) {
  customQueueStoreOverride = store
}

export function createSupabaseBsaleSyncQueueStore(
  coordinatorStore: BsaleSyncCoordinatorStore = createSupabaseBsaleSyncCoordinatorStore(),
): BsaleSyncQueueStore {
  if (customQueueStoreOverride) return customQueueStoreOverride
  return {
    coordinatorStore,
    async enqueue(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('enqueue_bsale_sync_request_v1', {
        p_company_id: params.companyId,
        p_credential_scope: params.credentialScope,
        p_operation_kind: params.operationKind,
        p_lock_name: params.lockName,
        p_incompatible_lock_names: params.incompatibleLockNames,
        p_resource_key: params.resourceKey,
        p_priority: params.priority,
        p_priority_weight: params.priorityWeight,
        p_ttl_seconds: params.ttlSeconds,
        p_max_attempts: params.maxAttempts,
        p_trigger_type: params.triggerType,
        p_requested_by: params.requestedBy,
        p_payload: params.payload,
        p_delay_seconds: params.delaySeconds ?? 0,
      })
      if (error) {
        throw new Error(`Error al encolar sincronización Bsale (${params.operationKind}): ${error.message}`)
      }
      const row = (data ?? {}) as Record<string, unknown>
      return {
        enqueued: row.enqueued !== false,
        alreadyRunning: row.already_running === true,
        deduplicated: row.deduplicated === true,
        requestId: row.request_id == null ? null : String(row.request_id),
        status: String(row.status ?? 'PENDING') as BsaleSyncQueueStatus,
        dedupeKey: String(row.dedupe_key),
        credentialScope: String(row.credential_scope),
        coalescedCount: Number(row.coalesced_count ?? 1),
        availableAt: String(row.available_at),
      }
    },
    async recover() {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('recover_bsale_sync_queue_v1')
      if (error) {
        throw new Error(`Error al recuperar cola Bsale: ${error.message}`)
      }
      const row = (data ?? {}) as Record<string, unknown>
      return {
        recoveredToPending: Number(row.recovered_to_pending ?? 0),
        failedExhausted: Number(row.failed_exhausted ?? 0),
        cancelledSuperseded: Number(row.cancelled_superseded ?? 0),
      }
    },
    async claimNext(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('claim_next_bsale_sync_request_v1', {
        p_worker_id: params.workerId,
        p_credential_scope: params.credentialScope ?? null,
        p_max_starvation_seconds: params.maxStarvationSeconds ?? 900,
        p_aging_step_seconds: params.agingStepSeconds ?? 180,
      })
      if (error) {
        throw new Error(`Error al reclamar solicitud Bsale en cola: ${error.message}`)
      }
      const payload = (data ?? {}) as Record<string, unknown>
      if (payload.claimed !== true) {
        return {
          claimed: false,
          serverNow: payload.server_now == null ? undefined : String(payload.server_now),
          nextAvailableAt: payload.next_available_at == null ? null : String(payload.next_available_at),
        }
      }
      const leaseRaw = (payload.lease ?? {}) as Record<string, unknown>
      const reqRaw = (payload.request ?? {}) as Record<string, unknown>
      return {
        claimed: true,
        serverNow: String(payload.server_now),
        lease: {
          ownerToken: String(leaseRaw.owner_token),
          lockName: String(leaseRaw.lock_name),
          expiresAt: String(leaseRaw.expires_at),
          serverNow: String(leaseRaw.server_now ?? payload.server_now),
        },
        request: {
          id: String(reqRaw.id),
          companyId: String(reqRaw.company_id),
          credentialScope: String(reqRaw.credential_scope),
          operationKind: String(reqRaw.operation_kind) as BsaleSyncOperationKind,
          lockName: String(reqRaw.lock_name),
          resourceKey: reqRaw.resource_key == null ? null : String(reqRaw.resource_key),
          dedupeKey: String(reqRaw.dedupe_key),
          status: String(reqRaw.status) as BsaleSyncQueueStatus,
          priority: String(reqRaw.priority) as BsaleSyncPriority,
          priorityWeight: Number(reqRaw.priority_weight ?? 200),
          coalescedCount: Number(reqRaw.coalesced_count ?? 1),
          attemptCount: Number(reqRaw.attempt_count ?? 1),
          maxAttempts: Number(reqRaw.max_attempts ?? 3),
          ttlSeconds: Number(reqRaw.ttl_seconds ?? 600),
          triggerType: String(reqRaw.trigger_type ?? 'MANUAL'),
          requestedBy: reqRaw.requested_by == null ? null : String(reqRaw.requested_by),
          payload: ((reqRaw.payload ?? {}) as Record<string, unknown>),
          enqueuedAt: String(reqRaw.enqueued_at),
          startedAt: reqRaw.started_at == null ? null : String(reqRaw.started_at),
        },
      }
    },
    async complete(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('complete_bsale_sync_request_v1', {
        p_request_id: params.requestId,
        p_company_id: params.companyId,
        p_lock_name: params.lockName,
        p_credential_scope: params.credentialScope,
        p_owner_token: params.ownerToken,
        p_duration_ms: Math.max(0, Math.round(params.durationMs)),
        p_sync_run_id: params.syncRunId ?? null,
        p_result_summary: params.resultSummary ?? {},
      })
      if (error) {
        return { completed: false, reason: error.message }
      }
      const row = (data ?? {}) as Record<string, unknown>
      return {
        completed: row.completed === true,
        status: row.status == null ? undefined : String(row.status) as BsaleSyncQueueStatus,
        reason: row.reason == null ? undefined : String(row.reason),
      }
    },
    async failOrRetry(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('fail_or_retry_bsale_sync_request_v1', {
        p_request_id: params.requestId,
        p_company_id: params.companyId,
        p_lock_name: params.lockName,
        p_credential_scope: params.credentialScope,
        p_owner_token: params.ownerToken,
        p_error_code: params.errorCode,
        p_error_message: params.errorMessage,
        p_retryable: params.retryable,
        p_http_status: params.httpStatus ?? null,
        p_retry_after_seconds: params.retryAfterSeconds ?? null,
        p_duration_ms: Math.max(0, Math.round(params.durationMs)),
        p_sync_run_id: params.syncRunId ?? null,
        p_result_summary: params.resultSummary ?? null,
      })
      if (error) {
        return { updated: false, reason: error.message }
      }
      const row = (data ?? {}) as Record<string, unknown>
      return {
        updated: row.updated === true,
        status: row.status == null ? undefined : String(row.status) as BsaleSyncQueueStatus,
        nextAvailableAt: row.next_available_at == null ? null : String(row.next_available_at),
        backoffSeconds: row.backoff_seconds == null ? null : Number(row.backoff_seconds),
        reason: row.reason == null ? undefined : String(row.reason),
      }
    },
    async cancel(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('cancel_bsale_sync_request_v1', {
        p_request_id: params.requestId,
        p_company_id: params.companyId,
        p_reason: params.reason ?? null,
      })
      if (error) {
        return { cancelled: false, reason: error.message }
      }
      const row = (data ?? {}) as Record<string, unknown>
      return {
        cancelled: row.cancelled === true,
        reason: row.reason == null ? undefined : String(row.reason),
      }
    },
  }
}

export function classifyBsaleQueueError(error: unknown): {
  errorCode: string
  errorMessage: string
  httpStatus: number | null
  retryAfterSeconds: number | null
  retryable: boolean
} {
  const message = error instanceof Error ? error.message : String(error)

  if (error instanceof BsaleRateLimitError) {
    return {
      errorCode: 'BSALE_RATE_LIMITED_429',
      errorMessage: message,
      httpStatus: 429,
      retryAfterSeconds: error.retryAfterSeconds,
      retryable: true,
    }
  }

  const maybeApiErr = error as { status?: unknown; retryAfterSeconds?: unknown; body?: unknown } | null
  if (maybeApiErr && Number(maybeApiErr.status) === 429) {
    const retryAfter = typeof maybeApiErr.retryAfterSeconds === 'number' && maybeApiErr.retryAfterSeconds > 0
      ? maybeApiErr.retryAfterSeconds
      : parseBsaleRetryAfterSeconds(null, typeof maybeApiErr.body === 'string' ? maybeApiErr.body : message)
    return {
      errorCode: 'BSALE_RATE_LIMITED_429',
      errorMessage: message,
      httpStatus: 429,
      retryAfterSeconds: retryAfter,
      retryable: true,
    }
  }

  if (/\b(?:HTTP\s*429|error\s*429|429\s*Too\s*Many\s*Requests)\b/i.test(message)) {
    return {
      errorCode: 'BSALE_RATE_LIMITED_429',
      errorMessage: message,
      httpStatus: 429,
      retryAfterSeconds: parseBsaleRetryAfterSeconds(null, message),
      retryable: true,
    }
  }

  if (error instanceof BsaleSyncLeaseLostError || /BSALE_SYNC_LEASE_(?:LOST|UNVERIFIED)/.test(message)) {
    return {
      errorCode: error instanceof BsaleSyncLeaseLostError ? error.code : 'BSALE_SYNC_LEASE_LOST',
      errorMessage: message,
      httpStatus: null,
      retryAfterSeconds: null,
      retryable: true,
    }
  }

  const statusMatch = message.match(/\b(?:HTTP|error)\s*(500|502|503|504)\b/i)
  if (statusMatch || (maybeApiErr && [500, 502, 503, 504].includes(Number(maybeApiErr?.status)))) {
    const status = statusMatch ? Number(statusMatch[1]) : Number(maybeApiErr?.status)
    return {
      errorCode: `BSALE_HTTP_${status}`,
      errorMessage: message,
      httpStatus: status,
      retryAfterSeconds: null,
      retryable: true,
    }
  }

  if (/fetch failed|ECONNRESET|ETIMEDOUT|TimeoutError|aborted/i.test(message)) {
    return {
      errorCode: 'TRANSIENT_NETWORK_ERROR',
      errorMessage: message,
      httpStatus: null,
      retryAfterSeconds: null,
      retryable: true,
    }
  }

  return {
    errorCode: 'EXECUTION_FAILED',
    errorMessage: message,
    httpStatus: maybeApiErr && typeof maybeApiErr.status === 'number' ? maybeApiErr.status : null,
    retryAfterSeconds: null,
    retryable: false,
  }
}

export interface BsaleSyncQueueManagerOptions {
  store?: BsaleSyncQueueStore
  workerId?: string
  heartbeatIntervalMs?: number
  leaseSafetyMarginMs?: number
  maxStarvationSeconds?: number
  agingStepSeconds?: number
  maxDrainIterations?: number
  autoScheduleTimers?: boolean
}

export interface DrainBsaleSyncQueueSummary {
  workerId: string
  recoveredToPending: number
  failedExhausted: number
  cancelledSuperseded: number
  processedCount: number
  completedIds: string[]
  retriedIds: string[]
  failedIds: string[]
  nextAvailableAt: string | null
}

// Máximo intervalo seguro de setTimeout en Node.js (~24.8 días), sin truncar plazos Retry-After > 300s.
const MAX_NODE_TIMER_MS = 2_147_483_000

export function createBsaleSyncQueueManager(options: BsaleSyncQueueManagerOptions = {}) {
  const store = options.store ?? createSupabaseBsaleSyncQueueStore()
  const workerId = options.workerId ?? `bsale-queue-worker:${randomUUID().slice(0, 8)}`
  const executors = new Map<BsaleSyncOperationKind, BsaleSyncQueueExecutor>()
  const scheduledWakeups = new Set<ReturnType<typeof setTimeout>>()
  const scheduledImmediates = new Set<ReturnType<typeof setImmediate>>()
  const autoScheduleTimers = options.autoScheduleTimers ?? true

  let activeDrainPromise: Promise<DrainBsaleSyncQueueSummary> | null = null
  let pendingRedrain = false
  let disposed = false

  function registerExecutor(operationKind: BsaleSyncOperationKind, executor: BsaleSyncQueueExecutor) {
    assertQueueableBsaleOperation(operationKind)
    executors.set(operationKind, executor)
  }

  function scheduleWakeupAt(isoTimestamp: string | null | undefined) {
    if (!autoScheduleTimers || !isoTimestamp) return
    if (!getBsaleSyncRolloutConfig().supervisorEnabled) return
    const targetMs = Date.parse(isoTimestamp)
    if (!Number.isFinite(targetMs)) return
    const delayMs = Math.min(MAX_NODE_TIMER_MS, Math.max(25, targetMs - Date.now() + 20))
    const timer = setTimeout(() => {
      scheduledWakeups.delete(timer)
      triggerBackgroundDrain()
    }, delayMs)
    timer.unref?.()
    scheduledWakeups.add(timer)
  }

  async function enqueue(params: {
    companyId: string
    operationKind: BsaleSyncOperationKind
    lockName?: string
    credentialScope?: string
    resourceKey?: string | null
    priority?: BsaleSyncPriority
    ttlSeconds?: number
    maxAttempts?: number
    triggerType?: string
    requestedBy?: string | null
    payload?: Record<string, unknown>
    delaySeconds?: number
    autoTriggerDrain?: boolean
  }): Promise<BsaleSyncEnqueueResult> {
    assertQueueableBsaleOperation(params.operationKind)
    const contract = buildBsaleSyncRequestContract({
      companyId: params.companyId,
      operationKind: params.operationKind,
      lockName: params.lockName,
      credentialScope: params.credentialScope,
      resourceKey: params.resourceKey,
      priority: params.priority,
      ttlSeconds: params.ttlSeconds,
      triggerType: params.triggerType,
      requestedBy: params.requestedBy,
      waitPolicy: 'ENQUEUE_WHEN_BUSY',
      metadata: params.payload,
    })

    const res = await store.enqueue({
      companyId: contract.companyId,
      credentialScope: contract.credentialScope,
      operationKind: contract.operationKind,
      lockName: contract.lockName,
      incompatibleLockNames: getIncompatibleLockNames(contract.operationKind),
      resourceKey: contract.resourceKey,
      priority: contract.priority,
      priorityWeight: contract.priorityWeight,
      ttlSeconds: contract.ttlSeconds,
      maxAttempts: params.maxAttempts ?? 3,
      triggerType: contract.triggerType,
      requestedBy: contract.requestedBy,
      payload: params.payload ?? {},
      delaySeconds: params.delaySeconds ?? 0,
    })

    const rollout = getBsaleSyncRolloutConfig()
    if (res.enqueued && params.autoTriggerDrain !== false && rollout.queueEnabled && rollout.supervisorEnabled) {
      if ((params.delaySeconds ?? 0) > 0) {
        scheduleWakeupAt(res.availableAt)
      } else {
        triggerBackgroundDrain()
      }
    }

    return res
  }

  async function executeSingleClaim(claimed: BsaleSyncClaimResult): Promise<{
    outcome: 'COMPLETED' | 'RETRIED' | 'FAILED'
    nextAvailableAt?: string | null
  }> {
    const startedAt = Date.now()
    const { request, lease } = claimed
    const executor = executors.get(request.operationKind)

    if (!executor) {
      const failRes = await store.failOrRetry({
        requestId: request.id,
        companyId: request.companyId,
        lockName: request.lockName,
        credentialScope: request.credentialScope,
        ownerToken: lease.ownerToken,
        errorCode: 'MISSING_EXECUTOR',
        errorMessage: `No existe ejecutor registrado para ${request.operationKind}.`,
        retryable: false,
        durationMs: Date.now() - startedAt,
      })
      return { outcome: 'FAILED', nextAvailableAt: failRes.nextAvailableAt }
    }

    const coordResult = await runWithBsaleSyncCoordinator({
      companyId: request.companyId,
      operationKind: request.operationKind,
      lockName: request.lockName,
      credentialScope: request.credentialScope,
      resourceKey: request.resourceKey,
      requestedBy: request.requestedBy,
      triggerType: request.triggerType,
      priority: request.priority,
      ttlSeconds: request.ttlSeconds,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      leaseSafetyMarginMs: options.leaseSafetyMarginMs,
      store: store.coordinatorStore,
      preAcquiredLease: {
        ownerToken: lease.ownerToken,
        expiresAt: lease.expiresAt,
        serverNow: lease.serverNow,
      },
      skipAutoRelease: true,
      execute: async (activeLease) => {
        activeLease.assertActive()
        const out = await executor(request, activeLease)
        activeLease.assertActive()
        return out
      },
    })

    const durationMs = Date.now() - startedAt

    if (coordResult.status === 'SUCCESS') {
      const data = coordResult.data ?? {}
      const completed = await store.complete({
        requestId: request.id,
        companyId: request.companyId,
        lockName: request.lockName,
        credentialScope: request.credentialScope,
        ownerToken: lease.ownerToken,
        durationMs,
        syncRunId: data.syncRunId ?? null,
        resultSummary: data.summary ?? {},
      })
      if (!completed.completed) {
        return { outcome: completed.status === 'PENDING' ? 'RETRIED' : 'FAILED' }
      }
      return { outcome: 'COMPLETED' }
    }

    const cause = coordResult.status === 'TECHNICAL_ERROR' ? (coordResult.cause ?? new Error(coordResult.error)) : new Error(coordResult.error)
    const classified = classifyBsaleQueueError(cause)
    const failRes = await store.failOrRetry({
      requestId: request.id,
      companyId: request.companyId,
      lockName: request.lockName,
      credentialScope: request.credentialScope,
      ownerToken: lease.ownerToken,
      errorCode: classified.errorCode,
      errorMessage: classified.errorMessage,
      retryable: classified.retryable,
      httpStatus: classified.httpStatus,
      retryAfterSeconds: classified.retryAfterSeconds,
      durationMs,
    })

    if (failRes.nextAvailableAt) {
      scheduleWakeupAt(failRes.nextAvailableAt)
    }

    return {
      outcome: failRes.status === 'PENDING' ? 'RETRIED' : 'FAILED',
      nextAvailableAt: failRes.nextAvailableAt,
    }
  }

  async function drainOnce(params?: { credentialScope?: string | null }): Promise<DrainBsaleSyncQueueSummary> {
    const recovery = await store.recover()
    const summary: DrainBsaleSyncQueueSummary = {
      workerId,
      recoveredToPending: recovery.recoveredToPending,
      failedExhausted: recovery.failedExhausted,
      cancelledSuperseded: recovery.cancelledSuperseded,
      processedCount: 0,
      completedIds: [],
      retriedIds: [],
      failedIds: [],
      nextAvailableAt: null,
    }

    const maxIterations = options.maxDrainIterations ?? 25
    for (let i = 0; i < maxIterations; i += 1) {
      const claim = await store.claimNext({
        workerId,
        credentialScope: params?.credentialScope ?? null,
        maxStarvationSeconds: options.maxStarvationSeconds,
        agingStepSeconds: options.agingStepSeconds,
      })

      if (!claim.claimed) {
        if (claim.nextAvailableAt) {
          summary.nextAvailableAt = claim.nextAvailableAt
          scheduleWakeupAt(claim.nextAvailableAt)
        }
        break
      }

      summary.processedCount += 1
      const itemOutcome = await executeSingleClaim(claim)
      if (itemOutcome.outcome === 'COMPLETED') summary.completedIds.push(claim.request.id)
      else if (itemOutcome.outcome === 'RETRIED') summary.retriedIds.push(claim.request.id)
      else summary.failedIds.push(claim.request.id)

      if (itemOutcome.nextAvailableAt && (!summary.nextAvailableAt || itemOutcome.nextAvailableAt < summary.nextAvailableAt)) {
        summary.nextAvailableAt = itemOutcome.nextAvailableAt
      }
    }

    return summary
  }

  async function drain(params?: { credentialScope?: string | null }): Promise<DrainBsaleSyncQueueSummary> {
    if (activeDrainPromise) {
      pendingRedrain = true
      return activeDrainPromise
    }

    activeDrainPromise = (async () => {
      let latestSummary = await drainOnce(params)
      while (pendingRedrain) {
        pendingRedrain = false
        const followUp = await drainOnce()
        latestSummary = {
          workerId,
          recoveredToPending: latestSummary.recoveredToPending + followUp.recoveredToPending,
          failedExhausted: latestSummary.failedExhausted + followUp.failedExhausted,
          cancelledSuperseded: latestSummary.cancelledSuperseded + followUp.cancelledSuperseded,
          processedCount: latestSummary.processedCount + followUp.processedCount,
          completedIds: [...latestSummary.completedIds, ...followUp.completedIds],
          retriedIds: [...latestSummary.retriedIds, ...followUp.retriedIds],
          failedIds: [...latestSummary.failedIds, ...followUp.failedIds],
          nextAvailableAt: followUp.nextAvailableAt ?? latestSummary.nextAvailableAt,
        }
      }
      return latestSummary
    })().finally(() => {
      activeDrainPromise = null
    })

    return activeDrainPromise
  }

  function triggerBackgroundDrain() {
    const rollout = getBsaleSyncRolloutConfig()
    if (disposed || !rollout.queueEnabled || !rollout.supervisorEnabled) return
    const handle = setImmediate(() => {
      scheduledImmediates.delete(handle)
      const currentRollout = getBsaleSyncRolloutConfig()
      if (disposed || !currentRollout.queueEnabled || !currentRollout.supervisorEnabled) return
      void drain().catch(err => {
        console.error('[bsale-sync-queue] Error procesando cola en segundo plano:', err)
      })
    })
    scheduledImmediates.add(handle)
  }

  function dispose() {
    disposed = true
    for (const handle of scheduledImmediates) {
      clearImmediate(handle)
    }
    scheduledImmediates.clear()
    for (const timer of scheduledWakeups) {
      clearTimeout(timer)
    }
    scheduledWakeups.clear()
  }

  return {
    workerId,
    store,
    registerExecutor,
    enqueue,
    drain,
    triggerBackgroundDrain,
    cancel: store.cancel,
    dispose,
  }
}

export type BsaleSyncQueueManager = ReturnType<typeof createBsaleSyncQueueManager>

type GlobalBsaleSyncQueueState = {
  manager: BsaleSyncQueueManager | null
  unsubscribeReleaseHook: (() => void) | null
}

const GLOBAL_BSALE_QUEUE_STATE_KEY = '__mymBsaleSyncQueueGlobalState__' as const

function getGlobalQueueState(): GlobalBsaleSyncQueueState {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_BSALE_QUEUE_STATE_KEY] || typeof g[GLOBAL_BSALE_QUEUE_STATE_KEY] !== 'object') {
    g[GLOBAL_BSALE_QUEUE_STATE_KEY] = {
      manager: null,
      unsubscribeReleaseHook: null,
    } satisfies GlobalBsaleSyncQueueState
  }
  return g[GLOBAL_BSALE_QUEUE_STATE_KEY] as GlobalBsaleSyncQueueState
}

export function getGlobalBsaleSyncQueueManager(): BsaleSyncQueueManager {
  const state = getGlobalQueueState()
  if (!state.manager) {
    state.manager = createBsaleSyncQueueManager()
    state.unsubscribeReleaseHook = onBsaleCoordinatorLockReleased(() => {
      const rollout = getBsaleSyncRolloutConfig()
      if (rollout.queueEnabled && rollout.supervisorEnabled) {
        state.manager?.triggerBackgroundDrain()
      }
    })
  }
  return state.manager
}

export function resetGlobalBsaleSyncQueueManagerForTests() {
  const state = getGlobalQueueState()
  state.unsubscribeReleaseHook?.()
  state.unsubscribeReleaseHook = null
  state.manager?.dispose()
  state.manager = null
}
