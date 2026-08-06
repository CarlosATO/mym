'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2, MapPin, Plus } from 'lucide-react'
import { createInventorySessionFromCampaignSite, type InventoryCampaignSiteDetail } from '@/app/actions/inventarios/campaigns'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'

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
    <div className="flex flex-col rounded-lg border border-theme-border bg-theme-surface p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-theme-text">{site.site_name}</p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-theme-text-muted">
            <MapPin className="h-3 w-3 shrink-0" />
            {site.site_code} · {site.location_count} ubicación(es) · {site.location_scope === 'SELECTED' ? 'Seleccionadas' : 'Todas'}
          </p>
        </div>
        {hasSession ? (
          <InventoryStatusBadge status={site.session_status} />
        ) : (
          <span className="inline-flex shrink-0 items-center rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-theme-text-muted">
            Sin sección de conteo
          </span>
        )}
      </div>

      {hasSession && site.session_number && (
        <p className="mt-1.5 truncate text-[11px] text-theme-text-muted">Sección #{site.session_number}</p>
      )}

      {error && (
        <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-[11px] text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-theme-border/60 pt-2.5">
        {hasSession ? (
          <Link
            href={`/dashboard/inventarios/jornadas/${site.session_id}`}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
          >
            Abrir
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        ) : canCreate ? (
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {creating ? 'Creando…' : 'Crear sección de conteo'}
          </button>
        ) : (
          <span
            title="Solo los usuarios con permiso de creación de secciones de conteo pueden crear una."
            className="inline-flex h-7 items-center rounded-lg border border-theme-border bg-theme-text/5 px-3 text-xs font-medium text-theme-text-muted"
          >
            Crear sección de conteo
          </span>
        )}
        {site.is_required && <span className="text-[11px] text-theme-text-muted">Requerida</span>}
      </div>
    </div>
  )
}
