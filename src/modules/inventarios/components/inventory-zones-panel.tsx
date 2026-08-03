import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'

interface InventoryZonesPanelProps {
  detail: InventorySessionDetail
}

export function InventoryZonesPanel({ detail }: InventoryZonesPanelProps) {
  const zones = detail.zones

  if (!zones || zones.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-theme-border bg-theme-surface/60 p-8 text-center">
        <p className="text-sm text-theme-text-muted">Sin zonas configuradas.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {zones.map(zone => (
        <div key={zone.id} className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-theme-text">{zone.display_name}</p>
              <p className="text-xs text-theme-text-muted">{zone.zone_code}</p>
            </div>
            <span className="shrink-0 text-[10px] font-medium text-theme-text-muted/60 uppercase tracking-wider">
              Prioridad {zone.priority}
            </span>
          </div>

          {zone.locations && zone.locations.length > 0 ? (
            <ul className="space-y-1">
              {zone.locations.map(location => (
                <li key={location.location_id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-theme-text">{location.name ?? location.code}</span>
                  <span className="shrink-0 font-mono text-theme-text-muted">{location.code}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-theme-text-muted/60">Sin ubicaciones asignadas.</p>
          )}
        </div>
      ))}
    </div>
  )
}
