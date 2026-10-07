export function normalizeBsaleRelatedDetailId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
