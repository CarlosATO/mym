export interface PurchaseOrderLineTotalsInput {
  quantity: number
  unit_price: number
  discount_percent: number
  discount_unit_amount?: number | null
  tax_rate: number
}

export interface PurchaseOrderLineTotals {
  gross_amount: number
  discount_amount: number
  net_amount: number
  tax_amount: number
  line_total: number
}

export interface PurchaseOrderTotals {
  gross_total: number
  discount_total: number
  net_total: number
  tax_total: number
  grand_total: number
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function calculatePurchaseOrderLineTotals(line: PurchaseOrderLineTotalsInput): PurchaseOrderLineTotals {
  const grossAmount = line.quantity * line.unit_price
  const discountAmount = line.discount_percent > 0 ? (grossAmount * line.discount_percent) / 100 : (line.discount_unit_amount ?? 0) > 0 ? line.quantity * (line.discount_unit_amount ?? 0) : 0
  const netAmount = grossAmount - discountAmount
  const taxAmount = (netAmount * line.tax_rate) / 100

  return {
    gross_amount: grossAmount,
    discount_amount: discountAmount,
    net_amount: netAmount,
    tax_amount: taxAmount,
    line_total: netAmount + taxAmount,
  }
}

export function calculatePurchaseOrderTotals(lines: PurchaseOrderLineTotalsInput[]): PurchaseOrderTotals {
  const totals = lines.reduce<PurchaseOrderTotals>(
    (summary, line) => {
      const lineTotals = calculatePurchaseOrderLineTotals(line)
      summary.gross_total += lineTotals.gross_amount
      summary.discount_total += lineTotals.discount_amount
      summary.net_total += lineTotals.net_amount
      summary.tax_total += lineTotals.tax_amount
      summary.grand_total += lineTotals.line_total
      return summary
    },
    {
      gross_total: 0,
      discount_total: 0,
      net_total: 0,
      tax_total: 0,
      grand_total: 0,
    },
  )

  return {
    gross_total: roundCurrency(totals.gross_total),
    discount_total: roundCurrency(totals.discount_total),
    net_total: roundCurrency(totals.net_total),
    tax_total: roundCurrency(totals.tax_total),
    grand_total: roundCurrency(totals.grand_total),
  }
}
