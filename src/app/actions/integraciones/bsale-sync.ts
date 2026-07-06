'use server'

import { createClient } from '@supabase/supabase-js'
import { bsaleFetchAll, normalizeSku, getBsaleHeaders } from '@/lib/bsale/client'

const BSALE_API_BASE = process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function integrDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'integraciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function adqDb() {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'adquisiciones' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

interface SyncRun {
  id: string
  company_id: string
  started_at?: string
}

async function createSyncRun(companyId: string): Promise<SyncRun> {
  const db = integrDb()
  const { data, error } = await db
    .from('bsale_sync_runs')
    .insert({
      company_id: companyId,
      status: 'STARTED',
      trigger: 'MANUAL',
    })
    .select('id, company_id, started_at')
    .single()

  if (error) throw new Error(`Error creando sync run: ${error.message}`)
  return data
}

async function finishSyncRun(
  runId: string,
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED',
  counts: Record<string, number>,
  errorMessage?: string
) {
  const db = integrDb()
  const update: any = {
    status,
    completed_at: new Date().toISOString(),
    error_message: errorMessage || null,
  }
  if (counts.products !== undefined) update.products_count = counts.products
  if (counts.variants !== undefined) update.variants_count = counts.variants
  if (counts.stocks !== undefined) update.stocks_count = counts.stocks
  if (counts.costs !== undefined) update.costs_count = counts.costs
  if (counts.documents !== undefined) update.documents_count = counts.documents
  if (counts.document_details_count !== undefined) update.document_details_count = counts.document_details_count

  await db.from('bsale_sync_runs').update(update).eq('id', runId)
}

// ─── Sync functions ───────────────────────────────────────────────

async function syncProductTypes(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  const items = await bsaleFetchAll<any>('/product_types.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((p: any) => ({
        company_id: companyId,
        bsale_id: p.id,
        name: p.name || '',
        state: p.state ?? null,
        raw_json: p,
        bsale_sync_run_id: runId,
        synced_at: new Date().toISOString(),
      }))

      const { error } = await db.from('bsale_product_types').upsert(records, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncProductTypes] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}


async function syncProducts(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  const items = await bsaleFetchAll<any>('/products.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((p: any) => ({
        company_id: companyId,
        bsale_id: p.id,
        name: p.name || '',
        description: p.description || null,
        classification: p.classification ?? null,
        stock_control: p.stockControl === 1,
        state: p.state ?? null,
        product_type_id: p.product_type?.id ? Number(p.product_type.id) : null,
        raw_json: p,
        bsale_sync_run_id: runId,
        synced_at: new Date().toISOString(),
      }))

      const { error } = await db.from('bsale_products').upsert(records, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncProducts] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}

async function syncVariants(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  const items = await bsaleFetchAll<any>('/variants.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((v: any) => ({
        company_id: companyId,
        bsale_id: v.id,
        bsale_product_id: v.product?.id ? Number(v.product.id) : 0,
        code: normalizeSku(v.code || ''),
        description: v.description || null,
        bar_code: v.barCode || null,
        state: v.state ?? null,
        unlimited_stock: v.unlimitedStock === 1,
        allow_negative_stock: v.allowNegativeStock === 1,
        raw_json: v,
        bsale_sync_run_id: runId,
        synced_at: new Date().toISOString(),
      }))

      const { error } = await db.from('bsale_variants').upsert(records, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncVariants] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}

async function syncStock(companyId: string, runId: string): Promise<number> {
  const db = integrDb()
  let count = 0

  const items = await bsaleFetchAll<any>('/stocks.json', { limit: 50 }, {
    onPage: async (page, batch) => {
      const records = batch.map((s: any) => ({
        company_id: companyId,
        bsale_id: s.id,
        variant_id: s.variant?.id ? Number(s.variant.id) : 0,
        variant_code: null,
        quantity: s.quantity ?? 0,
        quantity_reserved: s.quantityReserved ?? 0,
        quantity_available: s.quantityAvailable ?? 0,
        office_id: s.office?.id ? Number(s.office.id) : null,
        raw_json: s,
        bsale_sync_run_id: runId,
        synced_at: new Date().toISOString(),
      }))

      // Enrich with variant_code from bsale_variants
      const variantIds = [...new Set(records.map(r => r.variant_id).filter(Boolean))]
      if (variantIds.length > 0) {
        const { data: variants } = await db
          .from('bsale_variants')
          .select('bsale_id, code')
          .in('bsale_id', variantIds)
          .eq('company_id', companyId)

        const codeMap = new Map((variants || []).map((v: any) => [v.bsale_id, v.code]))
        for (const r of records) {
          r.variant_code = codeMap.get(r.variant_id) || null
        }
      }

      const { error } = await db.from('bsale_stock_current').upsert(records, {
        onConflict: 'company_id, bsale_id',
        ignoreDuplicates: false,
      })
      if (error) console.error(`[syncStock] page ${page} error:`, error.message)
      count += records.length
    },
  })

  return count
}

// ─── Sync Costs ────────────────────────────────────────────────────

async function getVariantCost(bsaleVariantId: number): Promise<{
  averageCost: number
  totalCost: number
  parsedHistory: any[]
  raw: any
} | null> {
  try {
    const url = `${BSALE_API_BASE}/variants/${bsaleVariantId}/costs.json`
    const response = await fetch(url, {
      method: 'GET',
      headers: getBsaleHeaders(),
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      if (response.status === 404) return null
      throw new Error(`HTTP ${response.status}`)
    }

    const data = await response.json()
    return {
      averageCost: Number(data.averageCost) || 0,
      totalCost: Number(data.totalCost) || 0,
      parsedHistory: (data.history || []).map((h: any) => ({
        admissionDate: h.admissionDate ? new Date(h.admissionDate * 1000).toISOString() : null,
        cost: Number(h.cost) || 0,
        quantity: Number(h.quantity) || 0,
      })),
      raw: data,
    }
  } catch {
    return null
  }
}

async function syncCosts(companyId: string, runId: string): Promise<{
  processed: number
  withCost: number
  zeroCost: number
  errors: number
}> {
  const db = integrDb()
  let processed = 0
  let withCost = 0
  let zeroCost = 0
  let errors = 0
  let errorDetails: string[] = []

  // Get all variant bsale_ids
  // Fetch all variants paginated (REST API default limit is 1000)
  let allVariants: any[] = []
  let from = 0
  const pageSize = 1000

  while (true) {
    const { data: page, error } = await db
      .from('bsale_variants')
      .select('bsale_id, code')
      .eq('company_id', companyId)
      .not('bsale_id', 'is', null)
      .range(from, from + pageSize - 1)

    if (error) {
      console.error('[syncCosts] Error fetching variants:', error.message)
      break
    }
    if (!page || page.length === 0) break
    allVariants = allVariants.concat(page)
    if (page.length < pageSize) break
    from += pageSize
  }

  const variants = allVariants

  if (!variants || variants.length === 0) {
    console.log('[syncCosts] No variants found to process')
    return { processed: 0, withCost: 0, zeroCost: 0, errors: 0 }
  }

  console.log(`[syncCosts] Processing ${variants.length} variants...`)
  const CONCURRENCY = 5

  // Process in batches with controlled concurrency
  for (let i = 0; i < variants.length; i += CONCURRENCY) {
    const batch = variants.slice(i, i + CONCURRENCY)
    const promises = batch.map(async (v: any) => {
      const variantId = Number(v.bsale_id)
      if (!variantId) return

      const cost = await getVariantCost(variantId)
      processed++

      if (!cost) {
        zeroCost++
        return
      }

      const { error } = await db.from('bsale_variant_costs').upsert(
        {
          company_id: companyId,
          variant_id: variantId,
          variant_code: v.code || null,
          average_cost: cost.averageCost,
          total_cost: cost.totalCost,
          cost_history: cost.parsedHistory.length > 0 ? cost.parsedHistory : null,
          raw_json: cost.raw,
          bsale_sync_run_id: runId,
          synced_at: new Date().toISOString(),
        },
        {
          onConflict: 'company_id, variant_id',
          ignoreDuplicates: false,
        }
      )

      if (error) {
        errors++
        errorDetails.push(`variant ${variantId}: ${error.message}`)
        return
      }

      if (cost.averageCost > 0) withCost++
      else zeroCost++
    })

    await Promise.allSettled(promises)

    if ((i + CONCURRENCY) % 100 < CONCURRENCY || i + CONCURRENCY >= variants.length) {
      console.log(`[syncCosts] Progress: ${Math.min(i + CONCURRENCY, variants.length)}/${variants.length} (ok: ${withCost}, zero: ${zeroCost}, err: ${errors})`)
    }
  }

  if (errorDetails.length > 0 && errorDetails.length <= 5) {
    console.error('[syncCosts] Errors:', errorDetails.join('; '))
  }

  return { processed, withCost, zeroCost, errors }
}

export async function syncBsaleCosts(companyId: string): Promise<{
  success: boolean
  runId?: string
  counts?: Record<string, number>
  error?: string
}> {
  if (!companyId) {
    return { success: false, error: 'companyId es requerido' }
  }

  let run: SyncRun | null = null

  try {
    run = await createSyncRun(companyId)
    const runId = run.id

    console.log('[bsale-sync] Iniciando sync de costos...')
    const result = await syncCosts(companyId, runId)
    console.log(`[bsale-sync] Costos: ${result.processed} procesados, ${result.withCost} con costo, ${result.zeroCost} sin costo, ${result.errors} errores`)

    const counts: Record<string, number> = {
      variant_costs_processed: result.processed,
      variant_costs_with_cost: result.withCost,
      variant_costs_zero: result.zeroCost,
      variant_costs_errors: result.errors,
    }

    await finishSyncRun(runId, 'COMPLETED', {
      costs: result.processed,
      ...counts,
    })

    return { success: true, runId, counts }
  } catch (err: any) {
    const errMsg = err.message || 'Error desconocido'
    console.error('[bsale-sync] Error en syncCosts:', errMsg)

    if (run?.id) {
      await finishSyncRun(run.id, 'FAILED', {}, errMsg).catch(e =>
        console.error('[bsale-sync] Error al finalizar sync run:', e.message)
      )
    }

    return { success: false, error: errMsg }
  }
}

// ─── Sync Sales (Documents + Details) ─────────────────────────────

async function fetchAllDocuments(
  companyId: string,
  runId: string,
  dateFrom: Date,
  dateTo: Date
): Promise<{ documents: any[]; pages: number }> {
  const allDocs: any[] = []
  const LIMIT = 50
  let offset = 0
  let pages = 0
  const rangeEncoded = encodeURIComponent(`[${Math.floor(dateFrom.getTime() / 1000)},${Math.floor(dateTo.getTime() / 1000)}]`)

  while (true) {
    const url = `${BSALE_API_BASE}/documents.json?limit=${LIMIT}&offset=${offset}&emissiondaterange=${rangeEncoded}`
    const response = await fetch(url, {
      method: 'GET',
      headers: getBsaleHeaders(),
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Bsale API error ${response.status} at offset ${offset}: ${body.substring(0, 100)}`)
    }

    const data = await response.json()
    const items = data.items || []
    allDocs.push(...items)
    pages++

    if (items.length < LIMIT) break
    offset += LIMIT
  }

  return { documents: allDocs, pages }
}

async function syncDocuments(companyId: string, runId: string, days: number): Promise<{
  docsCount: number
  detailsCount: number
  detailErrors: number
  pages: number
}> {
  const db = integrDb()
  const dateTo = new Date()
  const dateFrom = new Date(dateTo.getTime() - days * 86400000)

  console.log(`[syncSales] Fetching documents from ${dateFrom.toISOString().slice(0, 10)} to ${dateTo.toISOString().slice(0, 10)}`)

  const { documents, pages } = await fetchAllDocuments(companyId, runId, dateFrom, dateTo)
  console.log(`[syncSales] Documents fetched: ${documents.length} in ${pages} pages`)

  // Upsert documents in batches
  let docsCount = 0
  let detailsCount = 0
  let detailErrors = 0

  for (let i = 0; i < documents.length; i += 50) {
    const batch = documents.slice(i, i + 50)
    const records = batch.map((d: any) => ({
      company_id: companyId,
      bsale_id: d.id,
      number: d.number ?? null,
      emission_date: d.emissionDate ? new Date(d.emissionDate * 1000).toISOString().slice(0, 10) : null,
      generation_date: d.generationDate ? new Date(d.generationDate * 1000).toISOString() : null,
      total_amount: d.totalAmount ?? null,
      net_amount: d.netAmount ?? null,
      tax_amount: d.taxAmount ?? null,
      exempt_amount: d.exemptAmount ?? null,
      document_type_id: d.documentTypeId ?? d.document_type?.id ?? null,
      client_id: d.client?.id ?? d.clientId ?? null,
      office_id: d.office?.id ?? d.officeId ?? null,
      state: d.state ?? null,
      tracking_number: d.trackingNumber || null,
      url_pdf: d.urlPdf || null,
      raw_json: d,
      bsale_sync_run_id: runId,
      synced_at: new Date().toISOString(),
    }))

    const { error } = await db.from('bsale_documents').upsert(records, {
      onConflict: 'company_id, bsale_id',
      ignoreDuplicates: false,
    })
    if (error) console.error(`[syncSales] Document batch error:`, error.message)
    else docsCount += records.length
  }

  // Fetch details with retry + backoff + classification
  console.log(`[syncSales] Fetching details for ${documents.length} documents...`)
  const CONCURRENCY = 3
  const MAX_RETRIES = 3

  interface DetailResult {
    docId: number
    status: 'OK' | 'WITHOUT_DETAILS' | 'ERROR'
    detailCount: number
  }

  const allDocDetails: DetailResult[] = []

  for (let i = 0; i < documents.length; i += CONCURRENCY) {
    const batch = documents.slice(i, i + CONCURRENCY)
    const promises = batch.map(async (doc: any): Promise<DetailResult> => {
      let lastError: string | null = null

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 1) {
            const delay = attempt * 2000
            await new Promise(r => setTimeout(r, delay))
          }

          const url = `${BSALE_API_BASE}/documents/${doc.id}/details.json?limit=50`
          const response = await fetch(url, {
            method: 'GET',
            headers: getBsaleHeaders(),
            signal: AbortSignal.timeout(20000),
          })

          if (response.status === 404 || response.status === 400) {
            return { docId: doc.id, status: 'WITHOUT_DETAILS', detailCount: 0 }
          }

          if (response.status === 429) {
            lastError = `HTTP 429 (rate limited)`
            await new Promise(r => setTimeout(r, attempt * 3000))
            continue
          }

          if (!response.ok) {
            lastError = `HTTP ${response.status}`
            continue
          }

          const data = await response.json()
          const details = data.items || []

          if (details.length === 0) {
            return { docId: doc.id, status: 'WITHOUT_DETAILS', detailCount: 0 }
          }

          const detailRecords = details.map((det: any, idx: number) => {
            const vid = det.variant?.id ? Number(det.variant.id) : null
            const vcode = det.variant?.code ? normalizeSku(det.variant.code) : null

            return {
              company_id: companyId,
              bsale_id: det.id,
              bsale_document_id: doc.id,
              line_number: det.lineNumber ?? idx,
              quantity: det.quantity ?? 0,
              net_unit_value: det.netUnitValue ?? det.netUnitValueRaw ?? 0,
              total_unit_value: det.totalUnitValue ?? 0,
              net_amount: det.netAmount ?? 0,
              tax_amount: det.taxAmount ?? 0,
              total_amount: det.totalAmount ?? 0,
              net_discount: det.netDiscount ?? 0,
              variant_id: vid,
              variant_code: vcode,
              variant_description: det.variant?.description || null,
              raw_json: det,
              bsale_sync_run_id: runId,
              synced_at: new Date().toISOString(),
            }
          })

          const { error } = await db.from('bsale_document_details').upsert(detailRecords, {
            onConflict: 'company_id, bsale_id',
            ignoreDuplicates: false,
          })

          if (error) {
            lastError = `DB: ${error.message}`
            continue
          }

          detailsCount += detailRecords.length
          return { docId: doc.id, status: 'OK', detailCount: detailRecords.length }
        } catch (err: any) {
          lastError = err?.message || 'unknown error'
          if (err?.name === 'AbortError') lastError = 'timeout'
        }
      }

      return { docId: doc.id, status: 'ERROR', detailCount: 0 }
    })

    const results = await Promise.allSettled(promises)
    for (const r of results) {
      if (r.status === 'fulfilled') allDocDetails.push(r.value)
      else detailErrors++
    }

    if ((i + CONCURRENCY) % 200 < CONCURRENCY || i + CONCURRENCY >= documents.length) {
      const ok = allDocDetails.filter(d => d.status === 'OK').length
      const nodet = allDocDetails.filter(d => d.status === 'WITHOUT_DETAILS').length
      const err = allDocDetails.filter(d => d.status === 'ERROR').length
      const pct = documents.length > 0 ? ((ok / documents.length) * 100).toFixed(1) : '0'
      console.log(`[syncSales] ${Math.min(i + CONCURRENCY, documents.length)}/${documents.length} | OK:${ok} (${pct}%) | NoDet:${nodet} | Err:${err} | details:${detailsCount}`)
    }
  }

  const finalOk = allDocDetails.filter(d => d.status === 'OK').length
  const finalNoDet = allDocDetails.filter(d => d.status === 'WITHOUT_DETAILS').length
  const finalErr = allDocDetails.filter(d => d.status === 'ERROR').length
  const coverage = documents.length > 0 ? ((finalOk / documents.length) * 100).toFixed(1) : '0'

  console.log(`[syncSales] FINAL: docs=${documents.length} OK=${finalOk} (${coverage}%) NoDet=${finalNoDet} Err=${finalErr} details=${detailsCount}`)

  return { docsCount, detailsCount, detailErrors: finalErr, pages }
}

export async function syncBsaleSales(
  companyId: string,
  options?: { days?: number }
): Promise<{
  success: boolean
  runId?: string
  counts?: Record<string, number>
  error?: string
}> {
  if (!companyId) {
    return { success: false, error: 'companyId es requerido' }
  }

  const days = options?.days || 180
  let run: SyncRun | null = null

  try {
    run = await createSyncRun(companyId)
    const runId = run.id

    console.log(`[bsale-sync] Iniciando sync de ventas (${days} días)...`)
    const result = await syncDocuments(companyId, runId, days)

    const counts: Record<string, number> = {
      documents: result.docsCount,
      details: result.detailsCount,
      detail_errors: result.detailErrors,
      pages: result.pages,
    }

    const syncStatus = result.detailErrors > 0 ? 'PARTIAL' : 'COMPLETED'
    await finishSyncRun(runId, syncStatus, {
      documents: result.docsCount,
      document_details_count: result.detailsCount,
      detail_errors: result.detailErrors,
    })

    return { success: true, runId, counts }
  } catch (err: any) {
    const errMsg = err.message || 'Error desconocido'
    console.error('[bsale-sync] Error en syncSales:', errMsg)

    if (run?.id) {
      await finishSyncRun(run.id, 'FAILED', {}, errMsg).catch(e =>
        console.error('[bsale-sync] Error al finalizar sync run:', e.message)
      )
    }

    return { success: false, error: errMsg }
  }
}

// ─── Main sync function ───────────────────────────────────────────

export async function syncBsaleCatalog(companyId: string): Promise<{
  success: boolean
  runId?: string
  counts?: Record<string, number>
  error?: string
}> {
  if (!companyId) {
    return { success: false, error: 'companyId es requerido' }
  }

  let run: SyncRun | null = null

  try {
    run = await createSyncRun(companyId)
    const runId = run.id
    const counts: Record<string, number> = {}

    // 1. Sincronizar product types
    console.log('[bsale-sync] Iniciando sync de product types...')
    counts.product_types = await syncProductTypes(companyId, runId)
    console.log(`[bsale-sync] Product types sincronizados: ${counts.product_types}`)

    // 2. Sincronizar productos del catálogo
    console.log('[bsale-sync] Iniciando sync de productos...')
    counts.products = await syncProducts(companyId, runId)
    console.log(`[bsale-sync] Productos sincronizados: ${counts.products}`)

    // 2. Sincronizar variantes (contienen SKU)
    console.log('[bsale-sync] Iniciando sync de variantes...')
    counts.variants = await syncVariants(companyId, runId)
    console.log(`[bsale-sync] Variantes sincronizadas: ${counts.variants}`)

    // 3. Sincronizar stock actual
    console.log('[bsale-sync] Iniciando sync de stock...')
    counts.stocks = await syncStock(companyId, runId)
    console.log(`[bsale-sync] Stock sincronizado: ${counts.stocks}`)

    await finishSyncRun(runId, 'COMPLETED', counts)

    return { success: true, runId, counts }
  } catch (err: any) {
    const errMsg = err.message || 'Error desconocido'
    console.error('[bsale-sync] Error:', errMsg)

    if (run?.id) {
      await finishSyncRun(run.id, 'FAILED', {}, errMsg).catch(e =>
        console.error('[bsale-sync] Error al finalizar sync run:', e.message)
      )
    }

    return { success: false, error: errMsg }
  }
}
