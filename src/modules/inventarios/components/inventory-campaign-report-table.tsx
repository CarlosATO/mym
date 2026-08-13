'use client'

import { ArrowDown, ArrowUp, ArrowUpDown, Eye } from 'lucide-react'
import type { CampaignSortBy, CampaignSortDirection, CampaignVarianceItem } from '@/app/actions/inventarios/campaign-report'
import { formatCLP, formatQuantity, formatSignedQuantity } from '@/modules/inventarios/lib/format'

const VARIANCE_LABELS: Record<string, string> = {
  FALTANTE: 'Faltante',
  SOBRANTE: 'Sobrante',
  SIN_DIFERENCIA: 'Sin diferencia',
}

const COVERAGE_LABELS: Record<string, string> = {
  COUNTED: 'Contado',
  NOT_COUNTED: 'No contado',
  OUT_OF_SNAPSHOT: 'No incluido para conteo',
}

function VarianceBadge({ status }: { status: string }) {
  const tone =
    status === 'SOBRANTE'
      ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:text-emerald-300 dark:bg-emerald-400/10'
      : status === 'FALTANTE'
        ? 'bg-red-500/10 text-red-700 border-red-500/25 dark:text-red-300 dark:bg-red-400/10'
        : 'bg-slate-500/10 text-slate-700 border-slate-500/20 dark:text-slate-300 dark:bg-slate-400/10'
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone}`}>
      {VARIANCE_LABELS[status] ?? status}
    </span>
  )
}

function CoverageBadge({ status }: { status: string }) {
  const tone =
    status === 'OUT_OF_SNAPSHOT'
      ? 'bg-amber-500/10 text-amber-700 border-amber-500/25 dark:text-amber-300 dark:bg-amber-400/10'
      : status === 'NOT_COUNTED'
        ? 'bg-slate-500/10 text-slate-700 border-slate-500/20 dark:text-slate-300 dark:bg-slate-400/10'
        : 'bg-sky-500/10 text-sky-700 border-sky-500/20 dark:text-sky-300 dark:bg-sky-400/10'
  return (
    <span
      title={
        status === 'OUT_OF_SNAPSHOT'
          ? 'El producto existe en el stock teórico, pero no estuvo disponible en las secciones para ser contado.'
          : undefined
      }
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone}`}
    >
      {COVERAGE_LABELS[status] ?? status}
    </span>
  )
}

type SortKey = CampaignSortBy

const SORTABLE: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
  { key: 'SKU', label: 'SKU' },
  { key: 'NAME', label: 'Producto' },
  { key: 'THEORETICAL', label: 'Teórico', numeric: true },
  { key: 'PHYSICAL', label: 'Contado', numeric: true },
  { key: 'DIFFERENCE', label: 'Diferencia', numeric: true },
  { key: 'VARIANCE_STATUS', label: 'Estado' },
  { key: 'COVERAGE_STATUS', label: 'Situación' },
  { key: 'UNIT_COST', label: 'Costo u.', numeric: true },
  { key: 'DIFFERENCE_VALUE', label: 'Impacto', numeric: true },
]

function SortButton({
  column,
  current,
  direction,
  onSort,
}: {
  column: (typeof SORTABLE)[number]
  current: CampaignSortBy | ''
  direction: CampaignSortDirection | ''
  onSort: (key: CampaignSortBy) => void
}) {
  const active = current === column.key
  return (
    <button
      type="button"
      onClick={() => onSort(column.key)}
      title={`Ordenar por ${column.label}`}
      className={`inline-flex items-center gap-1 ${
        column.numeric ? 'w-full justify-end' : 'w-full justify-start'
      } transition-colors hover:text-theme-text`}
    >
      {column.label}
      {active && direction === 'ASC' ? (
        <ArrowUp className="h-3 w-3 text-theme-accent" />
      ) : active && direction === 'DESC' ? (
        <ArrowDown className="h-3 w-3 text-theme-accent" />
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  )
}

interface InventoryCampaignReportTableProps {
  items: CampaignVarianceItem[]
  onSelect: (bsaleVariantId: number) => void
  sortBy: CampaignSortBy | ''
  sortDirection: CampaignSortDirection | ''
  onSort: (key: CampaignSortBy) => void
}

export function InventoryCampaignReportTable({ items, onSelect, sortBy, sortDirection, onSort }: InventoryCampaignReportTableProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 py-10 text-center">
        <p className="text-sm font-semibold text-theme-text">Sin productos para mostrar</p>
        <p className="mt-1 text-xs text-theme-text-muted/70">Ajusta los filtros para ver otros productos del inventario.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface shadow-sm">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-theme-border/60 text-left text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
            {SORTABLE.map(col => (
              <th key={col.key} className={col.numeric ? 'px-2 py-1.5 text-right' : 'px-2 py-1.5'}>
                <SortButton column={col} current={sortBy} direction={sortDirection} onSort={onSort} />
              </th>
            ))}
            <th className="px-2 py-1.5 text-right">Acción</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const diff = item.difference_quantity ?? 0
            return (
              <tr key={item.product_key} className="border-b border-theme-border/40 transition-colors hover:bg-theme-text/2">
                <td className="px-2 py-1 font-mono font-semibold text-theme-text">{item.sku ?? '—'}</td>
                <td className="max-w-[200px] truncate px-2 py-1 text-theme-text">{item.name ?? '—'}</td>
                <td className="px-2 py-1 text-right text-theme-text-muted">{formatQuantity(item.theoretical_quantity)}</td>
                <td className="px-2 py-1 text-right text-theme-text-muted">{formatQuantity(item.physical_quantity)}</td>
                <td
                  className={
                    'px-2 py-1 text-right font-semibold ' +
                    (diff > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : diff < 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-theme-text')
                  }
                >
                  {formatSignedQuantity(diff)}
                </td>
                <td className="px-2 py-1">
                  <VarianceBadge status={item.variance_status} />
                </td>
                <td className="px-2 py-1">
                  <CoverageBadge status={item.coverage_status} />
                </td>
                <td className="px-2 py-1 text-right text-theme-text-muted">{formatCLP(item.unit_cost)}</td>
                <td
                  className={
                    'px-2 py-1 text-right font-semibold ' +
                    ((item.difference_value ?? 0) > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : (item.difference_value ?? 0) < 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-theme-text')
                  }
                >
                  {formatCLP(item.difference_value)}
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={() => onSelect(item.bsale_variant_id)}
                    className="inline-flex h-6 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-1.5 text-[11px] font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                  >
                    <Eye className="h-3 w-3" />
                    Ver detalle
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
