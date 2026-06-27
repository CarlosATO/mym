'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getStockSummary, getKardexMovements, type StockItem, type KardexMovement } from '@/app/actions/logistica/recepciones'
import { Search, Package, MapPin, Layers, Coins, Box, LayoutGrid, X, FileText, ArrowDownToLine, ArrowUpFromLine, RefreshCw, ArrowRightLeft, Undo2, Eye, ArrowRight } from 'lucide-react'
import { erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'

const MOVEMENT_TYPE_BADGES: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  IN: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-600 dark:text-emerald-400', icon: <ArrowDownToLine className="w-3 h-3" /> },
  PURCHASE_RECEIPT: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-600 dark:text-emerald-400', icon: <ArrowDownToLine className="w-3 h-3" /> },
  OUT: { bg: 'bg-red-500/10 border-red-500/20', text: 'text-red-600 dark:text-red-400', icon: <ArrowUpFromLine className="w-3 h-3" /> },
  ADJUSTMENT: { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-600 dark:text-amber-400', icon: <RefreshCw className="w-3 h-3" /> },
  TRANSFER_IN: { bg: 'bg-blue-500/10 border-blue-500/20', text: 'text-blue-600 dark:text-blue-400', icon: <ArrowRightLeft className="w-3 h-3" /> },
  TRANSFER_OUT: { bg: 'bg-indigo-500/10 border-indigo-500/20', text: 'text-indigo-600 dark:text-indigo-400', icon: <ArrowRightLeft className="w-3 h-3" /> },
  RETURN: { bg: 'bg-purple-500/10 border-purple-500/20', text: 'text-purple-600 dark:text-purple-400', icon: <Undo2 className="w-3 h-3" /> },
}

function movementLabel(type: string) {
  const map: Record<string, string> = {
    IN: 'Entrada',
    PURCHASE_RECEIPT: 'Entrada',
    OUT: 'Salida',
    ADJUSTMENT: 'Ajuste',
    TRANSFER_IN: 'Traspaso in',
    TRANSFER_OUT: 'Traspaso out',
    RETURN: 'Devolución'
  }
  return map[type] || type
}

function Badge({ type }: { type: string }) {
  const s = MOVEMENT_TYPE_BADGES[type] || { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-500', icon: <Package className="w-3 h-3" /> }
  return (
    <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider", s.bg, s.text)}>
      {s.icon} <span className="truncate max-w-[80px]">{movementLabel(type)}</span>
    </span>
  )
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('es-CL', { 
    day: '2-digit', month: '2-digit', year: '2-digit', 
    hour: '2-digit', minute: '2-digit' 
  })
}

function formatCurrency(amount: number | null) {
  if (amount === null || isNaN(amount)) return 'Sin costo'
  return amount.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

export function StockPanel() {
  const [data, setData] = useState<StockItem[]>([])
  const [loading, setLoading] = useState(true)
  
  // Navigation State
  const [mode, setMode] = useState<'product' | 'warehouse'>('product')
  
  const handleViewKardex = (it: any) => {
    sessionStorage.setItem('mym_stock_to_kardex', JSON.stringify({
      productId: it.product_id,
      productSku: it.product_sku,
      productDesc: it.product_description,
      warehouseId: it.warehouse_id,
      warehouseName: it.warehouse_name,
      locationId: it.location_id,
      locationCode: it.location_code,
      lotNumber: it.lot_number,
      expirationDate: it.expiration_date
    }))
    window.location.assign('/dashboard/logistica?tab=consultas&action=kardex')
  }
  
  // Product Mode State
  const [productSearch, setProductSearch] = useState('')
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null)
  
  // Warehouse Mode State
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | null>(null)
  const [warehouseLocationFilter, setWarehouseLocationFilter] = useState('')
  const [warehouseSearch, setWarehouseSearch] = useState('')

  // Preview State
  const [selectedRowForPreview, setSelectedRowForPreview] = useState<StockItem | null>(null)
  const [previewMovements, setPreviewMovements] = useState<any[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const kardexCache = useRef<Map<string, KardexMovement[]>>(new Map())

  const load = useCallback(async () => {
    setLoading(true)
    const summary = await getStockSummary()
    setData(summary)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Load Preview Kardex
  useEffect(() => {
    if (!selectedRowForPreview) return
    const row = selectedRowForPreview
    const cacheKey = `${row.product_id}_${row.warehouse_id}_${row.location_id || 'null'}_${row.lot_number || 'null'}`
    
    let active = true
    const processMovements = (allMvs: KardexMovement[]) => {
      // Filtrar y calcular saldo solo para esta fila
      const filtered = allMvs.filter(m => {
        if (m.warehouse_id !== row.warehouse_id) return false
        
        const locMatch = (m.location_id || null) === (row.location_id || null)
        if (!locMatch) return false
        
        const lotMatch = (m.lot_number || null) === (row.lot_number || null)
        if (!lotMatch) return false
        
        return true
      })

      let currentBalance = 0
      const calculated = filtered.map(m => {
        const isPositive = ['IN', 'PURCHASE_RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT'].includes(m.movement_type)
        const isNegative = ['OUT', 'TRANSFER_OUT', 'RETURN'].includes(m.movement_type)
        
        let delta = Number(m.quantity)
        if (isNegative) delta = -delta
        if (delta < 0 && m.quantity < 0) delta = m.quantity
        else if (isNegative && m.quantity > 0) delta = -m.quantity
        else if (isPositive && m.quantity < 0) delta = m.quantity

        currentBalance += delta
        return {
          ...m,
          delta,
          saldo: currentBalance,
          isPositive: delta > 0,
          isNegative: delta < 0
        }
      })

      if (active) {
        setPreviewMovements(calculated.reverse().slice(0, 10))
        setPreviewLoading(false)
      }
    }

    setPreviewLoading(true)
    
    // Check Cache
    if (kardexCache.current.has(row.product_id)) {
      processMovements(kardexCache.current.get(row.product_id)!)
      return
    }

    // Fetch from server
    getKardexMovements(row.product_id).then(data => {
      if (!active) return
      kardexCache.current.set(row.product_id, data)
      processMovements(data)
    })

    return () => { active = false }
  }, [selectedRowForPreview])

  // ─── Data Grouping & Derivations ──────────────────────────────────────────

  // All unique products in stock
  const productGroups = useMemo(() => {
    const groups = new Map<string, { id: string, sku: string, description: string, totalQty: number, totalValue: number }>()
    for (const item of data) {
      const val = item.unit_cost ? item.quantity * item.unit_cost : 0
      const existing = groups.get(item.product_id)
      if (existing) {
        existing.totalQty += item.quantity
        existing.totalValue += val
      } else {
        groups.set(item.product_id, {
          id: item.product_id,
          sku: item.product_sku,
          description: item.product_description,
          totalQty: item.quantity,
          totalValue: val
        })
      }
    }
    return Array.from(groups.values())
  }, [data])

  // All unique warehouses in stock
  const warehouseGroups = useMemo(() => {
    const groups = new Map<string, { id: string, name: string, totalQty: number, totalValue: number, uniqueSkus: Set<string> }>()
    for (const item of data) {
      const val = item.unit_cost ? item.quantity * item.unit_cost : 0
      const existing = groups.get(item.warehouse_id)
      if (existing) {
        existing.totalQty += item.quantity
        existing.totalValue += val
        existing.uniqueSkus.add(item.product_id)
      } else {
        groups.set(item.warehouse_id, {
          id: item.warehouse_id,
          name: item.warehouse_name,
          totalQty: item.quantity,
          totalValue: val,
          uniqueSkus: new Set([item.product_id])
        })
      }
    }
    return Array.from(groups.values())
  }, [data])

  // Filtered Products for Search
  const filteredProducts = useMemo(() => {
    if (!productSearch.trim()) return productGroups
    const s = productSearch.toLowerCase()
    return productGroups.filter(p => p.sku.toLowerCase().includes(s) || p.description.toLowerCase().includes(s))
  }, [productGroups, productSearch])

  // Selected Product Details
  const selectedProductDetails = useMemo(() => {
    if (!selectedProductId) return null
    const items = data.filter(d => d.product_id === selectedProductId)
    const productInfo = productGroups.find(p => p.id === selectedProductId)
    if (!productInfo) return null
    
    const warehousesCount = new Set(items.map(i => i.warehouse_id)).size
    const lotsCount = new Set(items.map(i => i.lot_number).filter(Boolean)).size

    return { info: productInfo, items, warehousesCount, lotsCount }
  }, [data, selectedProductId, productGroups])

  // Selected Warehouse Details
  const selectedWarehouseDetails = useMemo(() => {
    if (!selectedWarehouseId) return null
    const whInfo = warehouseGroups.find(w => w.id === selectedWarehouseId)
    if (!whInfo) return null

    let items = data.filter(d => d.warehouse_id === selectedWarehouseId)
    const locationsCount = new Set(items.map(i => i.location_id).filter(Boolean)).size

    if (warehouseSearch.trim()) {
      const s = warehouseSearch.toLowerCase()
      items = items.filter(i => 
        i.product_sku.toLowerCase().includes(s) || 
        i.product_description.toLowerCase().includes(s) ||
        (i.lot_number && i.lot_number.toLowerCase().includes(s))
      )
    }

    if (warehouseLocationFilter.trim()) {
      const s = warehouseLocationFilter.toLowerCase()
      items = items.filter(i => i.location_code && i.location_code.toLowerCase().includes(s))
    }

    return { info: whInfo, items, locationsCount }
  }, [data, selectedWarehouseId, warehouseGroups, warehouseLocationFilter, warehouseSearch])

  // ─── Render View ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 bg-theme-surface">
        <div className="w-8 h-8 border-4 border-theme-accent border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm font-semibold text-theme-text-muted">Cargando inventario...</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-theme-surface overflow-hidden animate-in fade-in duration-300">
      
      {/* ── Tabs ── */}
      <div className="shrink-0 px-6 pt-4 border-b border-theme-border bg-theme-text/[0.015]">
        <div className="flex items-center gap-6">
          <button 
            onClick={() => { setMode('product'); setSelectedWarehouseId(null); setSelectedRowForPreview(null) }}
            className={cn("pb-3 text-sm font-bold border-b-2 transition-colors flex items-center gap-2", mode === 'product' ? "border-theme-accent text-theme-accent" : "border-transparent text-theme-text-muted hover:text-theme-text")}
          >
            <Package className="w-4 h-4" /> Por producto
          </button>
          <button 
            onClick={() => { setMode('warehouse'); setSelectedProductId(null); setSelectedRowForPreview(null) }}
            className={cn("pb-3 text-sm font-bold border-b-2 transition-colors flex items-center gap-2", mode === 'warehouse' ? "border-theme-accent text-theme-accent" : "border-transparent text-theme-text-muted hover:text-theme-text")}
          >
            <LayoutGrid className="w-4 h-4" /> Por bodega
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex">
        
        {/* ── Modo Por Producto ── */}
        {mode === 'product' && (
          <>
            {/* Sidebar Products List */}
            <div className="w-80 border-r border-theme-border bg-theme-surface flex flex-col shrink-0">
              <div className="p-4 border-b border-theme-border">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
                  <input 
                    value={productSearch}
                    onChange={e => setProductSearch(e.target.value)}
                    placeholder="Buscar producto..."
                    className={cn(erpInputClass, 'w-full h-10 pl-9 pr-3 text-sm')}
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {filteredProducts.map(p => (
                  <button 
                    key={p.id}
                    onClick={() => setSelectedProductId(p.id)}
                    className={cn("w-full text-left p-4 border-b border-theme-border/50 hover:bg-theme-text/5 transition-colors", selectedProductId === p.id && "bg-theme-accent/5 border-l-2 border-l-theme-accent")}
                  >
                    <p className="font-mono text-[10px] font-bold text-theme-text-muted mb-0.5">{p.sku}</p>
                    <p className="font-semibold text-theme-text text-sm truncate">{p.description}</p>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs font-black text-theme-accent">{p.totalQty} unds.</span>
                      <span className="text-[10px] text-theme-text-muted">{formatCurrency(p.totalValue)}</span>
                    </div>
                  </button>
                ))}
                {filteredProducts.length === 0 && (
                  <p className="text-center text-sm text-theme-text-muted p-6">No se encontraron productos en stock.</p>
                )}
              </div>
            </div>

            {/* Product Detail View */}
            <div className="flex-1 bg-theme-surface overflow-y-auto">
              {!selectedProductDetails ? (
                <div className="h-full flex flex-col items-center justify-center text-theme-text-muted p-8 text-center">
                  <Package className="w-12 h-12 mb-4 opacity-20" />
                  <p className="text-lg font-bold text-theme-text mb-1">Seleccione un producto</p>
                  <p className="text-sm">Explore el stock desglosado por bodega, ubicación y lote.</p>
                </div>
              ) : (
                <div className="p-8 animate-in fade-in duration-300 max-w-6xl mx-auto">
                  <div className="mb-8 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-mono font-bold text-theme-accent mb-2">{selectedProductDetails.info.sku}</p>
                      <h2 className="text-3xl font-black text-theme-text mb-6 truncate" title={selectedProductDetails.info.description}>{selectedProductDetails.info.description}</h2>
                    </div>
                    <button 
                      onClick={() => handleViewKardex({ product_id: selectedProductDetails.info.id, product_sku: selectedProductDetails.info.sku, product_description: selectedProductDetails.info.description })}
                      className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-sm active:scale-95"
                    >
                      <Layers className="w-4 h-4" />
                      Ver Kardex
                    </button>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                    <div className="bg-theme-text/5 p-4 rounded-2xl border border-theme-border">
                      <p className="text-[10px] font-bold uppercase text-theme-text-muted flex items-center gap-2"><Package className="w-3 h-3"/> Stock Total</p>
                      <p className="text-2xl font-black text-theme-text mt-1">{selectedProductDetails.info.totalQty}</p>
                    </div>
                    <div className="bg-theme-text/5 p-4 rounded-2xl border border-theme-border">
                      <p className="text-[10px] font-bold uppercase text-theme-text-muted flex items-center gap-2"><Coins className="w-3 h-3"/> Valor Total</p>
                      <p className="text-2xl font-black text-emerald-600 dark:text-emerald-400 mt-1">{formatCurrency(selectedProductDetails.info.totalValue)}</p>
                    </div>
                    <div className="bg-theme-text/5 p-4 rounded-2xl border border-theme-border">
                      <p className="text-[10px] font-bold uppercase text-theme-text-muted flex items-center gap-2"><LayoutGrid className="w-3 h-3"/> Bodegas</p>
                      <p className="text-2xl font-black text-theme-text mt-1">{selectedProductDetails.warehousesCount}</p>
                    </div>
                    <div className="bg-theme-text/5 p-4 rounded-2xl border border-theme-border">
                      <p className="text-[10px] font-bold uppercase text-theme-text-muted flex items-center gap-2"><Box className="w-3 h-3"/> Lotes</p>
                      <p className="text-2xl font-black text-theme-text mt-1">{selectedProductDetails.lotsCount}</p>
                    </div>
                  </div>

                  <div className="bg-theme-surface border border-theme-border rounded-2xl overflow-hidden shadow-sm">
                    <div className="px-5 py-4 border-b border-theme-border bg-theme-text/[0.015]">
                      <h3 className="font-bold text-theme-text text-sm">Desglose de Existencias</h3>
                    </div>
                    <table className="w-full text-left text-xs whitespace-nowrap">
                      <thead className="bg-theme-text/5">
                        <tr className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                          <th className="px-5 py-3">Bodega</th>
                          <th className="px-5 py-3">Ubicación</th>
                          <th className="px-5 py-3">Lote / Vence</th>
                          <th className="px-5 py-3 text-right">Cantidad</th>
                          <th className="px-5 py-3 text-right">Costo Un.</th>
                          <th className="px-5 py-3 text-right">Valorizado</th>
                          <th className="px-3 py-3 text-center w-12"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-theme-border/50">
                        {selectedProductDetails.items.map((it, idx) => (
                          <tr key={idx} onClick={() => handleViewKardex(it)} className="hover:bg-theme-text/[0.02] transition-colors group cursor-pointer">
                            <td className="px-5 py-3 font-semibold text-theme-text">{it.warehouse_name}</td>
                            <td className="px-5 py-3 font-mono font-medium text-theme-text-muted">{it.location_code || '—'}</td>
                            <td className="px-5 py-3 text-theme-text-muted">
                              {it.lot_number ? (
                                <div><span className="font-bold text-theme-text">{it.lot_number}</span> {it.expiration_date && <span className="text-[10px] ml-2">V: {new Date(it.expiration_date).toLocaleDateString('es-CL')}</span>}</div>
                              ) : '—'}
                            </td>
                            <td className="px-5 py-3 text-right font-black text-theme-accent text-sm">{it.quantity}</td>
                            <td className="px-5 py-3 text-right text-theme-text-muted">{formatCurrency(it.unit_cost)}</td>
                            <td className="px-5 py-3 text-right font-bold text-theme-text">{formatCurrency(it.unit_cost ? it.quantity * it.unit_cost : 0)}</td>
                            <td className="px-3 py-3 text-center">
                              <button 
                                onClick={(e) => { e.stopPropagation(); handleViewKardex(it) }}
                                className="p-1.5 rounded-lg bg-theme-surface border border-theme-border hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-accent transition-colors opacity-0 group-hover:opacity-100 shadow-sm"
                                title="Ver Kardex"
                              >
                                <Layers className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Modo Por Bodega ── */}
        {mode === 'warehouse' && (
          <>
            {/* Sidebar Warehouses List */}
            <div className="w-80 border-r border-theme-border bg-theme-surface flex flex-col shrink-0">
              <div className="p-4 border-b border-theme-border bg-theme-text/[0.015]">
                <h3 className="font-bold text-sm text-theme-text mb-1">Bodegas Activas</h3>
                <p className="text-xs text-theme-text-muted">Bodegas con inventario disponible</p>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {warehouseGroups.map(w => (
                  <button 
                    key={w.id}
                    onClick={() => { setSelectedWarehouseId(w.id); setSelectedRowForPreview(null) }}
                    className={cn("w-full text-left p-4 rounded-xl mb-2 hover:bg-theme-text/5 transition-colors border border-transparent", selectedWarehouseId === w.id ? "bg-theme-accent/5 border-theme-accent/20" : "")}
                  >
                    <h4 className="font-bold text-theme-text text-sm mb-2">{w.name}</h4>
                    <div className="flex items-center justify-between mt-2 text-xs text-theme-text-muted">
                      <span>{w.uniqueSkus.size} SKUs</span>
                      <span className="font-bold text-theme-text">{w.totalQty} unds.</span>
                    </div>
                  </button>
                ))}
                {warehouseGroups.length === 0 && (
                  <p className="text-center text-sm text-theme-text-muted p-6">No hay bodegas con stock.</p>
                )}
              </div>
            </div>

            {/* Warehouse Detail View */}
            <div className="flex-1 flex overflow-hidden">
              <div className="flex-1 bg-theme-surface overflow-y-auto">
                {!selectedWarehouseDetails ? (
                  <div className="h-full flex flex-col items-center justify-center text-theme-text-muted p-8 text-center">
                    <LayoutGrid className="w-12 h-12 mb-4 opacity-20" />
                    <p className="text-lg font-bold text-theme-text mb-1">Seleccione una bodega</p>
                    <p className="text-sm">Explore el inventario total almacenado en las instalaciones.</p>
                  </div>
                ) : (
                  <div className="p-8 animate-in fade-in duration-300 max-w-6xl mx-auto">
                    <div className="mb-8">
                      <p className="text-sm font-bold uppercase tracking-wider text-theme-accent mb-2">Bodega</p>
                      <h2 className="text-3xl font-black text-theme-text mb-6">{selectedWarehouseDetails.info.name}</h2>
                      
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                        <div className="bg-theme-text/5 p-4 rounded-2xl border border-theme-border">
                          <p className="text-[10px] font-bold uppercase text-theme-text-muted flex items-center gap-2"><Box className="w-3 h-3"/> SKUs Distintos</p>
                          <p className="text-2xl font-black text-theme-text mt-1">{selectedWarehouseDetails.info.uniqueSkus.size}</p>
                        </div>
                        <div className="bg-theme-text/5 p-4 rounded-2xl border border-theme-border">
                          <p className="text-[10px] font-bold uppercase text-theme-text-muted flex items-center gap-2"><Package className="w-3 h-3"/> Unidades Totales</p>
                          <p className="text-2xl font-black text-theme-text mt-1">{selectedWarehouseDetails.info.totalQty}</p>
                        </div>
                        <div className="bg-theme-text/5 p-4 rounded-2xl border border-theme-border">
                          <p className="text-[10px] font-bold uppercase text-theme-text-muted flex items-center gap-2"><Coins className="w-3 h-3"/> Valor Inventario</p>
                          <p className="text-2xl font-black text-emerald-600 dark:text-emerald-400 mt-1">{formatCurrency(selectedWarehouseDetails.info.totalValue)}</p>
                        </div>
                        <div className="bg-theme-text/5 p-4 rounded-2xl border border-theme-border">
                          <p className="text-[10px] font-bold uppercase text-theme-text-muted flex items-center gap-2"><MapPin className="w-3 h-3"/> Ubicaciones con Stock</p>
                          <p className="text-2xl font-black text-theme-text mt-1">{selectedWarehouseDetails.locationsCount}</p>
                        </div>
                      </div>
                    </div>

                    <div className="bg-theme-surface border border-theme-border rounded-2xl overflow-hidden shadow-sm">
                      <div className="px-5 py-4 border-b border-theme-border bg-theme-text/[0.015] flex items-center gap-4">
                        <div className="relative w-64">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
                          <input 
                            value={warehouseSearch}
                            onChange={e => setWarehouseSearch(e.target.value)}
                            placeholder="Buscar producto o lote..."
                            className={cn(erpInputClass, 'w-full h-9 pl-9 pr-3 text-xs')}
                          />
                        </div>
                        <div className="relative w-48">
                          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
                          <input 
                            value={warehouseLocationFilter}
                            onChange={e => setWarehouseLocationFilter(e.target.value)}
                            placeholder="Filtrar ubicación..."
                            className={cn(erpInputClass, 'w-full h-9 pl-9 pr-3 text-xs')}
                          />
                        </div>
                      </div>
                      <table className="w-full text-left text-xs whitespace-nowrap">
                        <thead className="bg-theme-text/5">
                          <tr className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                            <th className="px-5 py-3">Producto</th>
                            <th className="px-5 py-3">Ubicación</th>
                            <th className="px-5 py-3">Lote / Vence</th>
                            <th className="px-5 py-3 text-right">Cantidad</th>
                            <th className="px-5 py-3 text-right">Costo Un.</th>
                            <th className="px-5 py-3 text-right">Valorizado</th>
                            <th className="px-3 py-3 text-center w-24"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-theme-border/50">
                          {selectedWarehouseDetails.items.map((it, idx) => (
                            <tr key={idx} onClick={() => setSelectedRowForPreview(it)} className={cn("transition-colors group cursor-pointer", selectedRowForPreview === it ? "bg-theme-accent/5 border-l-2 border-l-theme-accent" : "hover:bg-theme-text/[0.02]")}>
                              <td className="px-5 py-3 border-l-2 border-transparent">
                                <p className="font-mono text-[10px] font-bold text-theme-accent mb-0.5">{it.product_sku}</p>
                                <p className="font-semibold text-theme-text max-w-[250px] truncate" title={it.product_description}>{it.product_description}</p>
                              </td>
                              <td className="px-5 py-3 font-mono font-medium text-theme-text-muted">{it.location_code || '—'}</td>
                              <td className="px-5 py-3 text-theme-text-muted">
                                {it.lot_number ? (
                                  <div><span className="font-bold text-theme-text">{it.lot_number}</span> {it.expiration_date && <span className="text-[10px] block mt-0.5">V: {new Date(it.expiration_date).toLocaleDateString('es-CL')}</span>}</div>
                                ) : '—'}
                              </td>
                              <td className="px-5 py-3 text-right font-black text-theme-accent text-sm">{it.quantity}</td>
                              <td className="px-5 py-3 text-right text-theme-text-muted">{formatCurrency(it.unit_cost)}</td>
                              <td className="px-5 py-3 text-right font-bold text-theme-text">{formatCurrency(it.unit_cost ? it.quantity * it.unit_cost : 0)}</td>
                              <td className="px-3 py-3 text-center">
                                <button 
                                  onClick={(e) => { e.stopPropagation(); setSelectedRowForPreview(it) }}
                                  className="p-1.5 rounded-lg bg-theme-surface border border-theme-border hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-accent transition-colors opacity-0 group-hover:opacity-100 shadow-sm flex items-center gap-1.5 px-2.5 mx-auto"
                                  title="Vista Previa"
                                >
                                  <Eye className="w-3.5 h-3.5" /> <span className="text-[10px] font-bold">Vista Previa</span>
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {selectedWarehouseDetails.items.length === 0 && (
                        <div className="p-8 text-center text-theme-text-muted text-sm">
                          No se encontraron coincidencias para la búsqueda actual en esta bodega.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Mini Kardex Sidebar ── */}
              {selectedRowForPreview && (
                <div className="w-[420px] shrink-0 border-l border-theme-border bg-theme-surface flex flex-col animate-in slide-in-from-right-8 duration-300 shadow-[-4px_0_15px_rgba(0,0,0,0.03)] z-10">
                  <div className="p-4 border-b border-theme-border flex items-center justify-between bg-theme-text/[0.015]">
                    <div>
                      <h3 className="font-bold text-theme-text flex items-center gap-2 text-sm">
                        <Layers className="w-4 h-4 text-theme-accent" />
                        Vista Previa Kardex
                      </h3>
                    </div>
                    <button onClick={() => setSelectedRowForPreview(null)} className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-5">
                    {/* Resumen del Lote/Ubicación */}
                    <div className="mb-8">
                      <p className="font-mono text-[10px] font-bold text-theme-accent mb-1">{selectedRowForPreview.product_sku}</p>
                      <p className="font-bold text-theme-text text-sm mb-5 leading-tight">{selectedRowForPreview.product_description}</p>
                      
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-theme-text/5 p-2.5 rounded-lg border border-theme-border">
                          <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5">Bodega</p>
                          <p className="font-semibold text-theme-text truncate">{selectedRowForPreview.warehouse_name}</p>
                        </div>
                        <div className="bg-theme-text/5 p-2.5 rounded-lg border border-theme-border">
                          <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5">Ubicación</p>
                          <p className="font-mono font-medium text-theme-text truncate">{selectedRowForPreview.location_code || '—'}</p>
                        </div>
                        <div className="bg-theme-text/5 p-2.5 rounded-lg border border-theme-border">
                          <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5">Lote</p>
                          <p className="font-semibold text-theme-text truncate">{selectedRowForPreview.lot_number || '—'}</p>
                        </div>
                        <div className="bg-theme-text/5 p-2.5 rounded-lg border border-theme-border">
                          <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5">Vence</p>
                          <p className="font-semibold text-theme-text truncate">{selectedRowForPreview.expiration_date ? new Date(selectedRowForPreview.expiration_date).toLocaleDateString('es-CL') : '—'}</p>
                        </div>
                        <div className="bg-theme-text/5 p-2.5 rounded-lg border border-theme-border">
                          <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5">Stock Actual</p>
                          <p className="font-black text-theme-accent text-sm">{selectedRowForPreview.quantity}</p>
                        </div>
                        <div className="bg-theme-text/5 p-2.5 rounded-lg border border-theme-border">
                          <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5">Valorizado</p>
                          <p className="font-black text-theme-text text-sm">{formatCurrency(selectedRowForPreview.unit_cost ? selectedRowForPreview.quantity * selectedRowForPreview.unit_cost : 0)}</p>
                        </div>
                      </div>
                    </div>

                    <h4 className="font-bold text-[11px] text-theme-text-muted uppercase tracking-wider mb-4 border-b border-theme-border/50 pb-2">Últimos Movimientos</h4>
                    
                    {previewLoading ? (
                      <div className="py-8 flex flex-col items-center justify-center">
                        <div className="w-6 h-6 border-2 border-theme-accent border-t-transparent rounded-full animate-spin mb-3" />
                        <p className="text-xs text-theme-text-muted font-medium">Cargando Kardex...</p>
                      </div>
                    ) : previewMovements.length === 0 ? (
                      <div className="py-8 text-center bg-theme-text/5 rounded-xl border border-theme-border border-dashed">
                        <p className="text-xs text-theme-text-muted">No hay movimientos para esta combinación.</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {previewMovements.map((m: any) => (
                          <div key={m.id} className="bg-theme-surface border border-theme-border p-3.5 rounded-xl shadow-sm text-xs transition-all hover:border-theme-border/80">
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-mono text-[9px] font-semibold text-theme-text-muted bg-theme-text/5 px-1.5 py-0.5 rounded">{formatDate(m.movement_date)}</span>
                              <Badge type={m.movement_type} />
                            </div>
                            <p className="font-semibold text-theme-text mb-3 truncate" title={m.source_id}>{m.source_id}</p>
                            <div className="flex items-center justify-between bg-theme-text/[0.015] p-2.5 rounded-lg border border-theme-border/50">
                              <div className="text-center flex-1">
                                <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5">Entrada</p>
                                <p className="font-black text-emerald-600">{m.isPositive ? '+' + Math.abs(m.quantity) : '—'}</p>
                              </div>
                              <div className="w-px h-6 bg-theme-border/50 mx-2" />
                              <div className="text-center flex-1">
                                <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5">Salida</p>
                                <p className="font-black text-red-600">{m.isNegative ? '-' + Math.abs(m.quantity) : '—'}</p>
                              </div>
                              <div className="w-px h-6 bg-theme-border/50 mx-2" />
                              <div className="text-center flex-1">
                                <p className="text-[9px] font-bold text-theme-accent uppercase mb-0.5">Saldo</p>
                                <p className="font-black text-theme-text">{m.saldo}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="p-4 border-t border-theme-border bg-theme-surface shrink-0">
                    <button 
                      onClick={() => handleViewKardex(selectedRowForPreview)}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-sm active:scale-95"
                    >
                      Ver Kardex Completo <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  )
}
