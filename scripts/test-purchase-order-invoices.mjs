import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')
const modal = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-order-invoice-viewer-modal.tsx', root), 'utf8')

test('invoice summaries use one company-scoped batch query for visible purchase orders', () => {
  const start = action.indexOf('export async function getPurchaseOrderInvoiceSummaries')
  const end = action.indexOf('const PURCHASE_ORDER_INVOICE_BUCKET', start)
  const source = action.slice(start, end)
  assert.match(source, /authorizePurchaseOrderRead\(\)/)
  assert.match(source, /\.eq\('company_id', authorization\.companyId\)/)
  assert.match(source, /\.in\('purchase_order_id', authorizedPoIds\)/)
  assert.match(source, /\.neq\('status', 'CANCELLED'\)/)
  assert.match(source, /document\.document_type !== 'FA'/)
  assert.match(source, /document\.company_id !== authorization\.companyId/)
  assert.match(source, /seenByOrder/)
  assert.match(source, /seen\.has\(document\.id\)/)
  assert.match(source, /has_file: Boolean\(document\.storage_path\)/)
})

test('invoice signed URLs enforce session, active company, permission, ownership, bucket and safe path', () => {
  const start = action.indexOf('export async function getPurchaseOrderInvoiceSignedUrl')
  const end = action.indexOf('export async function getPurchaseOrderDetail', start)
  const source = action.slice(start, end)
  assert.match(source, /authorizePurchaseOrderRead\(\)/)
  assert.match(source, /document\.document_type !== 'FA'/)
  assert.match(source, /document\.storage_bucket !== PURCHASE_ORDER_INVOICE_BUCKET/)
  assert.match(source, /document\.storage_path\.startsWith\(expectedPrefix\)/)
  assert.match(source, /document\.storage_path\.includes\('\.\.'\)/)
  assert.match(source, /receipt\.status === 'CANCELLED'/)
  assert.match(source, /\.eq\('company_id', authorization\.companyId\)/)
  assert.match(source, /createSignedUrl\(document\.storage_path, expiresIn\)/)
  assert.match(source, /download: document\.file_name \|\| true/)
})

test('invoice summaries are integrated with list cache and visible rows without changing invoice_status', () => {
  assert.match(panel, /getPurchaseOrderInvoiceSummaries/)
  assert.match(panel, /fetchCachedPurchaseOrderInvoices/)
  assert.match(panel, /await fetchCachedPurchaseOrderInvoices\(result\.data\.map\(order => order\.id\)\)/)
  assert.match(panel, /loadVisiblePurchaseOrderInvoices\(res\.data, requestId\)/)
  assert.match(panel, /PurchaseOrderInvoiceCell documents=\{invoiceSummaries\[po\.id\]\}/)
  assert.match(panel, /documents\.length === 1 \? documents\[0\]\.document_number \|\| 'Factura' : `\$\{documents\.length\} facturas`/)
  assert.doesNotMatch(panel, /<Badge value=\{po\.invoice_status\}/)
  assert.match(panel, /setInvoiceSummaries\(\{\}\)/)
})

test('invoice viewer lists every document and supports image, PDF and original download', () => {
  assert.match(modal, /getPurchaseOrderInvoiceSignedUrl\(selected\.id\)/)
  assert.match(modal, /documents\.map\(document =>/)
  assert.match(modal, /document\.has_file/)
  assert.match(modal, /download=\{link\.fileName\}/)
  assert.match(modal, /isImage = link\?\.mimeType\.startsWith\('image\/'\)/)
  assert.match(modal, /isPdf = link\?\.mimeType === 'application\/pdf'/)
  assert.match(modal, /Descargar original/)
  assert.match(modal, /No se pudo obtener el enlace temporal de la factura/)
})
