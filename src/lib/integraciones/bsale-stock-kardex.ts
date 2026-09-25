import { createClient } from '@supabase/supabase-js'
import { getBsaleConfigForCompany } from '@/lib/bsale/company-config'

type BsalePage<T> = { count?: number; items?: T[] }
type StockHeader = {
  id: number
  office?: { id?: number | string | null } | null
  state?: number | string | null
  updateStock?: number | string | null
  consumptionTypeId?: number | string | null
  admissionDate?: number | string | null
  consumptionDate?: number | string | null
  shippingDate?: number | string | null
  returnDate?: number | string | null
  internalDispatchId?: number | string | null
  guide?: { id?: number | string | null } | null
  reference_document?: { id?: number | string | null } | null
}
type StockDetail = {
  id: number
  quantity?: number | string | null
  quantityDevStock?: number | string | null
  variantStock?: number | string | null
  variant?: { id?: number | string | null; code?: string | null } | null
  variantId?: number | string | null
  documentDetailId?: number | string | null
}

export type KardexSyncOptions = {
  companyId: string
  dateFrom: string
  dateTo: string
  officeId?: number
  bsaleSyncRunId?: string
}

export type KardexSyncResult = {
  success: boolean
  runId?: string
  requests: number
  pages: number
  headers: number
  details: number
  events: number
  upserted: number
  errors: number
  retries: number
  durationMs: number
  refreshed?: unknown
  error?: string
}

const limit = 50
const detailConcurrency = 5
const provider = 'BSALE'
const entity = 'STOCK_KARDEX'

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function dateRange(from: string, to: string) {
  const dates: string[] = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function number(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function epochDay(date: string) {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)
}

function eventDate(header: StockHeader, source: string) {
  const value = source === 'RECEPTION' ? header.admissionDate
    : source === 'CONSUMPTION' ? header.consumptionDate
      : source === 'SHIPPING' ? header.shippingDate : header.returnDate
  const timestamp = number(value)
  return timestamp === null ? null : new Date(timestamp * 1000).toISOString().slice(0, 10)
}

function detailVariantId(detail: StockDetail) {
  return number(detail.variant?.id ?? detail.variantId)
}

async function fetchPage<T>(path: string, params: Record<string, string | number>, metrics: { requests: number; retries: number }, companyId: string) {
  const { baseUrl, accessToken } = getBsaleConfigForCompany(companyId)
  let lastError = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    metrics.requests++
    try {
      const response = await fetch(url, { headers: { access_token: accessToken, Accept: 'application/json' } })
      if (response.ok) return await response.json() as BsalePage<T>
      lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (attempt < 3) {
      metrics.retries++
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
  throw new Error(`${path}: ${lastError}`)
}

async function fetchAll<T>(path: string, params: Record<string, string | number>, metrics: { requests: number; pages: number; retries: number }, companyId: string) {
  const items: T[] = []
  for (let offset = 0; ; offset += limit) {
    const page = await fetchPage<T>(path, { ...params, limit, offset }, metrics, companyId)
    const current = page.items || []
    metrics.pages++
    items.push(...current)
    if (current.length < limit || items.length >= Number(page.count ?? items.length)) return items
  }
}

async function fetchHeadersByDay<T extends StockHeader>(path: string, dateParam: string, options: KardexSyncOptions, metrics: { requests: number; pages: number; retries: number }) {
  const headers: T[] = []
  const dates = dateRange(options.dateFrom, options.dateTo)
  for (let offset = 0; offset < dates.length; offset += detailConcurrency) {
    const batch = await Promise.all(dates.slice(offset, offset + detailConcurrency).map(date => fetchAll<T>(path, {
      officeid: options.officeId || 1,
      [dateParam]: epochDay(date),
    }, metrics, options.companyId)))
    headers.push(...batch.flat())
  }
  return headers
}

async function createRun(options: KardexSyncOptions) {
  const { data, error } = await db().schema('integraciones').from('bsale_sync_runs').insert({
    company_id: options.companyId,
    status: 'STARTED',
    trigger: 'MANUAL',
    date_from: options.dateFrom,
    date_to: options.dateTo,
  }).select('id').single()
  if (error) throw new Error(`No se pudo crear bsale_sync_run: ${error.message}`)
  return data.id as string
}

async function finishRun(runId: string, result: KardexSyncResult) {
  await db().schema('integraciones').from('bsale_sync_runs').update({
    status: result.success ? 'COMPLETED' : 'PARTIAL',
    completed_at: new Date().toISOString(),
    error_message: result.error || null,
    documents_count: result.headers,
    document_details_count: result.details,
    stocks_count: result.events,
  }).eq('id', runId)
}

export async function syncBsaleStockKardex(options: KardexSyncOptions): Promise<KardexSyncResult> {
  const started = Date.now()
  const metrics = { requests: 0, pages: 0, retries: 0 }
  const result: KardexSyncResult = { success: false, requests: 0, pages: 0, headers: 0, details: 0, events: 0, upserted: 0, errors: 0, retries: 0, durationMs: 0 }
  let runId = options.bsaleSyncRunId
  const ownsRun = !runId
  try {
    if (!runId) runId = await createRun(options)
    const officeId = options.officeId || 1
    const database = db()
    const sources = [
      { type: 'RECEPTION', path: '/stocks/receptions.json', dateParam: 'admissiondate' },
      { type: 'CONSUMPTION', path: '/stocks/consumptions.json', dateParam: 'consumptiondate' },
      { type: 'SHIPPING', path: '/shippings.json', dateParam: 'shippingdate' },
      { type: 'RETURN', path: '/returns.json', dateParam: 'returndate' },
    ] as const
    const events: Array<Record<string, unknown>> = []
    const pendingReturns: Array<{ header: StockHeader; detail: StockDetail; date: string; quantity: number; updateStock: number | null; sourceState: number | null; relatedDocumentId: number | null }> = []
    for (const source of sources) {
      let headers: StockHeader[] = []
      try {
        headers = await fetchHeadersByDay<StockHeader>(source.path, source.dateParam, options, metrics)
      } catch (error) {
        result.errors++
        result.error = `${source.type}: ${error instanceof Error ? error.message : String(error)}`
        continue
      }
      headers = headers.filter(header => Number(header.office?.id) === officeId && Number(header.state ?? 0) === 0)
      result.headers += headers.length
      for (let offset = 0; offset < headers.length; offset += detailConcurrency) {
        const settled = await Promise.allSettled(headers.slice(offset, offset + detailConcurrency).map(async header => {
          const detailsPath = source.type === 'RECEPTION' ? `/stocks/receptions/${header.id}/details.json`
            : source.type === 'CONSUMPTION' ? `/stocks/consumptions/${header.id}/details.json`
              : source.type === 'SHIPPING' ? `/shippings/${header.id}/details.json` : `/returns/${header.id}/details.json`
          const details = await fetchAll<StockDetail>(detailsPath, {}, metrics, options.companyId)
          return { header, details }
        }))
        for (const item of settled) {
          if (item.status === 'rejected') { result.errors++; continue }
          for (const detail of item.value.details) {
            result.details++
            const variantId = detailVariantId(detail)
            const date = eventDate(item.value.header, source.type)
            const quantity = number(source.type === 'RETURN' ? (detail.quantityDevStock ?? detail.quantity) : detail.quantity)
            if (source.type === 'RETURN' && quantity !== null && quantity <= 0) continue
            if ((!variantId && !(source.type === 'RETURN' && number(detail.documentDetailId))) || !date || quantity === null || quantity <= 0) { result.errors++; continue }
            const updateStock = number(item.value.header.updateStock)
            if (source.type === 'CONSUMPTION' && updateStock !== null && updateStock !== 1) continue
            const sourceState = number(item.value.header.state)
            const relatedDocumentId = number(item.value.header.guide?.id ?? item.value.header.reference_document?.id ?? item.value.header.internalDispatchId)
            if (source.type === 'RETURN' && !variantId) {
              pendingReturns.push({ header: item.value.header, detail, date, quantity, updateStock, sourceState, relatedDocumentId })
              continue
            }
            events.push({
              company_id: options.companyId,
              office_id: officeId,
              variant_id: variantId,
              variant_code: detail.variant?.code || null,
              event_date: date,
              source_type: source.type,
              source_header_id: item.value.header.id,
              source_detail_id: detail.id,
              quantity_delta: source.type === 'RECEPTION' || source.type === 'RETURN' ? quantity : -quantity,
              variant_stock_after: number(detail.variantStock),
              update_stock: updateStock === null ? null : updateStock === 1,
              source_state: sourceState,
              consumption_type_id: source.type === 'CONSUMPTION' ? number(item.value.header.consumptionTypeId) : null,
              related_document_id: relatedDocumentId,
              raw_json: { header: item.value.header, detail },
              captured_at: new Date().toISOString(),
              synced_at: new Date().toISOString(),
              bsale_sync_run_id: runId,
            })
          }
        }
      }
    }
    if (pendingReturns.length) {
      const documentDetailIds = [...new Set(pendingReturns.map(item => number(item.detail.documentDetailId)).filter((id): id is number => id !== null))]
      const resolvedVariants = new Map<number, { variant_id: number; variant_code: string | null }>()
      for (let offset = 0; offset < documentDetailIds.length; offset += 100) {
        const { data, error } = await database.schema('integraciones').from('bsale_document_details')
          .select('bsale_id,variant_id,variant_code')
          .in('bsale_id', documentDetailIds.slice(offset, offset + 100))
        if (error) throw new Error(`No se pudieron resolver variantes de devoluciones: ${error.message}`)
        for (const row of data || []) {
          const variantId = number(row.variant_id)
          const detailId = number(row.bsale_id)
          if (variantId !== null && detailId !== null) resolvedVariants.set(detailId, { variant_id: variantId, variant_code: row.variant_code || null })
        }
      }
      for (const item of pendingReturns) {
        const resolved = resolvedVariants.get(number(item.detail.documentDetailId) || 0)
        if (!resolved) { result.errors++; continue }
        events.push({
          company_id: options.companyId,
          office_id: officeId,
          variant_id: resolved.variant_id,
          variant_code: resolved.variant_code || item.detail.variant?.code || null,
          event_date: item.date,
          source_type: 'RETURN',
          source_header_id: item.header.id,
          source_detail_id: item.detail.id,
          quantity_delta: item.quantity,
          variant_stock_after: number(item.detail.variantStock),
          update_stock: item.updateStock === null ? null : item.updateStock === 1,
          source_state: item.sourceState,
          consumption_type_id: null,
          related_document_id: item.relatedDocumentId,
          raw_json: { header: item.header, detail: item.detail, resolved_variant: resolved },
          captured_at: new Date().toISOString(),
          synced_at: new Date().toISOString(),
          bsale_sync_run_id: runId,
        })
      }
    }
    result.events = events.length
    for (let offset = 0; offset < events.length; offset += 500) {
      const chunk = events.slice(offset, offset + 500)
      const { error } = await database.schema('integraciones').from('bsale_stock_kardex_events').upsert(chunk, { onConflict: 'company_id,office_id,source_type,source_header_id,source_detail_id' })
      if (error) throw new Error(`No se pudo upsert Kardex: ${error.message}`)
      result.upserted += chunk.length
    }
    const { data: refreshed, error: refreshError } = await database.schema('integraciones').rpc('refresh_bsale_stock_break_read_models', {
      p_company_id: options.companyId,
      p_office_id: officeId,
      p_date_from: options.dateFrom,
      p_date_to: options.dateTo,
    })
    if (refreshError) throw new Error(`No se pudo refrescar read-model: ${refreshError.message}`)
    result.refreshed = refreshed
    result.success = result.errors === 0
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    result.errors++
  } finally {
    result.runId = runId
    result.requests = metrics.requests
    result.pages = metrics.pages
    result.retries = metrics.retries
    result.durationMs = Date.now() - started
    if (runId && ownsRun) await finishRun(runId, result)
  }
  return result
}
