import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchHistoricalCogsPayload,
  isCompletedHistoricalCogsCost,
  selectExistingHistoricalCogsCosts,
  selectHistoricalCogsUniverse,
  validateHistoricalCogsPayload,
// @ts-expect-error Standalone Node test runner needs explicit TypeScript extensions.
} from './bsale-historical-cogs-backfill.ts'
// @ts-expect-error Standalone Node test runner needs explicit TypeScript extensions.
import { mapDocumentCostPayload, upsertDocumentCost, upsertDocumentCostDetails } from './bsale-historical-cogs.ts'

type QueryClient = Parameters<typeof selectHistoricalCogsUniverse>[0]

export type DocumentCogsSyncMetrics = {
  eligibleRecent: number
  observedRecent: number
  missingRecent: number
  noCostRowRecent: number
  errorsRecent: number
  historicalCatchUpSelected: number
  observed: number
  missing: number
  errors: number
  requests: number
  retries: number
  rateLimits: number
  transientErrors: number
  dryRun: boolean
}

export type DocumentCogsSyncOptions = {
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
  delayMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  fetchImpl?: typeof fetch
  dryRun?: boolean
  batchSize?: number
  onBatch?: (summary: { batch: number; documentIds: number[]; metrics: DocumentCogsSyncMetrics }) => Promise<void> | void
}

export type DocumentCogsSyncResult = DocumentCogsSyncMetrics & {
  selectedDocumentIds: number[]
  missingDocumentIds: number[]
  errorDocumentIds: number[]
}

function daysAgo(now: Date, days: number) {
  const cutoff = new Date(now)
  cutoff.setUTCDate(cutoff.getUTCDate() - days)
  return cutoff.toISOString().slice(0, 10)
}

export function selectIncrementalDocumentCogsDocuments(
  documents: Awaited<ReturnType<typeof selectHistoricalCogsUniverse>>,
  existingCosts: Awaited<ReturnType<typeof selectExistingHistoricalCogsCosts>>,
  options: { now?: Date; recentDays?: number; catchUpLimit?: number } = {},
) {
  const cutoff = daysAgo(options.now ?? new Date(), options.recentDays ?? 30)
  const existingByDocument = new Map(existingCosts.map(row => [Number(row.bsale_document_id), row]))
  const recent: typeof documents = []
  const historical: typeof documents = []

  for (const document of documents) {
    const existing = existingByDocument.get(document.bsale_id)
    if (existing && isCompletedHistoricalCogsCost(existing)) continue
    if (document.emission_date.slice(0, 10) >= cutoff) recent.push(document)
    else historical.push(document)
  }

  return {
    recent,
    historical: historical.slice(0, options.catchUpLimit ?? 100),
    existingByDocument,
    cutoff,
  }
}

export async function syncRecentDocumentCogs(options: DocumentCogsSyncOptions): Promise<DocumentCogsSyncResult> {
  const universe = await selectHistoricalCogsUniverse(options.client, options.companyId, options.year)
  const existingCosts = await selectExistingHistoricalCogsCosts(options.client, options.companyId)
  const selection = selectIncrementalDocumentCogsDocuments(universe, existingCosts, options)
  const selected = [...selection.recent, ...selection.historical]
  const recentIds = new Set(selection.recent.map(document => document.bsale_id))
  const noCostRowRecent = selection.recent.filter(document => !selection.existingByDocument.has(document.bsale_id)).length
  const recentUniverse = universe.filter(document => document.emission_date.slice(0, 10) >= selection.cutoff)
  const recentMissing = recentUniverse.filter(document => selection.existingByDocument.get(document.bsale_id)?.status !== 'OBSERVED').length
  const metrics: DocumentCogsSyncMetrics = {
    eligibleRecent: universe.filter(document => document.emission_date.slice(0, 10) >= selection.cutoff).length,
    observedRecent: recentUniverse.filter(document => selection.existingByDocument.get(document.bsale_id)?.status === 'OBSERVED').length,
    missingRecent: recentMissing,
    noCostRowRecent,
    errorsRecent: 0,
    historicalCatchUpSelected: selection.historical.length,
    observed: 0,
    missing: 0,
    errors: 0,
    requests: 0,
    retries: 0,
    rateLimits: 0,
    transientErrors: 0,
    dryRun: options.dryRun === true,
  }
  const missingDocumentIds: number[] = []
  const errorDocumentIds: number[] = []

  const batchSize = Math.max(1, (options.batchSize ?? selected.length) || 1)
  for (let batchStart = 0, batch = 1; batchStart < selected.length; batchStart += batchSize, batch++) {
    const currentBatch = selected.slice(batchStart, batchStart + batchSize)
    for (const [index, document] of currentBatch.entries()) {
      if (options.delayMs && (batchStart + index) > 0) await (options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(options.delayMs)
      const fetched = await fetchHistoricalCogsPayload(options.companyId, document.bsale_id, {
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      maxRetries: options.maxRetries,
      baseBackoffMs: options.baseBackoffMs,
      requestTimeoutMs: options.requestTimeoutMs,
      })
      metrics.requests += fetched.requests
      metrics.retries += fetched.retries
      metrics.rateLimits += fetched.rateLimited ? 1 : 0
      metrics.transientErrors += fetched.transientErrors
      if (!fetched.payload) {
        metrics.errors++
        if (recentIds.has(document.bsale_id)) metrics.errorsRecent++
        errorDocumentIds.push(document.bsale_id)
        continue
      }
      try {
        const validation = validateHistoricalCogsPayload(fetched.payload)
        const mapped = mapDocumentCostPayload(options.companyId, fetched.payload, { status: validation.status, source: 'BSALE_DOCUMENT_COSTS' })
        if (!options.dryRun) {
          if (!options.persistenceClient) throw new Error('persistenceClient is required unless dryRun is enabled')
          await upsertDocumentCost(options.companyId, mapped.record, options.persistenceClient)
          await upsertDocumentCostDetails(options.companyId, mapped.details, options.persistenceClient)
        }
        if (validation.status === 'OBSERVED') metrics.observed++
        else {
          metrics.missing++
          missingDocumentIds.push(document.bsale_id)
        }
      } catch {
        metrics.errors++
        if (recentIds.has(document.bsale_id)) metrics.errorsRecent++
        errorDocumentIds.push(document.bsale_id)
      }
    }
    await options.onBatch?.({ batch, documentIds: currentBatch.map(document => document.bsale_id), metrics: { ...metrics } })
  }

  return { ...metrics, selectedDocumentIds: selected.map(document => document.bsale_id), missingDocumentIds, errorDocumentIds }
}
