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
