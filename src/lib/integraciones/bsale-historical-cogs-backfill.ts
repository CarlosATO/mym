import { createClient, type SupabaseClient } from '@supabase/supabase-js'
// @ts-expect-error The standalone Node test runner needs an explicit TypeScript extension.
import { getBsaleConfigForCompany } from '../bsale/company-config.ts'
import {
  mapDocumentCostPayload,
  upsertDocumentCost,
  upsertDocumentCostDetails,
  type BsaleDocumentCostPayload,
// @ts-expect-error The standalone Node test runner needs an explicit TypeScript extension.
} from './bsale-historical-cogs.ts'

const ELIGIBLE_DOCUMENT_TYPES = new Set([1, 5])
const COMPLETED_STATUSES = new Set(['OBSERVED', 'ZERO_WITH_EVIDENCE'])

export interface HistoricalCogsDocument {
  bsale_id: number
  document_type_id: number
  number: string | number | null
  emission_date: string
  net_amount: string | number | null
  total_amount: string | number | null
  state: number
}

export interface HistoricalCogsExistingCost {
  bsale_document_id: number
  status: string
  source: string
}

export interface HistoricalCogsReconciliation {
  documentId: number
  detailCount: number
  expectedDetailCount: number
  detailTotal: string | null
  documentTotal: string | null
  detailTotalMatchesDocument: boolean | null
  duplicateDetailKeys: number
  companyIdCorrect: boolean
}

export interface HistoricalCogsBackfillResult {
  companyId: string
  year: number
  universe: HistoricalCogsDocument[]
  skipped: number[]
  observed: number[]
  missing: number[]
  structuralErrors: Array<{ documentId: number; message: string }>
  pendingErrors: Array<{ documentId: number; status: number | null; message: string }>
  reconciliations: HistoricalCogsReconciliation[]
  requests: number
  retries: number
  rateLimits: number
  transientErrors: number
  startedAt: string
  finishedAt: string
}

interface QueryBuilder {
  select(columns: string): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  in(column: string, values: unknown[]): QueryBuilder
  gte(column: string, value: unknown): QueryBuilder
  lt(column: string, value: unknown): QueryBuilder
  order(column: string, options?: { ascending?: boolean }): QueryBuilder
  range(from: number, to: number): Promise<{ data: unknown[] | null; error: { message: string } | null }>
}

interface QueryResult {
  data: unknown[] | null
  error: { message: string } | null
}

interface QueryClient {
  schema(schema: string): {
    from(table: string): QueryBuilder
  }
}

type FetchLike = typeof fetch

function persistenceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) throw new Error('Supabase server credentials are not configured')
  return createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function isEligibleHistoricalCogsDocument(row: Partial<HistoricalCogsDocument>, year: number) {
  if (!ELIGIBLE_DOCUMENT_TYPES.has(Number(row.document_type_id))) return false
  if (Number(row.state) !== 0 || !row.emission_date) return false
  const date = row.emission_date.slice(0, 10)
  return date >= `${year}-01-01` && date < `${year + 1}-01-01`
}

export function isCompletedHistoricalCogsCost(row: Pick<HistoricalCogsExistingCost, 'status'>) {
  return COMPLETED_STATUSES.has(row.status)
}

export function selectPendingHistoricalCogsDocuments(
  documents: HistoricalCogsDocument[],
  existingCosts: HistoricalCogsExistingCost[],
) {
  const completed = new Set(
    existingCosts
      .filter(isCompletedHistoricalCogsCost)
      .map(row => Number(row.bsale_document_id)),
  )
  return documents.filter(document => !completed.has(document.bsale_id))
}

function decimalParts(value: string | number | null): { integer: bigint; scale: number } | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`Invalid non-negative decimal: ${text}`)
  const [whole, fraction = ''] = text.split('.')
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length }
}

export function decimalSum(values: Array<string | number | null>) {
  const parts = values.map(decimalParts).filter((part): part is { integer: bigint; scale: number } => part !== null)
  if (!parts.length) return null
  const scale = Math.max(...parts.map(part => part.scale))
  const total = parts.reduce((sum, part) => sum + part.integer * BigInt(10) ** BigInt(scale - part.scale), BigInt(0))
  const text = total.toString().padStart(scale + 1, '0')
  if (scale === 0) return text
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, '') || '0'
}

export function compareDecimalValues(left: string | number | null, right: string | number | null) {
  const leftSum = decimalSum([left])
  const rightSum = decimalSum([right])
  return leftSum === rightSum
}

export function validateHistoricalCogsPayload(payload: BsaleDocumentCostPayload) {
  const totalCost = payload.totalCost == null ? null : String(payload.totalCost)
  const isObserved = totalCost !== null && !/^0(?:\.0+)?$/.test(totalCost)
  if (!isObserved) return { status: 'MISSING' as const }
  if (!Array.isArray(payload.cost_detail)) {
    throw new Error('OBSERVED payload must include cost_detail[]')
  }
  for (const [index, detail] of payload.cost_detail.entries()) {
    const detailRecord = detail && typeof detail === 'object' ? detail as Record<string, unknown> : null
    const shipping = detailRecord?.shipping_detail
    const shippingId = shipping && typeof shipping === 'object' ? (shipping as Record<string, unknown>).id : null
    if (positiveInteger(shippingId) === null) {
      throw new Error(`cost_detail[${index}] is missing shipping_detail.id`)
    }
  }
  return { status: 'OBSERVED' as const }
}

export async function fetchHistoricalCogsPayload(
  companyId: string,
  documentId: number,
  options: {
    fetchImpl?: FetchLike
    sleep?: (milliseconds: number) => Promise<void>
    delayMs?: number
    maxRetries?: number
    baseBackoffMs?: number
    requestTimeoutMs?: number
    onRequest?: (request: { documentId: number; attempt: number }) => void
  } = {},
) {
  const { baseUrl, accessToken } = getBsaleConfigForCompany(companyId)
  const fetchImpl = options.fetchImpl || fetch
  const sleep = options.sleep || ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const maxRetries = options.maxRetries ?? 3
  const baseBackoffMs = options.baseBackoffMs ?? 1000
  const requestTimeoutMs = options.requestTimeoutMs ?? 30000
  let attempt = 0
  for (;;) {
    options.onRequest?.({ documentId, attempt })
    const url = new URL(`${baseUrl}/documents/costs.json`)
    url.searchParams.set('documentid', String(documentId))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const response = await fetchImpl(url, { headers: { access_token: accessToken, Accept: 'application/json' }, signal: controller.signal })
      clearTimeout(timeout)
      if (response.ok) return { payload: await response.json() as BsaleDocumentCostPayload, status: response.status, retries: attempt, requests: attempt + 1, rateLimited: false, transientErrors: 0 }
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt >= maxRetries) {
        return { payload: null, status: response.status, retries: attempt, requests: attempt + 1, rateLimited: response.status === 429, transientErrors: response.status >= 500 ? attempt + 1 : 0 }
      }
      const retryAfter = Number(response.headers.get('retry-after') || '')
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : baseBackoffMs * 2 ** attempt
      attempt++
      await sleep(waitMs)
    } catch (error) {
      clearTimeout(timeout)
      if (attempt >= maxRetries) return { payload: null, status: null, retries: attempt, requests: attempt + 1, rateLimited: false, transientErrors: attempt + 1, errorMessage: error instanceof Error ? error.message : String(error) }
      attempt++
      await sleep(baseBackoffMs * 2 ** (attempt - 1))
    }
  }
}

async function selectAll<T>(client: QueryClient, table: string, build: (query: QueryBuilder) => QueryBuilder) {
  const rows: T[] = []
  for (let offset = 0;; offset += 1000) {
    const query = build(client.schema('integraciones').from(table))
    const { data, error } = await query.range(offset, offset + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...((data || []) as T[]))
    if (!data || data.length < 1000) return rows
  }
}

export async function selectHistoricalCogsUniverse(client: QueryClient, companyId: string, year: number) {
  const rows = await selectAll<HistoricalCogsDocument>(client, 'bsale_documents', query => query
    .select('bsale_id,document_type_id,number,emission_date,net_amount,total_amount,state')
    .eq('company_id', companyId)
    .eq('state', 0)
    .in('document_type_id', [...ELIGIBLE_DOCUMENT_TYPES])
    .gte('emission_date', `${year}-01-01T00:00:00Z`)
    .lt('emission_date', `${year + 1}-01-01T00:00:00Z`)
    .order('emission_date')
    .order('bsale_id'))
  return rows.filter(row => isEligibleHistoricalCogsDocument(row, year)).map(row => ({
    ...row,
    bsale_id: Number(row.bsale_id),
    document_type_id: Number(row.document_type_id),
    state: Number(row.state),
  }))
}

export async function selectExistingHistoricalCogsCosts(client: QueryClient, companyId: string) {
  return selectAll<HistoricalCogsExistingCost>(client, 'bsale_document_costs', query => query
    .select('bsale_document_id,status,source')
    .eq('company_id', companyId))
}

export async function reconcileHistoricalCogsDocument(client: QueryClient, companyId: string, documentId: number, expectedDetailCount: number, documentTotal: string | number | null): Promise<HistoricalCogsReconciliation> {
  const documentQuery = client.schema('integraciones').from('bsale_document_costs').select('company_id,total_cost').eq('company_id', companyId).eq('bsale_document_id', documentId)
  const { data: documents, error: documentError } = await documentQuery as unknown as QueryResult
  if (documentError) throw new Error(`document cost reconciliation: ${documentError.message}`)
  const detailQuery = client.schema('integraciones').from('bsale_document_cost_details').select('company_id,cost_detail_key,total_cost').eq('company_id', companyId).eq('bsale_document_id', documentId)
  const { data: details, error: detailError } = await detailQuery as unknown as QueryResult
  if (detailError) throw new Error(`document cost detail reconciliation: ${detailError.message}`)
  const persistedDetails = (details || []) as Array<{ company_id: string; cost_detail_key: string; total_cost: string | number | null }>
  const persistedDocuments = (documents || []) as Array<{ company_id: string; total_cost: string | number | null }>
  const keys = persistedDetails.map(detail => detail.cost_detail_key)
  const detailTotal = decimalSum(persistedDetails.map(detail => detail.total_cost))
  return {
    documentId,
    detailCount: details?.length || 0,
    expectedDetailCount,
    detailTotal,
    documentTotal: documentTotal == null ? null : String(documentTotal),
    detailTotalMatchesDocument: documentTotal == null ? null : compareDecimalValues(detailTotal, documentTotal),
    duplicateDetailKeys: keys.length - new Set(keys).size,
    companyIdCorrect: persistedDocuments.every(row => row.company_id === companyId) && persistedDetails.every(row => row.company_id === companyId),
  }
}

export async function reconcileHistoricalCogsDocuments(client: QueryClient, companyId: string, expected: Array<{ documentId: number; detailCount: number; documentTotal: string | number | null }>) {
  if (!expected.length) return []
  const ids = expected.map(item => item.documentId)
  const documentQuery = client.schema('integraciones').from('bsale_document_costs').select('company_id,bsale_document_id,total_cost').eq('company_id', companyId).in('bsale_document_id', ids)
  const { data: documents, error: documentError } = await documentQuery as unknown as QueryResult
  if (documentError) throw new Error(`document cost batch reconciliation: ${documentError.message}`)
  const detailQuery = client.schema('integraciones').from('bsale_document_cost_details').select('company_id,bsale_document_id,cost_detail_key,total_cost').eq('company_id', companyId).in('bsale_document_id', ids)
  const { data: details, error: detailError } = await detailQuery as unknown as QueryResult
  if (detailError) throw new Error(`document cost detail batch reconciliation: ${detailError.message}`)
  const documentRows = documents as Array<{ company_id: string; bsale_document_id: number; total_cost: string | number | null }>
  const detailRows = details as Array<{ company_id: string; bsale_document_id: number; cost_detail_key: string; total_cost: string | number | null }>
  return expected.map(item => {
    const matchingDocuments = documentRows.filter(row => Number(row.bsale_document_id) === item.documentId)
    const matchingDetails = detailRows.filter(row => Number(row.bsale_document_id) === item.documentId)
    const keys = matchingDetails.map(row => row.cost_detail_key)
    const document = matchingDocuments[0]
    return {
      documentId: item.documentId,
      detailCount: matchingDetails.length,
      expectedDetailCount: item.detailCount,
      detailTotal: decimalSum(matchingDetails.map(row => row.total_cost)),
      documentTotal: item.documentTotal == null ? null : String(item.documentTotal),
      detailTotalMatchesDocument: item.documentTotal == null ? null : compareDecimalValues(decimalSum(matchingDetails.map(row => row.total_cost)), item.documentTotal),
      duplicateDetailKeys: keys.length - new Set(keys).size,
      companyIdCorrect: matchingDocuments.every(row => row.company_id === companyId) && matchingDetails.every(row => row.company_id === companyId),
      documentRowCount: matchingDocuments.length,
      persistedDocumentTotal: document?.total_cost ?? null,
    }
  })
}

export async function runHistoricalCogsBackfill(options: {
  companyId: string
  year: number
  batchSize?: number
  delayMs?: number
  maxRetries?: number
  maxDocuments?: number
  baseBackoffMs?: number
  requestTimeoutMs?: number
  client?: QueryClient
  fetchImpl?: FetchLike
  sleep?: (milliseconds: number) => Promise<void>
  onBatch?: (summary: { batch: number; processed: number; pending: number; observed: number; missing: number; errors: number }) => void
}): Promise<HistoricalCogsBackfillResult> {
  const client = (options.client || persistenceClient()) as QueryClient
  const batchSize = options.batchSize ?? 50
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer')
  const startedAt = new Date().toISOString()
  const universe = await selectHistoricalCogsUniverse(client, options.companyId, options.year)
  const existingCosts = await selectExistingHistoricalCogsCosts(client, options.companyId)
  const pending = selectPendingHistoricalCogsDocuments(universe, existingCosts).slice(0, options.maxDocuments)
  const existingCompleted = new Set(selectPendingHistoricalCogsDocuments(universe, []).map(document => document.bsale_id).filter(id => !pending.some(document => document.bsale_id === id)))
  const result: HistoricalCogsBackfillResult = { companyId: options.companyId, year: options.year, universe, skipped: [...existingCompleted], observed: [], missing: [], structuralErrors: [], pendingErrors: [], reconciliations: [], requests: 0, retries: 0, rateLimits: 0, transientErrors: 0, startedAt, finishedAt: startedAt }
  for (let offset = 0, batch = 1; offset < pending.length; offset += batchSize, batch++) {
    const currentBatch = pending.slice(offset, offset + batchSize)
    const batchExpectations: Array<{ documentId: number; detailCount: number; documentTotal: string | number | null }> = []
    for (const document of currentBatch) {
      if (options.delayMs && (result.requests > 0 || offset > 0)) await (options.sleep || ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))))(options.delayMs)
      let fetched: Awaited<ReturnType<typeof fetchHistoricalCogsPayload>>
      try {
        fetched = await fetchHistoricalCogsPayload(options.companyId, document.bsale_id, { fetchImpl: options.fetchImpl, sleep: options.sleep, maxRetries: options.maxRetries, baseBackoffMs: options.baseBackoffMs, requestTimeoutMs: options.requestTimeoutMs })
      } catch (error) {
        result.pendingErrors.push({ documentId: document.bsale_id, status: null, message: error instanceof Error ? error.message : String(error) })
        continue
      }
      result.requests += fetched.requests
      result.retries += fetched.retries
      if (fetched.rateLimited) result.rateLimits++
      result.transientErrors += fetched.transientErrors
      if (!fetched.payload) {
        result.pendingErrors.push({ documentId: document.bsale_id, status: fetched.status, message: fetched.errorMessage || 'BSale cost endpoint did not return a successful payload' })
        continue
      }
      try {
        const validation = validateHistoricalCogsPayload(fetched.payload)
        const mapped = mapDocumentCostPayload(options.companyId, fetched.payload, { status: validation.status, source: 'BSALE_DOCUMENT_COSTS' })
        await upsertDocumentCost(options.companyId, mapped.record, client as unknown as SupabaseClient)
        await upsertDocumentCostDetails(options.companyId, mapped.details, client as unknown as SupabaseClient)
        batchExpectations.push({ documentId: document.bsale_id, detailCount: mapped.details.length, documentTotal: mapped.record.total_cost })
        if (validation.status === 'OBSERVED') result.observed.push(document.bsale_id)
        else result.missing.push(document.bsale_id)
      } catch (error) {
        result.structuralErrors.push({ documentId: document.bsale_id, message: error instanceof Error ? error.message : String(error) })
      }
    }
    result.reconciliations.push(...await reconcileHistoricalCogsDocuments(client, options.companyId, batchExpectations))
    options.onBatch?.({ batch, processed: Math.min(offset + batchSize, pending.length), pending: result.pendingErrors.length, observed: result.observed.length, missing: result.missing.length, errors: result.structuralErrors.length })
  }
  result.finishedAt = new Date().toISOString()
  return result
}
