import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  classifyAndFilterReceiptCandidates,
  purchaseTypeLabel,
  receptionStatusLabel,
} from '../src/modules/cuentas-por-pagar/classification.ts'

const root = new URL('..', import.meta.url)
const inbox = await readFile(new URL('src/modules/cuentas-por-pagar/invoice-inbox.tsx', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/cuentas-por-pagar.ts', root), 'utf8')
const filterMigration = await readFile(
  new URL('supabase/migrations/20261120130000_cuentas_por_pagar_inbox_product_filter.sql', root),
  'utf8',
)

function candidate(overrides = {}) {
  return {
    candidate_id: 'c-1',
    issuer_rut: '761234567',
    supplier_name: 'Proveedor Test SpA',
    folio: '1001',
    issue_date: '2026-11-10',
    purchase_orders: ['OC-2026-000010'],
    receipt_ids: ['r-1'],
    reference_amount: 119000,
    has_document: true,
    invoice_id: null,
    invoice_status: null,
    blocked_reason: null,
    ...overrides,
  }
}

test('includes FA product receipts with total reception (with or without PDF)', () => {
  const receipts = new Map([
    ['r-1', { id: 'r-1', purchase_order_id: 'po-1', status: 'COMPLETED', document_type: 'FA', document_number: '1001', receiving_type: 'WAREHOUSE' }],
  ])
  const pos = new Map([
    ['po-1', { id: 'po-1', correlative: 'OC-2026-000010', po_type: 'PRODUCTOS', status: 'RECEPCION_TOTAL', receipt_status: 'RECEPCION_TOTAL', is_active: true }],
  ])

  const [withPdf] = classifyAndFilterReceiptCandidates([candidate({ has_document: true })], receipts, pos)
  assert.equal(withPdf?.purchase_type, 'PRODUCTS')
  assert.equal(withPdf?.reception_status, 'RECEIVED')
  assert.equal(purchaseTypeLabel(withPdf?.purchase_type), 'Productos')
  assert.equal(receptionStatusLabel(withPdf?.reception_status, withPdf?.purchase_type), 'Recibido')

  const [withoutPdf] = classifyAndFilterReceiptCandidates([candidate({ has_document: false })], receipts, pos)
  assert.ok(withoutPdf)
  assert.equal(withoutPdf.has_document, false)
  assert.equal(withoutPdf.reception_status, 'RECEIVED')
})

test('includes FA product receipts with partial reception as Productos / Parcial', () => {
  const receipts = new Map([
    ['r-1', { id: 'r-1', purchase_order_id: 'po-1', status: 'COMPLETED', document_type: 'FA', document_number: '1001', receiving_type: 'WAREHOUSE' }],
  ])
  const pos = new Map([
    ['po-1', { id: 'po-1', correlative: 'OC-2026-000010', po_type: 'PRODUCTOS', status: 'RECEPCION_PARCIAL', receipt_status: 'RECEPCION_PARCIAL', is_active: true }],
  ])

  const [row] = classifyAndFilterReceiptCandidates([candidate()], receipts, pos)
  assert.ok(row)
  assert.equal(row.purchase_type, 'PRODUCTS')
  assert.equal(row.reception_status, 'PARTIAL')
  assert.equal(receptionStatusLabel(row.reception_status, row.purchase_type), 'Parcial')
})

test('aggregates multiple product receipts per invoice accurately across single or multiple POs', () => {
  const receipts = new Map([
    ['r-1', { id: 'r-1', purchase_order_id: 'po-1', status: 'COMPLETED', document_type: 'FA', document_number: '1001', receiving_type: 'WAREHOUSE' }],
    ['r-2', { id: 'r-2', purchase_order_id: 'po-2', status: 'COMPLETED', document_type: 'FA', document_number: '1001', receiving_type: 'WAREHOUSE' }],
  ])
  const mixedPos = new Map([
    ['po-1', { id: 'po-1', correlative: 'OC-1', po_type: 'PRODUCTOS', status: 'RECEPCION_TOTAL', receipt_status: 'RECEPCION_TOTAL', is_active: true }],
    ['po-2', { id: 'po-2', correlative: 'OC-2', po_type: 'PRODUCTOS', status: 'RECEPCION_PARCIAL', receipt_status: 'RECEPCION_PARCIAL', is_active: true }],
  ])
  const [mixedRow] = classifyAndFilterReceiptCandidates(
    [candidate({ receipt_ids: ['r-1', 'r-2'], purchase_orders: ['OC-1', 'OC-2'] })],
    receipts,
    mixedPos,
  )
  assert.equal(mixedRow?.reception_status, 'PARTIAL')

  const completedPos = new Map([
    ['po-1', { id: 'po-1', correlative: 'OC-1', po_type: 'PRODUCTOS', status: 'RECEPCION_TOTAL', receipt_status: 'RECEPCION_TOTAL', is_active: true }],
    ['po-2', { id: 'po-2', correlative: 'OC-2', po_type: 'PRODUCTOS', status: 'CERRADA', receipt_status: 'RECEPCION_TOTAL', is_active: true }],
  ])
  const [completedRow] = classifyAndFilterReceiptCandidates(
    [candidate({ receipt_ids: ['r-1', 'r-2'], purchase_orders: ['OC-1', 'OC-2'] })],
    receipts,
    completedPos,
  )
  assert.equal(completedRow?.reception_status, 'RECEIVED')
})

test('excludes GD-only receipts, service/office receipts, pending POs without reception, cancelled POs, and receipts without document_number', () => {
  const receipts = new Map([
    ['r-gd', { id: 'r-gd', purchase_order_id: 'po-ok', status: 'COMPLETED', document_type: 'GD', document_number: '555', receiving_type: 'WAREHOUSE' }],
    ['r-svc', { id: 'r-svc', purchase_order_id: 'po-svc', status: 'COMPLETED', document_type: 'FA', document_number: '558', receiving_type: 'OFFICE' }],
    ['r-wh-svc', { id: 'r-wh-svc', purchase_order_id: 'po-svc', status: 'COMPLETED', document_type: 'FA', document_number: '559', receiving_type: 'WAREHOUSE' }],
    ['r-pending-po', { id: 'r-pending-po', purchase_order_id: 'po-pending', status: 'COMPLETED', document_type: 'FA', document_number: '556', receiving_type: 'WAREHOUSE' }],
    ['r-cancelled-po', { id: 'r-cancelled-po', purchase_order_id: 'po-cancelled', status: 'COMPLETED', document_type: 'FA', document_number: '557', receiving_type: 'WAREHOUSE' }],
    ['r-empty-doc', { id: 'r-empty-doc', purchase_order_id: 'po-ok', status: 'COMPLETED', document_type: 'FA', document_number: '   ', receiving_type: 'WAREHOUSE' }],
  ])
  const pos = new Map([
    ['po-ok', { id: 'po-ok', correlative: 'OC-1', po_type: 'PRODUCTOS', status: 'RECEPCION_TOTAL', receipt_status: 'RECEPCION_TOTAL', is_active: true }],
    ['po-svc', { id: 'po-svc', correlative: 'OC-4', po_type: 'SERVICIOS', status: 'RECEPCION_TOTAL', receipt_status: 'RECEPCION_TOTAL', is_active: true }],
    ['po-pending', { id: 'po-pending', correlative: 'OC-2', po_type: 'PRODUCTOS', status: 'CONFIRMADA', receipt_status: 'PENDIENTE', is_active: true }],
    ['po-cancelled', { id: 'po-cancelled', correlative: 'OC-3', po_type: 'PRODUCTOS', status: 'CANCELADA', receipt_status: 'RECEPCION_TOTAL', is_active: true }],
  ])

  const filtered = classifyAndFilterReceiptCandidates(
    [
      candidate({ candidate_id: 'c-gd', receipt_ids: ['r-gd'] }),
      candidate({ candidate_id: 'c-svc', receipt_ids: ['r-svc'] }),
      candidate({ candidate_id: 'c-wh-svc', receipt_ids: ['r-wh-svc'] }),
      candidate({ candidate_id: 'c-pend', receipt_ids: ['r-pending-po'] }),
      candidate({ candidate_id: 'c-canc', receipt_ids: ['r-cancelled-po'] }),
      candidate({ candidate_id: 'c-empty', receipt_ids: ['r-empty-doc'] }),
    ],
    receipts,
    pos,
  )
  assert.equal(filtered.length, 0)
})

test('SQL RPC and server action enforce identical product-only eligibility for listing and incorporation', () => {
  assert.match(filterMigration, /CREATE OR REPLACE FUNCTION public\.cxp_receipt_candidates\(\)/)
  assert.match(filterMigration, /r\.receiving_type = 'WAREHOUSE'/)
  assert.match(filterMigration, /coalesce\(p\.po_type, 'PRODUCTOS'\) <> 'SERVICIOS'/)
  assert.match(filterMigration, /p\.status NOT IN \('CANCELADA', 'RECHAZADA', 'BORRADOR'\)/)
  assert.match(filterMigration, /p\.receipt_status IN \('RECEPCION_TOTAL', 'RECEPCION_PARCIAL'\)/)
  assert.match(filterMigration, /nullif\(btrim\(r\.document_number\), ''\) IS NOT NULL/)
  assert.match(actions, /eligibleIds\.has\(id\)/)
  assert.match(inbox, /renderSortableHeader\('purchaseType', 'Tipo'\)/)
  assert.match(inbox, /renderSortableHeader\('receptionStatus', 'Recepción'\)/)
})
