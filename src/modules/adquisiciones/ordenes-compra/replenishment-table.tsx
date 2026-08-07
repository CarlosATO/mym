'use client'

import { useMemo } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { fmtN } from './replenishment-format'
import { PRODUCT_FALLBACK, getProductName, getRealSupplierName, getPseudoSupplierName } from './replenishment-names'
import {
  COLUMN_DEFS,
  STICKY_COLUMNS,
  TABLE_GROUPS,
  getColumnWidth,
  type ColumnId,
  type SortConfig,
  type SortKey,
  type WidthKey,
} from './replenishment-columns'
import type { SkuRow } from './replenishment-derive'

// ─── Constantes de estilo — imagen 2: limpio, elegante, sin ruido ─────────────

const thBase = [
  'border-b border-theme-border/60',
  'bg-theme-surface',
  'px-3 py-2',
  'text-[10px] font-semibold uppercase tracking-[0.08em] text-theme-text-muted/70',
  'whitespace-nowrap leading-tight relative group/th',
  'select-none',
].join(' ')

const stickyThBase = [
  'sticky z-[80]',
  'border-b border-theme-border/60',
  'bg-theme-surface',
  'px-3 py-2',
  'text-[10px] font-semibold uppercase tracking-[0.08em] text-theme-text-muted/70',
  'whitespace-nowrap leading-tight relative group/th',
  'select-none',
].join(' ')

const groupThBase = [
  'border-b border-theme-border/40',
  'bg-theme-surface',
  'px-3 py-1.5',
  'text-[10px] font-bold uppercase tracking-[0.1em] text-theme-text-muted',
].join(' ')

// Celda sticky: sin borde derecho por defecto, solo borde inferior
const stickyCellBase = 'sticky z-[40] border-b border-theme-border/40 px-3 py-2 text-[11px]'
const tdBase = 'border-b border-theme-border/40 px-3 py-2 text-[11px] tabular-nums'
const ALIGN: Record<string, string> = { left: 'text-left', center: 'text-center', right: 'text-right' }

// ─── Status sin badges de color — texto sobrio con dot indicador ───────────────

interface StatusInfo {
  dot: string
  text: string
  textCls: string
}

function statusInfo(row: SkuRow): StatusInfo {
  const s = row.sku
  if (s.costo_unitario === 0 && row.suggestedQty > 0) {
    return { dot: 'bg-amber-400', text: 'Sin costo', textCls: 'text-amber-600 dark:text-amber-400' }
  }
  if (s.alerta === 'Quiebre crítico' || s.alerta === 'Demanda histórica sin stock') {
    return { dot: 'bg-red-500', text: 'Crítico', textCls: 'text-red-600 dark:text-red-400' }
  }
  if (s.alerta === 'Riesgo de quiebre') {
    return { dot: 'bg-amber-400', text: 'En riesgo', textCls: 'text-amber-600 dark:text-amber-400' }
  }
  if (s.alerta === 'Producto muerto con stock') {
    return { dot: 'bg-theme-text-muted/40', text: 'Sin rotación', textCls: 'text-theme-text-muted' }
  }
  if (row.suggestedQty > 0) {
    return { dot: 'bg-emerald-500', text: 'A reponer', textCls: 'text-emerald-600 dark:text-emerald-400' }
  }
  return { dot: 'bg-theme-text-muted/30', text: 'Normal', textCls: 'text-theme-text-muted' }
}

// ─── Sub-componentes ──────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string
  sortKey: SortKey
  currentSort: SortConfig | null
  onSort: (k: SortKey) => void
  align?: string
}

function SortHeader({ label, sortKey, currentSort, onSort, align = 'text-left' }: SortHeaderProps) {
  const active = currentSort?.key === sortKey
  return (
    <div
      className={`flex items-center gap-1 cursor-pointer w-full h-full ${align === 'text-right' ? 'flex-row-reverse' : ''}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="truncate">{label}</span>
      <span className={`shrink-0 transition-colors ${active ? 'text-theme-accent' : 'text-theme-text-muted/20 group-hover/th:text-theme-text-muted/50'}`}>
        {active
          ? currentSort.direction === 'asc'
            ? <ChevronUp className="w-3 h-3" />
            : <ChevronDown className="w-3 h-3" />
          : <ChevronsUpDown className="w-3 h-3" />
        }
      </span>
    </div>
  )
}

interface ColumnResizerProps {
  currentWidth: number
  onResizeCommit: (w: number) => void
}

function ColumnResizer({ currentWidth, onResizeCommit }: ColumnResizerProps) {
  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-theme-accent/40 active:bg-theme-accent transition-colors z-[100]"
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.pageX
        const startW = currentWidth
        const move = (ev: MouseEvent) => onResizeCommit(Math.max(40, startW + ev.pageX - startX))
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }}
    />
  )
}

// ─── Interfaz ─────────────────────────────────────────────────────────────────

interface ReplenishmentTableProps {
  rows: SkuRow[]
  visibleFixed: ColumnId[]
  weeksVisible: boolean
  visibleBucketIndices: number[]
  bucketLabels: string[]
  colWidths: Record<WidthKey, number>
  onResizeCommit: (key: WidthKey, width: number) => void
  bucketColWidth: number
  onResizeBucketCommit: (width: number) => void
  sortConfig: SortConfig | null
  onSort: (key: SortKey) => void
  confirmedSet: Set<string>
  onToggleConfirmed: (sku: string) => void
  onUpdateQty: (sku: string, qty: number) => void
  activeSku: string | null
  onRowClick: (sku: string) => void
  onRowDoubleClick: (sku: string) => void
  hoveredRowSku: string | null
  onRowHover: (sku: string | null) => void
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function ReplenishmentTable({
  rows,
  visibleFixed,
  weeksVisible,
  visibleBucketIndices,
  bucketLabels,
  colWidths,
  onResizeCommit,
  bucketColWidth,
  onResizeBucketCommit,
  sortConfig,
  onSort,
  confirmedSet,
  onToggleConfirmed,
  onUpdateQty,
  activeSku,
  onRowClick,
  onRowDoubleClick,
  hoveredRowSku,
  onRowHover,
}: ReplenishmentTableProps) {

  // Offsets sticky
  const stickyLeft = useMemo(() => {
    const map: Record<string, number> = {}
    let acc = 0
    for (const id of visibleFixed) {
      const w = getColumnWidth(id, colWidths)
      if (STICKY_COLUMNS.includes(id)) map[id] = acc
      acc += w
    }
    return map
  }, [visibleFixed, colWidths])

  const lastStickyId = useMemo(() => {
    for (let i = visibleFixed.length - 1; i >= 0; i--) {
      if (STICKY_COLUMNS.includes(visibleFixed[i])) return visibleFixed[i]
    }
    return null
  }, [visibleFixed])

  const totalColumns = visibleFixed.length + (weeksVisible ? visibleBucketIndices.length : 0)

  const groupSpan = (columns: ColumnId[]): number => {
    let n = 0
    for (const c of columns) {
      if (c === 'semanas') n += weeksVisible ? visibleBucketIndices.length : 0
      else if (visibleFixed.includes(c)) n += 1
    }
    return n
  }

  // ─── Header cell ──────────────────────────────────────────────────

  const renderHeaderCell = (id: ColumnId) => {
    const def = COLUMN_DEFS[id]
    const w = getColumnWidth(id, colWidths)
    const isSticky = !!def.sticky
    const isLastSticky = isSticky && lastStickyId === id
    const borderRight = isLastSticky
      ? 'border-r border-theme-border/60 shadow-[1px_0_0_0_var(--theme-border)]'
      : ''
    const cls = `${isSticky ? stickyThBase : thBase} ${ALIGN[def.align]} ${borderRight}`

    return (
      <th
        key={id}
        className={cls}
        style={{ ...(isSticky ? { left: stickyLeft[id] } : {}), width: w, minWidth: w, maxWidth: w }}
      >
        {id === 'confirmar' ? (
          <div className="flex w-full h-full items-center justify-center">Conf.</div>
        ) : def.sortKey ? (
          <SortHeader
            label={def.label}
            sortKey={def.sortKey}
            currentSort={sortConfig}
            onSort={onSort}
            align={ALIGN[def.align]}
          />
        ) : (
          <div className="w-full truncate">{def.label}</div>
        )}
        {def.resizable && def.widthKey && (
          <ColumnResizer currentWidth={w} onResizeCommit={nw => onResizeCommit(def.widthKey!, nw)} />
        )}
      </th>
    )
  }

  // ─── Body cell ────────────────────────────────────────────────────

  const renderBodyCell = (id: ColumnId, row: SkuRow, idx: number, isActive: boolean, isHovered: boolean, isConfirmed: boolean) => {
    const s = row.sku
    const def = COLUMN_DEFS[id]
    const w = getColumnWidth(id, colWidths)
    const align = ALIGN[def.align]
    const productName = getProductName(s)
    const realSupplierName = getRealSupplierName(s)
    const pseudoSupplierName = getPseudoSupplierName(s)
    const unresolved = productName === PRODUCT_FALLBACK
    const isSticky = !!def.sticky
    const isLastSticky = isSticky && lastStickyId === id

    // Fondo de celda — limpio, sin alternado, solo hover/active
    const cellBg = isActive
      ? 'bg-theme-accent/8'
      : isHovered
        ? 'bg-theme-text/[0.025]'
        : 'bg-theme-surface'

    const stickyBorder = isLastSticky
      ? 'border-r border-theme-border/50 shadow-[1px_0_0_0_rgba(0,0,0,0.04)]'
      : ''

    switch (id) {
      case 'index':
        return (
          <td key={id}
            className={`${stickyCellBase} ${cellBg} text-center font-mono text-[10px] text-theme-text-muted/40`}
            style={{ left: stickyLeft[id] ?? undefined, width: w, minWidth: w, maxWidth: w }}>
            {idx + 1}
          </td>
        )
      case 'sku':
        return (
          <td key={id}
            className={`${stickyCellBase} ${cellBg} font-mono text-[11px] font-semibold text-theme-accent`}
            style={{ left: stickyLeft[id], width: w, minWidth: w, maxWidth: w }}>
            <div className="truncate">{s.SKU}</div>
          </td>
        )
      case 'product':
        return (
          <td key={id}
            className={`${stickyCellBase} ${cellBg} ${stickyBorder} ${unresolved ? 'text-amber-600 dark:text-amber-400' : 'text-theme-text'} font-medium`}
            style={{ left: stickyLeft[id], width: w, minWidth: w, maxWidth: w }}
            title={productName}>
            <div className="truncate text-[11px]">{productName}</div>
          </td>
        )
      case 'variant':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} text-theme-text-muted/70`}
            style={{ width: w, minWidth: w, maxWidth: w }}
            title={s.variante || s.tipo_producto || ''}>
            <div className="truncate">{s.variante || s.tipo_producto || '—'}</div>
          </td>
        )
      case 'supplier':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} text-theme-text`}
            style={{ width: w, minWidth: w, maxWidth: w }}
            title={realSupplierName}>
            <div className="truncate text-[11px]">{realSupplierName}</div>
          </td>
        )
      case 'line':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} text-theme-text-muted`}
            style={{ width: w, minWidth: w, maxWidth: w }}
            title={pseudoSupplierName}>
            <div className="truncate">{pseudoSupplierName}</div>
          </td>
        )
      case 'disponible':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} font-semibold text-theme-text`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            {s.cantidad_disponible ?? '—'}
          </td>
        )
      case 'estado': {
        const si = statusInfo(row)
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align}`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            <span className="inline-flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${si.dot}`} />
              <span className={`text-[10px] font-medium ${si.textCls} whitespace-nowrap`}>{si.text}</span>
            </span>
          </td>
        )
      }
      case 'sugerido':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} font-semibold ${row.suggestedQty > 0 ? 'text-theme-text' : 'text-theme-text-muted/30'}`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            {row.suggestedQty > 0 ? row.suggestedQty : '—'}
          </td>
        )
      case 'cantidad':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align}`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            <input
              type="number"
              min="0"
              value={row.confirmedQty}
              onChange={e => onUpdateQty(s.SKU, Number(e.target.value))}
              className="h-6 w-full rounded border border-theme-border/60 bg-transparent px-1 text-right text-[10px] font-medium text-theme-text outline-none focus:border-theme-accent focus:ring-1 focus:ring-theme-accent/15 hover:border-theme-border"
            />
          </td>
        )
      case 'monto':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} font-medium ${row.confirmedCost > 0 ? 'text-theme-text' : 'text-theme-text-muted/30'}`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            {row.confirmedCost > 0 ? fmtN(row.confirmedCost) : '—'}
          </td>
        )
      case 'confirmar':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align}`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            <input
              type="checkbox"
              checked={confirmedSet.has(s.SKU)}
              onChange={() => onToggleConfirmed(s.SKU)}
              className="h-3.5 w-3.5 rounded border-theme-border/60 text-theme-accent cursor-pointer"
            />
          </td>
        )
      case 'totalVendido':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} font-medium text-theme-text`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            {row.totalUnits || '—'}
          </td>
        )
      case 'promedio':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} text-theme-text`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            {row.avgPer7 > 0 ? row.avgPer7.toFixed(1) : '—'}
          </td>
        )
      case 'costo':
        return (
          <td key={id}
            className={`${tdBase} ${cellBg} ${align} text-theme-text-muted`}
            style={{ width: w, minWidth: w, maxWidth: w }}>
            {row.sku.costo_unitario === 0 && row.suggestedQty > 0
              ? <span className="font-medium text-amber-500">s/costo</span>
              : fmtN(s.costo_unitario)
            }
          </td>
        )
      default:
        return null
    }
  }

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden px-2 pb-2 pt-1">
      <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-theme-border/50 bg-theme-surface shadow-sm">
        <table className="w-max border-separate border-spacing-0 text-[11px]">
          <thead className="sticky top-0 z-[70] bg-theme-surface shadow-sm">
            {/* Fila de grupos */}
            <tr className="bg-theme-surface">
              {TABLE_GROUPS.map((g, gi) => {
                const span = groupSpan(g.columns)
                if (span <= 0) return null
                const isLast = TABLE_GROUPS.slice(gi + 1).every(gg => groupSpan(gg.columns) <= 0)
                const isProducto = g.label === 'Producto'
                return (
                  <th
                    key={g.label}
                    colSpan={span}
                    className={`${groupThBase} ${isProducto ? ALIGN.left : ALIGN.center}${isLast ? ' border-r-0' : ''}`}
                  >
                    {g.label}
                  </th>
                )
              })}
            </tr>
            {/* Fila de columnas */}
            <tr className="bg-theme-surface shadow-[0_1px_0_0_rgba(0,0,0,0.06)]">
              {visibleFixed.map(id => renderHeaderCell(id))}
              {weeksVisible && visibleBucketIndices.map(bi => {
                const bucketSortKey = `bucket_${bi}` as SortKey
                const active = sortConfig?.key === bucketSortKey
                return (
                  <th
                    key={`w-${bi}`}
                    className={`${thBase} text-center font-mono relative`}
                    style={{ width: bucketColWidth, minWidth: bucketColWidth, maxWidth: bucketColWidth }}
                    title={bucketLabels[bi]}
                  >
                    <SortHeader
                      label={bucketLabels[bi] ?? `Sem. ${bi + 1}`}
                      sortKey={bucketSortKey}
                      currentSort={sortConfig}
                      onSort={onSort}
                      align="text-center"
                    />
                    <ColumnResizer currentWidth={bucketColWidth} onResizeCommit={onResizeBucketCommit} />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const s = row.sku
              const isActive = activeSku === s.SKU
              const isHovered = hoveredRowSku === s.SKU
              const isConfirmed = confirmedSet.has(s.SKU)

              // Indicador de fila activa / confirmada: sutil línea izquierda
              const activeIndicator = isActive
                ? 'border-l-2 border-l-theme-accent'
                : isConfirmed
                  ? 'border-l-2 border-l-emerald-500/50'
                  : 'border-l-2 border-l-transparent'

              const rowBg = isActive
                ? 'bg-theme-accent/[0.06]'
                : isHovered
                  ? 'bg-theme-text/[0.025]'
                  : 'bg-theme-surface'

              return (
                <tr
                  key={s.SKU + idx}
                  onClick={() => onRowClick(s.SKU)}
                  onDoubleClick={() => onRowDoubleClick(s.SKU)}
                  onMouseEnter={() => onRowHover(s.SKU)}
                  onMouseLeave={() => onRowHover(null)}
                  className={`cursor-pointer transition-colors ${activeIndicator}`}
                >
                  {visibleFixed.map(id => renderBodyCell(id, row, idx, isActive, isHovered, isConfirmed))}
                  {weeksVisible && visibleBucketIndices.map(bi => {
                    const val = row.buckets[bi]
                    return (
                      <td
                        key={`w-${bi}`}
                        className={`${tdBase} ${rowBg} text-right font-mono text-theme-text`}
                        style={{ width: bucketColWidth, minWidth: bucketColWidth, maxWidth: bucketColWidth }}
                      >
                        {val > 0 ? val : <span className="text-theme-text-muted/30">—</span>}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={totalColumns}
                  className="bg-theme-surface py-16 text-center text-sm text-theme-text-muted"
                >
                  No se encontraron SKU con los filtros actuales.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
