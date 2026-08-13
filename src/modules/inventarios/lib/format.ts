export function formatDateChile(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

export function formatDateTimeChile(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function computeProgress(taskCount: number, taskCompletedCount: number): number | null {
  if (!taskCount || taskCount <= 0) return null
  return Math.round((taskCompletedCount / taskCount) * 100)
}

const clpFormatter = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'CLP',
  maximumFractionDigits: 0,
})

export function formatCLP(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return clpFormatter.format(value)
}

export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const withDecimals = Math.abs(value % 1) > 0
  return value.toLocaleString('es-CL', { maximumFractionDigits: withDecimals ? 3 : 0 })
}

export function formatSignedQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const base = formatQuantity(value)
  if (value > 0) return `+${base}`
  if (value < 0) return `−${formatQuantity(Math.abs(value))}`
  return base
}
