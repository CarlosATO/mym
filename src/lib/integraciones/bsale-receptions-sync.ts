import { createClient } from '@supabase/supabase-js'
import { bsaleFetchAll, getBsaleHeaders } from '@/lib/bsale/client'
import { tryAcquireSyncLock, releaseSyncLock, type SyncTriggerType } from './sync-core'

type BsaleReception = {
  id: number
  admissionDate?: number | null
  rawAdmissionDate?: string | null
  document?: string | null
  documentNumber?: string | number | null
  note?: string | null
  office?: { id?: string | number | null } | null
}

type BsaleReceptionDetail = {
  id: number
  quantity?: number | string | null
  cost?: number | string | null
  variantStock?: number | string | null
  variant?: { id?: string | number | null } | null
}

type SyncRunRow = {
  id: string
  company_id: string
  started_at?: string | null
}

type ReceptionSyncCounts = {
  receptionsFetched: number
  receptionsUpserted: number
  detailsFetched: number
  detailsUpserted: number
  errors: number
}

type LocalVariantRow = {
  bsale_variant_id: number | string | null
  sku: string | null
}

const BSALE_API_BASE = process.env.BSALE_API_BASE_URL || 'https://api.bsale.cl/v1'

function integrDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      db: { schema: 'integraciones' },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  )
}

function adqDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      db: { schema: 'adquisiciones' },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  )
}

function toNum(value: unknown) {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function epochToIso(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? new Date(parsed * 1000).toISOString() : null
}

function epochToDate(value: unknown) {
  const iso = epochToIso(value)
  return iso ? iso.slice(0, 10) : null
}

function fmtBsaleDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function listDates(from: string, to: string) {
  const result: string[] = []
  const current = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (current <= end) {
    result.push(fmtBsaleDate(current))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return result
}

async function createReceptionSyncRun(companyId: string, trigger: SyncTriggerType, dateFrom?: string, dateTo?: string): Promise<SyncRunRow> {
  const db = integrDb()
  const { data, error } = await db
    .from('bsale_sync_runs')
    .insert({
      company_id: companyId,
      status: 'STARTED',
      trigger,
      date_from: dateFrom || null,
      date_to: dateTo || null,
    })
    .select('id, company_id, started_at')
    .single()

  if (error) throw new Error(`Error creando sync run de recepciones: ${error.message}`)
  return data as SyncRunRow
}

async function finishReceptionSyncRun(runId: string, status: 'COMPLETED' | 'PARTIAL' | 'FAILED', counts: ReceptionSyncCounts, errorMessage?: string) {
  const db = integrDb()
  const { error } = await db
    .from('bsale_sync_runs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      error_message: errorMessage || null,
      documents_count: counts.receptionsFetched,
      document_details_count: counts.detailsFetched,
      stocks_count: counts.receptionsUpserted,
      products_count: counts.detailsUpserted,
      costs_count: counts.errors,
    })
    .eq('id', runId)
  if (error) console.error('[syncBsaleReceptions] Error finishing sync run:', error.message)
}

async function fetchReceptionHeaders(params: { dateFrom?: string; dateTo?: string }) {
  if (params.dateFrom && params.dateTo) {
    const dates = listDates(params.dateFrom, params.dateTo)
    const all: BsaleReception[] = []
    for (const date of dates) {
      const dayItems = await bsaleFetchAll<BsaleReception>('/stocks/receptions.json', {
        admissiondate: date,
      })
      all.push(...dayItems)
    }
    return all
  }

  return bsaleFetchAll<BsaleReception>('/stocks/receptions.json')
}

async function fetchReceptionDetails(receptionId: number) {
  return bsaleFetchAll<BsaleReceptionDetail>(`/stocks/receptions/${receptionId}/details.json`)
}

async function buildVariantCodeMap(companyId: string, variantIds: number[], cache: Map<number, string | null>) {
  const map = new Map<number, string>()
  if (!variantIds.length) return map

  for (const variantId of variantIds) {
    const cached = cache.get(variantId)
    if (cached) map.set(variantId, cached)
  }
  const unresolved = variantIds.filter((id) => !cache.has(id))
  if (!unresolved.length) return map

  const { data, error } = await adqDb()
    .from('products')
    .select('bsale_variant_id, sku')
    .eq('company_id', companyId)
    .in('bsale_variant_id', unresolved)
  if (error) throw error

  for (const row of (data || []) as LocalVariantRow[]) {
    const variantId = Number(row.bsale_variant_id || 0)
    if (variantId > 0 && row.sku) {
      const normalizedSku = String(row.sku).trim().toUpperCase()
      map.set(variantId, normalizedSku)
      cache.set(variantId, normalizedSku)
    }
  }

  const missing = unresolved.filter((id) => !map.has(id))
  for (const variantId of missing) {
    try {
      const response = await fetch(`${BSALE_API_BASE}/variants/${variantId}.json`, {
        method: 'GET',
        headers: getBsaleHeaders(),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        cache.set(variantId, null)
        continue
      }
      const data = await response.json() as { code?: string | null }
      const normalizedSku = data.code ? String(data.code).trim().toUpperCase() : null
      cache.set(variantId, normalizedSku)
      if (normalizedSku) map.set(variantId, normalizedSku)
    } catch {
      cache.set(variantId, null)
      // seguimos sin bloquear el sync completo por una variante sin resolver
    }
  }

  return map
}

export async function syncBsaleReceptionDetails(params: {
  companyId: string
  runId: string
  receptions: BsaleReception[]
  variantCodeCache: Map<number, string | null>
}) {
  const db = integrDb()
  const allDetails: Array<{
    company_id: string
    bsale_id: number
    bsale_reception_id: number
    quantity: number
    cost: number
    variant_stock: number
    variant_id: number | null
    variant_code: string | null
    raw_json: BsaleReceptionDetail
    bsale_sync_run_id: string
    synced_at: string
    updated_at: string
  }> = []

  const detailErrors: string[] = []
  const concurrency = 5
  for (let i = 0; i < params.receptions.length; i += concurrency) {
    const batch = params.receptions.slice(i, i + concurrency)
    const batchResults = await Promise.allSettled(
      batch.map(async (reception) => {
        const details = await fetchReceptionDetails(reception.id)
        return { receptionId: reception.id, details }
      }),
    )

    const variantIdsToResolve: number[] = []
    const successfulBatches = batchResults
      .filter((result): result is PromiseFulfilledResult<{ receptionId: number; details: BsaleReceptionDetail[] }> => result.status === 'fulfilled')
      .map((result) => result.value)

    for (const result of batchResults) {
      if (result.status === 'rejected') {
        detailErrors.push(result.reason instanceof Error ? result.reason.message : 'Error desconocido al leer detalle de recepción')
      }
    }

    for (const batchItem of successfulBatches) {
      for (const detail of batchItem.details) {
        const variantId = Number(detail.variant?.id || 0)
        if (variantId > 0) variantIdsToResolve.push(variantId)
      }
    }

    const variantCodeMap = await buildVariantCodeMap(
      params.companyId,
      Array.from(new Set(variantIdsToResolve)),
      params.variantCodeCache,
    )

    for (const batchItem of successfulBatches) {
      for (const detail of batchItem.details) {
        const variantId = Number(detail.variant?.id || 0) || null
        allDetails.push({
          company_id: params.companyId,
          bsale_id: Number(detail.id),
          bsale_reception_id: batchItem.receptionId,
          quantity: toNum(detail.quantity),
          cost: toNum(detail.cost),
          variant_stock: toNum(detail.variantStock),
          variant_id: variantId,
          variant_code: variantId ? variantCodeMap.get(variantId) || null : null,
          raw_json: detail,
          bsale_sync_run_id: params.runId,
          synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
      }
    }
  }

  if (!allDetails.length) {
    return { detailsFetched: 0, detailsUpserted: 0, detailErrors }
  }

  const { error } = await db.from('bsale_reception_details').upsert(allDetails, {
    onConflict: 'company_id,bsale_id',
    ignoreDuplicates: false,
  })
  if (error) throw new Error(`Error upserting reception details: ${error.message}`)

  return { detailsFetched: allDetails.length, detailsUpserted: allDetails.length, detailErrors }
}

export async function syncBsaleReceptions(options: {
  companyId: string
  trigger: SyncTriggerType
  dateFrom?: string
  dateTo?: string
  allowLargeBackfill?: boolean
}) {
  const { companyId, trigger, dateFrom, dateTo } = options
  const provider = 'BSALE'
  const entity = 'receptions'
  const locked = await tryAcquireSyncLock({
    companyId,
    provider,
    entity,
    ttlMinutes: 60,
    lockedBy: trigger,
  })
  if (!locked) {
    return { success: false, status: 'SKIPPED_LOCKED', message: 'Sync already running' as const }
  }

  let run: SyncRunRow | null = null
  const variantCodeCache = new Map<number, string | null>()
  try {
    run = await createReceptionSyncRun(companyId, trigger, dateFrom, dateTo)
    if (!run) throw new Error('No se pudo crear sync run de recepciones')
    const runId = run.id
    const headers = await fetchReceptionHeaders({ dateFrom, dateTo })

    const receptionRows = headers.map((reception) => ({
      company_id: companyId,
      bsale_id: Number(reception.id),
      admission_date: epochToIso(reception.admissionDate),
      raw_admission_date: reception.rawAdmissionDate || epochToDate(reception.admissionDate),
      document: reception.document || null,
      document_number: reception.documentNumber ? String(reception.documentNumber) : null,
      note: reception.note || null,
      office_id: Number(reception.office?.id || 0) || null,
      raw_json: reception,
      bsale_sync_run_id: runId,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))

    if (receptionRows.length) {
      const { error } = await integrDb().from('bsale_receptions').upsert(receptionRows, {
        onConflict: 'company_id,bsale_id',
        ignoreDuplicates: false,
      })
      if (error) throw new Error(`Error upserting receptions: ${error.message}`)
    }
    const detailResult = await syncBsaleReceptionDetails({
      companyId,
      runId,
      receptions: headers,
      variantCodeCache,
    })

    const status = detailResult.detailErrors.length > 0 ? 'PARTIAL' : 'COMPLETED'
    await finishReceptionSyncRun(run.id, status, {
      receptionsFetched: headers.length,
      receptionsUpserted: receptionRows.length,
      detailsFetched: detailResult.detailsFetched,
      detailsUpserted: detailResult.detailsUpserted,
      errors: detailResult.detailErrors.length,
    })

    return {
      success: true,
      status,
      receptionsFetched: headers.length,
      receptionsUpserted: receptionRows.length,
      detailsFetched: detailResult.detailsFetched,
      detailsUpserted: detailResult.detailsUpserted,
      detailErrors: detailResult.detailErrors,
      runId,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error inesperado sincronizando recepciones Bsale'
    if (run?.id) await finishReceptionSyncRun(run.id, 'FAILED', {
      receptionsFetched: 0,
      receptionsUpserted: 0,
      detailsFetched: 0,
      detailsUpserted: 0,
      errors: 1,
    }, message)
    return { success: false, status: 'FAILED' as const, message, runId: run?.id }
  } finally {
    await releaseSyncLock(companyId, provider, entity)
  }
}
