
export interface BsaleSyncStats {
  bsaleTotal: number
  bsaleFetched: number
  insertedCount: number
  updatedCount: number
  skippedCount: number
  errorCount: number
  newProducts: number
  updatedProducts: number
  unchangedCount: number
  conflictCount: number
  cycleCount: number
  reassignmentCount: number
  brandRecordsDetected: number
  productsWithBrand: number
  productsWithoutBrand: number
  withVariantId: number
  withBarcode: number
  withProductType: number
  newMappings: number
  withoutMapping: number
  durationMs: number
}
import { createClient } from '@supabase/supabase-js'
import { planUniqueSafeProductUpdates } from './bsale-planner'
import { collectBsaleBrandRecords, extractBsaleBrand } from './bsale-brand'
import { executeSequentialBatches } from './bsale-update-batches'
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

export interface SyncBsaleProductsOptions {
  companyId: string
  triggerType: SyncTriggerType
  requestedBy?: string
  isDryRun?: boolean
  recordDryRun?: boolean
  limitOverride?: number | null
}

export async function syncBsaleProducts(options: SyncBsaleProductsOptions) {
  const { companyId, triggerType, requestedBy, isDryRun = false, recordDryRun = false, limitOverride = null } = options
  const provider = 'BSALE'
  const entity = 'products'
  
  const bsaleUrl = process.env.BSALE_API_BASE_URL!
  const bsaleToken = process.env.BSALE_ACCESS_TOKEN!

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const shouldCreateRun = !isDryRun || recordDryRun
  
  if (shouldCreateRun) {
    const locked = await tryAcquireSyncLock({ companyId, provider, entity, ttlMinutes: 60, lockedBy: triggerType })
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

  const stats: BsaleSyncStats = {
    bsaleTotal: 0,
    bsaleFetched: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    newProducts: 0,
    updatedProducts: 0,
    unchangedCount: 0,
    conflictCount: 0,
    cycleCount: 0,
    reassignmentCount: 0,
    brandRecordsDetected: 0,
    productsWithBrand: 0,
    productsWithoutBrand: 0,
    withVariantId: 0,
    withBarcode: 0,
    withProductType: 0,
    newMappings: 0,
    withoutMapping: 0,
    durationMs: 0
  }

  try {
    let offset = 0
    const limit = 50
    let hasMore = true
    let totalCount = -1
    const allVariants = []

    while (hasMore) {
      const url = `${bsaleUrl}/variants.json?expand=product,product_type&limit=${limit}&offset=${offset}`
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

      allVariants.push(...data.items)
      stats.bsaleFetched += data.items.length

      if (limitOverride && allVariants.length >= limitOverride) {
        hasMore = false
        break
      }

      offset += limit
      if (offset > totalCount + limit) hasMore = false
    }

    const integracionesRecords = []
    const productsRecords = []
    const observedAt = new Date().toISOString()
    const brandRecords = collectBsaleBrandRecords(allVariants, companyId, observedAt)
    stats.brandRecordsDetected = brandRecords.length

    for (const v of allVariants) {
      const bsaleVariantId = v.id
      const bsaleProductId = v.product?.id
      const sku = v.code
      let barcode = String(v.barCode || '').trim()
      if (barcode === '0' || barcode === 'null' || barcode === 'undefined') barcode = ''

      const bsaleProductState = v.product?.state ?? 0
      const bsaleVariantState = v.state ?? 0
      const bsaleTypeId = v.product?.product_type?.id
      const bsaleTypeName = v.product?.product_type?.name
      const bsaleBrand = extractBsaleBrand(v.product)

      if (bsaleBrand.id === null) stats.productsWithoutBrand++
      else stats.productsWithBrand++

      let description = v.product?.name || ''
      if (v.description && v.description.trim() !== '') {
        description += ' ' + v.description.trim()
      }

      if (sku) stats.withVariantId++
      if (barcode) stats.withBarcode++
      if (bsaleTypeId) stats.withProductType++

      integracionesRecords.push({
        company_id: companyId,
        bsale_id: bsaleVariantId,
        bsale_product_id: bsaleProductId,
        code: sku,
        description: description,
        bar_code: barcode,
        state: bsaleVariantState,
        raw_json: v,
        synced_at: new Date().toISOString()
      })

      productsRecords.push({
        company_id: companyId,
        source: 'BSALE',
        sku: sku,
        barcode: barcode || null,
        description: description,
        bsale_product_id: bsaleProductId,
        bsale_variant_id: bsaleVariantId,
        bsale_product_state: bsaleProductState,
        bsale_variant_state: bsaleVariantState,
        bsale_product_type_id: bsaleTypeId ? String(bsaleTypeId) : null,
        bsale_product_type_name: bsaleTypeName || null,
        product_type: bsaleTypeName || null,
        bsale_brand_id: bsaleBrand.id,
        bsale_brand_href: bsaleBrand.href,
        is_active: bsaleProductState === 0 && bsaleVariantState === 0,
        last_bsale_sync_at: observedAt
      })
    }

    // Evaluate against existing
    const existingProducts: any[] = []
    let pOffset = 0
    while (true) {
      const { data: page, error: fetchErr } = await admin.schema('adquisiciones').from('products')
        .select('id, sku, bsale_variant_id, description, barcode, bsale_product_state, bsale_variant_state, bsale_product_type_id, bsale_product_type_name, product_type, bsale_brand_id, bsale_brand_href, is_active')
        .eq('company_id', companyId)
        .range(pOffset, pOffset + 999)
        
      if (fetchErr) throw fetchErr
      if (!page || page.length === 0) break
      existingProducts.push(...page)
      if (page.length < 1000) break
      pOffset += 1000
    }

    const existingMapBySku = new Map((existingProducts || []).filter(p => p.sku).map(p => [String(p.sku).trim().toUpperCase(), p]))
    const existingMapByVariant = new Map((existingProducts || []).filter(p => p.bsale_variant_id).map(p => [String(p.bsale_variant_id), p]))

    for (const rec of productsRecords) {
      if (!rec.sku) continue
      let ext = null
      if (rec.bsale_variant_id) ext = existingMapByVariant.get(String(rec.bsale_variant_id))
      if (!ext && rec.sku) ext = existingMapBySku.get(String(rec.sku).trim().toUpperCase())

      if (ext) {
        stats.updatedProducts++
      } else {
        stats.newProducts++
      }
    }

    // 4. Clasificación de operaciones
    const chunkSize = 200

    const toInsertProducts = []
    const toUpdateProducts = []

    for (const rec of productsRecords) {
      if (!rec.sku) continue
      let ext = null
      if (rec.bsale_variant_id) ext = existingMapByVariant.get(String(rec.bsale_variant_id))
      if (!ext && rec.sku) ext = existingMapBySku.get(String(rec.sku).trim().toUpperCase())

      if (ext) {
        const isUnchanged =
          (ext.sku || '') === (rec.sku || '') &&
          (ext.description || '') === (rec.description || '') &&
          (ext.barcode || '') === (rec.barcode || '') &&
          ext.bsale_product_state === rec.bsale_product_state &&
          ext.bsale_variant_state === rec.bsale_variant_state &&
          String(ext.bsale_product_type_id || '') === String(rec.bsale_product_type_id || '') &&
          (ext.bsale_product_type_name || null) === (rec.bsale_product_type_name || null) &&
          (ext.product_type || null) === (rec.product_type || null) &&
          (ext.bsale_brand_id ?? null) === (rec.bsale_brand_id ?? null) &&
          (ext.bsale_brand_href || null) === (rec.bsale_brand_href || null) &&
          ext.is_active === rec.is_active

        if (isUnchanged) {
          stats.unchangedCount++
        } else {
          toUpdateProducts.push({
            id: ext.id,
            sku: rec.sku,
            description: rec.description,
            barcode: rec.barcode,
            bsale_product_state: rec.bsale_product_state,
            bsale_variant_state: rec.bsale_variant_state,
            bsale_product_type_id: rec.bsale_product_type_id,
            bsale_product_type_name: rec.bsale_product_type_name,
            product_type: rec.product_type,
            bsale_brand_id: rec.bsale_brand_id,
            bsale_brand_href: rec.bsale_brand_href,
            is_active: rec.is_active,
            last_bsale_sync_at: rec.last_bsale_sync_at,
            company_id: companyId
          })
        }
      } else {
        toInsertProducts.push(rec)
      }
    }

    // Bsale can reuse a SKU/barcode after deleting or replacing a variant. In
    // that case the old local owner is not present in the complete Bsale
    // variant snapshot and must release only the values Bsale reassigned.
    // Keep this as an ordinary ordered update so the existing transactional
    // RPC still protects the write and stale-state checks.
    const incomingVariantIds = new Set(productsRecords.map(rec => String(rec.bsale_variant_id)))
    type BsaleProductOwner = {
      id: string
      sku: string | null
      barcode: string | null
      description: string | null
      bsale_variant_id?: string | number | null
      bsale_product_state: string | null
      bsale_variant_state: string | null
      bsale_product_type_id: string | number | null
      bsale_product_type_name: string | null
      product_type: string | null
      bsale_brand_id: string | number | null
      bsale_brand_href: string | null
      is_active: boolean
      last_bsale_sync_at: string | null
      company_id: string
    }
    const staleOwnerCleanup = new Map<string, BsaleProductOwner>()
    const ownerBySku = new Map((existingProducts || []).filter(p => p.sku).map(p => [String(p.sku).trim().toUpperCase(), p]))
    const ownerByBarcode = new Map((existingProducts || []).filter(p => p.barcode).map(p => [String(p.barcode).trim(), p]))

    for (const rec of productsRecords) {
      const release = (owner: BsaleProductOwner | undefined, field: 'sku' | 'barcode') => {
        if (!owner || owner.id === existingMapByVariant.get(String(rec.bsale_variant_id))?.id) return
        if (owner.bsale_variant_id && incomingVariantIds.has(String(owner.bsale_variant_id))) return

        const cleanup = staleOwnerCleanup.get(owner.id) || {
          id: owner.id,
          sku: owner.sku,
          barcode: owner.barcode,
          description: owner.description,
          bsale_product_state: owner.bsale_product_state,
          bsale_variant_state: owner.bsale_variant_state,
          bsale_product_type_id: owner.bsale_product_type_id,
          bsale_product_type_name: owner.bsale_product_type_name,
          product_type: owner.product_type,
          bsale_brand_id: owner.bsale_brand_id,
          bsale_brand_href: owner.bsale_brand_href,
          is_active: false,
          last_bsale_sync_at: new Date().toISOString(),
          company_id: companyId,
        }
        cleanup[field] = field === 'sku'
          ? `__BSALE_ORPHAN__${owner.bsale_variant_id || owner.id.slice(0, 8)}`
          : null
        staleOwnerCleanup.set(owner.id, cleanup)
      }

      if (rec.sku) release(ownerBySku.get(String(rec.sku).trim().toUpperCase()), 'sku')
      if (rec.barcode) release(ownerByBarcode.get(String(rec.barcode).trim()), 'barcode')
    }

    const plannerResult = planUniqueSafeProductUpdates(
      [...staleOwnerCleanup.values(), ...toUpdateProducts],
      existingProducts,
    )

    if (isDryRun) {
      stats.updatedCount = toUpdateProducts.length
      stats.insertedCount = toInsertProducts.length
      if (runId) await finishSyncRun({ runId, status: 'SUCCESS', message: `Dry-run. Insert: ${stats.insertedCount}, Update: ${stats.updatedCount}, Unchanged: ${stats.unchangedCount}`, readCount: stats.bsaleFetched })
      return { status: 'SUCCESS', stats, isDryRun: true, toUpdatePreview: toUpdateProducts, toInsertPreview: toInsertProducts, plannerResult }
    }

    if (plannerResult.conflicts.length > 0) {
      stats.conflictCount += plannerResult.conflicts.length
      stats.errorCount += plannerResult.conflicts.length
      const message = `Se detectaron ${plannerResult.conflicts.length} conflictos UNIQUE. Abortando actualizaciones.`
      if (runId) {
        await recordSyncError({ runId, companyId, provider, entity, errorMessage: message, safePayload: plannerResult.conflicts })
        await finishSyncRun({ runId, status: 'FAILED', readCount: stats.bsaleFetched, errorCount: stats.errorCount, message })
      }
      return { status: 'ERROR', stats, error: new Error('UNIQUE_CONFLICT_DETECTED') }
    }

    if (plannerResult.cycles.length > 0) {
      stats.cycleCount += plannerResult.cycles.length
      stats.errorCount += plannerResult.cycles.length
      const message = `Se detectaron ${plannerResult.cycles.length} ciclos UNIQUE. Abortando actualizaciones.`
      if (runId) {
        await recordSyncError({ runId, companyId, provider, entity, errorMessage: message, safePayload: plannerResult.cycles })
        await finishSyncRun({ runId, status: 'FAILED', readCount: stats.bsaleFetched, errorCount: stats.errorCount, message })
      }
      return { status: 'ERROR', stats, error: new Error('UNIQUE_CYCLE_DETECTED') }
    }

    // 5. Aplicar Updates mediante RPC Transaccional
    if (plannerResult.orderedUpdates.length > 0) {
      const payload = plannerResult.orderedUpdates.map(u => ({
        id: u.id,
        expected_sku: existingProducts.find(p => p.id === u.id)?.sku || null,
        new_sku: u.sku,
        expected_barcode: existingProducts.find(p => p.id === u.id)?.barcode || null,
        new_barcode: u.barcode,
        description: u.description,
        bsale_product_state: u.bsale_product_state,
        bsale_variant_state: u.bsale_variant_state,
        bsale_product_type_id: u.bsale_product_type_id,
        bsale_product_type_name: u.bsale_product_type_name,
        product_type: u.product_type,
        bsale_brand_id: u.bsale_brand_id,
        bsale_brand_href: u.bsale_brand_href,
        is_active: u.is_active,
        last_bsale_sync_at: u.last_bsale_sync_at
      }))
    
      const batchSummary = await executeSequentialBatches(payload, async (batch, batchIndex, totalBatches) => {
        console.log(`[bsale-products-sync] applying update batch ${batchIndex + 1}/${totalBatches} size=${batch.length}`)
        const { error: rpcErr } = await admin.schema('adquisiciones').rpc('apply_bsale_product_updates', {
          p_updates: batch,
          p_company_id: companyId
        })
        if (rpcErr) throw new Error(`Brand/product update batch ${batchIndex + 1}/${totalBatches}: ${rpcErr.message}`)
      })
      stats.updatedCount = batchSummary.itemsProcessed
      stats.reassignmentCount = payload.filter(u => u.expected_sku !== u.new_sku || u.expected_barcode !== u.new_barcode).length
    }

    // 6. Aplicar Inserts
    for (let i = 0; i < toInsertProducts.length; i += chunkSize) {
      const chunk = toInsertProducts.slice(i, i + chunkSize)
      const { error: err } = await admin.schema('adquisiciones').from('products').insert(chunk)
      if (err) {
        throw err
      } else {
        stats.insertedCount += chunk.length
      }
    }

    if (brandRecords.length > 0) {
      const { error: brandError } = await admin.schema('integraciones').from('bsale_brands').upsert(brandRecords, {
        onConflict: 'company_id,bsale_brand_id',
        ignoreDuplicates: false
      })
      if (brandError) {
        throw brandError
      }
    }

    console.log(`[bsale-products-sync] brands detected=${stats.brandRecordsDetected} withBrand=${stats.productsWithBrand} withoutBrand=${stats.productsWithoutBrand}`)

    if (runId) {
      await finishSyncRun({ 
        runId, status: 'SUCCESS', readCount: stats.bsaleFetched,
        insertedCount: stats.insertedCount, updatedCount: stats.updatedCount, errorCount: stats.errorCount,
        message: `Completado. Unchanged: ${stats.unchangedCount}`
      })
    }

    return { status: 'SUCCESS', stats }

  } catch (error: any) {
    if (runId) {
      await recordSyncError({ runId, companyId, provider, entity, errorMessage: error.message })
      await finishSyncRun({
        runId,
        status: 'FAILED',
        message: error.message,
        readCount: stats.bsaleFetched,
        insertedCount: stats.insertedCount,
        updatedCount: stats.updatedCount,
        errorCount: stats.errorCount + 1
      })
    }
    return { status: 'FAILED', message: error.message, stats }
  } finally {
    if (shouldCreateRun) await releaseSyncLock(companyId, provider, entity)
  }
}
