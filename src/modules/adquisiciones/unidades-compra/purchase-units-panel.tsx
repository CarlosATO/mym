'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Check, ChevronLeft, ChevronRight, Loader2, Save, Search, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { getPurchaseUnitsCatalog, updatePurchaseUnit, updatePurchaseUnitsBulk, type PurchaseUnitRow } from '@/app/actions/adquisiciones/purchase-units'
import { cn } from '@/lib/utils'
import { erpInputClass, erpSelectClass } from '@/lib/form-styles'

const UNITS = ['UNIDAD', 'BOLSA', 'DISPLAY', 'CAJA', 'PACK', 'SACHET']
const PAGE_SIZE = 30

function formatCost(value: number | null) {
  return value == null ? '—' : value.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

export function PurchaseUnitsPanel() {
  const [rows, setRows] = useState<PurchaseUnitRow[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [supplierId, setSupplierId] = useState('ALL')
  const [unit, setUnit] = useState('ALL')
  const [configuration, setConfiguration] = useState<'ALL' | 'CONFIGURED' | 'PENDING'>('ALL')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Record<string, { unit: string; factor: string }>>({})
  const [bulkUnit, setBulkUnit] = useState('UNIDAD')
  const [bulkFactor, setBulkFactor] = useState('1')
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    getPurchaseUnitsCatalog().then(result => {
      if (!active) return
      if (result.error) toast.error(result.error)
      setRows(result.data)
      setLoading(false)
    })
    return () => { active = false }
  }, [])

  const suppliers = useMemo(() => Array.from(new Map(rows.filter(row => row.real_supplier_id).map(row => [row.real_supplier_id, row.real_supplier_name])).entries()).sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? '')), [rows])
  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('es-CL')
    return rows.filter(row => {
      if (normalized && !`${row.sku} ${row.description}`.toLocaleLowerCase('es-CL').includes(normalized)) return false
      if (supplierId !== 'ALL' && row.real_supplier_id !== supplierId) return false
      if (unit !== 'ALL' && row.purchase_unit !== unit) return false
      if (configuration === 'CONFIGURED' && !row.purchase_unit) return false
      if (configuration === 'PENDING' && row.purchase_unit) return false
      return true
    })
  }, [rows, query, supplierId, unit, configuration])
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))
  const visibleRows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const editableVisible = visibleRows.filter(row => row.can_edit)
  const selectedRows = rows.filter(row => selected.has(row.row_id) && row.can_edit)

  function editValue(row: PurchaseUnitRow) {
    return editing[row.row_id] ?? { unit: row.purchase_unit ?? 'UNIDAD', factor: String(row.purchase_unit_factor || 1) }
  }

  function toggle(rowId: string) {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })
  }

  function saveRow(row: PurchaseUnitRow) {
    const value = editValue(row)
    startTransition(async () => {
      const result = await updatePurchaseUnit({ mappingId: row.mapping_id!, purchaseUnit: value.unit, purchaseUnitFactor: Number(value.factor) })
      if ('error' in result) { toast.error(result.error); return }
      setRows(current => current.map(item => item.row_id === row.row_id ? { ...item, purchase_unit: value.unit, purchase_unit_factor: Number(value.factor) } : item))
      toast.success('Unidad de compra guardada.')
    })
  }

  function saveBulk() {
    if (selectedRows.length === 0) return
    if (!window.confirm(`¿Confirmar la modificación de ${selectedRows.length} productos?`)) return
    startTransition(async () => {
      const result = await updatePurchaseUnitsBulk({ mappingIds: selectedRows.map(row => row.mapping_id!), purchaseUnit: bulkUnit, purchaseUnitFactor: Number(bulkFactor) })
      if ('error' in result) { toast.error(result.error); return }
      const ids = new Set(selectedRows.map(row => row.row_id))
      setRows(current => current.map(row => ids.has(row.row_id) ? { ...row, purchase_unit: bulkUnit, purchase_unit_factor: Number(bulkFactor) } : row))
      setSelected(new Set())
      toast.success(`${selectedRows.length} productos actualizados.`)
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-theme-text"><Settings2 className="h-5 w-5 text-theme-accent" /> Unidades de compra</h1>
          <p className="mt-1 text-xs text-theme-text-muted">Configura la presentación comercial por producto y proveedor. Esta configuración todavía no altera las órdenes de compra.</p>
        </div>
        <span className="rounded-full border border-theme-border px-3 py-1 text-[11px] text-theme-text-muted">{filteredRows.length} registros</span>
      </div>

      <div className="grid gap-2 rounded-xl border border-theme-border bg-theme-surface p-3 md:grid-cols-4">
        <label className="relative md:col-span-1"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted" /><input value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} placeholder="Buscar SKU o descripción" className={cn(erpInputClass, 'h-9 w-full pl-8 text-xs')} /></label>
        <select value={supplierId} onChange={event => { setSupplierId(event.target.value); setPage(1) }} className={cn(erpSelectClass, 'h-9 text-xs')}><option value="ALL">Todos los proveedores</option>{suppliers.map(([id, name]) => <option key={id} value={id!}>{name}</option>)}</select>
        <select value={unit} onChange={event => { setUnit(event.target.value); setPage(1) }} className={cn(erpSelectClass, 'h-9 text-xs')}><option value="ALL">Todas las unidades</option>{UNITS.map(value => <option key={value} value={value}>{value}</option>)}</select>
        <select value={configuration} onChange={event => { setConfiguration(event.target.value as typeof configuration); setPage(1) }} className={cn(erpSelectClass, 'h-9 text-xs')}><option value="ALL">Configurados y pendientes</option><option value="CONFIGURED">Configurados</option><option value="PENDING">Pendientes</option></select>
      </div>

      {selectedRows.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-theme-accent/30 bg-theme-accent/[0.04] p-3"><span className="text-xs font-semibold text-theme-text">{selectedRows.length} seleccionados</span><select value={bulkUnit} onChange={event => setBulkUnit(event.target.value)} className={cn(erpSelectClass, 'h-8 text-xs')}><option disabled value="">Unidad</option>{UNITS.map(value => <option key={value} value={value}>{value}</option>)}</select><input type="number" min={1} step={1} value={bulkFactor} onChange={event => setBulkFactor(event.target.value)} className={cn(erpInputClass, 'h-8 w-24 text-xs')} /><button type="button" onClick={saveBulk} disabled={isPending} className="inline-flex h-8 items-center gap-1 rounded-md bg-theme-accent px-3 text-xs font-semibold text-white disabled:opacity-50"><Save className="h-3.5 w-3.5" /> Aplicar a seleccionados</button></div>}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-theme-border bg-theme-surface">
        {loading ? <div className="p-10 text-center text-sm text-theme-text-muted"><Loader2 className="mx-auto h-5 w-5 animate-spin" /> Cargando catálogo...</div> : visibleRows.length === 0 ? <div className="p-10 text-center text-sm text-theme-text-muted">No hay productos para los filtros seleccionados.</div> : <table className="w-full min-w-[1050px] text-xs"><thead className="sticky top-0 z-10 bg-theme-surface"><tr className="border-b border-theme-border text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><th className="w-10 px-3 py-2"><input type="checkbox" checked={editableVisible.length > 0 && editableVisible.every(row => selected.has(row.row_id))} onChange={event => setSelected(current => { const next = new Set(current); editableVisible.forEach(row => event.target.checked ? next.add(row.row_id) : next.delete(row.row_id)); return next })} /></th><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Descripción</th><th className="px-3 py-2">Proveedor real</th><th className="px-3 py-2 text-right">Último costo neto unitario</th><th className="px-3 py-2">Unidad de compra</th><th className="px-3 py-2">Factor</th><th className="px-3 py-2">Unidad de venta</th><th className="px-3 py-2">Acción</th></tr></thead><tbody>{visibleRows.map(row => { const value = editValue(row); return <tr key={row.row_id} className="border-b border-theme-border/40 hover:bg-theme-text/[0.02]"><td className="px-3 py-2">{row.can_edit && <input type="checkbox" checked={selected.has(row.row_id)} onChange={() => toggle(row.row_id)} />}</td><td className="px-3 py-2 font-mono font-semibold text-theme-accent">{row.sku}</td><td className="max-w-[280px] px-3 py-2 text-theme-text">{row.description}</td><td className="px-3 py-2">{row.real_supplier_name ?? <span className="font-semibold text-amber-600">Sin proveedor asociado</span>}</td><td className="px-3 py-2 text-right text-theme-text-muted">{formatCost(row.last_purchase_unit_cost)}</td><td className="px-3 py-2">{row.can_edit ? <select value={value.unit} onChange={event => setEditing(current => ({ ...current, [row.row_id]: { ...value, unit: event.target.value } }))} className={cn(erpSelectClass, 'h-8 w-28 text-xs')}>{UNITS.map(option => <option key={option} value={option}>{option}</option>)}</select> : <span className="text-theme-text-muted">Pendiente de proveedor</span>}</td><td className="px-3 py-2">{row.can_edit ? <input type="number" min={1} step={1} value={value.factor} onChange={event => setEditing(current => ({ ...current, [row.row_id]: { ...value, factor: event.target.value } }))} className={cn(erpInputClass, 'h-8 w-20 text-xs')} /> : '—'}</td><td className="px-3 py-2 text-theme-text-muted">{row.sales_unit ?? '—'}</td><td className="px-3 py-2">{row.can_edit && <button type="button" onClick={() => saveRow(row)} disabled={isPending} className="inline-flex items-center gap-1 rounded-md border border-theme-border px-2 py-1 text-[10px] font-semibold text-theme-accent hover:bg-theme-accent/10 disabled:opacity-50"><Check className="h-3 w-3" /> Guardar</button>}</td></tr>})}</tbody></table>}
      </div>

      <div className="flex items-center justify-between text-xs text-theme-text-muted"><span>Página {page} de {pageCount}</span><div className="flex gap-1"><button type="button" disabled={page <= 1} onClick={() => setPage(current => current - 1)} className="rounded border border-theme-border p-1.5 disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5" /></button><button type="button" disabled={page >= pageCount} onClick={() => setPage(current => current + 1)} className="rounded border border-theme-border p-1.5 disabled:opacity-40"><ChevronRight className="h-3.5 w-3.5" /></button></div></div>
    </div>
  )
}
