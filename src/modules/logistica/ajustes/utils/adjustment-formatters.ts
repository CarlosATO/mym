export function formatQty(n: number) {
  return n.toLocaleString('es-CL', { maximumFractionDigits: 4 })
}

export function formatMoney(n: number | null) {
  if (n === null || isNaN(n)) return '—'
  return n.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

export function formatDate(date: string | null) {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('es-CL')
}

export function adjustmentTypeLabel(type: string) {
  return type === 'NEGATIVE' ? 'Ajuste de salida -' : 'Ajuste de ingreso +'
}
