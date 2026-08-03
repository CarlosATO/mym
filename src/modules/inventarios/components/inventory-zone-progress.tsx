import { Check, MapPin } from 'lucide-react'
import type { InventorySessionZone } from '@/app/actions/inventarios/sessions'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'

interface ZoneWithTask {
  zone: InventorySessionZone
  task: {
    status: string
    assignedUser?: string | null
  } | null
}

interface InventoryZoneProgressProps {
  zones: Array<{ zone: InventorySessionZone; taskStatus?: string | null; assignedUser?: string | null }>
}

export function InventoryZoneProgress({ zones }: InventoryZoneProgressProps) {
  const rows: ZoneWithTask[] = zones.map(z => ({
    zone: z.zone,
    task: z.taskStatus ? { status: z.taskStatus, assignedUser: z.assignedUser } : null,
  }))

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 text-center text-sm text-theme-text-muted shadow-sm">
        Sin zonas activas.
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-theme-text">Zonas</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map(({ zone, task }) => (
          <div key={zone.id} className="rounded-lg border border-theme-border/50 bg-theme-text/2 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium text-theme-text">{zone.display_name}</p>
              {task ? <InventoryStatusBadge status={task.status} /> : <span className="text-xs text-theme-text-muted/60">Sin tarea</span>}
            </div>
            {task?.assignedUser && (
              <p className="mt-1 text-xs text-theme-text-muted">Tomador: {task.assignedUser}</p>
            )}
            {zone.locations && zone.locations.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {zone.locations.slice(0, 3).map(location => (
                  <li key={location.location_id} className="flex items-center gap-1 text-[11px] text-theme-text-muted">
                    <MapPin className="h-3 w-3 shrink-0 text-theme-text-muted/50" />
                    <span className="truncate">{location.name ?? location.code}</span>
                  </li>
                ))}
                {(zone.locations?.length ?? 0) > 3 && (
                  <li className="pl-4 text-[11px] text-theme-text-muted/60">
                    +{(zone.locations?.length ?? 0) - 3} más
                  </li>
                )}
              </ul>
            )}
            {task?.status === 'COMPLETED' && (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                <Check className="h-3 w-3" /> Zona completada
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
