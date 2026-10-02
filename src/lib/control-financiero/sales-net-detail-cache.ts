import type { FinanceSalesNetDetailResponse } from './finance-api'

export type SalesNetDetailCacheKey = {
  companyId: string
  year: number
  providerKey: string | null
  familyKey: string | null
  scope: 'MONTH' | 'YTD'
  month: number | null
  page: number
  pageSize: number
}

export type SalesNetDetailLoader = () => Promise<FinanceSalesNetDetailResponse>

export function salesNetDetailCacheKey(key: SalesNetDetailCacheKey) {
  return [
    key.companyId,
    key.year,
    key.providerKey ?? '-',
    key.familyKey ?? '-',
    key.scope,
    key.month ?? 'ytd',
    key.page,
    key.pageSize,
  ].join('|')
}

export class SalesNetDetailCache {
  private readonly values = new Map<string, FinanceSalesNetDetailResponse>()
  private readonly pending = new Map<string, Promise<FinanceSalesNetDetailResponse>>()

  get(key: SalesNetDetailCacheKey) {
    return this.values.get(salesNetDetailCacheKey(key))
  }

  load(key: SalesNetDetailCacheKey, loader: SalesNetDetailLoader) {
    const serializedKey = salesNetDetailCacheKey(key)
    const cached = this.values.get(serializedKey)
    if (cached) return Promise.resolve(cached)

    const inFlight = this.pending.get(serializedKey)
    if (inFlight) return inFlight

    const request = loader()
      .then(response => {
        this.values.set(serializedKey, response)
        this.pending.delete(serializedKey)
        return response
      })
      .catch(error => {
        this.pending.delete(serializedKey)
        throw error
      })

    this.pending.set(serializedKey, request)
    return request
  }

  clear() {
    this.values.clear()
    this.pending.clear()
  }
}
