import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const action = await readFile(new URL('src/app/actions/adquisiciones/purchase-orders.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/adquisiciones/ordenes-compra/purchase-orders-panel.tsx', root), 'utf8')
const pdf = await readFile(new URL('src/lib/pdf/generate-po-pdf.ts', root), 'utf8')
const excel = await readFile(new URL('src/lib/excel/generate-po-excel.ts', root), 'utf8')

const pdfStart = panel.indexOf('async function handleDownloadPDF()')
const pdfEnd = panel.indexOf('\n  async function handleDownloadExcel()', pdfStart)
const excelStart = panel.indexOf('async function handleDownloadExcel()')
const excelEnd = panel.indexOf('\n  async function handlePreviewPDF()', excelStart)
assert.ok(pdfStart >= 0 && pdfEnd > pdfStart)
assert.ok(excelStart >= 0 && excelEnd > excelStart)
const pdfHandler = panel.slice(pdfStart, pdfEnd)
const excelHandler = panel.slice(excelStart, excelEnd)

test('canonical document source selects CURRENT or CONFIRMED from persisted data', () => {
  assert.match(action, /export async function getPurchaseOrderDocumentDetail\(poId: string\)/)
  assert.match(action, /const current = await getPurchaseOrderDetail\(poId\)/)
  assert.match(action, /snapshot_type', 'CONFIRMED'/)
  assert.match(action, /document_source: 'CURRENT'/)
  assert.match(action, /document_source: 'CONFIRMED'/)
  assert.match(action, /items_snapshot/)
  assert.match(action, /status: current\.po\.status/)
  assert.doesNotMatch(action, /snapshot_type', 'ORIGINAL_SENT'/)
})

test('SKU is resolved from products for CURRENT and directly from CONFIRMED snapshot', () => {
  assert.match(action, /from\('products'\)\.select\('id, sku'\)/)
  assert.match(action, /item\.sku \?\? .*currentSkuById\.get/)
  assert.match(action, /sku: snapshotText\(item\.sku/)
  assert.match(pdf, /'SKU'/)
  assert.match(pdf, /item\.sku \|\| '-'/)
  assert.match(excel, /'Línea', 'SKU', 'Descripción'/)
})

test('CONFIRMED preserves null snapshot values and only takes operational state from CURRENT', () => {
  const confirmedStart = action.indexOf('const header = (confirmed.header_snapshot ?? {})')
  const confirmedEnd = action.indexOf('\n  return {\n    data: {\n      po: snapshotPo', confirmedStart)
  assert.ok(confirmedStart >= 0 && confirmedEnd > confirmedStart)
  const confirmedSource = action.slice(confirmedStart, confirmedEnd)

  const confirmedHeader = { required_date: null, payment_terms: null, notes: null }
  const currentHeader = { required_date: '2099-01-01', payment_terms: '30 días', notes: 'Valor actual' }
  assert.equal(confirmedHeader.required_date, null)
  assert.notEqual(currentHeader.required_date, confirmedHeader.required_date)
  assert.equal(confirmedHeader.payment_terms, null)
  assert.equal(confirmedHeader.notes, null)

  assert.match(confirmedSource, /required_date: snapshotText\(header\.required_date\)/)
  assert.match(confirmedSource, /payment_terms: snapshotText\(header\.payment_terms\)/)
  assert.match(confirmedSource, /notes: snapshotText\(header\.notes\)/)
  assert.match(confirmedSource, /sku: snapshotText\(item\.sku\)/)
  assert.match(confirmedSource, /status: current\.po\.status/)
  assert.match(confirmedSource, /receipt_status: current\.po\.receipt_status/)
  assert.doesNotMatch(confirmedSource, /current\.po\.(required_date|payment_terms|notes)/)
  assert.doesNotMatch(confirmedSource, /currentSkuById/)
})

test('PDF and Excel query the same canonical source at download time', () => {
  assert.match(pdfHandler, /getPurchaseOrderDocumentDetail\(detail\.po\.id\)/)
  assert.match(excelHandler, /getPurchaseOrderDocumentDetail\(detail\.po\.id\)/)
  assert.match(pdfHandler, /downloadPOBooklet\(document/)
  assert.match(excelHandler, /generatePurchaseOrderExcel\(result\.data\)/)
  assert.doesNotMatch(pdfHandler, /detail\.items|const pdfDetail/)
  assert.doesNotMatch(excelHandler, /detail\.items|detailCacheRef|selectedPo/)
})

test('Excel has Resumen and Detalle with numeric export values', () => {
  assert.match(excel, /aoa_to_sheet\(summary\)/)
  assert.match(excel, /aoa_to_sheet\(\[[\s\S]*'Línea', 'SKU', 'Descripción'/)
  assert.match(excel, /book_append_sheet\(workbook, summarySheet, 'Resumen'\)/)
  assert.match(excel, /book_append_sheet\(workbook, detailSheet, 'Detalle'\)/)
  assert.match(excel, /item\.quantity,/)
  assert.match(excel, /item\.unit_price,/)
  assert.match(excel, /XLSX\.writeFile\(workbook, `OC_\$\{sanitizeFileName\(po\.correlative\)\}\.xlsx`\)/)
})

test('document buttons prevent duplicate downloads and expose errors', () => {
  assert.match(panel, /downloadingPdf/)
  assert.match(panel, /downloadingExcel/)
  assert.match(panel, /disabled=\{downloadingPdf\}/)
  assert.match(panel, /disabled=\{downloadingExcel\}/)
  assert.match(panel, /PDF\.\.\./)
  assert.match(panel, /Excel\.\.\./)
  assert.match(panel, /No se pudo generar el PDF\./)
  assert.match(panel, /No se pudo generar el Excel\./)
  assert.match(panel, /<FileSpreadsheet/)
  assert.match(panel, /downloadingExcel \? 'Excel\.\.\.' : 'Excel'/)
})
