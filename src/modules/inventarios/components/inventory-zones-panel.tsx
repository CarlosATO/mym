import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { getInventorySessionImportContext } from '@/app/actions/inventarios/sessions'
import { InventoryOperationalSetup } from '@/modules/inventarios/components/inventory-operational-setup'

interface InventoryZonesPanelProps {
  detail: InventorySessionDetail
  canManageZones: boolean
}

export async function InventoryZonesPanel({ detail, canManageZones }: InventoryZonesPanelProps) {
  const importContextResult = await getInventorySessionImportContext(detail.session.id)
  const campaignId = importContextResult.data?.campaign_id

  if (campaignId) {
    return (
      <InventoryOperationalSetup
        companyId={detail.session.company_id}
        sessionId={detail.session.id}
        campaignId={campaignId}
        readOnly={detail.session.status !== 'DRAFT'}
        canManageZones={canManageZones}
      />
    )
  }

  const zones = detail.zones

  if (!zones || zones.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-theme-border bg-theme-surface/60 px-4 py-4 text-center text-xs text-theme-text-muted">
        Sin zonas configuradas.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 bg-theme-text/[0.02] px-3 py-2">
        <p className="text-xs font-semibold text-theme-text">
          Zonas configuradas <span className="font-normal text-theme-text-muted">· {zones.length}</span>
        </p>
      </div>
      <ul className="divide-y divide-theme-border/40">
        {zones.map(zone => (
          <li key={zone.id} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="truncate text-sm font-semibold text-theme-text">{zone.display_name}</span>
              <span className="shrink-0 rounded bg-theme-text/5 px-1.5 py-0.5 font-mono text-[10px] font-medium text-theme-text-muted">
                {zone.zone_code}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-theme-text-muted">
                {zone.locations?.length ?? 0} ubicacion{(zone.locations?.length ?? 0) === 1 ? '' : 'es'}
              </span>
            </div>
            {zone.locations && zone.locations.length > 0 ? (
              <ul className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                {zone.locations.map(location => (
                  <li key={location.location_id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-theme-text">{location.name ?? location.code}</span>
                    <span className="shrink-0 font-mono text-theme-text-muted">{location.code}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-theme-text-muted/60">Sin ubicaciones asignadas.</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
