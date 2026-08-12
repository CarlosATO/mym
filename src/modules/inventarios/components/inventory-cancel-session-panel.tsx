'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, XCircle } from 'lucide-react'
import { cancelInventorySession, type CancelSessionTechnicalError } from '@/app/actions/inventarios/review'

interface InventoryCancelSessionPanelProps {
  companyId: string
  sessionId: string
}

function cancelIdempotencyKey(sessionId: string): string {
  if (typeof window === 'undefined') return `${Date.now()}-cancel`
  const storageKey = `inventarios:cancel:${sessionId}`
  const existing = window.sessionStorage.getItem(storageKey)
  if (existing) return existing
  const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-cancel`
  window.sessionStorage.setItem(storageKey, key)
  return key
}

export function InventoryCancelSessionPanel({ companyId, sessionId }: InventoryCancelSessionPanelProps) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorTechnical, setErrorTechnical] = useState<CancelSessionTechnicalError | null>(null)

  const openDialog = () => {
    setConfirming(true)
    setReason('')
    setError(null)
    setErrorTechnical(null)
  }

  const handleCancel = async () => {
    if (busy || reason.trim().length < 5) return
    setBusy(true)
    setError(null)
    setErrorTechnical(null)
    const key = cancelIdempotencyKey(sessionId)
    const result = await cancelInventorySession(companyId, sessionId, reason, key)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      setErrorTechnical(result.errorTechnical ?? null)
      return
    }
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(`inventarios:cancel:${sessionId}`)
    setConfirming(false)
    router.push(`/dashboard/inventarios/jornadas/${sessionId}?tab=resumen`)
    router.refresh()
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-500/20 dark:text-red-300"
      >
        <XCircle className="h-4 w-4" />
        Cancelar sección de conteo
      </button>

      {confirming && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Cancelar sección de conteo</h3>
            <div className="mt-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-sm text-theme-text-muted">
              Se cancelará esta sección de conteo de forma definitiva. Se preservan el snapshot,
              los conteos, las incidencias y la evidencia registrada. Esta acción no se puede deshacer.
            </div>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              placeholder="Motivo de la cancelación (mínimo 5 caracteres)"
              className="mt-3 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
            />
            {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
            {errorTechnical && (
              <details className="mt-2 rounded-lg border border-theme-border/60 bg-theme-text/[0.02] px-3 py-2 text-xs text-theme-text-muted">
                <summary className="flex cursor-pointer items-center gap-1 font-medium text-theme-text-muted select-none">
                  <ChevronDown className="h-3.5 w-3.5" />
                  Detalle técnico para administración
                </summary>
                <div className="mt-2 space-y-1">
                  {errorTechnical.code && (
                    <p><span className="font-semibold text-theme-text-muted">Código:</span> {errorTechnical.code}</p>
                  )}
                  {errorTechnical.message && (
                    <p><span className="font-semibold text-theme-text-muted">Mensaje:</span> {errorTechnical.message}</p>
                  )}
                  {errorTechnical.details && (
                    <p><span className="font-semibold text-theme-text-muted">Detalle:</span> {errorTechnical.details}</p>
                  )}
                  {errorTechnical.hint && (
                    <p><span className="font-semibold text-theme-text-muted">Sugerencia:</span> {errorTechnical.hint}</p>
                  )}
                </div>
              </details>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
              >
                Volver
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={busy || reason.trim().length < 5}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
              >
                <XCircle className="h-4 w-4" />
                {busy ? 'Cancelando…' : 'Cancelar sección de conteo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
