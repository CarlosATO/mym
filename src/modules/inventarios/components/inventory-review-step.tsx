'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ClipboardList, Lock, X } from 'lucide-react'
import type { InventoryParticipant, InventorySessionSetupResult } from '@/app/actions/inventarios/sessions'
import { getActiveCompanyPrepareSetup, prepareInventorySession } from '@/app/actions/inventarios/sessions'
import { clearWizardDraft } from '@/modules/inventarios/lib/wizard'
import { inventoryTypeLabel } from '@/modules/inventarios/lib/states'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

interface ReviewStepProps {
  companyId: string
  sessionId: string
}

interface Requirement {
  key: string
  label: string
  met: boolean
  step?: number
}

function makeKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function useIdempotencyKey(): () => string {
  const ref = useRef<string | null>(null)
  return () => {
    if (!ref.current) ref.current = makeKey()
    return ref.current
  }
}

function participantCount(participants: InventoryParticipant[], role: string): number {
  return participants.filter(p => !p.revoked_at && p.functional_role === role).length
}

export function InventoryReviewStep({ companyId, sessionId }: ReviewStepProps) {
  const router = useRouter()
  const [setup, setSetup] = useState<InventorySessionSetupResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [preparing, setPreparing] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idempotencyRef = useIdempotencyKey()

  useEffect(() => {
    getActiveCompanyPrepareSetup(sessionId).then(result => {
      if (result.data) setSetup(result.data)
      setLoading(false)
    })
  }, [sessionId])

  if (loading || !setup || !setup.session) {
    return <InventoryLoadingState label="Cargando revisión de la jornada…" />
  }

  const { session, participants, zones, tasks, product_scope, indicators } = setup
  const activeZones = (zones ?? []).filter(z => z.is_enabled)
  const activeTasks = (tasks ?? []).filter(t => !t.cancelled_at)

  const requirements: Requirement[] = [
    { key: 'admin', label: 'Al menos 1 Administrador', met: participantCount(participants, 'ADMINISTRATOR') > 0, step: 3 },
    { key: 'counter', label: 'Al menos 1 Tomador', met: participantCount(participants, 'COUNTER') > 0, step: 3 },
    { key: 'supervisor', label: 'Al menos 1 Supervisor', met: participantCount(participants, 'SUPERVISOR') > 0, step: 3 },
    { key: 'manager', label: 'Al menos 1 Encargado', met: participantCount(participants, 'MANAGER') > 0, step: 3 },
    { key: 'zones', label: 'Al menos 1 zona activa', met: activeZones.length > 0, step: 4 },
    { key: 'zone_locations', label: 'Cada zona con al menos 1 ubicación', met: activeZones.every(z => (z.locations?.length ?? 0) > 0), step: 4 },
    { key: 'zone_tasks', label: 'Cada zona con al menos 1 tarea', met: activeZones.every(z => activeTasks.some(t => t.session_zone_id === z.id)), step: 5 },
    { key: 'tasks_assigned', label: 'Todas las tareas en estado Asignada', met: activeTasks.every(t => t.status === 'ASSIGNED'), step: 5 },
    { key: 'tasks_assignment', label: 'Toda tarea con asignación vigente', met: activeTasks.every(t => Boolean(t.assignment?.user_id)), step: 5 },
    { key: 'partial_products', label: 'Alcance parcial con al menos 1 producto', met: session.scope_mode !== 'PARTIAL' || (product_scope?.length ?? 0) > 0, step: 2 },
  ]

  const unmet = requirements.filter(r => !r.met)
  const ready = unmet.length === 0 && indicators.ready_to_prepare === true

  const handlePrepare = async () => {
    if (preparing) return
    setPreparing(true)
    setError(null)
    const key = idempotencyRef()
    const result = await prepareInventorySession(companyId, sessionId, key)
    setPreparing(false)
    setShowConfirm(false)
    if (result.error) {
      setError(result.error)
      return
    }
    clearWizardDraft()
    router.push(`/dashboard/inventarios/jornadas/${sessionId}?tab=operacion`)
  }

  const roles = [
    { role: 'ADMINISTRATOR', label: 'Administrador' },
    { role: 'COUNTER', label: 'Tomador' },
    { role: 'SUPERVISOR', label: 'Supervisor' },
    { role: 'MANAGER', label: 'Encargado' },
  ]

  const section = (title: string, step: number) => (
    <a
      href={`/dashboard/inventarios/jornadas/${sessionId}?tab=configuracion&step=${step}`}
      className="ml-auto shrink-0 rounded-lg border border-theme-border bg-theme-surface px-2 py-1 text-[10px] font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
    >
      Editar
    </a>
  )

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
        <p className="flex items-center gap-1.5 font-semibold">
          <Lock className="h-4 w-4" /> Configuración a punto de bloquearse
        </p>
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300/80">
          Al preparar la jornada, la configuración quedará congelada y no podrás editarla.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Datos generales */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-theme-text">Datos generales</h3>
          {section('Editar', 1)}
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Jornada</p>
            <p className="truncate font-medium text-theme-text">{session.name}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Tipo</p>
            <p className="font-medium text-theme-text">{inventoryTypeLabel(session.inventory_type)}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Alcance</p>
            <p className="font-medium text-theme-text">{session.scope_mode === 'PARTIAL' ? 'Parcial' : 'General'}</p>
          </div>
        </div>
        {session.scope_mode === 'PARTIAL' && (
          <p className="mt-2 text-xs text-theme-text-muted">
            Productos seleccionados: {product_scope?.length ?? 0}
          </p>
        )}
      </div>

      {/* Participantes */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-theme-text">Participantes</h3>
          {section('Editar', 3)}
        </div>
        <div className="flex flex-wrap gap-2">
          {roles.map(role => (
            <span key={role.role} className="inline-flex items-center gap-1.5 rounded-full border border-theme-border bg-theme-text/5 px-2.5 py-1 text-xs text-theme-text">
              {role.label}
              <span className="font-semibold">{participantCount(participants, role.role)}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Zonas y tareas */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-theme-text">Zonas y tareas</h3>
          <div className="flex items-center gap-2">
            {section('Editar zonas', 4)}
            {section('Editar tareas', 5)}
          </div>
        </div>
        <p className="text-xs text-theme-text-muted">
          Zonas activas: {activeZones.length} · Tareas activas: {activeTasks.length}
        </p>
        {activeZones.length > 0 && (
          <ul className="mt-2 space-y-1">
            {activeZones.map(zone => (
              <li key={zone.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-theme-text">{zone.display_name}</span>
                <span className="text-theme-text-muted">
                  {zone.locations?.length ?? 0} ubicación(es) ·{' '}
                  {activeTasks.some(t => t.session_zone_id === zone.id) ? 'tarea' : 'sin tarea'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Requisitos */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-theme-text">Requisitos de preparación</h3>
        <ul className="space-y-1.5">
          {requirements.map(req => (
            <li key={req.key} className={`flex items-center justify-between gap-2 text-sm ${req.met ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-400'}`}>
              <span className="flex items-center gap-2">
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${req.met ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-red-500/30 bg-red-500/10'}`}>
                  {req.met ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                </span>
                {req.label}
              </span>
              {!req.met && req.step && (
                <a
                  href={`/dashboard/inventarios/jornadas/${sessionId}?tab=configuracion&step=${req.step}`}
                  className="shrink-0 text-[10px] font-medium text-theme-accent underline"
                >
                  Ir al paso {req.step}
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Preparar */}
      <div className="flex flex-col items-start gap-3 rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-theme-text">
            {ready ? 'Configuración completa' : 'Configuración incompleta'}
          </p>
          <p className="text-xs text-theme-text-muted">
            {ready
              ? 'La jornada está lista para prepararse.'
              : `Faltan ${unmet.length} requisito(s) antes de preparar.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          disabled={!ready || preparing}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
        >
          {preparing ? <InventoryLoadingState compact label="Preparando…" /> : <ClipboardList className="h-4 w-4" />}
          {!preparing && 'Preparar jornada'}
        </button>
      </div>

      {/* Diálogo de confirmación */}
      {showConfirm && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Preparar jornada</h3>
            <p className="mt-2 text-sm text-theme-text-muted">
              Al preparar la jornada, la configuración quedará <strong>bloqueada</strong> y no podrás
              modificarla. La jornada quedará en estado <strong>Preparada</strong> y podrás abrirla después.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={preparing}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handlePrepare}
                disabled={preparing}
                className="inline-flex h-8 items-center rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
              >
                {preparing ? 'Preparando…' : 'Confirmar preparación'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
