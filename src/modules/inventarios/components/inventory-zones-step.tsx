'use client'
import { useEffect, useState } from 'react'
import { Check, MapPin, Plus, Trash2, X } from 'lucide-react'
import type { CatalogUserOption, InventorySessionZone, OfficeOption, WarehouseOption } from '@/app/actions/inventarios/sessions'
import type { SessionZonesSetupResult } from '@/app/actions/inventarios/zones'
import {
  addZoneLocation,
  createSessionZone,
  deleteSessionZone,
  getActiveCompanyZonesSetup,
  removeZoneLocation,
} from '@/app/actions/inventarios/zones'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'
interface ZoneCatalogs {
  warehouses: WarehouseOption[]
  offices: OfficeOption[]
  users: CatalogUserOption[]
  locations: Array<{ id: string; warehouse_id: string; code: string; name: string | null }>
}

interface ZonesStepProps {
  companyId: string
  sessionId: string
  sessionWarehouseId: string
  catalogs: ZoneCatalogs
  onReadyChange?: (ready: boolean) => void
}

export function InventoryZonesStep({ companyId, sessionId, sessionWarehouseId, catalogs, onReadyChange }: ZonesStepProps) {

  const [setup, setSetup] = useState<SessionZonesSetupResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // formulario nueva zona
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  // asignación de ubicación por zona
  const [assignZoneId, setAssignZoneId] = useState<string | null>(null)
  const [locationSearch, setLocationSearch] = useState('')
  const refresh = async () => {
    const result = await getActiveCompanyZonesSetup(sessionId)
    if (result.data) setSetup(result.data)
    setLoading(false)
  }
  useEffect(() => {
    getActiveCompanyZonesSetup(sessionId).then(result => {
      if (result.data) setSetup(result.data)
      setLoading(false)
    })
  }, [sessionId])
  const zones = (setup?.zones ?? []).filter(z => z.is_enabled)
  const assignedLocationIds = new Set<string>()
  for (const zone of setup?.zones ?? []) {
    for (const loc of zone.locations ?? []) assignedLocationIds.add(loc.location_id)
  }
  const eligibleLocations = catalogs.locations.filter(loc => loc.warehouse_id === sessionWarehouseId && !assignedLocationIds.has(loc.id))
  const ready = zones.length > 0 && zones.every(zone => (zone.locations?.length ?? 0) > 0) && zones.length === (setup?.zones ?? []).filter(z => z.is_enabled).length
  useEffect(() => {
    onReadyChange?.(ready)
  }, [ready, onReadyChange])
  const createZone = async () => {
    if (!newName.trim() || busy) return
    const code = newCode.trim() || newName.trim().toUpperCase().slice(0, 10)
    setBusy(true)
    setError(null)
    const result = await createSessionZone(companyId, sessionId, {
      zone_code: code,
      scan_code: code,
      display_name: newName.trim(),
      priority: zones.length,
    })
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setNewName('')
    setNewCode('')
    await refresh()
  }

  const addLocation = async (zoneId: string, locationId: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await addZoneLocation(companyId, sessionId, zoneId, locationId)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setAssignZoneId(null)
    setLocationSearch('')
    await refresh()
  }

  const removeLocation = async (zoneId: string, locationId: string, locationName: string) => {
    if (!window.confirm(`¿Quitar la ubicación "${locationName}" de esta zona?`)) return
    setBusy(true)
    setError(null)
    const result = await removeZoneLocation(companyId, sessionId, zoneId, locationId)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    await refresh()
  }

  const removeZone = async (zone: InventorySessionZone) => {
    if (!window.confirm(`¿Eliminar la zona "${zone.display_name}"? Esta acción no se puede deshacer.`)) return
    setBusy(true)
    setError(null)
    const result = await deleteSessionZone(companyId, sessionId, zone.id)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return
    }
    await refresh()
  }

  const filteredAssignable = eligibleLocations.filter(loc => {
    const q = locationSearch.toLowerCase()
    return (loc.code.toLowerCase().includes(q) || (loc.name ?? '').toLowerCase().includes(q))
  })
  if (loading) {
    return <InventoryLoadingState label="Cargando zonas y ubicaciones…" />
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-theme-text-muted">
        Organiza la sección de conteo en zonas y asigna las ubicaciones de la bodega. Cada ubicación puede pertenecer a una sola zona.
      </p>
      <div className="rounded-lg border border-theme-border bg-theme-text/2 p-3">
        <p className="mb-2 text-xs font-semibold text-theme-text-muted uppercase tracking-wider">Requisitos para continuar</p>
        <ul className="space-y-1 text-sm">
          {[
            { met: zones.length > 0, label: `Al menos 1 zona (actual: ${zones.length})` },
            { met: zones.every(z => (z.locations?.length ?? 0) > 0), label: 'Cada zona con al menos 1 ubicación' },
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
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="Nombre de la zona (ej: Zona A)"
          aria-label="Nombre de la zona"
          className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
        />
        <input
          value={newCode}
          onChange={e => setNewCode(e.target.value)}
          placeholder="Código (opcional)"
          aria-label="Código de la zona"
          className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
        />
        <button
          type="button"
          onClick={createZone}
          disabled={!newName.trim() || busy}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
          Agregar zona
        </button>
      </div>
      {busy && <InventoryLoadingState compact label="Guardando cambios…" />}
      {zones.length === 0 ? (
        <p className="text-sm text-theme-text-muted">Aún no hay zonas. Crea la primera para comenzar.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {zones.map(zone => (
            <div key={zone.id} className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-theme-text">{zone.display_name}</p>
                  <p className="font-mono text-xs text-theme-text-muted">{zone.zone_code}</p>
                </div>
                <button
                  type="button"
                  onClick={() => removeZone(zone)}
                  disabled={busy || (zone.locations?.length ?? 0) > 0}
                  aria-label={`Eliminar zona ${zone.display_name}`}
                  title={(zone.locations?.length ?? 0) > 0 ? 'Retira las ubicaciones antes de eliminar la zona' : 'Eliminar zona'}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border text-theme-text-muted transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mb-1.5 text-xs text-theme-text-muted">
                {zone.locations?.length ?? 0} ubicación(es)
              </p>
              {zone.locations && zone.locations.length > 0 ? (
                <ul className="mb-2 space-y-1">
                  {zone.locations.map(location => (
                    <li key={location.location_id} className="flex items-center justify-between gap-2 rounded-lg border border-theme-border/50 px-2 py-1.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <MapPin className="h-3 w-3 shrink-0 text-theme-text-muted/50" />
                        <span className="truncate text-xs text-theme-text">{location.name ?? location.code}</span>
                        <span className="font-mono text-[10px] text-theme-text-muted">{location.code}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => removeLocation(zone.id, location.location_id, location.name ?? location.code)}
                        disabled={busy}
                        aria-label={`Quitar ubicación ${location.name ?? location.code}`}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-theme-border text-theme-text-muted transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-30"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-2 text-xs text-theme-text-muted/60">Sin ubicaciones asignadas.</p>
              )}
                      {assignZoneId === zone.id ? (
                <div className="space-y-1.5">
                  <input
                    value={locationSearch}
                    onChange={e => setLocationSearch(e.target.value)}
                    placeholder="Buscar ubicación de la bodega"
                    aria-label="Buscar ubicación"
                    autoFocus
                    className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
                  />
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-theme-border">
                    {filteredAssignable.length === 0 ? (
                      <p className="px-2 py-2 text-xs text-theme-text-muted">
                        {eligibleLocations.length === 0 ? 'No hay más ubicaciones disponibles en esta bodega.' : 'Sin resultados.'}
                      </p>
                    ) : (
                      <ul className="divide-y divide-theme-border/40">
                        {filteredAssignable.map(location => (
                          <li key={location.id}>
                            <button
                              type="button"
                              onClick={() => addLocation(zone.id, location.id)}
                              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-theme-text/5"
                            >
                              <span className="truncate text-theme-text">{location.name ?? location.code}</span>
                              <span className="shrink-0 font-mono text-[10px] text-theme-text-muted">{location.code}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setAssignZoneId(zone.id); setLocationSearch('') }}
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Agregar ubicación
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
