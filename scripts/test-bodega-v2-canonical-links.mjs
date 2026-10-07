import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { normalizeBsaleRelatedDetailId } from '../src/lib/integraciones/bsale-invoice-sales-order-link.ts'

const migration = await readFile(
  new URL('../supabase/migrations/20261007160000_bodega_v2_invoice_sales_order_reconciliation.sql', import.meta.url),
  'utf8',
)
const sync = await readFile(
  new URL('../src/app/actions/integraciones/bsale-sync.ts', import.meta.url),
  'utf8',
)

test('normaliza relatedDetailId Bsale de forma segura', () => {
  assert.equal(normalizeBsaleRelatedDetailId('331913'), 331913)
  assert.equal(normalizeBsaleRelatedDetailId(331913), 331913)
  assert.equal(normalizeBsaleRelatedDetailId(''), null)
  assert.equal(normalizeBsaleRelatedDetailId('not-an-id'), null)
  assert.equal(normalizeBsaleRelatedDetailId(-1), null)
  assert.equal(normalizeBsaleRelatedDetailId(1.5), null)
})

test('el contrato SQL sólo enlaza Factura tipo 5 con NV tipo 23 por detalle', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS integraciones\.bsale_invoice_sales_order_links/)
  assert.match(migration, /invoice\.document_type_id = 5/)
  assert.match(migration, /sales_order\.document_type_id = 23/)
  assert.match(migration, /invoice_detail\.related_detail_bsale_id IS NOT NULL/)
  assert.match(migration, /UNIQUE \(company_id, invoice_detail_bsale_id, sales_order_detail_bsale_id\)/)
  assert.doesNotMatch(migration, /invoice\.invoice_bsale_id/)
  assert.doesNotMatch(migration, /bsale_document_references invoice_ref/)
})

test('el sync persiste related_detail_bsale_id en ambos flujos de detalle', () => {
  assert.equal((sync.match(/related_detail_bsale_id:/g) || []).length, 2)
  assert.match(sync, /normalizeBsaleRelatedDetailId\(det\.relatedDetailId\)/)
  assert.match(sync, /normalizeBsaleRelatedDetailId\(detail\.relatedDetailId\)/)
  assert.match(sync, /rpc\('reconcile_bodega_preparation_cards'/)
})

test('el cierre y la vista activa son idempotentes y conservan historial', () => {
  assert.match(migration, /WHEN EXISTS \([\s\S]*?THEN 'INVOICED'\s+ELSE 'CANCELLED_BSALE'/)
  assert.doesNotMatch(migration, /WHEN nv\.state = 1 THEN 'CANCELLED_BSALE'/)
  assert.doesNotMatch(migration, /invoice\.state = 0/)
  assert.doesNotMatch(migration, /active_invoice/)
  assert.match(migration, /historical_invoice\.document_type_id = 5/)
  assert.match(migration, /closed_at IS NULL/)
  assert.match(migration, /company_id, card_id, automation_key/)
  assert.match(migration, /movement_source,\n    pin_validated,\n    observation,\n    metadata,\n    automation_key/)
  assert.match(migration, /ON CONFLICT DO NOTHING;/)
  assert.match(migration, /WHERE c\.closed_at IS NULL\n  AND nv\.is_invoiced = false;/)
  assert.match(migration, /UPDATE logistica\.sales_order_preparation_cards c/)
  assert.doesNotMatch(migration, /DELETE FROM logistica\.sales_order_preparation_cards/)
  assert.doesNotMatch(migration, /DELETE FROM logistica\.sales_order_preparation_movements/)
})
