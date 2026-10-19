type PreparationMetric = 'boardLoad' | 'exclusionPersist' | 'sync'

type PreparationPerformanceSnapshot = {
  boardFetches: number
  boardLoadMs: number[]
  exclusionPersistMs: number[]
  syncMs: number[]
}

const snapshot: PreparationPerformanceSnapshot = {
  boardFetches: 0,
  boardLoadMs: [],
  exclusionPersistMs: [],
  syncMs: [],
}

function isEnabled() {
  return process.env.NODE_ENV !== 'production'
}

export function markPreparationBoardFetch() {
  snapshot.boardFetches += 1
}

export function recordPreparationDuration(metric: PreparationMetric, durationMs: number) {
  const rounded = Math.max(0, Math.round(durationMs))
  if (metric === 'boardLoad') snapshot.boardLoadMs.push(rounded)
  if (metric === 'exclusionPersist') snapshot.exclusionPersistMs.push(rounded)
  if (metric === 'sync') snapshot.syncMs.push(rounded)

  if (isEnabled()) {
    console.debug(`[preparacion-perf] ${metric} ${rounded}ms`)
  }
}

export function getPreparationPerformanceSnapshot(): PreparationPerformanceSnapshot {
  return {
    boardFetches: snapshot.boardFetches,
    boardLoadMs: [...snapshot.boardLoadMs],
    exclusionPersistMs: [...snapshot.exclusionPersistMs],
    syncMs: [...snapshot.syncMs],
  }
}

export function resetPreparationPerformance() {
  snapshot.boardFetches = 0
  snapshot.boardLoadMs = []
  snapshot.exclusionPersistMs = []
  snapshot.syncMs = []
}
