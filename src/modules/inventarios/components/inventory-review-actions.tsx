'use client'

import { useState } from 'react'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import type { InventorySessionTask } from '@/app/actions/inventarios/sessions'
import { invalidateInventoryTask, reopenInventoryTask, validateInventoryTask } from '@/app/actions/inventarios/review'

interface InventoryReviewActionsProps {
  companyId: string
  task: InventorySessionTask
  contributionSummary?: string
  onChanged: () => void
  canValidateTasks: boolean
}

type Mode = 'validate' | 'invalidate' | 'reopen' | null

export function InventoryReviewActions({ companyId, task, contributionSummary, onChanged, canValidateTasks }: InventoryReviewActionsProps) {
  const [mode, setMode] = useState<Mode>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const taskStatus = task.status
  const hasValidation = Boolean(task.validated_at && task.validated_by)

  const canValidate = canValidateTasks && taskStatus === 'COMPLETED' && !hasValidation
  const canInvalidate = canValidateTasks && taskStatus === 'COMPLETED' && hasValidation
  const canReopen = canValidateTasks && taskStatus === 'COMPLETED'

  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    let result: { error: string | null } = { error: null }
    if (mode === 'validate') {
      result = await validateInventoryTask(companyId, task.id, task.version, task.validation_cycle)
    } else if (mode === 'invalidate') {
      result = await invalidateInventoryTask(companyId, task.id, task.version, task.validation_cycle, reason)
    } else if (mode === 'reopen') {
      result = await reopenInventoryTask(companyId, task.id, task.version, task.validation_cycle, reason)
    }
    setBusy(false)
    setMode(null)
    setReason('')
    if (result.error) {
      setError(result.error)
      return
    }
    onChanged()
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex flex-wrap items-center gap-1.5">
        {canValidate && (
          <button
            type="button"
            onClick={() => setMode('validate')}
            disabled={busy}
            title={contributionSummary ?? 'Validar tarea'}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-600 px-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Validar
          </button>
        )}
        {canInvalidate && (
          <button
            type="button"
            onClick={() => setMode('invalidate')}
            disabled={busy}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/10 px-2 text-xs font-medium text-red-700 dark:text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-40"
          >
            <XCircle className="h-3.5 w-3.5" />
            Invalidar
          </button>
        )}
        {canReopen && (
          <button
            type="button"
            onClick={() => setMode('reopen')}
            disabled={busy}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reabrir
          </button>
        )}
      </div>

      {mode && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">
              {mode === 'validate' ? 'Validar tarea' : mode === 'invalidate' ? 'Invalidar tarea' : 'Reabrir tarea'}
            </h3>
            {mode === 'validate' && contributionSummary && (
              <p className="mt-2 text-sm text-theme-text-muted">
                Resumen: {contributionSummary}
              </p>
            )}
            {mode === 'reopen' && (
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                La tarea deberá ejecutarse nuevamente. No se inicia desde la web.
              </p>
            )}
            {(mode === 'invalidate' || mode === 'reopen') && (
              <label className="mt-3 block">
                <span className="text-xs font-medium text-theme-text-muted">Motivo (mínimo 5 caracteres)</span>
                <textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
                />
              </label>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMode(null)}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={run}
                disabled={busy || ((mode === 'invalidate' || mode === 'reopen') && reason.trim().length < 5)}
                className="inline-flex h-8 items-center rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                {busy ? 'Procesando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
