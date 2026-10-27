import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261026180000_logistica_invoice_condition_fallback.sql', root), 'utf8')
const rollback = await readFile(new URL('supabase/rollback/20261026180000_logistica_invoice_condition_fallback.sql', root), 'utf8')

test('reemplaza ambas funciones conservando firma, seguridad y search_path', () => {
  assert.equal((migration.match(/CREATE OR REPLACE FUNCTION logistica\.invoice_attempt_prevalidate\(/g) ?? []).length, 1)
  assert.equal((migration.match(/CREATE OR REPLACE FUNCTION logistica\.prepare_sales_order_invoice_attempt\(/g) ?? []).length, 1)
  assert.match(migration, /invoice_attempt_prevalidate\([\s\S]*?RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER\nSET search_path = pg_catalog, public, auth, core, logistica, integraciones/)
  assert.match(migration, /prepare_sales_order_invoice_attempt\([\s\S]*?RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER\nSET search_path = pg_catalog, public, auth, core, logistica, integraciones/)
  assert.match(migration, /REVOKE ALL|GRANT EXECUTE/)
})

test('prioriza condición documental válida y sólo usa cliente cuando falta', () => {
  assert.match(migration, /COALESCE\(doc_row\.raw_json->'saleCondition'->>'id', doc_row\.raw_json->'sale_condition'->>'id'\)/)
  assert.match(migration, /document_sale_condition_raw IS NOT NULL/)
  assert.match(migration, /document_sale_condition_raw !~ '\^\[0-9\]\+\$'/)
  assert.match(migration, /integraciones\.bsale_clients client_row[\s\S]*JOIN integraciones\.bsale_sale_conditions condition_row/)
  assert.match(migration, /client_row\.bsale_client_id = doc_row\.client_id/)
  assert.match(migration, /condition_row\.company_id = client_row\.company_id[\s\S]*condition_row\.state = 0/)
})

test('mantiene bloqueos de negocio y no acepta condiciones inválidas', () => {
  for (const blocker of [
    'STATUS_NOT_AUDITED',
    'READINESS_NOT_READY_TO_INVOICE',
    'CURRENT_DOCUMENT_NOT_FOUND',
    'DOCUMENT_TYPE_NOT_SALES_ORDER',
    'BSALE_STATE_NOT_ACTIVE',
    'CLIENT_INVALID',
    'OFFICE_INVALID',
    'NOT_READY_CONTRACT',
    'OPEN_COMMERCIAL_INCIDENTS',
    'DETAILS_MISSING',
    'INVALID_QUANTITY:',
    'OVERCONSUMED:',
    'ZERO_BILLABLE_SALDO',
  ]) assert.match(migration, new RegExp(blocker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(migration, /condition_row\.bsale_id = document_sale_condition_id/)
  assert.match(migration, /condition_row\.state = 0/)
})

test('el flujo legado persiste la condición efectiva en el snapshot', () => {
  assert.match(migration, /effective_sale_condition_id bigint/)
  assert.match(migration, /IF effective_sale_condition_id IS NULL THEN/)
  assert.match(migration, /'sale_condition_id',effective_sale_condition_id/)
  assert.doesNotMatch(migration, /POST \/v1\/documents|fetch\([^\n]*documents\.json/)
})

test('el rollback restaura el bloqueo exclusivamente documental', () => {
  assert.match(rollback, /doc_row\.raw_json->'saleCondition'->>'id' IS NULL/)
  assert.doesNotMatch(rollback, /bsale_clients client_row/)
  assert.match(rollback, /'sale_condition_id',doc\.raw_json->'saleCondition'->>'id'/)
})
