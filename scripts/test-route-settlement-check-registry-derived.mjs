import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260827210000_route_settlement_check_registry_derived_location.sql', import.meta.url), 'utf8')
const relation = await readFile(new URL('../supabase/migrations/20260827205000_route_fund_closure_deposit_check_items.sql', import.meta.url), 'utf8')

test('deriva custodio y tesorería desde ítems activos de CFC', () => {
  assert.match(migration, /i\.released_at IS NULL/)
  assert.match(migration, /f\.status IN \('OPEN', 'PARTIAL', 'CLOSED', 'WITH_DIFFERENCE'\)/)
  assert.match(migration, /WHEN ac\.fund_closure_id IS NOT NULL THEN 'EN_TESORERIA'/)
  assert.match(migration, /ELSE 'CON_CUSTODIO'/)
})

test('los depósitos nuevos identifican cheques y los legacy no se atribuyen', () => {
  assert.match(relation, /deposit_id uuid NOT NULL/)
  assert.match(relation, /payment_id uuid NOT NULL REFERENCES adquisiciones\.route_settlement_payments/)
  assert.match(relation, /p_check_payment_ids uuid\[\]/)
  assert.match(migration, /LEFT JOIN active_deposit ad ON ad\.payment_id = p\.id/)
  assert.match(relation, /d\.status = 'ACTIVE'/)
  assert.doesNotMatch(migration, /p\.amount_received\s*<=.*d\.amount/i)
})

test('prioriza anulación del Payment', () => {
  assert.match(migration, /p\.voided_at IS NOT NULL OR p\.verification_status = 'VOIDED'/)
  assert.match(migration, /THEN 'ANULADO'/)
})

test('protege la relación contra duplicados activos y exige pertenencia al CFC', () => {
  assert.match(relation, /El cheque ya pertenece a otro depósito activo/)
  assert.match(relation, /El cheque no pertenece al Cierre de Fondos del depósito/)
  assert.match(relation, /El cheque y el depósito deben pertenecer a la misma empresa/)
  assert.match(relation, /v_payment\.payment_method_received <> 'CHECK'/)
  assert.match(relation, /d\.status = 'ACTIVE'/)
})

test('permite depósitos parciales y conserva asociaciones al anular', () => {
  assert.match(relation, /INSERT INTO adquisiciones\.route_fund_closure_deposit_checks/)
  assert.match(migration, /LEFT JOIN active_deposit ad ON ad\.payment_id = p\.id/)
  assert.doesNotMatch(relation, /DELETE FROM adquisiciones\.route_fund_closure_deposit_checks/)
})
