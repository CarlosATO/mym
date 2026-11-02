import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const cache = await readFile(new URL('src/lib/adquisiciones/pending-purchase-orders-report-cache.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')

test('pending report cache is scoped, short-lived and deduplicates requests', () => {
  assert.match(cache, /PENDING_PURCHASE_ORDERS_REPORT_CACHE_TTL = 30_000/)
  assert.match(cache, /return `\$\{userId\}:\$\{companyId\}`/)
  assert.match(cache, /const cache = new Map/)
  assert.match(cache, /const requests = new Map/)
  assert.match(cache, /const pending = requests\.get\(key\)/)
  assert.match(cache, /if \(pending\) return pending/)
  assert.match(cache, /fetchedAt: Date\.now\(\)/)
})

test('empty results are cached, errors are retryable and invalidation discards stale responses', () => {
  assert.match(cache, /cache\.set\(key, \{ result, fetchedAt: Date\.now\(\) \}\)/)
  assert.match(cache, /!\('error' in result\)/)
  assert.match(cache, /generations\.get\(key\) \?\? 0\) === generation/)
  assert.match(cache, /invalidatePendingPurchaseOrdersReportCache/)
  assert.match(cache, /generations\.set\(key, \(generations\.get\(key\) \?\? 0\) \+ 1\)/)
  assert.match(panel, /clearPendingPurchaseOrdersReportCache\(\)/)
  assert.match(panel, /discardPendingPurchaseOrdersReportRequest\(currentUserId, activeCompany\.id\)/)
  assert.match(panel, /invalidatePendingPurchaseOrdersReportCache\(currentUserId, activeCompany\.id\)/)
})

test('precaching is deferred until the initial list has loaded and the download reuses it', () => {
  assert.match(panel, /initialLoading\) return/)
  assert.match(panel, /setTimeout\(\(\) => \{\n\s+void fetchCachedPendingPurchaseOrdersReport\(\)/)
  assert.match(panel, /const report = await fetchCachedPendingPurchaseOrdersReport\(\)/)
  assert.doesNotMatch(panel, /getPendingPurchaseOrdersReport\(\)/)
})
