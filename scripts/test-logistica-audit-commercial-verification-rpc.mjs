import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261109090000_logistica_audit_commercial_verification_rpc.sql', import.meta.url), 'utf8')

test('la migración solo define la RPC y sus permisos', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.record_sales_order_audit_commercial_verification_v1\(/)
  for (const parameter of ['p_company_id uuid', 'p_card_id uuid', 'p_audit_id uuid', 'p_status text', 'p_current_bsale_nv_id bigint', 'p_canonical_bsale_token text', 'p_reason text', 'p_fingerprint text', 'p_snapshot jsonb', 'p_differences jsonb']) {
    assert.match(migration, new RegExp(parameter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.doesNotMatch(migration, /CREATE TABLE|CREATE OR REPLACE VIEW|CREATE TRIGGER|CREATE POLICY/)
  assert.doesNotMatch(migration, /verify_open_preparation_incidents_v1|sales_order_route_readiness/)
})

test('la RPC protege identidad, snapshot y estado comercial', () => {
  assert.match(migration, /AUDIT_COMMERCIAL_VERIFICATION_DENIED/)
  assert.match(migration, /AUDIT_COMMERCIAL_STALE_VERSION/)
  assert.match(migration, /AUDIT_COMMERCIAL_READY_WITH_DIFFERENCES/)
  assert.match(migration, /AUDIT_COMMERCIAL_INCIDENTS_INCOHERENT/)
  assert.match(migration, /AUDIT_COMMERCIAL_CURRENT_SNAPSHOT_INCOHERENT/)
  assert.match(migration, /SET is_current = false/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.record_sales_order_audit_commercial_verification_v1/)
})
