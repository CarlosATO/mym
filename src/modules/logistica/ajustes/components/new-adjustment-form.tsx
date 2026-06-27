import { useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, FileText, Loader2, Plus, Printer, Send, Trash2, X } from 'lucide-react'
import type { StockAdjustmentItem } from '@/app/actions/logistica/ajustes'
import type { TransferDestinationLocation, TransferWarehouse } from '@/app/actions/logistica/traspasos'
import { LocalCombobox, type ComboboxOption } from '@/components/ui/local-combobox'
import { erpErrorInputClass, erpInputClass, erpSelectClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import type { AdjustmentLine } from '../types'
import { formatDate, formatMoney, formatQty } from '../utils/adjustment-formatters'
import { AdjustmentPrintDocument } from './adjustment-print-view'

export function NewAdjustmentForm({
  type,
  setType,
  reason,
  setReason,
  notes,
  setNotes,
  warehouseId,
  setWarehouseId,
  lines,
  warehouses,
  locations,
  productOptions,
  locationOptions,
  stockOptionsForWarehouse,
  saving,
  error,
  onBack,
  onAddLine,
  onRemoveLine,
  onUpdateLine,
  onSelectStockForNegative,
  onEmit,
}: {
  type: 'INITIAL' | 'POSITIVE' | 'NEGATIVE'
  setType: (type: 'INITIAL' | 'POSITIVE' | 'NEGATIVE') => void
  reason: string
  setReason: (reason: string) => void
  notes: string
  setNotes: (notes: string) => void
  warehouseId: string
  setWarehouseId: (id: string) => void
  lines: AdjustmentLine[]
  warehouses: TransferWarehouse[]
  locations: TransferDestinationLocation[]
  productOptions: ComboboxOption[]
  locationOptions: ComboboxOption[]
  stockOptionsForWarehouse: ComboboxOption[]
  saving: boolean
  error: string | null
  onBack: () => void
  onAddLine: () => void
  onRemoveLine: (id: string) => void
  onUpdateLine: (id: string, field: keyof AdjustmentLine, value: string) => void
  onSelectStockForNegative: (id: string, stockKey: string) => void
  onEmit: () => void
}) {
  const [showDraftPreview, setShowDraftPreview] = useState(false)
  const draftPrintRef = useRef<HTMLDivElement>(null)
  const reasons = ['Carga inicial de inventario', 'Diferencia inventario físico', 'Merma', 'Producto dañado', 'Producto vencido', 'Corrección de ingreso', 'Corrección de conteo', 'Otro']
  const warehouseName = warehouses.find(w => w.id === warehouseId)?.name || '—'

  const draftItems = useMemo<StockAdjustmentItem[]>(() => lines.map(l => ({
    id: l.id,
    adjustment_id: 'draft',
    product_id: l.product_id,
    product_sku: l.product_sku,
    product_description: l.product_description,
    warehouse_id: warehouseId,
    location_id: l.location_id,
    location_code: locations.find(loc => loc.id === l.location_id)?.code || l.location_code,
    lot_number: l.lot_number,
    expiration_date: l.expiration_date,
    quantity: Number(l.quantity) || 0,
    unit_cost: Number(l.unit_cost) || 0,
    total_cost: (Number(l.quantity) || 0) * (Number(l.unit_cost) || 0),
    notes: l.notes,
  })), [lines, locations, warehouseId])

  const draftTotalQty = useMemo(() => draftItems.reduce((acc, item) => acc + Number(item.quantity || 0), 0), [draftItems])
  const draftTotalVal = useMemo(() => draftItems.reduce((acc, item) => acc + Number(item.total_cost || 0), 0), [draftItems])

  return (
    <div className="h-full flex flex-col bg-theme-surface overflow-hidden animate-in fade-in duration-300">
      <div className="shrink-0 p-4 border-b border-theme-border flex items-center gap-4 bg-theme-text/[0.015]">
        <button onClick={onBack} className="p-2 hover:bg-theme-text/10 rounded-lg text-theme-text-muted transition-colors"><ArrowLeft className="w-5 h-5" /></button>
        <div><h1 className="text-lg font-black text-theme-text">Nuevo Ajuste de Inventario</h1><p className="text-xs text-theme-text-muted">Documento interno de corrección de stock</p></div>
      </div>

      <div className="flex-1 overflow-y-auto"><div className="max-w-6xl mx-auto p-6 space-y-6">
        {error && <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-600 dark:text-red-400"><AlertCircle className="w-5 h-5 shrink-0" /><p className="text-sm font-semibold">{error}</p></div>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4 bg-theme-text/5 p-5 rounded-2xl border border-theme-border">
            <h3 className="text-sm font-bold text-theme-text flex items-center gap-2"><FileText className="w-4 h-4"/> Cabecera del Documento</h3>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-xs font-bold text-theme-text-muted mb-1.5 uppercase tracking-wider">Tipo de Ajuste</label><select value={type} onChange={e => { const next = e.target.value as 'POSITIVE' | 'NEGATIVE'; setType(next); setReason(next === 'NEGATIVE' ? 'Merma' : 'Carga inicial de inventario') }} className={cn(erpSelectClass, 'w-full h-10 px-3 rounded-xl text-sm')}><option value="POSITIVE">Ajuste de ingreso +</option><option value="NEGATIVE">Ajuste de salida -</option></select></div>
              <div><label className="block text-xs font-bold text-theme-text-muted mb-1.5 uppercase tracking-wider">Bodega Afectada</label><select value={warehouseId} onChange={e => setWarehouseId(e.target.value)} className={cn(erpSelectClass, 'w-full h-10 px-3 rounded-xl text-sm')}><option value="">Seleccione bodega...</option>{warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
            </div>
            <div><label className="block text-xs font-bold text-theme-text-muted mb-1.5 uppercase tracking-wider">Motivo</label><select value={reason} onChange={e => setReason(e.target.value)} className={cn(erpSelectClass, 'w-full h-10 px-3 rounded-xl text-sm')}>{reasons.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
            <div><label className="block text-xs font-bold text-theme-text-muted mb-1.5 uppercase tracking-wider">Observación General</label><input value={notes} onChange={e => setNotes(e.target.value)} placeholder={reason === 'Otro' ? 'Obligatorio especificar motivo...' : 'Opcional...'} className={cn(erpInputClass, 'w-full h-10 px-3 rounded-xl text-sm')} /></div>
          </div>
          <div className="bg-theme-text/5 p-5 rounded-2xl border border-theme-border flex flex-col justify-center"><h3 className="text-sm font-bold text-theme-text flex items-center gap-2 mb-2"><AlertCircle className="w-4 h-4 text-theme-accent"/> Instrucciones</h3><p className="text-xs text-theme-text-muted leading-relaxed">{type === 'NEGATIVE' ? 'Descuente stock por merma, daño, vencimiento o diferencia física. Solo permite seleccionar desde stock disponible y no puede dejar inventario en negativo.' : 'Incremente stock por carga inicial, diferencia positiva o corrección. Permite agregar productos del catálogo aunque no tengan existencias previas e ingresar costo unitario.'}</p></div>
        </div>

        <div className="bg-theme-surface border border-theme-border rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-theme-border bg-theme-text/[0.015] flex items-center justify-between"><h3 className="font-bold text-theme-text text-sm">Líneas a Ajustar</h3>{warehouseId && <button onClick={onAddLine} className="flex items-center gap-1.5 px-3 py-1.5 bg-theme-text/5 hover:bg-theme-text/10 text-theme-text text-xs font-bold rounded-lg transition-colors"><Plus className="w-3.5 h-3.5" /> Agregar Línea</button>}</div>
          {!warehouseId ? <div className="p-10 text-center text-theme-text-muted text-sm">Seleccione una bodega en la cabecera para comenzar a agregar líneas.</div> : lines.length === 0 ? <div className="p-10 text-center text-theme-text-muted text-sm border-dashed border-2 border-theme-border/50 mx-5 my-5 rounded-xl">Haga clic en &quot;Agregar Línea&quot; para incluir productos en este ajuste.</div> : (
            <div className="overflow-x-auto"><table className="w-full min-w-[1280px] text-left text-xs whitespace-nowrap"><thead className="bg-theme-text/5"><tr className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted"><th className="px-4 py-3 min-w-[420px] w-[420px]">Producto</th><th className="px-4 py-3 min-w-[260px] w-[260px]">Ubicación</th><th className="px-4 py-3 min-w-[130px] w-[130px]">Lote</th><th className="px-4 py-3 min-w-[140px] w-[140px]">Vence</th><th className="px-4 py-3 min-w-[120px] w-[120px] text-right">Cantidad</th>{type !== 'NEGATIVE' && <th className="px-4 py-3 min-w-[140px] w-[140px] text-right">Costo Unitario</th>}<th className="px-4 py-3 min-w-[220px]">Notas</th><th className="px-3 py-3 w-12"></th></tr></thead><tbody className="divide-y divide-theme-border/50">
              {lines.map(l => <tr key={l.id} className="hover:bg-theme-text/[0.02] transition-colors"><td className="px-4 py-3 min-w-[420px]">{type === 'NEGATIVE' ? <LocalCombobox value={l.product_id ? `${l.product_id}|${l.location_id || 'null'}|${l.lot_number || 'null'}|${l.expiration_date || 'null'}` : ''} onChange={value => onSelectStockForNegative(l.id, value)} options={stockOptionsForWarehouse} placeholder="Buscar stock disponible..." className={cn(erpInputClass, 'h-8 px-2 rounded-md text-xs')} /> : <LocalCombobox value={l.product_id} onChange={value => onUpdateLine(l.id, 'product_id', value)} options={productOptions} placeholder="Buscar producto..." className={cn(erpInputClass, 'h-8 px-2 rounded-md text-xs')} />}</td><td className="px-4 py-3 min-w-[260px] align-top"><LocalCombobox value={l.location_id} onChange={value => onUpdateLine(l.id, 'location_id', value)} options={locationOptions} placeholder={locationOptions.length === 0 ? 'Sin ubicaciones activas' : 'Buscar ubicación...'} disabled={type === 'NEGATIVE'} className={cn(erpInputClass, 'w-full h-8 px-2 rounded-md text-xs')} />{type !== 'NEGATIVE' && locationOptions.length === 0 && <p className="mt-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">No hay ubicaciones activas para esta bodega.</p>}</td><td className="px-4 py-3"><input value={l.lot_number} onChange={e => onUpdateLine(l.id, 'lot_number', e.target.value)} disabled={type === 'NEGATIVE'} placeholder="Lote..." className={cn(erpInputClass, 'w-full h-8 px-2 rounded-md text-xs')} /></td><td className="px-4 py-3"><input type="date" value={l.expiration_date} onChange={e => onUpdateLine(l.id, 'expiration_date', e.target.value)} disabled={type === 'NEGATIVE'} className={cn(erpInputClass, 'w-full h-8 px-2 rounded-md text-xs')} /></td><td className="px-4 py-3 text-right relative"><input type="number" min="0" step="0.01" value={l.quantity} onChange={e => onUpdateLine(l.id, 'quantity', e.target.value)} className={cn(erpInputClass, 'w-full h-8 px-2 text-right font-black rounded-md text-xs', type === 'NEGATIVE' && Number(l.quantity) > l.available_stock && erpErrorInputClass)} placeholder="0.00" />{type === 'NEGATIVE' && <div className="absolute -bottom-4 right-4 text-[9px] text-theme-text-muted">Max: {l.available_stock}</div>}</td>{type !== 'NEGATIVE' && <td className="px-4 py-3 text-right"><input type="number" min="0" step="1" value={l.unit_cost} onChange={e => onUpdateLine(l.id, 'unit_cost', e.target.value)} className={cn(erpInputClass, 'w-full h-8 px-2 text-right rounded-md text-xs')} placeholder="$0" /></td>}<td className="px-4 py-3"><input value={l.notes} onChange={e => onUpdateLine(l.id, 'notes', e.target.value)} placeholder="Obs..." className={cn(erpInputClass, 'w-full h-8 px-2 rounded-md text-xs')} /></td><td className="px-3 py-3 text-center"><button onClick={() => onRemoveLine(l.id)} className="p-1.5 text-theme-text-muted hover:text-red-500 hover:bg-red-500/10 rounded-md transition-colors"><Trash2 className="w-4 h-4" /></button></td></tr>)}
            </tbody></table></div>
          )}
        </div>
      </div></div>

      <div className="shrink-0 p-4 border-t border-theme-border bg-theme-text/[0.015] flex items-center justify-between"><button disabled={lines.length === 0 || !warehouseId || saving} onClick={() => setShowDraftPreview(true)} className="flex items-center gap-2 px-4 py-2 bg-theme-surface border border-theme-border hover:bg-theme-text/5 text-theme-text text-sm font-bold rounded-xl transition-all shadow-sm disabled:opacity-50"><Printer className="w-4 h-4" /> Imprimir Borrador</button><button disabled={lines.length === 0 || !warehouseId || saving} onClick={onEmit} className="flex items-center gap-2 px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-xl transition-all shadow-sm disabled:opacity-50 active:scale-95">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Emitir Ajuste</button></div>

      {showDraftPreview && <div id="draft-adjustment-preview-modal" className="fixed inset-0 z-[200] bg-black/45 backdrop-blur-sm flex items-center justify-center p-4 print:static print:bg-white print:p-0"><style>{`@media print { body * { visibility: hidden !important; } #adjustment-draft-print-section, #adjustment-draft-print-section * { visibility: visible !important; } #adjustment-draft-print-section { display: block !important; position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; box-shadow: none !important; border: 0 !important; } .draft-preview-no-print { display: none !important; } }`}</style><div id="adjustment-draft-print-section" className="hidden print:block"><AdjustmentPrintDocument adjustmentNumber="AJ-BORRADOR" statusLabel="BORRADOR - NO CONFIRMADO" type={type} reason={reason} warehouseName={warehouseName} date={new Date().toISOString()} notes={notes} items={draftItems} totalQty={draftTotalQty} totalValue={draftTotalVal} preparedLabel="Preparado Por" /></div><div className="w-[90vw] max-w-6xl h-[85vh] bg-theme-surface border border-theme-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"><div className="draft-preview-no-print shrink-0 px-5 py-4 border-b border-theme-border bg-theme-text/[0.015] flex items-center justify-between"><div><h2 className="text-lg font-black text-theme-text">Vista previa de borrador</h2><p className="text-xs text-theme-text-muted mt-0.5">Este documento no guarda, no emite y no consume correlativo.</p></div><button type="button" onClick={() => setShowDraftPreview(false)} className="p-2 rounded-lg text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 transition-colors" aria-label="Cerrar vista previa"><X className="w-5 h-5" /></button></div><div className="flex-1 overflow-y-auto bg-gray-100 dark:bg-black/20 p-6"><div ref={draftPrintRef} className="max-w-[21cm] mx-auto shadow-lg min-h-[29.7cm]"><AdjustmentPrintDocument adjustmentNumber="AJ-BORRADOR" statusLabel="BORRADOR - NO CONFIRMADO" type={type} reason={reason} warehouseName={warehouseName} date={new Date().toISOString()} notes={notes} items={draftItems} totalQty={draftTotalQty} totalValue={draftTotalVal} preparedLabel="Preparado Por" /></div></div><div className="draft-preview-no-print shrink-0 px-5 py-4 border-t border-theme-border bg-theme-text/[0.015] flex items-center justify-between gap-3"><p className="text-xs text-theme-text-muted">Descargar PDF queda pendiente: no se agregaron librerías nuevas.</p><div className="flex items-center gap-2"><button type="button" disabled className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed">Descargar PDF</button><button type="button" onClick={() => window.print()} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-colors shadow-sm"><Printer className="w-4 h-4" /> Imprimir</button><button type="button" onClick={() => setShowDraftPreview(false)} className="px-4 py-2 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-theme-text text-sm font-bold transition-colors">Cerrar</button></div></div></div></div>}
    </div>
  )
}
