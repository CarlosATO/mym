import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
// @ts-expect-error The local strip-types test runner resolves the source extension directly.
import { getBsaleConfigForCompany } from '../bsale/company-config.ts'

export type BsaleSyncOperationKind =
  | 'REPLENISHMENT_SYNC'
  | 'OPERATIONAL_PREP_SYNC'
  | 'WAREHOUSE_INCREMENTAL'
  | 'WAREHOUSE_OPERATIONAL'
  | 'WAREHOUSE_MANUAL'
  | 'WAREHOUSE_FULL_REFRESH'
  | 'CARD_SYNC'
  | 'INCIDENT_SYNC'
  | 'AUDIT_SYNC'
  | 'COBRANZA_SNAPSHOT'

export type BsaleSyncLockName =
  | 'bsale_replenishment_sync'
  | 'bsale_operational_prep_sync'
  | 'bsale_warehouse_full_refresh'
  | 'bsale_cobranza_manual_dispatch'

export type BsaleSyncPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW'
export type BsaleSyncWaitPolicy = 'FAIL_FAST' | 'ENQUEUE_WHEN_BUSY'

export interface BsaleSyncRolloutConfig {
  coordinatorEnabled: boolean
  queueEnabled: boolean
  supervisorEnabled: boolean
}

function parseRolloutEnvFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue
  const normalized = value.trim().toLowerCase()
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
  return defaultValue
}

/**
 * Configuración de activación controlada y reversible en caliente mediante variables
 * de entorno para la transición desde la versión publicada (d99eaf2):
 * - BSALE_SYNC_COORDINATOR_ENABLED=false -> revierte al bloqueo legacy por tabla.
 * - BSALE_SYNC_QUEUE_ENABLED=false       -> conserva coordinador atómico sin encolar (modo SYNC-01).
 * - BSALE_SYNC_SUPERVISOR_ENABLED=false  -> desactiva el barrido en memoria de instrumentation.ts.
 */
export function getBsaleSyncRolloutConfig(): BsaleSyncRolloutConfig {
  const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build'
  const coordinatorEnabled = parseRolloutEnvFlag(process.env.BSALE_SYNC_COORDINATOR_ENABLED, true)
  const queueEnabled = coordinatorEnabled && parseRolloutEnvFlag(process.env.BSALE_SYNC_QUEUE_ENABLED, true)
  const supervisorEnabled = !isBuildPhase && queueEnabled && parseRolloutEnvFlag(process.env.BSALE_SYNC_SUPERVISOR_ENABLED, true)
  return {
    coordinatorEnabled,
    queueEnabled,
    supervisorEnabled,
  }
}

export class BsaleSyncCredentialResolutionError extends Error {
  readonly code = 'BSALE_SYNC_CREDENTIALS_UNRESOLVED'
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'BsaleSyncCredentialResolutionError'
    this.cause = cause
  }
}

export class BsaleSyncLeaseLostError extends Error {
  readonly code: 'BSALE_SYNC_LEASE_LOST' | 'BSALE_SYNC_LEASE_UNVERIFIED'

  constructor(
    code: 'BSALE_SYNC_LEASE_LOST' | 'BSALE_SYNC_LEASE_UNVERIFIED',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'BsaleSyncLeaseLostError'
    this.code = code
  }
}

export class BsaleRateLimitError extends Error {
  readonly status = 429
  readonly code = 'BSALE_RATE_LIMITED_429'
  readonly retryAfterSeconds: number
  readonly body?: string

  constructor(
    message: string,
    retryAfterSeconds: number,
    body?: string,
  ) {
    super(message)
    this.name = 'BsaleRateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
    this.body = body
  }
}

// Límite superior únicamente para cabe dentro de PostgreSQL integer / temporizadores Node (~24 días),
// respetando íntegramente cualquier plazo válido de Retry-After indicado por Bsale (incluidos > 300s).
const MAX_SAFE_RETRY_AFTER_SECONDS = 2_000_000

export function parseBsaleRetryAfterSeconds(
  retryAfterHeader: string | null | undefined,
  bodyText?: string | null,
  defaultSeconds = 30,
): number {
  const normalizeValidSeconds = (val: number) => Math.min(MAX_SAFE_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(val)))

  if (retryAfterHeader) {
    const trimmed = retryAfterHeader.trim()
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed)
      if (Number.isFinite(numeric) && numeric > 0) return normalizeValidSeconds(numeric)
    }
    const parsedDateMs = Date.parse(trimmed)
    if (Number.isFinite(parsedDateMs)) {
      const deltaSeconds = (parsedDateMs - Date.now()) / 1000
      if (deltaSeconds > 0) return normalizeValidSeconds(deltaSeconds)
    }
  }

  if (bodyText) {
    const bodyMatch = bodyText.match(/retry[_-]?after\s*["']?\s*[:=]\s*["']?\s*(\d+(?:\.\d+)?)/i)
    if (bodyMatch?.[1]) {
      const numeric = Number(bodyMatch[1])
      if (Number.isFinite(numeric) && numeric > 0) return normalizeValidSeconds(numeric)
    }
  }

  return normalizeValidSeconds(defaultSeconds)
}

export interface BsaleSyncRequestContract {
  companyId: string
  operationKind: BsaleSyncOperationKind
  lockName: BsaleSyncLockName | string
  credentialScope: string
  resourceKey: string | null
  runId: string | null
  requestedBy: string | null
  triggerType: string
  priority: BsaleSyncPriority
  priorityWeight: number
  dedupeKey: string
  waitPolicy: BsaleSyncWaitPolicy
  ttlSeconds: number
  metadata: Record<string, unknown>
}

export interface BsaleSyncBlockingInfo {
  lockName: string
  operationKind: string | null
  runId: string | null
  resourceKey: string | null
  expiresAt: string | null
  reason?: string | null
  retryAfterSeconds?: number | null
}

export type BsaleSyncExecutionResult<T> =
  | {
    status: 'SUCCESS'
    ok: true
    data: T
    coordinator: {
      lockName: string
      ownerToken: string
      credentialScope: string
      confirmedExpiresAt: string
      reentrant: boolean
      renewedCount: number
      durationMs: number
      requestContract: BsaleSyncRequestContract
    }
  }
  | {
    status: 'LOCK_BUSY'
    ok: false
    error: string
    blocking: BsaleSyncBlockingInfo
    coordinator: {
      lockName: string
      credentialScope: string
      dedupeKey: string
      requestContract: BsaleSyncRequestContract
    }
  }
  | {
    status: 'TECHNICAL_ERROR'
    ok: false
    error: string
    cause?: unknown
    coordinator: {
      lockName: string
      ownerToken: string
      credentialScope: string
      confirmedExpiresAt: string | null
      reentrant: boolean
      renewedCount: number
      durationMs: number
      requestContract: BsaleSyncRequestContract
    }
  }

export interface BsaleSyncLease {
  companyId: string
  lockName: string
  ownerToken: string
  operationKind: BsaleSyncOperationKind
  credentialScope: string
  resourceKey: string | null
  runId: string | null
  ttlSeconds: number
  confirmedExpiresAt: string
  confirmedLeaseUntilMs: number
  reentrant: boolean
  renewedCount: number
  renewalFailureCount: number
  lastRenewalError: string | null
  released: boolean
  lostOwnership: boolean
  uncertainValidity: boolean
  signal: AbortSignal
  assertActive: () => void
}

export interface BsaleSyncCoordinatorStore {
  acquire: (params: {
    companyId: string
    lockName: string
    ownerToken: string
    operationKind: BsaleSyncOperationKind
    credentialScope: string
    resourceKey: string | null
    runId: string | null
    ttlSeconds: number
    incompatibleLockNames: string[]
    metadata: Record<string, unknown>
  }) => Promise<
    | { acquired: true; expiresAt: string; serverNow?: string }
    | { acquired: false; blocking: BsaleSyncBlockingInfo }
  >
  renew: (params: {
    companyId: string
    lockName: string
    credentialScope: string
    ownerToken: string
    ttlSeconds: number
  }) => Promise<{ renewed: boolean; expiresAt?: string; serverNow?: string; reason?: string }>
  release: (params: {
    companyId: string
    lockName: string
    credentialScope: string
    ownerToken: string
  }) => Promise<{ released: boolean; reason?: string }>
  registerCooldown?: (params: {
    companyId: string
    credentialScope: string
    retryAfterSeconds: number
    httpStatus?: number
    reason?: string
  }) => Promise<{ blockedUntil?: string; retryAfterSeconds?: number }>
}

type CoordinatorContextEntry = {
  companyId: string
  credentialScope: string
  lockName: string
  ownerToken: string
  operationKind: BsaleSyncOperationKind
  resourceKey: string | null
  runId: string | null
  depth: number
  signal: AbortSignal
  assertActive: () => void
}

const coordinatorContextStorage = new AsyncLocalStorage<CoordinatorContextEntry[]>()

type LockReleaseListener = (info: {
  companyId: string
  credentialScope: string
  lockName: string
}) => void

const GLOBAL_LOCK_RELEASE_LISTENERS_KEY = '__mymBsaleCoordinatorLockReleaseListeners__' as const

function getGlobalLockReleaseListeners(): Set<LockReleaseListener> {
  const g = globalThis as Record<string, unknown>
  if (!(g[GLOBAL_LOCK_RELEASE_LISTENERS_KEY] instanceof Set)) {
    g[GLOBAL_LOCK_RELEASE_LISTENERS_KEY] = new Set<LockReleaseListener>()
  }
  return g[GLOBAL_LOCK_RELEASE_LISTENERS_KEY] as Set<LockReleaseListener>
}

export function onBsaleCoordinatorLockReleased(listener: LockReleaseListener): () => void {
  const listeners = getGlobalLockReleaseListeners()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notifyLockReleased(info: { companyId: string; credentialScope: string; lockName: string }) {
  for (const listener of getGlobalLockReleaseListeners()) {
    try {
      listener(info)
    } catch {
      // Listeners must never disrupt lock cleanup.
    }
  }
}

const ALLOWED_REENTRANT_CHILDREN: Record<BsaleSyncOperationKind, BsaleSyncOperationKind[]> = {
  REPLENISHMENT_SYNC: [
    'REPLENISHMENT_SYNC',
    'OPERATIONAL_PREP_SYNC',
    'WAREHOUSE_INCREMENTAL',
    'WAREHOUSE_OPERATIONAL',
    'WAREHOUSE_MANUAL',
    'CARD_SYNC',
    'INCIDENT_SYNC',
    'AUDIT_SYNC',
  ],
  WAREHOUSE_FULL_REFRESH: [
    'WAREHOUSE_FULL_REFRESH',
    'OPERATIONAL_PREP_SYNC',
    'WAREHOUSE_INCREMENTAL',
    'WAREHOUSE_OPERATIONAL',
    'WAREHOUSE_MANUAL',
    'CARD_SYNC',
    'INCIDENT_SYNC',
    'AUDIT_SYNC',
  ],
  OPERATIONAL_PREP_SYNC: [
    'OPERATIONAL_PREP_SYNC',
    'WAREHOUSE_INCREMENTAL',
    'WAREHOUSE_OPERATIONAL',
    'WAREHOUSE_MANUAL',
    'CARD_SYNC',
    'INCIDENT_SYNC',
    'AUDIT_SYNC',
  ],
  WAREHOUSE_MANUAL: [
    'WAREHOUSE_MANUAL',
    'OPERATIONAL_PREP_SYNC',
    'WAREHOUSE_INCREMENTAL',
    'WAREHOUSE_OPERATIONAL',
    'CARD_SYNC',
    'INCIDENT_SYNC',
    'AUDIT_SYNC',
  ],
  WAREHOUSE_INCREMENTAL: ['WAREHOUSE_INCREMENTAL', 'OPERATIONAL_PREP_SYNC', 'CARD_SYNC', 'INCIDENT_SYNC', 'AUDIT_SYNC'],
  WAREHOUSE_OPERATIONAL: ['WAREHOUSE_OPERATIONAL', 'OPERATIONAL_PREP_SYNC', 'CARD_SYNC', 'INCIDENT_SYNC', 'AUDIT_SYNC'],
  CARD_SYNC: ['CARD_SYNC'],
  INCIDENT_SYNC: ['INCIDENT_SYNC'],
  AUDIT_SYNC: ['AUDIT_SYNC'],
  COBRANZA_SNAPSHOT: ['COBRANZA_SNAPSHOT'],
}

const INCOMPATIBLE_LOCKS_BY_OPERATION: Record<BsaleSyncOperationKind, string[]> = {
  REPLENISHMENT_SYNC: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  OPERATIONAL_PREP_SYNC: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  WAREHOUSE_INCREMENTAL: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  WAREHOUSE_OPERATIONAL: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  WAREHOUSE_MANUAL: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  WAREHOUSE_FULL_REFRESH: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  CARD_SYNC: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  INCIDENT_SYNC: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  AUDIT_SYNC: ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'],
  COBRANZA_SNAPSHOT: ['bsale_replenishment_sync', 'bsale_cobranza_manual_dispatch'],
}

const DEFAULT_PRIORITY_BY_OPERATION: Record<BsaleSyncOperationKind, BsaleSyncPriority> = {
  INCIDENT_SYNC: 'CRITICAL',
  CARD_SYNC: 'HIGH',
  AUDIT_SYNC: 'HIGH',
  WAREHOUSE_MANUAL: 'HIGH',
  WAREHOUSE_OPERATIONAL: 'NORMAL',
  WAREHOUSE_INCREMENTAL: 'NORMAL',
  OPERATIONAL_PREP_SYNC: 'NORMAL',
  WAREHOUSE_FULL_REFRESH: 'NORMAL',
  REPLENISHMENT_SYNC: 'LOW',
  COBRANZA_SNAPSHOT: 'LOW',
}

export const PRIORITY_WEIGHT_BY_OPERATION: Record<BsaleSyncOperationKind, number> = {
  INCIDENT_SYNC: 400,
  CARD_SYNC: 300,
  AUDIT_SYNC: 300,
  WAREHOUSE_MANUAL: 240,
  WAREHOUSE_OPERATIONAL: 220,
  WAREHOUSE_INCREMENTAL: 200,
  OPERATIONAL_PREP_SYNC: 200,
  WAREHOUSE_FULL_REFRESH: 150,
  REPLENISHMENT_SYNC: 100,
  COBRANZA_SNAPSHOT: 100,
}

export function getIncompatibleLockNames(operationKind: BsaleSyncOperationKind): string[] {
  return [...(INCOMPATIBLE_LOCKS_BY_OPERATION[operationKind] ?? ['bsale_replenishment_sync', 'bsale_operational_prep_sync', 'bsale_warehouse_full_refresh'])]
}

export function getDefaultLockNameForOperation(operationKind: BsaleSyncOperationKind): BsaleSyncLockName {
  if (operationKind === 'REPLENISHMENT_SYNC') return 'bsale_replenishment_sync'
  if (operationKind === 'WAREHOUSE_FULL_REFRESH') return 'bsale_warehouse_full_refresh'
  if (operationKind === 'COBRANZA_SNAPSHOT') return 'bsale_cobranza_manual_dispatch'
  return 'bsale_operational_prep_sync'
}

function validateExplicitCredentialScope(scope: string): string {
  const trimmed = scope.trim()
  if (!trimmed.startsWith('cred:') || trimmed.length <= 5) {
    throw new BsaleSyncCredentialResolutionError(
      `Alcance de credenciales Bsale inválido ("${scope}"). Debe comenzar con "cred:" y derivarse de credenciales válidas.`,
    )
  }
  return trimmed
}

export function resolveBsaleCredentialScope(companyId: string): string {
  if (!companyId || !companyId.trim()) {
    throw new BsaleSyncCredentialResolutionError('BSALE_SYNC_CREDENTIALS_UNRESOLVED: companyId vacío.')
  }
  let config: ReturnType<typeof getBsaleConfigForCompany>
  try {
    config = getBsaleConfigForCompany(companyId)
  } catch (error) {
    throw new BsaleSyncCredentialResolutionError(
      `BSALE_SYNC_CREDENTIALS_UNRESOLVED: no se pudieron resolver las credenciales Bsale para companyId="${companyId}": ${error instanceof Error ? error.message : String(error)}`,
      error,
    )
  }
  const baseUrl = config?.baseUrl?.trim()
  const accessToken = config?.accessToken?.trim()
  if (!baseUrl || !accessToken) {
    throw new BsaleSyncCredentialResolutionError(
      `BSALE_SYNC_CREDENTIALS_UNRESOLVED: configuración Bsale incompleta para companyId="${companyId}".`,
    )
  }
  const digest = createHash('sha256')
    .update(`${baseUrl}|${accessToken}`)
    .digest('hex')
    .slice(0, 24)
  return `cred:${digest}`
}

export function buildBsaleSyncDedupeKey(params: {
  companyId: string
  operationKind: BsaleSyncOperationKind
  resourceKey?: string | null
}): string {
  const normalizedCompany = params.companyId.trim()
  if (!normalizedCompany) {
    throw new Error('companyId es obligatorio para construir dedupeKey.')
  }
  const normalizedResource = params.resourceKey?.trim() ? params.resourceKey.trim() : 'ALL'
  return `${normalizedCompany}:${params.operationKind}:${normalizedResource}`
}

export function buildBsaleSyncRequestContract(params: {
  companyId: string
  operationKind: BsaleSyncOperationKind
  lockName?: BsaleSyncLockName | string
  credentialScope?: string
  resourceKey?: string | null
  runId?: string | null
  requestedBy?: string | null
  triggerType?: string
  priority?: BsaleSyncPriority
  waitPolicy?: BsaleSyncWaitPolicy
  ttlSeconds?: number
  metadata?: Record<string, unknown>
}): BsaleSyncRequestContract {
  const credentialScope = params.credentialScope !== undefined
    ? validateExplicitCredentialScope(params.credentialScope)
    : resolveBsaleCredentialScope(params.companyId)
  const lockName = params.lockName ?? getDefaultLockNameForOperation(params.operationKind)
  const resourceKey = params.resourceKey?.trim() ? params.resourceKey.trim() : null
  const dedupeKey = buildBsaleSyncDedupeKey({
    companyId: params.companyId,
    operationKind: params.operationKind,
    resourceKey,
  })
  return {
    companyId: params.companyId,
    operationKind: params.operationKind,
    lockName,
    credentialScope,
    resourceKey,
    runId: params.runId ?? null,
    requestedBy: params.requestedBy ?? null,
    triggerType: params.triggerType ?? 'MANUAL',
    priority: params.priority ?? DEFAULT_PRIORITY_BY_OPERATION[params.operationKind],
    priorityWeight: PRIORITY_WEIGHT_BY_OPERATION[params.operationKind] ?? 200,
    dedupeKey,
    waitPolicy: params.waitPolicy ?? 'FAIL_FAST',
    ttlSeconds: Math.max(1, Math.floor(params.ttlSeconds ?? 600)),
    metadata: params.metadata ?? {},
  }
}

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

let customCoordinatorStoreOverride: BsaleSyncCoordinatorStore | null = null

export function setCustomBsaleSyncCoordinatorStoreForTests(store: BsaleSyncCoordinatorStore | null) {
  customCoordinatorStoreOverride = store
}

export function createSupabaseBsaleSyncCoordinatorStore(): BsaleSyncCoordinatorStore {
  if (customCoordinatorStoreOverride) return customCoordinatorStoreOverride
  if (!getBsaleSyncRolloutConfig().coordinatorEnabled) {
    return {
      async acquire(params) {
        const db = getSupabaseAdmin().schema('integraciones')
        const nowIso = new Date().toISOString()
        await db.from('bsale_sync_locks')
          .delete()
          .eq('company_id', params.companyId)
          .eq('lock_name', params.lockName)
          .lt('expires_at', nowIso)
        const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString()
        const { error } = await db.from('bsale_sync_locks')
          .insert({
            company_id: params.companyId,
            lock_name: params.lockName,
            run_id: params.runId,
            acquired_at: nowIso,
            expires_at: expiresAt,
          })
          .select('lock_name')
          .single()
        if (error) {
          return {
            acquired: false,
            blocking: {
              lockName: params.lockName,
              operationKind: null,
              runId: null,
              resourceKey: null,
              expiresAt: null,
              reason: 'LEGACY_LOCK_ACTIVE',
            },
          }
        }
        return { acquired: true, expiresAt, serverNow: nowIso }
      },
      async renew(params) {
        const db = getSupabaseAdmin().schema('integraciones')
        const nowIso = new Date().toISOString()
        const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString()
        const { error } = await db.from('bsale_sync_locks')
          .update({ expires_at: expiresAt })
          .eq('company_id', params.companyId)
          .eq('lock_name', params.lockName)
        if (error) return { renewed: false, reason: error.message }
        return { renewed: true, expiresAt, serverNow: nowIso }
      },
      async release(params) {
        const db = getSupabaseAdmin().schema('integraciones')
        await db.from('bsale_sync_locks')
          .delete()
          .eq('company_id', params.companyId)
          .eq('lock_name', params.lockName)
        return { released: true }
      },
    }
  }
  return {
    async acquire(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('acquire_bsale_sync_lock_v1', {
        p_company_id: params.companyId,
        p_lock_name: params.lockName,
        p_owner_token: params.ownerToken,
        p_operation_kind: params.operationKind,
        p_credential_scope: params.credentialScope,
        p_resource_key: params.resourceKey,
        p_run_id: params.runId,
        p_ttl_seconds: params.ttlSeconds,
        p_incompatible_lock_names: params.incompatibleLockNames,
        p_metadata: params.metadata,
      })
      if (error) {
        throw new Error(`Error al adquirir bloqueo Bsale (${params.lockName}): ${error.message}`)
      }
      const payload = (data ?? {}) as Record<string, unknown>
      if (payload.acquired === true) {
        const expiresAt = String(payload.expires_at ?? '')
        if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
          throw new Error(`PostgreSQL no devolvió expires_at válido al adquirir ${params.lockName}`)
        }
        return {
          acquired: true,
          expiresAt,
          serverNow: payload.server_now == null ? undefined : String(payload.server_now),
        }
      }
      return {
        acquired: false,
        blocking: {
          lockName: String(payload.blocking_lock_name ?? params.lockName),
          operationKind: payload.blocking_operation_kind == null ? null : String(payload.blocking_operation_kind),
          runId: payload.blocking_run_id == null ? null : String(payload.blocking_run_id),
          resourceKey: payload.blocking_resource_key == null ? null : String(payload.blocking_resource_key),
          expiresAt: payload.blocking_expires_at == null ? null : String(payload.blocking_expires_at),
          reason: payload.reason == null ? null : String(payload.reason),
          retryAfterSeconds: typeof payload.retry_after_seconds === 'number' ? payload.retry_after_seconds : null,
        },
      }
    },
    async renew(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('renew_bsale_sync_lock_v1', {
        p_company_id: params.companyId,
        p_lock_name: params.lockName,
        p_owner_token: params.ownerToken,
        p_ttl_seconds: params.ttlSeconds,
        p_credential_scope: params.credentialScope,
      })
      if (error) {
        return { renewed: false, reason: error.message }
      }
      const payload = (data ?? {}) as Record<string, unknown>
      return {
        renewed: payload.renewed === true,
        expiresAt: payload.expires_at == null ? undefined : String(payload.expires_at),
        serverNow: payload.server_now == null ? undefined : String(payload.server_now),
        reason: payload.reason == null ? undefined : String(payload.reason),
      }
    },
    async release(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('release_bsale_sync_lock_v1', {
        p_company_id: params.companyId,
        p_lock_name: params.lockName,
        p_owner_token: params.ownerToken,
        p_credential_scope: params.credentialScope,
      })
      if (error) {
        return { released: false, reason: error.message }
      }
      const payload = (data ?? {}) as Record<string, unknown>
      return {
        released: payload.released === true,
        reason: payload.reason == null ? undefined : String(payload.reason),
      }
    },
    async registerCooldown(params) {
      const db = getSupabaseAdmin().schema('integraciones')
      const { data, error } = await db.rpc('register_bsale_scope_cooldown_v1', {
        p_company_id: params.companyId,
        p_credential_scope: params.credentialScope,
        p_retry_after_seconds: params.retryAfterSeconds,
        p_http_status: params.httpStatus ?? 429,
        p_reason: params.reason ?? null,
      })
      if (error) {
        throw new Error(`Error al registrar cooldown Bsale: ${error.message}`)
      }
      const payload = (data ?? {}) as Record<string, unknown>
      return {
        blockedUntil: payload.blocked_until == null ? undefined : String(payload.blocked_until),
        retryAfterSeconds: typeof payload.retry_after_seconds === 'number' ? payload.retry_after_seconds : undefined,
      }
    },
  }
}

export function getActiveBsaleCoordinatorContexts(): CoordinatorContextEntry[] {
  return coordinatorContextStorage.getStore() ?? []
}

export function getActiveBsaleCoordinatorSignal(): AbortSignal | undefined {
  const contexts = getActiveBsaleCoordinatorContexts()
  if (contexts.length === 0) return undefined
  return contexts[contexts.length - 1].signal
}

export function assertActiveBsaleCoordinatorLease(): void {
  const contexts = getActiveBsaleCoordinatorContexts()
  for (const ctx of contexts) {
    ctx.assertActive()
  }
}

export function composeBsaleProtectedSignal(options?: {
  signal?: AbortSignal
  timeoutMs?: number
}): AbortSignal | undefined {
  assertActiveBsaleCoordinatorLease()
  const signals: AbortSignal[] = []
  const coordSignal = getActiveBsaleCoordinatorSignal()
  if (coordSignal) signals.push(coordSignal)
  if (options?.signal) signals.push(options.signal)
  if (options?.timeoutMs && options.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(options.timeoutMs))
  }
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

export async function bsaleProtectedFetch(
  input: string | URL,
  init?: RequestInit & { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<Response> {
  assertActiveBsaleCoordinatorLease()
  const { timeoutMs, fetchImpl, signal: callerSignal, ...restInit } = init ?? {}
  const composedSignal = composeBsaleProtectedSignal({ signal: callerSignal ?? undefined, timeoutMs })
  const effectiveFetch = fetchImpl ?? fetch
  const response = await effectiveFetch(input, {
    ...restInit,
    ...(composedSignal ? { signal: composedSignal } : {}),
  })
  assertActiveBsaleCoordinatorLease()
  return response
}

function findActiveScopeContext(
  contexts: CoordinatorContextEntry[],
  credentialScope: string,
): CoordinatorContextEntry | null {
  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    if (contexts[i].credentialScope === credentialScope) return contexts[i]
  }
  return null
}

function isReentrantOperationCompatible(
  parent: CoordinatorContextEntry,
  childOperationKind: BsaleSyncOperationKind,
  childResourceKey: string | null,
): boolean {
  const allowed = ALLOWED_REENTRANT_CHILDREN[parent.operationKind] ?? []
  if (!allowed.includes(childOperationKind)) return false
  if (parent.resourceKey !== null && parent.resourceKey !== childResourceKey) return false
  return true
}

function defaultBusyMessage(operationKind: BsaleSyncOperationKind, blocking: BsaleSyncBlockingInfo): string {
  if (blocking.reason === 'COOLDOWN_ACTIVE' || blocking.operationKind === 'HTTP_429_COOLDOWN') {
    const secs = blocking.retryAfterSeconds ? ` (${blocking.retryAfterSeconds}s)` : ''
    return `Credenciales Bsale en enfriamiento por límite de tasa HTTP 429${secs}.`
  }
  const blockingLabel = blocking.operationKind ?? blocking.lockName
  if (operationKind === 'CARD_SYNC' || operationKind === 'INCIDENT_SYNC' || operationKind === 'AUDIT_SYNC') {
    return `Ya existe una sincronización de Bsale en curso (${blockingLabel}). Intenta nuevamente en unos segundos.`
  }
  return `Sincronización Bsale ocupada por ${blockingLabel}.`
}

function extractRateLimitRetrySecondsFromError(error: unknown): number | null {
  if (error instanceof BsaleRateLimitError) return error.retryAfterSeconds
  const maybeApiErr = error as { status?: unknown; retryAfterSeconds?: unknown; body?: unknown } | null
  if (maybeApiErr && Number(maybeApiErr.status) === 429) {
    if (typeof maybeApiErr.retryAfterSeconds === 'number' && maybeApiErr.retryAfterSeconds > 0) {
      return maybeApiErr.retryAfterSeconds
    }
    const msg = error instanceof Error ? error.message : String(error)
    return parseBsaleRetryAfterSeconds(null, typeof maybeApiErr.body === 'string' ? maybeApiErr.body : msg)
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/\b(?:HTTP\s*429|error\s*429|429\s*Too\s*Many\s*Requests)\b/i.test(message)) {
    return parseBsaleRetryAfterSeconds(null, message)
  }
  return null
}

function computeConfirmedDeadlineMs(
  expiresAtIso: string,
  serverNowIso: string | undefined,
  fallbackTtlSeconds: number,
): number {
  const expiresMs = Date.parse(expiresAtIso)
  if (!Number.isFinite(expiresMs)) {
    throw new BsaleSyncLeaseLostError(
      'BSALE_SYNC_LEASE_UNVERIFIED',
      `Timestamp expires_at inválido recibido desde PostgreSQL: "${expiresAtIso}"`,
    )
  }
  if (serverNowIso) {
    const serverNowMs = Date.parse(serverNowIso)
    if (Number.isFinite(serverNowMs)) {
      const remainingMs = Math.max(0, expiresMs - serverNowMs)
      return Date.now() + remainingMs
    }
  }
  const fallbackMax = Date.now() + fallbackTtlSeconds * 1000
  return Math.min(expiresMs, fallbackMax)
}

export interface PreAcquiredBsaleLease {
  ownerToken: string
  expiresAt: string
  serverNow?: string
}

export type RunWithBsaleSyncCoordinatorOptions<T> = {
  companyId: string
  operationKind: BsaleSyncOperationKind
  lockName?: BsaleSyncLockName | string
  credentialScope?: string
  resourceKey?: string | null
  runId?: string | null
  requestedBy?: string | null
  triggerType?: string
  priority?: BsaleSyncPriority
  waitPolicy?: BsaleSyncWaitPolicy
  ttlSeconds?: number
  heartbeatIntervalMs?: number
  leaseSafetyMarginMs?: number
  metadata?: Record<string, unknown>
  store?: BsaleSyncCoordinatorStore
  preAcquiredLease?: PreAcquiredBsaleLease
  skipAutoRelease?: boolean
  execute: (lease: BsaleSyncLease) => Promise<T>
}

export async function runWithBsaleSyncCoordinator<T>(
  options: RunWithBsaleSyncCoordinatorOptions<T>,
): Promise<BsaleSyncExecutionResult<T>> {
  const startedAt = Date.now()
  const store = options.store ?? createSupabaseBsaleSyncCoordinatorStore()

  let contract: BsaleSyncRequestContract
  try {
    contract = buildBsaleSyncRequestContract(options)
  } catch (error) {
    const fallbackLock = options.lockName ?? getDefaultLockNameForOperation(options.operationKind)
    const fallbackContract: BsaleSyncRequestContract = {
      companyId: options.companyId,
      operationKind: options.operationKind,
      lockName: fallbackLock,
      credentialScope: 'unresolved',
      resourceKey: options.resourceKey ?? null,
      runId: options.runId ?? null,
      requestedBy: options.requestedBy ?? null,
      triggerType: options.triggerType ?? 'MANUAL',
      priority: options.priority ?? DEFAULT_PRIORITY_BY_OPERATION[options.operationKind],
      priorityWeight: PRIORITY_WEIGHT_BY_OPERATION[options.operationKind] ?? 200,
      dedupeKey: `${options.companyId || 'unknown'}:${options.operationKind}:${options.resourceKey ?? 'ALL'}`,
      waitPolicy: options.waitPolicy ?? 'FAIL_FAST',
      ttlSeconds: Math.max(1, Math.floor(options.ttlSeconds ?? 600)),
      metadata: options.metadata ?? {},
    }
    return {
      status: 'TECHNICAL_ERROR',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error,
      coordinator: {
        lockName: fallbackLock,
        ownerToken: 'none',
        credentialScope: 'unresolved',
        confirmedExpiresAt: null,
        reentrant: false,
        renewedCount: 0,
        durationMs: Date.now() - startedAt,
        requestContract: fallbackContract,
      },
    }
  }

  const activeContexts = getActiveBsaleCoordinatorContexts()
  const scopeContext = options.preAcquiredLease
    ? null
    : findActiveScopeContext(activeContexts, contract.credentialScope)

  if (scopeContext) {
    if (!isReentrantOperationCompatible(scopeContext, options.operationKind, contract.resourceKey)) {
      const blocking: BsaleSyncBlockingInfo = {
        lockName: scopeContext.lockName,
        operationKind: scopeContext.operationKind,
        runId: scopeContext.runId,
        resourceKey: scopeContext.resourceKey,
        expiresAt: null,
      }
      return {
        status: 'LOCK_BUSY',
        ok: false,
        error: `Operación reentrante incompatible (${options.operationKind}) bajo bloqueo activo ${scopeContext.operationKind}.`,
        blocking,
        coordinator: {
          lockName: contract.lockName,
          credentialScope: contract.credentialScope,
          dedupeKey: contract.dedupeKey,
          requestContract: contract,
        },
      }
    }

    const reentrantLease: BsaleSyncLease = {
      companyId: contract.companyId,
      lockName: scopeContext.lockName,
      ownerToken: scopeContext.ownerToken,
      operationKind: options.operationKind,
      credentialScope: contract.credentialScope,
      resourceKey: contract.resourceKey,
      runId: contract.runId ?? scopeContext.runId,
      ttlSeconds: contract.ttlSeconds,
      confirmedExpiresAt: new Date(Date.now() + contract.ttlSeconds * 1000).toISOString(),
      confirmedLeaseUntilMs: Date.now() + contract.ttlSeconds * 1000,
      reentrant: true,
      renewedCount: 0,
      renewalFailureCount: 0,
      lastRenewalError: null,
      released: false,
      lostOwnership: false,
      uncertainValidity: false,
      signal: scopeContext.signal,
      assertActive: scopeContext.assertActive,
    }
    const nextStack: CoordinatorContextEntry[] = [
      ...activeContexts,
      {
        companyId: contract.companyId,
        credentialScope: contract.credentialScope,
        lockName: scopeContext.lockName,
        ownerToken: scopeContext.ownerToken,
        operationKind: options.operationKind,
        resourceKey: contract.resourceKey,
        runId: reentrantLease.runId,
        depth: scopeContext.depth + 1,
        signal: scopeContext.signal,
        assertActive: scopeContext.assertActive,
      },
    ]
    try {
      scopeContext.assertActive()
      const data = await coordinatorContextStorage.run(nextStack, () => options.execute(reentrantLease))
      scopeContext.assertActive()
      return {
        status: 'SUCCESS',
        ok: true,
        data,
        coordinator: {
          lockName: scopeContext.lockName,
          ownerToken: scopeContext.ownerToken,
          credentialScope: contract.credentialScope,
          confirmedExpiresAt: reentrantLease.confirmedExpiresAt,
          reentrant: true,
          renewedCount: 0,
          durationMs: Date.now() - startedAt,
          requestContract: contract,
        },
      }
    } catch (error) {
      return {
        status: 'TECHNICAL_ERROR',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        cause: error,
        coordinator: {
          lockName: scopeContext.lockName,
          ownerToken: scopeContext.ownerToken,
          credentialScope: contract.credentialScope,
          confirmedExpiresAt: null,
          reentrant: true,
          renewedCount: 0,
          durationMs: Date.now() - startedAt,
          requestContract: contract,
        },
      }
    }
  }

  const ownerToken = options.preAcquiredLease?.ownerToken ?? randomUUID()
  const leaseAbortController = new AbortController()
  const ttlMs = contract.ttlSeconds * 1000
  const intervalMs = options.heartbeatIntervalMs
    ?? Math.max(1_000, Math.min(20_000, Math.floor(ttlMs / 3)))
  const safetyMarginMs = options.leaseSafetyMarginMs
    ?? Math.min(5_000, Math.max(25, Math.floor(ttlMs * 0.15)))

  let initialExpiresAt = options.preAcquiredLease?.expiresAt ?? ''
  let initialServerNow = options.preAcquiredLease?.serverNow

  if (!options.preAcquiredLease) {
    let acquiredResult: Awaited<ReturnType<BsaleSyncCoordinatorStore['acquire']>>
    try {
      acquiredResult = await store.acquire({
        companyId: contract.companyId,
        lockName: contract.lockName,
        ownerToken,
        operationKind: contract.operationKind,
        credentialScope: contract.credentialScope,
        resourceKey: contract.resourceKey,
        runId: contract.runId,
        ttlSeconds: contract.ttlSeconds,
        incompatibleLockNames: getIncompatibleLockNames(contract.operationKind),
        metadata: {
          ...contract.metadata,
          priority: contract.priority,
          dedupeKey: contract.dedupeKey,
          triggerType: contract.triggerType,
        },
      })
    } catch (error) {
      return {
        status: 'TECHNICAL_ERROR',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        cause: error,
        coordinator: {
          lockName: contract.lockName,
          ownerToken,
          credentialScope: contract.credentialScope,
          confirmedExpiresAt: null,
          reentrant: false,
          renewedCount: 0,
          durationMs: Date.now() - startedAt,
          requestContract: contract,
        },
      }
    }

    if (!acquiredResult.acquired) {
      return {
        status: 'LOCK_BUSY',
        ok: false,
        error: defaultBusyMessage(contract.operationKind, acquiredResult.blocking),
        blocking: acquiredResult.blocking,
        coordinator: {
          lockName: contract.lockName,
          credentialScope: contract.credentialScope,
          dedupeKey: contract.dedupeKey,
          requestContract: contract,
        },
      }
    }
    initialExpiresAt = acquiredResult.expiresAt
    initialServerNow = acquiredResult.serverNow
  }

  let confirmedDeadlineMs: number
  try {
    confirmedDeadlineMs = computeConfirmedDeadlineMs(initialExpiresAt, initialServerNow, contract.ttlSeconds)
  } catch (error) {
    if (!options.skipAutoRelease) {
      await store.release({
        companyId: contract.companyId,
        lockName: contract.lockName,
        credentialScope: contract.credentialScope,
        ownerToken,
      }).catch(() => {})
    }
    return {
      status: 'TECHNICAL_ERROR',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error,
      coordinator: {
        lockName: contract.lockName,
        ownerToken,
        credentialScope: contract.credentialScope,
        confirmedExpiresAt: null,
        reentrant: false,
        renewedCount: 0,
        durationMs: Date.now() - startedAt,
        requestContract: contract,
      },
    }
  }

  const abortLease = (
    code: 'BSALE_SYNC_LEASE_LOST' | 'BSALE_SYNC_LEASE_UNVERIFIED',
    detail: string,
  ) => {
    if (lease.released) return
    lease.lostOwnership = true
    if (code === 'BSALE_SYNC_LEASE_UNVERIFIED') {
      lease.uncertainValidity = true
    }
    if (!leaseAbortController.signal.aborted) {
      leaseAbortController.abort(new BsaleSyncLeaseLostError(code, detail))
    }
  }

  const lease: BsaleSyncLease = {
    companyId: contract.companyId,
    lockName: contract.lockName,
    ownerToken,
    operationKind: contract.operationKind,
    credentialScope: contract.credentialScope,
    resourceKey: contract.resourceKey,
    runId: contract.runId,
    ttlSeconds: contract.ttlSeconds,
    confirmedExpiresAt: initialExpiresAt,
    confirmedLeaseUntilMs: confirmedDeadlineMs,
    reentrant: false,
    renewedCount: 0,
    renewalFailureCount: 0,
    lastRenewalError: null,
    released: false,
    lostOwnership: false,
    uncertainValidity: false,
    signal: leaseAbortController.signal,
    assertActive: () => {
      if (lease.lostOwnership || leaseAbortController.signal.aborted) {
        const abortReason = leaseAbortController.signal.reason
        if (abortReason instanceof Error) throw abortReason
        throw new BsaleSyncLeaseLostError(
          lease.uncertainValidity ? 'BSALE_SYNC_LEASE_UNVERIFIED' : 'BSALE_SYNC_LEASE_LOST',
          'la ejecución perdió la propiedad o vigencia confirmada del bloqueo y fue detenida.',
        )
      }
      if (Date.now() + safetyMarginMs >= lease.confirmedLeaseUntilMs) {
        abortLease(
          'BSALE_SYNC_LEASE_UNVERIFIED',
          `expiración confirmada (${lease.confirmedExpiresAt}) alcanzada sin renovación confirmada por PostgreSQL.`,
        )
        const abortReason = leaseAbortController.signal.reason
        if (abortReason instanceof Error) throw abortReason
        throw new BsaleSyncLeaseLostError(
          'BSALE_SYNC_LEASE_UNVERIFIED',
          `expiración confirmada (${lease.confirmedExpiresAt}) alcanzada sin renovación confirmada por PostgreSQL.`,
        )
      }
    },
  }

  let expiryWatchdog: ReturnType<typeof setTimeout> | null = null
  const scheduleExpiryWatchdog = () => {
    if (expiryWatchdog) clearTimeout(expiryWatchdog)
    if (lease.released || lease.lostOwnership) return
    const msUntilUnsafe = Math.max(0, lease.confirmedLeaseUntilMs - safetyMarginMs - Date.now())
    expiryWatchdog = setTimeout(() => {
      if (lease.released || lease.lostOwnership) return
      if (Date.now() + safetyMarginMs >= lease.confirmedLeaseUntilMs) {
        abortLease(
          'BSALE_SYNC_LEASE_UNVERIFIED',
          `no se pudo renovar la vigencia del lease antes de su expiración confirmada (${lease.confirmedExpiresAt}).`,
        )
      } else {
        scheduleExpiryWatchdog()
      }
    }, msUntilUnsafe + 2)
    expiryWatchdog.unref?.()
  }
  scheduleExpiryWatchdog()

  let renewing = false
  const heartbeat = setInterval(() => {
    if (renewing || lease.released || lease.lostOwnership) return
    renewing = true
    void store.renew({
      companyId: lease.companyId,
      lockName: lease.lockName,
      credentialScope: lease.credentialScope,
      ownerToken: lease.ownerToken,
      ttlSeconds: lease.ttlSeconds,
    }).then(res => {
      if (res.renewed && res.expiresAt) {
        const nextDeadlineMs = computeConfirmedDeadlineMs(res.expiresAt, res.serverNow, lease.ttlSeconds)
        lease.confirmedExpiresAt = res.expiresAt
        lease.confirmedLeaseUntilMs = nextDeadlineMs
        lease.renewedCount += 1
        lease.renewalFailureCount = 0
        lease.lastRenewalError = null
        scheduleExpiryWatchdog()
        return
      }
      if (res.reason === 'LOCK_LOST_OR_EXPIRED') {
        abortLease('BSALE_SYNC_LEASE_LOST', 'PostgreSQL informó pérdida o expiración del bloqueo.')
        return
      }
      lease.renewalFailureCount += 1
      lease.lastRenewalError = res.reason ?? 'RENEW_UNCONFIRMED'
      if (Date.now() + intervalMs + safetyMarginMs >= lease.confirmedLeaseUntilMs) {
        abortLease(
          'BSALE_SYNC_LEASE_UNVERIFIED',
          `falló la renovación (${lease.lastRenewalError}) y no puede garantizarse la vigencia más allá de ${lease.confirmedExpiresAt}.`,
        )
      }
    }).catch(err => {
      lease.renewalFailureCount += 1
      lease.lastRenewalError = err instanceof Error ? err.message : String(err)
      if (Date.now() + intervalMs + safetyMarginMs >= lease.confirmedLeaseUntilMs) {
        abortLease(
          'BSALE_SYNC_LEASE_UNVERIFIED',
          `fallo de conexión al renovar bloqueo (${lease.lastRenewalError}); vigencia no garantizada tras ${lease.confirmedExpiresAt}.`,
        )
      }
    }).finally(() => {
      renewing = false
    })
  }, intervalMs)
  heartbeat.unref?.()

  const nextStack: CoordinatorContextEntry[] = [
    ...activeContexts,
    {
      companyId: contract.companyId,
      credentialScope: contract.credentialScope,
      lockName: contract.lockName,
      ownerToken,
      operationKind: contract.operationKind,
      resourceKey: contract.resourceKey,
      runId: contract.runId,
      depth: 1,
      signal: lease.signal,
      assertActive: lease.assertActive,
    },
  ]

  try {
    const data = await coordinatorContextStorage.run(nextStack, () => options.execute(lease))
    // Impedir éxito si durante el tramo final se perdió la propiedad o expiró la vigencia confirmada
    lease.assertActive()
    return {
      status: 'SUCCESS',
      ok: true,
      data,
      coordinator: {
        lockName: contract.lockName,
        ownerToken,
        credentialScope: contract.credentialScope,
        confirmedExpiresAt: lease.confirmedExpiresAt,
        reentrant: false,
        renewedCount: lease.renewedCount,
        durationMs: Date.now() - startedAt,
        requestContract: contract,
      },
    }
  } catch (error) {
    // Si una ejecución directa recibe HTTP 429, persistir el cooldown por credenciales en PostgreSQL
    if (!options.preAcquiredLease && store.registerCooldown) {
      const retryAfterSeconds = extractRateLimitRetrySecondsFromError(error)
      if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
        await store.registerCooldown({
          companyId: contract.companyId,
          credentialScope: contract.credentialScope,
          retryAfterSeconds,
          httpStatus: 429,
          reason: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      }
    }

    return {
      status: 'TECHNICAL_ERROR',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error,
      coordinator: {
        lockName: contract.lockName,
        ownerToken,
        credentialScope: contract.credentialScope,
        confirmedExpiresAt: lease.confirmedExpiresAt,
        reentrant: false,
        renewedCount: lease.renewedCount,
        durationMs: Date.now() - startedAt,
        requestContract: contract,
      },
    }
  } finally {
    clearInterval(heartbeat)
    if (expiryWatchdog) clearTimeout(expiryWatchdog)
    if (!lease.released) {
      lease.released = true
      if (!options.skipAutoRelease) {
        await store.release({
          companyId: lease.companyId,
          lockName: lease.lockName,
          credentialScope: lease.credentialScope,
          ownerToken: lease.ownerToken,
        }).catch(() => {})
        notifyLockReleased({
          companyId: lease.companyId,
          credentialScope: lease.credentialScope,
          lockName: lease.lockName,
        })
      }
    }
  }
}
