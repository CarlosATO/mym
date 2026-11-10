import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261110120000_logistica_finalize_audit_commercial_guard.sql', root), 'utf8')
const action = await readFile(new URL('src/app/actions/logistica/sales-order-audit.ts', root), 'utf8')

function closureBody() {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION logistica.finalize_sales_order_audit')
  assert.ok(start >= 0)
  return migration.slice(start, migration.indexOf('REVOKE ALL ON FUNCTION logistica.finalize_sales_order_audit', start))
}

test('sin verificación persistida no se puede finalizar', () => {
  const body = closureBody()
  assert.match(body, /sales_order_audit_commercial_verifications/)
  assert.match(body, /No existe una verificación comercial vigente para esta Auditoría\./)
  assert.match(body, /is_current = true/)
})

test('BLOCKED, INCIDENTS y diferencias comerciales bloquean', () => {
  const body = closureBody()
  assert.match(body, /v_verification\.status <> 'READY_TO_INVOICE'/)
  assert.match(body, /jsonb_array_length\(v_verification\.differences\) <> 0/)
  assert.match(body, /comparison.*differences/)
})

test('la verificación debe pertenecer a la misma empresa, tarjeta y auditoría', () => {
  const body = closureBody()
  assert.match(body, /company_id = p_company_id/)
  assert.match(body, /card_id = p_card_id/)
  assert.match(body, /audit_id = p_audit_id/)
  assert.match(body, /v_snapshot->'identity'->>'companyId'/)
  assert.match(body, /v_snapshot->>'auditId'/)
})

test('identidad canónica y documento Bsale deben seguir vigentes', () => {
  const body = closureBody()
  assert.match(body, /canonical_bsale_token IS DISTINCT FROM v_card\.canonical_bsale_token/)
  assert.match(body, /current_bsale_nv_id IS DISTINCT FROM v_card\.current_bsale_nv_id/)
  assert.match(body, /vw_bsale_sales_order_documents_canonical/)
  assert.match(body, /documento comercial vigente/)
})

test('snapshot y fingerprint son obligatorios y la finalización conserva el registro', () => {
  const body = closureBody()
  assert.match(body, /fingerprint !~ '\^\[0-9A-Fa-f\]\{64\}\$'/)
  assert.match(body, /jsonb_typeof\(v_verification\.snapshot\)/)
  assert.match(body, /commercial_verification_id/)
  assert.match(action, /No se puede finalizar la Auditoría: existen diferencias comerciales pendientes\./)
})

test('la migración es nueva y no altera la migración histórica', async () => {
  const historical = await readFile(new URL('supabase/migrations/20261020160000_logistica_finalize_sales_order_audit.sql', root), 'utf8')
  assert.match(migration, /prospective/i)
  assert.notEqual(migration, historical)
})
