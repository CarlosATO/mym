import assert from 'node:assert/strict'
import test from 'node:test'
import { accrueOpenMonthPersonnel, buildStatementRows, buildPersonnelEstimateDetails, getManagerialAsOfDate, getConfirmedCoverage, getManagerialCoverage, getCommonCoverage } from '../src/lib/control-financiero/statement.ts'

function fixture(octoberComplete = true, expenseStatus = 'AVAILABLE') {
  const sales = { year: 2026, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: i < 8 ? '100000000' : i === 8 ? '90488606' : i === 9 ? '50000000' : null })) }
  const cogs = { year: 2026, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, net_cogs: i < 8 ? '80000000' : i === 8 ? '75156359' : i === 9 ? '40000000' : null, coverage_status: i < 9 || octoberComplete && i === 9 ? 'COMPLETE' : 'INCOMPLETE', missing_document_count: 0 })), ytd: { net_cogs: '755156359' } }
  const personnel = { year: 2026, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, status: i < 8 ? 'AVAILABLE' : i < 10 ? 'ESTIMATED' : 'MISSING', formalEarnings: i < 8 ? '9000000' : i < 10 ? '9641670' : null, employerContributions: i < 8 ? '500000' : i < 10 ? '491765' : null, offBook: i === 8 ? '2072819' : '0', salariesOther: i === 8 ? '75481' : '0', totalPersonnel: i < 8 ? '9500000' : i === 8 ? '12281735' : i === 9 ? '10133435' : null, formalEarningsEstimated: i >= 8 && i < 10, employerContributionsEstimated: i >= 8 && i < 10, personnelEstimated: i >= 8 && i < 10 })) }
  const expenses = { year: 2026, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, status: i < 8 || i === 8 || i === 9 && expenseStatus === 'AVAILABLE' ? 'AVAILABLE' : 'MISSING', operatingIdentifiedTotal: i < 8 ? '0' : i === 8 ? '1283672' : i === 9 && expenseStatus === 'AVAILABLE' ? '0' : null, nonOperatingIdentifiedTotal: i < 8 ? '0' : i === 8 ? '165722' : i === 9 && expenseStatus === 'AVAILABLE' ? '0' : null, otherIncome: '0' })), ytd: {}, coverage: { latestAvailableMonth: 10, coverageStatus: 'INCOMPLETE' } }
  return { sales, cogs, personnel, expenses }
}

test('confirmed and managerial coverage remain separate, zero expenses are real', () => {
  const { sales, cogs, personnel, expenses } = fixture()
  assert.equal(getCommonCoverage(sales, cogs, personnel, expenses).throughMonth, 8)
  assert.equal(getConfirmedCoverage(sales, cogs, personnel, expenses).throughMonth, 8)
  assert.equal(getManagerialCoverage(sales, cogs, personnel, expenses).throughMonth, 10)
  assert.equal(getManagerialCoverage(...Object.values(fixture(false))).throughMonth, 9)
  assert.equal(getManagerialCoverage(...Object.values(fixture(true, 'MISSING'))).throughMonth, 9)
})

test('September real sales and COGS lead to estimated personnel and aligned results', () => {
  const { sales, cogs, personnel, expenses } = fixture(false)
  const rows = buildStatementRows(sales, cogs, personnel, 10, expenses)
  const byLabel = label => rows.find(row => row.label === label)
  assert.equal(byLabel('Ventas Netas').values[8], '90488606')
  assert.equal(byLabel('Costo de Ventas').values[8], '75156359')
  assert.equal(byLabel('Margen Bruto').values[8], '15332247')
  assert.equal(byLabel('Margen Bruto').estimated, undefined)
  assert.equal(byLabel('GASTOS DE PERSONAL').values[8], '12281735')
  assert.equal(byLabel('GASTOS DE PERSONAL').estimated[8], true)
  assert.equal(byLabel('RESULTADO OPERACIONAL').estimated[8], true)
  assert.equal(byLabel('RESULTADO GERENCIAL').values[8], '1601118')
  assert.equal(byLabel('RESULTADO GERENCIAL').ytd, String(8 * (100000000 - 80000000 - 9500000) + 1601118))
  assert.equal(byLabel('RESULTADO GERENCIAL').confirmedYtd, String(8 * (100000000 - 80000000 - 9500000)))
  assert.equal(byLabel('RESULTADO GERENCIAL').percentageYtd, Number(byLabel('RESULTADO GERENCIAL').ytd) / (8 * 100000000 + 90488606) * 100)
  assert.equal(byLabel('RESULTADO GERENCIAL').ytdEstimated, true)
  assert.ok(Math.abs(1601118 / 90488606 * 100 - 1.8) < 0.1)
})

test('estimated drilldown uses payroll-period aggregates without workers', () => {
  const { personnel } = fixture()
  personnel.months[8].estimateSources = [{ year: 2026, month: 3, formalEarnings: '100', employerContributions: '10' }]
  personnel.months[9].estimateSources = [{ year: 2026, month: 4, formalEarnings: '200', employerContributions: '20' }]
  assert.deepEqual(buildPersonnelEstimateDetails(personnel, 10, 9), [{ month: 9, formalEarnings: '9641670', employerContributions: '491765', monthlyFormalEstimate: '9641670', monthlyEmployerEstimate: '491765', asOfDate: null, elapsedDays: null, daysInMonth: null, sources: personnel.months[8].estimateSources }])
  assert.equal(buildPersonnelEstimateDetails(personnel, 10, null).length, 2)
  assert.equal(buildPersonnelEstimateDetails(personnel, 8, null).length, 0)
  assert.ok(buildPersonnelEstimateDetails(personnel, 10, 9).every(item => !('workerName' in item)))
})

test('only estimated October payroll accrues through common real sales/COGS date', () => {
  const { sales, cogs, personnel, expenses } = fixture()
  sales.data_through = '2026-10-09'
  cogs.data_through = '2026-10-10'
  sales.months[9].amount = '38208171'
  cogs.months[9].net_cogs = '32323242.86'
  expenses.dataThrough = '2026-10-08' // Last bank movement is NOT a processing watermark.
  expenses.months[9].operatingIdentifiedTotal = '61850'
  expenses.months[9].nonOperatingIdentifiedTotal = '0'
  assert.equal(getManagerialAsOfDate(sales, cogs, '2026-10-11'), '2026-10-09')
  const accrued = accrueOpenMonthPersonnel(personnel, sales, cogs, '2026-10-11')
  assert.equal(accrued.months[8].formalEarnings, '9641670')
  assert.equal(accrued.months[8].totalPersonnel, '12281735')
  assert.equal(accrued.months[9].formalEarnings, '2799195')
  assert.equal(accrued.months[9].employerContributions, '142770')
  assert.equal(accrued.months[9].offBook, '0')
  assert.equal(accrued.months[9].salariesOther, '0')
  assert.equal(accrued.months[9].totalPersonnel, '2941965')
  assert.equal(accrued.months[9].estimateElapsedDays, 9)
  assert.equal(accrued.months[9].estimateDaysInMonth, 31)
  assert.equal(accrued.months[9].monthlyFormalEstimate, '9641670')
  assert.equal(accrued.months[9].estimateAsOfDate, '2026-10-09')
  assert.equal(personnel.months[9].formalEarnings, '9641670') // Response is derived, never mutated.
  const rows = buildStatementRows(sales, cogs, accrued, 10, expenses)
  const row = label => rows.find(item => item.label === label)
  assert.equal(row('Ventas Netas').values[9], '38208171')
  assert.equal(row('Costo de Ventas').values[9], '32323242.86')
  assert.equal(row('Margen Bruto').values[9], '5884928.14')
  assert.equal(row('GASTOS OPERACIONALES IDENTIFICADOS').values[9], '61850')
  assert.equal(row('GASTOS FINANCIEROS / NO OPERACIONALES').values[9], '0')
  assert.equal(row('RESULTADO OPERACIONAL').values[9], '2881113.14')
  assert.equal(row('RESULTADO GERENCIAL').values[9], '2881113.14')
  assert.equal(row('RESULTADO GERENCIAL').values[8], '1601118')
  assert.ok(Math.abs(100 * Number(row('RESULTADO GERENCIAL').values[9]) / 38208171 - 7.5) < 0.1)
  assert.equal(row('RESULTADO GERENCIAL').ytd, '88482231.14')
  assert.equal(row('RESULTADO GERENCIAL').confirmedYtd, '84000000')
  assert.equal(row('RESULTADO GERENCIAL').percentageYtd, 100 * Number(row('RESULTADO GERENCIAL').ytd) / (800000000 + 90488606 + 38208171))
  assert.equal(getConfirmedCoverage(sales, cogs, accrued, expenses).throughMonth, 8)
  assert.equal(getManagerialCoverage(sales, cogs, accrued, expenses).throughMonth, 10)
  const detail = buildPersonnelEstimateDetails(accrued, 10, 10)[0]
  assert.deepEqual([detail.monthlyFormalEstimate, detail.monthlyEmployerEstimate, detail.elapsedDays, detail.daysInMonth, detail.asOfDate], ['9641670', '491765', 9, 31, '2026-10-09'])
})

test('calendar days, leap February, day one, full month and real payroll precedence', () => {
  for (const [year, days] of [[2024, 29], [2025, 28]]) {
    const { sales, cogs, personnel } = fixture()
    sales.year = cogs.year = personnel.year = year
    personnel.months[1] = { ...personnel.months[1], status: 'ESTIMATED', formalEarnings: '100', employerContributions: '50', offBook: '80', salariesOther: '20', totalPersonnel: '250' }
    sales.data_through = cogs.data_through = `${year}-02-01`
    assert.equal(getManagerialAsOfDate(sales, cogs, `${year}-02-10`), `${year}-02-01`)
    const first = accrueOpenMonthPersonnel(personnel, sales, cogs, `${year}-02-10`).months[1]
    assert.equal(first.estimateDaysInMonth, days)
    assert.equal(first.formalEarnings, String(Math.round(100 / days)))
    assert.equal(first.offBook, '80')
    assert.equal(first.salariesOther, '20')
    sales.data_through = cogs.data_through = `${year}-02-${days}`
    const last = accrueOpenMonthPersonnel(personnel, sales, cogs, `${year}-02-${days}`).months[1]
    assert.equal(last.formalEarnings, '100')
    assert.equal(last.employerContributions, '50')
    personnel.months[1] = { ...personnel.months[1], status: 'AVAILABLE' }
    assert.equal(accrueOpenMonthPersonnel(personnel, sales, cogs, `${year}-02-${days}`).months[1].totalPersonnel, '250')
  }
})

test('future dates and incomplete current COGS cannot advance the accrual', () => {
  const { sales, cogs, personnel } = fixture()
  sales.data_through = cogs.data_through = '2026-10-15'
  assert.equal(getManagerialAsOfDate(sales, cogs, '2026-10-09'), '2026-10-09')
  assert.equal(accrueOpenMonthPersonnel(personnel, sales, cogs, '2026-10-09').months[9].estimateElapsedDays, 9)
  cogs.months[9].coverage_status = 'INCOMPLETE'
  assert.equal(getManagerialAsOfDate(sales, cogs, '2026-10-09'), null)
  assert.equal(accrueOpenMonthPersonnel(personnel, sales, cogs, '2026-10-09'), personnel)
  assert.equal(getManagerialAsOfDate(sales, cogs, '2026-11-01'), null) // No November sales/COGS.
})
