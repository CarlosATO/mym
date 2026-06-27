import type { StockAdjustment } from '@/app/actions/logistica/ajustes'
import { cn } from '@/lib/utils'
import { StatusBadge, TypeBadge } from './adjustment-badges'
import { formatDate } from '../utils/adjustment-formatters'

export function AdjustmentCompactList({
  filteredAdjustments,
  selectedId,
  onSelect,
}: {
  filteredAdjustments: StockAdjustment[]
  selectedId: string
  onSelect: (a: StockAdjustment) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      {filteredAdjustments.map(a => (
        <button
          key={a.id}
          onClick={() => onSelect(a)}
          className={cn(
            'w-full text-left px-3 py-2.5 border-b border-theme-border/40 transition-colors',
            selectedId === a.id
              ? 'bg-theme-accent/8 border-l-2 border-l-theme-accent'
              : 'hover:bg-theme-text/[0.03] border-l-2 border-l-transparent'
          )}
        >
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-mono text-[10px] font-bold text-theme-accent">{a.adjustment_number}</span>
            <StatusBadge status={a.status} />
          </div>
          <p className="text-[10px] font-medium text-theme-text truncate mb-1">{a.reason}</p>
          <div className="flex items-center justify-between gap-2">
            <TypeBadge type={a.adjustment_type} />
            <span className="text-[9px] text-theme-text-muted">{formatDate(a.adjustment_date)}</span>
          </div>
        </button>
      ))}
    </div>
  )
}
