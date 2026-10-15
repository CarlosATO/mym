export type PurchaseOrderDiscountMode = 'percent' | 'unit' | null

export interface PurchaseOrderDiscountValues {
  discount_percent: number
  discount_unit_amount: number
}

function finiteOrZero(value: number | null | undefined) {
  return Number.isFinite(value) ? Number(value) : 0
}

function roundDiscount(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function resolvePurchaseOrderDiscountMode(
  discountPercent: number | null | undefined,
  discountUnitAmount: number | null | undefined,
): PurchaseOrderDiscountMode {
  if (finiteOrZero(discountPercent) > 0) return 'percent'
  if (finiteOrZero(discountUnitAmount) > 0) return 'unit'
  return null
}

export function getPurchaseOrderDiscountDisplayValues(line: {
  unit_price: number
  discount_percent: number
  discount_unit_amount?: number | null
  discount_mode: PurchaseOrderDiscountMode
}): PurchaseOrderDiscountValues {
  const unitPrice = Math.max(finiteOrZero(line.unit_price), 0)
  if (line.discount_mode === 'unit') {
    const unitAmount = Math.min(Math.max(finiteOrZero(line.discount_unit_amount), 0), unitPrice)
    return {
      discount_percent: unitPrice > 0 ? roundDiscount((unitAmount / unitPrice) * 100) : 0,
      discount_unit_amount: unitAmount,
    }
  }
  if (line.discount_mode === 'percent') {
    const percent = Math.min(Math.max(finiteOrZero(line.discount_percent), 0), 100)
    return {
      discount_percent: percent,
      discount_unit_amount: roundDiscount(unitPrice * percent / 100),
    }
  }
  return { discount_percent: 0, discount_unit_amount: 0 }
}

export function getPurchaseOrderDiscountPayload(line: {
  unit_price: number
  discount_percent: number
  discount_unit_amount?: number | null
  discount_mode: PurchaseOrderDiscountMode
}): PurchaseOrderDiscountValues {
  const display = getPurchaseOrderDiscountDisplayValues(line)
  return line.discount_mode === 'unit'
    ? { discount_percent: 0, discount_unit_amount: display.discount_unit_amount }
    : line.discount_mode === 'percent'
      ? { discount_percent: display.discount_percent, discount_unit_amount: 0 }
      : { discount_percent: 0, discount_unit_amount: 0 }
}
