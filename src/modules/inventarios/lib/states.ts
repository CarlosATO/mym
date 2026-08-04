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
  { id: 'campanas', label: 'Campañas', href: '/dashboard/inventarios/campanas', icon: 'Layers' },
  { id: 'jornadas', label: 'Jornadas', href: '/dashboard/inventarios/jornadas', icon: 'ClipboardList' },
  { id: 'unidades', label: 'Unidades', href: '/dashboard/inventarios/unidades', icon: 'Boxes' },
  { id: 'importaciones', label: 'Importaciones', href: '/dashboard/inventarios/importaciones', icon: 'Upload' },
  { id: 'operacion', label: 'Operación', href: '/dashboard/inventarios/operacion', icon: 'PlayCircle' },
  { id: 'revision', label: 'Revisión', href: '/dashboard/inventarios/revision', icon: 'Eye' },
  { id: 'resultados', label: 'Resultados', href: '/dashboard/inventarios/resultados', icon: 'FileCheck2' },
] as const

export const INVENTORY_ROLE_LABELS: Record<string, string> = {
  COUNTER: 'Contador',
  SUPERVISOR: 'Supervisor',
  ADMINISTRATOR: 'Administrador',
  MANAGER: 'Gerente',
}

export function inventoryRoleLabel(role: string | null | undefined): string {
  if (!role) return '—'
  return INVENTORY_ROLE_LABELS[role] ?? role
}

export const INVENTORY_TYPE_LABELS: Record<string, string> = {
  GENERAL: 'General',
  PARTIAL: 'Parcial',
  CYCLIC: 'Cíclico',
  CONTROL: 'Control',
  RECOUNT: 'Recuento',
}

export function inventoryTypeLabel(type: string | null | undefined): string {
  if (!type) return '—'
  return INVENTORY_TYPE_LABELS[type] ?? type
}
