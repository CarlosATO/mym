import type { InvoiceDocumentPreview } from './invoice-flow-ui'

export const INVOICE_DOCUMENT_TTL_MS = 45_000

export type InvoiceDocumentCacheEntry = {
  current_bsale_nv_id: number
  documents: InvoiceDocumentPreview[]
  status: 'READY' | 'LOADING' | 'ERROR' | 'STALE'
  error: string | null
  updatedAt: number
}

export type InvoiceDocumentCache = Map<string, InvoiceDocumentCacheEntry>

export function createInvoiceDocumentCache(): InvoiceDocumentCache {
  return new Map()
}

export function getInvoiceDocumentCacheKey(cardId: string, currentBsaleNvId: number): string {
  return `${cardId}:${currentBsaleNvId}`
}

export function isInvoiceDocumentFresh(entry: InvoiceDocumentCacheEntry | undefined, now = Date.now()): boolean {
  return entry?.status === 'READY' && now - entry.updatedAt < INVOICE_DOCUMENT_TTL_MS
}

export function invalidateInvoiceDocuments(cache: InvoiceDocumentCache, cardId: string, currentBsaleNvId?: number): void {
  for (const [key, entry] of cache) {
    if (key.startsWith(`${cardId}:`) && (currentBsaleNvId == null || entry.current_bsale_nv_id === currentBsaleNvId)) {
      cache.delete(key)
    }
  }
}
