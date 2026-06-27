import { useEffect, useState } from 'react'
import { FileText, Package, Printer, Sliders, X } from 'lucide-react'
import { getStockAdjustmentDetails, type StockAdjustment, type StockAdjustmentItem } from '@/app/actions/logistica/ajustes'
import { StatusBadge, TypeBadge } from './adjustment-badges'
import { DetailSkeleton } from './adjustment-skeletons'
import { formatDate, formatMoney, formatQty } from '../utils/adjustment-formatters'

export function AdjustmentDetailPanel({
  summary,
  cachedDetail,
  onClose,
  onDetailLoaded,
  onPrint,
}: {
  summary: StockAdjustment
  cachedDetail: { adjustment: StockAdjustment; items: StockAdjustmentItem[] } | null
  onClose: () => void
  onDetailLoaded: (id: string, data: { adjustment: StockAdjustment; items: StockAdjustmentItem[] }) => void
  onPrint: (id: string) => void
}) {
  const [detail, setDetail] = useState(cachedDetail)
  const [loadingDetail, setLoadingDetail] = useState(!cachedDetail)

  useEffect(() => {
    if (cachedDetail) {
      setDetail(cachedDetail)
      setLoadingDetail(false)
      return
    }
    let active = true
    const label = `openAdjustmentDetail:${summary.id}`
    if (process.env.NODE_ENV === 'development') console.time(label)
    setDetail(null)
    setLoadingDetail(true)
    getStockAdjustmentDetails(summary.id).then(res => {
      if (process.env.NODE_ENV === 'development') console.timeEnd(label)
      if (active && res.adjustment) {
        const data = { adjustment: res.adjustment, items: res.items }
        setDetail(data)
        setLoadingDetail(false)
        onDetailLoaded(summary.id, data)
      } else if (active) {
        setLoadingDetail(false)
      }
    })
    return () => { active = false }
  }, [summary.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const adj = detail?.adjustment ?? summary
  const items = detail?.items ?? []
  const totalQty = items.reduce((acc, i) => acc + Number(i.quantity), 0)
  const totalVal = items.reduce((acc, i) => acc + (Number(i.total_cost) || 0), 0)

  return (
    <div className="h-full flex flex-col bg-theme-surface border-l border-theme-border">
      <div className="shrink-0 border-b border-theme-border/70">
        <div className="flex items-center justify-between gap-4 px-5 py-3 bg-theme-text/[0.02]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-theme-accent/10 flex items-center justify-center shrink-0">
              <Sliders className="w-4 h-4 text-theme-accent" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold text-theme-accent">{adj.adjustment_number}</span>
                <StatusBadge status={adj.status} />
              </div>
              <p className="text-xs text-theme-text-muted truncate">{adj.reason}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => onPrint(summary.id)} className="px-3 py-1.5 rounded-lg border border-theme-border hover:bg-theme-text/10 text-theme-text text-xs font-bold transition-all flex items-center gap-1.5">
              <Printer className="w-3.5 h-3.5" /> Imprimir
            </button>
            <button onClick={onClose} title="Cerrar detalle" className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-5 divide-x divide-theme-border/50 border-t border-theme-border/50">
          {[
            { label: 'Tipo', value: null, badge: <TypeBadge type={adj.adjustment_type} /> },
            { label: 'Bodega', value: adj.warehouse_name || '—', badge: null },
            { label: 'Líneas', value: String(adj.item_count ?? items.length), badge: null },
            { label: 'Unidades', value: formatQty(adj.total_units ?? totalQty), badge: null },
            { label: 'Total Valor.', value: formatMoney(adj.total_value ?? totalVal), badge: null },
          ].map(({ label, value, badge }) => (
            <div key={label} className="px-4 py-2">
              <p className="text-[9px] font-bold uppercase tracking-wider text-theme-text-muted mb-0.5">{label}</p>
              {badge ? badge : <p className="text-xs font-bold text-theme-text truncate">{value}</p>}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 px-5 py-2 text-[11px] text-theme-text-muted border-t border-theme-border/40">
          <span className="flex items-center gap-1"><FileText className="w-3 h-3" />{formatDate(adj.adjustment_date)}</span>
          {adj.created_by_name && <span className="flex items-center gap-1"><Package className="w-3 h-3" />{adj.created_by_name}</span>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loadingDetail ? (
          <DetailSkeleton />
        ) : (
          <div className="p-5 space-y-6">
            {adj.notes && (
              <div className="bg-amber-500/10 p-3 rounded-xl border border-amber-500/20 text-amber-900 dark:text-amber-200 text-xs">
                <span className="font-bold">Observación:</span> {adj.notes}
              </div>
            )}
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-2 flex items-center gap-1.5"><Package className="w-3 h-3 text-theme-accent" /> Líneas del Ajuste</h3>
              <div className="rounded-lg border border-theme-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-theme-text/[0.04] border-b border-theme-border text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
                      <th className="text-left px-3 py-2">Producto</th>
                      <th className="text-left px-3 py-2">Ubic.</th>
                      <th className="text-left px-3 py-2">Lote/Vence</th>
                      <th className="text-right px-3 py-2">Cant.</th>
                      <th className="text-right px-3 py-2">Costo U.</th>
                      <th className="text-right px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx} className="border-b border-theme-border/40 hover:bg-theme-text/[0.02]">
                        <td className="px-3 py-2"><p className="font-mono text-[10px] font-bold text-theme-accent">{it.product_sku}</p><p className="font-medium text-theme-text truncate max-w-[200px]">{it.product_description}</p></td>
                        <td className="px-3 py-2 font-mono text-theme-text-muted">{it.location_code || '—'}</td>
                        <td className="px-3 py-2 text-theme-text-muted">{it.lot_number ? <span>{it.lot_number}{it.expiration_date && <span className="text-[10px] ml-1">V: {formatDate(it.expiration_date)}</span>}</span> : '—'}</td>
                        <td className="px-3 py-2 text-right font-black text-theme-text">{formatQty(it.quantity)}</td>
                        <td className="px-3 py-2 text-right text-theme-text-muted">{formatMoney(it.unit_cost ?? null)}</td>
                        <td className="px-3 py-2 text-right font-bold text-theme-text">{formatMoney(it.total_cost ?? null)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-theme-text/[0.04] border-t border-theme-border font-bold text-theme-text">
                      <td colSpan={3} className="px-3 py-2 text-right text-[10px] uppercase text-theme-text-muted tracking-wider">Totales</td>
                      <td className="px-3 py-2 text-right text-theme-accent font-black">{formatQty(totalQty)}</td>
                      <td className="px-3 py-2 text-right"></td>
                      <td className="px-3 py-2 text-right font-black">{formatMoney(totalVal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
