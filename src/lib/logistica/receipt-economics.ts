export type PurchaseOrderLineEconomics = {
  quantity: number
  unitPrice: number
  discountPercent?: number | null
  discountAmount?: number | null
  taxRate?: number | null
}

export type ReceiptEconomics = {
  netAmount: number
  taxAmount: number
  grossAmount: number
  netUnitCost: number
}

export function calculateReceiptEconomics(
  line: PurchaseOrderLineEconomics,
  receivedQuantity: number,
): ReceiptEconomics {
  const quantity = Math.max(0, Number(line.quantity || 0))
  const received = Math.max(0, Number(receivedQuantity || 0))
  const unitPrice = Number(line.unitPrice || 0)
  const taxRate = Number(line.taxRate ?? 19)
  const fullBase = quantity * unitPrice
  const persistedDiscount = Number(line.discountAmount || 0)
  const percentageDiscount = fullBase * Number(line.discountPercent || 0) / 100
  const fullDiscount = persistedDiscount > 0 ? persistedDiscount : percentageDiscount
  const base = received * unitPrice
  const discount = quantity > 0 ? fullDiscount * received / quantity : 0
  const netAmount = Math.max(0, base - discount)
  const taxAmount = netAmount * taxRate / 100
  const grossAmount = netAmount + taxAmount

  return {
    netAmount,
    taxAmount,
    grossAmount,
    netUnitCost: received > 0 ? netAmount / received : 0,
  }
}
