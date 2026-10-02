import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatementRows } from '../src/lib/control-financiero/statement.ts'

const personnel = (overrides = {}) => ({
  companyId: 'company-a',
  year: 2026,
  currency: 'CLP',
  source: 'test',
  months: Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    status: index < 2 ? 'AVAILABLE' : 'MISSING',
    formalEarnings: index === 0 ? '100' : index === 1 ? '200' : null,
    employerContributions: index === 0 ? '10' : index === 1 ? '20' : null,
    formalLaborCost: index === 0 ? '110' : index === 1 ? '220' : null,
    recurringLaborCost: index === 0 ? '110' : index === 1 ? '220' : null,
    indemnities: '0',
    workerCount: index < 2 ? 1 : null,
    offBook: index === 1 ? '5' : '0',
    salariesOther: index === 1 ? '7' : '0',
    totalPersonnel: index === 0 ? '110' : index === 1 ? '232' : null,
  })),
  coverage: {
    availableMonths: [1, 2],
    missingMonths: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    latestAvailableMonth: 2,
    coverageStatus: 'INCOMPLETE',
  },
  ytd: {
    status: 'INCOMPLETE',
    availableMonths: [1, 2],
    missingMonths: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    latestAvailableMonth: 2,
    availableTotal: {
      formalEarnings: '300',
      employerContributions: '30',
      formalLaborCost: '330',
      recurringLaborCost: '330',
      indemnities: '0',
      offBook: '5',
      salariesOther: '7',
      totalPersonnel: '342',
    },
  },
  ...overrides,
})

test('builds the collapsed personnel group and keeps missing formal months null', () => {
  const rows = buildStatementRows(null, null, personnel())
  const group = rows.find(row => row.label === 'GASTOS DE PERSONAL')

  assert.ok(group)
  assert.equal(group.group, true)
  assert.equal(group.values[0], '110')
  assert.equal(group.values[2], null)
  assert.equal(group.ytd, '342')
  assert.equal(group.ytdMissing, 10)
  assert.deepEqual(group.children?.map(row => row.label), [
    'Remuneraciones formales',
    'Cargas del empleador',
    'Personal fuera de libro',
    'Otros laborales',
  ])
})

test('does not add an indemnity row to the personnel group', () => {
  const rows = buildStatementRows(null, null, personnel())
  assert.equal(rows.some(row => row.label === 'Indemnizaciones'), false)
})

test('uses the visible report horizon for personnel YTD and percentages', () => {
  const monthlyTotals = ['9918646', '11216640', '12481339', '9529602', '10238436', '11904497', '14580347', '12779970']
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    status: index < 8 ? 'AVAILABLE' : 'MISSING',
    formalEarnings: index === 0 ? '76487951' : index < 8 ? '0' : null,
    employerContributions: index === 0 ? '3817229' : index < 8 ? '0' : null,
    formalLaborCost: index === 0 ? '80305180' : index < 8 ? '0' : null,
    recurringLaborCost: index === 0 ? '80237086' : index < 8 ? '0' : null,
    indemnities: index === 0 ? '68094' : index < 8 ? '0' : null,
    workerCount: index < 8 ? 1 : null,
    offBook: index === 0 ? '10937351' : index === 8 ? '962098' : '0',
    salariesOther: index === 0 ? '1406946' : index === 8 ? '75481' : '0',
    totalPersonnel: index < 8 ? monthlyTotals[index] : null,
  }))
  const sales = {
    company_id: 'company-a',
    year: 2026,
    currency: 'CLP',
    source: 'test',
    data_through: '2026-10-31',
    has_information: true,
    documents_count: 1,
    lines_count: 1,
    months: Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      amount: index === 0 ? '873456656' : index < 10 ? '0' : null,
    })),
    total_ytd: '873456656',
  }
  const rows = buildStatementRows(sales, null, { ...personnel(), months }, 10)
  const group = rows.find(row => row.label === 'GASTOS DE PERSONAL')
  const children = Object.fromEntries(group?.children?.map(row => [row.label, row]) ?? [])

  assert.ok(group)
  assert.equal(group.ytd, '92649477')
  assert.equal(group.ytdMissing, 2)
  assert.equal(group.percentageYtd, (92649477 / 873456656) * 100)
  assert.equal(group.values[8], null)
  assert.equal(group.values[9], null)
  assert.equal(children['Remuneraciones formales'].ytd, '76487951')
  assert.equal(children['Remuneraciones formales'].ytdMissing, 2)
  assert.equal(children['Cargas del empleador'].ytd, '3817229')
  assert.equal(children['Cargas del empleador'].ytdMissing, 2)
  assert.equal(children['Personal fuera de libro'].ytd, '11899449')
  assert.equal(children['Personal fuera de libro'].ytdMissing, null)
  assert.equal(children['Otros laborales'].ytd, '1482427')
  assert.equal(children['Otros laborales'].ytdMissing, null)
})
