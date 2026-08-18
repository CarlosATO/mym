'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ClipboardList, X } from 'lucide-react'
import type { InventoryParticipant, InventorySessionDetail, InventorySessionSetupResult, InventorySessionTask, InventorySessionZone } from '@/app/actions/inventarios/sessions'
import { getActiveCompanyPrepareSetup, prepareInventorySession } from '@/app/actions/inventarios/sessions'
import { listInventorySessionScopes, type InventorySessionScopesResult } from '@/app/actions/inventarios/counting-zones'
import { clearWizardDraft } from '@/modules/inventarios/lib/wizard'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'
import { notifyInventoryNavigation } from '@/modules/inventarios/components/inventory-navigation-feedback'

export type PrepareRequirementStatus = 'ok' | 'missing' | 'deferred'

export interface PrepareRequirement {
  key: string
  label: string
  status: PrepareRequirementStatus
  step?: number
}

export function activeParticipantCount(participants: InventoryParticipant[], role: string): number {
  const now = Date.now()
  return participants.filter(
    participant =>
      !participant.revoked_at &&
      new Date(participant.active_from).getTime() <= now &&
      participant.functional_role === role
  ).length
}

export function buildPrepareRequirements(input: {
  session: { scope_mode: string }
  snapshot: InventorySessionDetail['snapshot'] | null
  participants: InventoryParticipant[]
  zones: InventorySessionZone[]
  tasks: InventorySessionTask[]
  product_scope: Array<Record<string, unknown>>
  coverageComplete?: boolean
}): PrepareRequirement[] {
  const { session, snapshot, participants, zones, tasks, product_scope } = input
  const activeZones = (zones ?? []).filter(zone => zone.is_enabled)
  const snapshotPending = !snapshot || snapshot.completion_status === 'PENDING'
  const partialOk = session.scope_mode !== 'PARTIAL' || (product_scope?.length ?? 0) > 0
  const hasOperationalResponsible =
    activeParticipantCount(participants, 'ADMINISTRATOR') > 0 ||
    activeParticipantCount(participants, 'SUPERVISOR') > 0 ||
    activeParticipantCount(participants, 'MANAGER') > 0
  const activeTasks = (tasks ?? []).filter(task => !task.cancelled_at)
  const tasksReady = activeZones.length > 0 && activeZones.every(zone => {
    const task = activeTasks.find(candidate => candidate.session_zone_id === zone.id)
    return task?.status === 'ASSIGNED' && Boolean(task.assignment?.user_id) &&
      participants.some(participant =>
        participant.user_id === task.assignment?.user_id &&
        participant.functional_role === 'COUNTER' &&
        !participant.revoked_at &&
        new Date(participant.active_from).getTime() <= Date.now()
      )
  })
  return [
    {
      key: 'snapshot',
      label: 'Snapshot pendiente',
      status: snapshotPending ? 'ok' : 'missing',
    },
    {
      key: 'counter',
      label: 'Al menos 1 Tomador activo',
      status: activeParticipantCount(participants, 'COUNTER') > 0 ? 'ok' : 'missing',
      step: 3,
    },
    {
      key: 'responsible',
      label: 'Al menos 1 responsable operacional (Administrador, Supervisor o Encargado)',
      status: hasOperationalResponsible ? 'ok' : 'missing',
      step: 3,
    },
    {
      key: 'zones',
      label: 'Al menos 1 zona activa',
      status: activeZones.length > 0 ? 'ok' : 'missing',
      step: 4,
    },
    {
      key: 'zone_locations',
      label: 'Cada zona activa con al menos 1 ubicación',
      status: activeZones.every(zone => (zone.locations?.length ?? 0) > 0) ? 'ok' : 'missing',
      step: 4,
    },
    {
      key: 'partial_products',
      label: 'Alcance parcial con al menos 1 producto',
      status: partialOk ? 'ok' : 'missing',
      step: 2,
    },
    {
      key: 'tasks',
      label: 'Tareas asignadas con responsable activo',
      status: tasksReady ? 'ok' : 'missing',
      step: 5,
    },
    {
      key: 'snapshot_products',
      label: 'Snapshot de productos construible',
      status: 'deferred',
    },
  ]
}

function makeKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface InventoryPrepareSectionProps {
  companyId: string
  sessionId: string
}

export function InventoryPrepareSection({ companyId, sessionId }: InventoryPrepareSectionProps) {
  const router = useRouter()
  const [setup, setSetup] = useState<InventorySessionSetupResult | null>(null)
  const [scopes, setScopes] = useState<InventorySessionScopesResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [preparing, setPreparing] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idempotencyRef = useRef<string | null>(null)

  useEffect(() => {
    let mounted = true
    const loadSetup = () => {
      void Promise.all([getActiveCompanyPrepareSetup(sessionId), listInventorySessionScopes(companyId, sessionId)]).then(
        ([setupResult, scopesResult]) => {
          if (!mounted) return
          if (setupResult.data) setSetup(setupResult.data)
          if (scopesResult.data) setScopes(scopesResult.data)
          setLoading(false)
        }
      )
    }
    const handleSetupUpdated = () => loadSetup()
    loadSetup()
    window.addEventListener('inventarios:setup-updated', handleSetupUpdated)
    return () => {
      mounted = false
      window.removeEventListener('inventarios:setup-updated', handleSetupUpdated)
    }
  }, [companyId, sessionId])

  const handlePrepare = async () => {
    if (preparing) return
    setPreparing(true)
    setError(null)
    if (!idempotencyRef.current) idempotencyRef.current = makeKey()
    const result = await prepareInventorySession(companyId, sessionId, idempotencyRef.current)
    setPreparing(false)
    setShowConfirm(false)
    if (result.error) {
      setError(result.error)
      return
    }
    clearWizardDraft()
    notifyInventoryNavigation()
    router.push(`/dashboard/inventarios/jornadas/${sessionId}?tab=operacion`)
  }

  if (loading || !setup || !setup.session) {
    return (
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <InventoryLoadingState compact label="Cargando requisitos…" />
      </div>
    )
  }

  const { session, snapshot, participants, zones, tasks, product_scope } = setup
  const requirements = buildPrepareRequirements({
    session,
    snapshot,
    participants,
    zones,
    tasks,
    product_scope,
    coverageComplete: scopes ? scopes.pending_locations === 0 : false,
  })
  const missing = requirements.filter(requirement => requirement.status === 'missing')
  const deferred = requirements.filter(requirement => requirement.status === 'deferred')
  const ready = missing.length === 0
  const totalLocations = scopes?.total_locations ?? 0
  const assignedLocations = scopes?.assigned_locations ?? 0
  const pendingLocations = scopes?.pending_locations ?? 0

  return (
    <section aria-label="Preparar sección de conteo">
      {error && (
        <div className="mb-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex flex-col items-start gap-3 rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-theme-text">
            {ready ? 'Configuración completa' : 'Configuración incompleta'}
          </p>
          {ready ? (
            <p className="text-xs text-theme-text-muted">La sección de conteo está lista para prepararse.</p>
          ) : (
            <p className="text-xs text-theme-text-muted">Faltan {missing.length} requisito(s) antes de preparar.</p>
          )}
          {!ready && missing.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {missing.map(requirement => (
                <li key={requirement.key}>
                  <a
                    href={
                      requirement.step
                        ? `/dashboard/inventarios/jornadas/${sessionId}?tab=configuracion&step=${requirement.step}`
                        : `/dashboard/inventarios/jornadas/${sessionId}?tab=configuracion`
                    }
                    className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/5 px-2 py-0.5 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                  >
                    <X className="h-3 w-3" />
                    {requirement.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {totalLocations > 0 && (
            <p className="mt-1.5 text-[11px] text-theme-text-muted">
              {assignedLocations} ubicaciones habilitadas · {pendingLocations} pendientes · {totalLocations} totales.
              {pendingLocations > 0 && ' Las pendientes podrán incorporarse posteriormente.'}
            </p>
          )}
          {deferred.length > 0 && (
            <p className="mt-1.5 text-[11px] text-theme-text-muted/70">
              Validación final al preparar: {deferred.map(requirement => requirement.label).join(' · ')}.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          disabled={!ready || preparing}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
        >
          {preparing ? <InventoryLoadingState compact label="Preparando…" /> : <ClipboardList className="h-4 w-4" />}
          {!preparing && 'Preparar sección'}
        </button>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
            <div className="border-b border-theme-border/70 px-6 pb-4 pt-5">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-theme-accent/10 text-theme-accent">
                  <ClipboardList className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold tracking-tight text-theme-text">Preparar sección de conteo</h3>
                  <p className="mt-1 text-sm leading-5 text-theme-text-muted">
                    Revisa el resumen antes de congelar la configuración.
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-5">
              <p className="text-sm leading-6 text-theme-text-muted">
               Al preparar la sección se congelará el snapshot y quedará lista para iniciar el conteo. Las ubicaciones
               pendientes podrán incorporarse posteriormente mientras la sección esté abierta.
              </p>
               <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-theme-border/70 bg-theme-border/70">
                 <div className="bg-theme-surface px-4 py-3">
                   <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Sección de conteo</p>
                   <p className="mt-1 truncate text-sm font-semibold text-theme-text">{setup.session.name}</p>
                 </div>
                 <div className="bg-theme-surface px-4 py-3">
                   <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Cobertura</p>
                   <p className="mt-1 text-sm font-semibold text-theme-text">{assignedLocations} habilitadas · {pendingLocations} pendientes</p>
                 </div>
                 <div className="bg-theme-surface px-4 py-3">
                   <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Zonas creadas</p>
                   <p className="mt-1 text-sm font-semibold text-theme-text">{setup.indicators.zone_count}</p>
                 </div>
                 <div className="bg-theme-surface px-4 py-3">
                   <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Ubicaciones asignadas</p>
                   <p className="mt-1 text-sm font-semibold text-theme-text">{setup.indicators.location_count}</p>
                 </div>
                 <div className="bg-theme-surface px-4 py-3">
                   <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Tareas</p>
                   <p className="mt-1 text-sm font-semibold text-theme-text">{setup.indicators.task_count}</p>
                 </div>
                 <div className="bg-theme-surface px-4 py-3">
                   <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Tomadores asignados</p>
                   <p className="mt-1 text-sm font-semibold text-theme-text">{activeParticipantCount(participants, 'COUNTER')}</p>
                 </div>
                 <div className="bg-theme-surface px-4 py-3">
                   <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Requisitos</p>
                   <p className={`mt-1 text-sm font-semibold ${ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                     {ready ? 'Completos' : 'Pendientes'}
                   </p>
                 </div>
               </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-theme-border/70 bg-theme-text/[0.02] px-6 py-4">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={preparing}
                className="inline-flex h-9 items-center rounded-lg border border-theme-border bg-theme-surface px-4 text-sm font-semibold text-theme-text transition-colors hover:bg-theme-text/5"
              >
                Volver
              </button>
              <button
                type="button"
                onClick={handlePrepare}
                disabled={preparing}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
              >
                {preparing && <InventoryLoadingState compact label="" />}
                {preparing ? 'Preparando…' : 'Preparar sección'}
              </button>
            </div>
          </div>
        </div>
      )}

      {ready && (
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-theme-text-muted/70">
          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
          Requisitos verificados contra la configuración actual.
        </p>
      )}
    </section>
  )
}
