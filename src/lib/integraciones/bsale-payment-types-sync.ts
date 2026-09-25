import { createClient } from '@supabase/supabase-js'
import {
  createSyncRun,
  finishSyncRun,
  recordSyncError,
  tryAcquireSyncLock,
  releaseSyncLock,
  SyncTriggerType
} from './sync-core'
import { getBsaleConfigForCompany } from '@/lib/bsale/company-config'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface SyncBsalePaymentTypesOptions {
  companyId: string
  triggerType: SyncTriggerType
  requestedBy?: string
  isDryRun?: boolean
  recordDryRun?: boolean
  limitOverride?: number | null
}

export async function syncBsalePaymentTypes(options: SyncBsalePaymentTypesOptions) {
  const { companyId, triggerType, requestedBy, isDryRun = false, recordDryRun = false, limitOverride = null } = options
  const provider = 'BSALE'
  const entity = 'payment_types'

  const { baseUrl: bsaleUrl, accessToken: bsaleToken } = getBsaleConfigForCompany(companyId)

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const shouldCreateRun = !isDryRun || recordDryRun

  if (shouldCreateRun) {
    const locked = await tryAcquireSyncLock({
      companyId, provider, entity, ttlMinutes: 60, lockedBy: triggerType
    })
    if (!locked) {
      if (shouldCreateRun) {
        const runId = await createSyncRun({ companyId, provider, entity, triggerType, requestedBy })
        await finishSyncRun({ runId, status: 'SKIPPED', message: 'Sync ya se encuentra en ejecución (Lock activo).' })
      }
      return { status: 'SKIPPED', message: 'Sync already running' }
    }
  }

  let runId: string | null = null
  if (shouldCreateRun) {
    runId = await createSyncRun({ companyId, provider, entity, triggerType, requestedBy })
    await admin.schema('integraciones').from('sync_locks').update({ sync_run_id: runId }).eq('company_id', companyId).eq('provider', provider).eq('entity', entity)
  }

  const stats = {
    bsaleTotal: 0,
    bsaleFetched: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0
  }

  try {
    let offset = 0
    const limit = 50
    let hasMore = true
    let totalCount = -1
    const allPaymentTypes: any[] = []

    while (hasMore) {
      const url = `${bsaleUrl}/payment_types.json?limit=${limit}&offset=${offset}`
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'access_token': bsaleToken, 'Content-Type': 'application/json' }
      })

      if (!response.ok) {
        if (response.status === 429) { await sleep(2000); continue }
        if (response.status === 404) {
          return { status: 'FAILED', message: 'Bsale API endpoint /payment_types.json no encontrado (404).', stats }
        }
        throw new Error(`Bsale API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      if (totalCount === -1) {
        totalCount = data.count
        stats.bsaleTotal = totalCount
      }

      if (!data.items || data.items.length === 0) {
        hasMore = false
        break
      }

      allPaymentTypes.push(...data.items)
      stats.bsaleFetched += data.items.length

      if (limitOverride && allPaymentTypes.length >= limitOverride) {
        hasMore = false
        break
      }

      offset += limit
      if (offset > totalCount + limit) hasMore = false
    }

    if (isDryRun) {
      if (runId) await finishSyncRun({ runId, status: 'SUCCESS', message: 'Dry-run completado', readCount: stats.bsaleFetched })
      return { status: 'SUCCESS', stats, isDryRun: true }
    }

    const now = new Date().toISOString()
    const records = allPaymentTypes.map((pt: any) => {
      const bsaleId = Number(pt.id)
      return {
        company_id: companyId,
        bsale_id: bsaleId,
        bsale_payment_type_id: bsaleId,
        name: pt.name ? pt.name.trim() : `Forma de pago ${bsaleId}`,
        is_active: pt.state === 0,
        raw_json: pt,
        synced_at: now,
        updated_at: now
      }
    })

    const chunkSize = 100
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize)
      const { error } = await admin.schema('integraciones').from('bsale_payment_types').upsert(chunk, {
        onConflict: 'company_id, bsale_payment_type_id',
        ignoreDuplicates: false
      })
      if (error) {
        stats.errorCount++
        if (runId) await recordSyncError({ runId, companyId, provider, entity, errorMessage: error.message })
        throw error
      }
      stats.insertedCount += chunk.length
    }

    if (runId) {
      await finishSyncRun({
        runId, status: 'SUCCESS', readCount: stats.bsaleFetched,
        insertedCount: stats.insertedCount, updatedCount: stats.updatedCount, errorCount: stats.errorCount
      })
    }

    return { status: 'SUCCESS', stats }

  } catch (error: any) {
    if (runId) {
      await recordSyncError({ runId, companyId, provider, entity, errorMessage: error.message })
      await finishSyncRun({ runId, status: 'FAILED', message: error.message, errorCount: stats.errorCount + 1 })
    }
    return { status: 'FAILED', message: error.message, stats }
  } finally {
    if (shouldCreateRun) await releaseSyncLock(companyId, provider, entity)
  }
}
