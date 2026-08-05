import { Layers, MapPin } from 'lucide-react'
import { getActiveCompanyCampaignDetail, getCampaignSessionCreatePermission } from '@/app/actions/inventarios/campaigns'
import { getCompanyImportPermissions } from '@/app/actions/inventarios/imports'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryCampaignSiteCard } from '@/modules/inventarios/components/inventory-campaign-site-card'
import { InventoryCampaignStockTheoreticalSelector } from '@/modules/inventarios/components/inventory-campaign-stock-theoretical-selector'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { formatDateChile } from '@/modules/inventarios/lib/format'

const CAMPAIGN_TYPE_LABELS: Record<string, string> = {
  GENERAL: 'General',
  SELECTIVE: 'Selectivo',
  EXTERNAL: 'Externo',
}

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function InventariosCampanaDetallePage({ params }: PageProps) {
  const { id } = await params
  const [{ data: detail, error, companyId }, importPermissions, permission] = await Promise.all([
    getActiveCompanyCampaignDetail(id),
    getCompanyImportPermissions(),
    getCampaignSessionCreatePermission(),
  ])

  if (!companyId) {
    return (
      <div className="space-y-5">
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<Layers className="h-5 w-5" />}
        />
      </div>
    )
  }

  if (error && !detail) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description={error} />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description="La campaña solicitada no existe." />
      </div>
    )
  }

  const campaign = detail.campaign
  const canCreate = permission.canCreate && campaign.status === 'DRAFT'
  const allHaveSessions = detail.site_count > 0 && detail.sessions_pending === 0
  const noneHaveSessions = detail.site_count > 0 && detail.session_count === 0
  const plannedOrCreated = campaign.planned_at ?? campaign.created_at

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title={campaign.name}
        description={`Campaña ${(CAMPAIGN_TYPE_LABELS[campaign.campaign_type] ?? campaign.campaign_type).toLowerCase()} de inventario.`}
        breadcrumb={['Inventarios', 'Campañas', 'Detalle']}
      />

      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Tipo</p>
            <p className="font-medium text-theme-text">{CAMPAIGN_TYPE_LABELS[campaign.campaign_type] ?? campaign.campaign_type}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Estado</p>
            <div className="mt-0.5">
              <InventoryStatusBadge status={campaign.status} />
            </div>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Alcance de unidades</p>
            <p className="font-medium text-theme-text">
              {campaign.site_scope === 'ALL_INTERNAL' ? 'Todas las bodegas' : 'Seleccionadas'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Alcance de productos</p>
            <p className="font-medium text-theme-text">
              {campaign.product_scope === 'ALL'
                ? 'Todos los productos'
                : `${detail.products.length} producto(s) seleccionado(s)`}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Fecha</p>
            <p className="font-medium text-theme-text">{formatDateChile(plannedOrCreated)}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Unidades</p>
            <p className="font-medium text-theme-text">{detail.site_count}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Sesiones creadas</p>
            <p className="font-medium text-theme-text">{detail.session_count}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Sesiones pendientes</p>
            <p className="font-medium text-theme-text">{detail.sessions_pending}</p>
          </div>
        </div>
      </div>

      <InventoryCampaignStockTheoreticalSelector
        canRead={importPermissions.canRead}
        canManage={importPermissions.canManage}
        canGenerateSessions={canCreate}
        campaignId={campaign.id}
        campaignStatus={campaign.status}
        cutoffAt={plannedOrCreated}
        sessionCount={detail.session_count}
        sessionsPending={detail.sessions_pending}
        siteCount={detail.site_count}
      />

      {noneHaveSessions && (
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 text-sm text-theme-text-muted">
          Crea una sesión para la unidad que deseas preparar.
        </div>
      )}

      {allHaveSessions && (
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 text-sm text-theme-text-muted">
          Todas las unidades de esta campaña ya tienen una sesión.
        </div>
      )}

      {detail.sites.length === 0 ? (
        <InventoryEmptyState
          title="Sin unidades"
          description="Esta campaña todavía no tiene unidades configuradas."
          icon={<MapPin className="h-5 w-5" />}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {detail.sites.map(site => (
            <InventoryCampaignSiteCard key={site.campaign_site_id} site={site} canCreate={canCreate} />
          ))}
        </div>
      )}
    </div>
  )
}
