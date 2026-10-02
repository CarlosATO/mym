import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20261003200000_financial_expense_entries.sql', import.meta.url), 'utf8')
const allowlistMigration = await readFile(new URL('../supabase/migrations/20261003200200_financial_expense_category_allowlist.sql', import.meta.url), 'utf8')
const actions = await readFile(new URL('../src/app/actions/control-financiero/recognized-expenses.ts', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/app/dashboard/analisis-comercial/control-financiero/gastos-reconocidos/page.tsx', import.meta.url), 'utf8')
const client = await readFile(new URL('../src/modules/analisis-comercial/control-financiero/components/recognized-expenses-client.tsx', import.meta.url), 'utf8')

test('recognized expense model is independent and multi-bank capable', () => {
  assert.match(migration, /create table comercial\.financial_expense_entries/)
  assert.match(migration, /create table comercial\.financial_expense_bank_links/)
  assert.match(migration, /unique \(company_id, idempotency_key\)/)
  assert.match(migration, /status in \('DRAFT', 'POSTED', 'VOIDED'\)/)
  assert.match(migration, /source_type in \('MANUAL', 'BANK_LINKED', 'IMPORT'\)/)
  assert.match(migration, /m\.direction <> 'DEBE'/)
  assert.match(migration, /c\.affects_pnl_directly/)
  assert.match(migration, /El motivo de anulación es obligatorio/)
})

test('recognized expense eligibility is an explicit backend allow-list', () => {
  assert.match(allowlistMigration, /financial_expense_recognition_allowed_codes/)
  assert.match(allowlistMigration, /EXPENSE_EXTERNAL_SERVICES.*EXPENSE_INSURANCE.*EXPENSE_TELECOM/)
  assert.match(allowlistMigration, /c\.code = any\(comercial\.financial_expense_recognition_allowed_codes\(\)\)/)
  for (const code of ['EXPENSE_SUPPLIERS', 'EXPENSE_FINANCING', 'COLLECTION_REVERSAL', 'EXPENSE_PERSONNEL_OFF_BOOK']) {
    assert.doesNotMatch(allowlistMigration, new RegExp(`array\\[[^;]*${code}`))
  }
  assert.match(actions, /get_financial_expense_recognition_categories/)
})

test('server actions enforce company and functional write permission', () => {
  assert.match(actions, /getActiveCompanyId\(user\)/)
  assert.match(actions, /analisis_comercial\.control_financiero\.manage_expenses/)
  assert.match(actions, /createAdminClient\(\)\.schema\('comercial'\)/)
  assert.match(actions, /idempotencyKey/)
})

test('UI exposes the independent recognized-expense workflow without P&L integration', () => {
  assert.match(client, /Gastos Reconocidos/)
  assert.match(client, /createRecognizedExpense|postRecognizedExpense|voidRecognizedExpense/)
  assert.doesNotMatch(page, /estado-resultados|statement|expenses\.py/)
})
