import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260827200000_route_settlement_check_registry_v1.sql', import.meta.url), 'utf8')
const pendingGuard = await readFile(new URL('../supabase/migrations/20260827202000_route_settlement_check_registry_pending_guard.sql', import.meta.url), 'utf8')

test('el registro conserva Payment como identidad y no crea una tabla maestra duplicada', () => {
  assert.match(migration, /payment_id uuid NOT NULL REFERENCES adquisiciones\.route_settlement_payments\(id\)/)
  assert.match(migration, /CREATE TABLE adquisiciones\.route_settlement_check_status_history/)
  assert.doesNotMatch(migration, /CREATE TABLE adquisiciones\.(?:checks|cheques)(?:\s|\()/i)
})

test('las transiciones operativas son monotónicas y anuladas por el Payment', () => {
  assert.match(migration, /ENTREGADO_A_DEPOSITO.*DEPOSITADO.*ANULADO/s)
  assert.match(migration, /v_current := COALESCE\(v_current, 'EN_CUSTODIA'\)/)
  assert.match(migration, /v_current = 'ANULADO'.*no puede volver a operación/s)
  assert.match(migration, /v_current = 'DEPOSITADO'.*ya está depositado/s)
  assert.match(migration, /OLD\.voided_at IS NULL/)
  assert.match(migration, /OLD\.verification_status IS DISTINCT FROM 'VOIDED'/)
  assert.match(migration, /AFTER UPDATE OF verification_status, voided_at, voided_by, void_reason/)
})

test('el read-model expone contexto y filtros operacionales por empresa', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION adquisiciones\.get_route_settlement_check_registry/)
  for (const field of ['customer_name', 'customer_rut', 'check_date', 'amount', 'check_number', 'bank_name', 'guide_number', 'settlement_number', 'fund_closure_number', 'operational_status', 'received_at', 'delivered_to_deposit_at', 'deposited_at', 'annulled_at']) {
    assert.match(migration, new RegExp(`\\n    ${field} `))
  }
  for (const filter of ['p_customer', 'p_check_number', 'p_bank', 'p_guide_number', 'p_settlement_number', 'p_status', 'p_check_date_from', 'p_check_date_to']) {
    assert.match(migration, new RegExp(filter))
  }
  assert.match(migration, /core\.has_company_access\(v_actor, p\.company_id\)/)
})

test('CFC no cambia el estado del cheque y los estados no se exponen por acceso directo', () => {
  assert.doesNotMatch(migration, /route_fund_closure_items[\s\S]{0,500}DEPOSITADO/)
  assert.match(migration, /REVOKE ALL ON adquisiciones\.route_settlement_check_status_history FROM PUBLIC, anon, authenticated/)
  assert.match(migration, /ROUTE_SETTLEMENT_CHECK_STATUS_CHANGED/)
})

test('depositados y anulados no reaparecen como pendientes de CFC', () => {
  assert.match(pendingGuard, /CREATE OR REPLACE FUNCTION adquisiciones\.validate_route_fund_closure_check_status/)
  assert.match(pendingGuard, /h\.status IN \('DEPOSITADO', 'ANULADO'\)/)
  assert.match(pendingGuard, /trg_validate_route_fund_closure_check_status/)
  assert.match(pendingGuard, /CREATE OR REPLACE FUNCTION adquisiciones\.get_pending_route_fund_groups/)
  assert.match(pendingGuard, /route_settlement_check_status_history[\s\S]*h\.status IN \('DEPOSITADO', 'ANULADO'\)/)
})
