'use client'

import { useEffect, useState } from 'react'
import { Check, MapPin, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { CatalogUserOption, InventorySessionTask } from '@/app/actions/inventarios/sessions'
import type { TasksSetup } from '@/app/actions/inventarios/tasks'
import {
  cancelInventoryTask,
  createInventoryTask,
  getActiveCompanyTasksSetup,
  reassignInventoryTask,
} from '@/app/actions/inventarios/tasks'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

interface TasksStepProps {
  companyId: string
  sessionId: string
  users: CatalogUserOption[]
  onReadyChange?: (ready: boolean) => void
}

export function InventoryTasksStep({ companyId, sessionId, users, onReadyChange }: TasksStepProps) {
  const router = useRouter()
  const [setup, setSetup] = useState<TasksSetup | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [assignments, setAssignments] = useState<Record<string, string>>({})

  const loadSetup = async () => {
    const result = await getActiveCompanyTasksSetup(sessionId)
    if (result.data) setSetup(result.data)
    setLoading(false)
  }

  useEffect(() => {
    getActiveCompanyTasksSetup(sessionId).then(result => {
      if (result.data) setSetup(result.data)
      setLoading(false)
    })
  }, [sessionId])

  const zones = (setup?.zones ?? []).filter(z => z.is_enabled)
  const tasks = setup?.tasks ?? []
  const activeTasks = tasks.filter(t => !t.cancelled_at)
  const counters = (setup?.participants ?? []).filter(
    p => !p.revoked_at && p.functional_role === 'COUNTER'
  )

  const taskByZone = (zoneId: string) => activeTasks.find(t => t.session_zone_id === zoneId) ?? null
  const incompleteZones = zones.filter(zone => {
    const task = taskByZone(zone.id)
    if (!task) return true
    if (task.status !== 'ASSIGNED') return true
    if (!task.assignment?.user_id) return true
    const counter = counters.find(c => c.user_id === task.assignment?.user_id)
    return !counter
  })

  const ready = zones.length > 0 && incompleteZones.length === 0

  useEffect(() => {
    onReadyChange?.(ready)
  }, [ready, onReadyChange])

  const userDisplay = (userId: string | null | undefined): string => {
    if (!userId) return '—'
    const user = users.find(u => u.id === userId)
    if (user) return `${user.nombre} ${user.apellido}`.trim()
    const counter = counters.find(c => c.user_id === userId)
    return counter?.user_name ?? '—'
  }

  const createTask = async (zoneId: string, counterUserId: string) => {
    if (busy || !counterUserId) return
    setBusy(true)
    setError(null)
    const result = await createInventoryTask(companyId, sessionId, zoneId, counterUserId)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    await loadSetup()
    router.refresh()
  }

  const reassignTask = async (task: InventorySessionTask, counterUserId: string) => {
    if (busy || !counterUserId) return
    if (!window.confirm(`¿Reasignar la tarea de esta zona a ${userDisplay(counterUserId)}?`)) return
    setBusy(true)
    setError(null)
    const result = await reassignInventoryTask(
      companyId,
      task.id,
      task.version,
      task.validation_cycle,
      counterUserId,
      'Reasignación desde el asistente'
    )
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    await loadSetup()
    router.refresh()
  }

  const cancelTask = async (task: InventorySessionTask) => {
    if (busy) return
    if (!window.confirm('¿Cancelar esta tarea? Podrás crear una nueva para la zona.')) return
    setBusy(true)
    setError(null)
    const result = await cancelInventoryTask(
      companyId,
      task.id,
      task.version,
      task.validation_cycle,
      'Cancelada desde el asistente'
    )
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    await loadSetup()
    router.refresh()
  }

  if (loading) {
    return <InventoryLoadingState label="Cargando tareas y asignaciones…" />
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-theme-text-muted">
        Crea una tarea por zona y asígnala a un tomador. Cada zona requiere un responsable de conteo.
      </p>

      {/* Requisitos */}
      <div className="rounded-lg border border-theme-border bg-theme-text/2 p-3">
        <p className="mb-2 text-xs font-semibold text-theme-text-muted uppercase tracking-wider">Requisitos para continuar</p>
        <ul className="space-y-1 text-sm">
          {[
            { met: zones.every(z => taskByZone(z.id)), label: 'Cada zona con al menos 1 tarea activa' },
            { met: activeTasks.every(t => t.status === 'ASSIGNED'), label: 'Todas las tareas en estado Asignada' },
            { met: activeTasks.every(t => Boolean(t.assignment?.user_id)), label: 'Toda tarea con asignación vigente' },
            { met: incompleteZones.length === 0, label: 'Todo asignado es un tomador activo' },
          ].map(req => (
            <li key={req.label} className={`flex items-center gap-2 ${req.met ? 'text-emerald-700 dark:text-emerald-300' : 'text-theme-text-muted'}`}>
              <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${req.met ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-theme-border'}`}>
                {req.met && <Check className="h-3 w-3" />}
              </span>
              {req.label}
            </li>
          ))}
        </ul>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {busy && <InventoryLoadingState compact label="Guardando cambios…" />}

      {zones.length === 0 ? (
        <p className="text-sm text-theme-text-muted">No hay zonas activas. Completa el paso de zonas primero.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {zones.map(zone => {
            const task = taskByZone(zone.id)
            const selectable = counters.filter(c => c.user_id !== task?.assignment?.user_id)
            return (
              <div key={zone.id} className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-theme-text">{zone.display_name}</p>
                    <p className="font-mono text-xs text-theme-text-muted">{zone.zone_code}</p>
                  </div>
                  {task && <InventoryStatusBadge status={task.status} />}
                </div>

                {zone.locations && zone.locations.length > 0 && (
                  <ul className="mb-3 space-y-0.5">
                    {zone.locations.map(location => (
                      <li key={location.location_id} className="flex items-center gap-1.5 text-xs text-theme-text-muted">
                        <MapPin className="h-3 w-3 shrink-0 text-theme-text-muted/50" />
                        <span className="truncate">{location.name ?? location.code}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {!task ? (
                  <div className="space-y-2">
                    <p className="text-xs text-theme-text-muted/70">Esta zona no tiene tarea.</p>
                    <select
                      value={assignments[zone.id] ?? ''}
                      onChange={e => setAssignments(prev => ({ ...prev, [zone.id]: e.target.value }))}
                      aria-label={`Tomador para ${zone.display_name}`}
                      className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-border-accent"
                    >
                      <option value="">Selecciona un tomador</option>
                      {counters.map(counter => (
                        <option key={counter.user_id} value={counter.user_id}>
                          {userDisplay(counter.user_id)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => createTask(zone.id, assignments[zone.id] ?? '')}
                      disabled={busy || !assignments[zone.id]}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Crear tarea
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-theme-text-muted">Tomador asignado</span>
                      <span className="truncate text-xs font-medium text-theme-text">
                        {userDisplay(task.assignment?.user_id)}
                      </span>
                    </div>

                    {selectable.length > 0 ? (
                      <div className="flex items-center gap-2">
                        <select
                          value=""
                          onChange={e => e.target.value && reassignTask(task, e.target.value)}
                          aria-label={`Reasignar tarea de ${zone.display_name}`}
                          className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-border-accent"
                        >
                          <option value="">Cambiar tomador…</option>
                          {selectable.map(counter => (
                            <option key={counter.user_id} value={counter.user_id}>
                              {userDisplay(counter.user_id)}
                            </option>
                          ))}
                        </select>
                        <RefreshCw className="h-3.5 w-3.5 shrink-0 text-theme-text-muted/50" />
                      </div>
                    ) : (
                      <p className="text-xs text-theme-text-muted/70">No hay otro tomador disponible.</p>
                    )}

                    {task.status === 'ASSIGNED' && (
                      <button
                        type="button"
                        onClick={() => cancelTask(task)}
                        disabled={busy}
                        className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Cancelar tarea
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {incompleteZones.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Zonas incompletas: {incompleteZones.map(z => z.display_name).join(', ')}.
        </p>
      )}
    </div>
  )
}
