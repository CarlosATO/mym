'use client'

import React, { useState } from 'react'
import { WarehouseMapView } from './warehouse-map-view'
import { LayoutGrid, Map as MapIcon, ArrowLeft, Building2, ArrowRight } from 'lucide-react'
import { type Warehouse } from '@/app/actions/adquisiciones/warehouses'
import { type WarehouseStats } from '@/app/actions/logistica/location-layouts'

interface WarehouseVisualOverviewProps {
  warehouses: Warehouse[]
  stats?: WarehouseStats[]
  onWarehouseSelect?: (id: string | null) => void
  onDataChange?: () => void
  permissions?: string[]
  canManageLayout?: boolean
}

export function WarehouseSummary({ warehouses, stats = [] }: { warehouses: Warehouse[]; stats?: WarehouseStats[] }) {
  const statsByWarehouseId = new Map(stats.map(s => [s.warehouse_id, s]))
  const totalLocations = stats.reduce((total, item) => total + (item.total_locations || 0), 0)
  const locationsWithStock = stats.reduce((total, item) => total + (item.locations_with_stock || 0), 0)
  const withoutLocations = warehouses.filter(warehouse => (statsByWarehouseId.get(warehouse.id)?.total_locations || 0) === 0).length

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-theme-border bg-theme-surface px-5 py-2.5">
      <Metric label="Total bodegas" value={warehouses.length} />
      <Metric label="Activas" value={warehouses.filter(warehouse => warehouse.is_active).length} valueClassName="text-emerald-600 dark:text-emerald-400" />
      <Metric label="Ubicaciones" value={totalLocations} />
      <Metric label="Con stock" value={locationsWithStock} valueClassName="text-theme-text-accent" />
      {withoutLocations > 0 && <Metric label="Sin ubicaciones" value={withoutLocations} valueClassName="text-amber-600" />}
    </div>
  )
}

function Metric({ label, value, valueClassName = 'text-theme-text' }: { label: string; value: number; valueClassName?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted/70">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${valueClassName}`}>{value}</span>
    </div>
  )
}

export function WarehouseVisualOverview({ warehouses, stats = [], onWarehouseSelect, onDataChange, permissions = [], canManageLayout = false }: WarehouseVisualOverviewProps) {
  const [selectedWarehouse, setSelectedWarehouse] = useState<Warehouse | null>(null)

  const statsByWarehouseId = new Map(stats.map(s => [s.warehouse_id, s]))

  const handleSelect = (w: Warehouse | null) => {
    setSelectedWarehouse(w)
    if (onWarehouseSelect) onWarehouseSelect(w?.id || null)
  }

  if (selectedWarehouse) {
    return (
      <div className="flex min-h-0 flex-col flex-1 h-full w-full animate-in fade-in duration-300">
        <div className="shrink-0 p-4 border-b border-theme-border bg-theme-surface flex items-center justify-between">
          <button 
            onClick={() => handleSelect(null)}
            className="flex items-center gap-2 text-sm font-bold text-theme-text-muted hover:text-theme-text transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Volver a lista de bodegas
          </button>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Building2 className="w-4 h-4 text-theme-accent" />
            <span className="text-theme-text">{selectedWarehouse.name}</span>
            <span className="text-theme-text-muted text-xs border border-theme-border px-1.5 rounded">{selectedWarehouse.code}</span>
          </div>
        </div>
         <WarehouseMapView warehouseId={selectedWarehouse.id} warehouseName={selectedWarehouse.name} warehouseActive={selectedWarehouse.is_active} onDataChange={onDataChange} permissions={permissions} canManageLayout={canManageLayout} />
      </div>
    )
  }

  // Sort logically by name
  const sortedWarehouses = [...warehouses].sort((a, b) => 
    new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare(a.name, b.name)
  )

  return (
    <div className="h-full overflow-y-auto bg-theme-text/[0.01]">
      <div className="max-w-[1600px]">
          {/* TODO: Preparar para futura tabla logistica.warehouse_layouts (Drag & Drop de bodegas) */}
            <div className="grid grid-cols-1 gap-3 animate-in fade-in duration-300 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sortedWarehouses.map(w => {
              const wStats = statsByWarehouseId.get(w.id)
              const totalLocs = wStats?.total_locations || 0
              const withStock = wStats?.locations_with_stock || 0
              const emptyLocs = totalLocs - withStock
              const aisles = wStats?.total_aisles || 0

              return (
                <div key={w.id} className="group flex cursor-pointer flex-col rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm transition-all hover:border-theme-accent/50 hover:shadow-md" onClick={() => handleSelect(w)} onDoubleClick={() => handleSelect(w)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold uppercase tracking-tight text-theme-text transition-colors group-hover:text-theme-accent" title={w.name}>{w.name}</h3>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="rounded-md bg-theme-text/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-theme-text-muted">{w.code}</span>
                        <span className="rounded-md bg-theme-text/5 px-1.5 py-0.5 text-[10px] font-semibold text-theme-text-muted">{w.warehouse_type}</span>
                      </div>
                    </div>
                    {w.is_active ? <span className="shrink-0 rounded-md border border-theme-accent/25 bg-theme-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-theme-text-accent">Activa</span> : <span className="shrink-0 rounded-md border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-500">Inactiva</span>}
                  </div>

                  <div className="mt-3 grid grid-cols-4 gap-2 border-y border-theme-border/70 py-2">
                    <CompactMetric label="Pasillos" value={aisles} />
                    <CompactMetric label="Ubic." value={totalLocs} />
                    <CompactMetric label="Stock" value={withStock} valueClassName="text-emerald-600 dark:text-emerald-400" />
                    <CompactMetric label="Vacías" value={emptyLocs} />
                  </div>

                  <button type="button" className="mt-2 inline-flex items-center justify-center gap-1 text-xs font-semibold text-theme-text-accent transition-colors hover:text-theme-accent-hover">
                    <MapIcon className="h-3.5 w-3.5" /> Abrir bodega <ArrowRight className="h-3.5 w-3.5 opacity-60" />
                  </button>
                </div>
              )
            })}

            {warehouses.length === 0 && (
              <div className="col-span-full py-16 text-center border-2 border-dashed border-theme-border rounded-xl bg-theme-surface">
                <LayoutGrid className="w-12 h-12 text-theme-text-muted/50 mx-auto mb-4" />
                <h3 className="text-lg font-bold text-theme-text mb-2">No hay bodegas configuradas</h3>
                <p className="text-sm text-theme-text-muted">Cree una bodega para acceder al WMS.</p>
              </div>
            )}
          </div>
      </div>
    </div>
  )
}

function CompactMetric({ label, value, valueClassName = 'text-theme-text' }: { label: string; value: number; valueClassName?: string }) {
  return (
    <div className="min-w-0">
      <span className="block truncate text-[9px] font-semibold uppercase tracking-wide text-theme-text-muted/70">{label}</span>
      <span className={`mt-0.5 block text-sm font-bold tabular-nums ${valueClassName}`}>{value}</span>
    </div>
  )
}
