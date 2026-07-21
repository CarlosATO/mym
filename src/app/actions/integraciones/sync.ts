'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { syncBsaleClients } from '@/lib/integraciones/bsale-clients-sync'
import { syncBsaleProductTypes } from '@/lib/integraciones/bsale-product-types-sync'
import { syncBsaleProducts } from '@/lib/integraciones/bsale-products-sync'
import { getSyncStatus as getStatus } from '@/lib/integraciones/sync-core'
import { createClient } from '@supabase/supabase-js'

export async function forceSyncBsaleClients() {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa no activa')

  const result = await syncBsaleClients({
    companyId,
    triggerType: 'MANUAL',
    isDryRun: false,
    recordDryRun: true
  })

  return result
}

export async function forceSyncBsaleProductTypes() {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa no activa')

  const result = await syncBsaleProductTypes({
    companyId,
    triggerType: 'MANUAL',
    isDryRun: false,
    recordDryRun: true
  })

  return result
}

export async function forceSyncBsaleProducts() {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa no activa')

  const result = await syncBsaleProducts({
    companyId,
    triggerType: 'MANUAL',
    isDryRun: false,
    recordDryRun: true
  })

  return result
}

export async function getSyncStatus(provider: string, entity: string) {
  const companyId = await getActiveCompanyId()
  if (!companyId) return null
  return getStatus(companyId, provider, entity)
}

export async function getRecentSyncRuns(provider: string, entity: string, limit: number = 5) {
  const companyId = await getActiveCompanyId()
  if (!companyId) return []

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data } = await admin.schema('integraciones').from('sync_runs')
    .select('id, status, started_at, finished_at, read_count, inserted_count, updated_count, error_count, message')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .eq('entity', entity)
    .order('started_at', { ascending: false })
    .limit(limit)

  return data || []
}

export type BsaleSalesSyncRunSummary = {
  id: string
  status: string
  trigger: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  documents_count: number | null
  document_details_count: number | null
  stocks_count: number | null
}

export type BsaleSalesSyncHealth = {
  latestRun: BsaleSalesSyncRunSummary | null
  latestSuccessfulRun: BsaleSalesSyncRunSummary | null
  latestScheduledRun: BsaleSalesSyncRunSummary | null
  scheduledRunsCount: number
  manualRunsCount: number
  failedRunsCount: number
  lastSuccessAgeMinutes: number | null
  isFresh: boolean
  hasScheduledEvidence: boolean
}

export async function getBsaleSalesSyncHealth(): Promise<BsaleSalesSyncHealth> {
  const companyId = await getActiveCompanyId()
  if (!companyId) {
    return {
      latestRun: null,
      latestSuccessfulRun: null,
      latestScheduledRun: null,
      scheduledRunsCount: 0,
      manualRunsCount: 0,
      failedRunsCount: 0,
      lastSuccessAgeMinutes: null,
      isFresh: false,
      hasScheduledEvidence: false,
    }
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const salesRuns = admin.schema('integraciones').from('bsale_sync_runs')
  const runColumns = 'id, status, trigger, started_at, completed_at, error_message, documents_count, document_details_count, stocks_count'

  const [latestResult, latestSuccessResult, latestScheduledResult, scheduledCountResult, manualCountResult, failedCountResult] = await Promise.all([
    salesRuns.select(runColumns).eq('company_id', companyId).not('documents_count', 'is', null).order('started_at', { ascending: false }).limit(1).maybeSingle(),
    salesRuns.select(runColumns).eq('company_id', companyId).eq('status', 'COMPLETED').not('documents_count', 'is', null).order('completed_at', { ascending: false }).limit(1).maybeSingle(),
    salesRuns.select(runColumns).eq('company_id', companyId).eq('trigger', 'SCHEDULED').not('documents_count', 'is', null).order('started_at', { ascending: false }).limit(1).maybeSingle(),
    salesRuns.select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('trigger', 'SCHEDULED').not('documents_count', 'is', null),
    salesRuns.select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('trigger', 'MANUAL').not('documents_count', 'is', null),
    salesRuns.select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'FAILED').not('documents_count', 'is', null),
  ])

  const firstError = latestResult.error || latestSuccessResult.error || latestScheduledResult.error || scheduledCountResult.error || manualCountResult.error || failedCountResult.error
  if (firstError) throw new Error(`Error leyendo salud sync Bsale ventas: ${firstError.message}`)

  const latestSuccessfulRun = latestSuccessResult.data as BsaleSalesSyncRunSummary | null
  const lastCompletedAt = latestSuccessfulRun?.completed_at || latestSuccessfulRun?.started_at || null
  const lastSuccessAgeMinutes = lastCompletedAt ? Math.round((Date.now() - new Date(lastCompletedAt).getTime()) / 60000) : null

  return {
    latestRun: latestResult.data as BsaleSalesSyncRunSummary | null,
    latestSuccessfulRun,
    latestScheduledRun: latestScheduledResult.data as BsaleSalesSyncRunSummary | null,
    scheduledRunsCount: scheduledCountResult.count || 0,
    manualRunsCount: manualCountResult.count || 0,
    failedRunsCount: failedCountResult.count || 0,
    lastSuccessAgeMinutes,
    isFresh: lastSuccessAgeMinutes !== null && lastSuccessAgeMinutes <= 180,
    hasScheduledEvidence: (scheduledCountResult.count || 0) > 0,
  }
}
