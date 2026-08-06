'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Settings2, UserCog } from 'lucide-react'
import {
  assignInventoryCountingZone,
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

interface InventoryOperationalSetupProps {
  companyId: string
  sessionId: string
  campaignId: string
  readOnly?: boolean
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
}: InventoryOperationalSetupProps) {
  const [scopes, setScopes] = useState<InventorySessionScopesResult | null>(null)
  const [setup, setSetup] = useState<InventorySessionSetupResult | null>(null)
  const [counters, setCounters] = useState<InventoryCampaignParticipant[]>([])
  const [selectedCounterId, setSelectedCounterId] = useState<string | null>(null)
  const [zoneName, setZoneName] = useState('')
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const createKeyRef = useRef<string | null>(null)

  const editable = !readOnly

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
      const activeCounters = (countersResult.data?.participants ?? []).filter(
        participant =>
          participant.participantRole === 'COUNTER' &&
          participant.state === 'ACTIVE' &&
          participant.userIsActive
      )
      setCounters(activeCounters)
      const sessionCounterUserIds = new Set(
        (setupResult.data?.participants ?? [])
          .filter(participant => participant.functional_role === 'COUNTER')
          .map(participant => participant.user_id)
      )
      const matching = activeCounters.find(participant => sessionCounterUserIds.has(participant.userId))
      setSelectedCounterId(matching?.participantId ?? activeCounters[0]?.participantId ?? null)
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
    if (creating || !selectedCounterId || selectedLocationIds.length === 0) return
    const trimmed = zoneName.trim()
    if (trimmed.length === 0) {
      setCreateError('Escribe un nombre para la zona.')
      return
    }
    if (!createKeyRef.current) createKeyRef.current = newOperationKey()
    setCreating(true)
    setCreateError(null)
    const result = await assignInventoryCountingZone({
      companyId,
      campaignId,
      sessionId,
      campaignParticipantId: selectedCounterId,
      zoneName: trimmed,
      locationIds: selectedLocationIds,
      idempotencyKey: createKeyRef.current,
    })
    setCreating(false)
    if (result.error) {
      setCreateError(result.error)
      return
    }
    createKeyRef.current = null
    setSelectedLocationIds([])
    await refresh()
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
      await refresh()
      return { error: null }
    },
    [companyId, campaignId, sessionId, refresh]
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
              <h3 className="mb-2.5 text-sm font-semibold text-theme-text">Crear zona y asignar</h3>

              {counters.length === 0 && (
                <p className="mb-3 rounded-lg border border-amber-500/15 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  El inventario no tiene contadores activos. Agrega un contador en &ldquo;Gestionar equipo&rdquo;
                  para poder crear zonas.
                </p>
              )}

              <label className="mb-1 block text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">
                Responsable de la zona (contador)
              </label>
              <select
                value={selectedCounterId ?? ''}
                onChange={event => setSelectedCounterId(event.target.value || null)}
                disabled={counters.length === 0}
                className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent disabled:opacity-40"
              >
                {counters.length === 0 && <option value="">No hay contadores activos en el inventario</option>}
                {counters.map(counter => (
                  <option key={counter.participantId} value={counter.participantId}>
                    {counter.userName ?? counter.email ?? 'Usuario'}
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
                disabled={creating || counters.length === 0 || selectedLocationIds.length === 0}
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
        canCancel={editable}
        onCancelZone={handleCancelZone}
      />
    </div>
  )
}
