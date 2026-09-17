'use client'

import { useMemo, useState, type MouseEvent } from 'react'
import type { BreakSummary60d } from '@/app/actions/integraciones/bsale-dataset'
import type { DailySalesPoint } from './replenishment-derive'

interface ReplenishmentSalesHoverChartProps {
  productName: string
  sku: string
  sparseSeries: DailySalesPoint[] | undefined
  dateTo: string
  stockActual: number
  breakSummary: BreakSummary60d
}

const CHART_WIDTH = 336
const CHART_HEIGHT = 132
const PADDING = { top: 10, right: 10, bottom: 24, left: 34 }

function formatDate(date: string) {
  const parsed = new Date(`${date}T00:00:00Z`)
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', timeZone: 'UTC' })
    .format(parsed)
    .replace('.', '')
}

function formatDecimal(value: number) {
  return new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

function formatEvidence(value: number) {
  return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)
}

function formatBreakDate(date: string) {
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
}

function completeSeries(sparseSeries: DailySalesPoint[] | undefined, dateTo: string) {
  const byDate = new Map((sparseSeries || []).map(point => [point.date, point.units]))
  const end = new Date(`${dateTo}T00:00:00Z`)
  const points: DailySalesPoint[] = []

  for (let offset = 59; offset >= 0; offset--) {
    const date = new Date(end)
    date.setUTCDate(date.getUTCDate() - offset)
    const dateString = date.toISOString().slice(0, 10)
    points.push({ date: dateString, units: byDate.get(dateString) ?? 0 })
  }

  return points
}

export function ReplenishmentSalesHoverChart({
  productName,
  sku,
  sparseSeries,
  dateTo,
  stockActual,
  breakSummary,
}: ReplenishmentSalesHoverChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const series = useMemo(() => completeSeries(sparseSeries, dateTo), [sparseSeries, dateTo])
  const total = series.reduce((sum, point) => sum + point.units, 0)
  const salesRateWithStock = breakSummary.salesIdentityResolved && breakSummary.salesRateWithStock !== null
    ? breakSummary.salesRateWithStock
    : null
  const coverageDays = salesRateWithStock !== null && salesRateWithStock > 0 && stockActual >= 0
    ? Math.round(stockActual / salesRateWithStock)
    : null
  const hasMovement = series.some(point => point.units !== 0)

  const { min, max, points } = useMemo(() => {
    const values = series.map(point => point.units)
    let minValue = Math.min(...values)
    let maxValue = Math.max(...values)
    if (minValue === maxValue) {
      if (minValue === 0) {
        minValue = -1
        maxValue = 1
      } else {
        const padding = Math.max(1, Math.abs(minValue) * 0.2)
        minValue -= padding
        maxValue += padding
      }
    } else {
      const padding = Math.max(1, (maxValue - minValue) * 0.08)
      minValue -= padding
      maxValue += padding
    }

    const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right
    const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom
    const valueToY = (value: number) => PADDING.top + ((maxValue - value) / (maxValue - minValue)) * innerHeight
    const chartPoints = series.map((point, index) => ({
      ...point,
      x: PADDING.left + (index / (series.length - 1)) * innerWidth,
      y: valueToY(point.units),
    }))

    return { min: minValue, max: maxValue, points: chartPoints }
  }, [series])

  const hoveredPoint = hoveredIndex == null ? null : points[hoveredIndex]
  const zeroY = PADDING.top + ((max - 0) / (max - min)) * (CHART_HEIGHT - PADDING.top - PADDING.bottom)
  const line = points.map(point => `${point.x},${point.y}`).join(' ')
  const stockoutBands = useMemo(() => {
    const step = points.length > 1 ? points[1].x - points[0].x : 0
    const firstX = PADDING.left
    const lastX = CHART_WIDTH - PADDING.right
    return breakSummary.stockoutRanges.flatMap(range => {
      const startIndex = points.findIndex(point => point.date === range.from)
      const endIndex = points.findIndex(point => point.date === range.to)
      if (startIndex < 0 || endIndex < startIndex) return []
      const x = Math.max(firstX, points[startIndex].x - step / 2)
      const end = Math.min(lastX, points[endIndex].x + step / 2)
      return [{ x, width: Math.max(0, end - x), from: range.from, to: range.to }]
    })
  }, [breakSummary.stockoutRanges, points])

  function handleChartMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    setHoveredIndex(Math.round(ratio * (series.length - 1)))
  }

  return (
    <section className="pointer-events-auto w-[360px] max-w-[calc(100vw-24px)] rounded-xl border border-theme-border/50 bg-theme-surface/95 p-3 text-theme-text shadow-[0_12px_30px_rgba(15,23,42,0.14)] backdrop-blur-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold" title={productName}>{productName}</p>
          <p className="mt-0.5 font-mono text-[10px] text-theme-text-muted">SKU {sku}</p>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-y border-theme-border/50 py-2">
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-theme-text-muted">Ventas 60d</p>
          <p className="text-xs font-semibold tabular-nums">{total} un.</p>
        </div>
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-theme-text-muted">Stock actual</p>
          <p className={`text-xs font-semibold tabular-nums ${stockActual < 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>
            {stockActual} un.
          </p>
        </div>
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-theme-text-muted">Ritmo con stock</p>
          <p className="text-xs font-semibold tabular-nums">
            {salesRateWithStock === null ? 'No calculable' : `${formatDecimal(salesRateWithStock)} ud/día`}
          </p>
          {breakSummary.salesIdentityResolved ? (
            <p className="mt-0.5 text-[9px] text-theme-text-muted">
              {breakSummary.unitsSoldWithStock} uds en {breakSummary.daysWithStock} días con stock
            </p>
          ) : (
            <p className="mt-0.5 text-[9px] text-theme-text-muted">Identidad de ventas no resuelta</p>
          )}
        </div>
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-theme-text-muted">Cobertura estimada</p>
          <p className="text-xs font-semibold tabular-nums">
            {coverageDays == null ? 'No calculable' : `~${coverageDays} días`}
          </p>
        </div>
        <div
          className={`col-span-2 rounded-md border px-2 py-1.5 ${breakSummary.daysWithoutStock > 0
            ? 'border-amber-400/70 bg-amber-100/80 dark:border-amber-300/40 dark:bg-amber-400/15'
            : 'border-theme-border/40 bg-theme-surface/40'}`}
          title="Días calendario dentro de los últimos 60 en que el stock físico permaneció en 0 o menos. El período termina cuando cualquier movimiento deja nuevamente el stock sobre 0. Los quiebres indican cuántas veces el stock llegó a 0 o menos."
        >
          <p className={`text-[9px] font-semibold uppercase tracking-[0.08em] ${breakSummary.daysWithoutStock > 0 ? 'text-amber-800 dark:text-amber-200' : 'text-theme-text-muted'}`}>Días sin stock 60d</p>
          <p className={`text-sm font-bold tabular-nums ${breakSummary.daysWithoutStock > 0 ? 'text-amber-800 dark:text-amber-200' : ''}`}>
            {breakSummary.daysWithoutStock} días
          </p>
          {breakSummary.breakCount > 0 && (
            <p className={`text-[9px] ${breakSummary.daysWithoutStock > 0 ? 'text-amber-900/80 dark:text-amber-100/90' : 'text-amber-700 dark:text-amber-300'}`}>
              {breakSummary.breakCount} {breakSummary.breakCount === 1 ? 'quiebre' : 'quiebres'}{breakSummary.lastBreakDate ? ` · último ${formatBreakDate(breakSummary.lastBreakDate)}` : ''}
            </p>
          )}
        </div>
      </div>

      <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-theme-text-muted/80">Ventas últimos 60 días</p>
      <p className="mt-2 text-[10px] text-theme-text-muted/80">
        Evidencia histórica: {formatEvidence(breakSummary.evidenceCoveragePct)}% · {breakSummary.knownDays}/60 días
      </p>

      <div className="relative mt-1">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-[132px] w-full overflow-visible"
          role="img"
          aria-label={`Ventas diarias de ${productName}`}
          onMouseMove={handleChartMove}
          onMouseLeave={() => setHoveredIndex(null)}
        >
          {[0, 0.5, 1].map(ratio => {
            const y = PADDING.top + ratio * (CHART_HEIGHT - PADDING.top - PADDING.bottom)
            const value = max - ratio * (max - min)
            return (
              <g key={ratio}>
                <line x1={PADDING.left} y1={y} x2={CHART_WIDTH - PADDING.right} y2={y} stroke="currentColor" className="text-theme-border/30" strokeDasharray="3 3" />
                <text x={PADDING.left - 5} y={y + 3} textAnchor="end" className="fill-theme-text-muted/70 text-[9px]">{Math.round(value)}</text>
              </g>
            )
          })}
          {stockoutBands.map(band => (
            <rect
              key={`${band.from}-${band.to}`}
              x={band.x}
              y={PADDING.top}
              width={band.width}
              height={CHART_HEIGHT - PADDING.top - PADDING.bottom}
              fill="rgb(239 68 68 / 0.14)"
              aria-label={`Sin stock confirmado: ${formatDate(band.from)} a ${formatDate(band.to)}`}
            />
          ))}
          {zeroY >= PADDING.top && zeroY <= CHART_HEIGHT - PADDING.bottom && (
            <line x1={PADDING.left} y1={zeroY} x2={CHART_WIDTH - PADDING.right} y2={zeroY} stroke="currentColor" className="text-theme-text-muted/35" />
          )}
          <polyline points={line} fill="none" stroke="currentColor" className="text-theme-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hoveredPoint && (
            <>
              <line x1={hoveredPoint.x} y1={PADDING.top} x2={hoveredPoint.x} y2={CHART_HEIGHT - PADDING.bottom} stroke="currentColor" className="text-theme-text-muted/40" strokeDasharray="3 3" />
              <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="4" fill="var(--theme-accent)" stroke="var(--theme-surface)" strokeWidth="2" />
            </>
          )}
          <text x={PADDING.left} y={CHART_HEIGHT - 5} className="fill-theme-text-muted/70 text-[9px]">{formatDate(series[0].date)}</text>
          <text x={CHART_WIDTH / 2} y={CHART_HEIGHT - 5} textAnchor="middle" className="fill-theme-text-muted/70 text-[9px]">{formatDate(series[29].date)}</text>
          <text x={CHART_WIDTH - PADDING.right} y={CHART_HEIGHT - 5} textAnchor="end" className="fill-theme-text-muted/70 text-[9px]">{formatDate(series[59].date)}</text>
        </svg>
        {hoveredPoint && (
          <div className="absolute right-1 top-1 rounded-md border border-theme-border bg-theme-surface/95 px-2 py-1 text-[10px] shadow-lg">
            <span className="font-semibold">{formatDate(hoveredPoint.date)}</span>
            <span className="ml-2 tabular-nums text-theme-text-muted">{hoveredPoint.units} un.</span>
          </div>
        )}
      </div>
      {!hasMovement && <p className="mt-1 text-[10px] text-theme-text-muted">Sin movimientos en el período</p>}
      <p className="mt-1 text-[9px] text-theme-text-muted/70">Ritmo basado en días con stock confirmado</p>
    </section>
  )
}
