'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Wrench } from 'lucide-react'
import type { InventoryIncident } from '@/app/actions/inventarios/sessions'
import { resolveInventoryIncident } from '@/app/actions/inventarios/review'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'

interface InventoryIncidentPanelProps {
  companyId: string
  incidents: InventoryIncident[]
  onChanged: () => void
}

const RESOLUTION_TYPES = [
  { value: 'COUNT_CORRECTED', label: 'Conteo corregido' },
  { value: 'COUNT_INVALIDATED', label: 'Conteo invalidado' },
  { value: 'RECOUNT_REQUESTED', label: 'Recuento solicitado' },
  { value: 'PRODUCT_IDENTIFIED', label: 'Producto identificado' },
  { value: 'LOCATION_CONFIRMED', label: 'Ubicación confirmada' },
  { value: 'DISMISSED', label: 'Descartada' },
  { value: 'NO_ACTION_REQUIRED', label: 'Sin acción requerida' },
  { value: 'OTHER', label: 'Otra' },
]

export function InventoryIncidentPanel({ companyId, incidents, onChanged }: InventoryIncidentPanelProps) {
  const [resolving, setResolving] = useState<InventoryIncident | null>(null)
  const [resolutionType, setResolutionType] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleResolve = async () => {
    if (busy || !resolving) return
    setBusy(true)
    setError(null)
    const result = await resolveInventoryIncident(
      companyId,
      resolving.id,
      resolving.status,
      'RESOLVED',
      null,
      resolutionType,
      description
    )
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setResolving(null)
    setResolutionType('')
    setDescription('')
    onChanged()
  }

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-theme-text">
        <AlertTriangle className="h-4 w-4 text-amber-500" /> Incidencias ({incidents.length})
      </h3>
      {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {incidents.length === 0 ? (
        <p className="text-sm text-theme-text-muted">Sin incidencias registradas.</p>
      ) : (
        <ul className="space-y-2">
          {incidents.map(incident => (
            <li key={incident.id} className="rounded-lg border border-theme-border/50 bg-theme-text/2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-theme-text">
                    {incident.is_blocking && <AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
                    <span className="font-medium">{incident.category_code}</span>
                    {incident.is_blocking && (
                      <span className="rounded-full border border-red-500/25 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300">
                        Bloqueante
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-theme-text-muted">{incident.description}</p>
                  <p className="mt-1 text-[11px] text-theme-text-muted/70">
                    {incident.reported_by_name ?? '—'} · {formatDateTimeChile(incident.reported_at)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-xs font-medium text-theme-text-muted">{incident.status}</span>
                  {(incident.status === 'OPEN' || incident.status === 'UNDER_REVIEW') && (
                    <button
                      type="button"
                      onClick={() => { setResolving(incident); setResolutionType(''); setDescription('') }}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                    >
                      <Wrench className="h-3 w-3" /> Resolver
                    </button>
                  )}
                  {incident.status === 'RESOLVED' && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" /> Resuelta
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {resolving && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Resolver incidencia</h3>
            <p className="mt-1 text-xs text-theme-text-muted">{resolving.description}</p>
            <div className="mt-3 space-y-2">
              <select
                value={resolutionType}
                onChange={e => setResolutionType(e.target.value)}
                aria-label="Tipo de resolución"
                className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
              >
                <option value="">Tipo de resolución</option>
                {RESOLUTION_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
                placeholder="Detalle de la resolución"
                className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResolving(null)}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleResolve}
                disabled={busy || !resolutionType || description.trim().length < 5}
                className="inline-flex h-8 items-center rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                {busy ? 'Resolviendo…' : 'Confirmar resolución'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
