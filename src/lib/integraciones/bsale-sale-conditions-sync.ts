import { createClient } from '@supabase/supabase-js'
import {
  createSyncRun,
  finishSyncRun,
  recordSyncError,
  tryAcquireSyncLock,
  releaseSyncLock,
  SyncTriggerType
} from './sync-core'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface SyncBsaleSaleConditionsOptions {
  companyId: string
  triggerType: SyncTriggerType
  requestedBy?: string
  isDryRun?: boolean
  recordDryRun?: boolean
  limitOverride?: number | null
}

export async function syncBsaleSaleConditions(options: SyncBsaleSaleConditionsOptions) {
  const { companyId, triggerType, requestedBy, isDryRun = false, recordDryRun = false, limitOverride = null } = options
  const provider = 'BSALE'
  const entity = 'sale_conditions'

  const bsaleUrl = process.env.BSALE_API_BASE_URL!
  const bsaleToken = process.env.BSALE_ACCESS_TOKEN!

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
    const allConditions = []

    while (hasMore) {
      const url = `${bsaleUrl}/sale_conditions.json?limit=${limit}&offset=${offset}`
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'access_token': bsaleToken, 'Content-Type': 'application/json' }
      })

      if (!response.ok) {
        if (response.status === 429) { await sleep(2000); continue }
        if (response.status === 404) {
          return { status: 'FAILED', message: 'Bsale API endpoint /sale_conditions.json no encontrado (404). Verificar disponibilidad.', stats }
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

      allConditions.push(...data.items)
      stats.bsaleFetched += data.items.length

      if (limitOverride && allConditions.length >= limitOverride) {
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

    const records = allConditions.map((sc: any) => ({
      company_id: companyId,
      bsale_id: sc.id,
      name: sc.name ? sc.name.trim() : `Condición ${sc.id}`,
      state: sc.state ?? null,
      raw_json: sc,
      synced_at: new Date().toISOString()
    }))

    const chunkSize = 100
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize)
      const { error } = await admin.schema('integraciones').from('bsale_sale_conditions').upsert(chunk, {
        onConflict: 'company_id, bsale_id',
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
