import type { PurchaseOrderLineTotals, PurchaseOrderLineTotalsInput, PurchaseOrderTotals } from './purchase-order-totals'

type CommercialLine = PurchaseOrderLineTotalsInput & {
  commercial_factor?: number
  commercial_price_raw?: string
}

// Inputs accepted by the draft RPC have at most four decimal places. Work in
// integers until the final presentation to match PostgreSQL numeric rounding.
function scaled(value: number | string): bigint {
  const raw = typeof value === 'string' ? value.trim().replace(',', '.') : String(value)
  const match = /^(\d+)(?:\.(\d{0,4}))?$/.exec(raw)
  if (match) return BigInt(match[1]) * BigInt(10000) + BigInt((match[2] ?? '').padEnd(4, '0'))
  // Numeric form state may temporarily contain a computed value or exponent.
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n >= 1e21) return BigInt(0)
  const [whole, fraction] = n.toFixed(4).split('.')
  return BigInt(whole) * BigInt(10000) + BigInt(fraction)
}

function roundRatio(n: bigint, d: bigint): bigint {
  return (n + d / BigInt(2)) / d
}

function cents(line: CommercialLine) {
  const qty = scaled(line.quantity)
  const factor = Number.isSafeInteger(line.commercial_factor) && (line.commercial_factor ?? 0) > 0 ? line.commercial_factor! : 1
  const price = scaled(line.commercial_factor !== undefined ? (line.commercial_price_raw ?? '0') : line.unit_price)
  const gross = roundRatio(qty * price, BigInt(factor) * BigInt(1000000))
  const discount = line.discount_percent > 0
    ? roundRatio(gross * scaled(line.discount_percent), BigInt(1000000))
    : roundRatio(qty * scaled(line.discount_unit_amount ?? 0), BigInt(1000000))
  const net = gross - discount
  const tax = roundRatio(net * scaled(line.tax_rate), BigInt(1000000))
  return { gross, discount, net, tax }
}

export function calculateCommercialDraftLineTotals(line: CommercialLine): PurchaseOrderLineTotals {
  const { gross, discount, net, tax } = cents(line)
  return { gross_amount: Number(gross) / 100, discount_amount: Number(discount) / 100, net_amount: Number(net) / 100, tax_amount: Number(tax) / 100, line_total: Number(net + tax) / 100 }
}

export function calculateCommercialDraftTotals(lines: CommercialLine[]): PurchaseOrderTotals {
  let gross = BigInt(0), discount = BigInt(0), net = BigInt(0), tax = BigInt(0)
  for (const line of lines) {
    const amounts = cents(line)
    gross += amounts.gross; discount += amounts.discount; net += amounts.net; tax += amounts.tax
  }
  return { gross_total: Number(gross) / 100, discount_total: Number(discount) / 100, net_total: Number(net) / 100, tax_total: Number(tax) / 100, grand_total: Number(net + tax) / 100 }
}
