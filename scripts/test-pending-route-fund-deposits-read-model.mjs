import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260827240000_pending_route_fund_deposits_read_model.sql', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/adquisiciones/route-fund-closures.ts', import.meta.url), 'utf8')

test('el read-model exige empresa, sesión y permiso de consulta', () => {
  assert.match(migration, /auth\.uid\(\)/)
  assert.match(migration, /core\.has_company_access\(v_actor, p_company_id\)/)
  assert.match(migration, /portal\.user_has_permission\(v_actor, 'adquisiciones\.route_fund_closures\.view'\)/)
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /SET search_path = pg_catalog, adquisiciones, logistica, core, portal/)
  assert.match(migration, /REVOKE ALL ON FUNCTION adquisiciones\.get_pending_route_fund_deposits/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION adquisiciones\.get_pending_route_fund_deposits.*TO authenticated/s)
})

test('el cálculo usa depósitos activos y vínculos explícitos de cheques', () => {
  assert.match(migration, /d\.status = 'ACTIVE'/)
  assert.match(migration, /route_fund_closure_deposit_checks/)
  assert.match(migration, /amount - linked_check_amount/)
  assert.match(migration, /l\.payment_id IS NULL/)
  assert.match(migration, /WHERE NOT c\.legacy_unresolved/)
  assert.match(migration, /s\.total_pending > 0/)
})

test('el action expone filtros y devuelve el contrato tipado', () => {
  assert.match(action, /export interface PendingRouteFundDepositFilters/)
  assert.match(action, /getPendingRouteFundDeposits\(filters: PendingRouteFundDepositFilters = \{\}\)/)
  assert.match(action, /get_pending_route_fund_deposits/)
  assert.match(action, /as PendingRouteFundDeposit\[\]/)
})
