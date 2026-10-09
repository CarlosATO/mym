import type { SupabaseClient } from '@supabase/supabase-js'
// @ts-expect-error Standalone Node test runner needs explicit TypeScript extensions.
import { getBsaleConfigForCompany } from '../bsale/company-config.ts'
import {
  mapCreditNoteReturnDetailPayload,
  mapCreditNoteReturnPayload,
  upsertCreditNoteReturn,
  upsertCreditNoteReturnDetails,
// @ts-expect-error Standalone Node test runner needs explicit TypeScript extensions.
} from './bsale-historical-cogs.ts'
import {
  resolveCreditNoteCogs,
  upsertCreditNoteCogsResolution,
  type CreditNoteCogsResolutionStatus,
// @ts-expect-error Standalone Node test runner needs explicit TypeScript extensions.
} from './bsale-credit-note-cogs.ts'

type QueryBuilder = {
  select(columns: string): QueryBuilder
  eq(column: string, value: unknown): QueryBuilder
  in(column: string, values: unknown[]): QueryBuilder
  gte(column: string, value: unknown): QueryBuilder
  lt(column: string, value: unknown): QueryBuilder
  order(column: string): QueryBuilder
  range(from: number, to: number): Promise<{ data: unknown[] | null; error: { message: string } | null }>
}

type QueryClient = { schema(schema: string): { from(table: string): QueryBuilder } }

type CreditNoteDocument = { bsale_id: number; emission_date: string; state: number; total_amount: string | number | null }
type ExistingResolution = { bsale_credit_note_id: number; resolution_status: CreditNoteCogsResolutionStatus }

const RESOLVED = new Set<CreditNoteCogsResolutionStatus>([
  'RESOLVED_PHYSICAL_RETURN',
  'RESOLVED_PRICE_ADJUSTMENT',
  'RESOLVED_NO_STOCK_REENTRY',
  'RESOLVED_MIXED',
])

export type CreditNoteCogsSyncResult = {
  eligibleCreditNotes: number
  resolvedCreditNotes: number
  pendingCreditNotes: number
  pendingRecentCreditNotes: number
  ambiguousCreditNotes: number
  selectedCreditNoteIds: number[]
  requests: number
  retries: number
  errors: number
  dryRun: boolean
}

export type CreditNoteCogsSyncOptions = {
  companyId: string
  year: number
  client: QueryClient
  persistenceClient?: SupabaseClient
  now?: Date
  recentDays?: number
  catchUpLimit?: number
  maxRetries?: number
  baseBackoffMs?: number
  requestTimeoutMs?: number
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  dryRun?: boolean
}

function items(payload: any): any[] {
  return Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : []
}

function cutoffDate(now: Date, days: number) {
  const value = new Date(now)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

async function selectAll<T>(client: QueryClient, table: string, select: string, build: (query: QueryBuilder) => QueryBuilder = query => query) {
  const rows: T[] = []
  for (let offset = 0;; offset += 1000) {
    const result = await build(client.schema('integraciones').from(table).select(select)).range(offset, offset + 999)
    if (result.error) throw new Error(`${table}: ${result.error.message}`)
    rows.push(...(result.data || []) as T[])
    if (!result.data || result.data.length < 1000) return rows
  }
}

async function fetchJson(
  companyId: string,
  path: string,
  options: Pick<CreditNoteCogsSyncOptions, 'fetchImpl' | 'sleep' | 'maxRetries' | 'baseBackoffMs' | 'requestTimeoutMs'> & { allow404?: boolean },
  metrics: { requests: number; retries: number },
) {
  const { baseUrl, accessToken } = getBsaleConfigForCompany(companyId)
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const maxRetries = options.maxRetries ?? 3
  let attempt = 0
  for (;;) {
    metrics.requests++
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 30000)
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { headers: { access_token: accessToken, Accept: 'application/json' }, signal: controller.signal })
      clearTimeout(timeout)
      if (response.status === 404 && options.allow404) return { items: [] }
      if (response.ok) return await response.json()
      if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status} at ${path}`)
      if (attempt >= maxRetries) throw new Error(`HTTP ${response.status} at ${path}`)
      const retryAfter = Number(response.headers.get('retry-after') || '')
      const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : (options.baseBackoffMs ?? 500) * 2 ** attempt
      attempt++
      metrics.retries++
      await sleep(wait)
    } catch (error) {
      clearTimeout(timeout)
      if (error instanceof Error && /^HTTP \d+/.test(error.message)) throw error
      if (attempt >= maxRetries) throw error
      attempt++
      metrics.retries++
      await sleep((options.baseBackoffMs ?? 500) * 2 ** (attempt - 1))
    }
  }
}

export function selectIncrementalCreditNotes(
  documents: CreditNoteDocument[],
  resolutions: ExistingResolution[],
  options: { now?: Date; recentDays?: number; catchUpLimit?: number } = {},
) {
  const cutoff = cutoffDate(options.now ?? new Date(), options.recentDays ?? 30)
  const byId = new Map(resolutions.map(row => [Number(row.bsale_credit_note_id), row]))
  const recent: CreditNoteDocument[] = []
  const historical: CreditNoteDocument[] = []
  for (const document of documents) {
    const resolution = byId.get(document.bsale_id)
    if (resolution && RESOLVED.has(resolution.resolution_status)) continue
    if (document.emission_date.slice(0, 10) >= cutoff) recent.push(document)
    else historical.push(document)
  }
  return { recent, historical: historical.slice(0, options.catchUpLimit ?? 100), cutoff }
}

export async function syncRecentCreditNoteCogs(options: CreditNoteCogsSyncOptions): Promise<CreditNoteCogsSyncResult> {
  const documents = (await selectAll<CreditNoteDocument>(options.client, 'bsale_documents', 'bsale_id,emission_date,state,total_amount', query => query
    .eq('company_id', options.companyId).eq('document_type_id', 2).eq('state', 0)
    .gte('emission_date', `${options.year}-01-01T00:00:00Z`).lt('emission_date', `${options.year + 1}-01-01T00:00:00Z`)
    .order('emission_date'))) .filter(row => Number(row.total_amount ?? 0) !== 0).map(row => ({ ...row, bsale_id: Number(row.bsale_id), state: Number(row.state) }))
  const resolutions = await selectAll<ExistingResolution>(options.client, 'bsale_credit_note_cogs_resolutions', 'bsale_credit_note_id,resolution_status', query => query.eq('company_id', options.companyId))
  const selection = selectIncrementalCreditNotes(documents, resolutions, options)
  const selected = [...selection.recent, ...selection.historical]
  const metrics = { requests: 0, retries: 0, errors: 0 }
  let resolvedCreditNotes = 0
  let pendingCreditNotes = 0
  let pendingRecentCreditNotes = 0
  let ambiguousCreditNotes = 0
  const selectedCreditNoteIds = selected.map(row => row.bsale_id)
  const recentIds = new Set(selection.recent.map(row => row.bsale_id))
  const existingReturns = await selectAll<any>(options.client, 'bsale_credit_note_returns', '*', query => query.eq('company_id', options.companyId))
  const existingDetails = await selectAll<any>(options.client, 'bsale_credit_note_return_details', '*', query => query.eq('company_id', options.companyId))
  const originalDetails = await selectAll<any>(options.client, 'bsale_document_details', 'bsale_id,company_id', query => query.eq('company_id', options.companyId))
  const resolvableDocumentDetailIds = new Set(originalDetails.map(row => Number(row.bsale_id)))
  const returnsByNote = new Map<number, any[]>()
  for (const row of existingReturns) {
    const noteId = Number(row.bsale_credit_note_id)
    if (!returnsByNote.has(noteId)) returnsByNote.set(noteId, [])
    returnsByNote.get(noteId)!.push(row)
  }
  const detailsByReturnId = new Map<number, any[]>()
  for (const row of existingDetails) {
    const returnId = Number(row.bsale_return_id)
    if (!detailsByReturnId.has(returnId)) detailsByReturnId.set(returnId, [])
    detailsByReturnId.get(returnId)!.push(row)
  }

  for (const document of selected) {
    try {
      let noteReturns = returnsByNote.get(document.bsale_id) ?? []
      if (!noteReturns.length || noteReturns.some(row => !(detailsByReturnId.get(Number(row.bsale_return_id)) || []).length)) {
        const payload = await fetchJson(options.companyId, `/returns.json?creditnoteid=${document.bsale_id}&limit=50`, options, metrics)
        noteReturns = []
        for (const returnPayload of items(payload)) {
          const mappedReturn = mapCreditNoteReturnPayload(options.companyId, returnPayload, { creditNoteId: document.bsale_id })
          const details = items(await fetchJson(options.companyId, `/returns/${mappedReturn.bsale_return_id}/details.json?limit=100`, { ...options, allow404: true }, metrics))
            .map(detail => mapCreditNoteReturnDetailPayload(options.companyId, mappedReturn.bsale_return_id, detail))
          noteReturns.push(mappedReturn)
          detailsByReturnId.set(mappedReturn.bsale_return_id, details)
          if (!options.dryRun) {
            if (!options.persistenceClient) throw new Error('persistenceClient is required unless dryRun is enabled')
            await upsertCreditNoteReturn(options.companyId, mappedReturn, options.persistenceClient)
            if (details.length) await upsertCreditNoteReturnDetails(options.companyId, details, options.persistenceClient)
          }
        }
        returnsByNote.set(document.bsale_id, noteReturns)
      }
      const resolution = resolveCreditNoteCogs({
        creditNoteId: document.bsale_id,
        returns: noteReturns.map(row => ({
          bsale_credit_note_id: document.bsale_id,
          bsale_return_id: Number(row.bsale_return_id),
          referenced_document_id: row.referenced_document_id == null ? null : Number(row.referenced_document_id),
          price_adjustment: row.price_adjustment,
        })),
        detailsByReturnId: new Map(noteReturns.map(row => [Number(row.bsale_return_id), (detailsByReturnId.get(Number(row.bsale_return_id)) ?? []).map(detail => ({
          bsale_return_id: Number(detail.bsale_return_id),
          bsale_return_detail_id: Number(detail.bsale_return_detail_id),
          bsale_document_detail_id: detail.bsale_document_detail_id == null ? null : Number(detail.bsale_document_detail_id),
          quantity: detail.quantity,
          quantity_dev_stock: detail.quantity_dev_stock,
          variant_cost: detail.variant_cost,
        }))])),
        resolvableDocumentDetailIds,
      })
      if (!options.dryRun) {
        if (!options.persistenceClient) throw new Error('persistenceClient is required unless dryRun is enabled')
        await upsertCreditNoteCogsResolution(options.companyId, resolution, options.persistenceClient)
      }
      if (RESOLVED.has(resolution.resolution_status)) resolvedCreditNotes++
      else {
        pendingCreditNotes++
        if (recentIds.has(document.bsale_id)) pendingRecentCreditNotes++
        if (resolution.resolution_status === 'AMBIGUOUS') ambiguousCreditNotes++
      }
    } catch {
      metrics.errors++
    }
  }

  return {
    eligibleCreditNotes: documents.length,
    resolvedCreditNotes,
    pendingCreditNotes,
    pendingRecentCreditNotes,
    ambiguousCreditNotes,
    selectedCreditNoteIds,
    ...metrics,
    dryRun: options.dryRun === true,
  }
}
