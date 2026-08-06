'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ClipboardList, X } from 'lucide-react'
import type { InventoryParticipant, InventorySessionDetail, InventorySessionSetupResult, InventorySessionTask, InventorySessionZone } from '@/app/actions/inventarios/sessions'
import { getActiveCompanyPrepareSetup, prepareInventorySession } from '@/app/actions/inventarios/sessions'
import { clearWizardDraft } from '@/modules/inventarios/lib/wizard'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

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
}): PrepareRequirement[] {
  const { session, snapshot, participants, zones, product_scope } = input
  const activeZones = (zones ?? []).filter(zone => zone.is_enabled)
  const snapshotPending = !snapshot || snapshot.completion_status === 'PENDING'
  const partialOk = session.scope_mode !== 'PARTIAL' || (product_scope?.length ?? 0) > 0
  const hasOperationalResponsible =
    activeParticipantCount(participants, 'ADMINISTRATOR') > 0 ||
    activeParticipantCount(participants, 'SUPERVISOR') > 0 ||
    activeParticipantCount(participants, 'MANAGER') > 0
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
      key: 'coverage',
      label: 'Cobertura del alcance completa',
      status: 'deferred',
    },
    {
      key: 'tasks',
      label: 'Tareas asignadas con responsable activo',
      status: 'deferred',
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
  const [loading, setLoading] = useState(true)
  const [preparing, setPreparing] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idempotencyRef = useRef<string | null>(null)

  useEffect(() => {
    let mounted = true
    getActiveCompanyPrepareSetup(sessionId).then(result => {
      if (!mounted) return
      if (result.data) setSetup(result.data)
      setLoading(false)
    })
    return () => {
      mounted = false
    }
  }, [sessionId])

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
  const requirements = buildPrepareRequirements({ session, snapshot, participants, zones, tasks, product_scope })
  const missing = requirements.filter(requirement => requirement.status === 'missing')
  const deferred = requirements.filter(requirement => requirement.status === 'deferred')
  const ready = missing.length === 0

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
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Preparar sección de conteo</h3>
            <p className="mt-2 text-sm text-theme-text-muted">
              Al preparar la sección se congelará su configuración operacional y quedará lista para iniciar el
              conteo. Las zonas y ubicaciones ya no podrán modificarse.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-theme-border/60 bg-theme-text/[0.02] p-3 text-xs">
              <div>
                <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Sección de conteo</p>
                <p className="truncate font-medium text-theme-text">{setup.session.name}</p>
              </div>
              <div>
                <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Zonas creadas</p>
                <p className="font-medium text-theme-text">{setup.indicators.zone_count}</p>
              </div>
              <div>
                <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Ubicaciones asignadas</p>
                <p className="font-medium text-theme-text">{setup.indicators.location_count}</p>
              </div>
              <div>
                <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Tareas</p>
                <p className="font-medium text-theme-text">{setup.indicators.task_count}</p>
              </div>
              <div>
                <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Tomadores asignados</p>
                <p className="font-medium text-theme-text">{activeParticipantCount(participants, 'COUNTER')}</p>
              </div>
              <div>
                <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Requisitos</p>
                <p className="font-medium text-emerald-700 dark:text-emerald-300">
                  {ready ? 'Completos' : 'Pendientes'}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={preparing}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5"
              >
                Volver
              </button>
              <button
                type="button"
                onClick={handlePrepare}
                disabled={preparing}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
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
