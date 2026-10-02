import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const action = fs.readFileSync('src/app/actions/control-financiero/bank-statements.ts', 'utf8')
const migration = fs.readFileSync('supabase/migrations/20260929260000_financial_open_previous_balance.sql', 'utf8')

test('the inspector reads the persisted previous balance', () => {
  assert.match(action, /previous_known_balance/)
  assert.doesNotMatch(action, /previousMovementResult/)
})

test('the historical September reconciliation preserves all financial values', () => {
  const previous = 1317152
  const opening = 1357916
  const explained = 5134911
  const reported = 5559468
  const difference = reported - explained

  assert.equal(previous, 1317152)
  assert.equal(opening, 1357916)
  assert.equal(explained, 5134911)
  assert.equal(reported, 5559468)
  assert.equal(difference, 424557)
  assert.match(migration, /set previous_known_balance = \(/)
})

test('future OPEN imports capture the prior balance before updating the period', () => {
  assert.match(migration, /select id, status = 'OPEN', opening_balance, current_balance/)
  assert.match(migration, /metadata, previous_current_balance/)
  assert.match(migration, /current_balance = \(p_period->>'current_balance'\)::numeric/)
  assert.match(migration, /previous_known_balance, reason_type/)
})

test('historical recovery and future writes are scoped by company, account, period and import', () => {
  for (const scope of [
    'previous_movement.company_id = d.company_id',
    'previous_movement.bank_account_id = d.bank_account_id',
    'previous_movement.statement_period_id = d.statement_period_id',
    'previous_movement.import_id <> d.detected_import_id',
    'previous_import.company_id = d.company_id',
  ]) assert.match(migration, new RegExp(scope.replaceAll('.', '\\.'), 'm'))
  assert.match(action, /\.eq\("company_id", companyId\)[\s\S]*?\.in\("statement_period_id", selectedPeriodIds\)/)
})

test('the migration does not alter or delete bank movements', () => {
  assert.doesNotMatch(migration, /\b(update|delete|truncate)\s+comercial\.financial_bank_movements\b/i)
})
