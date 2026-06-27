'use client'

import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRightLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Package,
  Plus,
  Search,
  Send,
  Trash2,
  Printer,
  ChevronDown,
  Eye
} from 'lucide-react'
import {
  createStockTransfer,
  getStockTransferDetail,
  getStockTransfers,
  getTransferDestinations,
  getTransferStockOptions,
  getTransferWarehouses,
  type StockTransferDetail,
  type StockTransferSummary,
  type TransferDestinationLocation,
  type TransferStockOption,
  type TransferWarehouse,
} from '@/app/actions/logistica/traspasos'
import { erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'

type TransferLine = {
  id: string
  stock: TransferStockOption
  quantity: string
  notes: string
}

function fmt(n: number) {
  return n.toLocaleString('es-CL', { maximumFractionDigits: 4 })
}

function money(n: number | null) {
  if (n === null) return '—'
  return n.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

function fmtDate(date: string | null) {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('es-CL')
}

function stockKey(item: TransferStockOption) {
  return `${item.product_id}_${item.location_id}_${item.lot_number || 'null'}_${item.expiration_date || 'null'}`
}

function Badge({ status }: { status: string }) {
  if (status === 'COMPLETED') return <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">Emitido</span>
  if (status === 'DRAFT') return <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-gray-500/10 text-gray-500 border border-gray-500/20">Borrador</span>
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-theme-text/5 text-theme-text-muted border border-theme-border">{status}</span>
}

// --- Local Combobox Component ---
function LocalCombobox<T>({ 
  value, 
  onChange, 
  options, 
  placeholder, 
  disabled, 
  emptyText, 
  getLabel, 
  getValue,
  renderOption 
}: { 
  value: string, 
  onChange: (val: string) => void, 
  options: T[], 
  placeholder: string, 
  disabled?: boolean, 
  emptyText: string, 
  getLabel: (opt: T) => string, 
  getValue: (opt: T) => string,
  renderOption?: (opt: T) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return options
    const s = search.toLowerCase()
    return options.filter(opt => getLabel(opt).toLowerCase().includes(s))
  }, [options, search, getLabel])

  const selectedOpt = options.find(opt => getValue(opt) === value)

  return (
    <div className="relative w-full" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setOpen(!open); setSearch('') }}
        className="w-full h-8 flex items-center justify-between rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text shadow-sm focus:outline-none focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent disabled:cursor-not-allowed disabled:bg-theme-text/5 disabled:text-theme-text-muted disabled:opacity-70"
      >
        <span className="truncate">{selectedOpt ? getLabel(selectedOpt) : <span className="text-theme-text-muted">{placeholder}</span>}</span>
        <ChevronDown className="w-3.5 h-3.5 text-theme-text-muted opacity-70" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-hidden flex flex-col rounded-xl border border-theme-border bg-white text-slate-900 shadow-2xl ring-1 ring-black/5 dark:bg-slate-950 dark:text-slate-100 dark:border-slate-700 dark:ring-white/10">
          <div className="p-1 border-b border-theme-border flex items-center px-2">
            <Search className="w-3.5 h-3.5 text-theme-text-muted mr-2 shrink-0" />
            <input 
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full h-7 bg-transparent text-xs text-slate-900 placeholder:text-slate-500 focus:outline-none dark:text-slate-100 dark:placeholder:text-slate-400"
              placeholder="Buscar..."
            />
          </div>
          <div className="flex-1 overflow-auto p-1">
            {filtered.length === 0 ? (
              <p className="p-2 text-center text-xs text-theme-text-muted">{emptyText}</p>
            ) : (
              filtered.map(opt => (
                <button
                  key={getValue(opt)}
                  type="button"
                  onClick={() => {
                    onChange(getValue(opt))
                    setOpen(false)
                  }}
                  className={cn(
                    "w-full text-left px-2 py-1.5 rounded-md text-xs flex items-center gap-2",
                    getValue(opt) === value ? "bg-theme-accent text-white font-bold" : "text-slate-800 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:text-white"
                  )}
                >
                  {renderOption ? renderOption(opt) : getLabel(opt)}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function TransfersPanel() {
  const [view, setView] = useState<'list' | 'form' | 'detail'>('list')
  const [listSearch, setListSearch] = useState('')

  const [stock, setStock] = useState<TransferStockOption[]>([])
  const [warehouses, setWarehouses] = useState<TransferWarehouse[]>([])
  const [destinations, setDestinations] = useState<TransferDestinationLocation[]>([])
  const [history, setHistory] = useState<StockTransferSummary[]>([])
  const [detail, setDetail] = useState<StockTransferDetail | null>(null)
  const detailCache = useRef<Record<string, StockTransferDetail>>({})
  
  const [fromWarehouseId, setFromWarehouseId] = useState('')
  const [toWarehouseId, setToWarehouseId] = useState('')
  const [toLocationId, setToLocationId] = useState('')
  const [search, setSearch] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<TransferLine[]>([])
  
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadList = useCallback(async () => {
    if (process.env.NODE_ENV === 'development') console.time('loadTransfers')
    setLoading(true)
    const transferData = await getStockTransfers()
    setHistory(transferData)
    setLoading(false)
    if (process.env.NODE_ENV === 'development') console.timeEnd('loadTransfers')
  }, [])

  const loadDependencies = useCallback(async () => {
    const [stockData, warehouseData] = await Promise.all([
      getTransferStockOptions(),
      getTransferWarehouses(),
    ])
    setStock(stockData)
    setWarehouses(warehouseData)
  }, [])

  useEffect(() => { loadList() }, [loadList])

  useEffect(() => {
    let active = true
    if (toWarehouseId) {
      getTransferDestinations(toWarehouseId).then(data => {
        if (active) setDestinations(data)
      })
    } else {
      setDestinations([])
    }
    return () => { active = false }
  }, [toWarehouseId])

  const originWarehouses = useMemo(() => {
    const map = new Map<string, { id: string; name: string; quantity: number; rows: number }>()
    for (const item of stock) {
      const current = map.get(item.warehouse_id)
      if (current) {
        current.quantity += item.quantity
        current.rows += 1
      } else {
        map.set(item.warehouse_id, { id: item.warehouse_id, name: item.warehouse_name, quantity: item.quantity, rows: 1 })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [stock])

  const destinationWarehouses = useMemo(() => warehouses.filter(w => w.id !== fromWarehouseId), [warehouses, fromWarehouseId])
  const destinationLocations = useMemo(() => {
    if (!toWarehouseId) return []
    return destinations.filter(loc => loc.warehouse_id === toWarehouseId)
  }, [destinations, toWarehouseId])

  const filteredStock = useMemo(() => {
    if (!fromWarehouseId) return []
    const warehouseStock = stock.filter(item => item.warehouse_id === fromWarehouseId)
    const s = search.trim().toLowerCase()
    if (!s) return warehouseStock
    return warehouseStock.filter(item =>
      item.product_sku.toLowerCase().includes(s) ||
      item.product_description.toLowerCase().includes(s) ||
      item.location_code.toLowerCase().includes(s) ||
      (item.lot_number?.toLowerCase().includes(s) ?? false)
    )
  }, [stock, fromWarehouseId, search])

  const filteredHistory = useMemo(() => {
    if (!listSearch.trim()) return history
    const s = listSearch.toLowerCase()
    return history.filter(h => 
      h.transfer_number.toLowerCase().includes(s) ||
      h.from_warehouse.toLowerCase().includes(s) ||
      h.to_warehouse.toLowerCase().includes(s) ||
      h.to_location.toLowerCase().includes(s) ||
      (h.created_by_name && h.created_by_name.toLowerCase().includes(s))
    )
  }, [history, listSearch])

  const lineErrors = useMemo(() => {
    const errors = new Map<string, string>()
    for (const line of lines) {
      const qty = Number(line.quantity)
      if (!Number.isFinite(qty) || qty <= 0) errors.set(line.id, 'Cantidad inválida')
      else if (qty > line.stock.quantity) errors.set(line.id, 'Supera disponible')
    }
    return errors
  }, [lines])

  const totalQuantity = lines.reduce((acc, line) => acc + (Number(line.quantity) || 0), 0)
  const canDraftPrint = fromWarehouseId && toWarehouseId && toLocationId && lines.length > 0 && lineErrors.size === 0
  const canSubmit = canDraftPrint && !saving

  function handleFromWarehouseChange(value: string) {
    setFromWarehouseId(value)
    setToWarehouseId('')
    setToLocationId('')
    setSearch('')
    setLines([])
    setMessage(null)
  }

  function handleToWarehouseChange(value: string) {
    setToWarehouseId(value)
    setToLocationId('')
    setMessage(null)
  }

  function addLine(item: TransferStockOption) {
    setMessage(null)
    if (!fromWarehouseId) return
    const key = stockKey(item)
    if (lines.some(line => stockKey(line.stock) === key)) {
      setMessage({ type: 'error', text: 'Esta combinación producto/lote/ubicación ya está agregada.' })
      return
    }
    setLines(prev => [...prev, { id: crypto.randomUUID(), stock: item, quantity: '', notes: '' }])
  }

  function updateLine(id: string, patch: Partial<TransferLine>) {
    setLines(prev => prev.map(line => line.id === id ? { ...line, ...patch } : line))
  }

  function removeLine(id: string) {
    setLines(prev => prev.filter(line => line.id !== id))
  }

  async function openNewTransfer() {
    setLoading(true)
    await loadDependencies()
    setFromWarehouseId('')
    setToWarehouseId('')
    setToLocationId('')
    setNotes('')
    setLines([])
    setMessage(null)
    setView('form')
    setLoading(false)
  }

  async function openDetail(id: string) {
    const cached = detailCache.current[id]
    if (cached) {
      setDetail(cached)
      setView('detail')
      return
    }
    const perfLabel = `openTransferDetail:${id}`
    if (process.env.NODE_ENV === 'development') console.time(perfLabel)
    setLoading(true)
    const data = await getStockTransferDetail(id)
    if (process.env.NODE_ENV === 'development') console.timeEnd(perfLabel)
    if (data) {
      detailCache.current[id] = data
      setDetail(data)
      setView('detail')
    }
    setLoading(false)
  }

  async function handleSubmit() {
    setMessage(null)
    if (!fromWarehouseId) return setMessage({ type: 'error', text: 'Debe seleccionar bodega origen.' })
    if (!toWarehouseId) return setMessage({ type: 'error', text: 'Debe seleccionar bodega destino.' })
    if (!toLocationId) return setMessage({ type: 'error', text: 'Debe seleccionar ubicación destino.' })
    if (fromWarehouseId === toWarehouseId) return setMessage({ type: 'error', text: 'La bodega destino debe ser distinta a la origen.' })
    if (lines.length === 0) return setMessage({ type: 'error', text: 'Debe agregar al menos una línea.' })
    if (lineErrors.size > 0) return setMessage({ type: 'error', text: 'Corrija las líneas con errores antes de confirmar.' })

    setSaving(true)
    const res = await createStockTransfer({
      from_warehouse_id: fromWarehouseId,
      to_warehouse_id: toWarehouseId,
      to_location_id: toLocationId,
      notes,
      items: lines.map(line => ({
        product_id: line.stock.product_id,
        from_location_id: line.stock.location_id,
        lot_number: line.stock.lot_number,
        expiration_date: line.stock.expiration_date,
        quantity: Number(line.quantity),
        notes: line.notes || null,
      })),
    })
    setSaving(false)

    if (res.error) {
      setMessage({ type: 'error', text: res.error })
      return
    }

    await loadList()
    if (res.transfer_id) {
      await openDetail(res.transfer_id)
    } else {
      setView('list')
    }
  }

  function handlePrint() {
    window.print()
  }

  // Helper variables for print view
  const originWhName = useMemo(() => warehouses.find(w => w.id === fromWarehouseId)?.name || '—', [warehouses, fromWarehouseId])
  const destWhName = useMemo(() => warehouses.find(w => w.id === toWarehouseId)?.name || '—', [warehouses, toWarehouseId])
  const destLocName = useMemo(() => {
    const loc = destinations.find(l => l.id === toLocationId)
    return loc ? `${loc.code} ${loc.name ? `- ${loc.name}` : ''}` : '—'
  }, [destinations, toLocationId])

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col bg-theme-surface overflow-hidden print:overflow-visible">
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body * { visibility: hidden; }
          #print-section, #print-section * { visibility: visible; }
          #print-section { position: absolute; left: 0; top: 0; width: 100%; }
        }
      `}} />

      {/* ── BANDEJA (LIST) ─────────────────────────────────────────────────── */}
      {view === 'list' && (
        <div className="flex-1 flex flex-col min-h-0 animate-in fade-in duration-200 print:hidden">
          <div className="px-6 py-4 border-b border-theme-border bg-theme-text/[0.015] flex items-center justify-between shrink-0">
            <div>
              <h2 className="text-lg font-bold text-theme-text flex items-center gap-2">
                <ArrowRightLeft className="w-5 h-5 text-theme-accent" /> Bandeja de Traspasos
              </h2>
              <p className="text-xs text-theme-text-muted mt-0.5">Historial de guías de movimiento interno.</p>
            </div>
            <div className="flex items-center gap-4">
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
                <input
                  value={listSearch}
                  onChange={e => setListSearch(e.target.value)}
                  placeholder="Buscar traspasos..."
                  className={cn(erpInputClass, 'w-full h-9 pl-9 pr-3 text-xs')}
                />
              </div>
              <button onClick={openNewTransfer} className="px-4 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold flex items-center gap-2 shadow-lg shadow-theme-accent/15 transition-colors">
                <Plus className="w-4 h-4" /> Nuevo traspaso
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6">
            {loading ? (
              <div className="flex items-center justify-center h-40 text-theme-text-muted">
                <Loader2 className="w-6 h-6 animate-spin mr-2" /> Cargando historial...
              </div>
            ) : filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-theme-text-muted bg-theme-text/[0.02] border border-theme-border border-dashed rounded-xl">
                <FileText className="w-8 h-8 mb-2 opacity-50" />
                <p className="text-sm font-medium">No se encontraron traspasos.</p>
              </div>
            ) : (
              <div className="bg-theme-surface border border-theme-border rounded-xl shadow-sm overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-theme-text/5 border-b border-theme-border text-[10px] uppercase tracking-wider text-theme-text-muted">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Correlativo / Fecha</th>
                      <th className="px-4 py-3 font-semibold">Origen</th>
                      <th className="px-4 py-3 font-semibold">Destino</th>
                      <th className="px-4 py-3 font-semibold">Ubicación</th>
                      <th className="px-4 py-3 font-semibold text-right">Líneas</th>
                      <th className="px-4 py-3 font-semibold text-right">Unidades</th>
                      <th className="px-4 py-3 font-semibold">Estado / Usuario</th>
                      <th className="px-4 py-3 font-semibold text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border/50">
                    {filteredHistory.map(item => (
                      <tr key={item.id} className="hover:bg-theme-text/[0.02] transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-mono font-bold text-theme-accent text-sm">{item.transfer_number}</p>
                          <p className="text-theme-text-muted">{new Date(item.date).toLocaleString('es-CL')}</p>
                        </td>
                        <td className="px-4 py-3 font-medium text-theme-text">{item.from_warehouse}</td>
                        <td className="px-4 py-3 font-medium text-theme-text">{item.to_warehouse}</td>
                        <td className="px-4 py-3 font-mono text-theme-text-muted">{item.to_location}</td>
                        <td className="px-4 py-3 text-right font-bold text-theme-text">{item.line_count}</td>
                        <td className="px-4 py-3 text-right font-bold text-theme-text">{fmt(item.total_quantity)}</td>
                        <td className="px-4 py-3">
                          <Badge status={item.status} />
                          <p className="text-theme-text-muted mt-1 truncate max-w-[120px]">{item.created_by_name || 'Sistema'}</p>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => openDetail(item.id)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-text/5 hover:bg-theme-text/10 text-theme-text font-semibold transition-colors">
                            <Eye className="w-3.5 h-3.5" /> Ver
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── NUEVO TRASPASO (FORM) ──────────────────────────────────────────── */}
      {view === 'form' && (
        <div className="flex-1 flex flex-col min-h-0 animate-in slide-in-from-right-4 duration-300 print:hidden">
          <div className="px-4 py-3 border-b border-theme-border bg-theme-surface flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <button onClick={() => { setView('list'); loadList() }} className="p-2 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h2 className="text-sm font-bold text-theme-text flex items-center gap-2">Nueva Guía Interna</h2>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] font-bold text-theme-text-muted/70 bg-theme-text/5 border border-theme-border px-2 py-0.5 rounded-md uppercase tracking-wider">Borrador</span>
                  <span className="text-[10px] text-theme-text-muted">Número se generará al emitir</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handlePrint}
                disabled={!canDraftPrint}
                className="px-4 py-2 rounded-xl border border-theme-border text-theme-text hover:bg-theme-text/5 disabled:opacity-45 disabled:cursor-not-allowed text-sm font-bold flex items-center gap-2 transition-colors"
              >
                <Printer className="w-4 h-4" /> Imprimir Borrador
              </button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white disabled:opacity-45 disabled:cursor-not-allowed text-sm font-bold flex items-center gap-2 shadow-lg shadow-theme-accent/15 transition-colors"
              >
                <Send className="w-4 h-4" /> {saving ? 'Emitiendo...' : 'Emitir Guía Interna'}
              </button>
            </div>
          </div>

          {message && (
            <div className="shrink-0 mx-4 mt-3 px-4 py-2 rounded-xl border text-sm font-semibold flex items-center gap-2 data-[type=success]:bg-emerald-500/10 data-[type=success]:border-emerald-500/25 data-[type=success]:text-emerald-600 data-[type=error]:bg-red-500/10 data-[type=error]:border-red-500/25 data-[type=error]:text-red-600" data-type={message.type}>
              {message.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
              {message.text}
            </div>
          )}

          <div className="shrink-0 px-4 py-3 bg-theme-text/[0.015] border-b border-theme-border/70">
            <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1.5fr_1.5fr_auto_1fr] gap-4 items-end">
              <div className="space-y-1 relative z-30">
                <label className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Bodega origen</label>
                <LocalCombobox value={fromWarehouseId} onChange={handleFromWarehouseChange} options={originWarehouses} placeholder="Seleccione origen..." emptyText="Sin bodegas con stock" getLabel={w => w.name} getValue={w => w.id} renderOption={w => <div className="flex flex-col"><span className="font-semibold">{w.name}</span><span className="text-[10px] opacity-75">{fmt(w.quantity)} disp.</span></div>} />
              </div>
              <div className="space-y-1 relative z-20">
                <label className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Bodega destino</label>
                <LocalCombobox value={toWarehouseId} onChange={handleToWarehouseChange} options={destinationWarehouses} placeholder="Seleccione destino..." emptyText="Sin opciones" disabled={!fromWarehouseId} getLabel={w => w.name} getValue={w => w.id} />
              </div>
              <div className="space-y-1 relative z-10">
                <label className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Ubic. destino (Global)</label>
                <LocalCombobox value={toLocationId} onChange={setToLocationId} options={destinationLocations} placeholder="Seleccione ubicación..." emptyText="Sin ubicaciones" disabled={!toWarehouseId} getLabel={loc => `${loc.code}${loc.name ? ` - ${loc.name}` : ''}`} getValue={loc => loc.id} renderOption={loc => <div className="flex flex-col"><span className="font-mono">{loc.code}</span>{loc.name && <span className="text-[9px] opacity-75">{loc.name}</span>}</div>} />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Fecha</label>
                <div className="h-8 rounded-lg border border-theme-border bg-theme-surface px-3 flex items-center text-xs font-semibold text-theme-text min-w-[90px]">{new Date().toLocaleDateString('es-CL')}</div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Obs. general</label>
                <input value={notes} onChange={e => setNotes(e.target.value)} className={cn(erpInputClass, 'w-full h-8 px-2 text-xs')} placeholder="Opcional" />
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 flex overflow-hidden">
            {/* Buscador de Stock (Left) */}
            <section className="flex flex-col border-r border-theme-border/70" style={{ flex: '0 0 45%', minWidth: 0 }}>
              <div className="shrink-0 px-4 py-2 bg-theme-surface border-b border-theme-border/40 flex items-center gap-3">
                <div className="flex-1 relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-text-muted/50" />
                  <input value={search} onChange={e => setSearch(e.target.value)} disabled={!fromWarehouseId} placeholder={fromWarehouseId ? 'Buscar stock por SKU o producto...' : 'Seleccione origen...'} className={cn(erpInputClass, 'w-full h-8 pl-8 pr-3 text-xs')} />
                </div>
                <span className="text-[10px] font-bold text-theme-text-muted bg-theme-text/5 px-2 py-1 rounded-md">{filteredStock.length} disp.</span>
              </div>
              <div className="flex-1 overflow-auto bg-theme-text/[0.01]">
                {!fromWarehouseId ? (
                  <div className="h-full flex flex-col items-center justify-center p-6 text-center">
                    <Package className="w-8 h-8 text-theme-text-muted/30 mb-2" />
                    <p className="text-xs font-semibold text-theme-text">Seleccione bodega origen para ver stock.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-theme-border/45">
                    {filteredStock.map(item => {
                      const added = lines.some(line => stockKey(line.stock) === stockKey(item))
                      return (
                        <div key={stockKey(item)} className="p-3 hover:bg-theme-text/[0.03] transition-colors flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="font-mono font-bold text-theme-accent text-xs">{item.product_sku}</span>
                              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-theme-text/10 text-theme-text">{item.location_code}</span>
                            </div>
                            <p className="text-xs text-theme-text font-medium truncate">{item.product_description}</p>
                            <p className="text-[10px] text-theme-text-muted mt-0.5">Lote: {item.lot_number || 'N/A'} · Vence: {fmtDate(item.expiration_date)}</p>
                          </div>
                          <div className="text-right shrink-0 flex flex-col items-end gap-2">
                            <span className="text-sm font-black text-theme-accent">{fmt(item.quantity)}</span>
                            <button onClick={() => addLine(item)} disabled={added || !toWarehouseId} className="px-3 py-1 rounded-lg bg-theme-accent hover:bg-theme-accent-hover disabled:opacity-45 text-white text-[10px] font-bold transition-colors">
                              {added ? 'Agregado' : 'Agregar'}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* Líneas Seleccionadas (Right) */}
            <section className="flex flex-col flex-1 min-w-0 bg-theme-surface">
              <div className="shrink-0 px-4 py-2 border-b border-theme-border/70 flex items-center justify-between bg-theme-surface">
                <h3 className="text-xs font-bold text-theme-text flex items-center gap-2">
                  Líneas agregadas
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-theme-accent/10 text-theme-accent text-[10px] font-black">{lines.length}</span>
                </h3>
                <div className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider">
                  Total: <span className="text-sm text-theme-text ml-1">{fmt(totalQuantity)} uds</span>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                {lines.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center p-6 text-center text-theme-text-muted/60">
                    <FileText className="w-8 h-8 mb-2 opacity-40" />
                    <p className="text-xs">Sin líneas. Agregue artículos desde el stock disponible.</p>
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-theme-surface border-b border-theme-border text-[10px] uppercase tracking-wider text-theme-text-muted z-10">
                      <tr>
                        <th className="px-4 py-2 font-semibold">Producto / Lote</th>
                        <th className="px-4 py-2 font-semibold text-right">Disponible</th>
                        <th className="px-4 py-2 font-semibold text-right w-32">Mover</th>
                        <th className="px-4 py-2 font-semibold text-right w-12"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-theme-border/45">
                      {lines.map(line => {
                        const error = lineErrors.get(line.id)
                        return (
                          <tr key={line.id} className={cn("hover:bg-theme-text/[0.015] transition-colors", error && "bg-red-500/5")}>
                            <td className="px-4 py-3">
                              <p className="font-mono font-bold text-theme-accent mb-0.5">{line.stock.product_sku}</p>
                              <p className="text-theme-text font-medium truncate max-w-[250px]">{line.stock.product_description}</p>
                              <p className="text-[10px] text-theme-text-muted mt-0.5">Desde: <span className="font-mono">{line.stock.location_code}</span> · Lote: {line.stock.lot_number || 'N/A'}</p>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <span className="font-black text-theme-text-muted">{fmt(line.stock.quantity)}</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <input
                                type="number"
                                min="0"
                                step="0.0001"
                                value={line.quantity}
                                onChange={e => updateLine(line.id, { quantity: e.target.value })}
                                 className={cn(erpInputClass, 'w-full h-8 px-2 text-right text-xs font-bold')}
                              />
                              {error && <p className="text-[9px] text-red-500 mt-1 font-bold">{error}</p>}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button onClick={() => removeLine(line.id)} className="p-1.5 rounded-lg text-theme-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* ── DETALLE GUÍA EMITIDA (DETAIL) ──────────────────────────────────── */}
      {view === 'detail' && detail && (
        <div className="flex-1 flex flex-col min-h-0 animate-in slide-in-from-right-4 duration-300 bg-theme-surface print:hidden">
          <div className="px-6 py-4 border-b border-theme-border bg-theme-text/[0.015] flex items-center justify-between shrink-0">
            <div className="flex items-center gap-4">
              <button onClick={() => setView('list')} className="p-2 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h2 className="text-lg font-black text-theme-accent font-mono tracking-tight">{detail.transfer_number}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <Badge status={detail.status} />
                  <span className="text-xs text-theme-text-muted font-medium">{new Date(detail.date).toLocaleString('es-CL')}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handlePrint}
                className="px-5 py-2 rounded-xl bg-theme-text/5 hover:bg-theme-text/10 border border-theme-border text-theme-text text-sm font-bold flex items-center gap-2 transition-colors"
              >
                <Printer className="w-4 h-4" /> Imprimir Guía Final
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto p-6">
            <div className="max-w-5xl mx-auto space-y-6">
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="p-4 rounded-xl border border-theme-border bg-theme-text/[0.02]">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-1">Bodega Origen</p>
                  <p className="text-sm font-semibold text-theme-text">{detail.from_warehouse}</p>
                </div>
                <div className="p-4 rounded-xl border border-theme-border bg-theme-text/[0.02]">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-1">Bodega Destino</p>
                  <p className="text-sm font-semibold text-theme-text">{detail.to_warehouse}</p>
                </div>
                <div className="p-4 rounded-xl border border-theme-border bg-theme-text/[0.02]">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-1">Ubicación Destino</p>
                  <p className="text-sm font-mono font-bold text-theme-text">{detail.to_location}</p>
                </div>
                <div className="p-4 rounded-xl border border-theme-border bg-theme-text/[0.02]">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-1">Usuario</p>
                  <p className="text-sm font-semibold text-theme-text">{detail.created_by_name || 'Sistema'}</p>
                </div>
              </div>

              {detail.notes && (
                <div className="p-4 rounded-xl border border-theme-border bg-theme-surface">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-1">Observaciones</p>
                  <p className="text-sm text-theme-text">{detail.notes}</p>
                </div>
              )}

              <div className="border border-theme-border rounded-xl shadow-sm overflow-hidden bg-theme-surface">
                <div className="px-4 py-3 bg-theme-text/5 border-b border-theme-border flex items-center justify-between">
                  <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider">Detalle de Líneas</h3>
                  <p className="text-xs font-black text-theme-accent">{fmt(detail.total_quantity)} unidades en {detail.line_count} líneas</p>
                </div>
                <table className="w-full text-left text-xs">
                  <thead className="bg-theme-text/[0.015] border-b border-theme-border text-[10px] uppercase tracking-wider text-theme-text-muted">
                    <tr>
                      <th className="px-4 py-3 font-semibold">SKU / Producto</th>
                      <th className="px-4 py-3 font-semibold">Ubic. Origen</th>
                      <th className="px-4 py-3 font-semibold">Lote / Vence</th>
                      <th className="px-4 py-3 font-semibold text-right">Cantidad Movida</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border/50">
                    {detail.items.map(item => (
                      <tr key={item.id}>
                        <td className="px-4 py-3">
                          <p className="font-mono font-bold text-theme-accent mb-0.5">{item.product_sku}</p>
                          <p className="text-theme-text font-medium">{item.product_description}</p>
                        </td>
                        <td className="px-4 py-3 font-mono text-theme-text">{item.from_location}</td>
                        <td className="px-4 py-3 text-theme-text-muted">
                          <p>{item.lot_number || 'N/A'}</p>
                          <p className="text-[10px] mt-0.5">{fmtDate(item.expiration_date)}</p>
                        </td>
                        <td className="px-4 py-3 text-right font-black text-theme-text text-sm">{fmt(item.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* ── VISTA DE IMPRESIÓN DINÁMICA (HTML/CSS) ─────────────────────────── */}
      <div id="print-section" className="hidden print:block bg-white text-black p-8 text-sm font-sans relative">
        
        {/* Marca de agua de BORRADOR */}
        {view === 'form' && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-10 z-0">
            <h1 className="text-[120px] font-black uppercase text-red-500 transform -rotate-45 whitespace-nowrap">Borrador</h1>
          </div>
        )}

        <div className="relative z-10">
          <div className="text-center border-b-2 border-black pb-4 mb-6">
            <h1 className="text-2xl font-black uppercase">Guía Interna de Traspaso</h1>
            <p className="text-lg font-mono font-bold mt-1">
              {view === 'form' ? 'TR-BORRADOR (NO CONFIRMADO)' : detail?.transfer_number}
            </p>
          </div>
          
          <div className="grid grid-cols-2 gap-6 mb-6">
            <div className="border border-black p-4 bg-gray-50">
              <p className="font-bold text-xs uppercase mb-2 border-b border-black/20 pb-1">Datos Origen / Emisión</p>
              <table className="w-full text-xs">
                <tbody>
                  <tr><td className="py-1 font-semibold w-24">Bodega:</td><td className="py-1">{view === 'form' ? originWhName : detail?.from_warehouse}</td></tr>
                  <tr><td className="py-1 font-semibold">Fecha:</td><td className="py-1">{view === 'form' ? new Date().toLocaleString('es-CL') : detail ? new Date(detail.date).toLocaleString('es-CL') : ''}</td></tr>
                  <tr><td className="py-1 font-semibold">Operador:</td><td className="py-1">{view === 'form' ? 'Usuario Actual' : detail?.created_by_name || 'Sistema'}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="border border-black p-4 bg-gray-50">
              <p className="font-bold text-xs uppercase mb-2 border-b border-black/20 pb-1">Datos Destino</p>
              <table className="w-full text-xs">
                <tbody>
                  <tr><td className="py-1 font-semibold w-24">Bodega:</td><td className="py-1">{view === 'form' ? destWhName : detail?.to_warehouse}</td></tr>
                  <tr><td className="py-1 font-semibold">Ubicación:</td><td className="py-1 font-mono font-bold">{view === 'form' ? destLocName : detail?.to_location}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {((view === 'form' && notes) || (view === 'detail' && detail?.notes)) && (
            <div className="mb-6 border border-black p-3">
              <p className="font-bold text-xs uppercase mb-1">Observaciones generales</p>
              <p className="text-xs">{view === 'form' ? notes : detail?.notes}</p>
            </div>
          )}

          <table className="w-full text-left border-collapse border border-black text-xs">
            <thead>
              <tr className="border-b border-black bg-gray-200">
                <th className="p-2 border-r border-black font-bold uppercase">SKU</th>
                <th className="p-2 border-r border-black font-bold uppercase">Producto</th>
                <th className="p-2 border-r border-black font-bold uppercase">Ubic. Origen</th>
                <th className="p-2 border-r border-black font-bold uppercase">Lote / Vence</th>
                <th className="p-2 text-right font-bold uppercase">Cant.</th>
              </tr>
            </thead>
            <tbody>
              {view === 'form' && lines.map(line => (
                <tr key={line.id} className="border-b border-black">
                  <td className="p-2 border-r border-black font-mono font-bold">{line.stock.product_sku}</td>
                  <td className="p-2 border-r border-black">{line.stock.product_description}</td>
                  <td className="p-2 border-r border-black font-mono">{line.stock.location_code}</td>
                  <td className="p-2 border-r border-black">{line.stock.lot_number || 'N/A'}</td>
                  <td className="p-2 text-right font-bold">{fmt(Number(line.quantity) || 0)}</td>
                </tr>
              ))}
              {view === 'detail' && detail?.items.map(item => (
                <tr key={item.id} className="border-b border-black">
                  <td className="p-2 border-r border-black font-mono font-bold">{item.product_sku}</td>
                  <td className="p-2 border-r border-black">{item.product_description}</td>
                  <td className="p-2 border-r border-black font-mono">{item.from_location}</td>
                  <td className="p-2 border-r border-black">{item.lot_number || 'N/A'}</td>
                  <td className="p-2 text-right font-bold">{fmt(item.quantity)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-100">
                <td colSpan={4} className="p-2 text-right font-black uppercase border-r border-black">Total Unidades:</td>
                <td className="p-2 text-right font-black text-sm">{fmt(view === 'form' ? totalQuantity : (detail?.total_quantity || 0))}</td>
              </tr>
            </tfoot>
          </table>

          {view === 'form' && (
            <div className="mt-4 p-3 bg-red-100 border border-red-500 text-red-700 text-center font-bold uppercase text-xs">
              Este documento es un borrador preliminar. No es válido para certificar movimiento de stock hasta su emisión definitiva.
            </div>
          )}

          <div className="mt-20 grid grid-cols-2 gap-12 text-center text-xs">
            <div>
              <div className="border-t border-black pt-2 mx-12">
                <p className="font-bold uppercase">Firma Entrega</p>
                <p className="text-gray-500 mt-1">Nombre y RUT</p>
              </div>
            </div>
            <div>
              <div className="border-t border-black pt-2 mx-12">
                <p className="font-bold uppercase">Firma Recepción</p>
                <p className="text-gray-500 mt-1">Nombre y RUT</p>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
