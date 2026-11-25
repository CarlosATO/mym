import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import ts from 'typescript'
import * as XLSX from 'xlsx'

const require = createRequire(import.meta.url)
const modules = new Map()
async function load(alias, path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => modules.get(name) ?? require(name), module, module.exports)
  modules.set(alias, module.exports)
  return module.exports
}
await load('@/lib/datetime', '../src/lib/datetime.ts')
await load('@/lib/adquisiciones/purchase-order-document', '../src/lib/adquisiciones/purchase-order-document.ts')
await load('@/lib/adquisiciones/purchase-order-discounts', '../src/lib/adquisiciones/purchase-order-discounts.ts')
await load('@/lib/adquisiciones/purchase-order-file-name', '../src/lib/adquisiciones/purchase-order-file-name.ts')
const pdf = await load('pdf', '../src/lib/pdf/generate-po-pdf.ts')
const excel = await load('excel', '../src/lib/excel/generate-po-excel.ts')

const line = { id: '1', line_number: 1, item_type: 'PRODUCT', sku: '513135', product_description: 'Producto de referencia', unit: 'UNIDAD', quantity: 900, unit_price: 1583.3333, purchase_unit_snapshot: 'DISPLAY', purchase_unit_factor_snapshot: 6, commercial_quantity: 150, commercial_unit_price_snapshot: 9500, commercial_gross_amount_snapshot: 1425000, discount_percent: 0, discount_unit_amount: 100, discount_amount: 90000, tax_rate: 19, tax_amount: 253650, line_total: 1588650 }
const detail = { po: { id: '1', correlative: 'OC-2026-000091', issue_date: '2026-11-25', supplier_name: 'Proveedor', po_type: 'PRODUCTOS', currency: 'CLP', requester_name: 'Usuario', net_total: 1335000, discount_total: 90000, tax_total: 253650, grand_total: 1588650, exempt_total: 0, status: 'CONFIRMADA', commercial_managed: true, created_at: '2026-11-25' }, document_source: 'CONFIRMED', items: [line] }

test('PDF y Excel muestran exactamente los importes persistidos, no el precio interno redondeado', async () => {
  const row = pdf.buildCommercialPOItemPdfRow(line)
  assert.match(row[2], /150 DISPLAY\nDISPLAY de 6\n900 UNIDAD internas/)
  assert.equal(row[3], '$ 9.500')
  assert.deepEqual(row.slice(4), ['$ 1.425.000,00', '$ 90.000,00', '$ 1.335.000,00', '$ 253.650,00', '$ 1.588.650,00'])
  const book = excel.buildPurchaseOrderWorkbook(detail)
  const saved = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
  const sheet = XLSX.read(saved, { type: 'buffer', cellNF: true }).Sheets.Detalle
  for (const [cell, value] of Object.entries({ E2: 900, F2: 1583.3333, G2: 'DISPLAY', H2: 6, I2: 150, J2: 9500, K2: 1425000, M2: 90000, N2: 1335000, P2: 253650, Q2: 1588650 })) assert.equal(sheet[cell].v, value, cell)
  assert.match(sheet.F2.z, /0\.00##/)
  const blob = pdf.generatePdfBlob(detail)
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1')
  assert.match(text, /1\.425\.000,00/)
  assert.match(text, /1\.588\.650,00/)
})

test('original enviado y confirmado conservan versiones distintas', () => {
  const original = { ...line, quantity: 660, unit_price: 1666.6667, commercial_quantity: 110, commercial_unit_price_snapshot: 10000, commercial_gross_amount_snapshot: 1100000, discount_amount: 66000, tax_amount: 196460, line_total: 1230460 }
  assert.match(pdf.buildCommercialPOItemPdfRow(original)[2], /110 DISPLAY/)
  assert.equal(excel.buildPurchaseOrderWorkbook({ ...detail, document_source: 'ORIGINAL_SENT', items: [original] }).Sheets.Detalle.J2.v, 10000)
  assert.equal(excel.buildPurchaseOrderWorkbook(detail).Sheets.Detalle.J2.v, 9500)
})

test('factor uno, presentación pendiente, servicios y líneas tradicionales', () => {
  const one = { ...line, purchase_unit_factor_snapshot: 1, purchase_unit_snapshot: 'UNIDAD', commercial_quantity: 900 }
  assert.match(pdf.buildCommercialPOItemPdfRow(one)[2], /UNIDAD de 1/)
  const pending = { ...line, purchase_unit_factor_snapshot: null, commercial_unit_price_snapshot: null, commercial_gross_amount_snapshot: null }
  assert.match(pdf.buildCommercialPOItemPdfRow(pending)[2], /Presentación pendiente/)
  assert.equal(excel.buildPurchaseOrderWorkbook({ ...detail, items: [pending] }).Sheets.Detalle.G2.v, 'Pendiente')
  assert.doesNotMatch(pdf.buildCommercialPOItemPdfRow({ ...pending, item_type: 'SERVICE' })[2], /pendiente/)
  assert.equal(pdf.buildPOItemPdfRow(pending).total_amount, 1588650)
})

test('PDF de muchas líneas y descripciones extensas se genera con paginación', async () => {
  const items = Array.from({ length: 80 }, (_, index) => ({ ...line, line_number: index + 1, product_description: 'Descripción comercial extensa '.repeat(6) }))
  const blob = pdf.generatePdfBlob({ ...detail, items })
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1')
  const count = text.match(/\/Count\s+(\d+)/)
  assert.ok(count && Number(count[1]) > 1)
})

test('referencia real: snapshots coherentes en PDF y Excel', { skip: process.env.PO_DOCUMENT_REFERENCE_READONLY !== '1' }, async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).schema('adquisiciones')
  const order = await db.from('purchase_orders').select('id,correlative,status,grand_total').eq('correlative', 'OC-2026-000091').single()
  if (order.error) throw new Error(order.error.message)
  const snapshots = await db.from('purchase_order_snapshots').select('snapshot_type,header_snapshot,items_snapshot').eq('po_id', order.data.id).in('snapshot_type', ['ORIGINAL_SENT', 'CONFIRMED'])
  if (snapshots.error) throw new Error(snapshots.error.message)
  assert.equal(snapshots.data.length, 2)
  for (const snapshot of snapshots.data) {
    const original = snapshot.snapshot_type === 'ORIGINAL_SENT'
    const amount = original ? 1762074.65 : 2120264.65
    assert.equal(Number(snapshot.header_snapshot.grand_total), amount)
    assert.equal(snapshot.items_snapshot.length, 6)
    const doc = { ...detail, po: { ...detail.po, ...snapshot.header_snapshot, status: order.data.status, commercial_managed: true }, document_source: snapshot.snapshot_type, items: snapshot.items_snapshot }
    const workbook = excel.buildPurchaseOrderWorkbook(doc)
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Detalle, { header: 1 })
    assert.equal(rows.length, 7)
    const index = snapshot.items_snapshot.findIndex(item => item.sku === '513135')
    assert.ok(index >= 0)
    assert.equal(rows[index + 1][8], original ? 110 : 150)
    assert.equal(rows[index + 1][9], original ? 10000 : 9500)
    assert.equal(rows[index + 1][10], original ? 1100000 : 1425000)
    assert.equal(rows[index + 1][16], original ? 1230460 : 1588650)
    const pdfText = Buffer.from(await pdf.generatePdfBlob(doc).arrayBuffer()).toString('latin1')
    assert.ok(pdfText.includes(original ? '1.762.074,65' : '2.120.264,65'))
    assert.ok(pdfText.includes(original ? '1.100.000,00' : '1.425.000,00'))
  }
})
