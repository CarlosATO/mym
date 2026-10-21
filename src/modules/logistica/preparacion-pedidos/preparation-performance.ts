type PreparationMetric = 'boardLoad' | 'exclusionPersist' | 'sync' | 'prefetchBatch' | 'cardOpen' | 'invoicePreviewOpen'

type PreparationPerformanceSnapshot = {
  boardFetches: number
  boardLoadMs: number[]
  exclusionPersistMs: number[]
  syncMs: number[]
  prefetchBatchMs: number[]
  cardOpenMs: number[]
  invoicePreviewOpenMs: number[]
}

const snapshot: PreparationPerformanceSnapshot = {
  boardFetches: 0,
  boardLoadMs: [],
  exclusionPersistMs: [],
  syncMs: [],
  prefetchBatchMs: [],
  cardOpenMs: [],
  invoicePreviewOpenMs: [],
}

function isEnabled() {
  return process.env.NODE_ENV !== 'production'
}

export function markPreparationBoardFetch() {
  snapshot.boardFetches += 1
}

export function tracePreparationOpenPhase(
  phase: string,
  durationMs: number,
  detail?: Record<string, unknown>,
) {
  if (!isEnabled()) return
  console.debug(`[preparacion-open] ${phase} ${Math.max(0, Math.round(durationMs))}ms`, detail ?? '')
}

export function recordPreparationDuration(metric: PreparationMetric, durationMs: number) {
  const rounded = Math.max(0, Math.round(durationMs))
  if (metric === 'boardLoad') snapshot.boardLoadMs.push(rounded)
  if (metric === 'exclusionPersist') snapshot.exclusionPersistMs.push(rounded)
  if (metric === 'sync') snapshot.syncMs.push(rounded)
  if (metric === 'prefetchBatch') snapshot.prefetchBatchMs.push(rounded)
  if (metric === 'cardOpen') snapshot.cardOpenMs.push(rounded)
  if (metric === 'invoicePreviewOpen') snapshot.invoicePreviewOpenMs.push(rounded)

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
    prefetchBatchMs: [...snapshot.prefetchBatchMs],
    cardOpenMs: [...snapshot.cardOpenMs],
    invoicePreviewOpenMs: [...snapshot.invoicePreviewOpenMs],
  }
}

export function resetPreparationPerformance() {
  snapshot.boardFetches = 0
  snapshot.boardLoadMs = []
  snapshot.exclusionPersistMs = []
  snapshot.syncMs = []
  snapshot.prefetchBatchMs = []
  snapshot.cardOpenMs = []
  snapshot.invoicePreviewOpenMs = []
}
