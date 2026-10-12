import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildResultVsCashReport } from '../src/lib/control-financiero/result-vs-cash.ts'

const require = createRequire(import.meta.url)

function loadSection() {
  const source = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/non-pnl-cash-section.tsx', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  const passthrough = tag => ({ children, className }) => createElement(tag, { className }, children)
  new Function('require', 'exports', compiled)(name => {
    if (name === '@/components/ui/dialog') return { Dialog: ({ children }) => createElement(require('react').Fragment, null, children), DialogTrigger: passthrough('button'), DialogContent: passthrough('div'), DialogHeader: passthrough('div'), DialogTitle: passthrough('h2'), DialogDescription: passthrough('p') }
    if (name === '@/components/ui/sheet') return { Sheet: () => null }
    return require(name)
  }, exports)
  return exports.ResultVsCashSection
}

const movement = (code, subtype, amount, direction, date = '2026-10-09') => ({ categoryCode: code, subtype, amount, direction, date })
const accounts = [{ bankName: 'Banco Chile', maskedAccountNumber: '•••• 1234', balance: 5143078, balanceDate: '2026-10-08' }, { bankName: 'Itaú', maskedAccountNumber: '•••• 5678', balance: 0, balanceDate: '2026-10-09' }]
const base = { resultYtd: '49575420.35', resultEstimated: true, resultCoverage: 'enero–octubre 2026', resultAsOfDate: '2026-10-09', resultThroughMonth: 10, bankBalance: 5143078, accountBalances: accounts, year: 2026, collection: { allPortfolio: { receivableAmount: 43140174, overdueAmount: 19580345 }, asOfDate: '2026-10-08', latestConfirmedPaymentAt: '2026-10-09T13:58:46Z' }, nonPnl: { movements: [movement('INCOME_FINANCING', 'LOAN_RECEIPT', 200, 'HABER'), movement('EXPENSE_FINANCING', 'LOAN_PAYMENT', 30, 'DEBE'), movement('INCOME_FINANCING', 'CREDIT_LINE_DRAW', 100, 'HABER'), movement('EXPENSE_FINANCING', 'CREDIT_LINE_PAYMENT', 20, 'DEBE'), movement('EXPENSE_OWNER_WITHDRAWAL', null, 50, 'DEBE'), movement('INCOME_CONTRIBUTIONS', null, 90, 'HABER'), movement('EXPENSE_ASSETS', null, 10, 'DEBE'), movement('INCOME_INTERNAL_TRANSFER', null, 400, 'HABER'), movement('EXPENSE_INTERNAL_TRANSFER', null, 400, 'DEBE'), movement('INCOME_FINANCING', 'LOAN_RECEIPT', 999, 'HABER', '2026-10-10')] } }

test('result vs banks is a dated nominal comparison; verified factors remain informational', () => {
  const report = buildResultVsCashReport(base)
  assert.equal(report.resultYtd, base.resultYtd)
  assert.equal(report.bankBalance, 5143078)
  assert.equal(report.nominalDifference, '-44432342.35')
  assert.equal(report.receivables.amount, 43140174)
  assert.deepEqual(report.accounts.map(item => item.date), ['2026-10-08', '2026-10-09'])
  assert.equal(report.factors.find(item => item.label === 'Préstamos recibidos').amount, 200)
  assert.equal(report.factors.find(item => item.label === 'Principal de préstamos pagado').amount, -30)
  assert.equal(report.factors.find(item => item.label === 'Transferencias internas consolidadas').amount, 0)
  assert.ok(report.factors.every(item => !item.label.toLowerCase().includes('intereses')))
  assert.ok(!('residual' in report))
  assert.match(report.explanation, /no es una conciliación/)
})

test('missing bank observation never becomes zero or an invented residual', () => {
  const report = buildResultVsCashReport({ ...base, bankBalance: 5143078, accountBalances: [{ ...accounts[0], balanceDate: null }] })
  assert.equal(report.bankBalance, null)
  assert.equal(report.nominalDifference, null)
  assert.equal(buildResultVsCashReport({ ...base, bankBalance: 0, accountBalances: [] }).bankBalance, null)
})

test('analysis trigger lives in the header and opens a central Resultado-a-Caja bridge dialog', () => {
  const page = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/page.tsx', import.meta.url), 'utf8')
  const section = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/non-pnl-cash-section.tsx', import.meta.url), 'utf8')
  // The redundant top strip is removed; the single trigger sits in the header actions beside Exportar Excel.
  assert.doesNotMatch(page, /Resumen resultado vs disponibilidad bancaria/)
  const trigger = page.indexOf('<ResultVsCashSection report={resultVsCash}')
  assert.ok(trigger > 0 && trigger < page.indexOf('<ManagerialLiquidityCards'))
  assert.ok(trigger < page.indexOf('<FinancialMatrix'))
  assert.equal(page.match(/<ResultVsCashSection /g)?.length, 1)
  assert.doesNotMatch(page, /openingBalance=\{cashFlowResult\?\.annual\?\.openingBalance \?\? null\}/)
  const component = section.slice(section.indexOf('export function ResultVsCashSection'), section.indexOf('function MovementDetail'))
  assert.match(component, /Análisis resultado vs caja/)
  assert.match(component, /<Dialog open=\{detailOpen\}/)
  assert.doesNotMatch(component, /<Sheet|Ver análisis|¿Por qué son distintos\?|Diferencia nominal/)
  assert.match(component, /sm:max-w-\[1200px\]/)
  assert.match(component, /lg:w-\[92vw\]/)
  assert.match(component, /Resultado gerencial del período/)
  assert.match(component, /Utilidad económica estimada del período; no representa efectivo disponible/)
  assert.match(component, /Pendientes de ingreso a caja \(cobranzas\)/)
  assert.match(component, /Retiros de socios/)
  assert.doesNotMatch(component, /Saldo estimado en cuentas corrientes|saldo estimado|const estimated|estimatedBankBalance/i)
  assert.match(component, /Saldo efectivo en cuentas corrientes/)
  assert.match(component, /El saldo bancario no se reconcilia directamente con el resultado del período/)
  assert.match(component, /Cuentas por pagar y obligaciones/)
  assert.match(component, /Próximamente/)
  // Removed blocks must not reappear, and the language must stay non-reconciliatory.
  assert.doesNotMatch(component, /Salidas de caja|Entradas de caja|Puente parcial|Diferencia aún no explicada|Transferencias internas|movimientos ajenos al resultado|puente/i)
})

test('rendered modal shows effective balances without an estimated-cash formula', () => {
  const ResultVsCashSection = loadSection()
  const report = {
    resultYtd: '50618246', resultEstimated: true, resultCoverage: 'enero–octubre 2026', resultAsOfDate: '2026-10-09',
    factorThroughDate: '2026-10-09', bankBalance: 5143078, nominalDifference: '-45475168',
    accounts: [{ name: 'Caylo Banco de Chile', maskedAccount: '•••• 2707', balance: 5143078, date: '2026-10-08' }, { name: 'Itaú Empresas', maskedAccount: '•••• 7323', balance: 0, date: '2026-10-07' }],
    receivables: { amount: 43140174, overdue: 19580345, snapshotDate: '2026-10-08', latestConfirmedPaymentAt: null },
    factors: [
      { label: 'Retiros de socios', amount: -5442375, movementCount: 75, effect: 'CASH_ONLY' },
      { label: 'Préstamos recibidos', amount: 148798500, movementCount: 1, effect: 'CASH_ONLY' },
      { label: 'Principal de préstamos pagado', amount: -53021479, movementCount: 23, effect: 'CASH_ONLY' },
      { label: 'Uso de línea de crédito', amount: 21589664, movementCount: 26, effect: 'CASH_ONLY' },
      { label: 'Restitución de línea de crédito', amount: -16803089, movementCount: 5, effect: 'CASH_ONLY' },
      { label: 'Transferencias internas consolidadas', amount: 0, movementCount: 63, effect: 'INFORMATIONAL' },
    ],
    explanation: 'El resultado mide utilidad económica; el saldo bancario mide efectivo disponible.',
  }
  const html = renderToStaticMarkup(createElement(ResultVsCashSection, { report }))
  for (const value of ['$50.618.246', '$43.140.174', '$5.442.375', '$5.143.078']) assert.ok(html.includes(value), value)
  for (const label of ['Resultado gerencial del período', 'Pendientes de ingreso a caja (cobranzas)', 'Retiros de socios', 'Saldo efectivo en cuentas corrientes', 'Cuentas por pagar y obligaciones', 'Próximamente']) assert.ok(html.includes(label), label)
  assert.doesNotMatch(html, /Saldo estimado en cuentas corrientes|saldo estimado|\$2\.035\.697/i)
  assert.match(html, /El saldo bancario no se reconcilia directamente con el resultado del período/)
  // Each account balance is bound to its own account, and an individual Itaú $0 must not collapse the total.
  for (const label of ['Caylo Banco de Chile •••• 2707', 'Itaú Empresas •••• 7323', '$0']) assert.ok(html.includes(label), label)
  // The discarded blocks and indirect items are gone from the rendered output.
  assert.doesNotMatch(html, /Salidas de caja|Entradas de caja|Puente parcial|Diferencia aún no explicada|Transferencias internas|Préstamos recibidos|Uso de línea de crédito/)
})
