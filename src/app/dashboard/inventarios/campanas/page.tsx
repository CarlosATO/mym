import { Layers } from 'lucide-react'
import { getActiveCompanyCampaigns } from '@/app/actions/inventarios/campaigns'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { formatDateChile } from '@/modules/inventarios/lib/format'

function campaignTypeLabel(type: string): string {
  if (type === 'GENERAL') return 'General'
  if (type === 'SELECTIVE') return 'Selectivo'
  if (type === 'EXTERNAL') return 'Externo'
  return type
}

function scopeLabel(scope: string | null): string {
  if (scope === 'ALL_INTERNAL') return 'Todas las bodegas'
  if (scope === 'SELECTED') return 'Seleccionadas'
  return '—'
}

export default async function InventariosCampanasPage() {
  const { data, error, companyId } = await getActiveCompanyCampaigns()
  const campaigns = data ?? []

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Campañas"
        description="Agrupa sesiones de inventario por unidad. Una campaña puede ser general, selectiva o externa."
        breadcrumb={['Inventarios', 'Campañas']}
      />

      {error ? (
        <InventoryErrorState description={error} />
      ) : !companyId ? (
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<Layers className="h-5 w-5" />}
        />
      ) : campaigns.length === 0 ? (
        <InventoryEmptyState
          title="Sin campañas"
          description="Las campañas de inventario aparecerán aquí."
          icon={<Layers className="h-5 w-5" />}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {campaigns.map(campaign => (
            <div key={campaign.id} className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-theme-text">{campaign.name}</p>
                  <p className="mt-0.5 text-xs text-theme-text-muted">
                    {campaignTypeLabel(campaign.campaign_type)} · {scopeLabel(campaign.site_scope)} ·{' '}
                    {campaign.product_scope === 'ALL' ? 'todos los productos' : 'productos seleccionados'}
                  </p>
                </div>
                <InventoryStatusBadge status={campaign.status} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-theme-border/60 pt-3 text-xs text-theme-text-muted">
                <span>{campaign.site_count} unidad(es)</span>
                <span>{campaign.product_count} producto(s)</span>
                <span>{campaign.session_count} sesión(es)</span>
                <span>{formatDateChile(campaign.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
