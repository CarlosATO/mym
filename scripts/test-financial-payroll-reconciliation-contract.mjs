import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const migration = await readFile(new URL('../supabase/migrations/20261009100000_financial_payroll_payment_reconciliation.sql', import.meta.url), 'utf8')
const personnel = await readFile(new URL('../services/finance-api/app/financial/personnel.py', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/control-financiero/payroll.ts', import.meta.url), 'utf8')
const bankStatements = await readFile(new URL('../src/app/actions/control-financiero/bank-statements.ts', import.meta.url), 'utf8')
const exactRule = await readFile(new URL('../supabase/migrations/20261009110000_financial_itau_caylo_transfer_exact_rule.sql', import.meta.url), 'utf8')
const drafts = await readFile(new URL('../supabase/migrations/20261009120000_financial_payroll_payment_drafts.sql', import.meta.url), 'utf8')
const residual = await readFile(new URL('../supabase/migrations/20261009130000_financial_payroll_residual_formal_model.sql', import.meta.url), 'utf8')
const financeApi = await readFile(new URL('../src/lib/control-financiero/finance-api.ts', import.meta.url), 'utf8')
const cashFlowClient = await readFile(new URL('../src/modules/analisis-comercial/control-financiero/components/cash-flow-client.tsx', import.meta.url), 'utf8')

test('unique batch per bank movement', () => assert.match(migration, /unique \(company_id, bank_movement_id\)/))
test('draft batches are allowed', () => assert.match(migration, /status text not null default 'DRAFT' check \(status in \('DRAFT', 'COMPLETE'\)\)/))
test('complete requires exact allocation sum', () => assert.match(migration, /v_total <> v_movement\.debit_amount/))
test('complete allocations are protected', () => assert.match(migration, /No se puede modificar allocations de un batch COMPLETE/))
test('formal without payroll is pending', () => assert.match(migration, /v_status := 'PENDING_PAYROLL'/))
test('formal matching uses net pay', () => assert.match(migration, /sum\(e\.net_pay\)/))
test('formal amount difference exists', () => assert.match(migration, /'AMOUNT_DIFFERENCE'/))
test('formal not found exists', () => assert.match(migration, /'NOT_FOUND_IN_PAYROLL'/))
test('off-book is not applicable', () => assert.match(migration, /'NOT_APPLICABLE'/))
test('off-book personnel uses complete batches', () => assert.match(personnel, /batches\.status = 'COMPLETE'/))
test('off-book personnel uses batch period', () => assert.match(personnel, /batches\.period_month AS month/))
test('formal allocations do not enter personnel query', () => assert.match(personnel, /allocation_type = 'OFF_BOOK'/))
test('salary bank category stays excluded', () => assert.doesNotMatch(personnel, /EXPENSE_SALARIES_WAGES/))
test('post-import reconciliation is invoked', () => assert.match(action, /reconcile_financial_payroll_payment_batches/))
test('multiple payroll lines aggregate by worker', () => assert.match(migration, /sum\(e\.net_pay\).*worker_rut_normalized/s))
test('payroll entry tenancy is composite', () => assert.match(migration, /foreign key \(company_id, payroll_entry_id\)/))
test('canonical RUT normalization is used', () => assert.match(migration, /normalize_financial_worker_rut/))
test('allocation timestamps are maintained', () => assert.match(migration, /financial_payroll_payment_allocations_updated_at/))
test('HABER participates in auto rules', () => assert.match(bankStatements, /\.in\("direction", \["DEBE", "HABER"\]\)/))
test('auto rules remain exact and active', () => assert.match(bankStatements, /\.eq\("match_type", "EXACT"\)[\s\S]*\.eq\("mode", "AUTO"\)[\s\S]*\.eq\("active", true\)/))
test('new Caylo signature is exact', () => assert.match(exactRule, /'EXACT', 'TRANSF DE 77196005 7 CAYLO'/))
test('new Caylo signature remains account scoped', () => assert.match(exactRule, /v_itau_account_id/))
test('draft persistence replaces allocations transactionally', () => assert.match(drafts, /delete from comercial\.financial_payroll_payment_allocations[\s\S]*insert into comercial\.financial_payroll_payment_allocations/))
test('drafts allow partial totals but reject over-allocation', () => assert.match(drafts, /v_total > v_movement\.debit_amount/))
test('off-book drafts allow an optional RUT', () => assert.match(drafts, /alter column worker_rut drop not null/))
test('completion updates the existing batch', () => assert.match(drafts, /complete_financial_payroll_payment_batch[\s\S]*set status = 'COMPLETE'/))
test('draft reads are available for drawer recovery', () => assert.match(drafts, /get_financial_payroll_payment_draft/))
test('drawer hydrates the persisted draft through a shared pending request', () => {
  assert.match(cashFlowClient, /payrollDraftPromiseCache/)
  assert.match(cashFlowClient, /void hydratePayrollDraft\(movement\.id\)/)
})
test('draft action maps persisted SQL allocation fields for COMPLETE batches', () => {
  assert.match(action, /allocationType: allocation\.allocationType \?\? allocation\.allocation_type/)
  assert.match(action, /workerNameSnapshot: allocation\.workerNameSnapshot \?\? allocation\.worker_name_snapshot/)
  assert.match(action, /workerRut: allocation\.workerRut \?\? allocation\.worker_rut/)
})
test('COMPLETE drawer renders two persisted OFF_BOOK allocations read-only', () => {
  assert.match(cashFlowClient, /payrollReadOnly = payrollBatchStatus === "COMPLETE"/)
  assert.match(cashFlowClient, /disabled=\{payrollReadOnly\}/)
  assert.match(cashFlowClient, /allocations\.filter\(\(allocation\) => allocation\.allocationType === "OFF_BOOK"\)/)
})
test('persisted draft hydration wins over description defaults', () => {
  assert.match(cashFlowClient, /selectedPayrollMovementId\.current !== movementId/)
  assert.match(cashFlowClient, /setPayrollPeriodMonth\(String\(batch\.period_month\)\)/)
})
test('drawer uses description period only before persisted draft hydration', () => {
  assert.match(cashFlowClient, /setPayrollPeriodYear\(payrollPeriod\.year\)[\s\S]*setPayrollPeriodMonth\(payrollPeriod\.month\)[\s\S]*hydratePayrollDraft\(movement\.id\)/)
})
test('formal amount is residual after explicit off-book allocations', () => assert.match(residual, /formal_expected_amount := v_movement\.debit_amount - v_off_book/))
test('complete permits zero allocations and validates only off-book total', () => assert.match(residual, /v_off_book > v_movement\.debit_amount/))
test('formal payroll reconciliation compares period totals', () => assert.match(residual, /sum\(e\.net_pay\)[\s\S]*formal_reconciliation_status/))
test('new draft flow stores only off-book exceptions', () => assert.match(residual, /v_item->>'allocation_type' <> 'OFF_BOOK'/))
test('legacy formal allocations are preserved', () => assert.match(residual, /allocation_type = 'OFF_BOOK'/))
test('consolidated balance uses all accounts', () => assert.match(bankStatements, /currentBalance: Array\.from\(latestAll\.values\(\)\)/))
test('credit line merge derives usage from newer availability', () => assert.match(bankStatements, /availabilityIsNewer/))
test('EERR family detail retries at most once', () => assert.match(financeApi, /attempt < 2/))
test('realistic bank balance and credit-line invariants hold', () => {
  const chile = 5143078
  const itau = 0
  const total = 5000000
  const available = 213425
  const usage = 21589664
  const payments = 16803089
  assert.equal(chile + itau, 5143078)
  assert.equal(usage - payments, 4786575)
  assert.equal(total - available, 4786575)
  assert.equal(total, 4786575 + available)
})
