import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildStatementRows } from '../src/lib/control-financiero/statement.ts'

const financeApiExpenses = await readFile(new URL('../services/finance-api/app/financial/expenses.py', import.meta.url), 'utf8')
const drilldown = await readFile(new URL('../src/app/actions/control-financiero/statement-drilldown.ts', import.meta.url), 'utf8')
const statementPage = await readFile(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/page.tsx', import.meta.url), 'utf8')

const sales = {
  company_id: 'company',
  year: 2026,
  currency: 'CLP',
  source: 'test',
  data_through: '2026-10-31',
  has_information: true,
  documents_count: 1,
  lines_count: 1,
  months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1, amount: '1000.00' })),
  total_ytd: '12000.00',
}

const expenses = {
  companyId: 'company',
  year: 2026,
  currency: 'CLP',
  source: 'comercial.financial_bank_movements + comercial.financial_expense_entries',
  dataThrough: '2026-09-29',
  months: Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    status: index < 9 ? 'AVAILABLE' : 'MISSING',
    softwareSubscriptions: index < 9 ? '10.00' : null,
    officeConsumption: index < 9 ? '0.00' : null,
    vehicleOperating: index === 1 ? '20.00' : index < 9 ? '0.00' : null,
    notaryServices: index === 2 ? '4.00' : index < 9 ? '0.00' : null,
     bankFees: index < 9 ? '5.00' : null,
     insurance: index < 9 ? '0.00' : null,
     telecom: index < 9 ? '0.00' : null,
     externalServices: index < 9 ? '0.00' : null,
     otherExpenses: index < 9 ? '0.00' : null,
    operatingIdentifiedTotal: index < 9 ? '39.00' : null,
    financialInterest: index === 5 ? '6.00' : index < 9 ? '0.00' : null,
    nonOperatingIdentifiedTotal: index === 5 ? '6.00' : index < 9 ? '0.00' : null,
  })),
  coverage: { availableMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9], missingMonths: [10, 11, 12], latestAvailableMonth: 9, coverageStatus: 'INCOMPLETE' },
  ytd: {
    status: 'INCOMPLETE', availableMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9], missingMonths: [10, 11, 12], latestAvailableMonth: 9,
     softwareSubscriptions: '90.00', officeConsumption: '0.00', vehicleOperating: '20.00', notaryServices: '4.00', bankFees: '45.00', insurance: '0.00', telecom: '0.00', externalServices: '0.00', otherExpenses: '0.00', operatingIdentifiedTotal: '159.00', financialInterest: '6.00', nonOperatingIdentifiedTotal: '6.00',
  },
}

test('adds identified operating and non-operating groups without operational result', () => {
  const rows = buildStatementRows(sales, null, null, 10, expenses)
  const operating = rows.find(row => row.label === 'GASTOS OPERACIONALES IDENTIFICADOS')
  const nonOperating = rows.find(row => row.label === 'GASTOS FINANCIEROS / NO OPERACIONALES')
  assert.deepEqual(operating?.children?.map(row => row.label), [
    'Software y suscripciones',
    'Gastos de oficina y consumo interno',
    'Combustible y gastos de vehículo',
     'Servicios notariales',
     'Gastos bancarios',
     'Seguros',
     'Telecomunicaciones e Internet',
      'Servicios profesionales y externos',
      'Otros gastos reconocidos',
  ])
  assert.equal(operating?.ytd, '159.00')
  assert.equal(nonOperating?.children?.[0].ytd, '6.00')
  assert.equal(rows.some(row => row.label === 'Resultado Operacional'), false)
})

test('renders missing expense months as null and compares YTD with covered-period sales', () => {
  const rows = buildStatementRows(sales, null, null, 10, expenses)
  const operating = rows.find(row => row.label === 'GASTOS OPERACIONALES IDENTIFICADOS')
  assert.equal(operating?.values[8], '39.00')
  assert.equal(operating?.values[9], null)
  assert.equal(operating?.ytdMissing, 1)
  assert.equal(operating?.percentageYtd, 159 / 9000 * 100)
})

test('integrates only POSTED recognized entries by accounting period and exposes drilldown traceability', () => {
  assert.match(financeApiExpenses, /expense\.status = 'POSTED'/)
  assert.match(financeApiExpenses, /expense\.period_year = :year/)
  assert.match(financeApiExpenses, /period_month AS month/)
  assert.match(financeApiExpenses, /available_periods/)
  assert.match(financeApiExpenses, /financial_expense_bank_links/)
  assert.match(financeApiExpenses, /allocated_amount/)
  assert.match(drilldown, /source: 'RECOGNIZED'/)
  assert.match(drilldown, /document_number/)
  assert.match(drilldown, /accountingPeriod/)
})

test('preserves the EERR when recognized-only months have no bank date', () => {
  assert.match(financeApiExpenses, /if value is not None/)
  assert.match(financeApiExpenses, /default=None/)
  assert.match(financeApiExpenses, /EXPENSE_FINANCIAL_INTEREST/)
  assert.match(financeApiExpenses, /EXPENSE_BANK_FEES/)
})

test('shows a non-blocking warning when identified expenses fail to load', () => {
  assert.match(statementPage, /!expensesResult\.ok/)
  assert.match(statementPage, /No se pudieron cargar los gastos identificados/)
  assert.match(statementPage, /El Estado de Resultados está incompleto/)
})
