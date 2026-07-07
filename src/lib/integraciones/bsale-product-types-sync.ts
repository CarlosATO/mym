import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import {
  createSyncRun,
  finishSyncRun,
  recordSyncError,
  tryAcquireSyncLock,
  releaseSyncLock,
  SyncTriggerType
} from './sync-core'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function computeHash(payload: any): string {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex')
}

export interface SyncBsaleProductTypesOptions {
  companyId: string
  triggerType: SyncTriggerType
  requestedBy?: string
  isDryRun?: boolean
  recordDryRun?: boolean
  limitOverride?: number | null
}

export async function syncBsaleProductTypes(options: SyncBsaleProductTypesOptions) {
  const { companyId, triggerType, requestedBy, isDryRun = false, recordDryRun = false, limitOverride = null } = options
  const provider = 'BSALE'
  const entity = 'product_types'
  
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
    errorCount: 0,
    pseudoNew: 0,
    pseudoUpdated: 0,
    pseudoPreservedParent: 0,
    pseudoWithoutParent: 0
  }

  try {
    let offset = 0
    const limit = 50
    let hasMore = true
    let totalCount = -1
    const allTypes = []

    while (hasMore) {
      const url = `${bsaleUrl}/product_types.json?limit=${limit}&offset=${offset}`
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'access_token': bsaleToken, 'Content-Type': 'application/json' }
      })

      if (!response.ok) {
        if (response.status === 429) { await sleep(2000); continue }
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

      allTypes.push(...data.items)
      stats.bsaleFetched += data.items.length

      if (limitOverride && allTypes.length >= limitOverride) {
        hasMore = false
        break
      }

      offset += limit
      if (offset > totalCount + limit) hasMore = false
    }

    const integracionesRecords = []

    for (const pt of allTypes) {
      const bsaleId = pt.id
      const name = pt.name ? pt.name.trim() : `Tipo ${bsaleId}`
      const hash = computeHash(pt)

      integracionesRecords.push({
        company_id: companyId,
        bsale_id: bsaleId,
        name: name,
        state: pt.state,
        raw_json: pt,
        synced_at: new Date().toISOString()
      })
    }

    const { data: existingIntegraciones, error: intErr } = await admin.schema('integraciones').from('bsale_product_types')
      .select('id, bsale_id')
      .eq('company_id', companyId)
    if (intErr) throw intErr

    const bsaleIdToUuidMap = new Map((existingIntegraciones || []).map(e => [e.bsale_id, e.id]))

    const { data: existingSuppliers, error: fetchErr } = await admin.schema('adquisiciones').from('suppliers')
      .select('id, bsale_product_type_id, parent_supplier_id')
      .eq('company_id', companyId)
      .eq('supplier_kind', 'BSALE_OPERATIVE')
    if (fetchErr) throw fetchErr

    // Resolve bsale_id for each existing supplier to allow robust matching even if UUIDs point to another company's mirror
    const supplierIds = (existingSuppliers || []).map(s => s.bsale_product_type_id).filter(Boolean)
    const { data: supplierInts, error: supIntErr } = await admin.schema('integraciones').from('bsale_product_types')
      .select('id, bsale_id')
      .in('id', supplierIds)
    if (supIntErr) throw supIntErr

    const uuidToBsaleIdMap = new Map((supplierInts || []).map(e => [e.id, e.bsale_id]))
    const existingSupplierByBsaleId = new Map()
    for (const sup of (existingSuppliers || [])) {
      const bsaleId = uuidToBsaleIdMap.get(sup.bsale_product_type_id)
      if (bsaleId !== undefined) {
        existingSupplierByBsaleId.set(bsaleId, sup)
      }
    }
    
    for (const pt of allTypes) {
      const bsaleId = pt.id
      const extSupplier = existingSupplierByBsaleId.get(bsaleId)

      if (extSupplier) {
        stats.pseudoUpdated++
        if (extSupplier.parent_supplier_id) stats.pseudoPreservedParent++
        else stats.pseudoWithoutParent++
      } else {
        stats.pseudoNew++
        stats.pseudoWithoutParent++
      }
    }

    if (isDryRun) {
      if (runId) await finishSyncRun({ runId, status: 'SUCCESS', message: 'Dry-run completado', readCount: stats.bsaleFetched })
      return { status: 'SUCCESS', stats, isDryRun: true }
    }

    const chunkSize = 100
    for (let i = 0; i < integracionesRecords.length; i += chunkSize) {
      const chunk = integracionesRecords.slice(i, i + chunkSize)
      const { error, data: insertedInts } = await admin.schema('integraciones').from('bsale_product_types').upsert(chunk, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false
      }).select('id, bsale_id')

      if (error) {
        stats.errorCount++
        if (runId) await recordSyncError({ runId, companyId, provider, entity, errorMessage: error.message })
        throw error
      }
      
      for (const row of insertedInts || []) {
        bsaleIdToUuidMap.set(row.bsale_id, row.id)
      }
    }

    const suppliersRecordsFixed = allTypes.map(pt => {
      const bsaleId = pt.id
      const name = pt.name ? pt.name.trim() : `Tipo ${bsaleId}`
      const uuid = bsaleIdToUuidMap.get(bsaleId)
      return {
        _temp_bsale_id: bsaleId,
        company_id: companyId,
        bsale_product_type_id: uuid,
        bsale_product_type_name: name,
        business_name: name,
        supplier_kind: 'BSALE_OPERATIVE',
        source: 'BSALE',
        is_active: pt.state === 0
      }
    })

    for (let i = 0; i < suppliersRecordsFixed.length; i += chunkSize) {
      const chunk = suppliersRecordsFixed.slice(i, i + chunkSize)
      const toInsert = []
      const toUpdate = []

      for (const record of chunk) {
        const bsaleId = record._temp_bsale_id
        delete (record as any)._temp_bsale_id
        
        const ext = existingSupplierByBsaleId.get(bsaleId)
        if (ext) {
          toUpdate.push({
            id: ext.id,
            bsale_product_type_id: record.bsale_product_type_id,
            bsale_product_type_name: record.bsale_product_type_name,
            business_name: record.business_name,
            is_active: record.is_active,
          })
        } else {
          toInsert.push(record)
        }
      }

      if (toInsert.length > 0) {
        const { error: insErr } = await admin.schema('adquisiciones').from('suppliers').insert(toInsert)
        if (insErr) throw insErr
        stats.insertedCount += toInsert.length
      }
      
      if (toUpdate.length > 0) {
        const { error: updErr } = await admin.schema('adquisiciones').from('suppliers').upsert(toUpdate, {
          onConflict: 'id',
          ignoreDuplicates: false
        })
        if (updErr) throw updErr
        stats.updatedCount += toUpdate.length
      }
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
