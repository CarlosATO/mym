import { Layers, MapPin } from 'lucide-react'
import { getActiveCompanyCampaignDetail, getCampaignManagePermission, getCampaignSessionCreatePermission } from '@/app/actions/inventarios/campaigns'
import { getCompanyImportPermissions } from '@/app/actions/inventarios/imports'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryCampaignSiteCard } from '@/modules/inventarios/components/inventory-campaign-site-card'
import { InventoryCampaignStockTheoreticalSelector } from '@/modules/inventarios/components/inventory-campaign-stock-theoretical-selector'
import { InventoryCampaignParticipantTeam } from '@/modules/inventarios/components/inventory-campaign-participant-team'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { formatDateChile } from '@/modules/inventarios/lib/format'
import { getLatestCampaignStockImport, type CampaignStockImportDetail } from '@/app/actions/inventarios/imports'

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
  const [{ data: detail, error, companyId }, importPermissions, permission, managePermission] = await Promise.all([
    getActiveCompanyCampaignDetail(id),
    getCompanyImportPermissions(),
    getCampaignSessionCreatePermission(),
    getCampaignManagePermission(),
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
  const importFetch = await getLatestCampaignStockImport(campaign.id)
  const initialImport: CampaignStockImportDetail | null = importFetch.data
  const importError: string | null = importFetch.error
  const canCreate = permission.canCreate && campaign.status === 'DRAFT'
  const allHaveSessions = detail.site_count > 0 && detail.sessions_pending === 0
  const noneHaveSessions = detail.site_count > 0 && detail.session_count === 0
  const plannedOrCreated = campaign.planned_at ?? campaign.created_at
  const sitesReadyCount = allHaveSessions ? detail.site_count : detail.session_count

  return (
    <div className="space-y-3">
      <nav className="flex items-center gap-1.5 text-xs text-theme-text-muted">
        <span>Inventarios</span>
        <span>/</span>
        <span>Campañas</span>
        <span>/</span>
        <span className="font-medium text-theme-text">Detalle</span>
      </nav>

      <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-lg font-bold text-theme-text">{campaign.name}</h1>
          <InventoryStatusBadge status={campaign.status} />
        </div>
        <p className="mt-1 text-xs text-theme-text-muted">
          {CAMPAIGN_TYPE_LABELS[campaign.campaign_type] ?? campaign.campaign_type}
          {' · '}
          {campaign.site_scope === 'ALL_INTERNAL' ? 'Todas las bodegas' : 'Bodegas seleccionadas'}
          {' · '}
          {campaign.product_scope === 'ALL' ? 'Todos los productos' : `${detail.products.length} producto(s)`}
          {' · '}
          {formatDateChile(plannedOrCreated)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-theme-text">
          <span>{detail.site_count} unidades</span>
          <span className="text-theme-border">·</span>
          <span>{detail.session_count} sesiones</span>
          <span className="text-theme-border">·</span>
          <span>{detail.sessions_pending} pendientes</span>
        </div>
      </section>

      {importError && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          No fue posible recuperar el archivo de stock de esta campaña.
        </div>
      )}

      <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <InventoryCampaignStockTheoreticalSelector
            key={initialImport?.import.id ?? 'no-campaign-import'}
            canRead={importPermissions.canRead}
            canManage={importPermissions.canManage}
            canGenerateSessions={canCreate}
            campaignId={campaign.id}
            campaignStatus={campaign.status}
            cutoffAt={plannedOrCreated}
            initialImport={initialImport}
            sessionCount={detail.session_count}
            sessionsPending={detail.sessions_pending}
            siteCount={detail.site_count}
          />
        </div>
        <div className="lg:col-span-2">
          <InventoryCampaignParticipantTeam
            companyId={companyId}
            campaignId={campaign.id}
            campaignStatus={campaign.status}
            canManage={managePermission.canManage}
          />
        </div>
      </div>

      <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-theme-text">Unidades de la campaña</h2>
          {detail.site_count > 0 ? (
            allHaveSessions ? (
              <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {detail.site_count} de {detail.site_count} listas
              </span>
            ) : noneHaveSessions ? (
              <span className="inline-flex items-center rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-xs font-medium text-theme-text-muted">
                Sin sesiones creadas
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                {sitesReadyCount} de {detail.site_count} listas
              </span>
            )
          ) : (
            <span className="inline-flex items-center rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-xs font-medium text-theme-text-muted">
              Sin unidades
            </span>
          )}
        </div>

        {detail.sites.length === 0 ? (
          <InventoryEmptyState
            className="mt-3"
            title="Sin unidades"
            description="Esta campaña todavía no tiene unidades configuradas."
            icon={<MapPin className="h-5 w-5" />}
          />
        ) : (
          <>
            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
              {detail.sites.map(site => (
                <InventoryCampaignSiteCard key={site.campaign_site_id} site={site} canCreate={canCreate} />
              ))}
            </div>
            {noneHaveSessions && (
              <p className="mt-2.5 text-[11px] text-theme-text-muted">
                Crea una sesión para la unidad que deseas preparar.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  )
}
