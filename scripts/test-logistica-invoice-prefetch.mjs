import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createInvoicePreviewCache,
  getInvoicePreviewCacheKey,
  invalidateInvoicePreview,
  isInvoicePreviewFresh,
} from '../src/modules/logistica/preparacion-pedidos/invoice-preview-cache.ts'
import {
  createInvoiceDocumentCache,
  getInvoiceDocumentCacheKey,
  isInvoiceDocumentFresh,
} from '../src/modules/logistica/preparacion-pedidos/invoice-document-cache.ts'

const root = new URL('../', import.meta.url)
const action = await readFile(new URL('src/app/actions/logistica/sales-order-preparation.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const ui = await readFile(new URL('src/modules/logistica/preparacion-pedidos/invoice-flow-ui.tsx', root), 'utf8')

test('cache key includes card and current NV, with TTL and targeted invalidation', () => {
  const cache = createInvoicePreviewCache()
  const key = getInvoicePreviewCacheKey('card-a', 92513)
  cache.set(key, { current_bsale_nv_id: 92513, snapshot: null, status: 'READY', error: null, updatedAt: 1000 })
  assert.equal(key, 'card-a:92513')
  assert.equal(isInvoicePreviewFresh(cache.get(key), 1000 + 44_999), true)
  assert.equal(isInvoicePreviewFresh(cache.get(key), 1000 + 45_000), false)
  invalidateInvoicePreview(cache, 'card-a', 92513)
  assert.equal(cache.has(key), false)
})

test('batch action uses set-based reads and does not call Bsale', () => {
  assert.match(action, /getInvoiceReviewPreviews/)
  assert.match(action, /getInvoiceDocumentPreviews/)
  assert.match(action, /bsale_invoice_sales_order_links/)
  assert.match(action, /invoice_detail_bsale_id/)
  assert.match(action, /\.in\('sales_order_bsale_id', nvIds\)/)
  assert.match(action, /\.in\('bsale_id', nvIds\)/)
  assert.match(action, /\.in\('nv_bsale_id', nvIds\)/)
  assert.match(action, /\.in\('bsale_client_id', clientIds\)/)
  assert.doesNotMatch(action, /fetch\(/)
  assert.match(action, /urlPdf|urlXml|urlPublicView/)
  assert.doesNotMatch(action, /\.eq\('number'|\.eq\('total_amount'|\.eq\('client_id'/)
  assert.doesNotMatch(action, /POST.*bsale|PUT.*bsale|DELETE.*bsale/i)
})

test('panel prefetches only ready cards and opens from the same in-flight promise', () => {
  assert.match(panel, /status === 'AUDITED' && readinessByCardId\[card\.card_id\]\?\.route_readiness === 'READY_TO_INVOICE'/)
  assert.match(panel, /invoicePreviewInFlightRef\.current\.get\(key\)/)
  assert.match(panel, /prefetchInvoicePreviews\(companyId, \[card\]\)/)
  assert.match(panel, /status === 'INVOICED_READY_FOR_ROUTE'/)
  assert.match(panel, /prefetchInvoiceDocuments\(companyId, invoicedCards\)/)
  assert.match(panel, /invoiceDocumentInFlightRef\.current\.get\(key\)/)
  assert.doesNotMatch(panel, /\.pdf\(|\.xml\(|downloadPdf|downloadXml/)
  assert.doesNotMatch(panel, /getInvoiceReviewSnapshot\(/)
})

test('document cache is keyed by card and NV with the same TTL boundary', () => {
  const cache = createInvoiceDocumentCache()
  const key = getInvoiceDocumentCacheKey('card-a', 92513)
  cache.set(key, { current_bsale_nv_id: 92513, documents: [], status: 'READY', error: null, updatedAt: 1000 })
  assert.equal(isInvoiceDocumentFresh(cache.get(key), 1000 + 44_999), true)
  assert.equal(isInvoiceDocumentFresh(cache.get(key), 1000 + 45_000), false)
})

test('5032 preview contract remains current and lightweight', () => {
  assert.match(ui, /current_bsale_nv_id: 92513/)
  assert.match(ui, /detail_id: 334790[\s\S]*quantity: 1/)
  assert.match(ui, /total_amount: 5598/)
})
