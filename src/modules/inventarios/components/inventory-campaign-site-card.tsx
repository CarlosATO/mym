'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Boxes, Loader2, MapPin, Plus } from 'lucide-react'
import { createInventorySessionFromCampaignSite, type InventoryCampaignSiteDetail } from '@/app/actions/inventarios/campaigns'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'

const SITE_TYPE_LABELS: Record<string, string> = {
  INTERNAL_WAREHOUSE: 'Bodega interna',
  OWN_STORE: 'Tienda propia',
  EXTERNAL_SITE: 'Sitio externo',
}

interface InventoryCampaignSiteCardProps {
  site: InventoryCampaignSiteDetail
  canCreate: boolean
}

export function InventoryCampaignSiteCard({ site, canCreate }: InventoryCampaignSiteCardProps) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasSession = Boolean(site.session_id)

  const handleCreate = async () => {
    if (creating || hasSession) return
    setCreating(true)
    setError(null)
    const result = await createInventorySessionFromCampaignSite(site.campaign_site_id)
    if (result.error) {
      setCreating(false)
      setError(result.error)
      return
    }
    if (result.data?.session_id) {
      router.push(`/dashboard/inventarios/jornadas/${result.data.session_id}`)
    }
  }

  return (
    <div className="flex flex-col rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-theme-text">{site.site_name}</p>
          <p className="mt-0.5 text-xs text-theme-text-muted">
            {SITE_TYPE_LABELS[site.site_type] ?? site.site_type} · {site.is_required ? 'Requerida' : 'Opcional'}
          </p>
        </div>
        {hasSession ? (
          <InventoryStatusBadge status={site.session_status} />
        ) : (
          <span className="inline-flex items-center rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-theme-text-muted">
            Sin sesión
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-theme-border/60 pt-3 text-xs text-theme-text-muted">
        <span className="inline-flex items-center gap-1">
          <MapPin className="h-3.5 w-3.5" />
          {site.location_count} ubicación(es)
        </span>
        <span>Alcance: {site.location_scope === 'SELECTED' ? 'Seleccionadas' : 'Todas'}</span>
        <span className="inline-flex items-center gap-1">
          <Boxes className="h-3.5 w-3.5" />
          {site.site_code}
        </span>
      </div>

      {hasSession && site.session_number && (
        <div className="mt-2 text-xs text-theme-text-muted">
          Jornada #{site.session_number}
          {site.import_filename && (
            <span className="block truncate">
              Importación: {site.import_filename} ({site.import_status ?? '—'})
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 p-2.5 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-theme-border/60 pt-3">
        {hasSession ? (
          <Link
            href={`/dashboard/inventarios/jornadas/${site.session_id}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover"
          >
            Abrir sesión
            <ArrowRight className="h-4 w-4" />
          </Link>
        ) : canCreate ? (
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {creating ? 'Creando…' : 'Crear sesión'}
          </button>
        ) : (
          <span
            title="Solo los usuarios con permiso de creación de jornadas pueden crear una sesión."
            className="inline-flex h-9 items-center rounded-lg border border-theme-border bg-theme-text/5 px-4 text-sm font-medium text-theme-text-muted"
          >
            Crear sesión
          </span>
        )}
        <span className="text-xs text-theme-text-muted">{site.is_required ? 'Requerida' : 'Opcional'}</span>
      </div>
    </div>
  )
}
