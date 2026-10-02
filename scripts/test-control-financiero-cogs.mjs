import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStatementRows, getSalesNetDetailScope, hasStatementInformation } from '../src/lib/control-financiero/statement.ts'

const sales = {
  company_id: 'company-a', year: 2026, currency: 'CLP', source: 'sales', data_through: '2026-09-30', has_information: true,
  documents_count: 1, lines_count: 1,
  months: Array.from({ length: 12 }, (_, index) => ({ month: index + 1, amount: index < 2 ? ['100.005', '200.00'][index] : null })),
  total_ytd: '300.005',
}

const cogs = {
  company_id: 'company-a', year: 2026, currency: 'CLP', source: 'cogs', data_through: '2026-09-30', has_information: true,
  months: Array.from({ length: 12 }, (_, index) => ({
    month: index + 1, gross_cogs: index < 2 ? ['60.005', '80.00'][index] : null,
    credit_note_reversal: index < 2 ? ['10.005', '20.00'][index] : null,
    net_cogs: index < 2 ? ['50.00', '60.00'][index] : null,
    observed_document_count: index < 2 ? 1 : null, missing_document_count: index === 0 ? 1 : index === 1 ? 2 : null,
    coverage_status: index < 2 ? 'INCOMPLETE' : null,
  })),
  ytd: { gross_cogs: '140.005', credit_note_reversal: '30.005', net_cogs: '110.00', observed_document_count: 2, missing_document_count: 3, coverage_status: 'INCOMPLETE' },
}

test('builds net COGS and gross margin without binary float arithmetic', () => {
  const rows = buildStatementRows(sales, cogs)
  assert.equal(rows[1].values[0], '50.00')
  assert.equal(rows[2].values[0], '50.005')
  assert.equal(rows[2].ytd, '190.005')
  assert.equal(rows[1].percentageYtd, 110 / 300.005 * 100)
})

test('carries incomplete coverage and keeps future months unavailable', () => {
  const rows = buildStatementRows(sales, cogs)
  assert.equal(rows[1].missing[0], 1)
  assert.equal(rows[1].missing[1], 2)
  assert.equal(rows[1].ytdMissing, 3)
  assert.equal(rows[2].values[9], null)
  assert.equal(rows[2].percentageYtd, 190.005 / 300.005 * 100)
})

test('does not manufacture margin when COGS is unavailable', () => {
  const rows = buildStatementRows(sales, null)
  assert.equal(rows[1].values[0], null)
  assert.equal(rows[2].values[0], null)
  assert.equal(rows[2].percentageYtd, null)
})

test('recognizes real monthly values even when an HTTP 200 payload omits the information flag', () => {
  assert.equal(hasStatementInformation({ ...sales, has_information: false }, null), true)
  assert.equal(hasStatementInformation(null, { ...cogs, has_information: false }), true)
  assert.equal(hasStatementInformation({ ...sales, has_information: false, months: sales.months.map(month => ({ ...month, amount: null })) }, null), false)
})

test('opens only available sales cells and maps monthly and YTD columns correctly', () => {
  assert.deepEqual(getSalesNetDetailScope(0, '100.00'), { month: 1 })
  assert.deepEqual(getSalesNetDetailScope(8, '100.00'), { month: 9 })
  assert.deepEqual(getSalesNetDetailScope(12, '300.00'), { month: null })
  assert.equal(getSalesNetDetailScope(9, null), null)
})
