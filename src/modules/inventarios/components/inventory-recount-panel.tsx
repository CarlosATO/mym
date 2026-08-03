'use client'

import { useState } from 'react'
import { CheckCircle2, ListRestart, RotateCcw, UserPlus, XCircle } from 'lucide-react'
import type { InventoryParticipant, InventoryRecount, InventorySessionReview } from '@/app/actions/inventarios/sessions'
import {
  assignInventoryRecount,
  cancelInventoryRecount,
  decideInventoryRecount,
} from '@/app/actions/inventarios/review'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'

interface InventoryRecountPanelProps {
  companyId: string
  recounts: InventoryRecount[]
  contributions: InventorySessionReview['contributions']
  counters: InventoryParticipant[]
  onChanged: () => void
}

type Action = 'assign' | 'cancel' | 'decide' | null

interface ContributionRow {
  task_id?: string | null
  snapshot_product_id?: string | null
  contribution_source?: string | null
  contribution_count_entry_id?: string | null
  recount_request_id?: string | null
}

function asContributions(rows: InventorySessionReview['contributions']): ContributionRow[] {
  return rows as unknown as ContributionRow[]
}

export function InventoryRecountPanel({ companyId, recounts, contributions, counters, onChanged }: InventoryRecountPanelProps) {
  const [action, setAction] = useState<Action>(null)
  const [target, setTarget] = useState<InventoryRecount | null>(null)
  const [counterUserId, setCounterUserId] = useState('')
  const [reason, setReason] = useState('')
  const [decision, setDecision] = useState<'accept' | 'reject' | null>(null)
  const [justification, setJustification] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const contribs = asContributions(contributions)

  const openAction = (mode: Action, recount: InventoryRecount) => {
    setAction(mode)
    setTarget(recount)
    setError(null)
    setCounterUserId('')
    setReason('')
    setDecision(null)
    setJustification('')
  }

  const recountContributions = (recount: InventoryRecount) =>
    contribs.filter(c => c.recount_request_id === recount.id)

  const selectedForDecision = (recount: InventoryRecount): string | null => {
    // Aceptar: usar el conteo del recuento; Rechazar: usar el conteo normal de la misma tarea/producto.
    const rows = recountContributions(recount)
    if (decision === 'accept') {
      return rows.find(r => r.contribution_source === 'RECOUNT')?.contribution_count_entry_id ?? rows[0]?.contribution_count_entry_id ?? null
    }
    if (decision === 'reject') {
      const normal = contribs.find(c =>
        c.recount_request_id === null
        && c.task_id === recount.source_task_id
        && c.snapshot_product_id === recount.snapshot_product_id
        && c.contribution_source === 'NORMAL'
      )
      return normal?.contribution_count_entry_id ?? null
    }
    return null
  }

  const handleAssign = async () => {
    if (busy || !target || !counterUserId) return
    setBusy(true)
    setError(null)
    const result = await assignInventoryRecount(companyId, target.id, target.status, counterUserId)
    setBusy(false)
    if (result.error) { setError(result.error); return }
    setAction(null)
    onChanged()
  }

  const handleCancel = async () => {
    if (busy || !target) return
    setBusy(true)
    setError(null)
    const result = await cancelInventoryRecount(companyId, target.id, target.status, reason)
    setBusy(false)
    if (result.error) { setError(result.error); return }
    setAction(null)
    onChanged()
  }

  const handleDecide = async () => {
    if (busy || !target) return
    const selected = selectedForDecision(target)
    if (!selected) { setError('No hay un conteo disponible para esta decisión.'); return }
    setBusy(true)
    setError(null)
    const result = await decideInventoryRecount(companyId, target.id, selected, justification, null, null)
    setBusy(false)
    if (result.error) { setError(result.error); return }
    setAction(null)
    onChanged()
  }

  const confirmLabel = action === 'assign' ? 'Asignar' : action === 'cancel' ? 'Cancelar' : action === 'decide' ? (decision === 'accept' ? 'Aceptar resultado' : 'Rechazar resultado') : ''

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-theme-text">
        <ListRestart className="h-4 w-4 text-sky-500" /> Recuentos ({recounts.length})
      </h3>
      {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {recounts.length === 0 ? (
        <p className="text-sm text-theme-text-muted">Sin recuentos solicitados.</p>
      ) : (
        <ul className="space-y-2">
          {recounts.map(recount => {
            const hasDecision = recount.decision_count && recount.decision_count > 0
            const contributionCount = recountContributions(recount).length
            return (
              <li key={recount.id} className="rounded-lg border border-theme-border/50 bg-theme-text/2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-theme-text">
                      Recuento #{recount.ordinal} · ciclo {recount.cycle_number}
                    </p>
                    <p className="mt-0.5 text-xs text-theme-text-muted">
                      {recount.assigned_user_name
                        ? `Tomador: ${recount.assigned_user_name}`
                        : 'Sin tomador asignado'}
                    </p>
                    {recount.reason && <p className="mt-0.5 text-xs text-theme-text-muted/70">Motivo: {recount.reason}</p>}
                    {recount.completed_at && (
                      <p className="mt-0.5 text-[11px] text-theme-text-muted/60">
                        Completado {formatDateTimeChile(recount.completed_at)}
                      </p>
                    )}
                    {recount.cancelled_at && (
                      <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
                        Cancelado {formatDateTimeChile(recount.cancelled_at)}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs font-medium text-theme-text-muted">{recount.status}</span>
                    {hasDecision && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-3 w-3" /> Decidido
                      </span>
                    )}
                  </div>
                </div>

                {!recount.cancelled_at && !hasDecision && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {recount.status === 'REQUESTED' && (
                      <button
                        type="button"
                        onClick={() => openAction('assign', recount)}
                        className="inline-flex h-7 items-center gap-1 rounded-lg bg-sky-600 px-2 text-xs font-semibold text-white hover:bg-sky-700"
                      >
                        <UserPlus className="h-3 w-3" /> Asignar
                      </button>
                    )}
                    {(recount.status === 'REQUESTED' || recount.status === 'ASSIGNED' || recount.status === 'IN_PROGRESS') && (
                      <button
                        type="button"
                        onClick={() => openAction('cancel', recount)}
                        className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted hover:bg-theme-text/5"
                      >
                        <XCircle className="h-3 w-3" /> Cancelar
                      </button>
                    )}
                    {recount.status === 'COMPLETED' && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => { openAction('decide', recount); setDecision('accept') }}
                          className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-600 px-2 text-xs font-semibold text-white hover:bg-emerald-700"
                        >
                          <CheckCircle2 className="h-3 w-3" /> Aceptar
                        </button>
                        <button
                          type="button"
                          onClick={() => { openAction('decide', recount); setDecision('reject') }}
                          className="inline-flex h-7 items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/10 px-2 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-500/20"
                        >
                          <XCircle className="h-3 w-3" /> Rechazar
                        </button>
                        <span className="text-[11px] text-theme-text-muted/70">
                          {contributionCount} contribucion(es)
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {action && target && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">
              {action === 'assign' ? 'Asignar recuento' : action === 'cancel' ? 'Cancelar recuento' : 'Decidir recuento'}
            </h3>
            {action === 'assign' && (
              <select
                value={counterUserId}
                onChange={e => setCounterUserId(e.target.value)}
                aria-label="Tomador"
                className="mt-3 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
              >
                <option value="">Selecciona un tomador</option>
                {counters.map(c => (
                  <option key={c.user_id} value={c.user_id}>{c.user_name ?? '—'}</option>
                ))}
              </select>
            )}
            {action === 'cancel' && (
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={3}
                placeholder="Motivo de la cancelación"
                className="mt-3 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
              />
            )}
            {action === 'decide' && (
              <>
                <p className="mt-2 text-sm text-theme-text-muted">
                  {decision === 'accept'
                    ? 'Se aceptará el resultado del recuento como válido.'
                    : 'Se rechazará el resultado y se conservará el conteo original.'}
                </p>
                <textarea
                  value={justification}
                  onChange={e => setJustification(e.target.value)}
                  rows={3}
                  placeholder="Justificación de la decisión"
                  className="mt-3 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
                />
              </>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAction(null)}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={action === 'assign' ? handleAssign : action === 'cancel' ? handleCancel : handleDecide}
                disabled={
                  busy
                  || (action === 'assign' && !counterUserId)
                  || (action === 'cancel' && reason.trim().length < 5)
                  || (action === 'decide' && justification.trim().length < 5)
                }
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                <RotateCcw className="h-3 w-3" />
                {busy ? 'Procesando…' : confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
