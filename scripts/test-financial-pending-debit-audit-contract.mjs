import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const classification = await readFile(new URL('../src/app/actions/control-financiero/classification.ts', import.meta.url), 'utf8')
const bankStatements = await readFile(new URL('../src/app/actions/control-financiero/bank-statements.ts', import.meta.url), 'utf8')
const cashFlow = await readFile(new URL('../src/modules/analisis-comercial/control-financiero/components/cash-flow-client.tsx', import.meta.url), 'utf8')

const auditAction = classification.slice(classification.indexOf('export async function getPendingDebitAudit'), classification.indexOf('export type PendingDebitAuditMovement'))

test('pending debit audit is multibank and category agnostic', () => {
  assert.match(auditAction, /p_bank_account_id: input\.bankAccountId \?\? null/)
  assert.match(auditAction, /bankName/)
  assert.match(auditAction, /maskedAccountNumber/)
  assert.doesNotMatch(auditAction, /EXPENSE_PERSONNEL_CASH/)
  assert.match(classification, /getDebitCategory\(companyId, input\.categoryId\)/)
  assert.match(classification, /p_source: 'BULK_EXACT'/)
})

test('audit rule creation is exact, bank-scoped, AUTO, and idempotent', () => {
  assert.match(classification, /\.in\('bank_account_id', accountIds/)
  assert.match(classification, /\.eq\('match_type', 'EXACT'\)/)
  assert.match(classification, /p_mode: 'AUTO'/)
  assert.match(classification, /const rulesByScope = new Map<string, any\[\]>/)
  assert.match(classification, /createRule\?: boolean/)
})

test('import auto-classifies only unambiguous active AUTO rules', () => {
  assert.match(bankStatements, /function applyAutoDebitRules/)
  assert.match(bankStatements, /\.eq\("mode", "AUTO"\)/)
  assert.match(bankStatements, /\.eq\("active", true\)/)
  assert.match(bankStatements, /const categoryIds = \[\.\.\.new Set/)
  assert.match(bankStatements, /p_source: "AUTO_RULE"/)
  assert.match(bankStatements, /p_only_pending: true/)
  assert.match(bankStatements, /newRows\.map\(\(\{ key \}\) => key\.movement_identity\)/)
})

test('audit UI defaults to all accounts and exposes bank/category controls', () => {
  assert.match(cashFlow, /setAuditAccountId\(ALL_ACCOUNTS\)/)
  assert.match(cashFlow, /value=\{accountId\}.*Todas las cuentas/s)
  assert.match(cashFlow, /group\.bankName/)
  assert.match(cashFlow, /debitCategoryGroups\(categories\)/)
  assert.doesNotMatch(cashFlow, /data\.category\.id/)
})
