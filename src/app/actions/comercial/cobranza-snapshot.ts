'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import crypto from 'node:crypto'
import { MANUAL_DISPATCH_LOCK_NAME, MANUAL_DISPATCH_LOCK_TTL_MINUTES } from '@/lib/integraciones/bsale-receivable-snapshot-runner'
import { classifyReceivablesSnapshotExecution, type ReceivablesSnapshotExecution } from '@/lib/integraciones/receivables-snapshot-execution-state'

const WORKFLOW_FILE = 'bsale-replenishment-sync.yml'
const DEFAULT_REPOSITORY = 'CarlosATO/mym'
const SNAPSHOT_WORKER_LOCK_NAME = 'bsale_receivable_snapshot'
const SYNC_LOCK_NAME = 'bsale_replenishment_sync'

export type ReceivablesSnapshotStatus = {
  lastCompletedAt: string | null
  activeRunId: string | null
  executionState: ReceivablesSnapshotExecution
  canResume: boolean
  lastProgressAt: string | null
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | null
  clientsTotal: number
  clientsProcessed: number
  clientsSuccess: number
  clientsUnqueryable: number
  clientsError: number
  rateLimited: boolean
  retryAfterSeconds: number | null
  updatedAt: string | null
}

async function companyContext() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  return companyId
}

function emptyStatus(): ReceivablesSnapshotStatus {
  return {
    lastCompletedAt: null,
    activeRunId: null,
    executionState: 'IDLE',
    canResume: false,
    lastProgressAt: null,
    status: null,
    clientsTotal: 0,
    clientsProcessed: 0,
    clientsSuccess: 0,
    clientsUnqueryable: 0,
    clientsError: 0,
    rateLimited: false,
    retryAfterSeconds: null,
    updatedAt: null,
  }
}

export async function getReceivablesSnapshotStatus(): Promise<ReceivablesSnapshotStatus> {
  const companyId = await companyContext()
  const runs = createAdminClient().schema('integraciones').from('bsale_receivable_snapshot_runs')
  const [activeResult, completedResult, latestResult] = await Promise.all([
    runs.select('id,status,clients_total,clients_success,clients_unqueryable,clients_error,error_summary,snapshot_at,completed_at')
      .eq('company_id', companyId).eq('status', 'RUNNING').order('snapshot_at', { ascending: false }).limit(1).maybeSingle(),
    runs.select('snapshot_at,completed_at').eq('company_id', companyId).eq('status', 'COMPLETED')
      .order('snapshot_at', { ascending: false }).limit(1).maybeSingle(),
    runs.select('id,status,clients_total,clients_success,clients_unqueryable,clients_error,error_summary,snapshot_at,completed_at')
      .eq('company_id', companyId).order('snapshot_at', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (activeResult.error || completedResult.error || latestResult.error) {
    throw new Error((activeResult.error || completedResult.error || latestResult.error)?.message ?? 'No se pudo consultar el estado de Cobranzas.')
  }

  const active = activeResult.data
  const latest = latestResult.data
  const source = active ?? latest
  if (!source) return emptyStatus()
  const errorSummary = source.error_summary && typeof source.error_summary === 'object'
    ? source.error_summary as Record<string, unknown>
    : null
  const isRateLimited = Boolean(active && errorSummary?.code === 'TRANSIENT_GLOBAL_RATE_LIMIT')
  let lastProgressAt: string | null = null
  let hasLiveLock = false
  if (active?.id) {
    const admin = createAdminClient().schema('integraciones')
    const [progressResult, lockResult] = await Promise.all([
      admin.from('bsale_receivable_snapshot_clients')
        .select('processed_at')
        .eq('run_id', active.id)
        .order('processed_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin.from('bsale_sync_locks')
        .select('lock_name')
        .eq('company_id', companyId)
        .in('lock_name', [SNAPSHOT_WORKER_LOCK_NAME, MANUAL_DISPATCH_LOCK_NAME, SYNC_LOCK_NAME])
        .gt('expires_at', new Date().toISOString()),
    ])
    if (progressResult.error || lockResult.error) {
      throw new Error((progressResult.error || lockResult.error)?.message ?? 'No se pudo comprobar la actividad de Cobranzas.')
    }
    lastProgressAt = progressResult.data?.processed_at ?? null
    hasLiveLock = Boolean(lockResult.data?.length)
  }
  const executionState = classifyReceivablesSnapshotExecution({
    runStatus: active?.status ?? null,
    snapshotAt: active?.snapshot_at ?? null,
    lastProgressAt,
    lastRateLimitAt: isRateLimited && typeof errorSummary?.recorded_at === 'string'
      ? errorSummary.recorded_at : null,
    hasLiveLock,
    rateLimited: isRateLimited,
  })
  const clientsProcessed = Number(source.clients_success || 0)
    + Number(source.clients_unqueryable || 0)
    + Number(source.clients_error || 0)
  const retryAfter = errorSummary?.retry_after_seconds == null
    ? null : Number(errorSummary.retry_after_seconds)
  return {
    lastCompletedAt: completedResult.data?.completed_at || completedResult.data?.snapshot_at || null,
    activeRunId: active?.id ? String(active.id) : null,
    executionState,
    canResume: executionState === 'INTERRUPTED' || executionState === 'PAUSED',
    lastProgressAt,
    status: source.status as ReceivablesSnapshotStatus['status'],
    clientsTotal: Number(source.clients_total || 0),
    clientsProcessed,
    clientsSuccess: Number(source.clients_success || 0),
    clientsUnqueryable: Number(source.clients_unqueryable || 0),
    clientsError: Number(source.clients_error || 0),
    rateLimited: isRateLimited,
    retryAfterSeconds: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
    updatedAt: lastProgressAt || source.completed_at || source.snapshot_at || null,
  }
}

export async function requestReceivablesSnapshot(): Promise<{ accepted: boolean; status: ReceivablesSnapshotStatus }> {
  await companyContext()
  const status = await getReceivablesSnapshotStatus()
  if (status.activeRunId && !status.canResume) return { accepted: false, status }

  const companyId = await companyContext()
  const admin = createAdminClient().schema('integraciones')
  const now = new Date().toISOString()
  await admin.from('bsale_sync_locks').delete()
    .eq('company_id', companyId).eq('lock_name', MANUAL_DISPATCH_LOCK_NAME).lt('expires_at', now)
  const claimId = crypto.randomUUID()
  const { error: claimError } = await admin.from('bsale_sync_locks').insert({
    company_id: companyId,
    lock_name: MANUAL_DISPATCH_LOCK_NAME,
    run_id: claimId,
    acquired_at: now,
    expires_at: new Date(Date.now() + MANUAL_DISPATCH_LOCK_TTL_MINUTES * 60_000).toISOString(),
    metadata: { source: 'COBRANZA_MANUAL_DISPATCH' },
  })
  if (claimError) {
    if (claimError.code === '23505') {
      return { accepted: false, status }
    }
    throw new Error(`No se pudo reservar la actualización de Cobranzas: ${claimError.message}`)
  }

  const token = process.env.GITHUB_ACTIONS_TOKEN
  if (!token) {
    await admin.from('bsale_sync_locks').delete().eq('company_id', companyId).eq('lock_name', MANUAL_DISPATCH_LOCK_NAME).eq('run_id', claimId)
    throw new Error('La ejecución manual de Cobranzas no está configurada en el servidor.')
  }
  const repository = process.env.GITHUB_ACTIONS_REPOSITORY || DEFAULT_REPOSITORY
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'mym-cobranza-snapshot',
      },
      body: JSON.stringify({ ref: 'main', inputs: { snapshot_only: 'true', manual_claim_id: claimId } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`No se pudo iniciar la actualización de Cobranzas (HTTP ${response.status}).`)
  } catch (error) {
    await admin.from('bsale_sync_locks').delete().eq('company_id', companyId).eq('lock_name', MANUAL_DISPATCH_LOCK_NAME).eq('run_id', claimId)
    throw error
  }
  return { accepted: true, status: { ...status, executionState: 'ACTIVE', canResume: false } }
}
