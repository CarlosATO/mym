import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/page.tsx', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/control-financiero/non-pnl-cash.ts', import.meta.url), 'utf8')
const classifier = await readFile(new URL('../src/lib/control-financiero/non-pnl-classification.ts', import.meta.url), 'utf8')
const section = await readFile(new URL('../src/app/dashboard/analisis-comercial/control-financiero/non-pnl-cash-section.tsx', import.meta.url), 'utf8')
const cashFlow = await readFile(new URL('../src/app/actions/control-financiero/bank-statements.ts', import.meta.url), 'utf8')

test('managerial KPIs reuse EERR result and consolidated bank balance', () => {
  assert.match(page, /const finalResultRow = rows\.find\(row => row\.label === 'RESULTADO GERENCIAL'\)/)
  assert.match(page, /resultYtd=\{finalResultRow\?\.ytd/)
  assert.match(page, /marginYtd=\{finalResultRow\?\.percentageYtd/)
  assert.match(page, /getCashFlowDashboard\(2026, 12, undefined/)
  assert.match(page, /currentBalance=\{cashFlowResult\?\.currentBalance \?\? null\}/)
  assert.doesNotMatch(page, /creditLineAvailable.*currentBalance/)
})

test('non-P&L action aggregates all requested categories in one annual movement query', () => {
  for (const code of ['EXPENSE_OWNER_WITHDRAWAL', 'EXPENSE_FINANCING', 'INCOME_FINANCING', 'INCOME_CONTRIBUTIONS', 'EXPENSE_ASSETS', 'INCOME_INTERNAL_TRANSFER', 'EXPENSE_INTERNAL_TRANSFER', 'INCOME_INTERCOMPANY', 'EXPENSE_INTERCOMPANY']) assert.match(action, new RegExp(code))
  assert.match(action, /\.in\('category_id', categoryIds\)/)
  assert.match(action, /\.gte\('transaction_date', start\)/)
  assert.match(action, /const movements: NonPnlCashMovement\[\] =/)
  assert.match(action, /consolidatedNonPnlImpact/)
  assert.match(action, /ownerWithdrawalsYtd: Math\.abs/)
  assert.match(action, /loanPaymentsYtd/)
  assert.match(action, /creditLinePaymentsYtd/)
  assert.match(action, /loanReceiptsYtd/)
  assert.match(action, /creditLineDrawsYtd/)
})

test('loan and credit-line subtypes do not net or overlap', () => {
  assert.match(classifier, /PAGO DE CREDITOS/)
  assert.match(classifier, /PAGO PRESTAMO/)
  assert.match(classifier, /CUOTA PRESTAMO/)
  assert.match(classifier, /ABONO DESDE LINEA DE CREDITO/)
  assert.match(classifier, /return 'LOAN_RECEIPT'/)
  assert.match(classifier, /return 'CREDIT_LINE_DRAW'/)
  assert.match(classifier, /CARGO CTA \?CTE POR TRASPASO LC/)
  assert.match(classifier, /return 'CREDIT_LINE_PAYMENT'/)
  assert.match(classifier, /return 'LOAN_PAYMENT'/)
  assert.doesNotMatch(classifier, /EXPENSE_FINANCING.*return 'LOAN_PAYMENT'/s)
})

test('bank balance excludes credit-line availability and preserves negative balances', () => {
  assert.match(cashFlow, /currentBalance: Array\.from\(latest\.values\(\)\)\.reduce/)
  assert.match(cashFlow, /n \+ row\.balance/)
  assert.match(cashFlow, /creditLineAvailable: creditLine\?\.available/)
})

test('non-P&L section exposes monthly/YTD rows and movement drill-down fields', () => {
  assert.match(section, /MOVIMIENTOS DE CAJA FUERA DEL RESULTADO/)
  assert.match(section, /MONTHS\.map/)
  assert.match(section, /YTD/)
  assert.match(section, /month: index \+ 1/)
  assert.match(section, /month: null/)
  assert.match(section, /movementForPeriod/)
  assert.match(section, /transaction_date|movement\.date\.slice\(5, 7\)/)
  assert.match(section, /Uso del período/)
  assert.match(section, /Pago\/restitución del período/)
  assert.match(section, /Saldo neto del período/)
  for (const field of ['Fecha', 'Banco', 'Descripción bancaria', 'Categoría', 'Clasificación', 'Revisión']) assert.match(section, new RegExp(field))
  assert.match(section, /SALDO BANCARIO ACTUAL/)
  assert.match(section, /Pago de préstamos bancarios/)
  assert.match(section, /Pago línea de crédito/)
  assert.match(action, /Préstamos recibidos/)
  assert.match(action, /Uso de línea de crédito/)
  assert.match(action, /Saldo neto línea de crédito/)
  assert.match(section, /value > 0/)
  assert.match(section, /BANCOS/)
})

test('credit-line control keeps flow rows separate and accumulates closing debt', () => {
  assert.match(section, /CONTROL DE LÍNEA DE CRÉDITO/)
  assert.match(section, /CREDIT_LINE_CODES/)
  assert.match(section, /visibleRows = data\.rows\.filter/)
  assert.match(section, /creditLineClosingBalances/)
  assert.match(section, /Saldo inicial del período/)
  assert.match(section, /Saldo final usado/)
  assert.match(section, /Disponible al cierre/)
  assert.match(section, /coveredClosing/)
  assert.match(section, /balanceDate/)
  assert.match(section, /availabilitySummary/)
  assert.match(section, /creditLineTotal/)
  assert.match(cashFlow, /credit_line_total/)
  assert.doesNotMatch(section.split('export function CreditLineControlSection')[0], /Uso de línea de crédito.*<tr/s)

  const usage = [0, 0, 0, 0, 0, 4528901, 4858421, 4812500, 4802171, 0, 0, 0]
  const payments = [0, 0, 0, 0, 0, -4525459, -4861863, -4812500, -2603267, 0, 0, 0]
  const closing = []
  let balance = 0
  usage.forEach((amount, index) => {
    balance += amount + payments[index]
    closing.push(balance)
  })
  assert.equal(usage.reduce((sum, amount) => sum + amount, 0), 19001993)
  assert.equal(Math.abs(payments.reduce((sum, amount) => sum + amount, 0)), 16803089)
  assert.equal(closing[5], 3442)
  assert.equal(closing[6], 0)
  assert.equal(closing[7], 0)
  assert.equal(closing[8], 2198904)
  assert.equal(2198904 + 2801096, 5000000)
  const total = 5000000
  const available = closing.map((amount, index) => index < 9 ? total - amount : null)
  assert.equal(available[5], 4996558)
  assert.equal(available[6], 5000000)
  assert.equal(available[7], 5000000)
  assert.equal(available[8], 2801096)
  assert.equal(available[9], null)
  assert.equal(available[10], null)
  assert.equal(available[11], null)
})
