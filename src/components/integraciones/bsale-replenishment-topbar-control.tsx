'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock3, RefreshCw } from 'lucide-react'
import {
  forceSyncBsaleReplenishment,
  getLatestBsaleSyncRun,
  type LatestBsaleSyncRun,
} from '@/app/actions/integraciones/sync'

type Props = {
  isSuperUsuario: boolean
}

const TIME_ZONE = 'America/Santiago'

function formatRunDate(run: LatestBsaleSyncRun | null) {
  const value = run?.completed_at || run?.started_at
  if (!value) return '—'

  return new Intl.DateTimeFormat('es-CL', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function statusLabel(status: string | undefined) {
  if (!status) return 'Nunca'
  if (status === 'FAILED') return 'ERROR'
  if (status === 'STARTED') return 'EN CURSO'
  return status
}

function statusClass(status: string | undefined) {
  if (status === 'COMPLETED') return 'text-emerald-500'
  if (status === 'PARTIAL') return 'text-amber-500'
  if (status === 'FAILED') return 'text-red-500'
  if (status === 'STARTED') return 'text-blue-500'
  return 'text-theme-text-muted'
}

export function BsaleReplenishmentTopbarControl({ isSuperUsuario }: Props) {
  const [latestRun, setLatestRun] = useState<LatestBsaleSyncRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  async function loadLatestRun() {
    try {
      setLatestRun(await getLatestBsaleSyncRun())
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadLatestRun(), 0)
    const interval = window.setInterval(() => void loadLatestRun(), 30000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
    }
  }, [])

  async function handleSync() {
    if (syncing) return
    setSyncing(true)
    try {
      await forceSyncBsaleReplenishment()
    } catch (error) {
      console.error(error)
    } finally {
      await loadLatestRun()
      setSyncing(false)
    }
  }

  const isRunning = syncing || latestRun?.status === 'STARTED'
  const status = syncing ? 'STARTED' : latestRun?.status

  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-theme-border/60 bg-theme-surface/40 px-1.5 text-[10px]" title="Última sincronización Bsale">
      <span className={`flex items-center ${statusClass(status)}`} aria-hidden="true">
        {isRunning ? <RefreshCw className="h-3 w-3 animate-spin" /> : status === 'COMPLETED' ? <CheckCircle2 className="h-3 w-3" /> : status === 'PARTIAL' || status === 'FAILED' ? <AlertCircle className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
      </span>
      <span className="hidden whitespace-nowrap text-theme-text-muted sm:inline">Última sync</span>
      <span className="whitespace-nowrap font-medium text-theme-text">
        {loading ? '…' : isRunning ? 'Sincronizando…' : formatRunDate(latestRun)}
      </span>
      {!loading && !isRunning && <span className={`hidden whitespace-nowrap font-semibold sm:inline ${statusClass(status)}`}>{statusLabel(status)}</span>}
      {isSuperUsuario && (
        <button
          type="button"
          onClick={handleSync}
          disabled={Boolean(isRunning)}
          className="ml-0.5 rounded px-1.5 py-0.5 font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/10 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={isRunning ? 'Sincronización Bsale en curso' : 'Sincronizar Bsale ahora'}
        >
          <span className="hidden sm:inline">{isRunning ? 'Sincronizando…' : 'Sincronizar'}</span>
          <RefreshCw className={`h-3 w-3 sm:hidden ${isRunning ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
