import { todayInSantiago } from '@/lib/datetime'

export type PortalPeriodMode = 'CALENDAR_MONTH' | 'COMMISSIONABLE'

export type PortalPeriod = {
  from: string
  to: string
  toExclusive: string
}

/** Returns a sufficiently wide civil-date window ending today for daily charts. */
export function getPortalDailyPeriod(today = todayInSantiago()): PortalPeriod {
  const [year, month, day] = today.split('-').map(Number)
  const start = utcDate(year, month - 1, day)
  start.setUTCDate(start.getUTCDate() - 31)
  const endExclusive = utcDate(year, month - 1, day + 1)
  const end = new Date(endExclusive.getTime() - 86400000)
  return { from: formatDate(start), to: formatDate(end), toExclusive: formatDate(endExclusive) }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day))
}

/** Returns the selected Portal range as civil dates, with an exclusive end. */
export function getPortalPeriod(
  mode: PortalPeriodMode = 'CALENDAR_MONTH',
  today = todayInSantiago(),
): PortalPeriod {
  const [year, month, day] = today.split('-').map(Number)
  const currentMonth = utcDate(year, month - 1, 1)

  if (mode === 'COMMISSIONABLE') {
    const periodMonth = day <= 25
      ? utcDate(year, month - 2, 1)
      : currentMonth
    const start = utcDate(periodMonth.getUTCFullYear(), periodMonth.getUTCMonth() - 1, 26)
    const endExclusive = utcDate(periodMonth.getUTCFullYear(), periodMonth.getUTCMonth(), 26)
    const end = new Date(endExclusive.getTime() - 86400000)
    return { from: formatDate(start), to: formatDate(end), toExclusive: formatDate(endExclusive) }
  }

  const start = currentMonth
  const endExclusive = utcDate(year, month - 1, day + 1)
  const end = new Date(endExclusive.getTime() - 86400000)
  return { from: formatDate(start), to: formatDate(end), toExclusive: formatDate(endExclusive) }
}
