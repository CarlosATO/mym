import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// P0-01 - contrato de no-regresión de materialización; no modifica datos reales.
const current = await readFile(
  new URL('../supabase/migrations/20261103121029_logistica_snapshot_existing_lines_guard.sql', import.meta.url),
  'utf8',
)
const previous = await readFile(
  new URL('../supabase/migrations/20261028175733_logistica_initial_snapshot_current_nv_guarded.sql', import.meta.url),
  'utf8',
)

function acceptedBlock(sql) {
  const start = sql.indexOf('  IF FOUND THEN\n    -- La tarjeta puede apuntar')
  const stop = sql.indexOf('  -- No se reconstruye el snapshot', start)
  assert.ok(start >= 0 && stop > start, 'No se pudo aislar el contrato de aceptación')
  return sql.slice(start, stop)
}

test('única función modificada, aceptación comercial intacta', () => {
  assert.equal((current.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1)
  assert.match(current, /CREATE OR REPLACE FUNCTION logistica\.materialize_sales_order_preparation_snapshot/)
  assert.equal(acceptedBlock(current), acceptedBlock(previous))
  assert.doesNotMatch(current, /DELETE FROM logistica\.sales_order_preparation_lines/)
  assert.doesNotMatch(current, /UPDATE logistica\.sales_order_preparation_lines/)
})

test('nunca agrega líneas si ya existen; valida antes de retornar', () => {
  const existing = current.indexOf('  -- P0-01: El snapshot inicial es inmutable')
  const empty = current.indexOf('  -- Sin lineas ni version aceptada:')
  const insert = current.indexOf('  INSERT INTO logistica.sales_order_preparation_lines')
  assert.ok(existing >= 0 && empty > existing && insert > empty)
  const section = current.slice(existing, empty)
  assert.match(section, /IF EXISTS \([\s\S]*?FROM logistica\.sales_order_preparation_lines/)
  assert.match(section, /min\(l\.bsale_nv_id\), max\(l\.bsale_nv_id\)/)
  assert.match(section, /v_existing_min_nv_id IS DISTINCT FROM v_existing_max_nv_id/)
  assert.match(section, /det\.bsale_document_id = v_existing_min_nv_id/)
  assert.match(section, /EXCEPT ALL/)
  assert.match(section, /RETURN 0;[\s\S]*?END IF;/)
  assert.doesNotMatch(section, /INSERT INTO logistica\.sales_order_preparation_lines/)
})

test('compara cambios comerciales, no solo IDs físicos', () => {
  assert.match(current, /v_card\.status = 'IN_PREPARATION'/)
  assert.match(current, /v_existing_min_nv_id IS DISTINCT FROM[\s\S]*?COALESCE\(v_card\.current_bsale_nv_id, v_card\.bsale_nv_id\)/)
  for (const field of ['variant_id', 'quantity', 'net_unit_value', 'net_amount', 'tax_amount', 'total_amount']) {
    assert.ok(current.includes('det.' + field), field)
  }
  assert.match(current, /SELECT \* FROM previous_lines EXCEPT ALL SELECT \* FROM current_lines/)
  assert.match(current, /SELECT \* FROM current_lines EXCEPT ALL SELECT \* FROM previous_lines/)
  assert.match(current, /original\.exempt_amount IS DISTINCT FROM current_nv\.exempt_amount/)
  assert.match(current, /Cambio comercial pendiente en Bsale: reconciliar/)
})

test('materialización inicial conserva validación vigente e idempotencia', () => {
  assert.match(current, /v_initial_nv_id := v_card\.bsale_nv_id;/)
  assert.match(current, /v_card\.current_bsale_nv_id IS DISTINCT FROM v_card\.bsale_nv_id/)
  assert.match(current, /nv\.state = 0/)
  assert.match(current, /nv\.number::text = v_card\.bsale_nv_folio/)
  assert.match(current, /nullif\(btrim\(nv\.raw_json->>'token'\), ''\) = v_card\.canonical_bsale_token/)
  assert.match(current, /ON CONFLICT \(company_id, card_id, bsale_detail_id\) DO NOTHING;/)
  assert.match(current, /No se encontraron productos de la Nota de Venta/)
})

test('regla de oro: la función no cambia pedidos confirmados ni facturación', () => {
  assert.doesNotMatch(current, /(?:UPDATE|DELETE FROM)\s+logistica\.sales_order_preparation_cards\b/i)
  assert.doesNotMatch(current, /(?:UPDATE|DELETE FROM)\s+logistica\.sales_order_audit/i)
  assert.doesNotMatch(current, /(?:UPDATE|DELETE FROM)\s+logistica\.sales_order_invoice_attempts/i)
  assert.doesNotMatch(current, /(?:UPDATE|DELETE FROM)\s+integraciones\.bsale_documents/i)
})
