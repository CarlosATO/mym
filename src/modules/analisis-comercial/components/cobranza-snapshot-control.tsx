'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getReceivablesSnapshotStatus, requestReceivablesSnapshot, type ReceivablesSnapshotStatus } from '@/app/actions/comercial/cobranza-snapshot'

const POLL_MS = 7000

export function CobranzaSnapshotControl({ initialStatus }: { initialStatus: ReceivablesSnapshotStatus }) {
  const router = useRouter()
  const [status, setStatus] = useState(initialStatus)
  const [pending, setPending] = useState(Boolean(initialStatus.activeRunId))
  const [feedback, setFeedback] = useState<string | null>(null)
  const previousUpdatedAt = useRef(initialStatus.updatedAt)

  const refresh = async () => {
    try {
      const next = await getReceivablesSnapshotStatus()
      setStatus(next)
      if (pending && !next.activeRunId && next.updatedAt !== previousUpdatedAt.current) {
        setPending(false)
        setFeedback(next.status === 'COMPLETED'
          ? 'Cobranzas actualizada correctamente.'
          : 'No fue posible completar la actualización de cobranzas.')
        router.refresh()
      }
    } catch {
      // Keep the last known state; the next poll can recover without blocking Cobranzas.
    }
  }

  useEffect(() => {
    if (!pending && !status.activeRunId) return
    const timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [pending, status.activeRunId])

  const start = async () => {
    if (pending || status.activeRunId) return
    setPending(true)
    setFeedback(null)
    try {
      const result = await requestReceivablesSnapshot()
      setStatus(result.status)
      if (!result.accepted) {
        setPending(false)
        setFeedback('Ya existe una actualización de cobranzas en curso.')
      }
    } catch (error) {
      setPending(false)
      setFeedback(error instanceof Error ? error.message : 'No se pudo iniciar la actualización de cobranzas.')
    }
  }

  const running = pending || Boolean(status.activeRunId)
  const progress = status.clientsTotal > 0 ? `${status.clientsProcessed}/${status.clientsTotal}` : null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void start()} disabled={running} className="border border-[#72383D]/35 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-[#72383D] hover:bg-[#F5EDE9] disabled:cursor-not-allowed disabled:opacity-50">
        {running ? 'Sincronizando cobranzas…' : 'Sincronizar cobranzas'}
      </button>
      {running && <span className="text-[10px] text-[#806238]">{status.rateLimited ? 'BSale solicitó una pausa. La actualización continuará automáticamente.' : 'Actualizando cobranzas…'}{progress ? ` ${progress}` : ''}</span>}
      {!running && feedback && <span role="status" className={`text-[10px] ${status.status === 'COMPLETED' ? 'text-[#426247]' : 'text-[#8A4B4B]'}`}>{feedback}</span>}
    </div>
  )
}
