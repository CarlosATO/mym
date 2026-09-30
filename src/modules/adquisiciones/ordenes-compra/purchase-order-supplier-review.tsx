'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ClipboardCheck, Loader2, Plus, Save, Search, Trash2 } from 'lucide-react'
import {
  getPurchaseOrderSupplierReviewComparison,
  updateSentPurchaseOrderReview,
  type PurchaseOrderReviewChangedField,
  type PurchaseOrderReviewComparisonLine,
  type PurchaseOrderReviewItem,
  type PurchaseOrderSupplierReviewComparison,
  type SupplierReviewData,
} from '@/app/actions/adquisiciones/purchase-orders'
import { getPurchaseOrderProductCatalogCached } from './purchase-order-product-cache'
import type { PurchaseOrderCatalogProduct } from '@/app/actions/adquisiciones/products'

type EditableReviewItem = Omit<PurchaseOrderReviewItem, 'item_id'> & { item_id: string | null }

interface PurchaseOrderSupplierReviewProps {
  poId: string
  onBack: () => void
  onSaved?: () => void | Promise<void>
}

const inputClass = 'h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15'

function currency(value: number | null | undefined, code: string) {
  return Number(value ?? 0).toLocaleString('es-CL', { style: 'currency', currency: code })
}

function dateValue(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(`${value.slice(0, 10)}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('es-CL')
}

function statusStyle(status: string) {
  if (status === 'MODIFICADA') return 'border-[#AC9C8D]/50 bg-[#AC9C8D]/15 text-[#72383D]'
  if (status === 'AGREGADA') return 'border-[#72383D]/30 bg-[#72383D]/10 text-[#72383D]'
  return 'border-[#D1C7BD] bg-[#EFE9E1] text-[#6D625B]'
}

function statusLabel(status: string) {
  return status === 'SIN_CAMBIOS' ? 'Sin cambios' : status === 'MODIFICADA' ? 'Modificada' : status === 'AGREGADA' ? 'Agregada' : 'Eliminada'
}

function changedValue(changes: PurchaseOrderReviewChangedField[], field: string) {
  return changes.find(change => change.field === field)?.original
}

function displayValue(value: unknown, field: string, code: string) {
  if (value === null || value === undefined || value === '') return '—'
  if (field === 'unit_price') return currency(Number(value), code)
  if (field === 'quantity') return Number(value).toLocaleString('es-CL')
  if (field.endsWith('_percent')) return `${value}%`
  return String(value)
}

function reviewLineMap(comparison: PurchaseOrderReviewComparisonLine[]) {
  return new Map(comparison.map(line => [line.item_id, line]))
}

function toEditable(item: PurchaseOrderReviewItem): EditableReviewItem {
  return { ...item, item_id: item.item_id || null }
}

export function PurchaseOrderSupplierReview({ poId, onBack, onSaved }: PurchaseOrderSupplierReviewProps) {
  const [comparison, setComparison] = useState<PurchaseOrderSupplierReviewComparison | null>(null)
  const [lines, setLines] = useState<EditableReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalog, setCatalog] = useState<PurchaseOrderCatalogProduct[]>([])
  const [catalogQuery, setCatalogQuery] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<PurchaseOrderCatalogProduct | null>(null)
  const [newQuantity, setNewQuantity] = useState('1')
  const [newUnitPrice, setNewUnitPrice] = useState('0')
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function loadComparison() {
    setLoading(true)
    setError('')
    const result = await getPurchaseOrderSupplierReviewComparison(poId)
    if ('error' in result && result.error) {
      setError(result.error)
      setLoading(false)
      return
    }
    if ('data' in result && result.data) {
      setComparison(result.data)
      setLines(result.data.current.items.map(toEditable))
      setDirty(false)
    }
    setLoading(false)
  }

  useEffect(() => { void loadComparison() }, [poId])

  const statuses = useMemo(() => reviewLineMap(comparison?.comparison ?? []), [comparison])
  const removedLines = comparison?.comparison.filter(line => line.comparison_status === 'ELIMINADA') ?? []
  const visibleProducts = useMemo(() => {
    const query = catalogQuery.trim().toLocaleLowerCase('es-CL')
    if (!query) return catalog.slice(0, 8)
    return catalog.filter(product => [product.sku, product.description, product.barcode ?? ''].some(value => value.toLocaleLowerCase('es-CL').includes(query))).slice(0, 8)
  }, [catalog, catalogQuery])

  const preview = useMemo(() => lines.reduce((totals, line) => {
    const base = line.quantity * line.unit_price
    const discount = base * (line.discount_percent || 0) / 100
    const tax = (base - discount) * (line.tax_rate || 0) / 100
    totals.net += base - discount
    totals.discount += discount
    totals.tax += tax
    totals.total += base - discount + tax
    return totals
  }, { net: 0, discount: 0, tax: 0, total: 0 }), [lines])

  function updateLine(itemId: string | null, field: 'quantity' | 'unit_price' | 'discount_percent' | 'tax_rate', value: string) {
    const numeric = Number(value)
    setLines(current => current.map(line => line.item_id === itemId ? { ...line, [field]: Number.isFinite(numeric) ? numeric : 0 } : line))
    setDirty(true)
  }

  function removeLine(itemId: string | null) {
    setLines(current => current.filter(line => line.item_id !== itemId))
    setDirty(true)
  }

  async function openCatalog() {
    setCatalogLoading(true)
    try {
      setCatalog(await getPurchaseOrderProductCatalogCached())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar el catálogo.')
    } finally {
      setCatalogLoading(false)
    }
  }

  function addProduct() {
    if (!selectedProduct) return
    const quantity = Number(newQuantity)
    const unitPrice = Number(newUnitPrice)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('La cantidad debe ser mayor que cero.')
      return
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setError('El precio unitario no puede ser negativo.')
      return
    }
    setLines(current => [...current, {
      item_id: null,
      line_number: current.length + 1,
      item_type: 'PRODUCT',
      product_id: selectedProduct.id,
      sku: selectedProduct.sku,
      product_description: selectedProduct.description,
      unit: selectedProduct.unit_of_measure,
      quantity,
      unit_price: unitPrice,
      discount_percent: 0,
      discount_amount: 0,
      tax_rate: selectedProduct.tax_rate,
      tax_amount: 0,
      line_total: 0,
      notes: null,
    }])
    setSelectedProduct(null)
    setCatalogQuery('')
    setDirty(true)
    setError('')
  }

  async function saveReview() {
    if (saving) return
    if (lines.length === 0) {
      setError('La orden debe conservar al menos una línea. Si el proveedor rechazó todo el pedido, cancela la OC.')
      return
    }
    setSaving(true)
    setError('')
    const payload: SupplierReviewData = {
      items: lines.map(line => ({
        item_id: line.item_id,
        item_type: line.item_type,
        product_id: line.product_id,
        quantity: line.quantity,
        unit_price: line.unit_price,
        discount_percent: line.discount_percent,
        tax_rate: line.tax_rate,
        notes: line.notes,
      })),
    }
    const result = await updateSentPurchaseOrderReview(poId, payload)
    if ('error' in result && result.error) {
      setError(result.error)
      setSaving(false)
      return
    }
    await loadComparison()
    setMessage('Revisión guardada')
    await onSaved?.()
    setSaving(false)
  }

  function leave() {
    if (dirty && !confirm('Hay cambios sin guardar. ¿Deseas salir sin guardarlos?')) return
    onBack()
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center bg-[#EFE9E1] text-sm text-[#6D625B]"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Cargando comparación...</div>
  }

  if (error && !comparison) {
    return <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#EFE9E1] p-6 text-center"><p className="text-sm text-[#72383D]">{error}</p><button onClick={leave} className="rounded-md border border-[#D1C7BD] px-3 py-2 text-xs font-semibold text-[#322D29]">Volver</button></div>
  }

  if (!comparison) return null
  const { po, summary } = comparison

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[#EFE9E1] text-[#322D29]">
      <header className="sticky top-0 z-20 flex shrink-0 flex-wrap items-center justify-between gap-3 bg-[#322D29] px-4 py-3 text-[#EFE9E1] shadow-sm">
        <div className="flex items-center gap-3"><button onClick={leave} className="rounded-md p-1.5 hover:bg-white/10" title="Volver"><ArrowLeft className="h-4 w-4" /></button><div><div className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4 text-[#D1C7BD]" /><h1 className="text-sm font-bold">Confirmación del proveedor</h1><span className="font-mono text-xs text-[#D1C7BD]">OC {po.correlative}</span></div><p className="text-[11px] text-[#D1C7BD]">Proveedor: {po.supplier_name || '—'} · Estado: ENVIADA_PROVEEDOR</p></div></div>
        <div className="flex items-center gap-3"><span className="text-[11px] text-[#D1C7BD]">{dirty ? 'Cambios sin guardar' : message}</span><button onClick={() => void saveReview()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-md bg-[#EFE9E1] px-3 py-2 text-xs font-bold text-[#72383D] disabled:opacity-50"><Save className="h-3.5 w-3.5" /> {saving ? 'Guardando...' : 'Guardar revisión'}</button></div>
      </header>

      <main className="min-w-0 flex-1 overflow-auto p-4 lg:p-6">
        {error && <div className="mb-3 border border-[#72383D]/30 bg-[#F5EDEE] px-3 py-2 text-xs text-[#72383D]">{error}</div>}
        <section className="mb-4 grid grid-cols-2 gap-3 border border-[#D1C7BD] bg-white/60 p-3 text-xs md:grid-cols-4 xl:grid-cols-7">
          {[['Proveedor', po.supplier_name], ['RUT', po.supplier_rut], ['Bodega', po.warehouse_name], ['Fecha emisión', dateValue(po.issue_date)], ['Fecha requerida', dateValue(po.required_date)], ['Condición de pago', po.payment_terms], ['Moneda', po.currency]].map(([label, value]) => <div key={label as string}><p className="text-[10px] uppercase tracking-wider text-[#AC9C8D]">{label}</p><p className="mt-1 font-medium">{value || '—'}</p></div>)}
        </section>

        <section className="mb-4 grid gap-px border border-[#D1C7BD] bg-[#D1C7BD] md:grid-cols-7">
          {[['Sin cambios', summary.unchanged_count], ['Modificadas', summary.modified_count], ['Eliminadas', summary.removed_count], ['Agregadas', summary.added_count], ['Total original', currency(summary.original_grand_total, po.currency)], ['Total actual', currency(summary.current_grand_total, po.currency)], ['Diferencia', currency(summary.total_difference, po.currency)]].map(([label, value]) => <div key={label as string} className="bg-white/80 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-[#AC9C8D]">{label}</p><p className="mt-1 text-sm font-bold tabular-nums">{value}</p></div>)}
        </section>

        <section className="mb-4 overflow-x-auto border border-[#D1C7BD] bg-white">
          <table className="min-w-[1080px] w-full border-collapse text-xs">
            <thead><tr className="bg-[#322D29] text-[10px] uppercase tracking-wider text-[#EFE9E1]"><th className="px-3 py-2 text-left">Estado</th><th className="px-3 py-2 text-left">SKU</th><th className="px-3 py-2 text-left">Producto</th><th className="px-3 py-2 text-left">Unidad</th><th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">P. unitario</th><th className="px-3 py-2 text-right">Dto %</th><th className="px-3 py-2 text-right">IVA %</th><th className="px-3 py-2 text-right">Total</th><th className="px-3 py-2 text-right">Acción</th></tr></thead>
            <tbody>{lines.map(line => {
              const persisted = line.item_id ? statuses.get(line.item_id) : undefined
              const status = persisted?.comparison_status ?? 'AGREGADA'
              return <tr key={line.item_id ?? `${line.product_id}-${line.line_number}`} className="border-b border-[#E5DDD4] align-top"><td className="px-3 py-2"><span className={`inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold ${statusStyle(status)}`}>{statusLabel(status)}</span></td><td className="px-3 py-2 font-mono text-[#72383D]">{line.sku || '—'}</td><td className="px-3 py-2 font-medium">{line.product_description}{line.unit_price === 0 && <span className="ml-2 text-[10px] text-[#AC9C8D]">Precio pendiente</span>}{persisted?.comparison_status === 'MODIFICADA' && <div className="mt-1 space-y-0.5 text-[10px] text-[#AC9C8D]">{persisted.changed_fields.map(change => <div key={change.field}>Antes {change.field}: {displayValue(change.original, change.field, po.currency)}</div>)}</div>}</td><td className="px-3 py-2">{line.unit || '—'}</td><td className="px-3 py-2"><input aria-label={`Cantidad ${line.product_description}`} type="number" min="0" step="0.01" value={line.quantity} onChange={event => updateLine(line.item_id, 'quantity', event.target.value)} className={`${inputClass} w-24 text-right`} /></td><td className="px-3 py-2"><input aria-label={`Precio ${line.product_description}`} type="number" min="0" step="0.01" value={line.unit_price} onChange={event => updateLine(line.item_id, 'unit_price', event.target.value)} className={`${inputClass} w-28 text-right`} /></td><td className="px-3 py-2"><input aria-label={`Descuento ${line.product_description}`} type="number" min="0" max="100" step="0.01" value={line.discount_percent} onChange={event => updateLine(line.item_id, 'discount_percent', event.target.value)} className={`${inputClass} w-20 text-right`} /></td><td className="px-3 py-2"><input aria-label={`IVA ${line.product_description}`} type="number" min="0" max="100" step="0.01" value={line.tax_rate} onChange={event => updateLine(line.item_id, 'tax_rate', event.target.value)} className={`${inputClass} w-20 text-right`} /></td><td className="px-3 py-2 text-right font-semibold tabular-nums">{currency((line.quantity * line.unit_price) - (line.quantity * line.unit_price * line.discount_percent / 100) + (((line.quantity * line.unit_price) - (line.quantity * line.unit_price * line.discount_percent / 100)) * line.tax_rate / 100), po.currency)}</td><td className="px-3 py-2 text-right"><button onClick={() => removeLine(line.item_id)} className="rounded p-1.5 text-[#6D625B] hover:bg-[#F5EDEE] hover:text-[#72383D]" title="Eliminar línea"><Trash2 className="h-3.5 w-3.5" /></button></td></tr>
            })}</tbody>
          </table>
        </section>

        <section className="mb-4 border border-[#D1C7BD] bg-white/70 p-3"><div className="mb-2 flex flex-wrap items-center gap-2"><button onClick={() => void openCatalog()} disabled={catalogLoading} className="inline-flex items-center gap-1.5 rounded-md border border-[#72383D]/40 px-3 py-2 text-xs font-semibold text-[#72383D] hover:bg-[#72383D]/10"><Plus className="h-3.5 w-3.5" /> {catalogLoading ? 'Cargando catálogo...' : 'Agregar producto'}</button>{selectedProduct && <><span className="text-xs font-medium">{selectedProduct.sku} · {selectedProduct.description}</span><input aria-label="Cantidad nuevo producto" type="number" min="0" step="0.01" value={newQuantity} onChange={event => setNewQuantity(event.target.value)} className={`${inputClass} w-24`} /><input aria-label="Precio nuevo producto" type="number" min="0" step="0.01" value={newUnitPrice} onChange={event => setNewUnitPrice(event.target.value)} className={`${inputClass} w-28`} /><button onClick={addProduct} className="rounded-md bg-[#72383D] px-3 py-2 text-xs font-semibold text-white">Agregar</button></>}</div>{catalog.length > 0 && !selectedProduct && <div className="max-w-xl"><div className="relative"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-[#AC9C8D]" /><input value={catalogQuery} onChange={event => setCatalogQuery(event.target.value)} placeholder="Buscar por SKU, descripción o código de barra" className={`${inputClass} pl-7`} /></div><div className="mt-1 divide-y divide-[#E5DDD4] border border-[#D1C7BD]">{visibleProducts.map(product => <button key={product.id} onClick={() => setSelectedProduct(product)} className="block w-full px-2 py-1.5 text-left text-xs hover:bg-[#EFE9E1]"><span className="font-mono text-[#72383D]">{product.sku}</span> · {product.description} <span className="text-[#AC9C8D]">({product.barcode || 'sin código'})</span></button>)}{visibleProducts.length === 0 && <p className="px-2 py-2 text-xs text-[#AC9C8D]">Producto no encontrado en catálogo.</p>}</div></div>}</section>

        {removedLines.length > 0 && <section className="mb-4 border border-[#D1C7BD] bg-white/70 p-3"><h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-[#6D625B]">Productos no disponibles / eliminados</h2><div className="overflow-x-auto"><table className="min-w-[700px] w-full text-xs"><thead><tr className="border-b border-[#D1C7BD] text-left text-[10px] uppercase text-[#AC9C8D]"><th className="py-2">Estado</th><th>SKU</th><th>Descripción</th><th className="text-right">Cantidad</th><th className="text-right">Precio</th><th className="text-right">Total</th></tr></thead><tbody>{removedLines.map(line => <tr key={line.item_id} className="border-b border-[#E5DDD4]"><td className="py-2"><span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusStyle('ELIMINADA')}`}>Eliminada</span></td><td className="font-mono">{line.original_item?.sku || '—'}</td><td>{line.original_item?.product_description || '—'}</td><td className="text-right">{line.original_item?.quantity ?? '—'}</td><td className="text-right">{currency(line.original_item?.unit_price, po.currency)}</td><td className="text-right font-semibold">{currency(line.original_item?.line_total, po.currency)}</td></tr>)}</tbody></table></div></section>}

        <section className="flex justify-end border-t border-[#D1C7BD] pt-3"><div className="w-72 space-y-1 text-xs"><div className="flex justify-between"><span className="text-[#AC9C8D]">Neto preview</span><span>{currency(preview.net, po.currency)}</span></div><div className="flex justify-between"><span className="text-[#AC9C8D]">Descuento preview</span><span>{currency(preview.discount, po.currency)}</span></div><div className="flex justify-between"><span className="text-[#AC9C8D]">IVA preview</span><span>{currency(preview.tax, po.currency)}</span></div><div className="flex justify-between border-t border-[#D1C7BD] pt-1 font-bold text-[#72383D]"><span>Total preview</span><span>{currency(preview.total, po.currency)}</span></div></div></section>
      </main>
    </div>
  )
}
