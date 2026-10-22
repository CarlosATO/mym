import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sql = await readFile(new URL('../supabase/migrations/20261022090000_logistica_route_invoice_read_model.sql', import.meta.url), 'utf8')

test('agrega identidad tecnica de factura y backfill conservador', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS invoice_bsale_id bigint/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_route_guide_items_invoice_bsale_id[\s\S]*WHERE invoice_bsale_id IS NOT NULL/)
  assert.match(sql, /candidate_count = 1/)
  assert.match(sql, /backfilled=%.*unresolved=%.*ambiguous=/)
})

test('requiere intento confirmado y documento Tipo 5 valido', () => {
  assert.match(sql, /a\.status = 'CONFIRMED'/)
  assert.match(sql, /a\.bsale_invoice_id IS NOT NULL/)
  assert.match(sql, /d\.document_type_id = 5/)
  assert.match(sql, /d\.state = 0/)
  assert.match(sql, /COALESCE\(d\.raw_json->>'cancellationStatus', '0'\) = '0'/)
})

test('excluye asociaciones vigentes por identidad tecnica o fallback historico', () => {
  assert.match(sql, /rg\.status IN \('DRAFT', 'DISPATCHED'\)/)
  assert.match(sql, /rgi\.validation_status = 'VALID'/)
  assert.match(sql, /rgi\.invoice_bsale_id = a\.bsale_invoice_id/)
  assert.match(sql, /rgi\.invoice_bsale_id IS NULL/)
  assert.match(sql, /rgi\.invoice_number = d\.number::text/)
})

test('mantiene soporte N:M y vuelve elegible cuando no queda asociacion', () => {
  assert.match(sql, /LEFT JOIN LATERAL/)
  assert.match(sql, /ORDER BY a\.confirmed_at DESC NULLS LAST/)
  assert.match(sql, /NOT EXISTS \([\s\S]*route_guide_items/)
  assert.match(sql, /c\.status = 'INVOICED_READY_FOR_ROUTE'/)
})

test('el board se resuelve en una vista y no agrega N+1 de React', () => {
  assert.doesNotMatch(sql, /FROM logistica\.sales_order_preparation_cards[\s\S]*LOOP/)
  assert.match(sql, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_preparation_board/)
})

function isEligible(fixture) {
  if (fixture.status !== 'INVOICED_READY_FOR_ROUTE') return false
  return fixture.attemptStatus === 'CONFIRMED'
    && fixture.invoiceId != null
    && fixture.documentTypeId === 5
    && fixture.state === 0
    && fixture.cancellationStatus === 0
    && fixture.validRouteInvoiceIds.every(id => id !== fixture.invoiceId)
    && fixture.validLegacyRouteNumbers.every(number => number !== String(fixture.invoiceNumber))
}

test('cubre la matriz funcional y el caso real 5032/24758', () => {
  const base = {
    status: 'INVOICED_READY_FOR_ROUTE', attemptStatus: 'CONFIRMED', invoiceId: 92551,
    documentTypeId: 5, state: 0, cancellationStatus: 0, invoiceNumber: 24758,
    validRouteInvoiceIds: [], validLegacyRouteNumbers: [],
  }
  assert.equal(isEligible(base), true)
  assert.equal(isEligible({ ...base, attemptStatus: null }), false)
  assert.equal(isEligible({ ...base, invoiceId: null }), false)
  assert.equal(isEligible({ ...base, state: 1 }), false)
  assert.equal(isEligible({ ...base, validRouteInvoiceIds: [92551] }), false)
  assert.equal(isEligible({ ...base, validLegacyRouteNumbers: ['24758'] }), false)
  assert.equal(isEligible({ ...base, companyId: 'other-company' }), true)
  assert.equal(isEligible({ ...base, validRouteInvoiceIds: [] }), true)
  assert.equal(isEligible({ ...base, status: 'IN_AUDIT' }), false)
})

test('la tarjeta conserva folio confirmado y forma de pago del espejo local', async () => {
  const action = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation.ts', import.meta.url), 'utf8')
  const card = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-card.tsx', import.meta.url), 'utf8')
  assert.match(action, /payment_type_name/)
  assert.match(action, /payment_method_name: client\?\.payment_type_name/)
  assert.match(card, /Factura #\$\{invoiceDocuments\[0\]\.invoice_folio\}/)
  assert.match(card, /invoiceDocuments\[0\]\.payment_method_name/)
})
