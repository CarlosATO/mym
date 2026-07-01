'use client'

import React, { useState } from 'react'
import { WarehouseMapView } from './warehouse-map-view'
import { LayoutGrid, Map as MapIcon, ArrowLeft, Building2, MapPin, Package, AlertCircle, ArrowRight } from 'lucide-react'
import { type Warehouse } from '@/app/actions/adquisiciones/warehouses'
import { type WarehouseStats } from '@/app/actions/logistica/location-layouts'

interface WarehouseVisualOverviewProps {
  warehouses: Warehouse[]
  stats?: WarehouseStats[]
  onWarehouseSelect?: (id: string | null) => void
}

export function WarehouseVisualOverview({ warehouses, stats = [], onWarehouseSelect }: WarehouseVisualOverviewProps) {
  const [selectedWarehouse, setSelectedWarehouse] = useState<Warehouse | null>(null)

  const statsByWarehouseId = new Map(stats.map(s => [s.warehouse_id, s]))

  const handleSelect = (w: Warehouse | null) => {
    setSelectedWarehouse(w)
    if (onWarehouseSelect) onWarehouseSelect(w?.id || null)
  }

  if (selectedWarehouse) {
    return (
      <div className="flex flex-col flex-1 h-full w-full animate-in fade-in duration-300">
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
        <WarehouseMapView warehouseId={selectedWarehouse.id} warehouseName={selectedWarehouse.name} />
      </div>
    )
  }

  // Global Stats
  const totalBodegas = warehouses.length
  const activas = warehouses.filter(w => w.is_active).length
  const totalUbicaciones = stats.reduce((acc, s) => acc + (s.total_locations || 0), 0)
  const conStock = stats.reduce((acc, s) => acc + (s.locations_with_stock || 0), 0)
  const sinUbicaciones = warehouses.filter(w => (statsByWarehouseId.get(w.id)?.total_locations || 0) === 0).length

  // Sort logically by name
  const sortedWarehouses = [...warehouses].sort((a, b) => 
    new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare(a.name, b.name)
  )

  return (
    <div className="h-full overflow-y-auto flex flex-col bg-theme-text/[0.01]">
      {/* Global Summary Bar */}
      <div className="shrink-0 bg-theme-surface border-b border-theme-border px-6 py-4 flex flex-wrap items-center gap-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-theme-accent/10 text-theme-accent rounded-lg">
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <p className="text-[10px] uppercase font-bold text-theme-text-muted">Total Bodegas</p>
            <p className="text-lg font-black leading-none text-theme-text">{totalBodegas}</p>
          </div>
        </div>
        <div className="w-px h-8 bg-theme-border hidden sm:block" />
        <div className="flex items-center gap-3">
          <div>
            <p className="text-[10px] uppercase font-bold text-theme-text-muted">Activas</p>
            <p className="text-lg font-black leading-none text-emerald-600 dark:text-emerald-400">{activas}</p>
          </div>
        </div>
        <div className="w-px h-8 bg-theme-border hidden sm:block" />
        <div className="flex items-center gap-3">
          <div>
            <p className="text-[10px] uppercase font-bold text-theme-text-muted">Ubicaciones</p>
            <p className="text-lg font-black leading-none text-theme-text">{totalUbicaciones}</p>
          </div>
        </div>
        <div className="w-px h-8 bg-theme-border hidden sm:block" />
        <div className="flex items-center gap-3">
          <div>
            <p className="text-[10px] uppercase font-bold text-theme-text-muted">Con Stock</p>
            <p className="text-lg font-black leading-none text-blue-600 dark:text-blue-400">{conStock}</p>
          </div>
        </div>
        {sinUbicaciones > 0 && (
          <>
            <div className="w-px h-8 bg-theme-border hidden sm:block" />
            <div className="flex items-center gap-3">
              <div className="p-1.5 bg-amber-500/10 text-amber-600 rounded-md">
                <AlertCircle className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-theme-text-muted">Sin Ubicaciones</p>
                <p className="text-sm font-black leading-none text-amber-600">{sinUbicaciones}</p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Warehouses Grid */}
      <div className="flex-1 p-6 md:p-8">
        <div className="max-w-[1600px] mx-auto">
          {/* TODO: Preparar para futura tabla logistica.warehouse_layouts (Drag & Drop de bodegas) */}
          <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-10 animate-in fade-in duration-300">
            {sortedWarehouses.map(w => {
              const wStats = statsByWarehouseId.get(w.id)
              const totalLocs = wStats?.total_locations || 0
              const withStock = wStats?.locations_with_stock || 0
              const emptyLocs = totalLocs - withStock
              const aisles = wStats?.total_aisles || 0

              return (
                <div key={w.id} className="group relative flex flex-col cursor-pointer" onClick={() => handleSelect(w)} onDoubleClick={() => handleSelect(w)}>
                  
                  {/* Warehouse Roof */}
                  <div className="w-full flex justify-center">
                    <div 
                      className="w-[90%] h-8 bg-theme-surface border-t-2 border-x-2 border-theme-border/80 group-hover:border-theme-accent/70 transition-colors relative overflow-hidden"
                      style={{ clipPath: 'polygon(15% 0%, 85% 0%, 100% 100%, 0% 100%)' }}
                    >
                      <div className="absolute inset-0 bg-gradient-to-b from-theme-text/[0.03] to-transparent"></div>
                    </div>
                  </div>

                  {/* Warehouse Body */}
                  <div className="bg-theme-surface border-2 border-theme-border/80 rounded-lg shadow-sm group-hover:shadow-md group-hover:border-theme-accent/70 transition-all flex flex-col relative z-10 min-h-[220px] overflow-hidden">
                    
                    {/* Subtle Loading Dock Door Background */}
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-24 h-16 border-t-2 border-x-2 border-theme-border/30 rounded-t-lg bg-theme-text/[0.01] flex flex-col justify-end pointer-events-none">
                      <div className="w-full h-1 border-b border-theme-border/20"></div>
                      <div className="w-full h-1 border-b border-theme-border/20 mt-1"></div>
                      <div className="w-full h-1 border-b border-theme-border/20 mt-1"></div>
                    </div>

                    <div className="p-5 flex-1 flex flex-col z-10">
                      {/* Header */}
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex flex-col">
                          <h3 className="text-base font-black text-theme-text uppercase tracking-tight group-hover:text-theme-accent transition-colors line-clamp-2 leading-tight">
                            {w.name}
                          </h3>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[10px] font-bold text-theme-text-muted bg-theme-text/5 px-1.5 py-0.5 rounded">
                              {w.code}
                            </span>
                            <span className="text-[10px] font-bold text-theme-text-muted bg-theme-text/5 px-1.5 py-0.5 rounded">
                              {w.warehouse_type}
                            </span>
                          </div>
                        </div>
                        <div className="shrink-0 ml-2">
                          {w.is_active ? (
                            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" title="Activa" />
                          ) : (
                            <div className="w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" title="Inactiva" />
                          )}
                        </div>
                      </div>

                      {/* Stats Grid */}
                      <div className="grid grid-cols-2 gap-3 mt-auto bg-theme-text/[0.02] p-3 rounded-lg border border-theme-border/50 backdrop-blur-sm">
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold uppercase text-theme-text-muted mb-0.5">Pasillos</span>
                          <span className="text-sm font-black text-theme-text">{aisles}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold uppercase text-theme-text-muted mb-0.5">Ubicaciones</span>
                          <span className="text-sm font-black text-theme-text">{totalLocs}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold uppercase text-emerald-600/70 mb-0.5">Con Stock</span>
                          <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">{withStock}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold uppercase text-theme-text-muted mb-0.5">Vacías</span>
                          <span className="text-sm font-black text-theme-text">{emptyLocs}</span>
                        </div>
                      </div>

                      {/* Action Button */}
                      <div className="mt-4 pt-4 border-t border-theme-border/50">
                        <button 
                          className="w-full py-2 bg-theme-text/5 hover:bg-theme-accent hover:text-white text-theme-text text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
                        >
                          <MapIcon className="w-4 h-4" />
                          Abrir bodega
                          <ArrowRight className="w-4 h-4 opacity-50" />
                        </button>
                      </div>
                    </div>
                  </div>
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
    </div>
  )
}
