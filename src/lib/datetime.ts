export const OPERATIONAL_TIME_ZONE = 'America/Santiago'

type CivilDateFormat = 'numeric' | 'short'

const SHORT_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

function parseCivilDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null
  return { year, month, day }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** Formats a PostgreSQL date without turning it into a timezone-bearing instant. */
export function formatCivilDate(value: string | null | undefined, format: CivilDateFormat = 'numeric'): string {
  if (!value) return ''
  const parsed = parseCivilDate(value)
  if (!parsed) return value

  const day = String(parsed.day).padStart(2, '0')
  const month = String(parsed.month).padStart(2, '0')
  if (format === 'short') return `${day} ${SHORT_MONTHS[parsed.month - 1]} ${parsed.year}`
  return `${day}-${month}-${parsed.year}`
}

/** Returns today's civil date according to Chile's IANA timezone rules. */
export function todayInSantiago(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new globalThis.Date())
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

/** Formats a timestamptz/ISO instant explicitly in Chile's operational timezone. */
export function formatInstantInSantiago(value: string | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return ''
  const instant = new globalThis.Date(value)
  if (Number.isNaN(instant.getTime())) return value

  return new Intl.DateTimeFormat('es-CL', {
    timeZone: OPERATIONAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...options,
  }).format(instant)
}
