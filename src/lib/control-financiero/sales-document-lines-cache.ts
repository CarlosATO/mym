import type { FinanceSalesDocumentLinesResponse } from './finance-api'

export type SalesDocumentLinesCacheKey = {
  companyId: string
  year: number
  documentId: number
  providerKey: string | null
  familyKey: string | null
}

function serialize(key: SalesDocumentLinesCacheKey) {
  return [key.companyId, key.year, key.documentId, key.providerKey ?? '-', key.familyKey ?? '-'].join('|')
}

export class SalesDocumentLinesCache {
  private readonly values = new Map<string, FinanceSalesDocumentLinesResponse>()
  private readonly pending = new Map<string, Promise<FinanceSalesDocumentLinesResponse>>()

  get(key: SalesDocumentLinesCacheKey) {
    return this.values.get(serialize(key))
  }

  load(key: SalesDocumentLinesCacheKey, loader: () => Promise<FinanceSalesDocumentLinesResponse>) {
    const cacheKey = serialize(key)
    const cached = this.values.get(cacheKey)
    if (cached) return Promise.resolve(cached)
    const inFlight = this.pending.get(cacheKey)
    if (inFlight) return inFlight

    const request = loader().then(response => {
      this.values.set(cacheKey, response)
      this.pending.delete(cacheKey)
      return response
    }).catch(error => {
      this.pending.delete(cacheKey)
      throw error
    })
    this.pending.set(cacheKey, request)
    return request
  }

  clear() {
    this.values.clear()
    this.pending.clear()
  }
}
