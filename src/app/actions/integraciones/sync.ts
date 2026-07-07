'use server'

import { getActiveCompanyId } from '@/app/actions/companies'
import { syncBsaleClients } from '@/lib/integraciones/bsale-clients-sync'
import { getSyncStatus as getStatus } from '@/lib/integraciones/sync-core'
import { createClient } from '@supabase/supabase-js'

export async function forceSyncBsaleClients() {
  const companyId = await getActiveCompanyId()
  if (!companyId) throw new Error('Empresa no activa')

  // Ideally validate user roles here. Currently delegating to standard auth.
  // We assume any authenticated user calling this has access since there's no granular permission defined yet.
  
  // No dry-run, record the run
  const result = await syncBsaleClients({
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
