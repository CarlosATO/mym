'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DoorOpen, Lock, Play, RotateCcw } from 'lucide-react'
import { clearOperationIdempotencyKey, operationIdempotencyKey } from '@/modules/inventarios/lib/operation-keys'
import { closeInventorySession, startInventorySession } from '@/app/actions/inventarios/operations'
import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { notifyInventoryNavigation } from '@/modules/inventarios/components/inventory-navigation-feedback'

interface InventoryOperationActionsProps {
  companyId: string
  sessionId: string
  detail: InventorySessionDetail
  canCloseSession: boolean
}

export function InventoryOperationActions({ companyId, sessionId, detail, canCloseSession }: InventoryOperationActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'start' | 'close' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const status = detail.session.status

  const handleStart = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const key = operationIdempotencyKey(sessionId, 'start')
    const result = await startInventorySession(companyId, sessionId, key)
    setBusy(false)
    setConfirm(null)
    if (result.error) {
      setError(result.error)
      return
    }
    clearOperationIdempotencyKey(sessionId, 'start')
    router.refresh()
  }, [busy, companyId, sessionId, router])

  const handleClose = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const key = operationIdempotencyKey(sessionId, 'close')
    const result = await closeInventorySession(companyId, sessionId, key)
    setBusy(false)
    setConfirm(null)
    if (result.error) {
      setError(result.error)
      return
    }
    clearOperationIdempotencyKey(sessionId, 'close')
    notifyInventoryNavigation()
    router.push(`/dashboard/inventarios/jornadas/${sessionId}?tab=revision`)
  }, [busy, companyId, sessionId, router])

  if (status === 'PREPARED') {
    return (
      <div className="space-y-3">
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button
          type="button"
          onClick={() => setConfirm('start')}
          disabled={busy}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
        >
          <Play className="h-4 w-4" />
          Abrir sección de conteo
        </button>
        <p className="text-xs text-theme-text-muted">
          Al abrir, las zonas configuradas quedan disponibles para operar. Las tareas no se inician automáticamente.
        </p>

        {confirm === 'start' && (
          <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
              <h3 className="flex items-center gap-2 text-base font-bold text-theme-text">
                <DoorOpen className="h-5 w-5 text-theme-accent" /> Abrir sección de conteo
              </h3>
               <p className="mt-2 text-sm text-theme-text-muted">
                 La sección pasará a estado <strong>En conteo</strong>. Abrirla <strong>no inicia automáticamente las tareas</strong>.
                 Las zonas ya configuradas quedarán disponibles para operar. Mientras haya ubicaciones pendientes, podrás
                 agregar nuevas zonas desde <strong>Asignación de zonas</strong>. Al cerrar la sección ya no podrás agregar zonas.
               </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirm(null)}
                  disabled={busy}
                  className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={busy}
                  className="inline-flex h-8 items-center rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy ? 'Abriendo…' : 'Confirmar apertura'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (status === 'COUNTING') {
    const tasks = detail.tasks.filter(t => !t.cancelled_at)
    const hasIncomplete = tasks.some(t => t.status !== 'COMPLETED')
    const blocking = detail.counts.blocking_incident_count > 0
    const canClose = !hasIncomplete && !blocking
    return (
      <div className="space-y-3">
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {canCloseSession && <button
          type="button"
          onClick={() => setConfirm('close')}
          disabled={busy || !canClose}
          title={!canClose ? 'Completa todas las tareas y resuelve bloqueos antes de cerrar' : 'Cerrar el conteo'}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
        >
          <Lock className="h-4 w-4" />
          Cerrar conteo
        </button>}
        {!canClose && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {hasIncomplete ? `Hay ${tasks.filter(t => t.status !== 'COMPLETED').length} tarea(s) sin completar.` : ''}
            {blocking ? ' Existen incidencias bloqueantes.' : ''}
          </p>
        )}

        {confirm === 'close' && (
          <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
              <h3 className="flex items-center gap-2 text-base font-bold text-theme-text">
                <RotateCcw className="h-5 w-5 text-emerald-600" /> Cerrar conteo
              </h3>
              <p className="mt-2 text-sm text-theme-text-muted">
                La sección de conteo pasará a estado <strong>En revisión</strong>. Esto <strong>no aprueba resultados</strong>:
                la revisión y aprobación se harán después.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirm(null)}
                  disabled={busy}
                  className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={busy}
                  className="inline-flex h-8 items-center rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy ? 'Cerrando…' : 'Confirmar cierre'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return null
}
