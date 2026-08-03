'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MapPin, Warehouse } from 'lucide-react'
import type { InventorySite } from '@/app/actions/inventarios/sites'
import { updateInventorySiteInventoryConfig } from '@/app/actions/inventarios/sites'

interface InventorySitesPanelProps {
  sites: InventorySite[]
}

function SiteTypeBadge({ type }: { type: InventorySite['site_type'] }) {
  if (type === 'INTERNAL_WAREHOUSE') {
    return <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-300">Bodega interna</span>
  }
  if (type === 'OWN_STORE') {
    return <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">Tienda propia</span>
  }
  return <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Sitio externo</span>
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        disabled
          ? 'relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full bg-theme-text/10'
          : checked
            ? 'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-theme-accent'
            : 'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-theme-text/15'
      }
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

function SiteCard({ site }: { site: InventorySite }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isInternal = site.site_type === 'INTERNAL_WAREHOUSE'

  const setConfig = async (inventoryEnabled: boolean, includeInGeneral: boolean) => {
    setSaving(true)
    setError(null)
    const result = await updateInventorySiteInventoryConfig(site.id, inventoryEnabled, includeInGeneral)
    setSaving(false)
    if (result.error) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-theme-text">
            {site.name}
            <span className="ml-2 font-mono text-xs font-normal text-theme-text-muted">{site.code}</span>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <SiteTypeBadge type={site.site_type} />
            {isInternal && site.warehouse_name && (
              <span className="inline-flex items-center gap-1 rounded-full border border-theme-border bg-theme-text/2 px-2 py-0.5 text-xs text-theme-text-muted">
                <Warehouse className="h-3 w-3" />
                {site.warehouse_name}
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full border border-theme-border bg-theme-text/2 px-2 py-0.5 text-xs text-theme-text-muted">
              <MapPin className="h-3 w-3" />
              {site.location_count} ubicación(es)
            </span>
          </div>
        </div>
        <span className={`text-xs font-medium ${site.is_active ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
          {site.is_active ? 'Activo' : 'Inactivo'}
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-3 space-y-2 border-t border-theme-border/60 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-theme-text">Disponible para inventarios</p>
            <p className="text-xs text-theme-text-muted/70">Puede participar en nuevas campañas.</p>
          </div>
          <Toggle
            checked={site.inventory_enabled}
            disabled={saving}
            label="Disponible para inventarios"
            onChange={v => setConfig(v, site.include_in_general)}
          />
        </div>

        {isInternal ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-theme-text">Incluir en inventario general</p>
              <p className="text-xs text-theme-text-muted/70">
                Afecta únicamente campañas creadas después de guardar este cambio.
              </p>
            </div>
            <Toggle
              checked={site.include_in_general}
              disabled={saving || !site.inventory_enabled}
              label="Incluir en inventario general"
              onChange={v => setConfig(site.inventory_enabled, v)}
            />
          </div>
        ) : (
          <p className="rounded-lg border border-theme-border/50 bg-theme-text/2 px-2 py-1.5 text-xs text-theme-text-muted">
            Solo campañas selectivas o externas.
          </p>
        )}
      </div>

      {isInternal && (
        <p className="mt-3 flex items-center gap-1 text-[11px] text-theme-text-muted/70">
          <Warehouse className="h-3 w-3" /> Sincronizado desde Logística
        </p>
      )}
    </div>
  )
}

export function InventorySitesPanel({ sites }: InventorySitesPanelProps) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {sites.map(site => (
        <SiteCard key={site.id} site={site} />
      ))}
    </div>
  )
}
