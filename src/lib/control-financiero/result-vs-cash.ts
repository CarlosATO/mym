import type { FinancialAccountBalance } from '@/app/actions/control-financiero/bank-statements'
import type { NonPnlCashData } from '@/app/actions/control-financiero/non-pnl-cash'
import type { CurrentCobranzaPosition } from './current-cobranza-position'
// @ts-expect-error Standalone Node harnesses use explicit TypeScript extensions.
import { subtractMoney } from './money.ts'
// @ts-expect-error Standalone Node harnesses use explicit TypeScript extensions.
import { consolidatedNonPnlImpact } from './non-pnl-classification.ts'

export type ResultVsCashReport = {
  resultYtd: string | null
  resultEstimated: boolean
  resultCoverage: string
  resultAsOfDate: string | null
  factorThroughDate: string | null
  bankBalance: number | null
  accounts: Array<{ name: string; maskedAccount: string; balance: number | null; date: string | null }>
  nominalDifference: string | null
  receivables: { amount: number; overdue: number; snapshotDate: string; latestConfirmedPaymentAt: string | null } | null
  factors: Array<{ label: string; amount: number; movementCount: number; effect: 'CASH_ONLY' | 'INFORMATIONAL' }>
  explanation: string
}

export function buildResultVsCashReport(input: {
  resultYtd: string | null
  resultEstimated: boolean
  resultCoverage: string
  resultAsOfDate: string | null
  resultThroughMonth: number | null
  bankBalance: number | null
  accountBalances: FinancialAccountBalance[]
  nonPnl: NonPnlCashData | null
  collection: CurrentCobranzaPosition | null
  year: number
}): ResultVsCashReport {
  const accounts = input.accountBalances.map(account => ({ name: account.bankName, maskedAccount: account.maskedAccountNumber, balance: account.balance, date: account.balanceDate }))
  // A zero returned by the bank dashboard with no observations is not a verified balance.
  const bankBalance = accounts.length > 0 && accounts.every(account => account.balance !== null && account.date !== null)
    ? input.bankBalance : null
  const definitions = [
    { code: 'EXPENSE_OWNER_WITHDRAWAL', label: 'Retiros de socios', effect: 'CASH_ONLY' },
    { code: 'LOAN_RECEIPT', label: 'Préstamos recibidos', effect: 'CASH_ONLY' },
    { code: 'LOAN_PAYMENT', label: 'Principal de préstamos pagado', effect: 'CASH_ONLY' },
    { code: 'CREDIT_LINE_DRAW', label: 'Uso de línea de crédito', effect: 'CASH_ONLY' },
    { code: 'CREDIT_LINE_PAYMENT', label: 'Restitución de línea de crédito', effect: 'CASH_ONLY' },
    { code: 'INCOME_CONTRIBUTIONS', label: 'Aportes de socios', effect: 'CASH_ONLY' },
    { code: 'EXPENSE_ASSETS', label: 'Inversiones / activos', effect: 'CASH_ONLY' },
    { code: 'INTERCOMPANY', label: 'Transferencias internas consolidadas', effect: 'INFORMATIONAL' },
  ] as const
  const factorThroughDate = input.resultAsOfDate ?? (input.resultThroughMonth === null ? null : new Date(Date.UTC(input.year, input.resultThroughMonth, 0)).toISOString().slice(0, 10))
  const movements = (input.nonPnl?.movements ?? []).filter(item =>
    factorThroughDate !== null && item.date >= `${input.year}-01-01` && item.date <= factorThroughDate)
  const factors = definitions.flatMap(definition => {
    const selected = movements.filter(item => definition.code === 'INTERCOMPANY'
      ? ['INCOME_INTERNAL_TRANSFER', 'EXPENSE_INTERNAL_TRANSFER', 'INCOME_INTERCOMPANY', 'EXPENSE_INTERCOMPANY'].includes(item.categoryCode)
      : definition.code === 'LOAN_RECEIPT' || definition.code === 'LOAN_PAYMENT' || definition.code === 'CREDIT_LINE_DRAW' || definition.code === 'CREDIT_LINE_PAYMENT'
        ? item.subtype === definition.code
        : item.categoryCode === definition.code)
    if (!selected.length) return []
    return [{ label: definition.label, amount: selected.reduce((sum, item) => sum + consolidatedNonPnlImpact(item), 0), movementCount: selected.length, effect: definition.effect }]
  })
  return {
    resultYtd: input.resultYtd,
    resultEstimated: input.resultEstimated,
    resultCoverage: input.resultCoverage,
    resultAsOfDate: input.resultAsOfDate,
    factorThroughDate,
    bankBalance,
    accounts,
    nominalDifference: input.resultYtd !== null && bankBalance !== null ? subtractMoney(String(bankBalance), input.resultYtd) : null,
    receivables: input.collection ? { amount: input.collection.allPortfolio.receivableAmount, overdue: input.collection.allPortfolio.overdueAmount, snapshotDate: input.collection.asOfDate, latestConfirmedPaymentAt: input.collection.latestConfirmedPaymentAt } : null,
    factors,
    explanation: 'El resultado mide utilidad económica; el saldo bancario mide efectivo disponible. Cobranza pendiente, inventario, financiamiento, retiros y diferencias de fecha provocan que ambos valores sean distintos. La diferencia nominal no es una conciliación ni un error.',
  }
}
