/** Shared presentation of persisted document values. Never derive amounts from unit prices. */
export type DocumentLine = {
  item_type: string
  unit?: string | null
  quantity: number
  unit_price: number
  discount_amount: number
  tax_amount: number
  line_total: number
  purchase_unit_snapshot?: string | null
  purchase_unit_factor_snapshot?: number | null
  commercial_quantity?: number | null
  commercial_unit_price_snapshot?: number | string | null
  commercial_gross_amount_snapshot?: number | string | null
}

const cents = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100

export function documentLineValues(item: DocumentLine) {
  const factor = item.purchase_unit_factor_snapshot != null && Number(item.purchase_unit_factor_snapshot) > 0 ? Number(item.purchase_unit_factor_snapshot) : null
  const net = cents(Number(item.line_total) - Number(item.tax_amount))
  const gross = item.commercial_gross_amount_snapshot != null
    ? Number(item.commercial_gross_amount_snapshot)
    : cents(net + Number(item.discount_amount))
  return {
    factor,
    commercialUnit: factor === null ? null : item.purchase_unit_snapshot || 'Unidad',
    commercialQuantity: factor === null ? null : Number(item.commercial_quantity ?? Number(item.quantity) / factor),
    commercialPrice: factor === null || item.commercial_unit_price_snapshot == null ? null : Number(item.commercial_unit_price_snapshot),
    gross,
    net,
    discount: Number(item.discount_amount),
    tax: Number(item.tax_amount),
    total: Number(item.line_total),
  }
}
