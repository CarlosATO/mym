'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { getKardexMovements, type KardexMovement } from '@/app/actions/logistica/recepciones'
import { getProducts, type Product } from '@/app/actions/adquisiciones/products'
import { Search, Package, Calendar, MapPin, Tag, ArrowLeft, Filter, X, ArrowRightLeft, ArrowDownToLine, ArrowUpFromLine, RefreshCw, Undo2, FileText } from 'lucide-react'
import { erpInputClass, erpSelectClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import * as XLSX from 'xlsx'

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
    IN: 'Entrada por recepción',
    PURCHASE_RECEIPT: 'Entrada por recepción',
    OUT: 'Salida',
    ADJUSTMENT: 'Ajuste',
    TRANSFER_IN: 'Traspaso entrada',
    TRANSFER_OUT: 'Traspaso salida',
    RETURN: 'Devolución'
  }
  return map[type] || type
}

function Badge({ type }: { type: string }) {
  const s = MOVEMENT_TYPE_BADGES[type] || { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-500', icon: <Package className="w-3 h-3" /> }
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider", s.bg, s.text)}>
      {s.icon} {movementLabel(type)}
    </span>
  )
}

function formatCurrency(amount: number | null) {
  if (amount === null) return '—'
  return amount.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('es-CL', { 
    day: '2-digit', month: '2-digit', year: 'numeric', 
    hour: '2-digit', minute: '2-digit' 
  })
}

// ─── Componente Principal ──────────────────────────────────────────────────

export function KardexPanel() {
  const [productSearch, setProductSearch] = useState('')
  const [searchingProducts, setSearchingProducts] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  
  const [movements, setMovements] = useState<KardexMovement[]>([])
  const [loadingMovements, setLoadingMovements] = useState(false)
  
  // Filters
  const [filterWarehouse, setFilterWarehouse] = useState('')
  const [filterWarehouseId, setFilterWarehouseId] = useState('')
  const [filterLocation, setFilterLocation] = useState('')
  const [filterLot, setFilterLot] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [isFilteredFromStock, setIsFilteredFromStock] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const flash = sessionStorage.getItem('mym_stock_to_kardex')
      if (flash) {
        try {
          const data = JSON.parse(flash)
          if (data.productId) {
            setSelectedProduct({
              id: data.productId,
              sku: data.productSku,
              description: data.productDesc,
              brand: null
            } as Product)
            
            if (data.warehouseId) {
              setFilterWarehouseId(data.warehouseId)
              setFilterWarehouse(data.warehouseName || '')
            }
            if (data.locationCode) {
              setFilterLocation(data.locationCode)
            }
            if (data.lotNumber) {
              setFilterLot(data.lotNumber)
            }
            
            setIsFilteredFromStock(true)
            setShowFilters(true)
            sessionStorage.removeItem('mym_stock_to_kardex')
          }
        } catch (e) {}
      }
    }
  }, [])

  // Product Search Debounce
  useEffect(() => {
    if (!productSearch.trim()) {
      setProducts([])
      return
    }
    const timer = setTimeout(async () => {
      setSearchingProducts(true)
      const res = await getProducts({ search: productSearch, pageSize: 15 })
      setProducts(res.data)
      setSearchingProducts(false)
    }, 400)
    return () => clearTimeout(timer)
  }, [productSearch])

  // Load Movements when product selected
  useEffect(() => {
    if (!selectedProduct) {
      setMovements([])
      return
    }
    let active = true
    setLoadingMovements(true)
    getKardexMovements(selectedProduct.id).then(data => {
      if (active) {
        setMovements(data)
        setLoadingMovements(false)
      }
    })
    return () => { active = false }
  }, [selectedProduct])

  // Apply filters and calculate running balance
  const filteredAndCalculatedMovements = useMemo(() => {
    if (!selectedProduct || movements.length === 0) return []

    // 1. Filter raw movements (which are sorted ASC from DB)
    const filtered = movements.filter(m => {
      if (filterWarehouseId && m.warehouse_id !== filterWarehouseId) return false
      else if (!filterWarehouseId && filterWarehouse && !m.warehouse_name.toLowerCase().includes(filterWarehouse.toLowerCase())) return false
      if (filterLocation && !(m.location_code && m.location_code.toLowerCase().includes(filterLocation.toLowerCase()))) return false
      if (filterLot && !(m.lot_number && m.lot_number.toLowerCase().includes(filterLot.toLowerCase()))) return false
      if (filterType && m.movement_type !== filterType) return false
      if (filterDateFrom && new Date(m.movement_date) < new Date(filterDateFrom)) return false
      if (filterDateTo && new Date(m.movement_date) > new Date(filterDateTo + 'T23:59:59')) return false
      return true
    })

    // 2. Calculate running balance (saldo)
    let currentBalance = 0
    const calculated = filtered.map(m => {
      const isPositive = ['IN', 'PURCHASE_RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT'].includes(m.movement_type)
      const isNegative = ['OUT', 'TRANSFER_OUT', 'RETURN'].includes(m.movement_type)
      
      let delta = Number(m.quantity)
      if (isNegative) delta = -delta
      
      if (delta < 0 && m.quantity < 0) delta = m.quantity // avoid double negative
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

    // 3. Reverse for display (newest first)
    return calculated.reverse()
  }, [movements, selectedProduct, filterWarehouse, filterWarehouseId, filterLocation, filterLot, filterType, filterDateFrom, filterDateTo])

  // Total absolute stock vs filtered stock
  const globalStock = useMemo(() => {
    let total = 0
    for (const m of movements) {
      let delta = Number(m.quantity)
      if (['OUT', 'TRANSFER_OUT', 'RETURN'].includes(m.movement_type)) delta = -delta
      total += delta
    }
    return total
  }, [movements])

  const filteredStock = filteredAndCalculatedMovements.length > 0 ? filteredAndCalculatedMovements[0].saldo : 0

  const hasActiveFilters = filterWarehouse || filterLocation || filterLot || filterType || filterDateFrom || filterDateTo

  const handleExportExcel = () => {
    if (!selectedProduct || filteredAndCalculatedMovements.length === 0) return

    const exportData = filteredAndCalculatedMovements.map(m => {
      const isPositive = m.isPositive
      const isNegative = m.isNegative
      const absoluteQty = Math.abs(Number(m.quantity))
      
      return {
        'Fecha / hora': formatDate(m.movement_date),
        'SKU': selectedProduct.sku,
        'Producto': selectedProduct.description,
        'Tipo movimiento': movementLabel(m.movement_type),
        'Referencia': m.source_id || '',
        'Bodega': m.warehouse_name || '',
        'Ubicación': m.location_code || '',
        'Lote': m.lot_number || '',
        'Vencimiento': m.expiration_date ? new Date(m.expiration_date).toLocaleDateString('es-CL') : '',
        'Entrada': isPositive ? absoluteQty : '',
        'Salida': isNegative ? absoluteQty : '',
        'Saldo': m.saldo,
        'Costo unitario': m.unit_cost || 0,
        'Costo total': (m.unit_cost || 0) * absoluteQty
      }
    })

    const ws = XLSX.utils.json_to_sheet(exportData)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Kardex')

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    XLSX.writeFile(wb, `Kardex_${selectedProduct.sku}_${dateStr}.xlsx`)
  }

  // ─── Render View ──────────────────────────────────────────────────────────

  if (!selectedProduct) {
    return (
      <div className="h-full flex flex-col items-center justify-start pt-12 px-6 bg-theme-surface overflow-auto">
        <div className="w-full max-w-2xl animate-in fade-in slide-in-from-top-4 duration-500">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl bg-theme-accent/10 flex items-center justify-center shrink-0 shadow-inner shadow-theme-accent/20">
              <Package className="w-6 h-6 text-theme-accent" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-theme-text tracking-tight">Consulta de Kardex</h1>
              <p className="text-theme-text-muted text-sm">Busque un producto para analizar su historial de movimientos y saldos.</p>
            </div>
          </div>
          
          <div className="relative text-left w-full">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-theme-text-muted/50" />
            <input 
              value={productSearch}
              onChange={e => setProductSearch(e.target.value)}
              placeholder="Buscar por SKU, código de barras, descripción o marca..."
              className="w-full h-12 pl-12 pr-4 rounded-xl border border-theme-border bg-theme-surface text-theme-text focus:outline-none focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/20 transition-all shadow-sm"
              autoFocus
            />
            {searchingProducts && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-theme-accent border-t-transparent rounded-full animate-spin" />
            )}

            {products.length > 0 && (
              <div className="absolute top-full mt-2 w-full max-h-80 overflow-y-auto rounded-xl border border-theme-border bg-theme-surface shadow-xl z-50 animate-in fade-in zoom-in-95 duration-200">
                {products.map(p => (
                  <button 
                    key={p.id}
                    onClick={() => {
                      setSelectedProduct(p)
                      setProductSearch('')
                      setProducts([])
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-theme-accent/5 border-b last:border-b-0 border-theme-border/50 transition-colors flex items-center gap-4"
                  >
                    <div className="w-8 h-8 rounded-lg bg-theme-text/5 flex items-center justify-center shrink-0">
                      <Package className="w-4 h-4 text-theme-text-muted" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="font-bold text-theme-text text-sm truncate">{p.description}</h4>
                      <p className="text-[11px] text-theme-text-muted mt-0.5 font-mono truncate">{p.sku} {p.brand ? `· ${p.brand}` : ''}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-theme-surface overflow-hidden animate-in fade-in duration-300">
      
      {/* ── Header ── */}
      <header className="shrink-0 px-6 py-4 border-b border-theme-border bg-theme-text/[0.015] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <button 
            onClick={() => { setSelectedProduct(null); setMovements([]) }}
            className="p-2 rounded-xl hover:bg-theme-text/10 text-theme-text-muted transition-colors"
            title="Volver a la búsqueda"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-theme-text truncate" title={selectedProduct.description}>
              {selectedProduct.description}
            </h2>
            <div className="flex items-center gap-3 mt-1 text-xs text-theme-text-muted">
              <span className="font-mono font-bold text-theme-accent bg-theme-accent/10 px-2 py-0.5 rounded-md">{selectedProduct.sku}</span>
              {selectedProduct.brand && <span className="flex items-center gap-1"><Tag className="w-3 h-3" /> {selectedProduct.brand}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6 shrink-0">
          <div className="text-right">
            <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-0.5">Stock Total Producto</p>
            <p className="text-xl font-black text-theme-text">{globalStock}</p>
          </div>
          {hasActiveFilters && (
            <div className="text-right pl-6 border-l border-theme-border/50">
              <p className="text-[10px] font-bold uppercase tracking-wider text-theme-accent mb-0.5">Stock Filtro Actual</p>
              <p className="text-xl font-black text-theme-accent">{filteredStock}</p>
            </div>
          )}
        </div>
      </header>

      {/* ── Filters Bar ── */}
      <div className="shrink-0 border-b border-theme-border bg-theme-surface">
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setShowFilters(!showFilters)}
              className={cn("text-xs font-bold flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors", showFilters ? "bg-theme-accent text-white" : "bg-theme-text/5 text-theme-text hover:bg-theme-text/10")}
            >
              <Filter className="w-3.5 h-3.5" />
              {showFilters ? 'Ocultar Filtros' : 'Mostrar Filtros'}
              {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-red-500" />}
            </button>
            {isFilteredFromStock && (
              <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20">
                Filtro aplicado desde Stock
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            <button
              onClick={handleExportExcel}
              disabled={filteredAndCalculatedMovements.length === 0}
              className="text-xs font-bold flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors disabled:opacity-50 shadow-sm"
              title={filteredAndCalculatedMovements.length === 0 ? "No hay movimientos para exportar" : ""}
            >
              <FileText className="w-3.5 h-3.5" /> Exportar Excel
            </button>
            {hasActiveFilters && (
              <button 
                onClick={() => {
                  setFilterWarehouse(''); setFilterWarehouseId(''); setFilterLocation(''); setFilterLot(''); setFilterType(''); setFilterDateFrom(''); setFilterDateTo(''); setIsFilteredFromStock(false);
                }}
                className="text-xs text-theme-text-muted hover:text-red-500 transition-colors flex items-center gap-1 font-semibold"
              >
                <X className="w-3 h-3" /> Limpiar filtros
              </button>
            )}
          </div>
        </div>

        {showFilters && (
          <div className="px-6 pb-4 pt-2 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3 animate-in slide-in-from-top-2 duration-200">
            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Bodega</label>
              <input value={filterWarehouse} onChange={e => { setFilterWarehouse(e.target.value); setFilterWarehouseId(''); setIsFilteredFromStock(false); }} placeholder="Ej: Principal" className={cn(erpInputClass, 'w-full h-8 px-3 text-xs')} />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Ubicación</label>
              <input value={filterLocation} onChange={e => setFilterLocation(e.target.value)} placeholder="Ej: R01-N02" className={cn(erpInputClass, 'w-full h-8 px-3 text-xs')} />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Lote</label>
              <input value={filterLot} onChange={e => setFilterLot(e.target.value)} placeholder="Nº Lote" className={cn(erpInputClass, 'w-full h-8 px-3 text-xs')} />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Movimiento</label>
              <select value={filterType} onChange={e => setFilterType(e.target.value)} className={cn(erpSelectClass, 'w-full h-8 px-2 text-xs')}>
                <option value="">Todos</option>
                <option value="IN">Entrada por recepción</option>
                <option value="OUT">Salida</option>
                <option value="TRANSFER_IN">Traspaso Entrada</option>
                <option value="TRANSFER_OUT">Traspaso Salida</option>
                <option value="ADJUSTMENT">Ajuste</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Desde</label>
              <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)} className={cn(erpInputClass, 'w-full h-8 px-2 text-xs')} />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Hasta</label>
              <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)} className={cn(erpInputClass, 'w-full h-8 px-2 text-xs')} />
            </div>
          </div>
        )}
      </div>

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto bg-theme-surface">
        {loadingMovements ? (
          <div className="h-full flex flex-col items-center justify-center">
            <div className="w-8 h-8 border-4 border-theme-accent border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-sm font-semibold text-theme-text-muted">Cargando movimientos...</p>
          </div>
        ) : filteredAndCalculatedMovements.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-8 text-center text-theme-text-muted">
            <Package className="w-12 h-12 opacity-20 mb-4" />
            <p className="text-lg font-bold text-theme-text mb-1">Sin movimientos</p>
            <p className="text-sm">No hay registros para los filtros seleccionados.</p>
          </div>
        ) : (
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="sticky top-0 bg-theme-surface shadow-sm z-10">
              <tr className="border-b border-theme-border text-[10px] font-bold uppercase tracking-wider text-theme-text-muted bg-theme-text/[0.02]">
                <th className="px-4 py-3">Fecha / Hora</th>
                <th className="px-4 py-3">Tipo Movimiento</th>
                <th className="px-4 py-3">Referencia</th>
                <th className="px-4 py-3">Bodega / Ubicación</th>
                <th className="px-4 py-3">Lote / Vence</th>
                <th className="px-4 py-3 text-right">Entrada</th>
                <th className="px-4 py-3 text-right">Salida</th>
                <th className="px-4 py-3 text-right bg-theme-text/5 text-theme-text">Saldo</th>
                <th className="px-4 py-3 text-right">Costo Un.</th>
                <th className="px-4 py-3 text-right">Total Costo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/50">
              {filteredAndCalculatedMovements.map(m => (
                <tr key={m.id} className="hover:bg-theme-text/[0.02] transition-colors">
                  <td className="px-4 py-3 font-mono text-[11px] text-theme-text-muted">
                    {formatDate(m.movement_date)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge type={m.movement_type} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-bold text-theme-text">{m.source_type}</span>
                    <span className="text-theme-text-muted block mt-0.5 truncate max-w-[150px]" title={m.source_id}>{m.source_id}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-theme-text">{m.warehouse_name}</span>
                    <span className="text-theme-text-muted block mt-0.5 font-mono text-[10px]">{m.location_code || '—'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-theme-text">{m.lot_number || '—'}</span>
                    <span className="text-theme-text-muted block mt-0.5">{m.expiration_date ? new Date(m.expiration_date).toLocaleDateString('es-CL') : '—'}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {m.isPositive ? <span className="font-black text-emerald-600 dark:text-emerald-400">+{Math.abs(Number(m.quantity))}</span> : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {m.isNegative ? <span className="font-black text-red-600 dark:text-red-400">-{Math.abs(Number(m.quantity))}</span> : '—'}
                  </td>
                  <td className="px-4 py-3 text-right bg-theme-text/[0.015]">
                    <span className="font-black text-theme-text text-sm">{m.saldo}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-theme-text-muted font-medium">
                    {formatCurrency(m.unit_cost)}
                  </td>
                  <td className="px-4 py-3 text-right font-bold text-theme-text">
                    {formatCurrency(m.total_cost || ((m.unit_cost || 0) * Math.abs(Number(m.quantity))))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
