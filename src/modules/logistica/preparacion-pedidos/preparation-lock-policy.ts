export type PreparationLockView = {
  status: string
  currentUserId: string | null
  lockedByUserId: string | null
  lockedByName?: string | null
  canManage?: boolean
  canTakeover?: boolean
}

export function isPreparationReadOnly(view: PreparationLockView): boolean {
  if (view.status !== 'IN_PREPARATION') return false
  return !view.currentUserId || view.lockedByUserId !== view.currentUserId
}

export function canClaimPreparation(view: PreparationLockView): boolean {
  return view.status === 'IN_PREPARATION'
    && !view.lockedByUserId
    && Boolean(view.canManage)
}

export function canTakeoverPreparation(view: PreparationLockView): boolean {
  return view.status === 'IN_PREPARATION'
    && Boolean(view.lockedByUserId)
    && Boolean(view.currentUserId)
    && view.lockedByUserId !== view.currentUserId
    && Boolean(view.canTakeover)
}

export function getPreparationLockLabel(view: PreparationLockView): string | null {
  if (view.status !== 'IN_PREPARATION') return null
  if (!view.lockedByUserId) return 'Sin responsable asignado'
  if (view.lockedByUserId === view.currentUserId) return 'Tu preparación'
  return `En preparación por ${view.lockedByName || 'otro usuario'}`
}

export function isPreparationLockError(message: string | null | undefined): boolean {
  if (!message) return false
  return /asignada a otro usuario|ya fue tomada por otro preparador|aún no tiene responsable|sin responsable|tomar la preparación de otro usuario/i.test(message)
}
