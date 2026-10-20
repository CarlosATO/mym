import type { SalesOrderAuditDetail } from '@/app/actions/logistica/sales-order-audit'

type AuditCacheEntry = {
  detail: SalesOrderAuditDetail
  cachedAt: number
}

const cache = new Map<string, AuditCacheEntry>()

export function getAuditCache(cardId: string): SalesOrderAuditDetail | null {
  return cache.get(cardId)?.detail ?? null
}

export function setAuditCache(cardId: string, detail: SalesOrderAuditDetail): void {
  cache.set(cardId, { detail, cachedAt: Date.now() })
}

export function patchAuditCache(
  cardId: string,
  updater: (current: SalesOrderAuditDetail) => SalesOrderAuditDetail,
): SalesOrderAuditDetail | null {
  const current = cache.get(cardId)
  if (!current) return null
  const next = updater(current.detail)
  cache.set(cardId, { detail: next, cachedAt: Date.now() })
  return next
}

export function invalidateAuditCache(cardId: string): void {
  cache.delete(cardId)
}
