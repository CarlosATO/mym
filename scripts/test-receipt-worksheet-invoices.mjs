import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const action = await readFile(new URL('src/app/actions/logistica/recepciones.ts', root), 'utf8')
const worksheet = await readFile(new URL('src/modules/logistica/recepciones/receipt-worksheet.tsx', root), 'utf8')

test('invoice metadata query is scoped to the active company and purchase order', () => {
  assert.match(action, /export async function getPurchaseOrderReceiptInvoices\(poId: string\)/)
  assert.match(action, /\.eq\('id', poId\)\n\s*\.eq\('company_id', companyId\)/)
  assert.match(action, /\.eq\('company_id', companyId\)\n\s*\.eq\('purchase_order_id', purchaseOrder\.id\)/)
  assert.match(action, /document\.document_type !== 'FA'/)
  assert.match(action, /\['CANCELADA', 'CANCELLED'\]\.includes\(receipt\.status\)/)
  assert.match(action, /const documents = new Map<string, ReceiptInvoiceSummary>\(\)/)
})

test('invoice response exposes safe metadata and no signed storage URL', () => {
  const invoiceAction = action.slice(action.indexOf('export async function getPurchaseOrderReceiptInvoices'), action.indexOf('export interface OperationalPurchaseOrderPdfData'))
  assert.match(action, /has_file: Boolean\(document\.storage_path\)/)
  assert.match(action, /received_at: receipt\.received_at/)
  assert.match(action, /return \[\.\.\.documents\.values\(\)\]/)
  assert.doesNotMatch(invoiceAction, /signedUrl|createSignedUrl/)
})

test('worksheet loads invoices independently and reuses the existing viewer', () => {
  assert.match(worksheet, /getPurchaseOrderReceiptInvoices\(poId\)/)
  assert.match(worksheet, /const \[registeredInvoices, setRegisteredInvoices\]/)
  assert.match(worksheet, /const \[registeredInvoicesError, setRegisteredInvoicesError\]/)
  assert.match(worksheet, /registeredInvoices\.length > 0/)
  assert.match(worksheet, /<ReceiptDocumentViewerModal documentId=\{invoiceToView\.id\}/)
  assert.match(worksheet, /overflow-x-auto overscroll-x-contain/)
  assert.match(worksheet, /flex min-w-max flex-nowrap/)
  assert.match(worksheet, /disabled=\{!invoice\.has_file\}/)
  assert.match(worksheet, /Abrir factura/)
  assert.doesNotMatch(worksheet, /Ver factura/)
  assert.doesNotMatch(worksheet, /invoice\.file_name.*<\/p>/)
})
