'use client'

import type { LocationLifecycle } from '@/app/actions/logistica/locations'

export function lifecycleReasonText(reason: { code: string; message: string }) {
  switch (reason.code) {
    case 'STOCK_PRESENT': return 'Esta ubicación tiene stock.'
    case 'HISTORY_PRESENT': return 'Esta ubicación posee historial y su estructura física ya no puede modificarse.'
    case 'INVENTORY_REFERENCE': return 'Esta ubicación está referenciada por Inventarios.'
    case 'ACTIVE_OPERATION': return 'Esta ubicación participa en una operación activa.'
    default: return reason.message
  }
}

export function lifecycleReasons(lifecycle?: LocationLifecycle | null) {
  return (lifecycle?.blocking_reasons ?? []).map(lifecycleReasonText)
}

export function LocationLifecycleBadges({ lifecycle }: { lifecycle: LocationLifecycle }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
      <span className={lifecycle.found ? 'rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600' : 'rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-red-500'}>
        {lifecycle.found ? 'Disponible' : 'No encontrada'}
      </span>
      {lifecycle.has_stock && <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">Con stock</span>}
      {lifecycle.has_history && <span className="rounded border border-theme-border bg-theme-text/5 px-1.5 py-0.5 text-theme-text-muted">Con historial</span>}
      {lifecycle.has_active_operation && <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-amber-600">En operación activa</span>}
    </div>
  )
}
