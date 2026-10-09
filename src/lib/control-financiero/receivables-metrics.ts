export type ReceivablesMonthlyOverdue = {
  month: number
  overdue_amount: string | null
}

export function receivablesEvolutionRate(
  previous: string | null,
  current: string | null,
): number | null {
  if (previous === null || current === null) return null
  const previousAmount = Number(previous)
  if (previousAmount === 0) return null
  return ((previousAmount - Number(current)) / previousAmount) * 100
}

export function findPreviousClosedOverdue(
  months: ReceivablesMonthlyOverdue[],
  cutoffDate: string | null,
): string | null {
  const cutoffMonth = cutoffDate ? Number(cutoffDate.slice(5, 7)) : 13
  const closedMonths = months.filter(
    month => month.month < cutoffMonth && month.overdue_amount !== null,
  )
  return closedMonths[closedMonths.length - 1]?.overdue_amount ?? null
}
