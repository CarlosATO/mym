'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getReceivablesSnapshotStatus, requestReceivablesSnapshot, type ReceivablesSnapshotStatus } from '@/app/actions/comercial/cobranza-snapshot'

const POLL_MS = 15000

export function CobranzaSnapshotControl({ initialStatus }: { initialStatus: ReceivablesSnapshotStatus }) {
  const router = useRouter()
  const [status, setStatus] = useState(initialStatus)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const next = await getReceivablesSnapshotStatus()
      const wasActive = pending || status.executionState === 'ACTIVE'
      setStatus(next)
      if (next.executionState === 'INTERRUPTED' || next.executionState === 'PAUSED') {
        setPending(false)
        setFeedback(null)
      } else if (next.executionState === 'ACTIVE') {
        setPending(false)
      } else if (wasActive) {
        setPending(false)
        setFeedback(next.status === 'COMPLETED'
          ? 'Cobranzas actualizada correctamente.'
          : 'No fue posible completar la actualización de cobranzas.')
        router.refresh()
      }
    } catch {
      // Preserve the last rendered state; the next poll may succeed.
    }
  }

  useEffect(() => {
    // Do not poll abandoned runs forever. A resume is explicitly initiated by the user.
    if (!pending && status.executionState !== 'ACTIVE') return
    const timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [pending, status.executionState])

  const start = async () => {
    if (pending || status.executionState === 'ACTIVE') return
    setPending(true)
    setFeedback(null)
    try {
      const result = await requestReceivablesSnapshot()
      setStatus(result.status)
      if (!result.accepted) {
        setPending(false)
        setFeedback('Ya existe una actualización de cobranzas en curso. Intenta nuevamente más tarde.')
      }
    } catch (error) {
      setPending(false)
      setFeedback(error instanceof Error ? error.message : 'No se pudo iniciar la actualización de cobranzas.')
    }
  }

  const interrupted = status.executionState === 'INTERRUPTED'
  const paused = status.executionState === 'PAUSED'
  const resumable = interrupted || paused
  const running = pending || status.executionState === 'ACTIVE'
  const progress = status.clientsTotal > 0 ? `${status.clientsProcessed}/${status.clientsTotal}` : null
  const effectiveCoverage = status.clientsTotal > 0
    ? Math.round((status.clientsSuccess / status.clientsTotal) * 1000) / 10
    : 100
  const effectiveCoverageLabel = effectiveCoverage === 100 ? '100%' : `${effectiveCoverage.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
  const terminalSnapshot = status.status === 'COMPLETED' || status.status === 'PARTIAL'
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <button type="button" onClick={() => void start()} disabled={running} className="border border-[#72383D]/35 bg-white px-2 py-1 text-[10px] font-semibold text-[#72383D] hover:bg-[#F5EDE9] disabled:cursor-not-allowed disabled:opacity-50">
        {running ? 'Sincronizando cobranzas…' : resumable ? 'Reanudar sincronización' : 'Sincronizar cobranzas'}
      </button>
      {running && <span className="break-words text-[10px] leading-4 text-[#806238]">{status.rateLimited ? 'BSale solicitó una pausa. La actualización continuará automáticamente.' : 'Actualizando cobranzas…'}{progress ? ` ${progress}` : ''}</span>}
      {resumable && !running && (
        <span className="break-words text-[10px] leading-4 text-[#8A4B4B]" role="alert">
          {paused
            ? 'La actualización está en pausa por el límite de solicitudes de Bsale.'
            : 'Sincronización interrumpida: no se detecta actividad del proceso.'}
          {progress ? ` Se conservaron ${progress} clientes procesados.` : ''}
          {' '}Puedes reanudar sin repetir los clientes registrados. La cartera visible mantiene el último corte completo.
        </span>
      )}
      {!running && terminalSnapshot && status.clientsTotal > 0 && (
        <span className={`break-words text-[10px] leading-4 ${status.clientsError > 0 ? 'text-[#8A4B4B]' : 'text-[#806238]'}`}>
          {status.clientsSuccess} consultados · {status.clientsUnqueryable} no consultables
          {status.clientsError > 0 ? ` · ${status.clientsError} con error` : ''}
          {' · '}Cobertura efectiva {effectiveCoverageLabel}
        </span>
      )}
      {!running && feedback && <span role="status" className={`break-words text-[10px] leading-4 ${status.status === 'COMPLETED' ? 'text-[#426247]' : 'text-[#8A4B4B]'}`}>{feedback}</span>}
    </div>
  )
}
