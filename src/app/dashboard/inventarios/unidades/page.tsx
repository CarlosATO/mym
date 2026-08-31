import Link from 'next/link'
import { ArrowLeft, ArrowRight, Boxes, MapPin } from 'lucide-react'
import { getActiveCompanyCampaigns, getActiveCompanyCampaignDetail } from '@/app/actions/inventarios/campaigns'
import { getActiveCompanySites } from '@/app/actions/inventarios/sites'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventorySitesPanel } from '@/modules/inventarios/components/inventory-sites-panel'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { formatDateChile } from '@/modules/inventarios/lib/format'

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

  const campaignsResult = await getActiveCompanyCampaigns()
  const sitesResult = inventoryId === 'all' ? await getActiveCompanySites() : null
  const companyId = campaignsResult.companyId ?? sitesResult?.companyId ?? null
  const masterSites = sitesResult?.data ?? []

  let campaignDetail: Awaited<ReturnType<typeof getActiveCompanyCampaignDetail>> | null = null
  if (inventoryId && inventoryId !== 'all') {
    campaignDetail = await getActiveCompanyCampaignDetail(inventoryId)
  }

  const selectorOptions = (campaignsResult.data ?? []).map(c => ({ id: c.id, name: c.name }))

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Bodegas"
        description="Consulta las bodegas participantes de cada Inventario y administra las bodegas maestras por separado."
        breadcrumb={['Inventarios', 'Bodegas']}
      />

      {!companyId ? (
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<Boxes className="h-5 w-5" />}
        />
      ) : campaignsResult.error ? (
        <InventoryErrorState description={campaignsResult.error} />
      ) : (
        <>
          {!inventoryId ? (
            <div className="space-y-3">
              {selectorOptions.length === 0 ? (
                <InventoryEmptyState
                  title="Sin Inventarios"
                  description="Los Inventarios creados para esta empresa aparecerán aquí."
                  icon={<Boxes className="h-5 w-5" />}
                />
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {(campaignsResult.data ?? []).map(campaign => {
                    const isClosed = campaign.status === 'APPROVED'
                    return (
                      <Link
                        key={campaign.id}
                        href={`/dashboard/inventarios/unidades?inventoryId=${campaign.id}`}
                        className="group relative flex min-h-[148px] flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm transition-colors hover:border-theme-accent/50 hover:bg-theme-text/[0.02] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme-accent"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-theme-text">{campaign.name}</p>
                            <p className="mt-1 text-xs text-theme-text-muted">
                              {formatDateChile(campaign.planned_at ?? campaign.created_at)}
                            </p>
                          </div>
                          {isClosed ? (
                            <span className="inline-flex shrink-0 items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-bold text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300">
                              CERRADO
                            </span>
                          ) : (
                            <InventoryStatusBadge status={campaign.status} />
                          )}
                        </div>
                        <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                          <span className="text-xs text-theme-text-muted">
                            <strong className="text-sm text-theme-text">{campaign.site_count}</strong> bodega(s) participantes
                          </span>
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-theme-accent transition-transform group-hover:translate-x-0.5">
                            Ver bodegas <ArrowRight className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}

              <Link
                href="/dashboard/inventarios/unidades?inventoryId=all"
                className="group flex items-center justify-between gap-3 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-4 py-3 transition-colors hover:border-theme-accent/50 hover:bg-theme-text/[0.02] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme-accent"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Boxes className="h-4 w-4 shrink-0 text-theme-text-muted/70" />
                  <span>
                    <span className="block text-sm font-semibold text-theme-text">Bodegas maestras</span>
                    <span className="block text-xs text-theme-text-muted">Configuración general de unidades inventariables</span>
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-theme-text-muted transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          ) : inventoryId === 'all' ? (
            sitesResult?.error ? (
              <InventoryErrorState description={sitesResult.error} />
            ) : masterSites.length === 0 ? (
              <InventoryEmptyState
                title="Sin bodegas inventariables"
                description="Las bodegas y locales que participan en inventarios aparecerán aquí."
                icon={<Boxes className="h-5 w-5" />}
              />
            ) : (
              <div className="space-y-3">
                <Link href="/dashboard/inventarios/unidades" className="inline-flex items-center gap-1.5 text-xs font-medium text-theme-text-muted hover:text-theme-text">
                  <ArrowLeft className="h-3.5 w-3.5" /> Volver a Inventarios
                </Link>
                <InventorySitesPanel sites={masterSites} />
              </div>
            )
          ) : campaignDetail?.data ? (
            <div className="space-y-3">
              <Link href="/dashboard/inventarios/unidades" className="inline-flex items-center gap-1.5 text-xs font-medium text-theme-text-muted hover:text-theme-text">
                <ArrowLeft className="h-3.5 w-3.5" /> Volver a Inventarios
              </Link>
              <div className="rounded-xl border border-theme-border bg-theme-surface shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-theme-border/60 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-bold text-theme-text">{campaignDetail.data.campaign.name}</p>
                      {campaignDetail.data.campaign.status === 'APPROVED' && (
                        <span className="inline-flex shrink-0 items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-bold text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300">
                          CERRADO
                        </span>
                      )}
                      <InventoryStatusBadge status={campaignDetail.data.campaign.status} />
                    </div>
                    <p className="mt-1 text-xs text-theme-text-muted">
                      {formatDateChile(campaignDetail.data.campaign.planned_at ?? campaignDetail.data.campaign.created_at)}
                      {' · '}
                      {campaignDetail.data.site_count} bodega(s) participante(s)
                    </p>
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
