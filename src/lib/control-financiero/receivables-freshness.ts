export const RECEIVABLES_FRESHNESS_THRESHOLD_MINUTES = 3 * 60

export type ReceivablesFreshnessStatus = 'FRESH' | 'STALE' | 'NO_DATA'

export type ReceivablesFreshness = {
  status: ReceivablesFreshnessStatus
  ageMinutes: number | null
}

export function getReceivablesFreshness(snapshotAt: string | null | undefined, now = new Date()): ReceivablesFreshness {
  if (!snapshotAt) return { status: 'NO_DATA', ageMinutes: null }

  const snapshotTime = new Date(snapshotAt).getTime()
  if (!Number.isFinite(snapshotTime)) return { status: 'NO_DATA', ageMinutes: null }

  const ageMinutes = Math.max(0, Math.floor((now.getTime() - snapshotTime) / 60_000))
  return {
    status: ageMinutes <= RECEIVABLES_FRESHNESS_THRESHOLD_MINUTES ? 'FRESH' : 'STALE',
    ageMinutes,
  }
}

export function formatReceivablesSnapshotAt(snapshotAt: string | null | undefined): string | null {
  if (!snapshotAt || !Number.isFinite(new Date(snapshotAt).getTime())) return null

  const parts = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(snapshotAt))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.day}-${values.month}-${values.year} ${values.hour}:${values.minute}`
}
