import type { InvoiceReviewSnapshot } from './invoice-flow-ui'

export const INVOICE_PREVIEW_TTL_MS = 45_000

export type InvoicePreviewStatus = 'READY' | 'LOADING' | 'ERROR' | 'STALE'

export type InvoicePreviewCacheEntry = {
  current_bsale_nv_id: number
  snapshot: InvoiceReviewSnapshot | null
  status: InvoicePreviewStatus
  error: string | null
  updatedAt: number
}

export type InvoicePreviewCache = Map<string, InvoicePreviewCacheEntry>

export function createInvoicePreviewCache(): InvoicePreviewCache {
  return new Map()
}

export function getInvoicePreviewCacheKey(cardId: string, currentBsaleNvId: number): string {
  return `${cardId}:${currentBsaleNvId}`
}

export function isInvoicePreviewFresh(entry: InvoicePreviewCacheEntry | undefined, now = Date.now()): boolean {
  return entry?.status === 'READY' && now - entry.updatedAt < INVOICE_PREVIEW_TTL_MS
}

export function invalidateInvoicePreview(cache: InvoicePreviewCache, cardId: string, currentBsaleNvId?: number): void {
  for (const [key, entry] of cache) {
    if (key.startsWith(`${cardId}:`) && (currentBsaleNvId == null || entry.current_bsale_nv_id === currentBsaleNvId)) {
      cache.delete(key)
    }
  }
}
