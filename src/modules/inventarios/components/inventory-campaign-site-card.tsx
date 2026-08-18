'use client'

import { useState } from 'react'
import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2, MapPin, Plus } from 'lucide-react'
import { createInventorySessionFromCampaignSite, type InventoryCampaignSiteDetail } from '@/app/actions/inventarios/campaigns'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { notifyInventoryNavigation } from '@/modules/inventarios/components/inventory-navigation-feedback'

interface InventoryCampaignSiteCardProps {
  site: InventoryCampaignSiteDetail
  canCreate: boolean
}

function sessionActionLabel(status: string | null | undefined): string {
  switch (status) {
    case 'COUNTING':
      return 'En ejecución'
    case 'UNDER_REVIEW':
      return 'Contada'
    case 'APPROVED':
    case 'EXPORTED':
    case 'RECONCILED':
      return 'Finalizada'
    case 'CANCELLED':
      return 'Cancelada'
    case 'PREPARED':
    default:
      return 'Abrir'
  }
}

export function InventoryCampaignSiteCard({ site, canCreate }: InventoryCampaignSiteCardProps) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [opening, startOpening] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const hasSession = Boolean(site.session_id)
  const isCounting = site.session_status === 'COUNTING'
  const hasAssignedZones = site.session_status === 'DRAFT' && (site.active_zone_count ?? 0) > 0
  const isPrepared = site.session_status === 'PREPARED'
  const isAmber = hasAssignedZones || isPrepared
  const isNotStarted = !hasSession
  const actionLabel = sessionActionLabel(site.session_status)

  const handleOpen = () => {
    if (opening || !site.session_id) return
    startOpening(() => {
      notifyInventoryNavigation()
      router.push(`/dashboard/inventarios/jornadas/${site.session_id}`)
    })
  }

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
      notifyInventoryNavigation()
      router.push(`/dashboard/inventarios/jornadas/${result.data.session_id}`)
    }
  }

  return (
    <div className={`flex h-full flex-col rounded-lg border p-3 shadow-sm ${isCounting ? 'border-emerald-500/35 bg-emerald-500/5' : isAmber ? 'border-amber-500/35 bg-amber-500/5' : isNotStarted ? 'border-sky-500/35 bg-sky-500/5' : 'border-theme-border bg-theme-surface'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p title={site.site_name} className="text-sm font-semibold leading-snug text-theme-text break-words">
            {site.site_name}
          </p>
          <p title={`${site.site_code} · ${site.location_count} ubicación(es) · ${site.location_scope === 'SELECTED' ? 'Seleccionadas' : 'Todas'}`} className="mt-0.5 flex items-center gap-1 text-[11px] text-theme-text-muted break-words">
            <MapPin className="h-3 w-3 shrink-0" />
            {site.site_code} · {site.location_count} ubicación(es) · {site.location_scope === 'SELECTED' ? 'Seleccionadas' : 'Todas'}
          </p>
        </div>
        {hasSession ? (
          <InventoryStatusBadge
            status={hasAssignedZones ? 'ZONES_ASSIGNED' : site.session_status}
            className={isCounting ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300' : isAmber ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300' : undefined}
          />
        ) : (
          <span className="inline-flex shrink-0 items-center rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-theme-text-muted">
            Sin sección de conteo
          </span>
        )}
      </div>

      {hasSession && site.session_number && (
        <p className="mt-1.5 text-[11px] text-theme-text-muted">Sección #{site.session_number}</p>
      )}

      {error && (
        <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-[11px] text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-theme-border/60 pt-2.5">
        {hasSession ? (
          <button
            type="button"
            onClick={handleOpen}
            disabled={opening}
            className={`inline-flex h-7 items-center gap-1 rounded-lg px-3 text-xs font-semibold text-white transition-colors disabled:cursor-wait disabled:opacity-70 ${isCounting ? 'bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400' : 'bg-theme-accent hover:bg-theme-accent-hover'}`}
          >
            {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
            {opening ? 'Abriendo…' : actionLabel}
          </button>
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
