export type PurchaseOrderDiscountMode = 'percent' | 'unit' | null

export interface PurchaseOrderDiscountValues {
  discount_percent: number
  discount_unit_amount: number
}

export function finiteOrZero(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  const normalized = typeof value === 'string' ? value.replace(',', '.').trim() : value
  const parsed = typeof normalized === 'number' ? normalized : Number(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function roundDiscount(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function resolvePurchaseOrderDiscountMode(
  discountPercent: number | string | null | undefined,
  discountUnitAmount: number | string | null | undefined,
): PurchaseOrderDiscountMode {
  if (finiteOrZero(discountPercent) > 0) return 'percent'
  if (finiteOrZero(discountUnitAmount) > 0) return 'unit'
  return null
}

export function getPurchaseOrderDiscountDisplayValues(line: {
  unit_price: number | string
  discount_percent: number | string
  discount_unit_amount?: number | string | null
  discount_mode?: PurchaseOrderDiscountMode
}): PurchaseOrderDiscountValues {
  const unitPrice = Math.max(finiteOrZero(line.unit_price), 0)
  const mode = line.discount_mode ?? resolvePurchaseOrderDiscountMode(line.discount_percent, line.discount_unit_amount)

  if (mode === 'unit') {
    const unitAmount = Math.min(Math.max(finiteOrZero(line.discount_unit_amount), 0), unitPrice)
    return {
      discount_percent: unitPrice > 0 ? roundDiscount((unitAmount / unitPrice) * 100) : 0,
      discount_unit_amount: unitAmount,
    }
  }
  if (mode === 'percent') {
    const percent = Math.min(Math.max(finiteOrZero(line.discount_percent), 0), 100)
    return {
      discount_percent: percent,
      discount_unit_amount: roundDiscount((unitPrice * percent) / 100),
    }
  }
  return { discount_percent: 0, discount_unit_amount: 0 }
}

export function getPurchaseOrderDiscountPayload(line: {
  unit_price: number | string
  discount_percent: number | string
  discount_unit_amount?: number | string | null
  discount_mode?: PurchaseOrderDiscountMode
}): PurchaseOrderDiscountValues {
  const mode = line.discount_mode ?? resolvePurchaseOrderDiscountMode(line.discount_percent, line.discount_unit_amount)
  const display = getPurchaseOrderDiscountDisplayValues({ ...line, discount_mode: mode })

  return mode === 'unit'
    ? { discount_percent: 0, discount_unit_amount: display.discount_unit_amount }
    : mode === 'percent'
      ? { discount_percent: display.discount_percent, discount_unit_amount: 0 }
      : { discount_percent: 0, discount_unit_amount: 0 }
}
