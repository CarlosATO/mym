import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const client = fs.readFileSync('src/modules/analisis-comercial/control-financiero/components/cash-flow-client.tsx', 'utf8')
const bankActions = fs.readFileSync('src/app/actions/control-financiero/bank-statements.ts', 'utf8')
const classificationActions = fs.readFileSync('src/app/actions/control-financiero/classification.ts', 'utf8')
const page = fs.readFileSync('src/app/dashboard/analisis-comercial/control-financiero/flujo-caja/page.tsx', 'utf8')

test('cash flow mutations use path invalidation instead of refresh navigation', () => {
  assert.doesNotMatch(client, /router\.refresh\(\)|window\.location\.(reload|href)/)
  assert.match(bankActions, /const CASH_FLOW_PATH = .*flujo-caja/)
  assert.equal((bankActions.match(/revalidatePath\(CASH_FLOW_PATH\)/g) ?? []).length, 5)
  assert.equal((classificationActions.match(/revalidatePath\(CASH_FLOW_PATH\)/g) ?? []).length, 6)
})

test('reconciliation status is updated locally and errors are visible', () => {
  assert.match(client, /setReconciliationOverride\(\{/)
  assert.match(client, /status: "IDENTIFIED"/)
  assert.match(client, /No se pudo identificar la diferencia:/)
  assert.match(client, /reconciliation\.status === "PENDING"/)
})

test('current filters remain URL-driven', () => {
  assert.match(client, /new URLSearchParams/)
  assert.match(client, /params\.set\("classification", nextFilter\)/)
  assert.match(client, /nextSearch\.trim\(\)/)
  assert.match(client, /nextCategory/)
  assert.match(client, /params\.set\("scope", nextScope\)/)
  assert.match(client, /params\.set\("direction", nextDirection\)/)
  assert.match(client, /query\(year, month, accountId, 1, classificationFilter, search, categoryFilter, nextScope, direction\)/)
})

test('movement search supports month and year scopes server-side', () => {
  assert.match(page, /params\.scope === 'year' \? 'year' : 'month'/)
  assert.match(bankActions, /scope: "month" \| "year" = "month"/)
  assert.match(bankActions, /scope === "year"\s*\n\s*\? `\$\{year\}-01-01`/)
  assert.match(bankActions, /scope === "year"\s*\n\s*\? `\$\{year \+ 1\}-01-01`/)
  assert.match(client, /Resultados de búsqueda · \$\{year\}/)
})

test('movement direction filters use financial amounts server-side', () => {
  assert.match(page, /params\.direction === 'credit' \|\| params\.direction === 'debit' \? params\.direction : 'all'/)
  assert.match(bankActions, /direction: "all" \| "credit" \| "debit" = "all"/)
  assert.match(bankActions, /direction === "credit"\) countQuery\.gt\("credit_amount", 0\)/)
  assert.match(bankActions, /direction === "debit"\) countQuery\.gt\("debit_amount", 0\)/)
  assert.match(bankActions, /direction === "credit"\) movementQuery\.gt\("credit_amount", 0\)/)
  assert.match(bankActions, /direction === "debit"\) movementQuery\.gt\("debit_amount", 0\)/)
  assert.match(client, /aria-label="Tipo de movimiento"/)
  assert.match(client, /query\(year, month, accountId, 1, classificationFilter, search, categoryFilter, scope, nextDirection\)/)
})

test('read-only category loading cannot refresh the route from the client', () => {
  assert.doesNotMatch(client, /useEffect|loadCategories|getFinancialClassificationCategories/)
  assert.match(page, /getFinancialClassificationCategories/)
  assert.match(page, /categories=\{categories\}/)
})
