/** Detect whether a receivables snapshot is active, paused, or abandoned.
 * A RUNNING database value is not proof that a worker is still executing.
 * The recovery grace period must exceed the GitHub Actions 429 retry cooldown.
 */
export const RECEIVABLES_SNAPSHOT_GRACE_MS = 10 * 60 * 1000

export type ReceivablesSnapshotExecution = 'IDLE' | 'ACTIVE' | 'INTERRUPTED' | 'PAUSED'

export function classifyReceivablesSnapshotExecution({
  runStatus,
  snapshotAt,
  lastProgressAt,
  lastRateLimitAt,
  hasLiveLock,
  rateLimited,
  now = new Date(),
}: {
  runStatus: string | null
  snapshotAt: string | null
  lastProgressAt: string | null
  lastRateLimitAt: string | null
  hasLiveLock: boolean
  rateLimited: boolean
  now?: Date
}): ReceivablesSnapshotExecution {
  if (runStatus !== 'RUNNING') return 'IDLE'
  if (hasLiveLock) return 'ACTIVE'

  const timestamps = [snapshotAt, lastProgressAt, lastRateLimitAt]
    .map(value => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite)
  // Missing or malformed timestamps must never authorise an automatic restart.
  if (timestamps.length === 0) return 'ACTIVE'

  const lastActivityAt = Math.max(...timestamps)
  if (now.getTime() - lastActivityAt < RECEIVABLES_SNAPSHOT_GRACE_MS) return 'ACTIVE'
  return rateLimited ? 'PAUSED' : 'INTERRUPTED'
}
