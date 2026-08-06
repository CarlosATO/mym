'use client'

import { useMemo, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, Plus } from 'lucide-react'
import type { InventorySite } from '@/app/actions/inventarios/sites'
import { createGeneralInventoryCampaign } from '@/app/actions/inventarios/campaigns'

interface InventoryCampaignCreateFormProps {
  eligibleSites: InventorySite[]
}

function formatLocalDateTime(value: string): string {
  if (!value) return ''
  const dt = new Date(value)
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString()
}

export function InventoryCampaignCreateForm({ eligibleSites }: InventoryCampaignCreateFormProps) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [name, setName] = useState('')
  const [plannedAt, setPlannedAt] = useState('')
  const [error, setError] = useState<string | null>(null)

  const eligibleCount = eligibleSites.length
  const eligiblePreview = useMemo(() => eligibleSites.slice(0, 8), [eligibleSites])
  const canSubmit = name.trim().length > 0 && plannedAt.trim().length > 0 && eligibleCount > 0 && !isSubmitting

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return

    setError(null)
    setIsSubmitting(true)
    void (async () => {
      try {
        const result = await createGeneralInventoryCampaign({
          name: name.trim(),
          plannedAt: formatLocalDateTime(plannedAt),
        })

        if (result.error || !result.data) {
          setError(result.error ?? 'No se pudo crear el inventario.')
          setIsSubmitting(false)
          return
        }

        router.push(`/dashboard/inventarios/campanas/${result.data.campaign_id}`)
      } catch {
        setError('No se pudo crear el inventario.')
        setIsSubmitting(false)
      }
    })()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-xl border border-theme-border bg-theme-surface p-5 shadow-sm">
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">Tipo</p>
        <h2 className="text-lg font-bold text-theme-text">Inventario general</h2>
        <p className="text-sm text-theme-text-muted">Todas las bodegas internas habilitadas. Todos los productos.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-sm font-medium text-theme-text">Nombre del inventario</span>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            maxLength={200}
            className="w-full rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none transition-colors placeholder:text-theme-text-muted/50 focus:border-theme-accent"
            placeholder="Ej. Inventario general agosto"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-sm font-medium text-theme-text">Fecha programada</span>
          <input
            type="datetime-local"
            value={plannedAt}
            onChange={e => setPlannedAt(e.target.value)}
            required
            className="w-full rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none transition-colors focus:border-theme-accent"
          />
        </label>
      </div>

      <div className="rounded-xl border border-theme-border/70 bg-theme-bg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-theme-text">Bodegas a incluir</p>
            <p className="text-sm text-theme-text-muted">{eligibleCount} bodega(s) interna(s) habilitada(s).</p>
          </div>
          <span className="inline-flex items-center rounded-full border border-theme-border bg-theme-surface px-2.5 py-1 text-xs font-medium text-theme-text-muted">
            Se creará en Borrador
          </span>
        </div>

        {eligibleCount > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {eligiblePreview.map(site => (
              <span key={site.id} className="inline-flex items-center rounded-full border border-theme-border bg-theme-surface px-2.5 py-1 text-xs font-medium text-theme-text-muted">
                {site.code} · {site.name}
              </span>
            ))}
            {eligibleCount > eligiblePreview.length && (
              <span className="inline-flex items-center rounded-full border border-theme-border bg-theme-surface px-2.5 py-1 text-xs font-medium text-theme-text-muted">
                +{eligibleCount - eligiblePreview.length} más
              </span>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">No hay bodegas internas habilitadas para crear el inventario.</p>
        )}
      </div>

      <div className="rounded-xl border border-theme-border/70 bg-theme-surface p-4 text-sm text-theme-text-muted">
        <p>El inventario se creará en estado Borrador.</p>
        <p>No se iniciará ningún conteo en este paso.</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-theme-border/60 pt-4">
        <button
          type="button"
          onClick={() => router.push('/dashboard/inventarios/campanas')}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
        >
          <ArrowLeft className="h-4 w-4" />
          Volver
        </button>

        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {isSubmitting ? 'Creando inventario…' : 'Crear inventario'}
        </button>
      </div>
    </form>
  )
}
