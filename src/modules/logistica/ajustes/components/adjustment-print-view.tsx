import type { StockAdjustment, StockAdjustmentItem } from '@/app/actions/logistica/ajustes'
import { adjustmentTypeLabel, formatDate, formatMoney, formatQty } from '../utils/adjustment-formatters'

export function AdjustmentPrintDocument({
  adjustmentNumber,
  statusLabel,
  type,
  reason,
  warehouseName,
  date,
  notes,
  items,
  totalQty,
  totalValue,
  preparedLabel = 'Emitido Por',
}: {
  adjustmentNumber: string
  statusLabel: string
  type: string
  reason: string
  warehouseName?: string
  date: string | null
  notes?: string | null
  items: StockAdjustmentItem[]
  totalQty: number
  totalValue: number
  preparedLabel?: string
}) {
  const isDraft = statusLabel.includes('BORRADOR')
  return (
    <div className="bg-white text-black p-[1cm] text-sm font-sans">
      <div className="flex justify-between items-start mb-8 border-b-2 border-black pb-6">
        <div>
          {isDraft && <p className="text-sm font-bold uppercase tracking-[0.2em] text-gray-500">MYM Distribuidora</p>}
          <h1 className="text-3xl font-black uppercase tracking-tight mt-2">Ajuste de Inventario</h1>
          <p className={`text-sm font-black mt-2 ${isDraft ? 'text-red-600' : 'text-black'}`}>{statusLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold font-mono text-blue-800">{adjustmentNumber}</p>
          {isDraft && <p className="text-xs mt-1 text-gray-600">Número: se generará al emitir</p>}
          <p className="text-sm mt-2">Fecha: {formatDate(date)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8 mb-8 text-sm">
        <div>
          <p className="font-bold text-gray-500 uppercase text-[10px] mb-1 tracking-widest">Información General</p>
          <p><strong>Tipo:</strong> {adjustmentTypeLabel(type)}</p>
          <p><strong>Bodega:</strong> {warehouseName || '—'}</p>
          <p><strong>Motivo:</strong> {reason || '—'}</p>
          {isDraft && <p><strong>Usuario:</strong> Usuario en sesión</p>}
        </div>
        <div>
          <p className="font-bold text-gray-500 uppercase text-[10px] mb-1 tracking-widest">{isDraft ? 'Estado del Documento' : 'Auditoría'}</p>
          <p><strong>Estado:</strong> {isDraft ? 'BORRADOR' : statusLabel}</p>
          {isDraft && <p><strong>Kardex/Stock:</strong> No afectado</p>}
          {notes && <p className="mt-2"><strong>Obs:</strong> {notes}</p>}
        </div>
      </div>

      <table className="w-full text-left text-xs mb-12">
        <thead>
          <tr className="border-b-2 border-black">
            <th className="py-2">SKU</th>
            <th className="py-2">Producto</th>
            <th className="py-2">Ubic.</th>
            <th className="py-2">Lote/Vence</th>
            <th className="py-2 text-right">Cantidad</th>
            <th className="py-2 text-right">Costo U.</th>
            <th className="py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {items.map((it, idx) => (
            <tr key={it.id || idx}>
              <td className="py-2 font-mono">{it.product_sku || '—'}</td>
              <td className="py-2 max-w-[220px] pr-2">{it.product_description || '—'}</td>
              <td className="py-2 font-mono">{it.location_code || '—'}</td>
              <td className="py-2">{it.lot_number || '-'}{it.expiration_date ? ` / ${formatDate(it.expiration_date)}` : ''}</td>
              <td className="py-2 text-right font-bold">{formatQty(it.quantity)}</td>
              <td className="py-2 text-right">{formatMoney(it.unit_cost || null)}</td>
              <td className="py-2 text-right font-semibold">{formatMoney(it.total_cost || null)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-black">
          <tr>
            <td colSpan={4} className="py-3 text-right font-bold uppercase text-[10px]">Totales Generales</td>
            <td className="py-3 text-right font-black text-sm">{formatQty(totalQty)}</td>
            <td className="py-3 text-right"></td>
            <td className="py-3 text-right font-black text-sm">{formatMoney(totalValue)}</td>
          </tr>
        </tfoot>
      </table>

      <div className="mt-20 grid grid-cols-2 gap-16 px-16 text-center text-sm">
        <div><div className="border-t border-black pt-2"><p className="font-bold">{preparedLabel}</p><p className="text-xs text-gray-500">Firma y Timbre</p></div></div>
        <div><div className="border-t border-black pt-2"><p className="font-bold">Aprobado Por</p><p className="text-xs text-gray-500">Firma Jefatura / Gerencia</p></div></div>
      </div>
    </div>
  )
}

export function AdjustmentPrintView({ adjustment, items, onBack, onPrint }: { adjustment: StockAdjustment; items: StockAdjustmentItem[]; onBack: () => void; onPrint: () => void }) {
  const totalQty = items.reduce((acc, i) => acc + Number(i.quantity), 0)
  const totalValue = items.reduce((acc, i) => acc + (Number(i.total_cost) || 0), 0)
  return (
    <div className="h-full flex flex-col bg-gray-100 overflow-hidden print:bg-white">
      <div className="shrink-0 p-4 bg-white border-b flex items-center justify-between print:hidden">
        <button onClick={onBack} className="flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-gray-600 hover:bg-gray-100 rounded-md">Volver</button>
        <button onClick={onPrint} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-md shadow-sm">Imprimir</button>
      </div>
      <div className="flex-1 overflow-y-auto p-8 print:p-0">
        <div className="max-w-[21cm] mx-auto shadow-lg print:shadow-none min-h-[29.7cm]">
          <AdjustmentPrintDocument
            adjustmentNumber={adjustment.adjustment_number}
            statusLabel="Documento Interno"
            type={adjustment.adjustment_type}
            reason={adjustment.reason}
            warehouseName={adjustment.warehouse_name}
            date={adjustment.adjustment_date}
            notes={adjustment.notes}
            items={items}
            totalQty={totalQty}
            totalValue={totalValue}
          />
        </div>
      </div>
    </div>
  )
}
