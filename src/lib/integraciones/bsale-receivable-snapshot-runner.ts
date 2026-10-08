import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { getBsaleConfigForCompany, KNOWN_COMPANY_IDS } from '@/lib/bsale/company-config'
import {
  collectPagedRows,
  snapshotReceivablesBatch,
  type SnapshotBatchResult,
} from './bsale-receivable-snapshot'

const COMPANY_ID = KNOWN_COMPANY_IDS.CAYLO
const MAX_BATCH_SIZE = 20
const SNAPSHOT_LOCK_NAME = 'bsale_receivable_snapshot'
const SYNC_LOCK_NAME = 'bsale_replenishment_sync'
const LOCK_TTL_MINUTES = 15
const YEAR = 2026

type SnapshotRunRow = {
  id: string
  status: string
  clients_total: number
  clients_success: number
  clients_unqueryable: number
  clients_error: number
  documents_total: number
  total_amount_owed: number
  coverage_percent: number | null
  completed_at: string | null
}

export type ReceivableSnapshotRunResult = {
  skipped?: 'SNAPSHOT_LOCKED' | 'SYNC_ACTIVE'
  run?: SnapshotRunRow
  result?: SnapshotBatchResult
  universe: {
    year: number
    eligible_documents: number
    candidate_clients: number
  }
  duration_ms: number
}

function integrationDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function loadUniverse(db: ReturnType<typeof integrationDb>) {
  const candidateDocuments = await collectPagedRows(async (offset, pageSize) => {
    const { data, error } = await db.schema('integraciones')
      .from('bsale_documents')
      .select('bsale_id, client_id')
      .eq('company_id', COMPANY_ID)
      .eq('state', 0)
      .gte('emission_date', `${YEAR}-01-01`)
      .lt('emission_date', `${YEAR + 1}-01-01`)
      .not('client_id', 'is', null)
      .order('bsale_id', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    return data || []
  })

  const normalizedDocuments = await collectPagedRows(async (offset, pageSize) => {
    const { data, error } = await db.schema('integraciones')
      .from('vw_bsale_documents_normalized')
      .select('bsale_id, sign_for_sales, include_in_replenishment, business_category')
      .eq('company_id', COMPANY_ID)
      .order('bsale_id', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    return data || []
  })

  const eligibleTypes = new Map(normalizedDocuments.map(row => [Number(row.bsale_id), row]))
  const eligibleDocuments = candidateDocuments.filter(document => {
    const normalized = eligibleTypes.get(Number(document.bsale_id))
    return normalized?.include_in_replenishment === true
      && [1, -1].includes(Number(normalized.sign_for_sales))
      && ['sale', 'reversal'].includes(normalized.business_category)
  })
  const clientIds = [...new Set(eligibleDocuments.map(row => Number(row.client_id)).filter(Number.isFinite))]

  return {
    clientIds,
    summary: {
      year: YEAR,
      eligible_documents: eligibleDocuments.length,
      candidate_clients: clientIds.length,
    },
  }
}

async function acquireLock(db: ReturnType<typeof integrationDb>, lockName: string, runId: string) {
  const now = new Date().toISOString()
  await db.schema('integraciones').from('bsale_sync_locks')
    .delete()
    .eq('company_id', COMPANY_ID)
    .eq('lock_name', lockName)
    .lt('expires_at', now)

  const expiresAt = new Date(Date.now() + LOCK_TTL_MINUTES * 60_000).toISOString()
  const { error } = await db.schema('integraciones').from('bsale_sync_locks').insert({
    company_id: COMPANY_ID,
    lock_name: lockName,
    run_id: runId,
    acquired_at: now,
    expires_at: expiresAt,
  })
  return !error
}

async function refreshLock(db: ReturnType<typeof integrationDb>, lockName: string, runId: string) {
  await db.schema('integraciones').from('bsale_sync_locks').update({
    expires_at: new Date(Date.now() + LOCK_TTL_MINUTES * 60_000).toISOString(),
  }).eq('company_id', COMPANY_ID).eq('lock_name', lockName).eq('run_id', runId)
}

async function releaseLock(db: ReturnType<typeof integrationDb>, lockName: string, runId: string) {
  await db.schema('integraciones').from('bsale_sync_locks').delete()
    .eq('company_id', COMPANY_ID).eq('lock_name', lockName).eq('run_id', runId)
}

async function activeSyncLock(db: ReturnType<typeof integrationDb>) {
  const { data, error } = await db.schema('integraciones').from('bsale_sync_locks')
    .select('run_id, expires_at')
    .eq('company_id', COMPANY_ID)
    .eq('lock_name', SYNC_LOCK_NAME)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (error) throw error
  return data
}

async function latestRunningSnapshot(db: ReturnType<typeof integrationDb>) {
  const { data, error } = await db.schema('integraciones').from('bsale_receivable_snapshot_runs')
    .select('id')
    .eq('company_id', COMPANY_ID)
    .eq('status', 'RUNNING')
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.id ? String(data.id) : undefined
}

async function fetchRun(db: ReturnType<typeof integrationDb>, runId: string) {
  const { data, error } = await db.schema('integraciones').from('bsale_receivable_snapshot_runs')
    .select('id, status, clients_total, clients_success, clients_unqueryable, clients_error, documents_total, total_amount_owed, coverage_percent, completed_at')
    .eq('id', runId)
    .single()
  if (error) throw error
  return data as SnapshotRunRow
}

export async function runReceivablesSnapshot({
  runId,
  batchSize = MAX_BATCH_SIZE,
  forceNew = false,
}: {
  runId?: string
  batchSize?: number
  forceNew?: boolean
} = {}): Promise<ReceivableSnapshotRunResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`batchSize debe estar entre 1 y ${MAX_BATCH_SIZE}.`)
  }

  const startedAt = Date.now()
  const db = integrationDb()
  const universe = await loadUniverse(db)
  if (universe.clientIds.length === 0) throw new Error('El universo CxC no contiene clientes candidatos.')

  const syncLock = await activeSyncLock(db)
  if (syncLock) {
    return { skipped: 'SYNC_ACTIVE', universe: universe.summary, duration_ms: Date.now() - startedAt }
  }

  const activeRunId = await latestRunningSnapshot(db)
  if (runId && activeRunId && runId !== activeRunId) {
    return { skipped: 'SNAPSHOT_LOCKED', universe: universe.summary, duration_ms: Date.now() - startedAt }
  }
  if (forceNew && activeRunId) {
    return { skipped: 'SNAPSHOT_LOCKED', universe: universe.summary, duration_ms: Date.now() - startedAt }
  }
  let currentRunId = runId || (!forceNew ? activeRunId : undefined)
  const lockRunId = currentRunId || crypto.randomUUID()
  if (!await acquireLock(db, SNAPSHOT_LOCK_NAME, lockRunId)) {
    return { skipped: 'SNAPSHOT_LOCKED', universe: universe.summary, duration_ms: Date.now() - startedAt }
  }

  try {
    let batchResult: SnapshotBatchResult | undefined
    do {
      batchResult = await snapshotReceivablesBatch({
        db,
        companyId: COMPANY_ID,
        clientIds: universe.clientIds,
        runId: currentRunId,
        limit: batchSize,
        fetchJson: async path => {
          const { baseUrl, accessToken } = getBsaleConfigForCompany(COMPANY_ID)
          const response = await fetch(`${baseUrl}${path}`, {
            headers: { access_token: accessToken, Accept: 'application/json' },
            signal: AbortSignal.timeout(30_000),
          })
          const body = await response.text()
          if (!response.ok) throw new Error(`Bsale HTTP ${response.status}: ${body.slice(0, 300)}`)
          return JSON.parse(body)
        },
      })
      currentRunId = batchResult.runId
      await refreshLock(db, SNAPSHOT_LOCK_NAME, lockRunId)
    } while (batchResult.status === 'RUNNING' && batchResult.remainingClientIds.length > 0)

    return {
      run: await fetchRun(db, batchResult.runId),
      result: batchResult,
      universe: universe.summary,
      duration_ms: Date.now() - startedAt,
    }
  } finally {
    await releaseLock(db, SNAPSHOT_LOCK_NAME, lockRunId)
  }
}
