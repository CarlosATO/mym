export const PREPARATION_SYNC_STALE_AFTER_MINUTES = 5
export const PREPARATION_SYNC_CHECK_INTERVAL_MS = 5 * 60 * 1000
export const PREPARATION_SYNC_VISIBILITY_MIN_GAP_MS = 30 * 1000
export const PREPARATION_SYNC_RETRY_MIN_MS = 60 * 1000
export const PREPARATION_SYNC_RUNNING_MAX_MINUTES = 15

export type PreparationSyncSkipReason = 'fresh' | 'running' | 'throttled'

export type PreparationSyncDecision =
  | { action: 'sync'; reason: 'stale' | 'no_evidence' }
  | { action: 'skip'; reason: PreparationSyncSkipReason }

export function decidePreparationSync(input: {
  lastSuccessAgeMinutes: number | null
  latestRunStatus: string | null
  latestRunAgeMinutes?: number | null
  lastAttemptAt?: number | null
  now?: number
}): PreparationSyncDecision {
  const now = input.now ?? Date.now()
  const lastAttemptAt = input.lastAttemptAt ?? null
  const latestRunAgeMinutes = input.latestRunAgeMinutes ?? null

  const isRunning = input.latestRunStatus === 'STARTED'
    && (latestRunAgeMinutes === null || latestRunAgeMinutes < PREPARATION_SYNC_RUNNING_MAX_MINUTES)

  if (isRunning) {
    return { action: 'skip', reason: 'running' }
  }

  if (
    input.lastSuccessAgeMinutes !== null
    && input.lastSuccessAgeMinutes < PREPARATION_SYNC_STALE_AFTER_MINUTES
  ) {
    return { action: 'skip', reason: 'fresh' }
  }

  if (lastAttemptAt !== null && now - lastAttemptAt < PREPARATION_SYNC_RETRY_MIN_MS) {
    return { action: 'skip', reason: 'throttled' }
  }

  return {
    action: 'sync',
    reason: input.lastSuccessAgeMinutes === null ? 'no_evidence' : 'stale',
  }
}

export type PreparationBoardRow = {
  card_id: string
  nv_bsale_id: number
  status: string
}

export function mergePreparationBoardRows<T extends PreparationBoardRow>(
  rows: T[],
  local: {
    pendingStatuses?: ReadonlyMap<string, string>
    pendingExclusionNvIds?: ReadonlySet<number>
  } = {},
): T[] {
  const pendingStatuses = local.pendingStatuses
  const pendingExclusionNvIds = local.pendingExclusionNvIds

  return rows
    .filter((row) => !pendingExclusionNvIds?.has(Number(row.nv_bsale_id)))
    .map((row) => {
      const pendingStatus = pendingStatuses?.get(row.card_id)
      return pendingStatus && pendingStatus !== row.status
        ? ({ ...row, status: pendingStatus } as T)
        : row
    })
}

export type PreparationCardSnapshot<T> = {
  card: T
  index: number
}

export function removeCardOptimistically<T extends { card_id: string }>(
  cards: T[],
  cardId: string,
): { cards: T[]; snapshot: PreparationCardSnapshot<T> | null } {
  const index = cards.findIndex((card) => card.card_id === cardId)
  if (index < 0) return { cards, snapshot: null }

  return {
    cards: cards.filter((_, currentIndex) => currentIndex !== index),
    snapshot: { card: cards[index], index },
  }
}

export function restoreCardOptimistically<T extends { card_id: string }>(
  cards: T[],
  snapshot: PreparationCardSnapshot<T> | null,
): T[] {
  if (!snapshot) return cards
  if (cards.some((card) => card.card_id === snapshot.card.card_id)) return cards

  const next = [...cards]
  const targetIndex = Math.max(0, Math.min(snapshot.index, next.length))
  next.splice(targetIndex, 0, snapshot.card)
  return next
}

export function shouldRefreshBoardAfterSync(input: {
  didRun: boolean
  previousRunId: string | null
  nextRunId: string | null
}): boolean {
  if (input.didRun) return true
  return Boolean(input.nextRunId && input.nextRunId !== input.previousRunId)
}

export type PreparationQueueLifecycleStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export type PreparationOperationalSyncPhase =
  | 'IDLE'
  | 'WAITING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'ERROR'

export function isPreparationOrdersTopbarSurface(params: {
  pathname: string | null | undefined
  tab: string | null | undefined
  roleName?: string | null
  permissions?: readonly string[]
}): boolean {
  if (params.pathname !== '/dashboard/logistica') return false
  if (params.tab === 'preparacion_pedidos') return true
  if (params.tab !== null && params.tab !== undefined && params.tab !== '') return false
  const role = String(params.roleName ?? '').trim().toUpperCase()
  const perms = params.permissions ?? []
  return (
    role === 'SUPER_USUARIO'
    || role === 'OPERADOR_BODEGA'
    || perms.includes('system.admin')
    || perms.includes('logistica.preparation.manage')
    || perms.includes('logistica.preparation.access')
  )
}

export function resolvePreparationBoardSyncUiState(input: {
  isLocalSyncing: boolean
  queueStatus: PreparationQueueLifecycleStatus | null
  activeLockRunning?: boolean
  latestRunStatus: string | null
  latestRunErrorMessage?: string | null
  syncError: string | null
  lastSuccessAgeMinutes: number | null
  hasHealth: boolean
}): {
  phase: PreparationOperationalSyncPhase
  isWaiting: boolean
  isRunning: boolean
  isError: boolean
  isFresh: boolean
  disableManualRefresh: boolean
  buttonLabel: string
  statusLabel: string
} {
  const isRunning = input.isLocalSyncing
    || input.queueStatus === 'RUNNING'
    || Boolean(input.activeLockRunning)
    || input.latestRunStatus === 'STARTED'
  const isWaiting = !isRunning && input.queueStatus === 'PENDING'
  const latestRunIsSkippedLock = String(input.latestRunErrorMessage ?? '').startsWith('SKIPPED_LOCKED:')
  const latestRunFailed = (input.latestRunStatus === 'FAILED' || input.latestRunStatus === 'PARTIAL') && !latestRunIsSkippedLock
  const isError = !isRunning
    && !isWaiting
    && (Boolean(input.syncError) || input.queueStatus === 'FAILED' || input.queueStatus === 'CANCELLED' || latestRunFailed)
  const isFresh = input.lastSuccessAgeMinutes !== null && input.lastSuccessAgeMinutes < PREPARATION_SYNC_STALE_AFTER_MINUTES

  const statusLabel = isRunning
    ? 'Sincronizando…'
    : isWaiting
      ? 'En espera…'
      : isError
        ? 'ERROR'
        : isFresh
          ? 'Actualizado'
          : input.hasHealth
            ? 'Desactualizado'
            : 'Sin evidencia'

  const phase: PreparationOperationalSyncPhase = isRunning
    ? 'RUNNING'
    : isWaiting
      ? 'WAITING'
      : isError
        ? 'ERROR'
        : input.queueStatus === 'COMPLETED' || isFresh
          ? 'COMPLETED'
          : 'IDLE'

  return {
    phase,
    isWaiting,
    isRunning,
    isError,
    isFresh,
    disableManualRefresh: isRunning || isWaiting,
    buttonLabel: isWaiting ? 'En espera…' : isRunning ? 'Sincronizando…' : 'Actualizar',
    statusLabel,
  }
}

export function resolveIndividualCardSyncUiState(input: {
  isLocalSyncing: boolean
  queueStatus: PreparationQueueLifecycleStatus | null
  activeLockRunning?: boolean
}): {
  phase: 'IDLE' | 'WAITING' | 'RUNNING'
  isBusy: boolean
  cardSyncPhase: 'WAITING' | 'RUNNING' | null
  buttonLabel: string
} {
  const isRunning = input.isLocalSyncing || input.queueStatus === 'RUNNING' || Boolean(input.activeLockRunning)
  const isWaiting = !isRunning && input.queueStatus === 'PENDING'
  const isBusy = isRunning || isWaiting
  return {
    phase: isWaiting ? 'WAITING' : isRunning ? 'RUNNING' : 'IDLE',
    isBusy,
    cardSyncPhase: isWaiting ? 'WAITING' : isRunning ? 'RUNNING' : null,
    buttonLabel: isWaiting ? 'En espera…' : isRunning ? 'Sincronizando…' : 'Sincronizar',
  }
}

export function shouldRefreshPreparationBoardOnQueueTransition(input: {
  requestId: string
  nextStatus: PreparationQueueLifecycleStatus
  skippedReason?: string | null
  alreadyProcessedIds: ReadonlySet<string>
}): boolean {
  if (!input.requestId || input.alreadyProcessedIds.has(input.requestId)) return false
  if (input.nextStatus !== 'COMPLETED') return false
  if (input.skippedReason) return false
  return true
}
