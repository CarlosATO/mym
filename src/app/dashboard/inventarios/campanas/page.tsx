import Link from 'next/link'
import { ArrowRight, Layers } from 'lucide-react'
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

function isOperationalInventory(status: string): boolean {
  return status === 'DRAFT' || status === 'IN_PROGRESS' || status === 'UNDER_REVIEW'
}

export default async function InventariosCampanasPage() {
  const { data, error, companyId } = await getActiveCompanyCampaigns()
  const campaigns = data ?? []

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Inventarios"
        description="Agrupa secciones de conteo por bodega. Un inventario puede ser general, selectivo o externo."
        breadcrumb={['Inventarios']}
        action={
          <Link
            href="/dashboard/inventarios/campanas/nueva"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover"
          >
            <Layers className="h-4 w-4" />
            Nuevo inventario
          </Link>
        }
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
          title="Sin inventarios"
          description="Los inventarios aparecerán aquí."
          icon={<Layers className="h-5 w-5" />}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
           {campaigns.map(campaign => (
             <Link
               key={campaign.id}
               href={`/dashboard/inventarios/campanas/${campaign.id}`}
               className={`group rounded-xl border p-3 shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-theme-accent ${
                 isOperationalInventory(campaign.status)
                   ? 'border-sky-500/45 bg-sky-500/5 shadow-sky-500/10 hover:border-sky-500/70 hover:bg-sky-500/10'
                   : 'border-theme-border bg-theme-surface hover:border-theme-accent/50'
               }`}
             >
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
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-theme-border/60 pt-2 text-xs text-theme-text-muted">
                <span>{campaign.site_count} bodega(s)</span>
                <span>{campaign.product_count} producto(s)</span>
                <span>{campaign.session_count} sección(es) de conteo</span>
                <span>{formatDateChile(campaign.created_at)}</span>
              </div>
              <div className="mt-2 flex items-center gap-1 text-sm font-semibold text-theme-accent">
                Ver inventario
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
