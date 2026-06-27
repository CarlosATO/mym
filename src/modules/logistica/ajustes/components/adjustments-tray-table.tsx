import { CheckCircle2, Eye, Plus, Search, Sliders } from 'lucide-react'
import type { StockAdjustment } from '@/app/actions/logistica/ajustes'
import { erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import type { FilterTab } from '../types'
import { StatusBadge, TypeBadge } from './adjustment-badges'
import { formatDate, formatMoney, formatQty } from '../utils/adjustment-formatters'

export function AdjustmentsTrayTable({
  loading,
  search,
  setSearch,
  filterTab,
  setFilterTab,
  counts,
  filteredAdjustments,
  onOpenDetail,
  onNewAdjustment,
  successMessage,
}: {
  adjustments: StockAdjustment[]
  loading: boolean
  search: string
  setSearch: (v: string) => void
  filterTab: FilterTab
  setFilterTab: (v: FilterTab) => void
  counts: { all: number; positive: number; negative: number; completed: number }
  filteredAdjustments: StockAdjustment[]
  onOpenDetail: (a: StockAdjustment) => void
  onNewAdjustment: () => void
  successMessage: string | null
}) {
  const tabBtn = (id: FilterTab, label: string, activeColor: string) => (
    <button
      key={id}
      onClick={() => setFilterTab(id)}
      className={cn(
        'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap',
        filterTab === id ? `${activeColor} text-white shadow-sm` : 'text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5'
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-theme-border/60 bg-theme-text/[0.01]">
        <div className="flex gap-1 p-1 rounded-xl bg-theme-text/[0.04] border border-theme-border/40">
          {tabBtn('ALL', `Todos (${counts.all})`, 'bg-theme-accent')}
          {tabBtn('POSITIVE', `Ingresos + (${counts.positive})`, 'bg-emerald-500')}
          {tabBtn('NEGATIVE', `Salidas - (${counts.negative})`, 'bg-red-500')}
          {tabBtn('COMPLETED', `Emitidos (${counts.completed})`, 'bg-blue-500')}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-text-muted/50" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por N°, motivo o bodega..."
            className={cn(erpInputClass, 'w-full h-9 pl-9 pr-3 text-xs')}
          />
        </div>
        <div className="ml-auto">
          <button
            onClick={onNewAdjustment}
            className="flex items-center gap-2 px-4 py-2 bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold rounded-xl transition-all shadow-sm active:scale-95"
          >
            <Plus className="w-4 h-4" /> Nuevo Ajuste
          </button>
        </div>
      </div>

      {successMessage && (
        <div className="mx-5 mt-3 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <p className="text-sm font-bold">{successMessage}</p>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin w-6 h-6 border-2 border-theme-accent border-t-transparent rounded-full mx-auto" />
            <p className="text-xs text-theme-text-muted mt-3">Cargando ajustes...</p>
          </div>
        ) : filteredAdjustments.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 h-full p-12">
            <Sliders className="w-10 h-10 text-theme-text-muted/20" />
            <p className="text-sm text-theme-text-muted">{search ? 'Sin resultados para la búsqueda' : 'No se encontraron ajustes.'}</p>
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-theme-surface border-b border-theme-border text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
                <th className="text-left px-4 py-3">Nº Ajuste</th>
                <th className="text-left px-4 py-3">Fecha</th>
                <th className="text-left px-4 py-3">Tipo</th>
                <th className="text-left px-4 py-3">Motivo</th>
                <th className="text-left px-4 py-3">Bodega</th>
                <th className="text-right px-4 py-3">Líneas</th>
                <th className="text-right px-4 py-3">Unidades</th>
                <th className="text-right px-4 py-3">Total Valor.</th>
                <th className="text-left px-4 py-3">Usuario</th>
                <th className="text-center px-4 py-3">Estado</th>
                <th className="text-right px-4 py-3">Acción</th>
              </tr>
            </thead>
            <tbody>
              {filteredAdjustments.map(a => (
                <tr key={a.id} onDoubleClick={() => onOpenDetail(a)} className="border-b border-theme-border/40 hover:bg-theme-accent/[0.03] transition-colors cursor-pointer group">
                  <td className="px-4 py-2.5"><span className="font-mono font-bold text-theme-accent text-[11px]">{a.adjustment_number}</span></td>
                  <td className="px-4 py-2.5 text-theme-text-muted whitespace-nowrap">{formatDate(a.adjustment_date)}</td>
                  <td className="px-4 py-2.5"><TypeBadge type={a.adjustment_type} /></td>
                  <td className="px-4 py-2.5 max-w-[180px]"><p className="truncate font-medium text-theme-text" title={a.reason}>{a.reason}</p></td>
                  <td className="px-4 py-2.5 text-theme-text-muted max-w-[140px]"><p className="truncate">{a.warehouse_name || '—'}</p></td>
                  <td className="px-4 py-2.5 text-right text-theme-text">{a.item_count ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right font-semibold text-theme-text">{a.total_units != null ? formatQty(a.total_units) : '—'}</td>
                  <td className="px-4 py-2.5 text-right text-theme-text">{a.total_value != null ? formatMoney(a.total_value) : '—'}</td>
                  <td className="px-4 py-2.5 text-theme-text-muted max-w-[120px]"><p className="truncate">{a.created_by_name || '—'}</p></td>
                  <td className="px-4 py-2.5 text-center"><StatusBadge status={a.status} /></td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={(e) => { e.stopPropagation(); onOpenDetail(a) }} className="px-2.5 py-1 rounded-lg border border-theme-border hover:bg-theme-text/10 text-theme-text-muted text-[10px] font-semibold transition-all flex items-center gap-1 ml-auto">
                      <Eye className="w-3 h-3" /> Ver
                    </button>
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
