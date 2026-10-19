import type {
  SalesOrderPreparationItem,
  SalesOrderClientData,
  SalesOrderPreparationPrintData,
} from '@/app/actions/logistica/sales-order-preparation'

export type PreparationDetailEntry = {
  items: SalesOrderPreparationItem[]
  clientData: SalesOrderClientData | null
  loadedAt: number
}

export type PreparationDetailCache = Map<number, PreparationDetailEntry>

export function createPreparationDetailCache(): PreparationDetailCache {
  return new Map<number, PreparationDetailEntry>()
}

export function getUncachedNvIds(
  cache: PreparationDetailCache,
  nvIds: number[],
  inFlightIds?: Set<number>,
): number[] {
  const unique = [...new Set(nvIds.filter(id => Number.isFinite(id)))]
  return unique.filter(id => !cache.has(id) && (!inFlightIds || !inFlightIds.has(id)))
}

export function putPreparationDetailsBatch(
  cache: PreparationDetailCache,
  printData: SalesOrderPreparationPrintData,
  nvIds: number[],
  loadedAt: number = Date.now(),
): void {
  for (const nvId of nvIds) {
    const key = String(nvId)
    const items = printData.itemsByNv[key] || []
    const clientData = printData.clientByNv[key] || null
    cache.set(nvId, {
      items,
      clientData,
      loadedAt,
    })
  }
}

export function prunePreparationDetailCache(
  cache: PreparationDetailCache,
  activeNvIds: Iterable<number>,
): number {
  const activeSet = new Set(activeNvIds)
  let removed = 0
  for (const nvId of [...cache.keys()]) {
    if (!activeSet.has(nvId)) {
      cache.delete(nvId)
      removed += 1
    }
  }
  return removed
}
