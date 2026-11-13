import { createClient } from '@supabase/supabase-js'

// Usa Service Role para operaciones internas de sync
function getSyncAdminClient(timeoutMs?: number) {
  const boundedFetch: typeof fetch = (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs!)
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  }
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false }, ...(timeoutMs ? { global: { fetch: boundedFetch } } : {}) }
  )
}

export type SyncTriggerType = 'MANUAL' | 'SCHEDULED' | 'CLI' | 'API'
export type SyncStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED'

export interface CreateSyncRunParams {
  companyId: string
  provider: string
  entity: string
  triggerType: SyncTriggerType
  requestedBy?: string
  metadata?: any
  timeoutMs?: number
}

export async function createSyncRun(params: CreateSyncRunParams) {
  const admin = getSyncAdminClient(params.timeoutMs)
  const { data, error } = await admin.schema('integraciones').from('sync_runs').insert({
    company_id: params.companyId,
    provider: params.provider,
    entity: params.entity,
    trigger_type: params.triggerType,
    status: 'RUNNING',
    metadata: params.metadata || {},
    requested_by: params.requestedBy || null
  }).select('id').single()

  if (error) throw new Error(`Error createSyncRun: ${error.message}`)
  return data.id as string
}

export interface FinishSyncRunParams {
  runId: string
  status: SyncStatus
  readCount?: number
  insertedCount?: number
  updatedCount?: number
  skippedCount?: number
  errorCount?: number
  message?: string
  metadata?: any
  strict?: boolean
}

export async function finishSyncRun(params: FinishSyncRunParams) {
  const admin = getSyncAdminClient(params.strict ? 30_000 : undefined)
  
  // Calculate duration
  const { data: runData, error: readError } = await admin.schema('integraciones').from('sync_runs')
    .select('started_at, metadata').eq('id', params.runId).single()
  if (params.strict && (readError || !runData)) throw new Error(`Error finishSyncRun read: ${readError?.message ?? 'run not found'}`)
    
  let durationMs = null
  if (runData?.started_at) {
    durationMs = new Date().getTime() - new Date(runData.started_at).getTime()
  }

  const mergedMetadata = runData ? { ...runData.metadata, ...params.metadata } : (params.metadata || {})

  const update = admin.schema('integraciones').from('sync_runs').update({
    status: params.status,
    finished_at: new Date().toISOString(),
    duration_ms: durationMs,
    read_count: params.readCount ?? 0,
    inserted_count: params.insertedCount ?? 0,
    updated_count: params.updatedCount ?? 0,
    skipped_count: params.skippedCount ?? 0,
    error_count: params.errorCount ?? 0,
    message: params.message || null,
    metadata: mergedMetadata
  }).eq('id', params.runId)

  if (params.strict) {
    const { data, error } = await update.select('id').maybeSingle()
    if (error || !data) throw new Error(`Error finishSyncRun update: ${error?.message ?? 'run not found'}`)
    return
  }
  const { error } = await update

  if (error) console.error(`Error finishSyncRun: ${error.message}`)
}

export interface RecordSyncErrorParams {
  runId: string
  companyId: string
  provider: string
  entity: string
  externalId?: string
  errorCode?: string
  errorMessage: string
  safePayload?: any
  timeoutMs?: number
}

export async function recordSyncError(params: RecordSyncErrorParams) {
  const admin = getSyncAdminClient(params.timeoutMs)
  const { error } = await admin.schema('integraciones').from('sync_errors').insert({
    sync_run_id: params.runId,
    company_id: params.companyId,
    provider: params.provider,
    entity: params.entity,
    external_id: params.externalId || null,
    error_code: params.errorCode || null,
    error_message: params.errorMessage,
    safe_payload: params.safePayload || null
  })
  if (params.timeoutMs && error) throw new Error(`Error recordSyncError: ${error.message}`)
}

export interface TryAcquireSyncLockParams {
  companyId: string
  provider: string
  entity: string
  ttlMinutes: number
  lockedBy?: string
  syncRunId?: string
  timeoutMs?: number
}

export async function tryAcquireSyncLock(params: TryAcquireSyncLockParams): Promise<boolean> {
  const admin = getSyncAdminClient(params.timeoutMs)
  
  // Limpiar locks expirados antes de intentar adquirir
  const { error: cleanupError } = await admin.schema('integraciones').from('sync_locks')
    .delete()
    .eq('company_id', params.companyId)
    .eq('provider', params.provider)
    .eq('entity', params.entity)
    .lt('expires_at', new Date().toISOString())
  if (params.syncRunId && cleanupError) throw new Error(`Error cleaning expired lock: ${cleanupError.message}`)

  const expiresAt = new Date(Date.now() + params.ttlMinutes * 60000).toISOString()

  const { error } = await admin.schema('integraciones').from('sync_locks').insert({
    company_id: params.companyId,
    provider: params.provider,
    entity: params.entity,
    locked_by: params.lockedBy || null,
    sync_run_id: params.syncRunId || null,
    expires_at: expiresAt
  })

  // Si hay error de llave única (uq_sync_locks), significa que alguien más tiene el lock
  if (error) {
    if (error.code === '23505') return false // unique violation
    throw new Error(`Error acquiring lock: ${error.message}`)
  }

  return true
}

export async function releaseSyncLock(companyId: string, provider: string, entity: string, syncRunId?: string) {
  const admin = getSyncAdminClient(syncRunId ? 30_000 : undefined)
  const query = admin.schema('integraciones').from('sync_locks')
    .delete()
    .eq('company_id', companyId)
    .eq('provider', provider)
    .eq('entity', entity)
  if (syncRunId) {
    const { data, error } = await query.eq('sync_run_id', syncRunId).select('id').maybeSingle()
    if (error || !data) throw new Error(`Error releasing sync lock: ${error?.message ?? 'lock ownership lost'}`)
    return
  }
  await query
}

export async function getSyncStatus(companyId: string, provider: string, entity: string) {
  const admin = getSyncAdminClient()
  const now = new Date()
  
  // Limpiar locks expirados
  await admin.schema('integraciones').from('sync_locks')
    .delete()
    .eq('company_id', companyId)
    .eq('provider', provider)
    .eq('entity', entity)
    .lt('expires_at', new Date().toISOString())

  const { data: lock } = await admin.schema('integraciones').from('sync_locks')
    .select('*').eq('company_id', companyId).eq('provider', provider).eq('entity', entity).gt('expires_at', now.toISOString()).maybeSingle()
    
  const { data: lastRun } = await admin.schema('integraciones').from('sync_runs')
    .select('*').eq('company_id', companyId).eq('provider', provider).eq('entity', entity).order('started_at', { ascending: false }).limit(1).maybeSingle()
    
  const { data: lastSuccess } = await admin.schema('integraciones').from('sync_runs')
    .select('*').eq('company_id', companyId).eq('provider', provider).eq('entity', entity).eq('status', 'SUCCESS').order('finished_at', { ascending: false }).limit(1).maybeSingle()

  const { data: config } = await admin.schema('integraciones').from('sync_job_configs')
    .select('*').eq('company_id', companyId).eq('provider', provider).eq('entity', entity).maybeSingle()

  const runningStartedAt = lastRun?.status === 'RUNNING' && lastRun?.started_at ? new Date(lastRun.started_at).getTime() : null
  const isRecentRunning = runningStartedAt !== null && now.getTime() - runningStartedAt <= 15 * 60 * 1000

  return {
    isLocked: !!lock,
    isRunning: !!lock || isRecentRunning,
    runningReason: lock ? 'active_lock' : isRecentRunning ? 'recent_running_run' : null,
    lockDetails: lock || null,
    lastRun: lastRun || null,
    lastSuccess: lastSuccess || null,
    config: config || null
  }
}
