export type CurrentBalanceAccount = { id: string }

export type CurrentBalancePeriod = {
  bank_account_id: string
  status: string
  year: number
  month: number
  closing_balance: number | string
  current_balance?: number | string | null
  coverage_through?: string | null
  last_transaction_date: string
}

export type CurrentBalanceObservation = {
  balance: number
  date: string
}

/**
 * Resolves the latest bank observation for the currently supported CLOSED model.
 * An OPEN-period branch can be added here later without changing consolidation.
 */
export function resolveLatestClosedBalances(
  accounts: CurrentBalanceAccount[],
  periods: CurrentBalancePeriod[],
  selectedAccountId?: string,
) {
  const activeAccountIds = new Set(
    accounts
      .filter(account => !selectedAccountId || account.id === selectedAccountId)
      .map(account => account.id),
  )
  const latest = new Map<string, CurrentBalanceObservation>()

  for (const period of periods) {
    if (period.status !== 'CLOSED' || !activeAccountIds.has(period.bank_account_id)) continue
    const current = latest.get(period.bank_account_id)
    const periodKey = `${period.year}-${String(period.month).padStart(2, '0')}`
    const isLater = !current || periodKey > current.date.slice(0, 7)
    if (isLater) latest.set(period.bank_account_id, { balance: Number(period.closing_balance), date: period.last_transaction_date })
  }

  return latest
}

export function resolveLatestKnownBalances(
  accounts: CurrentBalanceAccount[],
  periods: CurrentBalancePeriod[],
  selectedAccountId?: string,
) {
  const activeAccountIds = new Set(accounts.filter(account => !selectedAccountId || account.id === selectedAccountId).map(account => account.id))
  const latest = new Map<string, CurrentBalanceObservation & { periodKey: string }>()
  for (const period of periods) {
    if (!activeAccountIds.has(period.bank_account_id)) continue
    const key = `${period.year}-${String(period.month).padStart(2, '0')}`
    const current = latest.get(period.bank_account_id)
    if (current && key <= current.periodKey) continue
    const balance = period.status === 'OPEN' ? period.current_balance : period.closing_balance
    const date = period.status === 'OPEN' ? period.coverage_through : period.last_transaction_date
    if (balance === null || balance === undefined || !date) continue
    latest.set(period.bank_account_id, { balance: Number(balance), date, periodKey: key })
  }
  return latest
}
