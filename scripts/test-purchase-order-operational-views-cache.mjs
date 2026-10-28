import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')

test('list cache is scoped by user, company, filters, view and page with a finite TTL', () => {
  assert.match(panel, /const PURCHASE_ORDER_LIST_CACHE_TTL = 30_000/)
  assert.match(panel, /const purchaseOrderCacheGenerationRef = useRef\(0\)/)
  assert.match(panel, /const purchaseOrderCacheScope = `\$\{currentUserId \?\? 'anonymous'\}:\$\{activeCompany\?\.id \?\? 'unknown'\}`/)
  assert.match(panel, /operational_view: filters\.operational_view \?\? 'PENDING'/)
  assert.match(panel, /page: filters\.page \?\? 1/)
  assert.match(panel, /pageSize: filters\.pageSize \?\? 50/)
  assert.match(panel, /Date\.now\(\) - cached\.updatedAt < PURCHASE_ORDER_LIST_CACHE_TTL/)
})

test('secondary views are prefetched only for the current filter and page combination', () => {
  assert.match(panel, /const secondaryViews = PURCHASE_ORDER_OPERATIONAL_VIEWS\.filter\(view => view\.value !== baseFilters\.operational_view\)/)
  assert.match(panel, /operational_view: view\.value/)
  assert.match(panel, /void Promise\.all\(secondaryViews\.map\(async view => \{/)
  assert.match(panel, /page: filters\.page \?\? 1/)
})

test('cache hits avoid queries while force refresh and mutations invalidate list data', () => {
  assert.match(panel, /if \(!force && cached && Date\.now\(\) - cached\.updatedAt < PURCHASE_ORDER_LIST_CACHE_TTL\) return cached/)
  assert.match(panel, /if \(!force\) \{[\s\S]*const pending = purchaseOrderListRequestsRef\.current\.get\(key\)/)
  assert.match(panel, /invalidatePurchaseOrderListCache\(\); void load\(\{ force: true \}\)/)
  assert.match(panel, /generation === purchaseOrderCacheGenerationRef\.current/)
  assert.match(panel, /invalidatePurchaseOrderListCache\(\); setView\('list'\); resetForm\(\); load\(\)/)
  assert.match(panel, /msg\('Orden de compra anulada correctamente'\)[\s\S]*invalidatePurchaseOrderListCache\(\)/)
  assert.match(panel, /msg\(res\.already_closed[^\n]+\)[\s\S]*invalidatePurchaseOrderListCache\(\)/)
})

test('search input is debounced and stale responses cannot replace the active request', () => {
  assert.match(panel, /const timer = window\.setTimeout\(\(\) => \{[\s\S]*setFilters\(previous => previous\.search === search/)
  assert.match(panel, /return \(\) => window\.clearTimeout\(timer\)/)
  assert.match(panel, /if \(requestId !== requestSequence\.current\) return/)
  assert.match(panel, /value=\{searchInput\} onChange=\{e => setSearchInput\(e\.target\.value\)\}/)
})
