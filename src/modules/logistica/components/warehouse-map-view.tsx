'use client'

import { useEffect, useState, useMemo } from 'react'
import { getWarehouseVisualData, type LocationWithLayout, type StockByLocation, type LocationLayout } from '@/app/actions/logistica/location-layouts'
import { LocationTile } from './location-tile'
import { LocationDetailPanel } from './location-detail-panel'
import { LocationForm } from './location-form'
import { LocationBulkForm } from './location-bulk-form'
import { AisleManagementModal } from './aisle-management-modal'
import { Maximize, ZoomIn, ZoomOut, RefreshCw, Save, Map as MapIcon, Package, MapPin, Plus, Sparkles, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

function WarehouseAisleTable({
  racks,
  levels,
  groupLocations,
  collator,
  panelMode,
  selectedLocation,
  highlightLocationId,
  onLocationSelect,
  onLocationDoubleClick
}: any) {
  const [hoveredRack, setHoveredRack] = useState<string | null>(null)
  const [hoveredLevel, setHoveredLevel] = useState<string | null>(null)

  return (
    <div className="overflow-x-auto p-4" onMouseLeave={() => { setHoveredRack(null); setHoveredLevel(null); }}>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="p-2 border-b-2 border-theme-border/60"></th>
            {racks.map((r: string) => (
              <th 
                key={r} 
                className={cn(
                  "p-2 border-b-2 font-bold text-center whitespace-nowrap min-w-[100px] text-xs transition-colors",
                  hoveredRack === r ? "bg-theme-text/5 text-theme-text border-theme-accent" : "bg-theme-text/[0.02] border-theme-border/60 text-theme-text-muted"
                )}
              >
                Rack {r}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-theme-border/20">
          {levels.map((l: string) => (
            <tr key={l}>
              <td 
                className={cn(
                  "p-2 font-bold text-right pr-4 whitespace-nowrap align-middle border-r text-xs transition-colors",
                  hoveredLevel === l ? "bg-theme-text/5 text-theme-text border-theme-accent" : "bg-theme-text/[0.015] border-theme-border/40 text-theme-text-muted"
                )}
              >
                Nivel {l}
              </td>
              {racks.map((r: string) => {
                const cellLocations = groupLocations.filter((loc: any) => loc.rack === r && loc.level === l)
                cellLocations.sort((a: any, b: any) => collator.compare(String(a.position || ''), String(b.position || '')))
                const isHovered = hoveredRack === r || hoveredLevel === l
                const isCross = hoveredRack === r && hoveredLevel === l
                return (
                  <td 
                    key={r} 
                    onMouseEnter={() => { setHoveredRack(r); setHoveredLevel(l); }}
                    className={cn(
                      "p-1.5 align-top border-x transition-colors",
                      isCross ? "bg-theme-text/10 border-theme-border/60" : isHovered ? "bg-theme-text/[0.03] border-theme-border/40" : "border-theme-border/20"
                    )}
                  >
                    <div className="flex flex-wrap gap-1.5 justify-center">
                      {cellLocations.length === 0 ? (
                        <div className="h-[52px] w-full flex items-center justify-center text-[10px] text-theme-text-muted/40 italic bg-theme-text/[0.01] rounded-md border border-theme-border/20 border-dashed">Vacío</div>
                      ) : (
                        cellLocations.map((loc: any) => (
                          <LocationTile
                            key={loc.id}
                            id={loc.id}
                            code={loc.code}
                            name={loc.name}
                            aisle={loc.aisle}
                            rack={loc.rack}
                            level={loc.level}
                            position={loc.position}
                            stockCount={loc.stockCount}
                            itemCount={loc.itemCount}
                            isIncomplete={loc.isIncomplete}
                            isActive={loc.is_active}
                            selected={panelMode === 'detail' && selectedLocation?.id === loc.id}
                            highlight={highlightLocationId === loc.id}
                            onClick={() => onLocationSelect(loc)}
                            onDoubleClick={() => onLocationDoubleClick(loc)}
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
  )
}

interface WarehouseMapViewProps {
  warehouseId: string
  warehouseName: string
}

export function WarehouseMapView({ warehouseId, warehouseName }: WarehouseMapViewProps) {
  const [locations, setLocations] = useState<LocationWithLayout[]>([])
  const [stock, setStock] = useState<StockByLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [panelMode, setPanelMode] = useState<'detail' | 'create' | 'edit' | 'bulk' | null>(null)
  const [selectedLocation, setSelectedLocation] = useState<any | null>(null)
  const [highlightLocationId, setHighlightLocationId] = useState<string | null>(null)
  const [managingAisle, setManagingAisle] = useState<string | null>(null)
  
  // Floor support
  const availableFloors = useMemo(() => {
    const floors = new Set<number>()
    locations.forEach(l => {
      if (l.layout) floors.add(l.layout.floor)
      else floors.add(1) // default
    })
    return Array.from(floors).sort((a, b) => a - b)
  }, [locations])
  
  const [activeFloor, setActiveFloor] = useState<number>(1)

  useEffect(() => {
    if (availableFloors.length > 0 && !availableFloors.includes(activeFloor)) {
      setActiveFloor(availableFloors[0])
    }
  }, [availableFloors, activeFloor])

  const load = async () => {
    setLoading(true)
    const data = await getWarehouseVisualData(warehouseId)
    
    console.log('[WMS UI] data recibida:', {
      warehouse: data?.warehouse?.name,
      locations: data?.locations?.length,
      layouts: data?.layouts?.length,
      stockRows: data?.stockByLocation?.length
    })

    if (!data) {
      setLoading(false)
      return
    }

    const { locations: locsRaw, layouts: laysRaw, stockByLocation: stkRaw } = data
    
    const layoutMap = new Map<string, LocationLayout>()
    if (laysRaw) {
      for (const lay of laysRaw) {
        layoutMap.set(lay.location_id, lay as LocationLayout)
      }
    }

    const locs: LocationWithLayout[] = (locsRaw || []).map((loc: any) => ({
      id: loc.id,
      code: loc.code,
      name: loc.name,
      aisle: loc.aisle,
      rack: loc.rack,
      level: loc.level,
      position: loc.position,
      description: loc.description,
      is_active: loc.is_active,
      layout: layoutMap.get(loc.id) || null
    }))

    setLocations(locs)
    setStock(stkRaw || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [warehouseId])

  // Group and sort locations
  const { groups, incomplete } = useMemo(() => {
    const usesAisles = locations.some(l => !!l.aisle)

    const groupsObj: Record<string, any[]> = {}
    const incompleteArr: any[] = []

    locations.forEach(loc => {
      const stockItems = stock.filter(s => s.location_id === loc.id)
      const stockCount = stockItems.reduce((acc, curr) => acc + curr.quantity, 0)
      const itemCount = new Set(stockItems.map(s => s.product_id)).size
      
      const locExt = { ...loc, stockCount, itemCount, isIncomplete: false }

      // Check if incomplete
      const isMissingAisleParts = usesAisles && (!loc.rack || !loc.level || !loc.position)
      const endsWithP = loc.code.endsWith('-P')
      const missingP = !loc.position && loc.code.toUpperCase().includes('P')
      
      // Additional safety check for malformed codes
      const isIncomplete = isMissingAisleParts || endsWithP || missingP

      locExt.isIncomplete = isIncomplete

      if (isIncomplete) {
        incompleteArr.push(locExt)
      } else {
        const groupName = loc.aisle ? `Pasillo ${loc.aisle}` : 'Zona General'
        if (!groupsObj[groupName]) groupsObj[groupName] = []
        groupsObj[groupName].push(locExt)
      }
    })

    // Sort inside groups by rack, level, position
    Object.values(groupsObj).forEach(group => {
      group.sort((a, b) => {
        if (a.rack !== b.rack) return String(a.rack || '').localeCompare(String(b.rack || ''))
        if (a.level !== b.level) return String(a.level || '').localeCompare(String(b.level || ''))
        return String(a.position || '').localeCompare(String(b.position || ''))
      })
    })
    
    incompleteArr.sort((a, b) => a.code.localeCompare(b.code))

    return { groups: groupsObj, incomplete: incompleteArr }
  }, [locations, stock])

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-theme-text/5 min-h-[400px]">
        <div className="w-8 h-8 border-4 border-theme-accent border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm font-semibold text-theme-text-muted">Cargando mapa de {warehouseName}...</p>
      </div>
    )
  }

  const totalLocations = locations.length
  const locationsWithStock = locations.filter(l => {
    const s = stock.filter(x => x.location_id === l.id)
    return s.reduce((acc, curr) => acc + curr.quantity, 0) > 0
  }).length
  const locationsEmpty = totalLocations - locationsWithStock

  return (
    <div className="flex-1 relative bg-theme-surface overflow-hidden flex flex-col">
      {/* Toolbar */}
      <div className="h-14 border-b border-theme-border flex items-center justify-between px-4 bg-theme-text/[0.015] shrink-0">
        <div className="flex items-center gap-6">
          <div>
            <h3 className="font-bold text-theme-text text-sm flex items-center gap-2">
              <MapPin className="w-4 h-4 text-theme-accent" />
              {warehouseName}
            </h3>
            <div className="flex items-center gap-3 mt-1 text-[10px] font-semibold">
              <span className="text-theme-text-muted">Total: <span className="text-theme-text">{totalLocations}</span></span>
              <span className="text-emerald-500/70">Con stock: <span className="text-emerald-500">{locationsWithStock}</span></span>
              <span className="text-theme-text-muted/60">Vacías: <span className="text-theme-text-muted">{locationsEmpty}</span></span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => { setSelectedLocation(null); setPanelMode('create'); }} className="px-3 py-1.5 rounded-lg bg-theme-text text-theme-surface hover:bg-theme-text/80 text-xs font-bold transition-colors flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Nueva
          </button>
          <button onClick={() => { setSelectedLocation(null); setPanelMode('bulk'); }} className="px-3 py-1.5 rounded-lg bg-theme-accent/10 text-theme-accent hover:bg-theme-accent/20 text-xs font-bold transition-colors flex items-center gap-1.5">
            <Sparkles className="w-4 h-4" /> Masivo
          </button>
          <div className="w-px h-6 bg-theme-border mx-1" />
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-theme-text/5 text-theme-text-muted transition-colors" title="Actualizar plano">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden min-w-0 relative">
        {locations.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center bg-theme-text/5 min-w-0">
            <MapIcon className="w-16 h-16 text-theme-text-muted/20 mb-4" />
            <h3 className="text-lg font-bold text-theme-text mb-2">Esta bodega no tiene ubicaciones creadas.</h3>
            <p className="text-sm text-theme-text-muted">Crea ubicaciones desde el mantenedor o selecciona otra bodega.</p>
          </div>
        ) : (
          <div className="flex-1 min-w-0 overflow-auto p-6 bg-[url('/grid.svg')] bg-center bg-repeat bg-[size:40px_40px] bg-theme-text/[0.02]">
            <div className="flex flex-col gap-6 max-w-[1400px] mx-auto">
              {Object.entries(groups).sort(([a], [b]) => new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare(a, b)).map(([groupName, groupLocations]) => (
                <div key={groupName} className="bg-theme-surface border border-theme-border rounded-lg shadow-sm overflow-hidden">
                  {/* TODO: Preparar para "Modo Ordenar Pasillos" (Drag & Drop de layout manual por pasillo) */}
                  <div className="bg-theme-text/5 px-4 py-3 border-b border-theme-border flex items-center justify-between">
                    <h4 className="text-sm font-bold text-theme-text flex items-center gap-2">
                      <MapIcon className="w-4 h-4 text-theme-accent" />
                      {groupName} <span className="text-xs text-theme-text-muted font-normal ml-1">· {groupLocations.length} ubicaciones</span>
                    </h4>
                    
                    <div className="flex items-center gap-3 text-[10px] font-semibold">
                      <span className="text-emerald-500">Con stock: <span className="text-emerald-600 dark:text-emerald-400">{groupLocations.filter(l => l.stockCount > 0).length}</span></span>
                      <span className="text-theme-text-muted">Vacías: <span className="text-theme-text">{groupLocations.filter(l => l.stockCount === 0).length}</span></span>
                      {groupLocations.filter(l => !l.is_active).length > 0 && (
                        <span className="text-red-500/70">Inactivas: {groupLocations.filter(l => !l.is_active).length}</span>
                      )}
                      {groupLocations[0]?.aisle && (
                        <button
                          onClick={() => setManagingAisle(groupLocations[0].aisle!)}
                          className="ml-2 p-1.5 rounded hover:bg-theme-text/10 text-theme-text-muted transition-colors"
                          title="Gestionar pasillo"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  {(() => {
                    const racksSet = new Set<string>()
                    const levelsSet = new Set<string>()
                    groupLocations.forEach(l => {
                      if (l.rack) racksSet.add(l.rack)
                      if (l.level) levelsSet.add(l.level)
                    })
                    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
                    const racks = Array.from(racksSet).sort((a, b) => collator.compare(a, b))
                    const levels = Array.from(levelsSet).sort((a, b) => collator.compare(b, a)) // Descending (top to bottom)

                    if (racks.length === 0 || levels.length === 0) {
                      return (
                        <div className="flex flex-wrap gap-3">
                          {groupLocations.map(loc => (
                            <LocationTile
                              key={loc.id}
                              id={loc.id}
                              code={loc.code}
                              name={loc.name}
                              aisle={loc.aisle}
                              rack={loc.rack}
                              level={loc.level}
                              position={loc.position}
                              stockCount={loc.stockCount}
                              itemCount={loc.itemCount}
                              isIncomplete={loc.isIncomplete}
                              isActive={loc.is_active}
                              selected={panelMode === 'detail' && selectedLocation?.id === loc.id}
                              highlight={highlightLocationId === loc.id}
                              onClick={() => { setSelectedLocation(loc); setPanelMode('detail'); }}
                              onDoubleClick={() => { setSelectedLocation(loc); setPanelMode('detail'); }}
                            />
                          ))}
                        </div>
                      )
                    }

                    return (
                      <WarehouseAisleTable 
                        racks={racks}
                        levels={levels}
                        groupLocations={groupLocations}
                        collator={collator}
                        panelMode={panelMode}
                        selectedLocation={selectedLocation}
                        highlightLocationId={highlightLocationId}
                        onLocationSelect={(loc: any) => { setSelectedLocation(loc); setPanelMode('detail'); }}
                        onLocationDoubleClick={(loc: any) => { setSelectedLocation(loc); setPanelMode('detail'); }}
                      />
                    )
                  })()}
                </div>
              ))}

              {incomplete.length > 0 && (
                <div className="bg-amber-50/50 dark:bg-amber-500/5 backdrop-blur-md border border-amber-200 dark:border-amber-500/20 rounded-xl p-5 shadow-sm">
                  <h4 className="text-sm font-bold text-amber-700 dark:text-amber-400 mb-4 border-b border-amber-200 dark:border-amber-500/20 pb-2 flex items-center gap-2">
                    Ubicaciones por revisar <span className="text-xs font-normal opacity-80">({incomplete.length} ubicaciones)</span>
                  </h4>
                  <div className="flex flex-wrap gap-3">
                    {incomplete.map(loc => (
                      <LocationTile
                        key={loc.id}
                        id={loc.id}
                        code={loc.code}
                        name={loc.name}
                        aisle={loc.aisle}
                        rack={loc.rack}
                        level={loc.level}
                        position={loc.position}
                        stockCount={loc.stockCount}
                        itemCount={loc.itemCount}
                        isIncomplete={loc.isIncomplete}
                        isActive={loc.is_active}
                        selected={panelMode === 'detail' && selectedLocation?.id === loc.id}
                        highlight={highlightLocationId === loc.id}
                        onClick={() => { setSelectedLocation(loc); setPanelMode('detail'); }}
                        onDoubleClick={() => { setSelectedLocation(loc); setPanelMode('detail'); }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {panelMode === 'detail' && selectedLocation && (
          <aside className="w-[420px] shrink-0 h-full border-l border-theme-border shadow-[-10px_0_30px_-15px_rgba(0,0,0,0.1)]">
            <LocationDetailPanel
              locationId={selectedLocation.id}
              locationCode={selectedLocation.code}
              isActive={selectedLocation.is_active}
              onClose={() => setPanelMode(null)}
              onEdit={() => setPanelMode('edit')}
              onStatusChange={async () => {
                await load();
                setHighlightLocationId(selectedLocation.id);
                setTimeout(() => setHighlightLocationId(null), 2000);
              }}
            />
          </aside>
        )}

        {panelMode === 'create' && (
          <aside className="w-[480px] shrink-0 h-full">
            <LocationForm 
              warehouseId={warehouseId} 
              warehouseName={warehouseName}
              onClose={() => setPanelMode(null)} 
              onSuccess={(id) => { 
                setPanelMode(null); 
                load(); 
                if (id) {
                  setHighlightLocationId(id);
                  setTimeout(() => setHighlightLocationId(null), 2000);
                }
              }} 
            />
          </aside>
        )}

        {panelMode === 'edit' && selectedLocation && (
          <aside className="w-[480px] shrink-0 h-full">
            <LocationForm 
              warehouseId={warehouseId} 
              warehouseName={warehouseName}
              editLoc={selectedLocation}
              onClose={() => setPanelMode('detail')} 
              onSuccess={(id) => { 
                setPanelMode('detail'); 
                load(); 
                if (id) {
                  setHighlightLocationId(id);
                  setTimeout(() => setHighlightLocationId(null), 2000);
                }
              }} 
            />
          </aside>
        )}

        {panelMode === 'bulk' && (
          <div className="absolute inset-0 z-50 bg-theme-surface animate-in fade-in duration-200">
            <LocationBulkForm 
              warehouseId={warehouseId} 
              onClose={() => setPanelMode(null)} 
              onSuccess={() => { setPanelMode(null); load(); }} 
            />
          </div>
        )}
      </div>

      {managingAisle && (
        <AisleManagementModal
          open={!!managingAisle}
          onOpenChange={(open) => {
            if (!open) setManagingAisle(null)
          }}
          warehouseId={warehouseId}
          aisle={managingAisle}
          onSuccess={() => {
            setManagingAisle(null)
            load()
          }}
        />
      )}
    </div>
  )
}
