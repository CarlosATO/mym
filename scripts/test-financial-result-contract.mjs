import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatementRows, getCommonCoverage } from '../src/lib/control-financiero/statement.ts'

const months = Array.from({ length: 12 }, (_, index) => index + 1)
const sales = {
  company_id: 'company', year: 2026, currency: 'CLP', source: 'BSale', data_through: '2026-10-31', has_information: true,
  documents_count: 1, lines_count: 1, months: months.map(month => ({ month, amount: month <= 10 ? '1000' : null })), total_ytd: '10000',
}
const cogs = {
  company_id: 'company', year: 2026, currency: 'CLP', source: 'BSale', data_through: '2026-10-31', has_information: true,
  months: months.map(month => ({ month, gross_cogs: month <= 8 ? '500' : null, credit_note_reversal: '0', net_cogs: month <= 8 ? '500' : null, observed_document_count: 1, missing_document_count: 0, coverage_status: month <= 8 ? 'COMPLETE' : 'INCOMPLETE' })),
  ytd: { gross_cogs: '4000', credit_note_reversal: '0', net_cogs: '4000', observed_document_count: 8, missing_document_count: 0, coverage_status: 'COMPLETE' },
}
const personnel = {
  companyId: 'company', year: 2026, currency: 'CLP', source: 'payroll',
  months: months.map(month => ({ month, status: month <= 8 ? 'AVAILABLE' : 'MISSING', formalEarnings: month <= 8 ? '100' : null, employerContributions: '0', formalLaborCost: '100', recurringLaborCost: '100', indemnities: '0', workerCount: 1, offBook: '0', salariesOther: '0', totalPersonnel: month <= 8 ? '100' : null })),
  coverage: { availableMonths: months.slice(0, 8), missingMonths: months.slice(8), latestAvailableMonth: 8, coverageStatus: 'INCOMPLETE' },
  ytd: { status: 'INCOMPLETE', availableMonths: months.slice(0, 8), missingMonths: months.slice(8), latestAvailableMonth: 8, availableTotal: {} },
}
const expenses = {
  companyId: 'company', year: 2026, currency: 'CLP', source: 'bank', dataThrough: '2026-10-31',
  months: months.map(month => ({ month, status: month <= 8 ? 'AVAILABLE' : 'MISSING', softwareSubscriptions: '0', officeConsumption: '0', vehicleOperating: '0', notaryServices: '0', bankFees: '0', insurance: '0', telecom: '0', externalServices: '0', operatingIdentifiedTotal: month <= 8 ? '50' : null, financialInterest: month <= 8 ? '2' : null, nonOperatingIdentifiedTotal: month <= 8 ? '2' : null })),
  coverage: { availableMonths: months.slice(0, 8), missingMonths: months.slice(8), latestAvailableMonth: 8, coverageStatus: 'INCOMPLETE' },
  ytd: { status: 'INCOMPLETE', availableMonths: months.slice(0, 8), missingMonths: months.slice(8), latestAvailableMonth: 8, operatingIdentifiedTotal: '400', nonOperatingIdentifiedTotal: '16', softwareSubscriptions: '0', officeConsumption: '0', vehicleOperating: '0', notaryServices: '0', bankFees: '0', insurance: '0', telecom: '0', externalServices: '0', financialInterest: '16' },
  pendingReviewCount: 1, pendingHistoricalAmount: '999', historicalCoverageNote: 'not used',
}

test('uses the latest contiguous common coverage and leaves later months unavailable', () => {
  const coverage = getCommonCoverage(sales, cogs, personnel, expenses)
  assert.deepEqual(coverage.months, months.slice(0, 8))
  const rows = buildStatementRows(sales, cogs, personnel, 10, expenses)
  const operating = rows.find(row => row.label === 'RESULTADO OPERACIONAL')
  const managerial = rows.find(row => row.label === 'RESULTADO GERENCIAL')
  assert.equal(operating?.values[7], '350')
  assert.equal(operating?.values[8], null)
  assert.equal(managerial?.values[8], null)
  assert.equal(operating?.ytd, '2800')
  assert.equal(managerial?.ytd, '2784')
  assert.equal(managerial?.percentageYtd, 2784 / 8000 * 100)
  assert.equal(operating?.percentageYtd, 2800 / 8000 * 100)
})

test('does not create derived results without all required sources', () => {
  const rows = buildStatementRows(sales, cogs, null, 10, expenses)
  assert.equal(getCommonCoverage(sales, cogs, null, expenses).throughMonth, null)
  assert.equal(rows.some(row => row.label === 'RESULTADO OPERACIONAL'), false)
})

test('derived results use only monthly source values, not pending or expense-entry totals', () => {
  const rows = buildStatementRows(sales, cogs, personnel, 10, expenses)
  const operating = rows.find(row => row.label === 'RESULTADO OPERACIONAL')
  assert.equal(operating?.ytd, '2800')
  assert.notEqual(operating?.ytd, '3799')
})

test('matches the current 2026 control values for the common period', () => {
  const controlSales = { ...sales, months: months.map(month => ({ month, amount: month === 1 ? '873456656' : month <= 8 ? '0' : null })), total_ytd: '873456656' }
  const controlCogs = { ...cogs, months: months.map(month => ({ ...cogs.months[month - 1], month, net_cogs: month === 1 ? '722542683' : month <= 8 ? '0' : null, coverage_status: month <= 8 ? 'COMPLETE' : 'INCOMPLETE' })) }
  const controlPersonnel = { ...personnel, months: personnel.months.map((item, index) => ({ ...item, totalPersonnel: index === 0 ? '92649477' : index < 8 ? '0' : null })) }
  const controlExpenses = { ...expenses, months: expenses.months.map((item, index) => ({ ...item, operatingIdentifiedTotal: index === 0 ? '12822950' : index < 8 ? '0' : null, financialInterest: index === 0 ? '16466' : index < 8 ? '0' : null, nonOperatingIdentifiedTotal: index === 0 ? '16466' : index < 8 ? '0' : null })) }
  const rows = buildStatementRows(controlSales, controlCogs, controlPersonnel, 10, controlExpenses)
  assert.equal(rows.find(row => row.label === 'RESULTADO OPERACIONAL')?.ytd, '45441546')
  assert.equal(rows.find(row => row.label === 'RESULTADO GERENCIAL')?.ytd, '45425080')
})

test('keeps calculated result rows unavailable after common coverage', () => {
  const rows = buildStatementRows(sales, cogs, personnel, 10, expenses)
  const operating = rows.find(row => row.label === 'RESULTADO OPERACIONAL')
  const managerial = rows.find(row => row.label === 'RESULTADO GERENCIAL')
  assert.deepEqual(operating?.values.slice(8, 10), [null, null])
  assert.deepEqual(managerial?.values.slice(8, 10), [null, null])
})

test('exposes stable drill-down keys without changing statement amounts', () => {
  const rows = buildStatementRows(sales, cogs, personnel, 10, expenses)
  const personnelRow = rows.find(row => row.label === 'GASTOS DE PERSONAL')
  const operatingRow = rows.find(row => row.label === 'GASTOS OPERACIONALES IDENTIFICADOS')
  const financialRow = rows.find(row => row.label === 'GASTOS FINANCIEROS / NO OPERACIONALES')
  assert.equal(personnelRow?.drilldownKey, 'PERSONNEL_GROUP')
  assert.deepEqual(personnelRow?.children?.map(child => child.drilldownKey), [
    'PERSONNEL_FORMAL',
    'PERSONNEL_EMPLOYER',
    'PERSONNEL_OFF_BOOK',
    'PERSONNEL_OTHER',
  ])
  assert.equal(operatingRow?.drilldownKey, 'OPERATING_GROUP')
  assert.equal(financialRow?.drilldownKey, 'NON_OPERATING_GROUP')
  assert.equal(operatingRow?.children?.[0]?.values[7], '0')
  assert.equal(operatingRow?.children?.[0]?.values[8], null)
})

test('does not discard common coverage when COGS has an incomplete quality flag', () => {
  const incompleteCogs = {
    ...cogs,
    months: cogs.months.map(month => month.month <= 8 ? { ...month, coverage_status: 'INCOMPLETE' } : month),
  }
  assert.deepEqual(getCommonCoverage(sales, incompleteCogs, personnel, expenses).months, months.slice(0, 8))
})
