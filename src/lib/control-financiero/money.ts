type DecimalParts = { integer: bigint; scale: number }

function parseDecimal(value: string | null): DecimalParts | null {
  if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) return null
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction = ''] = unsigned.split('.')
  const integer = BigInt(`${whole}${fraction}`) * (negative ? -BigInt(1) : BigInt(1))
  return { integer, scale: fraction.length }
}

function formatDecimal(value: DecimalParts) {
  const negative = value.integer < BigInt(0)
  const absolute = negative ? -value.integer : value.integer
  const raw = absolute.toString().padStart(value.scale + 1, '0')
  if (!value.scale) return `${negative ? '-' : ''}${raw}`
  const fraction = raw.slice(-value.scale).replace(/0+$/, '')
  const whole = raw.slice(0, -value.scale) || '0'
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export function subtractMoney(left: string | null, right: string | null) {
  const leftParts = parseDecimal(left)
  const rightParts = parseDecimal(right)
  if (!leftParts || !rightParts) return null
  const scale = Math.max(leftParts.scale, rightParts.scale)
  const leftInteger = leftParts.integer * BigInt(10) ** BigInt(scale - leftParts.scale)
  const rightInteger = rightParts.integer * BigInt(10) ** BigInt(scale - rightParts.scale)
  return formatDecimal({ integer: leftInteger - rightInteger, scale })
}

export function addMoney(left: string | null, right: string | null) {
  const leftParts = parseDecimal(left)
  const rightParts = parseDecimal(right)
  if (!leftParts) return right
  if (!rightParts) return left
  const scale = Math.max(leftParts.scale, rightParts.scale)
  const leftInteger = leftParts.integer * BigInt(10) ** BigInt(scale - leftParts.scale)
  const rightInteger = rightParts.integer * BigInt(10) ** BigInt(scale - rightParts.scale)
  return formatDecimal({ integer: leftInteger + rightInteger, scale })
}

export function sumMoney(values: Array<string | null | undefined>) {
  return values.reduce<string | null>((total, value) => addMoney(total, value ?? null), '0') ?? '0'
}

export function percentageOf(value: string | null, denominator: string | null) {
  const valueParts = parseDecimal(value)
  const denominatorParts = parseDecimal(denominator)
  if (!valueParts || !denominatorParts || denominatorParts.integer === BigInt(0)) return null
  const valueNumber = Number(value)
  const denominatorNumber = Number(denominator)
  if (!Number.isFinite(valueNumber) || !Number.isFinite(denominatorNumber) || denominatorNumber === 0) return null
  return (valueNumber / denominatorNumber) * 100
}
