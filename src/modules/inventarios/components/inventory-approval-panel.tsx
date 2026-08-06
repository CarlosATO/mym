'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { BadgeCheck, ShieldCheck } from 'lucide-react'
import type { InventorySessionReview } from '@/app/actions/inventarios/sessions'
import { approveInventorySession } from '@/app/actions/inventarios/review'

interface InventoryApprovalPanelProps {
  companyId: string
  sessionId: string
  review: InventorySessionReview
}

function approvalIdempotencyKey(sessionId: string): string {
  if (typeof window === 'undefined') return `${Date.now()}-approve`
  const storageKey = `inventarios:approve:${sessionId}`
  const existing = window.sessionStorage.getItem(storageKey)
  if (existing) return existing
  const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-approve`
  window.sessionStorage.setItem(storageKey, key)
  return key
}

export function InventoryApprovalPanel({ companyId, sessionId, review }: InventoryApprovalPanelProps) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = review.indicators.ready_to_approve === true

  const handleApprove = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const key = approvalIdempotencyKey(sessionId)
    const result = await approveInventorySession(companyId, sessionId, key)
    setBusy(false)
    setConfirming(false)
    if (result.error) {
      setError(result.error)
      return
    }
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(`inventarios:approve:${sessionId}`)
    router.push(`/dashboard/inventarios/jornadas/${sessionId}?tab=resultados`)
  }

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-theme-text">
            <ShieldCheck className="h-4 w-4 text-theme-accent" /> Aprobación de la sección de conteo
          </h3>
          <p className="mt-1 text-xs text-theme-text-muted">
            {ready
              ? 'La sección de conteo está lista para aprobarse y generar el resultado oficial.'
              : 'Resuelve todos los bloqueos para habilitar la aprobación.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={!ready || busy}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
        >
          <BadgeCheck className="h-4 w-4" />
          Aprobar sección de conteo
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {confirming && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Aprobar sección de conteo</h3>
            <p className="mt-2 text-sm text-theme-text-muted">
              Se generará el <strong>resultado oficial</strong> de la sección de conteo. Este paso no se puede deshacer.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-40"
              >
                {busy ? 'Aprobando…' : 'Confirmar aprobación'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
