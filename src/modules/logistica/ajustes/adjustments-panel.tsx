'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { getProducts } from '@/app/actions/adquisiciones/products'
import type { Product } from '@/app/actions/adquisiciones/products'
import { createStockAdjustment, getStockAdjustmentDetails, getStockAdjustments, type StockAdjustment, type StockAdjustmentItem } from '@/app/actions/logistica/ajustes'
import { getTransferDestinations, getTransferStockOptions, getTransferWarehouses, type TransferDestinationLocation, type TransferStockOption, type TransferWarehouse } from '@/app/actions/logistica/traspasos'
import { erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import { AdjustmentCompactList } from './components/adjustment-compact-list'
import { AdjustmentDetailPanel } from './components/adjustment-detail-panel'
import { AdjustmentPrintView } from './components/adjustment-print-view'
import { AdjustmentsTrayTable } from './components/adjustments-tray-table'
import { NewAdjustmentForm } from './components/new-adjustment-form'
import type { AdjustmentDetailCache, AdjustmentLine, FilterTab } from './types'
import { formatDate, formatQty } from './utils/adjustment-formatters'

export function AdjustmentsPanel() {
  const [view, setView] = useState<'list' | 'new' | 'print'>('list')
  const [loading, setLoading] = useState(true)
  const [adjustments, setAdjustments] = useState<StockAdjustment[]>([])
  const [search, setSearch] = useState('')
  const [filterTab, setFilterTab] = useState<FilterTab>('ALL')
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [detailAdjId, setDetailAdjId] = useState<string | null>(null)
  const detailCache = useRef<AdjustmentDetailCache>({})

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedAdjustment, setSelectedAdjustment] = useState<{ adjustment: StockAdjustment | null; items: StockAdjustmentItem[] }>({ adjustment: null, items: [] })

  const [type, setType] = useState<'INITIAL' | 'POSITIVE' | 'NEGATIVE'>('POSITIVE')
  const [reason, setReason] = useState('Carga inicial de inventario')
  const [notes, setNotes] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [lines, setLines] = useState<AdjustmentLine[]>([])
  const [warehouses, setWarehouses] = useState<TransferWarehouse[]>([])
  const [locations, setLocations] = useState<TransferDestinationLocation[]>([])
  const [stockOptions, setStockOptions] = useState<TransferStockOption[]>([])
  const [allProducts, setAllProducts] = useState<Product[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadAdjustments = useCallback(async () => {
    if (process.env.NODE_ENV === 'development') console.time('loadAdjustments:frontend')
    setLoading(true)
    const data = await getStockAdjustments()
    setAdjustments(data)
    setLoading(false)
    if (process.env.NODE_ENV === 'development') console.timeEnd('loadAdjustments:frontend')
  }, [])

  useEffect(() => {
    if (view === 'list') loadAdjustments()
  }, [view, loadAdjustments])

  useEffect(() => {
    if (view === 'new') {
      getTransferWarehouses().then(setWarehouses)
      getTransferStockOptions().then(setStockOptions)
      getProducts({}).then(res => setAllProducts(res.data))
    }
  }, [view])

  useEffect(() => {
    if (warehouseId && view === 'new') {
      let cancelled = false
      getTransferDestinations(warehouseId).then(data => {
        if (!cancelled) setLocations(data.filter(loc => loc.warehouse_id === warehouseId))
      })
      setLines([])
      return () => { cancelled = true }
    }
    setLocations([])
    setLines([])
  }, [warehouseId, view])

  useEffect(() => {
    if (view === 'print' && selectedId) {
      const cached = detailCache.current[selectedId]
      if (cached) {
        setSelectedAdjustment({ adjustment: cached.adjustment, items: cached.items })
        return
      }
      getStockAdjustmentDetails(selectedId).then(data => {
        setSelectedAdjustment(data)
        if (data.adjustment) detailCache.current[selectedId] = { adjustment: data.adjustment, items: data.items }
      })
    }
  }, [view, selectedId])

  const filteredAdjustments = useMemo(() => {
    let result = adjustments
    if (filterTab === 'POSITIVE') result = result.filter(a => a.adjustment_type === 'POSITIVE' || a.adjustment_type === 'INITIAL')
    if (filterTab === 'NEGATIVE') result = result.filter(a => a.adjustment_type === 'NEGATIVE')
    if (filterTab === 'COMPLETED') result = result.filter(a => a.status === 'COMPLETED')
    if (search.trim()) {
      const s = search.toLowerCase()
      result = result.filter(a => a.adjustment_number.toLowerCase().includes(s) || a.reason.toLowerCase().includes(s) || a.warehouse_name?.toLowerCase().includes(s) || a.created_by_name?.toLowerCase().includes(s))
    }
    return result
  }, [adjustments, search, filterTab])

  const counts = useMemo(() => ({
    all: adjustments.length,
    positive: adjustments.filter(a => a.adjustment_type === 'POSITIVE' || a.adjustment_type === 'INITIAL').length,
    negative: adjustments.filter(a => a.adjustment_type === 'NEGATIVE').length,
    completed: adjustments.filter(a => a.status === 'COMPLETED').length,
  }), [adjustments])

  useEffect(() => {
    if (detailAdjId && !filteredAdjustments.find(a => a.id === detailAdjId)) setDetailAdjId(null)
  }, [filteredAdjustments, detailAdjId])

  const productOptions = useMemo(() => allProducts.map(p => ({ value: p.id, label: `[${p.sku}] ${p.description}` })), [allProducts])
  const locationOptions = useMemo(() => locations.filter(loc => loc.warehouse_id === warehouseId).map(loc => ({ value: loc.id, label: `${loc.code}${loc.name ? ` - ${loc.name}` : ''}` })), [locations, warehouseId])
  const stockOptionsForWarehouse = useMemo(() => stockOptions.filter(s => s.warehouse_id === warehouseId).map(s => ({ value: `${s.product_id}|${s.location_id || 'null'}|${s.lot_number || 'null'}|${s.expiration_date || 'null'}`, label: `[${s.product_sku}] ${s.product_description} | ${s.location_code || 'S/U'}${s.lot_number ? ` | Lote ${s.lot_number}` : ''}${s.expiration_date ? ` | Vence ${formatDate(s.expiration_date)}` : ''} | ${formatQty(s.quantity)} disp.` })), [stockOptions, warehouseId])

  function openNewAdjustment() {
    setType('POSITIVE')
    setReason('Carga inicial de inventario')
    setNotes('')
    setWarehouseId('')
    setLines([])
    setError(null)
    setView('new')
  }

  function addLine() {
    setLines(prev => [...prev, { id: crypto.randomUUID(), product_id: '', product_sku: '', product_description: '', location_id: '', location_code: '', lot_number: '', expiration_date: '', quantity: '', unit_cost: '', notes: '', available_stock: 0 }])
  }

  function updateLine(id: string, field: keyof AdjustmentLine, value: string) {
    setLines(prev => prev.map(line => {
      if (line.id !== id) return line
      const updated = { ...line, [field]: value }
      if (field === 'product_id' && type !== 'NEGATIVE') {
        const product = allProducts.find(p => p.id === value)
        if (product) {
          updated.product_sku = product.sku
          updated.product_description = product.description
        }
      }
      if (field === 'location_id') {
        const location = locations.find(loc => loc.id === value && loc.warehouse_id === warehouseId)
        updated.location_code = location?.code || ''
      }
      return updated
    }))
  }

  function selectStockForNegative(id: string, stockKeyStr: string) {
    if (!stockKeyStr) return
    const [pId, lId, lot, exp] = stockKeyStr.split('|')
    const stockItem = stockOptions.find(s => s.product_id === pId && s.warehouse_id === warehouseId && (s.location_id || 'null') === lId && (s.lot_number || 'null') === lot && (s.expiration_date || 'null') === exp)
    if (!stockItem) return
    setLines(prev => prev.map(line => line.id === id ? { ...line, product_id: stockItem.product_id, product_sku: stockItem.product_sku, product_description: stockItem.product_description, location_id: stockItem.location_id || '', location_code: stockItem.location_code || '', lot_number: stockItem.lot_number || '', expiration_date: stockItem.expiration_date || '', unit_cost: stockItem.unit_cost?.toString() || '', available_stock: stockItem.quantity } : line))
  }

  async function emitAdjustment() {
    setError(null)
    setSuccessMessage(null)
    if (!warehouseId) return setError('Debe seleccionar una bodega')
    if (lines.length === 0) return setError('Debe agregar al menos una línea')
    if (reason === 'Otro' && !notes.trim()) return setError('Debe agregar una observación para el motivo Otro')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const quantity = Number(line.quantity)
      if (!line.product_id) return setError(`Línea ${i + 1}: Debe seleccionar producto`)
      if (!line.location_id) return setError(`Línea ${i + 1}: Debe seleccionar ubicación`)
      if (isNaN(quantity) || quantity <= 0) return setError(`Línea ${i + 1}: Cantidad inválida`)
      if (type === 'NEGATIVE' && quantity > line.available_stock) return setError(`Línea ${i + 1}: Cantidad excede el stock disponible (${line.available_stock})`)
    }
    setSaving(true)
    const res = await createStockAdjustment({ type, reason, warehouse_id: warehouseId, notes, items: lines.map(line => ({ product_id: line.product_id, location_id: line.location_id, lot_number: line.lot_number || undefined, expiration_date: line.expiration_date || undefined, quantity: Number(line.quantity), unit_cost: line.unit_cost ? Number(line.unit_cost) : undefined, notes: line.notes })) })
    if (!res.success) {
      setError(res.error || 'Error al emitir ajuste')
      setSaving(false)
      return
    }
    setSuccessMessage(res.message || `Ajuste emitido correctamente ${res.adjustment_number || ''}`.trim())
    await loadAdjustments()
    setSaving(false)
    setView('list')
  }

  if (view === 'new') {
    return <NewAdjustmentForm type={type} setType={setType} reason={reason} setReason={setReason} notes={notes} setNotes={setNotes} warehouseId={warehouseId} setWarehouseId={setWarehouseId} lines={lines} warehouses={warehouses} locations={locations} productOptions={productOptions} locationOptions={locationOptions} stockOptionsForWarehouse={stockOptionsForWarehouse} saving={saving} error={error} onBack={() => setView('list')} onAddLine={addLine} onRemoveLine={id => setLines(prev => prev.filter(line => line.id !== id))} onUpdateLine={updateLine} onSelectStockForNegative={selectStockForNegative} onEmit={emitAdjustment} />
  }

  if (view === 'print') {
    const { adjustment, items } = selectedAdjustment
    if (!adjustment) return null
    return <AdjustmentPrintView adjustment={adjustment} items={items} onBack={() => setView('list')} onPrint={() => window.print()} />
  }

  const detailSummary = detailAdjId ? filteredAdjustments.find(a => a.id === detailAdjId) ?? null : null
  if (!detailSummary) {
    return <div className="flex flex-col h-full overflow-hidden bg-theme-surface animate-in fade-in duration-300"><AdjustmentsTrayTable adjustments={adjustments} loading={loading} search={search} setSearch={setSearch} filterTab={filterTab} setFilterTab={setFilterTab} counts={counts} filteredAdjustments={filteredAdjustments} onOpenDetail={a => setDetailAdjId(a.id)} onNewAdjustment={openNewAdjustment} successMessage={successMessage} /></div>
  }

  return (
    <div className="flex h-full overflow-hidden bg-theme-surface animate-in fade-in duration-300">
      <div className="w-[300px] shrink-0 flex flex-col bg-theme-text/[0.01] border-r border-theme-border">
        <div className="shrink-0 px-3 py-2.5 border-b border-theme-border/60 bg-theme-text/[0.02] flex items-center gap-2">
          <div className="relative flex-1"><Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-theme-text-muted/50" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..." className={cn(erpInputClass, 'w-full h-7 pl-7 pr-2 rounded-md text-[11px]')} /></div>
          <button onClick={openNewAdjustment} title="Nuevo Ajuste" className="p-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white transition-colors shrink-0"><Plus className="w-3.5 h-3.5" /></button>
        </div>
        <AdjustmentCompactList filteredAdjustments={filteredAdjustments} selectedId={detailAdjId!} onSelect={a => setDetailAdjId(a.id)} />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden"><AdjustmentDetailPanel key={detailSummary.id} summary={detailSummary} cachedDetail={detailCache.current[detailSummary.id] ?? null} onClose={() => setDetailAdjId(null)} onDetailLoaded={(id, data) => { detailCache.current[id] = data }} onPrint={id => { setSelectedId(id); setView('print') }} /></div>
    </div>
  )
}
