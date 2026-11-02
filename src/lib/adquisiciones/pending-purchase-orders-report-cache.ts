import { getPendingPurchaseOrdersReport, type PendingPurchaseOrdersReport } from '@/app/actions/adquisiciones/purchase-orders'

export const PENDING_PURCHASE_ORDERS_REPORT_CACHE_TTL = 30_000

type PendingReportResult = Awaited<ReturnType<typeof getPendingPurchaseOrdersReport>>
type PendingReportCacheEntry = { result: PendingReportResult; fetchedAt: number }

const cache = new Map<string, PendingReportCacheEntry>()
const requests = new Map<string, Promise<PendingReportResult>>()
const generations = new Map<string, number>()

export function pendingPurchaseOrdersReportCacheKey(userId: string, companyId: string): string {
  return `${userId}:${companyId}`
}

export function getCachedPendingPurchaseOrdersReport(
  userId: string,
  companyId: string,
  options: { force?: boolean } = {},
): Promise<PendingReportResult> {
  const key = pendingPurchaseOrdersReportCacheKey(userId, companyId)
  const now = Date.now()
  const cached = cache.get(key)
  if (!options.force && cached && now - cached.fetchedAt < PENDING_PURCHASE_ORDERS_REPORT_CACHE_TTL) {
    return Promise.resolve(cached.result)
  }

  const pending = requests.get(key)
  if (pending) return pending

  const generation = generations.get(key) ?? 0
  const request = getPendingPurchaseOrdersReport()
    .then(result => {
      if (!('error' in result) && (generations.get(key) ?? 0) === generation) {
        cache.set(key, { result, fetchedAt: Date.now() })
      }
      return result
    })
  const trackedRequest = request.finally(() => {
    if (requests.get(key) === trackedRequest) requests.delete(key)
  })
  requests.set(key, trackedRequest)
  return trackedRequest
}

export function invalidatePendingPurchaseOrdersReportCache(userId: string, companyId: string): void {
  const key = pendingPurchaseOrdersReportCacheKey(userId, companyId)
  generations.set(key, (generations.get(key) ?? 0) + 1)
  cache.delete(key)
  requests.delete(key)
}

export function discardPendingPurchaseOrdersReportRequest(userId: string, companyId: string): void {
  const key = pendingPurchaseOrdersReportCacheKey(userId, companyId)
  generations.set(key, (generations.get(key) ?? 0) + 1)
  requests.delete(key)
}

export function clearPendingPurchaseOrdersReportCache(): void {
  const keys = new Set([...cache.keys(), ...requests.keys()])
  for (const key of keys) generations.set(key, (generations.get(key) ?? 0) + 1)
  cache.clear()
  requests.clear()
}

export function getPendingPurchaseOrdersReportCacheSnapshot(): { keys: string[]; cachedEntries: number; inFlightEntries: number } {
  return { keys: Array.from(cache.keys()), cachedEntries: cache.size, inFlightEntries: requests.size }
}

export type { PendingPurchaseOrdersReport }
