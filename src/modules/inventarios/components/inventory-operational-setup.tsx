'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Settings2, UserCog } from 'lucide-react'
import {
  assignInventoryCountingZone,
  addInventoryCountingZoneProgressive,
  cancelInventoryCountingZone,
  listInventorySessionScopes,
  type InventorySessionScopesResult,
} from '@/app/actions/inventarios/counting-zones'
import {
  listInventoryCampaignParticipants,
  type InventoryCampaignParticipant,
} from '@/app/actions/inventarios/campaigns'
import {
  getActiveCompanySessionSetup,
  type InventorySessionSetupResult,
} from '@/app/actions/inventarios/sessions'
import { InventoryZoneLocationPicker } from '@/modules/inventarios/components/inventory-zone-location-picker'
import { InventoryZoneAssignmentsList } from '@/modules/inventarios/components/inventory-zone-assignments-list'
import type { InventoryCampaignParticipantRole } from '@/app/actions/inventarios/campaigns'

interface InventoryOperationalSetupProps {
  companyId: string
  sessionId: string
  campaignId: string
  readOnly?: boolean
  canManageZones: boolean
}

interface ZoneAssigneeOption {
  participantId: string
  userId: string
  userName: string
  label: string
}

const ROLE_PRIORITY: Record<InventoryCampaignParticipantRole, number> = {
  ADMINISTRATOR: 1,
  SUPERVISOR: 2,
  MANAGER: 3,
  COUNTER: 4,
}

const ROLE_LABEL: Record<InventoryCampaignParticipantRole, string> = {
  ADMINISTRATOR: 'Administrador',
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Gerencia',
  COUNTER: 'Contador',
}

function buildZoneAssigneeOptions(participants: InventoryCampaignParticipant[]): ZoneAssigneeOption[] {
  const byUser = new Map<string, InventoryCampaignParticipant[]>()

  for (const participant of participants) {
    const current = byUser.get(participant.userId) ?? []
    current.push(participant)
    byUser.set(participant.userId, current)
  }

  return Array.from(byUser.values())
    .map(group => {
      const sorted = [...group].sort(
        (a, b) =>
          ROLE_PRIORITY[a.participantRole] - ROLE_PRIORITY[b.participantRole] ||
          (a.userName ?? a.email ?? '').localeCompare(b.userName ?? b.email ?? '')
      )
      // The operation contract accepts the campaign participant registered as COUNTER,
      // even when the label includes the user's other informative roles.
      const primary = group.find(item => item.participantRole === 'COUNTER') ?? sorted[0]
      const roles = Array.from(new Set(sorted.map(item => ROLE_LABEL[item.participantRole]))).join(' / ')
      const name = primary.userName ?? primary.email ?? 'Usuario'
      return {
        participantId: primary.participantId,
        userId: primary.userId,
        userName: name,
        label: `${name} · ${roles}`,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

function newOperationKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function percentOf(assigned: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((assigned / total) * 1000) / 10
}

export function InventoryOperationalSetup({
  companyId,
  sessionId,
  campaignId,
  readOnly,
  canManageZones,
}: InventoryOperationalSetupProps) {
  const router = useRouter()
  const [scopes, setScopes] = useState<InventorySessionScopesResult | null>(null)
  const [setup, setSetup] = useState<InventorySessionSetupResult | null>(null)
  const [assignees, setAssignees] = useState<ZoneAssigneeOption[]>([])
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(null)
  const [zoneName, setZoneName] = useState('')
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createKeyRef = useRef<string | null>(null)

  const editable = !readOnly && canManageZones

  const refresh = useCallback(async () => {
    const [scopesResult, setupResult] = await Promise.all([
      listInventorySessionScopes(companyId, sessionId),
      getActiveCompanySessionSetup(sessionId),
    ])
    if (scopesResult.error || !scopesResult.data) {
      setLoadError(scopesResult.error ?? 'No se pudo cargar el alcance de la sección de conteo.')
      return
    }
    setScopes(scopesResult.data)
    setSetup(setupResult.data ?? null)
    if (setupResult.data) {
      setZoneName(`Zona ${setupResult.data.zones.filter(zone => zone.is_enabled).length + 1}`)
    }
  }, [companyId, sessionId])

  useEffect(() => {
    let mounted = true
    void (async () => {
      const [scopesResult, setupResult, countersResult] = await Promise.all([
        listInventorySessionScopes(companyId, sessionId),
        getActiveCompanySessionSetup(sessionId),
        listInventoryCampaignParticipants(companyId, campaignId),
      ])
      if (!mounted) return
      if (scopesResult.error || !scopesResult.data) {
        setLoadError(scopesResult.error ?? 'No se pudo cargar el alcance de la sección de conteo.')
        setLoading(false)
        return
      }
      setScopes(scopesResult.data)
      setSetup(setupResult.data ?? null)
      const activeAssignees = (countersResult.data?.participants ?? []).filter(
        participant => participant.state === 'ACTIVE' && participant.userIsActive && participant.participantRole === 'COUNTER'
      )
      const assigneeOptions = buildZoneAssigneeOptions(activeAssignees)
      setAssignees(assigneeOptions)
      const sessionEligibleUserIds = new Set(
        (setupResult.data?.participants ?? [])
          .filter(participant => ['COUNTER', 'SUPERVISOR', 'ADMINISTRATOR', 'MANAGER'].includes(participant.functional_role))
          .map(participant => participant.user_id)
      )
      const matching = assigneeOptions.find(participant => sessionEligibleUserIds.has(participant.userId))
      setSelectedAssigneeId(matching?.participantId ?? assigneeOptions[0]?.participantId ?? null)
      setZoneName(prev => (prev === '' ? `Zona ${(setupResult.data?.zones ?? []).filter(zone => zone.is_enabled).length + 1}` : prev))
      setLoading(false)
    })()
    return () => {
      mounted = false
    }
  }, [companyId, sessionId, campaignId])

  const handleToggle = useCallback(
    (locationId: string) => {
      setSelectedLocationIds(prev =>
        prev.includes(locationId) ? prev.filter(id => id !== locationId) : [...prev, locationId]
      )
      setCreateError(null)
    },
    []
  )

  const handleToggleAll = useCallback(
    (locationIds: string[]) => {
      setSelectedLocationIds(prev => {
        const next = new Set(prev)
        for (const id of locationIds) next.add(id)
        return Array.from(next)
      })
      setCreateError(null)
    },
    []
  )

  const handleClear = useCallback(() => {
    setSelectedLocationIds([])
    setCreateError(null)
  }, [])

  const handleCreateZone = async () => {
    if (creating || !selectedAssigneeId || selectedLocationIds.length === 0) return
    const trimmed = zoneName.trim()
    if (trimmed.length === 0) {
      setCreateError('Escribe un nombre para la zona.')
      return
    }
    if (!createKeyRef.current) createKeyRef.current = newOperationKey()
    setCreating(true)
    setCreateError(null)
    const input = {
      companyId,
      campaignId,
      sessionId,
      campaignParticipantId: selectedAssigneeId,
      zoneName: trimmed,
      locationIds: selectedLocationIds,
      idempotencyKey: createKeyRef.current,
    }
    const result = setup?.session?.status === 'PREPARED' || setup?.session?.status === 'COUNTING'
      ? await addInventoryCountingZoneProgressive(input)
      : await assignInventoryCountingZone(input)
    setCreating(false)
    if (result.error) {
      setCreateError(result.error)
      return
    }
    createKeyRef.current = null
    setSelectedLocationIds([])
    window.dispatchEvent(new Event('inventarios:setup-updated'))
    await refresh()
    router.refresh()
  }

  const handleCancelZone = useCallback(
    async (zoneId: string, reason: string) => {
      const key = newOperationKey()
      const result = await cancelInventoryCountingZone({
        companyId,
        campaignId,
        sessionId,
        zoneId,
        reason,
        idempotencyKey: key,
      })
      if (result.error) return { error: result.error }
      window.dispatchEvent(new Event('inventarios:setup-updated'))
      await refresh()
      router.refresh()
      return { error: null }
    },
    [companyId, campaignId, sessionId, refresh, router]
  )

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-theme-border bg-theme-surface p-6 text-sm text-theme-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Cargando configuración operacional…
      </div>
    )
  }

  if (loadError || !scopes) {
    return (
      <div className="rounded-xl border border-theme-border bg-theme-surface p-6 text-sm text-red-600 dark:text-red-400">
        {loadError ?? 'No se pudo cargar la configuración operacional.'}
      </div>
    )
  }

  const total = scopes.total_locations
  const assigned = scopes.assigned_locations
  const pending = scopes.pending_locations
  const percent = percentOf(assigned, total)
  const fullyCovered = total > 0 && pending === 0
  const zones = (setup?.zones ?? []).filter(zone => zone.is_enabled)
  const canShowForm = editable && total > 0 && !fullyCovered

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-theme-text-muted">
          <Settings2 className="h-4 w-4" />
          <span className="font-semibold text-theme-text">Configuración operacional</span>
          {readOnly && (
            <span className="rounded bg-theme-text/5 px-1.5 py-0.5 text-[10px] font-medium text-theme-text-muted">
              Solo lectura
            </span>
          )}
        </div>
        <Link
          href={`/dashboard/inventarios/campanas/${campaignId}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-theme-accent hover:underline"
        >
          <UserCog className="h-3.5 w-3.5" />
          Gestionar equipo
        </Link>
      </div>

      <div className="rounded-xl border border-theme-border bg-theme-surface px-3 py-2 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-base font-bold text-theme-text">{percent.toFixed(1)}%</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-theme-text-muted">
            <span>
              <span className="font-semibold text-theme-text">{assigned}</span> asignadas
            </span>
            <span aria-hidden className="text-theme-text-muted/40">·</span>
            <span>
              <span className="font-semibold text-theme-text">{pending}</span> pendientes
            </span>
            <span aria-hidden className="text-theme-text-muted/40">·</span>
            <span>
              <span className="font-semibold text-theme-text">{total}</span> totales
            </span>
            <span aria-hidden className="text-theme-text-muted/40">·</span>
            <span>
              <span className="font-semibold text-theme-text">{zones.length}</span>{' '}
              zona{zones.length === 1 ? '' : 's'} creada{zones.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="h-1.5 min-w-[120px] flex-1 basis-40 overflow-hidden rounded-full bg-theme-text/10">
            <div
              className={`h-full rounded-full transition-all ${fullyCovered ? 'bg-emerald-500' : 'bg-theme-accent'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
        {fullyCovered ? (
          <p className="mt-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            Cobertura completa. Todas las ubicaciones de la sección pertenecen a una zona.
          </p>
        ) : total === 0 ? (
          <p className="mt-1 text-[11px] text-theme-text-muted">
            La sección de conteo no tiene ubicaciones en alcance para asignar.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        <div className={canShowForm ? 'lg:col-span-3' : 'lg:col-span-5'}>
          <div className="rounded-xl border border-theme-border bg-theme-surface p-2.5 shadow-sm">
            <InventoryZoneLocationPicker
              locations={scopes.locations}
              selectedIds={selectedLocationIds}
              onToggle={handleToggle}
              onToggleAll={handleToggleAll}
              onClear={handleClear}
              disabled={!editable}
            />
          </div>
        </div>

        {canShowForm && (
          <div className="lg:col-span-2">
            <div className="rounded-xl border border-theme-border bg-theme-surface p-2.5 shadow-sm">
              <h3 className="mb-2.5 text-sm font-semibold text-theme-text">Crear zona y asignar responsable</h3>

              {assignees.length === 0 && (
                <p className="mb-3 rounded-lg border border-amber-500/15 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  El inventario no tiene participantes activos asignables. Agrega participantes en &ldquo;Gestionar equipo&rdquo;
                  para poder crear zonas.
                </p>
              )}

              <label className="mb-1 block text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">
                Responsable de la zona
              </label>
              <select
                value={selectedAssigneeId ?? ''}
                onChange={event => setSelectedAssigneeId(event.target.value || null)}
                disabled={assignees.length === 0}
                className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent disabled:opacity-40"
              >
                {assignees.length === 0 && <option value="">No hay participantes activos asignables</option>}
                {assignees.map(assignee => (
                  <option key={assignee.participantId} value={assignee.participantId}>
                    {assignee.label}
                  </option>
                ))}
              </select>

              <label className="mt-3 mb-1 block text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">
                Nombre de la zona
              </label>
              <input
                value={zoneName}
                onChange={event => setZoneName(event.target.value)}
                maxLength={200}
                className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-border-accent"
              />

              <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-theme-border/60 bg-theme-text/[0.02] px-3 py-2">
                <span className="text-xs text-theme-text-muted">
                  <span className="font-semibold text-theme-text">{selectedLocationIds.length}</span>{' '}
                  ubicacion{selectedLocationIds.length === 1 ? '' : 'es'} seleccionada
                  {selectedLocationIds.length === 1 ? '' : 's'}
                </span>
                {selectedLocationIds.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className="text-[11px] font-medium text-theme-text-muted hover:underline"
                  >
                    Limpiar
                  </button>
                )}
              </div>

              {createError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">{createError}</p>
              )}

              <button
                type="button"
                onClick={handleCreateZone}
                disabled={creating || assignees.length === 0 || selectedLocationIds.length === 0}
                className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {creating
                  ? 'Creando zona…'
                  : `Crear zona y asignar (${selectedLocationIds.length} ubicaciones)`}
              </button>
            </div>
          </div>
        )}
      </div>

      {editable && fullyCovered && total > 0 && (
        <p className="text-xs text-theme-text-muted">
          Para nuevas zonas, las ubicaciones deben estar pendientes de asignación.
        </p>
      )}

      <InventoryZoneAssignmentsList
        zones={zones}
        tasks={setup?.tasks ?? []}
        assigneeNames={Object.fromEntries(assignees.map(assignee => [assignee.userId, assignee.userName]))}
        canCancel={editable}
        onCancelZone={handleCancelZone}
      />
    </div>
  )
}
