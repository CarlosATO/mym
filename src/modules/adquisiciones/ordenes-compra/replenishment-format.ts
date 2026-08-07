export function fmt(n: number): string {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
}

export function fmtN(n: number): string {
  return n.toLocaleString('es-CL', { maximumFractionDigits: 0 })
}
