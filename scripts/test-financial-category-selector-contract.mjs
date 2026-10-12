import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  categoryTreatment,
  eligibleFinancialCategories,
  filterCategoriesByTreatment,
} from '../src/lib/control-financiero/classification.ts'

const source = await readFile(new URL('../src/modules/analisis-comercial/control-financiero/components/cash-flow-client.tsx', import.meta.url), 'utf8')

const categories = [
  { id: 'pnl', parent_id: 'root', code: 'EXPENSE_EXTERNAL_SERVICES', name: 'Servicios externos', direction: 'EXPENSE', is_active: true, cash_direction: 'DEBIT', affects_pnl_directly: true },
  { id: 'cash', parent_id: 'root', code: 'EXPENSE_SUPPLIERS', name: 'Pago a proveedores', direction: 'EXPENSE', is_active: true, cash_direction: 'DEBIT', affects_pnl_directly: false },
  { id: 'income', parent_id: 'root', code: 'INCOME_SALES', name: 'Ventas', direction: 'INCOME', is_active: true, cash_direction: 'CREDIT', affects_pnl_directly: true },
  { id: 'inactive', parent_id: 'root', code: 'EXPENSE_INACTIVE', name: 'Inactiva', direction: 'EXPENSE', is_active: false, cash_direction: 'DEBIT', affects_pnl_directly: true },
]

test('metadata determines the two category treatments', () => {
  assert.equal(categoryTreatment(categories[0]), 'PNL')
  assert.equal(categoryTreatment(categories[1]), 'CASH')
  assert.deepEqual(filterCategoriesByTreatment(eligibleFinancialCategories(categories, 'DEBE'), 'PNL').map(category => category.code), ['EXPENSE_EXTERNAL_SERVICES'])
  assert.deepEqual(filterCategoriesByTreatment(eligibleFinancialCategories(categories, 'DEBE'), 'CASH').map(category => category.code), ['EXPENSE_SUPPLIERS'])
})

test('selector preserves direction filtering and derives tabs without saving', () => {
  assert.deepEqual(filterCategoriesByTreatment(eligibleFinancialCategories(categories, 'HABER'), 'PNL').map(category => category.code), ['INCOME_SALES'])
  assert.match(source, /setCategoryTreatmentTab\(existingCategory \? categoryTreatment\(existingCategory\) : "CASH"\)/)
  assert.match(source, /filterCategoriesByTreatment\(eligibleCategories, categoryTreatmentTab\)/)
  assert.match(source, /onClick=\{\(\) => changeCategoryTreatmentTab\(treatment\)\}/)
  assert.match(source, /Este cambio modificará si el movimiento afecta directamente el Estado de Resultados\./)
  assert.match(source, /grid grid-cols-1 gap-2 sm:grid-cols-2/)
  assert.match(source, /role="tablist"/)
})

test('selector keeps the existing category save action', () => {
  assert.match(source, /onClick=\{\(\) => saveMovement\(false\)\}/)
  assert.match(source, /updateFinancialMovementCategoryAction/)
  assert.match(source, /Sólo se muestran hojas activas compatibles/)
})
