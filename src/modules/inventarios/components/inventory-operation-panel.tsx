'use client'

import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, UserRound } from 'lucide-react'
import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { getActiveCompanySessionDetail } from '@/app/actions/inventarios/sessions'
import { InventoryOperationActions } from '@/modules/inventarios/components/inventory-operation-actions'
import { InventoryTaskProgress } from '@/modules/inventarios/components/inventory-task-progress'
import { InventoryZoneProgress } from '@/modules/inventarios/components/inventory-zone-progress'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { inventoryRoleLabel } from '@/modules/inventarios/lib/states'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

interface InventoryOperationPanelProps {
  companyId: string
  sessionId: string
  initialDetail: InventorySessionDetail | null
}

export function InventoryOperationPanel({ companyId, sessionId, initialDetail }: InventoryOperationPanelProps) {
  const [detail, setDetail] = useState<InventorySessionDetail | null>(initialDetail)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = async () => {
    setRefreshing(true)
    const result = await getActiveCompanySessionDetail(sessionId)
    setRefreshing(false)
    if (result.error || !result.data) {
      setError(result.error ?? 'No se pudo cargar la jornada.')
      return
    }
    setDetail(result.data)
    setError(null)
  }

  useEffect(() => {
    if (!detail) {
      getActiveCompanySessionDetail(sessionId).then(result => {
        if (result.data) setDetail(result.data)
        if (result.error) setError(result.error)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  if (error && !detail) {
    return <InventoryErrorState description={error} onRetry={load} />
  }
  if (!detail) {
    return <InventoryLoadingState label="Cargando operación de la jornada…" />
  }

  const status = detail.session.status
  const tasks = detail.tasks.filter(t => !t.cancelled_at)
  const activeZones = detail.zones.filter(z => z.is_enabled)
  const activeParticipants = detail.participants.filter(p => !p.revoked_at)

  const zoneRows = activeZones.map(zone => {
    const task = tasks.find(t => t.session_zone_id === zone.id)
    return {
      zone,
      taskStatus: task?.status ?? null,
      assignedUser: task?.assignment?.user_name ?? null,
    }
  })

  return (
    <div className="space-y-4">
      {/* Cabecera de operación */}
      <div className="flex flex-col gap-3 rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-theme-text">
              {status === 'PREPARED' ? 'Jornada preparada' : 'Jornada en conteo'}
            </h3>
            <InventoryStatusBadge status={status} />
          </div>
          <p className="mt-1 text-xs text-theme-text-muted">
            {status === 'PREPARED'
              ? 'Lista para abrir. Al abrir, la configuración queda cerrada.'
              : `Última información ${formatDateTimeChile(detail.session.updated_at)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={refreshing}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-40"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Actualizar
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Acciones según estado */}
      <InventoryOperationActions companyId={companyId} sessionId={sessionId} detail={detail} />

      {/* Monitoreo COUNTING */}
      {status === 'COUNTING' && (
        <div className="space-y-4">
          <InventoryTaskProgress tasks={tasks} />

          <InventoryZoneProgress zones={zoneRows} />

          {/* Participantes activos */}
          <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
            <h3 className="mb-2 text-sm font-semibold text-theme-text">Participantes activos</h3>
            {activeParticipants.length === 0 ? (
              <p className="text-sm text-theme-text-muted">Sin participantes activos.</p>
            ) : (
              <ul className="space-y-1">
                {activeParticipants.map(participant => (
                  <li key={participant.id} className="flex items-center gap-2 text-sm">
                    <UserRound className="h-3.5 w-3.5 text-theme-text-muted/50" />
                    <span className="truncate text-theme-text">{participant.user_name ?? '—'}</span>
                    <span className="ml-auto shrink-0 text-xs text-theme-text-muted">
                      {inventoryRoleLabel(participant.functional_role)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
              <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Conteos</p>
              <p className="text-xl font-bold text-theme-text">{detail.counts.count_entry_count}</p>
            </div>
            <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
              <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Contribuciones</p>
              <p className="text-xl font-bold text-theme-text">{detail.counts.effective_contribution_count}</p>
            </div>
            <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
              <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Recuentos pendientes</p>
              <p className="text-xl font-bold text-theme-text">{detail.counts.pending_recount_count}</p>
            </div>
            <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
              <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Incidencias bloqueantes</p>
              <p className={`text-xl font-bold ${detail.counts.blocking_incident_count > 0 ? 'text-red-600 dark:text-red-400' : 'text-theme-text'}`}>
                {detail.counts.blocking_incident_count}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Vista previa PREPARED */}
      {status === 'PREPARED' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Tareas</p>
            <p className="text-xl font-bold text-theme-text">{tasks.length}</p>
          </div>
          <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Zonas</p>
            <p className="text-xl font-bold text-theme-text">{activeZones.length}</p>
          </div>
          <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Participantes</p>
            <p className="text-xl font-bold text-theme-text">{activeParticipants.length}</p>
          </div>
        </div>
      )}
    </div>
  )
}
