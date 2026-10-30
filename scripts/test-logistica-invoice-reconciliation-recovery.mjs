import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261030120743_logistica_invoice_reconciliation_strict.sql', import.meta.url), 'utf8')
const historical = await readFile(new URL('../supabase/migrations/20261021140000_logistica_invoice_attempts_readonly.sql', import.meta.url), 'utf8')

test('MEJ-03B reemplaza ambas RPC en una migración forward-only sin escribir Bsale', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.validate_sales_order_invoice_document/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.reconcile_sales_order_invoice_attempt/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.confirm_sales_order_invoice_attempt/)
  assert.match(migration, /BEGIN;[\s\S]*COMMIT;/)
  assert.doesNotMatch(migration, /bsaleWriteForCompany|\/documents\.json|UPDATE integraciones\.bsale_documents|DELETE FROM integraciones\.bsale_documents/)
  assert.doesNotMatch(migration, /module\.logistica\.view/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.reconcile_sales_order_invoice_attempt\(uuid\) TO authenticated, service_role/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.confirm_sales_order_invoice_attempt\(uuid, bigint, text\) TO authenticated, service_role/)
})

test('caso real 24869 conserva identidad y acepta solo el total oficial dentro de ±5', () => {
  const invoice24869 = {
    totals: { net: 250618, tax: 47617, total: 298235 },
    lines: [
      { sku: 'USA651', net: 82098, tax: 15598, gross: 97697 },
      { sku: 'TF1013', net: 4520, tax: 859, gross: 5378 },
    ],
  }
  assert.equal(invoice24869.lines[0].net + invoice24869.lines[0].tax - invoice24869.lines[0].gross, -1)
  assert.equal(invoice24869.lines[1].net + invoice24869.lines[1].tax - invoice24869.lines[1].gross, 1)
  assert.deepEqual(invoice24869.totals, { net: 250618, tax: 47617, total: 298235 })
  assert.match(migration, /expected_total := NULLIF\(a\.nv_snapshot->'totals'->>'total'/)
  assert.match(migration, /abs\(total_difference\) > 5/)
  assert.match(migration, /'limit', 5/)
  assert.doesNotMatch(migration, /inv\.net_amount IS DISTINCT FROM/)
  assert.doesNotMatch(migration, /inv\.tax_amount IS DISTINCT FROM/)
})

test('no se comparan importes unitarios, descuentos, netos, IVA ni líneas monetarias', () => {
  assert.doesNotMatch(migration, /net_unit_value IS DISTINCT FROM/)
  assert.doesNotMatch(migration, /net_discount IS DISTINCT FROM/)
  assert.doesNotMatch(migration, /net_amount IS DISTINCT FROM/)
  assert.doesNotMatch(migration, /tax_amount IS DISTINCT FROM/)
  assert.doesNotMatch(migration, /total_amount IS DISTINCT FROM/)
  assert.doesNotMatch(migration, /net_amount \+ tax_amount/)
  assert.doesNotMatch(migration, /DETAIL_NET_REDISTRIBUTION_NOT_PROVABLE/)
  assert.doesNotMatch(migration, /DETAIL_GROSS_VALUE_MISMATCH/)
})

test('identidad documental, vigencia, cliente, oficina y salesId son obligatorios', () => {
  assert.match(migration, /d\.document_type_id = 5/)
  assert.match(migration, /d\.state = 0/)
  assert.match(migration, /cancellationStatus', '0'/)
  assert.match(migration, /d\.raw_json->>'salesId' = a\.sales_id/)
  assert.match(migration, /inv\.client_id IS DISTINCT FROM/)
  assert.match(migration, /inv\.office_id IS DISTINCT FROM/)
  assert.match(migration, /NO_VALID_INVOICE/)
  assert.match(migration, /AMBIGUOUS_SALES_ID_MATCH/)
  assert.match(migration, /INVOICE_ID_MISMATCH/)
  assert.match(migration, /p_invoice_number IS NOT NULL AND p_invoice_number IS DISTINCT FROM invoice_number/)
  assert.match(migration, /INVOICE_NUMBER_MISMATCH/)
})

test('productos, cantidades, referencias, faltantes y duplicados quedan protegidos', () => {
  assert.match(migration, /actual_count <> expected_count/)
  assert.match(migration, /duplicate_expected/)
  assert.match(migration, /duplicate_actual/)
  assert.match(migration, /x\.quantity IS DISTINCT FROM coalesce\(e\.billable_quantity, e\.quantity\)/)
  assert.match(migration, /x\.variant_id IS DISTINCT FROM e\.variant_id/)
  assert.match(migration, /x\.variant_code IS DISTINCT FROM e\.sku/)
  assert.match(migration, /RELATED_DETAIL_ID_NOT_PROVABLE/)
  assert.match(migration, /INVOICE_ALREADY_LINKED/)
  assert.match(migration, /INVOICE_LINK_CONFLICT/)
})

test('reconciliación y confirmación protegen tarjeta, permisos, auditoría e idempotencia', () => {
  assert.match(migration, /FOR UPDATE/)
  assert.match(migration, /logistica\.preparation_card_is_excluded\(a\.company_id, a\.card_id\)/)
  assert.match(migration, /current_bsale_nv_id IS DISTINCT FROM a\.current_bsale_nv_id/)
  assert.match(migration, /card_row\.closure_reason IS DISTINCT FROM 'INVOICED'/)
  assert.match(migration, /CARD_CANCELLED/)
  assert.match(migration, /status = CASE WHEN status = 'AUDITED' THEN 'INVOICED_READY_FOR_ROUTE'/)
  assert.match(migration, /INSERT INTO integraciones\.bsale_invoice_sales_order_links/)
  assert.match(migration, /UPDATE logistica\.sales_order_invoice_attempts[\s\S]*SET status = 'CONFIRMED'/)
  assert.match(migration, /INVOICE_RECONCILIATION_CONFIRMED/)
  assert.match(migration, /'invoice_total', validation->'invoice_total'/)
  assert.match(migration, /'expected_total', validation->'expected_total'/)
  assert.match(migration, /'difference', difference/)
  assert.match(migration, /NOT EXISTS \([\s\S]*event_type = 'INVOICE_RECONCILIATION_CONFIRMED'/)
  assert.match(migration, /idempotent', was_confirmed/)
})

test('la migración histórica permanece intacta y el contrato de MEJ-03A no se toca', () => {
  assert.match(historical, /CREATE OR REPLACE FUNCTION logistica\.reconcile_sales_order_invoice_attempt/)
  assert.match(historical, /RECONCILIATION_REQUIRED/)
})
