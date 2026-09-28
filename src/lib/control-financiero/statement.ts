import type { FinanceCogsResponse, FinanceSalesNetResponse } from './finance-api'
// @ts-expect-error Standalone Node harnesses use explicit TypeScript extensions.
import { percentageOf, subtractMoney } from './money.ts'

const MONTH_COUNT = 12

export type StatementRow = {
  label: string
  values: (string | null)[]
  ytd: string | null
  percentageYtd: number | null
  missing: (number | null)[]
  ytdMissing: number | null
  emphasis?: boolean
}

export function hasStatementInformation(
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
) {
  return Boolean(
    sales?.has_information
      || sales?.months.some(month => month.amount !== null)
      || cogs?.has_information
      || cogs?.months.some(month => month.net_cogs !== null || month.gross_cogs !== null || month.credit_note_reversal !== null),
  )
}

export function buildStatementRows(
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
): StatementRow[] {
  const emptyMonths = Array.from({ length: MONTH_COUNT }, () => null)
  const salesValues = sales?.months.map(month => month.amount) ?? emptyMonths
  const salesYtd = sales?.total_ytd ?? null
  const cogsMonths = cogs?.months ?? Array.from({ length: MONTH_COUNT }, (_, index) => ({
    month: index + 1,
    net_cogs: null,
    missing_document_count: null,
  }))
  const cogsValues = cogsMonths.map(month => month.net_cogs)
  const cogsMissing = cogsMonths.map(month => month.missing_document_count)
  const grossMargin = salesValues.map((value, index) => subtractMoney(value, cogsValues[index]))
  const marginYtd = subtractMoney(salesYtd, cogs?.ytd.net_cogs ?? null)

  return [
    { label: 'Ventas Netas', values: salesValues, ytd: salesYtd, percentageYtd: percentageOf(salesYtd, salesYtd), missing: emptyMonths, ytdMissing: null },
    { label: 'Costo de Ventas', values: cogsValues, ytd: cogs?.ytd.net_cogs ?? null, percentageYtd: percentageOf(cogs?.ytd.net_cogs ?? null, salesYtd), missing: cogsMissing, ytdMissing: cogs?.ytd.missing_document_count ?? null },
    { label: 'Margen Bruto', values: grossMargin, ytd: marginYtd, percentageYtd: percentageOf(marginYtd, salesYtd), missing: cogsMissing, ytdMissing: cogs?.ytd.missing_document_count ?? null, emphasis: true },
  ]
}
