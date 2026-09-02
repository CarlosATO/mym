'use client'

import { useEffect, useState } from 'react'
import { Check, Info, Lock, X } from 'lucide-react'
import type { InventorySessionSetupResult } from '@/app/actions/inventarios/sessions'
import { getActiveCompanyPrepareSetup } from '@/app/actions/inventarios/sessions'
import { inventoryTypeLabel } from '@/modules/inventarios/lib/states'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'
import {
  InventoryPrepareSection,
  activeParticipantCount,
  buildPrepareRequirements,
} from '@/modules/inventarios/components/inventory-prepare-section'

interface ReviewStepProps {
  companyId: string
  sessionId: string
}

const ROLES = [
  { role: 'ADMINISTRATOR', label: 'Administrador' },
  { role: 'COUNTER', label: 'Tomador' },
  { role: 'SUPERVISOR', label: 'Supervisor' },
  { role: 'MANAGER', label: 'Encargado' },
]

export function InventoryReviewStep({ companyId, sessionId }: ReviewStepProps) {
  const [setup, setSetup] = useState<InventorySessionSetupResult | null>(null)
  const [loading, setLoading] = useState(true)

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

  if (loading || !setup || !setup.session) {
    return <InventoryLoadingState label="Cargando revisión de la sección de conteo…" />
  }

  const { session, snapshot, participants, zones, tasks, product_scope } = setup
  const activeZones = (zones ?? []).filter(zone => zone.is_enabled)
  const activeTasks = (tasks ?? []).filter(task => !task.cancelled_at)
  const requirements = buildPrepareRequirements({ session, snapshot, participants, zones, tasks, product_scope })

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
          Al preparar la sección se congelará el snapshot y quedará lista para abrir. Las zonas nuevas no se agregan en este paso:
          mientras la sección esté en PREPARED o En conteo y existan ubicaciones pendientes, podrás crearlas y asignarlas desde Asignación de zonas.
        </p>
      </div>

      {/* Datos generales */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-theme-text">Datos generales</h3>
          {section('Editar', 1)}
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Sección de conteo</p>
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
          {ROLES.map(role => (
            <span key={role.role} className="inline-flex items-center gap-1.5 rounded-full border border-theme-border bg-theme-text/5 px-2.5 py-1 text-xs text-theme-text">
              {role.label}
              <span className="font-semibold">{activeParticipantCount(participants, role.role)}</span>
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
                  {activeTasks.some(task => task.session_zone_id === zone.id) ? 'tarea' : 'sin tarea'}
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
          {requirements.map(requirement => (
            <li
              key={requirement.key}
              className={`flex items-center justify-between gap-2 text-sm ${
                requirement.status === 'ok'
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : requirement.status === 'missing'
                    ? 'text-red-700 dark:text-red-400'
                    : 'text-theme-text-muted'
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    requirement.status === 'ok'
                      ? 'border-emerald-500/40 bg-emerald-500/10'
                      : requirement.status === 'missing'
                        ? 'border-red-500/30 bg-red-500/10'
                        : 'border-theme-border bg-theme-text/5'
                  }`}
                >
                  {requirement.status === 'ok' ? (
                    <Check className="h-3 w-3" />
                  ) : requirement.status === 'missing' ? (
                    <X className="h-3 w-3" />
                  ) : (
                    <Info className="h-3 w-3" />
                  )}
                </span>
                {requirement.label}
              </span>
              {requirement.status === 'missing' && requirement.step && (
                <a
                  href={`/dashboard/inventarios/jornadas/${sessionId}?tab=configuracion&step=${requirement.step}`}
                  className="shrink-0 text-[10px] font-medium text-theme-accent underline"
                >
                  Ir al paso {requirement.step}
                </a>
              )}
              {requirement.status === 'deferred' && (
                <span className="shrink-0 text-[10px] text-theme-text-muted/70">
                  Validación final al preparar
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <InventoryPrepareSection companyId={companyId} sessionId={sessionId} />
    </div>
  )
}
