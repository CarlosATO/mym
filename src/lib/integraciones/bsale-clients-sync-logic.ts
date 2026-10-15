export function getAbsentBsaleClientIds(localIds: number[], currentIds: number[]): number[] {
  const currentIdSet = new Set(currentIds)
  return localIds.filter(id => !currentIdSet.has(id))
}

export function canDeactivateAbsentClients({
  isDryRun,
  hasLimitOverride,
  fetchCompleted
}: {
  isDryRun: boolean
  hasLimitOverride: boolean
  fetchCompleted: boolean
}): boolean {
  return !isDryRun && !hasLimitOverride && fetchCompleted
}
