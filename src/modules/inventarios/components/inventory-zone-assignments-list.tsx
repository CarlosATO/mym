'use client'

import { useRef, useState } from 'react'
import { ChevronDown, Loader2, MapPin, Trash2, X } from 'lucide-react'
import type { InventorySessionTask, InventorySessionZone } from '@/app/actions/inventarios/sessions'

interface InventoryZoneAssignmentsListProps {
  zones: InventorySessionZone[]
  tasks: InventorySessionTask[]
  canCancel: boolean
  onCancelZone: (zoneId: string, reason: string) => Promise<{ error: string | null }>
}

function newOperationKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function taskStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'ASSIGNED':
      return 'Asignada'
    case 'IN_PROGRESS':
      return 'En conteo'
    case 'COMPLETED':
      return 'Completada'
    case 'VALIDATED':
      return 'Validada'
    case 'CANCELLED':
      return 'Cancelada'
    default:
      return status ?? '—'
  }
}

export function InventoryZoneAssignmentsList({
  zones,
  tasks,
  canCancel,
  onCancelZone,
}: InventoryZoneAssignmentsListProps) {
  const [cancellingZone, setCancellingZone] = useState<InventorySessionZone | null>(null)
  const [expandedZoneId, setExpandedZoneId] = useState<string | null>(null)

  if (zones.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-theme-border bg-theme-surface/60 px-4 py-4 text-center text-xs text-theme-text-muted">
        Aún no hay zonas configuradas en esta sección de conteo.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 bg-theme-text/[0.02] px-3 py-1.5">
        <p className="text-xs font-semibold text-theme-text">
          Zonas configuradas <span className="font-normal text-theme-text-muted">· {zones.length}</span>
        </p>
      </div>
      <ul className="divide-y divide-theme-border/40">
        {zones.map(zone => {
          const task = tasks.find(candidate => candidate.session_zone_id === zone.id)
          const counterName = task?.assignment?.user_name ?? null
          const locationCount = zone.locations?.length ?? 0
          const isExpanded = expandedZoneId === zone.id
          return (
            <li key={zone.id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setExpandedZoneId(isExpanded ? null : zone.id)}
                  className="flex items-center gap-1 rounded p-0.5 text-theme-text-muted transition-colors hover:text-theme-text"
                  title={isExpanded ? 'Ocultar ubicaciones' : 'Ver ubicaciones'}
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  />
                </button>
                <span className="truncate text-sm font-semibold text-theme-text">{zone.display_name}</span>
                <span className="shrink-0 rounded bg-theme-text/5 px-1.5 py-0.5 font-mono text-[10px] font-medium text-theme-text-muted">
                  {zone.zone_code}
                </span>
                <span className="min-w-0 truncate text-xs text-theme-text-muted">
                  {counterName ? `Responsable: ${counterName}` : 'Sin responsable asignado'}
                </span>
                {task && (
                  <span className="shrink-0 rounded-full border border-theme-border/60 bg-theme-text/[0.03] px-2 py-0.5 text-[10px] font-medium text-theme-text-muted">
                    {taskStatusLabel(task.status)}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-theme-text-muted">
                  {locationCount} ubicacion{locationCount === 1 ? '' : 'es'}
                </span>
                {canCancel && task && task.status === 'ASSIGNED' && (
                  <button
                    type="button"
                    onClick={() => setCancellingZone(zone)}
                    className="inline-flex h-7 items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/5 px-2 text-[11px] font-medium text-red-600 hover:bg-red-500/15 dark:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" />
                    Cancelar zona
                  </button>
                )}
              </div>

              {isExpanded && (
                <div className="border-t border-theme-border/40 bg-theme-text/[0.015] px-3 py-1.5">
                  {locationCount > 0 ? (
                    <ul className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                      {zone.locations!.map(location => (
                        <li key={location.location_id} className="flex items-center gap-2 text-xs">
                          <MapPin className="h-3 w-3 shrink-0 text-theme-text-muted/50" />
                          <span className="truncate font-mono text-theme-text">{location.code}</span>
                          <span className="min-w-0 flex-1 truncate text-theme-text-muted">
                            {location.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-theme-text-muted/60">Sin ubicaciones asignadas.</p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {cancellingZone && (
        <CancelZoneDialog
          zone={cancellingZone}
          onClose={() => setCancellingZone(null)}
          onCancelled={async reason => {
            const result = await onCancelZone(cancellingZone.id, reason)
            if (!result.error) setCancellingZone(null)
            return result
          }}
        />
      )}
    </div>
  )
}

interface CancelZoneDialogProps {
  zone: InventorySessionZone
  onClose: () => void
  onCancelled: (reason: string) => Promise<{ error: string | null }>
}

function CancelZoneDialog({ zone, onClose, onCancelled }: CancelZoneDialogProps) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keyRef = useRef<string | null>(null)

  const validLength = reason.trim().length >= 5 && reason.trim().length <= 500

  const handleConfirm = async () => {
    if (busy) return
    const trimmed = reason.trim()
    if (trimmed.length < 5 || trimmed.length > 500) {
      setError('El motivo debe tener entre 5 y 500 caracteres.')
      return
    }
    if (!keyRef.current) keyRef.current = newOperationKey()
    setBusy(true)
    setError(null)
    const result = await onCancelled(trimmed)
    setBusy(false)
    if (result.error) setError(result.error)
  }

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
        <h3 className="text-base font-bold text-theme-text">Cancelar zona {zone.display_name}</h3>
        <p className="mt-1 text-xs text-theme-text-muted">
          Se libera la asignación y sus ubicaciones vuelven a estar pendientes. La historia de la zona se conserva.
        </p>
        <textarea
          value={reason}
          onChange={event => setReason(event.target.value)}
          rows={3}
          placeholder="Motivo de la cancelación (mínimo 5 caracteres)"
          className="mt-3 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-border-accent"
        />
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
          >
            Volver
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || !validLength}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            {busy ? 'Cancelando…' : 'Cancelar zona'}
          </button>
        </div>
      </div>
    </div>
  )
}
