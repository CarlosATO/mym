'use client'

import { Suspense, useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { AlertCircle, CheckCircle2, Clock3, RefreshCw } from 'lucide-react'
import {
  forceSyncBsaleReplenishment,
  getLatestBsaleSyncRun,
  type LatestBsaleSyncRun,
} from '@/app/actions/integraciones/sync'
import { isPreparationOrdersTopbarSurface } from '@/modules/logistica/preparacion-pedidos/preparation-sync-policy'

type Props = {
  isSuperUsuario: boolean
  roleName?: string
  permissions?: string[]
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

function BsaleReplenishmentTopbarControlInner({ isSuperUsuario, roleName, permissions }: Props) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tab = searchParams.get('tab')
  const hiddenOnPreparation = isPreparationOrdersTopbarSurface({
    pathname,
    tab,
    roleName,
    permissions,
  })

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
    if (hiddenOnPreparation) return
    const initialLoad = window.setTimeout(() => void loadLatestRun(), 0)
    const interval = window.setInterval(() => void loadLatestRun(), 30000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
    }
  }, [hiddenOnPreparation])

  if (hiddenOnPreparation) {
    return null
  }

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
  const formattedDate = loading ? 'Cargando…' : isRunning ? 'Sincronizando…' : formatRunDate(latestRun)

  const dotColor =
    status === 'COMPLETED'
      ? 'bg-emerald-500'
      : status === 'PARTIAL'
        ? 'bg-amber-500'
        : status === 'FAILED'
          ? 'bg-red-500'
          : status === 'STARTED'
            ? 'bg-sky-500'
            : 'bg-slate-400'

  return (
    <div className="flex items-center">
      {isSuperUsuario ? (
        <button
          type="button"
          onClick={handleSync}
          disabled={Boolean(isRunning)}
          title={`Sincronización Bsale · Última: ${formattedDate} (${statusLabel(status)}) — Clic para sincronizar`}
          aria-label={isRunning ? 'Sincronización Bsale en curso' : 'Sincronizar Bsale ahora'}
          className="group relative flex h-8 items-center gap-1.5 rounded-full border border-theme-border/60 bg-theme-surface/60 px-2.5 text-[11px] font-medium text-theme-text-muted transition-all duration-200 hover:border-sky-500/40 hover:bg-sky-500/8 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className="relative flex h-2 w-2 shrink-0">
            {isRunning && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${dotColor}`} />
          </span>
          <RefreshCw
            className={`h-3.5 w-3.5 shrink-0 text-theme-text-muted transition-transform duration-300 group-hover:rotate-90 group-hover:text-sky-600 dark:group-hover:text-sky-400 ${isRunning ? 'animate-spin text-sky-500' : ''}`}
            aria-hidden="true"
          />
          <span className="hidden md:inline whitespace-nowrap">
            {isRunning ? 'Sincronizando…' : 'Sincronizar'}
          </span>
        </button>
      ) : (
        <div
          className="flex h-8 items-center gap-1.5 rounded-full border border-theme-border/50 bg-theme-surface/40 px-2.5 text-[11px] text-theme-text-muted"
          title={`Última sincronización Bsale: ${formattedDate} (${statusLabel(status)})`}
        >
          <span className={`inline-flex h-2 w-2 rounded-full ${dotColor}`} />
          <span className="hidden lg:inline whitespace-nowrap text-[10px]">Sync {formattedDate}</span>
        </div>
      )}
    </div>
  )
}

export { isPreparationOrdersTopbarSurface }

export function BsaleReplenishmentTopbarControl(props: Props) {
  return (
    <Suspense fallback={null}>
      <BsaleReplenishmentTopbarControlInner {...props} />
    </Suspense>
  )
}
