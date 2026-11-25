/** Decimal arithmetic at the numeric(14,4) precision of OC quantities and prices. */
const SCALE = BigInt(10_000)
const MAX_INTERNAL = BigInt('99999999999999')
const ZERO = BigInt(0)

export type CommercialDecimalResult =
  | { ok: true; value: string }
  | { ok: false; error: 'INVALID' | 'PRECISION' | 'OVERFLOW' }

function parse(value: string): bigint | null {
  const input = value.trim().replace(',', '.')
  if (!/^\d+(?:\.\d{0,4})?$/.test(input)) return null
  const [whole, fraction = ''] = input.split('.')
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'))
}

function format(value: bigint): string {
  const whole = value / SCALE
  const fraction = (value % SCALE).toString().padStart(4, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

/** Converts to or from internal units without rounding. */
export function convertPurchaseDecimal(value: string, factor: number, direction: 'multiply' | 'divide', internalResult: boolean): CommercialDecimalResult {
  const amount = parse(value)
  if (amount === null || !Number.isSafeInteger(factor) || factor < 1) return { ok: false, error: 'INVALID' }
  const divisor = BigInt(factor)
  if (direction === 'divide' && amount % divisor !== ZERO) return { ok: false, error: 'PRECISION' }
  const result = direction === 'multiply' ? amount * divisor : amount / divisor
  if (internalResult && result > MAX_INTERNAL) return { ok: false, error: 'OVERFLOW' }
  return { ok: true, value: format(result) }
}

/** Multiplicity applies to the ordered quantity, not partial receipts. */
export function isPurchaseMultiple(value: string, factor: number): boolean {
  const amount = parse(value)
  return amount !== null && amount > ZERO && Number.isSafeInteger(factor) && factor >= 1 && (factor === 1 || amount % (BigInt(factor) * SCALE) === ZERO)
}

/** Gross amount rounded to cents from the exact commercial price, not a rounded unit price. */
export function commercialGrossCents(quantity: string, commercialPrice: string, factor: number): bigint | null {
  const units = parse(quantity)
  const price = parse(commercialPrice)
  if (units === null || price === null || !Number.isSafeInteger(factor) || factor < 1) return null
  const numerator = units * price * BigInt(100)
  const denominator = BigInt(factor) * SCALE * SCALE
  return (numerator + denominator / BigInt(2)) / denominator
}

/** Difference of rounded cumulative amounts, so split receipts reconcile to the total. */
export function commercialReceiptGrossCents(previousQuantity: string, cumulativeQuantity: string, commercialPrice: string, factor: number): bigint | null {
  const previous = parse(previousQuantity)
  const cumulative = parse(cumulativeQuantity)
  if (previous === null || cumulative === null || cumulative < previous) return null
  const before = commercialGrossCents(previousQuantity, commercialPrice, factor)
  const after = commercialGrossCents(cumulativeQuantity, commercialPrice, factor)
  return before === null || after === null ? null : after - before
}
