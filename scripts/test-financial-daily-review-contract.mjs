import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const migration = readFileSync('supabase/migrations/20261003210000_financial_daily_review_control.sql', 'utf8')
const actions = readFileSync('src/app/actions/control-financiero/classification.ts', 'utf8')
const cashFlow = readFileSync('src/app/actions/control-financiero/bank-statements.ts', 'utf8')
const pAndL = readFileSync('services/finance-api/app/financial/expenses.py', 'utf8')

test('review status has historical and daily cutoff semantics', () => {
  assert.match(migration, /transaction_date < date '2026-10-01' then 'HISTORICAL'/)
  assert.match(migration, /else 'PENDING'/)
  assert.match(migration, /direction <> 'DEBE' or direction is null/)
  assert.match(migration, /review_status = 'REVIEWED'/)
})

test('classification confirmation preserves rule metadata and manual correction clears it', () => {
  assert.match(migration, /confirm_financial_bank_movement_classification/)
  assert.match(actions, /confirmFinancialMovementClassification/)
  assert.match(migration, /classification_source = 'MANUAL'/)
  assert.match(migration, /classification_rule_id = null/)
})

test('cash flow exposes the four review filters and P&L uses reviewed post-cutoff movements', () => {
  assert.match(cashFlow, /"REVIEWED" \| "HISTORICAL"/)
  assert.match(cashFlow, /review_status.*PENDING/)
  assert.match(pAndL, /review_status = 'REVIEWED'/)
  assert.match(pAndL, /EXPENSE_INSURANCE/)
  assert.doesNotMatch(pAndL, /financial_expense_entries/)
})
