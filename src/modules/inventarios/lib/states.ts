export const INVENTORY_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Borrador',
  PREPARED: 'Preparada',
  COUNTING: 'En conteo',
  UNDER_REVIEW: 'En revisión',
  APPROVED: 'Aprobada',
  EXPORTED: 'Exportada',
  RECONCILED: 'Conciliada',
  CANCELLED: 'Cancelada',
}

export type InventoryStatusTone =
  | 'neutral'
  | 'info'
  | 'warning'
  | 'purple'
  | 'success'
  | 'danger'

export const INVENTORY_STATUS_TONES: Record<string, InventoryStatusTone> = {
  DRAFT: 'neutral',
  PREPARED: 'info',
  COUNTING: 'warning',
  UNDER_REVIEW: 'purple',
  APPROVED: 'success',
  EXPORTED: 'success',
  RECONCILED: 'success',
  CANCELLED: 'danger',
}

export function inventoryStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Sin estado'
  return INVENTORY_STATUS_LABELS[status] ?? status
}

export function inventoryStatusTone(status: string | null | undefined): InventoryStatusTone {
  if (!status) return 'neutral'
  return INVENTORY_STATUS_TONES[status] ?? 'neutral'
}

export const INVENTORY_NAV_ITEMS = [
  { id: 'resumen', label: 'Resumen', href: '/dashboard/inventarios', icon: 'LayoutDashboard' },
  { id: 'jornadas', label: 'Jornadas', href: '/dashboard/inventarios/jornadas', icon: 'ClipboardList' },
  { id: 'operacion', label: 'Operación', href: '/dashboard/inventarios/operacion', icon: 'PlayCircle' },
  { id: 'revision', label: 'Revisión', href: '/dashboard/inventarios/revision', icon: 'Eye' },
  { id: 'resultados', label: 'Resultados', href: '/dashboard/inventarios/resultados', icon: 'FileCheck2' },
] as const
