export function normalizeRut(value: string) {
  return value.trim().replace(/[.\-\s]/g, '').toUpperCase()
}

export function isValidRut(value: string) {
  const normalized = normalizeRut(value)
  if (!/^\d{7,8}[0-9K]$/.test(normalized)) return false

  const body = normalized.slice(0, -1)
  const verifier = normalized.slice(-1)
  let factor = 2
  let sum = 0
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * factor
    factor = factor === 7 ? 2 : factor + 1
  }
  const remainder = 11 - (sum % 11)
  const expected = remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder)
  return verifier === expected
}

export function formatRut(value: string | null | undefined) {
  if (!value) return '—'
  const normalized = normalizeRut(value)
  const body = normalized.slice(0, -1)
  const verifier = normalized.slice(-1)
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}\-${verifier}`
}
