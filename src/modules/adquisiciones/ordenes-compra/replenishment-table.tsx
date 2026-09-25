'use client'

import { useMemo } from 'react'
import { ChevronDown, ChevronUp, ChevronsUpDown, Info } from 'lucide-react'
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

// ─── Paleta fija — referencia matriz financiera ────────────────────────────────
// Charcoal:  #322D29  → fondo header de grupos
// Ivory:     #EFE9E1  → texto sobre charcoal
// Stone:     #D1C7BD  → bordes, divisores
// Taupe:     #AC9C8D  → labels secundarios, muted
// Burgundy:  #72383D  → acento: activo, foco, sort

const COL_GROUP_BG  = '#322D29'   // header grupo — charcoal
const COL_GROUP_FG  = '#EFE9E1'   // texto grupo — ivory
const COL_HEAD_BG   = '#F7F4F0'   // header columna — ivory muy claro
const COL_HEAD_FG   = '#322D29'   // texto columna — charcoal
const COL_HEAD_MUT  = '#AC9C8D'   // texto secundario / muted columna
const BODY_BG       = '#FFFFFF'   // fondo cuerpo — blanco
const BODY_STRIPE   = '#FBFAF8'   // stripe alternada (muy sutil)
const BODY_HOVER    = '#F3EFE9'   // hover — taupe tenue
const BODY_ACTIVE   = '#F5EDEE'   // activo — burgundy ultra suave
const BODY_CONFIRM  = '#EFF7F3'   // confirmado — verde ultra suave
const BORDER_FINE   = '#E5DDD4'   // divisor fino — stone claro
const BORDER_GROUP  = '#C8BDB3'   // divisor de grupo — stone

// ─── Clases base ──────────────────────────────────────────────────────────────

// Header de GRUPOS — charcoal oscuro, texto ivory
const groupThBase = [
  'px-3 py-[5px]',
  'text-[9px] font-bold uppercase tracking-[0.12em]',
  'whitespace-nowrap select-none',
].join(' ')

// Header de COLUMNAS — ivory claro, texto charcoal
const thBase = [
  'px-3 py-[5px]',
  'text-[9px] font-semibold uppercase tracking-[0.08em]',
  'whitespace-nowrap leading-tight relative group/th',
  'select-none',
].join(' ')

const stickyThBase = [
  'sticky z-[80]',
  'px-3 py-[5px]',
  'text-[9px] font-semibold uppercase tracking-[0.08em]',
  'whitespace-nowrap leading-tight relative group/th',
  'select-none',
].join(' ')

// Celda body sticky
const stickyCellBase = 'sticky z-[40] border-b px-3 py-1.5 text-[11px]'
// Celda body normal
const tdBase = 'border-b px-3 py-1.5 text-[11px] tabular-nums'

const ALIGN: Record<string, string> = { left: 'text-left', center: 'text-center', right: 'text-right' }

// ─── Estado — colores semánticos intactos ─────────────────────────────────────

interface StatusInfo { dot: string; text: string; textCls: string }

function statusInfo(row: SkuRow): StatusInfo {
  const s = row.sku
  if (s.costo_unitario === 0 && row.suggestedQty > 0)
    return { dot: 'bg-amber-400', text: 'Sin costo', textCls: 'text-amber-600' }
  if (s.alerta === 'Quiebre crítico' || s.alerta === 'Demanda histórica sin stock')
    return { dot: 'bg-red-500', text: 'Crítico', textCls: 'text-red-600' }
  if (s.alerta === 'Riesgo de quiebre')
    return { dot: 'bg-amber-400', text: 'En riesgo', textCls: 'text-amber-600' }
  if (s.alerta === 'Producto muerto con stock')
    return { dot: 'bg-[#AC9C8D]/60', text: 'Sin rotación', textCls: 'text-[#AC9C8D]' }
  if (row.suggestedQty > 0)
    return { dot: 'bg-emerald-500', text: 'A reponer', textCls: 'text-emerald-600' }
  return { dot: 'bg-[#AC9C8D]/30', text: 'Normal', textCls: 'text-[#AC9C8D]' }
}

// ─── Sort header ──────────────────────────────────────────────────────────────

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
      <span
        className="shrink-0 transition-colors"
        style={{ color: active ? '#72383D' : 'rgba(172,156,141,0.3)' }}
      >
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

// ─── Column resizer ───────────────────────────────────────────────────────────

interface ColumnResizerProps {
  currentWidth: number
  onResizeCommit: (w: number) => void
}

function ColumnResizer({ currentWidth, onResizeCommit }: ColumnResizerProps) {
  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-[100]"
      style={{ transition: 'background 0.15s' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(114,56,61,0.35)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
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

  // ─── Offsets sticky ─────────────────────────────────────────────────
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

  // ─── Span de grupos ──────────────────────────────────────────────────
  const groupSpan = (columns: ColumnId[]): number => {
    let n = 0
    for (const c of columns) {
      if (c === 'semanas') n += weeksVisible ? visibleBucketIndices.length : 0
      else if (visibleFixed.includes(c)) n += 1
    }
    return n
  }

  // ─── Determinar última columna de cada grupo (para divisor derecho) ──
  const groupLastCols = useMemo(() => {
    const set = new Set<string>()
    for (const g of TABLE_GROUPS) {
      const cols = g.columns.filter(c => c !== 'semanas' && visibleFixed.includes(c as ColumnId))
      if (cols.length > 0) set.add(cols[cols.length - 1])
      else if (g.columns.includes('semanas') && weeksVisible && visibleBucketIndices.length > 0) {
        // última semana — manejado aparte
      }
    }
    return set
  }, [visibleFixed, weeksVisible, visibleBucketIndices])

  // ─── Header cell ─────────────────────────────────────────────────────

  const renderHeaderCell = (id: ColumnId) => {
    const def = COLUMN_DEFS[id]
    const w = getColumnWidth(id, colWidths)
    const isSticky = !!def.sticky
    const isLastSticky = isSticky && lastStickyId === id
    const isGroupLast = groupLastCols.has(id)

    const borderRight = isLastSticky
      ? `border-r shadow-[1px_0_0_0_${BORDER_GROUP}]`
      : isGroupLast
        ? `border-r`
        : ''

    const cls = `${isSticky ? stickyThBase : thBase} ${ALIGN[def.align]} ${borderRight}`

    return (
      <th
        key={id}
        className={cls}
        style={{
          ...(isSticky ? { left: stickyLeft[id] } : {}),
          width: w,
          minWidth: w,
          maxWidth: w,
          background: COL_HEAD_BG,
          color: COL_HEAD_FG,
          borderBottomColor: BORDER_FINE,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          ...(isGroupLast || isLastSticky ? { borderRightColor: BORDER_GROUP, borderRightWidth: 1, borderRightStyle: 'solid' } : {}),
        }}
      >
        {id === 'confirmar' ? (
          <div className="flex w-full h-full items-center justify-center" style={{ color: COL_HEAD_MUT }}>Conf.</div>
        ) : def.sortKey ? (
          <SortHeader
            label={def.label}
            sortKey={def.sortKey}
            currentSort={sortConfig}
            onSort={onSort}
            align={ALIGN[def.align]}
          />
        ) : (
          <div className="w-full truncate" style={{ color: COL_HEAD_FG }}>{def.label}</div>
        )}
        {def.resizable && def.widthKey && (
          <ColumnResizer currentWidth={w} onResizeCommit={nw => onResizeCommit(def.widthKey!, nw)} />
        )}
      </th>
    )
  }

  // ─── Body cell ────────────────────────────────────────────────────────

  const renderBodyCell = (
    id: ColumnId,
    row: SkuRow,
    idx: number,
    isActive: boolean,
    isHovered: boolean,
    isConfirmed: boolean,
    rowBg: string,
  ) => {
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
    const isGroupLast = groupLastCols.has(id)

    const cellStyle: React.CSSProperties = {
      background: rowBg,
      borderBottomColor: BORDER_FINE,
      borderBottomWidth: 1,
      borderBottomStyle: 'solid',
      ...(isSticky ? { left: stickyLeft[id] } : {}),
      width: w,
      minWidth: w,
      maxWidth: w,
      ...(isGroupLast || isLastSticky
        ? { borderRightColor: BORDER_GROUP, borderRightWidth: 1, borderRightStyle: 'solid' }
        : {}),
    }

    switch (id) {
      case 'index':
        return (
          <td key={id}
            className={`${stickyCellBase} text-center font-mono text-[10px]`}
            style={{ ...cellStyle, color: '#C8BDB3' }}>
            {idx + 1}
          </td>
        )
      case 'sku':
        return (
          <td key={id}
            className={`${stickyCellBase} font-mono text-[11px] font-semibold`}
            style={{ ...cellStyle, color: '#72383D' }}>
            <div className="truncate">{s.SKU}</div>
          </td>
        )
      case 'product':
        return (
          <td key={id}
            className={`${stickyCellBase} font-medium`}
            style={{ ...cellStyle, color: unresolved ? '#B45309' : '#322D29' }}
            title={productName}>
            <div className="truncate text-[11px]">{productName}</div>
          </td>
        )
      case 'variant':
        return (
          <td key={id}
            className={`${tdBase} ${align}`}
            style={{ ...cellStyle, color: '#AC9C8D' }}
            title={s.variante || s.tipo_producto || ''}>
            <div className="truncate">{s.variante || s.tipo_producto || '—'}</div>
          </td>
        )
      case 'supplier':
        return (
          <td key={id}
            className={`${tdBase} ${align}`}
            style={{ ...cellStyle, color: '#322D29' }}
            title={realSupplierName}>
            <div className="truncate text-[11px]">{realSupplierName}</div>
          </td>
        )
      case 'line':
        return (
          <td key={id}
            className={`${tdBase} ${align}`}
            style={{ ...cellStyle, color: '#6B5F57' }}
            title={pseudoSupplierName}>
            <div className="truncate">{pseudoSupplierName}</div>
          </td>
        )
      case 'disponible':
        return (
          <td key={id}
            className={`${tdBase} ${align} font-semibold`}
            style={{ ...cellStyle, color: '#322D29' }}>
            {s.cantidad_disponible ?? '—'}
          </td>
        )
      case 'estado': {
        const si = statusInfo(row)
        return (
          <td key={id}
            className={`${tdBase} ${align}`}
            style={cellStyle}>
            <span className="inline-flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${si.dot}`} />
              <span className={`text-[10px] font-medium ${si.textCls} whitespace-nowrap`}>{si.text}</span>
            </span>
          </td>
        )
      }
      case 'sugerido': {
        const suggestedTitle = row.suggestedCalculable
          ? [
              `Ritmo con stock: ${row.suggestedRate?.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ud/día`,
              `Cobertura objetivo: ${row.suggestedTargetDays} días`,
              `Necesidad estimada: ${row.suggestedTargetUnits?.toLocaleString('es-CL', { maximumFractionDigits: 2 })} un.`,
              `Stock físico: ${s.cantidad_disponible} un.`,
              `Sugerido: ${row.suggestedQty} un.`,
              'Ritmo calculado sobre historial de 60 días, ajustado por disponibilidad.',
            ].join('\n')
          : `No se puede calcular automáticamente: ${row.suggestedReason}`
        const qtyColor = row.suggestedCalculable && row.suggestedQty > 0
          ? '#322D29'
          : row.suggestedCalculable
            ? '#AC9C8D'
            : '#B45309'
        return (
          <td key={id}
            className={`${tdBase} ${align} font-semibold`}
            style={{ ...cellStyle, color: qtyColor }}
            title={suggestedTitle}
            aria-label={suggestedTitle}>
            {row.suggestedCalculable ? row.suggestedQty : 'Revisar'}
          </td>
        )
      }
      case 'cantidad':
        return (
          <td key={id}
            className={`${tdBase} ${align}`}
            style={cellStyle}>
            <input
              type="number"
              min="0"
              value={row.confirmedQty}
              onChange={e => onUpdateQty(s.SKU, Number(e.target.value))}
              className="h-6 w-full rounded border px-1 text-right text-[10px] font-medium outline-none"
              style={{
                background: 'transparent',
                borderColor: BORDER_FINE,
                color: '#322D29',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = '#72383D'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(114,56,61,0.12)' }}
              onBlur={e => { e.currentTarget.style.borderColor = BORDER_FINE; e.currentTarget.style.boxShadow = 'none' }}
            />
          </td>
        )
      case 'monto':
        return (
          <td key={id}
            className={`${tdBase} ${align} font-medium`}
            style={{ ...cellStyle, color: row.confirmedCost > 0 ? '#322D29' : '#C8BDB3' }}>
            {row.confirmedCost > 0 ? fmtN(row.confirmedCost) : '—'}
          </td>
        )
      case 'confirmar':
        return (
          <td key={id}
            className={`${tdBase} ${align}`}
            style={cellStyle}>
            <input
              type="checkbox"
              checked={confirmedSet.has(s.SKU) && row.confirmedQty > 0}
              onChange={() => onToggleConfirmed(s.SKU)}
              className="h-3.5 w-3.5 rounded cursor-pointer"
              style={{
                accentColor: '#72383D',
                borderColor: BORDER_FINE,
              }}
            />
          </td>
        )
      case 'totalVendido':
        return (
          <td key={id}
            className={`${tdBase} ${align} font-medium`}
            style={{ ...cellStyle, color: '#322D29' }}>
            {row.totalUnits || '—'}
          </td>
        )
      case 'promedio':
        return (
          <td key={id}
            className={`${tdBase} ${align}`}
            style={{ ...cellStyle, color: '#322D29' }}>
            {row.avgPer7 > 0 ? row.avgPer7.toFixed(1) : '—'}
          </td>
        )
      case 'costo':
        return (
          <td key={id}
            className={`${tdBase} ${align}`}
            style={{ ...cellStyle, color: '#AC9C8D' }}>
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

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    /* Contenedor externo: ocupa TODO el ancho disponible del workspace */
    <div className="h-full flex flex-col overflow-hidden" style={{ padding: '0 0 6px 0' }}>
      <div
        className="flex-1 min-h-0 overflow-auto w-full"
        style={{
          borderTop: `1px solid ${BORDER_FINE}`,
          background: BODY_BG,
        }}
      >
        <table
          className="border-separate border-spacing-0 text-[11px]"
          style={{ width: 'max-content', minWidth: '100%' }}
        >
          {/* ─── THEAD sticky ─────────────────────────────────────────── */}
          <thead style={{ position: 'sticky', top: 0, zIndex: 70 }}>

            {/* Fila 1: GRUPOS — fondo charcoal, texto ivory */}
            <tr>
              {TABLE_GROUPS.map((g, gi) => {
                const span = groupSpan(g.columns)
                if (span <= 0) return null
                const isFirst = TABLE_GROUPS.slice(0, gi).every(gg => groupSpan(gg.columns) <= 0)
                const isLast  = TABLE_GROUPS.slice(gi + 1).every(gg => groupSpan(gg.columns) <= 0)
                const isProducto = g.label === 'Producto'
                return (
                  <th
                    key={g.label}
                    colSpan={span}
                    className={`${groupThBase} ${isProducto ? 'text-left' : 'text-center'}`}
                    style={{
                      background: COL_GROUP_BG,
                      color: COL_GROUP_FG,
                      borderBottom: `1px solid rgba(239,233,225,0.15)`,
                      // Separador entre grupos — línea tenue en ivory
                      ...(!isLast
                        ? { borderRight: `1px solid rgba(239,233,225,0.2)` }
                        : {}),
                    }}
                  >
                    <span className="inline-flex items-center gap-1" style={{ opacity: 0.92 }}>
                      {g.label}
                      {g.label === 'Cálculo sugerido' && (
                        <span
                          title="Calculado con el ritmo de venta durante días con stock de los últimos 60 días."
                          aria-label="Calculado con el ritmo de venta durante días con stock de los últimos 60 días."
                        >
                          <Info className="h-3 w-3" style={{ color: COL_GROUP_FG, opacity: 0.5 }} aria-hidden="true" />
                        </span>
                      )}
                    </span>
                  </th>
                )
              })}
            </tr>

            {/* Fila 2: COLUMNAS — ivory claro, texto charcoal */}
            <tr>
              {visibleFixed.map(id => renderHeaderCell(id))}
              {weeksVisible && visibleBucketIndices.map((bi, arrIdx) => {
                const bucketSortKey = `bucket_${bi}` as SortKey
                const isLastBucket = arrIdx === visibleBucketIndices.length - 1
                return (
                  <th
                    key={`w-${bi}`}
                    className={`${thBase} text-center font-mono relative`}
                    style={{
                      width: bucketColWidth,
                      minWidth: bucketColWidth,
                      maxWidth: bucketColWidth,
                      background: COL_HEAD_BG,
                      color: COL_HEAD_FG,
                      borderBottomColor: BORDER_FINE,
                      borderBottomWidth: 1,
                      borderBottomStyle: 'solid',
                      ...(isLastBucket
                        ? { borderRightColor: BORDER_GROUP, borderRightWidth: 1, borderRightStyle: 'solid' }
                        : {}),
                    }}
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

          {/* ─── TBODY ────────────────────────────────────────────────── */}
          <tbody>
            {rows.map((row, idx) => {
              const s = row.sku
              const isActive    = activeSku === s.SKU
              const isHovered   = hoveredRowSku === s.SKU
              const isConfirmed = confirmedSet.has(s.SKU)

              // Fondo de fila — claro, casi sin alternado
              const rowBg = isActive
                ? BODY_ACTIVE
                : isHovered
                  ? BODY_HOVER
                  : isConfirmed
                    ? BODY_CONFIRM
                    : idx % 2 === 0
                      ? BODY_BG
                      : BODY_STRIPE

              // Indicador izquierdo de estado activo/confirmado
              const leftBorderColor = isActive
                ? '#72383D'
                : isConfirmed
                  ? 'rgba(52,168,83,0.45)'
                  : 'transparent'

              return (
                <tr
                  key={s.SKU + idx}
                  onClick={() => onRowClick(s.SKU)}
                  onDoubleClick={() => onRowDoubleClick(s.SKU)}
                  onMouseEnter={() => onRowHover(s.SKU)}
                  onMouseLeave={() => onRowHover(null)}
                  className="cursor-pointer"
                  style={{
                    borderLeft: `2px solid ${leftBorderColor}`,
                    transition: 'background 0.1s',
                  }}
                >
                  {visibleFixed.map(id => renderBodyCell(id, row, idx, isActive, isHovered, isConfirmed, rowBg))}
                  {weeksVisible && visibleBucketIndices.map((bi, arrIdx) => {
                    const val = row.buckets[bi]
                    const isLastBucket = arrIdx === visibleBucketIndices.length - 1
                    return (
                      <td
                        key={`w-${bi}`}
                        className={`${tdBase} text-right font-mono`}
                        style={{
                          background: rowBg,
                          color: val > 0 ? '#322D29' : '#C8BDB3',
                          width: bucketColWidth,
                          minWidth: bucketColWidth,
                          maxWidth: bucketColWidth,
                          borderBottomColor: BORDER_FINE,
                          ...(isLastBucket
                            ? { borderRightColor: BORDER_GROUP, borderRightWidth: 1, borderRightStyle: 'solid' }
                            : {}),
                        }}
                      >
                        {val > 0 ? val : '—'}
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
                  className="py-16 text-center text-sm"
                  style={{ background: BODY_BG, color: '#AC9C8D' }}
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
