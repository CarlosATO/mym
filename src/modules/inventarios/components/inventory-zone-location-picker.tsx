'use client'

import { useMemo } from 'react'
import { Check, MapPin, Package } from 'lucide-react'
import type { InventorySessionScopeLocation } from '@/app/actions/inventarios/counting-zones'

interface InventoryZoneLocationPickerProps {
  locations: InventorySessionScopeLocation[]
  selectedIds: string[]
  onToggle: (locationId: string) => void
  onToggleAll: (locationIds: string[]) => void
  onClear: () => void
  disabled?: boolean
}

interface LocationGroup {
  aisle: string | null
  locations: InventorySessionScopeLocation[]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function isPending(location: InventorySessionScopeLocation): boolean {
  return location.assigned_zone_id === null
}

function buildGroups(locations: InventorySessionScopeLocation[]): LocationGroup[] {
  const groupsObj: Record<string, LocationGroup> = {}
  for (const location of locations) {
    const key = location.aisle ?? ''
    if (!groupsObj[key]) groupsObj[key] = { aisle: location.aisle, locations: [] }
    groupsObj[key].locations.push(location)
  }
  return Object.values(groupsObj).sort((a, b) =>
    collator.compare(a.aisle ?? '', b.aisle ?? '')
  )
}

function tileState(location: InventorySessionScopeLocation, selected: boolean): string {
  if (!isPending(location)) {
    return 'border-sky-400/80 bg-sky-100/90 text-sky-800 dark:border-sky-600 dark:bg-sky-900/60 dark:text-sky-100'
  }
  if (selected) {
    return 'border-theme-accent bg-theme-accent/10 text-theme-text ring-2 ring-theme-accent shadow-sm z-10'
  }
  return 'border-theme-border bg-theme-surface text-theme-text-muted hover:border-theme-border-accent hover:bg-theme-text/5'
}

function LocationMiniTile({
  location,
  selected,
  disabled,
  onToggle,
}: {
  location: InventorySessionScopeLocation
  selected: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  const assigned = !isPending(location)
  return (
    <button
      type="button"
      disabled={disabled || assigned}
      onClick={onToggle}
      title={`${location.code}${location.name ? ` · ${location.name}` : ''}${assigned ? ` · ${location.assigned_zone_name ?? 'Asignada'}` : ''}`}
      className={`relative flex h-10 min-w-[72px] flex-col justify-between rounded-md border p-1 text-left transition-all select-none ${
        assigned ? 'cursor-default' : 'cursor-pointer'
      } ${tileState(location, selected)}`}
    >
      <div className="flex items-start justify-between gap-1">
        <span
          className={`font-mono text-[8px] leading-none font-bold tracking-tight break-all ${
            location.code.length > 14 ? 'text-[7px]' : ''
          }`}
        >
          {location.code}
        </span>
        {selected && !assigned && (
          <span className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-theme-accent">
            <Check className="h-2 w-2 text-white" />
          </span>
        )}
      </div>
      <div className="mt-auto flex items-end justify-between gap-1">
        {assigned ? (
          <span className="flex max-w-full items-center gap-0.5 rounded bg-sky-200/80 px-1 py-px text-[8px] leading-none font-bold text-sky-900 dark:bg-sky-700/80 dark:text-sky-50">
            <Package className="h-2 w-2 shrink-0" />
            <span className="truncate">{location.assigned_zone_name ?? 'Zona'}</span>
          </span>
        ) : (
          <span className="flex items-center gap-0.5 text-[8px] font-semibold text-theme-text-muted/70 leading-none">
            <MapPin className="h-2 w-2 shrink-0" />
            {location.position ?? '—'}
          </span>
        )}
      </div>
    </button>
  )
}

export function InventoryZoneLocationPicker({
  locations,
  selectedIds,
  onToggle,
  onToggleAll,
  onClear,
  disabled,
}: InventoryZoneLocationPickerProps) {
  const groups = useMemo(() => buildGroups(locations), [locations])
  const pendingLocations = useMemo(() => locations.filter(isPending), [locations])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectionOnlyPending = useMemo(
    () => selectedIds.every(id => pendingLocations.some(location => location.location_id === id)),
    [selectedIds, pendingLocations]
  )

  if (pendingLocations.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-theme-border bg-theme-surface/60 px-4 py-6 text-center text-xs text-theme-text-muted">
        {locations.length === 0
          ? 'La sección de conteo no tiene ubicaciones en alcance.'
          : 'Todas las ubicaciones de la sección de conteo ya pertenecen a una zona.'}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-theme-border/60 pb-1.5">
        <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">
          Mapa de ubicaciones
          <span className="ml-1.5 normal-case text-theme-text-muted">
            · {pendingLocations.length} pendientes
          </span>
          {selectedSet.size > 0 && (
            <span className="ml-1 normal-case text-theme-accent">· {selectedSet.size} seleccionadas</span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onToggleAll(pendingLocations.map(location => location.location_id))}
            disabled={disabled || selectedSet.size === pendingLocations.length}
            className="text-[11px] font-medium text-theme-accent hover:underline disabled:opacity-40"
          >
            Seleccionar todas
          </button>
          {selectedSet.size > 0 && (
            <button
              type="button"
              onClick={onClear}
              disabled={disabled}
              className="text-[11px] font-medium text-theme-text-muted hover:underline disabled:opacity-40"
            >
              Limpiar
            </button>
          )}
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto rounded-lg border border-theme-border bg-theme-surface/60">
        {groups.map(group => {
          const groupPending = group.locations.filter(isPending)
          const groupSelected = groupPending.filter(location => selectedSet.has(location.location_id))
          const groupAssigned = group.locations.length - groupPending.length
          const racksSet = new Set<string>()
          const levelsSet = new Set<string>()
          for (const location of group.locations) {
            if (location.rack) racksSet.add(location.rack)
            if (location.level) levelsSet.add(location.level)
          }
          const racks = Array.from(racksSet).sort((a, b) => collator.compare(a, b))
          const levels = Array.from(levelsSet).sort((a, b) => collator.compare(b, a))
          const hasLayout = racks.length > 0 && levels.length > 0
          return (
            <div key={group.aisle ?? 'general'} className="border-b border-theme-border/60 last:border-b-0">
              {!hasLayout ? (
                <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 bg-theme-text/[0.02] px-3 py-1.5">
                  <p className="flex items-center gap-2 text-xs font-bold text-theme-text">
                    {group.aisle ? `Pasillo ${group.aisle}` : 'Zona General'}
                    <span className="text-[10px] font-normal text-theme-text-muted">
                      · {group.locations.length} ubicaciones
                      {groupAssigned > 0 && ` · ${groupAssigned} asignadas`}
                    </span>
                  </p>
                  <div className="flex items-center gap-2">
                    {groupPending.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onToggleAll(groupPending.map(location => location.location_id))}
                        disabled={disabled || groupSelected.length === groupPending.length}
                        className="text-[10px] font-medium text-theme-accent hover:underline disabled:opacity-40"
                      >
                        Seleccionar pasillo
                      </button>
                    )}
                    <span className="text-[10px] text-theme-text-muted">
                      {groupPending.length === 0
                        ? 'completo'
                        : `${groupSelected.length}/${groupPending.length} seleccionadas`}
                    </span>
                  </div>
                </div>
              ) : null}

              {!hasLayout ? (
                <div className="flex flex-wrap gap-1.5 p-2">
                  {group.locations.map(location => (
                    <LocationMiniTile
                      key={location.location_id}
                      location={location}
                      selected={selectionOnlyPending && selectedSet.has(location.location_id)}
                      disabled={disabled}
                      onToggle={() => onToggle(location.location_id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto p-1.5">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className="p-1 pr-2 border-b-2 border-theme-border/60 text-left whitespace-nowrap">
                          <span className="text-[10px] font-bold text-theme-text">
                            {group.aisle ? `Pasillo ${group.aisle}` : 'Zona General'}
                          </span>
                          <span className="ml-1 text-[10px] font-normal text-theme-text-muted">
                            · {group.locations.length} ubicaciones · {groupAssigned} asignadas
                          </span>
                          {groupPending.length > 0 ? (
                            <>
                              <button
                                type="button"
                                onClick={() => onToggleAll(groupPending.map(location => location.location_id))}
                                disabled={disabled || groupSelected.length === groupPending.length}
                                className="ml-2 text-[10px] font-medium text-theme-accent hover:underline disabled:opacity-40"
                              >
                                Seleccionar pasillo
                              </button>
                              <span className="ml-1 text-[10px] text-theme-text-muted">
                                {groupSelected.length}/{groupPending.length} sel.
                              </span>
                            </>
                          ) : (
                            <span className="ml-1 text-[10px] text-theme-text-muted">· completo</span>
                          )}
                        </th>
                        {racks.map(rack => (
                          <th
                            key={rack}
                            className="p-1 border-b-2 border-theme-border/60 text-center text-[10px] font-bold whitespace-nowrap min-w-[82px] text-theme-text-muted"
                          >
                            Rack {rack}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-theme-border/20">
                      {levels.map(level => (
                        <tr key={level}>
                          <td className="p-1 pr-2 text-right text-[10px] font-bold whitespace-nowrap align-middle border-r border-theme-border/40 text-theme-text-muted">
                            Nivel {level}
                          </td>
                          {racks.map(rack => {
                            const cellLocations = group.locations
                              .filter(location => location.rack === rack && location.level === level)
                              .sort((a, b) => collator.compare(a.position ?? '', b.position ?? ''))
                            return (
                              <td key={rack} className="p-1 align-top border-x border-theme-border/20">
                                <div className="flex flex-wrap gap-1 justify-center">
                                  {cellLocations.length === 0 ? (
                                    <div className="h-10 w-full flex items-center justify-center text-[9px] italic text-theme-text-muted/40 rounded-md border border-dashed border-theme-border/20 bg-theme-text/[0.01]">
                                      Vacío
                                    </div>
                                  ) : (
                                    cellLocations.map(location => (
                                      <LocationMiniTile
                                        key={location.location_id}
                                        location={location}
                                        selected={selectionOnlyPending && selectedSet.has(location.location_id)}
                                        disabled={disabled}
                                        onToggle={() => onToggle(location.location_id)}
                                      />
                                    ))
                                  )}
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
