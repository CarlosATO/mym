'use client'

import { memo, useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Save, Search, Settings2, X } from 'lucide-react'
import { toast } from 'sonner'
import { getPurchaseUnitsCatalog, saveUnitConfiguration, updatePurchaseUnitsBulk, type PurchaseUnitRow } from '@/app/actions/adquisiciones/purchase-units'

const UNITS = ['UNIDAD', 'BOLSA', 'DISPLAY', 'CAJA', 'PACK', 'SACHET']
const PAGE_SIZE = 30
const control = 'h-8 rounded border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-accent focus:ring-1 focus:ring-theme-accent/30 disabled:opacity-50'
const cellControl = `${control} w-full bg-theme-accent/[0.04]`
const button = 'inline-flex h-8 items-center justify-center gap-1 rounded border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text hover:bg-theme-text/5 disabled:cursor-not-allowed disabled:opacity-40'
const header = 'border-b border-r border-theme-border px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted'

function money(value: number | null) {
  return value == null ? '—' : value.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

export function PurchaseUnitsGrid() {
  const [rows, setRows] = useState<PurchaseUnitRow[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [supplierId, setSupplierId] = useState('ALL')
  const [unit, setUnit] = useState('ALL')
  const [configuration, setConfiguration] = useState<'ALL' | 'CONFIGURED' | 'PENDING'>('ALL')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Record<string, { unit: string; factor: string }>>({})
  const [salesDrafts, setSalesDrafts] = useState<Record<string, string>>({})
  const [bulkUnit, setBulkUnit] = useState('UNIDAD')
  const [bulkFactor, setBulkFactor] = useState('1')
  const [bulkSales, setBulkSales] = useState('')
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    getPurchaseUnitsCatalog().then(result => {
      if (!active) return
      if (result.error) toast.error(result.error)
      setRows(result.data)
      setLoading(false)
    }).catch(() => { if (active) { toast.error('No se pudo cargar el catálogo.'); setLoading(false) } })
    return () => { active = false }
  }, [])

  const suppliers = useMemo(() => Array.from(new Map(rows.filter(row => row.real_supplier_id).map(row => [row.real_supplier_id!, row.real_supplier_name ?? ''])).entries()).sort((a, b) => a[1].localeCompare(b[1])), [rows])
  const filteredRows = useMemo(() => {
    const text = query.trim().toLocaleLowerCase('es-CL')
    return rows.filter(row => {
      if (text && !`${row.sku} ${row.description}`.toLocaleLowerCase('es-CL').includes(text)) return false
      if (supplierId !== 'ALL' && row.real_supplier_id !== supplierId) return false
      if (unit !== 'ALL' && row.purchase_unit !== unit) return false
      if (configuration === 'CONFIGURED' && !row.purchase_unit) return false
      if (configuration === 'PENDING' && row.purchase_unit) return false
      return true
    })
  }, [rows, query, supplierId, unit, configuration])
  const counts = useMemo(() => {
    const products = new Map<string, boolean>()
    for (const row of rows) products.set(row.product_id, (products.get(row.product_id) ?? true) && Boolean(row.purchase_unit))
    const configured = Array.from(products.values()).filter(Boolean).length
    return { total: products.size, configured, pending: products.size - configured }
  }, [rows])
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visibleRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const selectedRows = useMemo(() => rows.filter(row => selected.has(row.row_id)), [rows, selected])
  const purchaseRows = useMemo(() => selectedRows.filter(row => row.can_edit), [selectedRows])
  const selectedProducts = useMemo(() => Array.from(new Set(selectedRows.map(row => row.product_id))), [selectedRows])

  function changePageFilter(change: () => void) { change(); setPage(1) }
  function clearFilters() { setQuery(''); setSupplierId('ALL'); setUnit('ALL'); setConfiguration('ALL'); setPage(1) }
  function editValue(row: PurchaseUnitRow) { return editing[row.row_id] ?? { unit: row.purchase_unit ?? '', factor: String(row.purchase_unit_factor) } }
  const updateDraft = useCallback((row: PurchaseUnitRow, change: Partial<{ unit: string; factor: string }>) => {
    setEditing(current => ({ ...current, [row.row_id]: { ...(current[row.row_id] ?? { unit: row.purchase_unit ?? '', factor: String(row.purchase_unit_factor) }), ...change } }))
  }, [])
  const toggleRow = useCallback((id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next }), [])
  const updateSalesDraft = useCallback((id: string, value: string) => setSalesDrafts(current => ({ ...current, [id]: value })), [])
  const saveRow = useCallback((row: PurchaseUnitRow, value: { unit: string; factor: string }, salesDraft: string) => {
    const purchaseUnit = value.unit !== (row.purchase_unit ?? '') ? value.unit : undefined
    const purchaseFactor = value.factor !== String(row.purchase_unit_factor) ? Number(value.factor) : undefined
    const salesFactor = salesDraft !== String(row.sales_unit_factor) ? Number(salesDraft) : undefined
    if (value.factor.trim() === '' || salesDraft.trim() === '') { toast.error('Ingrese factores enteros mayores o iguales a 1.'); return }
    startTransition(async () => {
      try {
      const result = await saveUnitConfiguration({ productIds: [row.product_id], mappingId: row.mapping_id ?? undefined, purchaseUnit, purchaseFactor, salesFactor })
      if ('error' in result) { toast.error(result.error); return }
      setRows(current => current.map(item => item.row_id === row.row_id || (item.product_id === row.product_id && result.salesFactor !== undefined) ? { ...item, ...(item.row_id === row.row_id ? { purchase_unit: result.purchaseUnit ?? item.purchase_unit, purchase_unit_factor: result.purchaseFactor ?? item.purchase_unit_factor } : {}), ...(item.product_id === row.product_id && result.salesFactor !== undefined ? { sales_unit_factor: result.salesFactor } : {}) } : item))
      setEditing(current => { const next = { ...current }; const draft = next[row.row_id]; if (draft && draft.unit === value.unit && draft.factor === value.factor) delete next[row.row_id]; return next })
      setSalesDrafts(current => { const next = { ...current }; if (next[row.product_id] === salesDraft) delete next[row.product_id]; return next })
      toast.success('Configuración guardada.')
      } catch { toast.error('No se pudo confirmar el guardado. Revise la conexión.') }
    })
  }, [])
  function savePurchaseBulk() {
    if (purchaseRows.length > 500) { toast.error('Seleccione como máximo 500 mapeos de compra.'); return }
    if (!purchaseRows.length || !window.confirm(`¿Confirmar la modificación de ${purchaseRows.length} productos?`)) return
    startTransition(async () => {
      try {
      const result = await updatePurchaseUnitsBulk({ mappingIds: purchaseRows.map(row => row.mapping_id!), purchaseUnit: bulkUnit, purchaseUnitFactor: Number(bulkFactor) })
      if ('error' in result) { toast.error(result.error); return }
      const ids = new Set(purchaseRows.map(row => row.row_id))
      setRows(current => current.map(row => ids.has(row.row_id) ? { ...row, purchase_unit: result.purchaseUnit, purchase_unit_factor: result.purchaseUnitFactor } : row))
      setEditing(current => { const next = { ...current }; ids.forEach(id => delete next[id]); return next })
      setSelected(current => { const next = new Set(current); ids.forEach(id => next.delete(id)); return next })
      toast.success(`${result.updated} productos actualizados.`)
      } catch { toast.error('No se pudo confirmar el guardado. Revise la conexión.') }
    })
  }
  function saveSales(ids: string[], value: string) {
    if (!value.trim()) { toast.error('Ingrese unidades por venta.'); return }
    if (ids.length > 500) { toast.error('Seleccione como máximo 500 productos.'); return }
    startTransition(async () => {
      try {
      const result = await saveUnitConfiguration({ productIds: ids, salesFactor: Number(value) })
      if ('error' in result) { toast.error(result.error); return }
      const changed = new Set(ids)
      setRows(current => current.map(row => changed.has(row.product_id) ? { ...row, sales_unit_factor: result.salesFactor! } : row))
      setSalesDrafts(current => { const next = { ...current }; ids.forEach(id => delete next[id]); return next })
      toast.success(`Unidades por venta actualizadas en ${result.updated} producto(s).`)
      } catch { toast.error('No se pudo confirmar el guardado. Revise la conexión.') }
    })
  }

  return <div className="flex h-full min-h-0 w-full flex-col gap-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="flex items-center gap-2 text-lg font-bold text-theme-text"><Settings2 className="h-5 w-5 text-theme-accent" /> Unidades de compra</h1><p className="mt-0.5 text-xs text-theme-text-muted">Presentación y unidades por compra por proveedor; unidades por venta por producto. No modifica operaciones.</p></div>
      <div className="flex flex-wrap gap-2 text-xs" title="Configurado: presentación de compra en todas las filas del producto">
        {loading && <span role="status" className="inline-flex items-center gap-1 px-2 text-theme-text-muted"><Loader2 className="h-3 w-3 animate-spin" /> Cargando catálogo...</span>}
        <span className="rounded border border-theme-border bg-theme-surface px-3 py-1.5"><strong>{counts.total}</strong> productos</span>
        <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-emerald-700"><strong>{counts.configured}</strong> configurados</span>
        <span className="rounded border border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-amber-700"><strong>{counts.pending}</strong> pendientes</span>
      </div>
    </div>

    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-theme-border bg-theme-surface p-2">
      <label className="relative min-w-[220px] flex-1"><Search className="absolute left-2.5 top-2 h-4 w-4 text-theme-text-muted" /><input aria-label="Buscar SKU o descripción" value={query} onChange={event => changePageFilter(() => setQuery(event.target.value))} placeholder="Buscar SKU o descripción" className={`${control} w-full pl-8`} /></label>
      <select aria-label="Filtrar proveedor" value={supplierId} onChange={event => changePageFilter(() => setSupplierId(event.target.value))} className={`${control} max-w-[220px]`}><option value="ALL">Todos los proveedores</option>{suppliers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select aria-label="Filtrar presentación de compra" value={unit} onChange={event => changePageFilter(() => setUnit(event.target.value))} className={control}><option value="ALL">Todas las presentaciones</option>{UNITS.map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Filtrar configuración de compra" value={configuration} onChange={event => changePageFilter(() => setConfiguration(event.target.value as typeof configuration))} className={control}><option value="ALL">Compra: todos</option><option value="CONFIGURED">Compra configurada</option><option value="PENDING">Compra pendiente</option></select>
      <button type="button" onClick={clearFilters} className={button}><X className="h-3.5 w-3.5" /> Limpiar filtros</button>
    </div>

    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-theme-border bg-theme-surface p-2 text-xs">
      <span className="font-semibold text-theme-text">Acciones masivas · {selectedRows.length} filas / {selectedProducts.length} productos</span>
      <span className="text-theme-text-muted">Presentación de compra</span><select aria-label="Presentación de compra masiva" value={bulkUnit} onChange={event => setBulkUnit(event.target.value)} className={control}>{UNITS.map(value => <option key={value}>{value}</option>)}</select>
      <input aria-label="Unidades por compra masivo" type="number" min={1} step={1} value={bulkFactor} onChange={event => setBulkFactor(event.target.value)} className={`${control} w-16 text-right`} />
      <button type="button" onClick={savePurchaseBulk} disabled={isPending || !purchaseRows.length} className={button}>Aplicar compra ({purchaseRows.length})</button>
      <span className="text-theme-text-muted">Unidades por venta</span><input aria-label="Unidades por venta masivo" type="number" min={1} step={1} value={bulkSales} onChange={event => setBulkSales(event.target.value)} className={`${control} w-16 text-right`} />
      <button type="button" onClick={() => saveSales(selectedProducts, bulkSales)} disabled={isPending || !selectedProducts.length || !bulkSales} className={button}>Aplicar unidades por venta ({selectedProducts.length})</button>
    </div>

    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-theme-border bg-theme-surface">
      {!loading && !visibleRows.length ? <div className="p-10 text-center text-sm text-theme-text-muted">No hay productos para los filtros seleccionados.</div> :
      <table className="w-full min-w-[1350px] table-fixed border-collapse text-xs">
        <colgroup><col style={{ width: 38 }} /><col style={{ width: 100 }} /><col style={{ width: '24%' }} /><col style={{ width: '17%' }} /><col style={{ width: 135 }} /><col style={{ width: 125 }} /><col style={{ width: 90 }} /><col style={{ width: 125 }} /><col style={{ width: 135 }} /><col style={{ width: 150 }} /></colgroup>
        <thead className="sticky top-0 z-10 bg-theme-surface shadow-sm"><tr>
          <th className={header}><input aria-label="Seleccionar página" type="checkbox" checked={visibleRows.length > 0 && visibleRows.every(row => selected.has(row.row_id))} onChange={event => { const checked = event.target.checked; setSelected(current => { const next = new Set(current); visibleRows.forEach(row => { if (checked) next.add(row.row_id); else next.delete(row.row_id) }); return next }) }} /></th>
          <th className={header}>SKU</th><th className={header}>Descripción</th><th className={header}>Proveedor</th><th className={`${header} text-right`}>Último costo neto unitario</th><th className={header}>Presentación de compra</th><th className={`${header} text-right`}>Unidades por compra</th><th className={header}>Unidades por venta</th><th className={header}>Estado</th><th className={header}>Acciones</th>
        </tr></thead>
        <tbody>{visibleRows.map((row, index) => {
          const purchase = editValue(row)
          const sales = salesDrafts[row.product_id] ?? String(row.sales_unit_factor)
          return <PurchaseUnitTableRow key={row.row_id} row={row} index={index} unit={purchase.unit} factor={purchase.factor} sales={sales} selected={selected.has(row.row_id)} isPending={isPending} onToggle={toggleRow} onPurchaseChange={updateDraft} onSalesChange={updateSalesDraft} onSave={saveRow} />
        })}</tbody>
      </table>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-theme-text-muted"><span>{filteredRows.length} de {rows.length} registros · página {currentPage} de {pageCount}</span><div className="flex gap-1"><button aria-label="Página anterior" type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} className={button}><ChevronLeft className="h-4 w-4" /></button><button aria-label="Página siguiente" type="button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)} className={button}><ChevronRight className="h-4 w-4" /></button></div></div>
  </div>
}

const PurchaseUnitTableRow = memo(function PurchaseUnitTableRow({ row, index, unit, factor, sales, selected, isPending, onToggle, onPurchaseChange, onSalesChange, onSave }: {
  row: PurchaseUnitRow; index: number; unit: string; factor: string; sales: string; selected: boolean; isPending: boolean
  onToggle: (id: string, checked: boolean) => void
  onPurchaseChange: (row: PurchaseUnitRow, change: Partial<{ unit: string; factor: string }>) => void
  onSalesChange: (id: string, value: string) => void
  onSave: (row: PurchaseUnitRow, value: { unit: string; factor: string }, sales: string) => void
}) {
          const dirty = unit !== (row.purchase_unit ?? '') || factor !== String(row.purchase_unit_factor) || sales !== String(row.sales_unit_factor)
          const state = row.supplier_status === 'UNRESOLVED' ? 'Revisar proveedor' : dirty ? 'Sin guardar' : !row.purchase_unit ? 'Pendiente' : 'Configurado'
          const supplierText = row.real_supplier_name ?? (row.supplier_status === 'UNRESOLVED' ? 'Proveedor no resoluble' : 'Sin proveedor asociado')
          return <tr className={`${index % 2 ? 'bg-theme-text/[0.025]' : 'bg-theme-surface'} hover:bg-theme-accent/[0.06]`}>
            <td className="border-b border-r border-theme-border/60 px-2 py-1"><input aria-label={`Seleccionar ${row.sku}`} type="checkbox" checked={selected} onChange={event => onToggle(row.row_id, event.target.checked)} /></td>
            <td title={row.sku} className="truncate border-b border-r border-theme-border/60 px-2 py-1 font-mono font-semibold text-theme-accent">{row.sku}</td>
            <td title={row.description} className="truncate border-b border-r border-theme-border/60 px-2 py-1 text-theme-text">{row.description}</td>
            <td title={supplierText} className={`truncate border-b border-r border-theme-border/60 px-2 py-1 ${row.supplier_status === 'RESOLVED' ? 'text-theme-text-muted' : 'font-semibold text-amber-600'}`}>{supplierText}</td>
            <td className="border-b border-r border-theme-border/60 px-2 py-1 text-right tabular-nums text-theme-text-muted">{money(row.last_purchase_unit_cost)}</td>
            <td className="border-b border-r border-theme-border/60 px-1 py-1">{row.can_edit ? <select aria-label={`Presentación de compra ${row.sku}`} value={unit} onChange={event => onPurchaseChange(row, { unit: event.target.value })} className={cellControl}><option value="">Pendiente</option>{UNITS.map(value => <option key={value}>{value}</option>)}</select> : <span className="px-1 text-theme-text-muted">—</span>}</td>
            <td className="border-b border-r border-theme-border/60 px-1 py-1">{row.can_edit ? <input aria-label={`Unidades por compra ${row.sku}`} type="number" min={1} step={1} value={factor} onChange={event => onPurchaseChange(row, { factor: event.target.value })} className={`${cellControl} text-right tabular-nums`} /> : <span className="block px-1 text-right text-theme-text-muted">—</span>}</td>
            <td className="border-b border-r border-theme-border/60 px-1 py-1"><input aria-label={`Unidades por venta ${row.sku}`} type="number" min={1} step={1} value={sales} onChange={event => onSalesChange(row.product_id, event.target.value)} className={`${cellControl} text-right tabular-nums`} /></td>
            <td className="border-b border-r border-theme-border/60 px-2 py-1"><span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${state === 'Configurado' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700'}`}>{state}</span>{dirty && state === 'Revisar proveedor' && <span className="ml-1 text-amber-700">Sin guardar</span>}</td>
            <td className="border-b border-theme-border/60 px-1 py-1"><button type="button" disabled={isPending || !dirty} onClick={() => onSave(row, { unit, factor }, sales)} className={`${button} h-7 px-1.5`}><Save className="h-3 w-3" /> Guardar</button></td>
          </tr>
})
