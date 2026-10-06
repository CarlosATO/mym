export type BsaleMermaExclusionDecision = {
  accepted: boolean
  excluded: boolean
}

export function classifyBsaleMermaConsumption(
  consumptionId: number,
  consumptionTypeId: number | string | null | undefined,
  excludedIds: ReadonlySet<number>,
): BsaleMermaExclusionDecision {
  if (Number(consumptionTypeId) !== 2) return { accepted: false, excluded: false }
  if (excludedIds.has(consumptionId)) return { accepted: false, excluded: true }
  return { accepted: true, excluded: false }
}
