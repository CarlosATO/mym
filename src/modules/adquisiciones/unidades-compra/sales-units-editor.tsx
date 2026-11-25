'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { getClassifiers } from '@/app/actions/adquisiciones/products'
import { updateSalesUnits, type PurchaseUnitRow } from '@/app/actions/adquisiciones/purchase-units'
import { erpSelectClass } from '@/lib/form-styles'

export function SalesUnitsEditor({ rows, onSaved }: {
  rows: PurchaseUnitRow[]
  onSaved: (productIds: string[], unit: string) => void
}) {
  const [options, setOptions] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [bulkUnit, setBulkUnit] = useState('')
  const [pending, startTransition] = useTransition()
  const products = useMemo(() => Array.from(new Map(rows.map(row => [row.product_id, row])).values()), [rows])

  useEffect(() => {
    let active = true
    getClassifiers('SALES_UNIT').then(items => { if (active) setOptions(Array.from(new Set(items.map(item => item.name)))) })
    return () => { active = false }
  }, [])

  function save(ids: string[], unit: string) {
    if (!unit) { toast.error('Seleccione una unidad de venta.'); return }
    if (ids.length > 500) { toast.error('Seleccione como máximo 500 productos.'); return }
    startTransition(async () => {
      const result = await updateSalesUnits({ productIds: ids, salesUnit: unit })
      if ('error' in result) { toast.error(result.error); return }
      onSaved(ids, result.salesUnit)
      setDrafts(current => { const next = { ...current }; ids.forEach(id => delete next[id]); return next })
      setSelected(current => { const next = new Set(current); ids.forEach(id => next.delete(id)); return next })
      toast.success(`Unidad de venta actualizada en ${result.updated} producto(s).`)
    })
  }

  return <details className="rounded-xl border border-theme-border bg-theme-surface p-3">
    <summary className="cursor-pointer text-xs font-semibold text-theme-text">Administrar unidades de venta · productos de esta página</summary>
    <p className="my-2 text-xs text-theme-text-muted">La unidad de venta se guarda por producto, independientemente del proveedor y de la unidad de compra.</p>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>{selected.size} productos seleccionados</span>
      <select aria-label="Unidad de venta masiva" value={bulkUnit} onChange={event => setBulkUnit(event.target.value)} className={erpSelectClass}>
        <option value="">Seleccionar unidad de venta</option>{options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      <button type="button" disabled={pending || !selected.size || !bulkUnit} onClick={() => save(Array.from(selected), bulkUnit)} className="rounded bg-theme-accent px-3 py-2 text-white disabled:opacity-50">Aplicar unidad de venta</button>
    </div>
    <div className="mt-2 max-h-64 overflow-auto">
      <table className="w-full text-left text-xs"><thead><tr><th><input aria-label="Seleccionar productos de esta página" type="checkbox" checked={products.length > 0 && products.every(row => selected.has(row.product_id))} onChange={event => setSelected(current => { const next = new Set(current); products.forEach(row => event.target.checked ? next.add(row.product_id) : next.delete(row.product_id)); return next })} /></th><th>SKU</th><th>Producto</th><th>Unidad de venta</th><th>Acción</th></tr></thead><tbody>
        {products.map(row => {
          const value = drafts[row.product_id] ?? row.sales_unit ?? ''
          return <tr key={row.product_id} className="border-t border-theme-border"><td><input aria-label={`Seleccionar ${row.sku}`} type="checkbox" checked={selected.has(row.product_id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(row.product_id); else next.delete(row.product_id); return next })} /></td><td>{row.sku}</td><td>{row.description}</td><td><select aria-label={`Unidad de venta ${row.sku}`} value={value} onChange={event => setDrafts(current => ({ ...current, [row.product_id]: event.target.value }))} className={erpSelectClass}><option value="">Pendiente de configuración</option>{value && !options.includes(value) && <option value={value}>{value}</option>}{options.map(option => <option key={option} value={option}>{option}</option>)}</select>{!row.sales_unit && <span className="ml-2 font-semibold text-amber-600">Pendiente</span>}</td><td><button type="button" disabled={pending || !value || value === row.sales_unit} onClick={() => save([row.product_id], value)} className="rounded border border-theme-border px-2 py-1 disabled:opacity-50">Guardar</button></td></tr>
        })}
      </tbody></table>
    </div>
  </details>
}
