import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLatestClosedBalances, resolveLatestKnownBalances } from '../src/lib/control-financiero/current-balance.ts'

const accounts = [{ id: 'caylo' }, { id: 'amimascotas' }]

test('uses closing balance and coverage date for the latest closed period', () => {
  const latest = resolveLatestClosedBalances(accounts, [
    { bank_account_id: 'caylo', status: 'CLOSED', year: 2026, month: 1, closing_balance: 17185477, last_transaction_date: '2026-01-30' },
  ])
  assert.deepEqual(latest.get('caylo'), { balance: 17185477, date: '2026-01-30' })
})

test('ignores same-day movement ordering and consolidates active accounts', () => {
  const latest = resolveLatestClosedBalances(accounts, [
    { bank_account_id: 'caylo', status: 'CLOSED', year: 2026, month: 1, closing_balance: 17185477, last_transaction_date: '2026-01-30' },
    { bank_account_id: 'amimascotas', status: 'CLOSED', year: 2025, month: 12, closing_balance: 1000, last_transaction_date: '2025-12-31' },
    { bank_account_id: 'caylo', status: 'CLOSED', year: 2026, month: 1, closing_balance: 2565603, last_transaction_date: '2026-01-30' },
  ])
  assert.equal([...latest.values()].reduce((sum, row) => sum + row.balance, 0), 17186477)
})

test('supports an account filter without crossing account scope', () => {
  const latest = resolveLatestClosedBalances(accounts, [
    { bank_account_id: 'caylo', status: 'CLOSED', year: 2026, month: 1, closing_balance: 17185477, last_transaction_date: '2026-01-30' },
    { bank_account_id: 'amimascotas', status: 'CLOSED', year: 2026, month: 1, closing_balance: 2000, last_transaction_date: '2026-01-31' },
  ], 'amimascotas')
  assert.deepEqual([...latest.keys()], ['amimascotas'])
})

test('prefers the latest OPEN current balance over an older CLOSED balance', () => {
  const latest = resolveLatestKnownBalances(accounts, [
    { bank_account_id: 'caylo', status: 'CLOSED', year: 2026, month: 8, closing_balance: 1357916, last_transaction_date: '2026-08-31' },
    { bank_account_id: 'caylo', status: 'OPEN', year: 2026, month: 9, closing_balance: null, current_balance: 1317152, coverage_through: '2026-09-23', last_transaction_date: '2026-09-23' },
  ])
  assert.deepEqual(latest.get('caylo'), { balance: 1317152, date: '2026-09-23', periodKey: '2026-09' })
})
