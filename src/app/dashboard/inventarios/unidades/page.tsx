import Link from 'next/link'
import { ArrowRight, Boxes, MapPin } from 'lucide-react'
import { getActiveCompanyCampaigns, getActiveCompanyCampaignDetail } from '@/app/actions/inventarios/campaigns'
import { getActiveCompanySites } from '@/app/actions/inventarios/sites'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventorySitesPanel } from '@/modules/inventarios/components/inventory-sites-panel'
import { InventorySelector } from '@/modules/inventarios/components/inventory-inventory-selector'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function siteTypeLabel(type: string): string {
  if (type === 'INTERNAL_WAREHOUSE') return 'Bodega interna'
  if (type === 'OWN_STORE') return 'Tienda propia'
  return 'Sitio externo'
}

export default async function InventariosBodegasPage({ searchParams }: PageProps) {
  const params = await searchParams
  const raw = params.inventoryId
  const inventoryId = typeof raw === 'string' ? raw : ''

  const [campaignsResult, sitesResult] = await Promise.all([
    getActiveCompanyCampaigns(),
    getActiveCompanySites(),
  ])
  const companyId = campaignsResult.companyId ?? sitesResult.companyId

  let campaignDetail: Awaited<ReturnType<typeof getActiveCompanyCampaignDetail>> | null = null
  if (inventoryId && inventoryId !== 'all') {
    campaignDetail = await getActiveCompanyCampaignDetail(inventoryId)
  }

  const selectorOptions = (campaignsResult.data ?? []).map(c => ({ id: c.id, name: c.name }))

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Bodegas"
        description="Configura qué bodegas o locales participan en inventarios y cuáles se incluyen automáticamente en inventarios generales."
        breadcrumb={['Inventarios', 'Bodegas']}
      />

      {!companyId ? (
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<Boxes className="h-5 w-5" />}
        />
      ) : campaignsResult.error || sitesResult.error ? (
        <InventoryErrorState description={campaignsResult.error ?? sitesResult.error ?? 'Error'} />
      ) : (
        <>
          <InventorySelector inventories={selectorOptions} value={inventoryId} />

          {!inventoryId ? (
            <InventoryEmptyState
              title="Selecciona un inventario"
              description="Elige un inventario para ver las bodegas que lo componen, o &ldquo;Todas las bodegas&rdquo; para administrarlas."
              icon={<Boxes className="h-5 w-5" />}
            />
          ) : inventoryId === 'all' ? (
            (sitesResult.data ?? []).length === 0 ? (
              <InventoryEmptyState
                title="Sin bodegas inventariables"
                description="Las bodegas y locales que participan en inventarios aparecerán aquí."
                icon={<Boxes className="h-5 w-5" />}
              />
            ) : (
              <InventorySitesPanel sites={sitesResult.data ?? []} />
            )
          ) : campaignDetail?.data ? (
            <div className="rounded-xl border border-theme-border bg-theme-surface shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-theme-border/60 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-sm font-bold text-theme-text">{campaignDetail.data.campaign.name}</p>
                  <InventoryStatusBadge status={campaignDetail.data.campaign.status} />
                </div>
                <Link
                  href={`/dashboard/inventarios/campanas/${campaignDetail.data.campaign.id}`}
                  className="inline-flex h-6 items-center gap-1 text-xs font-semibold text-theme-accent transition-colors hover:underline"
                >
                  Ver resumen
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>

              {campaignDetail.data.sites.length === 0 ? (
                <div className="p-4">
                  <InventoryEmptyState
                    title="Este inventario no tiene bodegas"
                    description="Las bodegas se asignan al preparar el inventario."
                    icon={<MapPin className="h-5 w-5" />}
                  />
                </div>
              ) : (
                <div className="divide-y divide-theme-border/40">
                  {campaignDetail.data.sites.map(site => (
                    <div key={site.campaign_site_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-theme-text">
                          {site.site_name}
                          <span className="ml-1.5 font-mono text-xs font-normal text-theme-text-muted/60">{site.site_code}</span>
                        </p>
                        <p className="text-[11px] text-theme-text-muted">
                          {siteTypeLabel(site.site_type)} · {site.location_count} ubicación(es)
                        </p>
                      </div>
                      {site.session_id ? (
                        <Link
                          href={`/dashboard/inventarios/jornadas/${site.session_id}`}
                          className="text-xs font-medium text-theme-accent transition-colors hover:underline"
                        >
                          Sección #{site.session_number}
                        </Link>
                      ) : (
                        <span className="text-[11px] text-theme-text-muted/60">Sin sección de conteo</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <InventoryEmptyState
              title="Inventario no encontrado"
              description="El inventario seleccionado no existe o no pertenece a la empresa activa."
              icon={<Boxes className="h-5 w-5" />}
            />
          )}
        </>
      )}
    </div>
  )
}
