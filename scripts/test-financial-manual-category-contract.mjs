import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { eligibleFinancialCategories } from '../src/lib/control-financiero/classification.ts'

const categories = [
  { id: 'root-debit', parent_id: null, code: 'EXPENSE', name: 'Gastos', direction: 'EXPENSE', is_active: true, cash_direction: 'DEBIT' },
  { id: 'debit', parent_id: 'root-debit', code: 'EXPENSE_OK', name: 'Gasto válido', direction: 'EXPENSE', is_active: true, cash_direction: 'DEBIT' },
  { id: 'pnl-debit', parent_id: 'root-debit', code: 'EXPENSE_PNL', name: 'Gasto P&L', direction: 'EXPENSE', is_active: true, cash_direction: 'DEBIT' },
  { id: 'credit', parent_id: 'root-credit', code: 'INCOME_OK', name: 'Ingreso válido', direction: 'INCOME', is_active: true, cash_direction: 'CREDIT' },
  { id: 'inactive', parent_id: 'root-debit', code: 'INACTIVE', name: 'Inactiva', direction: 'EXPENSE', is_active: false, cash_direction: 'DEBIT' },
  { id: 'parent', parent_id: 'root-debit', code: 'PARENT', name: 'Padre', direction: 'EXPENSE', is_active: true, cash_direction: 'DEBIT' },
  { id: 'child', parent_id: 'parent', code: 'CHILD', name: 'Hijo', direction: 'EXPENSE', is_active: true, cash_direction: 'DEBIT' },
  { id: 'root-credit', parent_id: null, code: 'INCOME', name: 'Ingresos', direction: 'INCOME', is_active: true, cash_direction: 'CREDIT' },
]
const migration = readFileSync(new URL('../supabase/migrations/20261003170000_financial_manual_category_override.sql', import.meta.url), 'utf8')

test('filters eligible leaf categories by bank direction, not P&L treatment', () => {
  assert.deepEqual(eligibleFinancialCategories(categories, 'DEBE').map((category) => category.id), ['debit', 'pnl-debit', 'child'])
  assert.deepEqual(eligibleFinancialCategories(categories, 'HABER').map((category) => category.id), ['credit'])
})

test('does not expose structural parents, inactive categories, or arbitrary categories', () => {
  const debit = eligibleFinancialCategories(categories, 'DEBE').map((category) => category.id)
  assert.equal(debit.includes('root-debit'), false)
  assert.equal(debit.includes('parent'), false)
  assert.equal(debit.includes('inactive'), false)
  assert.equal(debit.includes('credit'), false)
})

test('manual override contract protects scope, concurrency, audit, and automatic classifiers', () => {
  for (const clause of [
    "core.has_company_access(p_actor_user_id, p_company_id)",
    "portal.user_has_permission(p_actor_user_id, 'analisis_comercial.control_financiero.classify')",
    'category.parent_id is not null',
    "category.cash_direction in ('DEBIT', 'BOTH')",
    "category.cash_direction in ('CREDIT', 'BOTH')",
    "classification_rule_id = null",
    'financial_movement_category_manual_override',
    'p_current_category_id',
    'classification_source is distinct from \'MANUAL\'',
  ]) assert.match(migration, new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(migration.includes('update comercial.financial_bank_classification_rules'), false)
})
