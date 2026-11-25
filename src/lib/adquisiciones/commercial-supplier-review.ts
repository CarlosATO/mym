import { convertPurchaseDecimal, isPurchaseMultiple } from './purchase-commercial-decimal'

export function commercialReviewConvert(value: string, factor: number, direction: 'multiply' | 'divide', internal: boolean): string {
  const result = convertPurchaseDecimal(value, factor, direction, internal)
  return result.ok ? result.value : ''
}

export function commercialReviewValidQuantity(quantity: number, factor?: number): boolean {
  return Number.isFinite(quantity) && quantity > 0 && (factor === undefined || isPurchaseMultiple(String(quantity), factor))
}

/** Compare the values the RPC saves, independent of UI-only state. */
export function commercialReviewFingerprint(items: unknown[]): string {
  return JSON.stringify(items)
}

function normalizedDecimal(value: unknown): string {
  const text = String(value).replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(text)) return text
  const [whole, fraction = ''] = text.split('.')
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`
}

export function commercialReviewChangedFields(original: Record<string, unknown>, current: Record<string, unknown>) {
  const fields = ['quantity', 'unit_price', 'commercial_unit_price', 'discount_percent', 'discount_unit_amount', 'tax_rate', 'notes'] as const
  return fields.flatMap(field => {
    const before = field === 'commercial_unit_price' ? original.commercial_unit_price_snapshot ?? original.commercial_unit_price : original[field]
    const after = current[field]
    const equal = field === 'notes' ? (before || null) === (after || null) : before == null && after == null || before != null && after != null && normalizedDecimal(before) === normalizedDecimal(after)
    return equal ? [] : [{ field, original: before, current: after }]
  })
}
