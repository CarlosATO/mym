export function filterExcludedMermaReceptionIds(receptionIds: number[], excludedIds: Set<number>) {
  return receptionIds.filter(id => !excludedIds.has(id))
}
