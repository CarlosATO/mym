import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260827230000_secure_pending_route_fund_groups_history_read.sql', import.meta.url), 'utf8')

test('el read-model de fondos pendientes encapsula el historial interno', () => {
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /core\.has_company_access\(v_actor, p_company_id\)/)
  assert.match(migration, /portal\.user_has_permission\(v_actor, 'adquisiciones\.route_fund_closures\.view'\)/)
  assert.match(migration, /REVOKE ALL ON FUNCTION adquisiciones\.get_pending_route_fund_groups\(uuid\)/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.get_pending_route_fund_groups\(uuid\)\s+TO authenticated/)
  assert.doesNotMatch(migration, /GRANT SELECT ON TABLE.*route_settlement_check_status_history/)
})
