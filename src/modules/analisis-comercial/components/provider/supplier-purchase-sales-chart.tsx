'use client'

import type { SupplierWeeklyPoint, SupplierWeeklyDetail } from '@/app/actions/comercial/analysis/types'
import { getSupplierWeeklyDetail } from '@/app/actions/comercial/analysis/suppliers'
import { SupplierDocumentModal } from './supplier-document-modal'
import { useMemo, useState, useTransition, useEffect } from 'react'

const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

function formatCompactMoney(value: number) {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(1).replace('.0', '') + 'M'
  if (abs >= 1000) return sign + '$' + Math.round(abs / 1000) + 'K'
  return sign + '$' + abs
}

function money(value: number) {
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function monthLabel(weekStart: string) {
  const [y, m] = weekStart.split('-')
  return `${MONTHS_SHORT[parseInt(m) - 1]} ${y}`
}

function shortDate(weekStart: string) {
  const [, m, d] = weekStart.split('-')
  return `${parseInt(d)}/${parseInt(m)}`
}

function getEpoch(dateStr: string) {
  return new Date(`${dateStr}T00:00:00Z`).getTime()
}

function getMonthBoundaries(weekly: SupplierWeeklyPoint[]) {
  const boundaries: { label: string; startIndex: number; weeks: SupplierWeeklyPoint[] }[] = []
  weekly.forEach((w, i) => {
    const key = w.weekStart.slice(0, 7)
    if (i === 0 || key !== weekly[i - 1].weekStart.slice(0, 7)) {
      boundaries.push({ label: monthLabel(w.weekStart), startIndex: i, weeks: [w] })
    } else {
      boundaries[boundaries.length - 1].weeks.push(w)
    }
  })
  return boundaries
}

const baselineY_pct = 90
const usableHeight_pct = 80

export function SupplierPurchaseSalesChart({ supplierId, weekly, hasReceptionData, totalEstimatedCost }: { supplierId: string; weekly: SupplierWeeklyPoint[]; hasReceptionData: boolean; totalEstimatedCost: number }) {
  const [tab, setTab] = useState<'profitability' | 'supply'>('profitability')
  const isProfit = tab === 'profitability'
  const hasCostData = totalEstimatedCost > 0
  
  const { fullSeries, forecastStartIndex, historicalMaxPurchases, historicalMaxSales, peakSalesWeek, peakPurchasesWeek, peakMarginWeek, confidence, avgSales, avgPurchases, avgMargin } = useMemo(() => {
    let peakSales = -1
    let peakSalesW: SupplierWeeklyPoint | null = null as SupplierWeeklyPoint | null
    let peakPurchases = -1
    let peakPurchasesW: SupplierWeeklyPoint | null = null as SupplierWeeklyPoint | null
    let peakMargin = -Infinity
    let peakMarginW: SupplierWeeklyPoint | null = null as SupplierWeeklyPoint | null

    weekly.forEach(w => {
      const m = (w.margin ?? w.sales - w.purchases)
      if (w.sales > peakSales) { peakSales = w.sales; peakSalesW = w; }
      if (w.purchases > peakPurchases) { peakPurchases = w.purchases; peakPurchasesW = w; }
      if (m > peakMargin) { peakMargin = m; peakMarginW = w; }
    })
    
    const recent = weekly.slice(-8)
    const recentCount = recent.length
    const avgSales = recentCount ? recent.reduce((sum, w) => sum + w.sales, 0) / recentCount : 0
    const avgPurchases = recentCount ? recent.reduce((sum, w) => sum + w.purchases, 0) / recentCount : 0
    const avgMargin = recentCount ? recent.reduce((sum, w) => sum + (w.margin ?? w.sales - w.purchases), 0) / recentCount : 0
    
    const projected: (SupplierWeeklyPoint & { isProjection: boolean })[] = []
    if (weekly.length > 0) {
      const lastWeek = new Date(weekly[weekly.length - 1].weekStart + 'T00:00:00Z')
      for (let i = 1; i <= 13; i++) {
        const nextStart = new Date(lastWeek.getTime() + i * 7 * 24 * 60 * 60 * 1000)
        const nextEnd = new Date(nextStart.getTime() + 6 * 24 * 60 * 60 * 1000)
        const s = nextStart.toISOString().slice(0, 10)
        const e = nextEnd.toISOString().slice(0, 10)
        projected.push({
          label: `${shortDate(s)} - ${shortDate(e)}`,
          weekStart: s, weekEnd: e,
          sales: avgSales, purchases: avgPurchases,
          margin: avgMargin,
          isProjection: true
        })
      }
    }
    
    let confidence: 'alta' | 'media' | 'baja' = 'baja'
    if (recentCount >= 8) confidence = 'alta'
    else if (recentCount >= 4) confidence = 'media'
    if (recentCount > 0) {
      const totalSales = recent.reduce((s, w) => s + w.sales, 0)
      const totalPurchases = recent.reduce((s, w) => s + w.purchases, 0)
      const maxSalesShare = totalSales > 0 ? Math.max(...recent.map(w => w.sales / totalSales)) : 0
      const maxPurchasesShare = totalPurchases > 0 ? Math.max(...recent.map(w => w.purchases / totalPurchases)) : 0
      if (Math.max(maxSalesShare, maxPurchasesShare) > 0.6) {
        if (confidence === 'alta') confidence = 'media'
        else if (confidence === 'media') confidence = 'baja'
      }
    }

    return {
      fullSeries: [...weekly.map(w => ({ ...w, isProjection: false })), ...projected],
      forecastStartIndex: weekly.length,
      peakSalesWeek: peakSalesW, peakPurchasesWeek: peakPurchasesW, peakMarginWeek: peakMarginW,
      confidence, avgSales, avgPurchases, avgMargin,
      historicalMaxPurchases: peakPurchases, historicalMaxSales: peakSales
    }
  }, [weekly])
  
  const maxValue = Math.max(1, ...fullSeries.flatMap((item) => isProfit
    ? [item.sales, Math.max(0, item.margin ?? 0)]
    : [item.purchases, item.sales, item.margin || 0]))
  const n = fullSeries.length

  const [cache, setCache] = useState<Record<string, SupplierWeeklyDetail>>({})
  const [hoveredPoint, setHoveredPoint] = useState<(SupplierWeeklyPoint & { isProjection: boolean; x: number }) | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalData, setModalData] = useState<SupplierWeeklyDetail | null>(null)
  const [modalType, setModalType] = useState<'PURCHASE' | 'SALE'>('PURCHASE')
  const [loadingModal, setLoadingModal] = useState(false)

  const [showMargin, setShowMargin] = useState(false)
  const [, startTransition] = useTransition()

  const handleOpenModal = (w: SupplierWeeklyPoint & { isProjection?: boolean }, type: 'PURCHASE' | 'SALE') => {
    if (w.isProjection) return
    const cacheKey = `${supplierId}:${w.weekStart}:${w.weekEnd}`
    const cached = cache[cacheKey]
    setModalType(type)

    if (cached) {
      setModalData(cached)
      setModalOpen(true)
      return
    }

    setLoadingModal(true)
    startTransition(() => {
      getSupplierWeeklyDetail({ supplierId, dateFrom: w.weekStart, dateTo: w.weekEnd })
        .then((detail) => {
          setCache((prev) => ({ ...prev, [cacheKey]: detail }))
          setModalData(detail)
          setModalOpen(true)
        })
        .catch((err) => {
          alert(err instanceof Error ? err.message : 'Error al cargar detalle semanal')
        })
        .finally(() => {
          setLoadingModal(false)
        })
    })
  }

  const pointsWithX = useMemo(() => {
    if (n === 0) return []
    const minTime = getEpoch(fullSeries[0].weekStart)
    const maxTime = getEpoch(fullSeries[n - 1].weekStart)
    const timeSpan = maxTime - minTime || 1

    return fullSeries.map((w, i) => {
      const time = getEpoch(w.weekStart)
      const ratio = n === 1 ? 0.5 : (time - minTime) / timeSpan
      const x = 2 + ratio * 96

      let showLabel = false
      if (!w.isProjection) {
        if (n <= 6 && (w.sales > 0 || (isProfit ? false : w.purchases > 0))) showLabel = true
        else if (n > 6) {
          if (w.sales === historicalMaxSales && w.sales > 0) showLabel = true
          if (!isProfit && w.purchases === historicalMaxPurchases && w.purchases > 0) showLabel = true
        }
      }

      return { ...w, x, time, index: i, showLabel }
    })
  }, [fullSeries, n, historicalMaxPurchases, historicalMaxSales, isProfit])
  
  const { histPurchaseLine, projPurchaseLine, histSalesLine, projSalesLine, histCostLine, projCostLine, histMarginLine } = useMemo(() => {
    if (!pointsWithX.length) return { histPurchaseLine: '', projPurchaseLine: '', histSalesLine: '', projSalesLine: '', histCostLine: '', projCostLine: '', histMarginLine: '' }
    
    const hist = pointsWithX.filter(p => !p.isProjection)
    const proj = pointsWithX.filter(p => p.isProjection)
    
    if (hist.length && proj.length) {
      proj.unshift(hist[hist.length - 1])
    }
    
    const pLine = (pts: typeof pointsWithX) => pts.map((p) => `${p.x.toFixed(2)},${(baselineY_pct - (p.purchases / maxValue) * usableHeight_pct).toFixed(2)}`).join(' ')
    const sLine = (pts: typeof pointsWithX) => pts.map((p) => `${p.x.toFixed(2)},${(baselineY_pct - (p.sales / maxValue) * usableHeight_pct).toFixed(2)}`).join(' ')
    const cLine = (pts: typeof pointsWithX) => pts.map((p) => `${p.x.toFixed(2)},${(baselineY_pct - ((p.sales - (p.margin ?? 0)) / maxValue) * usableHeight_pct).toFixed(2)}`).join(' ')
    const mLines = (pts: typeof pointsWithX) => pts.map((p) => `${p.x.toFixed(2)},${(baselineY_pct - (Math.max(0, p.margin ?? 0) / maxValue) * usableHeight_pct).toFixed(2)}`).join(' ')
    
    return {
      histPurchaseLine: pLine(hist), projPurchaseLine: pLine(proj),
      histSalesLine: sLine(hist), projSalesLine: sLine(proj),
      histCostLine: cLine(hist), projCostLine: cLine(proj),
      histMarginLine: mLines(hist)
    }
  }, [pointsWithX, maxValue])

  const monthBoundaries = useMemo(() => getMonthBoundaries(fullSeries), [fullSeries])

  const forecastStartPct = pointsWithX.length > forecastStartIndex ? pointsWithX[forecastStartIndex].x : 100

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface/80 shadow-sm relative">
      <div className="p-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between border-b border-theme-border/50">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button onClick={() => setTab('profitability')} className={`px-3 py-1 text-xs font-bold rounded-md transition-colors ${isProfit ? 'bg-theme-accent/15 text-theme-accent' : 'text-theme-text-muted hover:text-theme-text bg-theme-surface/50'}`}>Rentabilidad semanal</button>
            <button onClick={() => setTab('supply')} className={`px-3 py-1 text-xs font-bold rounded-md transition-colors ${!isProfit ? 'bg-theme-accent/15 text-theme-accent' : 'text-theme-text-muted hover:text-theme-text bg-theme-surface/50'}`}>Abastecimiento</button>
          </div>
          <p className="text-xs text-theme-text-muted/80">
            {isProfit
              ? hasCostData
                ? 'Ventas vs costo vendido estimado. Margen = venta neta − costo. No incluye gastos operacionales.'
                : 'Ventas semanales. Margen no calculable: faltan costos para los SKUs vendidos.'
              : hasReceptionData
                ? 'Compras recepcionadas vs ventas. Haz clic en una semana histórica para ver documentos.'
                : 'Ventas semanales disponibles. Compras en 0 porque recepciones Bsale aún no están sincronizadas.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-xs font-medium text-theme-text-muted flex-wrap justify-end">
          {isProfit ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                Ventas netas
              </span>
              {hasCostData && (
                <>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-500 dark:bg-amber-400" />
                    Costo vendido est.
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-blue-500 dark:bg-blue-400" />
                    Margen bruto
                  </span>
                </>
              )}
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-blue-500 dark:bg-blue-400" />
                Compras recepcionadas netas
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                Ventas
              </span>
            </>
          )}
        </div>
      </div>

      <div className="px-5 py-4 flex flex-col md:flex-row gap-4 justify-between bg-theme-surface/40 border-b border-theme-border/50">
        <div className="flex gap-4">
          <div className="rounded-lg border border-theme-border/50 bg-theme-surface p-3 min-w-[140px]">
            <div className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Semana pico venta</div>
            <div className="mt-1 text-xs text-theme-text-muted">{peakSalesWeek ? `${shortDate(peakSalesWeek.weekStart)} – ${shortDate(peakSalesWeek.weekEnd)}` : '—'}</div>
            <div className="mt-1 text-lg font-bold text-theme-text">{peakSalesWeek ? formatCompactMoney(peakSalesWeek.sales) : '$0'}</div>
          </div>
          {isProfit ? (
            <div className="rounded-lg border border-theme-border/50 bg-theme-surface p-3 min-w-[140px]">
              <div className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Semana pico margen</div>
              <div className="mt-1 text-xs text-theme-text-muted">{peakMarginWeek ? `${shortDate(peakMarginWeek.weekStart)} – ${shortDate(peakMarginWeek.weekEnd)}` : '—'}</div>
              <div className="mt-1 text-lg font-bold text-theme-text">{peakMarginWeek ? formatCompactMoney((peakMarginWeek.margin ?? peakMarginWeek.sales - peakMarginWeek.purchases)) : '$0'}</div>
            </div>
          ) : (
            <div className="rounded-lg border border-theme-border/50 bg-theme-surface p-3 min-w-[140px]">
              <div className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider">Semana pico compra</div>
              <div className="mt-1 text-xs text-theme-text-muted">{peakPurchasesWeek ? `${shortDate(peakPurchasesWeek.weekStart)} – ${shortDate(peakPurchasesWeek.weekEnd)}` : '—'}</div>
              <div className="mt-1 text-lg font-bold text-theme-text">{peakPurchasesWeek ? formatCompactMoney(peakPurchasesWeek.purchases) : '$0'}</div>
            </div>
          )}
          {!isProfit && (
            <div className="rounded-lg border border-theme-border/50 bg-theme-surface p-3 min-w-[140px]">
              <div className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Brecha compra-venta</div>
              <div className="mt-1 text-xs text-theme-text-muted">Flujo del período</div>
              <div className="mt-1 text-lg font-bold text-theme-text">{weekly.length > 0 ? formatCompactMoney(weekly.reduce((s, w) => s + w.purchases - w.sales, 0)) : '$0'}</div>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-theme-border bg-theme-surface shadow-sm p-3 min-w-[180px]">
          <div className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider">Proyección 3 meses</div>
          <div className="mt-1 text-xs text-theme-text-muted">
            {isProfit ? (
              hasCostData
                ? <><span className="font-semibold text-theme-text">Ventas:</span> {formatCompactMoney(avgSales * 13)}<span className="mx-1.5">&middot;</span><span className="font-semibold text-theme-text">Margen:</span> {formatCompactMoney(avgMargin * 13)}</>
                : <><span className="font-semibold text-theme-text">Ventas:</span> {formatCompactMoney(avgSales * 13)}<span className="mx-1.5">&middot;</span><span className="text-theme-text-muted/60">Margen: Sin costo</span></>
            ) : (
              <><span className="font-semibold text-theme-text">Ventas:</span> {formatCompactMoney(avgSales * 13)}<span className="mx-1.5">&middot;</span><span className="font-semibold text-theme-text">Compras:</span> {formatCompactMoney(avgPurchases * 13)}</>
            )}
          </div>
          <div className="text-[10px] mt-0.5">
            <span className="text-theme-text-muted">Confianza: </span>
            <span className={confidence === 'alta' ? 'text-emerald-500 font-semibold' : confidence === 'media' ? 'text-amber-500 font-semibold' : 'text-rose-500 font-semibold'}>
              {confidence.toUpperCase()}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 w-full relative px-5" onMouseLeave={() => setHoveredPoint(null)}>
        {weekly.length === 0 ? (
          <div className="rounded-lg border border-theme-border bg-theme-bg/40 px-4 py-8 text-center text-sm text-theme-text-muted/70">
            No hay datos semanales en el período seleccionado.
          </div>
        ) : (
          <>
            <div className="relative group/chart w-full h-72">
              
              <div className="absolute left-0 top-0 bottom-0 w-12 flex flex-col justify-between text-[10px] text-theme-text-muted/60 pointer-events-none pb-[10%]">
                {[1, 0.75, 0.5, 0.25, 0].map(r => (
                  <div key={r} className="absolute w-full text-right pr-2 font-medium" style={{ top: `${(1 - r) * usableHeight_pct}%`, transform: 'translateY(-50%)' }}>
                    {formatCompactMoney(maxValue * r)}
                  </div>
                ))}
              </div>

              <div className="absolute left-14 right-4 top-0 bottom-0">
                <svg className="absolute inset-0 w-full h-full overflow-visible">
                  {[0, 0.25, 0.5, 0.75, 1].map((r) => {
                    const y = baselineY_pct - r * usableHeight_pct
                    return (
                      <line
                        key={r}
                        x1="0%" y1={`${y}%`} x2="100%" y2={`${y}%`}
                        stroke="currentColor" className="text-theme-border/30" strokeWidth="1px" strokeDasharray={r > 0 ? "4 4" : "none"}
                      />
                    )
                  })}

                  {forecastStartPct < 100 && (
                    <rect 
                      x={`${forecastStartPct}%`} y="0%" width={`${100 - forecastStartPct}%`} height="100%" 
                      className="fill-purple-500/5 dark:fill-purple-400/5 pointer-events-none"
                    />
                  )}
                  {forecastStartPct < 100 && (
                    <text x={`${forecastStartPct + 1}%`} y="5%" className="fill-purple-500/50 dark:fill-purple-400/50 text-[10px] font-bold uppercase pointer-events-none">
                      Proyección
                    </text>
                  )}

                  <svg viewBox="0 0 100 100" preserveAspectRatio="none" x="0" y="0" width="100%" height="100%" className="overflow-visible pointer-events-none">
                    {isProfit ? (
                      <>
                        {hasCostData && pointsWithX.map(p => {
                          const m = p.margin ?? 0
                          if (m <= 0) return null
                          const salesY_pct = baselineY_pct - (p.sales / maxValue) * usableHeight_pct
                          const costY_pct = baselineY_pct - ((p.sales - m) / maxValue) * usableHeight_pct
                          return <rect key={p.time} x={`${p.x - 0.8}%`} y={`${costY_pct}%`} width="1.6%" height={`${salesY_pct - costY_pct}%`} className="fill-blue-500/40 dark:fill-blue-400/40 pointer-events-none" />
                        })}
                        {hasCostData && <polyline points={histCostLine} fill="none" className="stroke-amber-500 dark:stroke-amber-400" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
                        {hasCostData && <polyline points={projCostLine} fill="none" className="stroke-amber-500/60 dark:stroke-amber-400/60" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />}
                        <polyline points={histSalesLine} fill="none" className="stroke-emerald-500 dark:stroke-emerald-400" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                        <polyline points={projSalesLine} fill="none" className="stroke-emerald-500/60 dark:stroke-emerald-400/60" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
                      </>
                    ) : (
                      <>
                        <polyline points={histPurchaseLine} fill="none" className="stroke-blue-500 dark:stroke-blue-400" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                        <polyline points={projPurchaseLine} fill="none" className="stroke-blue-500/60 dark:stroke-blue-400/60" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
                        <polyline points={histSalesLine} fill="none" className="stroke-emerald-500 dark:stroke-emerald-400" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                        <polyline points={projSalesLine} fill="none" className="stroke-emerald-500/60 dark:stroke-emerald-400/60" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
                      </>
                    )}
                  </svg>

                  {pointsWithX.map((item, i) => {
                    const purchaseY = baselineY_pct - (item.purchases / maxValue) * usableHeight_pct
                    const salesY = baselineY_pct - (item.sales / maxValue) * usableHeight_pct
                    const marginY = baselineY_pct - (Math.max(0, item.margin ?? 0) / maxValue) * usableHeight_pct
                    const costY = baselineY_pct - ((item.sales - (item.margin ?? 0)) / maxValue) * usableHeight_pct
                    const isHovered = hoveredPoint?.weekStart === item.weekStart

                    const prevX = i > 0 ? pointsWithX[i-1].x : 0
                    const nextX = i < n - 1 ? pointsWithX[i+1].x : 100
                    const leftBound = i === 0 ? 0 : (item.x + prevX) / 2
                    const rightBound = i === n - 1 ? 100 : (item.x + nextX) / 2
                    const width = rightBound - leftBound

                    return (
                      <g key={item.weekStart} className={`transition-opacity ${isHovered ? 'opacity-100' : 'opacity-70 hover:opacity-100 group-hover/chart:opacity-50'}`}>
                        <rect
                          x={`${leftBound}%`} y="0%" width={`${width}%`} height="100%"
                          className={`cursor-pointer transition-colors ${isHovered ? 'fill-theme-border/20' : 'fill-transparent'}`}
                          onDoubleClick={() => handleOpenModal(item, isProfit ? 'SALE' : 'PURCHASE')}
                          onMouseEnter={() => setHoveredPoint(item)}
                        />

                        {isHovered && (
                          <line x1={`${item.x}%`} y1="0%" x2={`${item.x}%`} y2={`${baselineY_pct}%`} stroke="currentColor" className="text-theme-text-muted/40 pointer-events-none" strokeWidth="1px" strokeDasharray="4 4" />
                        )}

                        {item.isProjection ? (
                          isProfit ? (
                            <>
                              <polygon points={`${item.x},${marginY - 2.5} ${item.x - 2},${marginY + 2.5} ${item.x + 2},${marginY + 2.5}`} className="fill-theme-surface stroke-blue-500/80 stroke-[2] pointer-events-none" />
                              <polygon points={`${item.x},${salesY - 2.5} ${item.x - 2.5},${salesY - 0.7} ${item.x - 1.5},${salesY + 2} ${item.x + 1.5},${salesY + 2} ${item.x + 2.5},${salesY - 0.7}`} className="fill-theme-surface stroke-emerald-500/80 stroke-[2] pointer-events-none" />
                            </>
                          ) : (
                            <>
                              <polygon points={`${item.x},${purchaseY - 2.5} ${item.x - 2},${purchaseY + 2.5} ${item.x + 2},${purchaseY + 2.5}`} className="fill-theme-surface stroke-blue-500/80 stroke-[2] pointer-events-none" />
                              <polygon points={`${item.x},${salesY - 2.5} ${item.x - 2.5},${salesY - 0.7} ${item.x - 1.5},${salesY + 2} ${item.x + 1.5},${salesY + 2} ${item.x + 2.5},${salesY - 0.7}`} className="fill-theme-surface stroke-emerald-500/80 stroke-[2] pointer-events-none" />
                            </>
                          )
                        ) : isProfit ? (
                          <>
                            <circle cx={`${item.x}%`} cy={`${salesY}%`} r={isHovered ? "6" : "4.5"} className="fill-emerald-500 dark:fill-emerald-400 transition-all cursor-pointer pointer-events-none" stroke="var(--theme-surface)" strokeWidth="2" />
                            {hasCostData && <circle cx={`${item.x}%`} cy={`${costY}%`} r={isHovered ? "5" : "3.5"} className="fill-amber-500 dark:fill-amber-400 transition-all pointer-events-none" stroke="var(--theme-surface)" strokeWidth="2" />}
                            {hasCostData && <rect x={`${item.x - 0.6}%`} y={`${marginY}%`} width="1.2%" height={`${salesY - marginY}%`} className="fill-blue-500/40 dark:fill-blue-400/40 pointer-events-none" />}
                          </>
                        ) : (
                          <>
                            <circle cx={`${item.x}%`} cy={`${purchaseY}%`} r={isHovered ? "6" : "4.5"} className="fill-blue-500 dark:fill-blue-400 transition-all cursor-pointer pointer-events-none" stroke="var(--theme-surface)" strokeWidth="2" />
                            <circle cx={`${item.x}%`} cy={`${salesY}%`} r={isHovered ? "6" : "4.5"} className="fill-emerald-500 dark:fill-emerald-400 transition-all cursor-pointer pointer-events-none" stroke="var(--theme-surface)" strokeWidth="2" />
                          </>
                        )}
                        
                        {item.showLabel && !item.isProjection && (
                          isProfit ? (
                            <text x={`${item.x}%`} y={`${salesY - 4}%`} textAnchor="middle" className="fill-emerald-600 dark:fill-emerald-400 text-[10px] font-bold pointer-events-none">{formatCompactMoney(item.sales)}</text>
                          ) : (
                            <>
                              <text x={`${item.x}%`} y={`${purchaseY - 4}%`} textAnchor="middle" className="fill-blue-600 dark:fill-blue-400 text-[10px] font-bold pointer-events-none">{formatCompactMoney(item.purchases)}</text>
                              <text x={`${item.x}%`} y={`${salesY - 4}%`} textAnchor="middle" className="fill-emerald-600 dark:fill-emerald-400 text-[10px] font-bold pointer-events-none">{formatCompactMoney(item.sales)}</text>
                            </>
                          )
                        )}
                      </g>
                    )
                  })}
                </svg>
                
                {hoveredPoint && (
                  <div 
                    className="absolute pointer-events-none z-10 -translate-x-1/2 -translate-y-full pb-4 transition-all duration-75"
                    style={{ 
                      left: `${hoveredPoint.x}%`, 
                      top: `${baselineY_pct - (Math.max(hoveredPoint.purchases, hoveredPoint.sales, hoveredPoint.margin || 0) / maxValue) * usableHeight_pct}%` 
                    }}
                  >
                    <div className="bg-theme-surface/90 backdrop-blur border border-theme-border shadow-xl rounded-xl p-3 min-w-[160px]">
                      <div className="text-xs font-bold text-theme-text border-b border-theme-border/50 pb-2 mb-2 text-center">
                        {hoveredPoint.label}
                        {hoveredPoint.isProjection && <div className="text-[10px] text-purple-600 dark:text-purple-400 mt-1 uppercase tracking-wider font-bold bg-purple-500/10 py-1 px-2 rounded">Proyección estimada</div>}
                      </div>
                      <div className="space-y-1.5 text-xs">
                        {isProfit ? (
                          <>
                            <div className="flex justify-between items-center gap-4">
                              <span className="flex items-center gap-1.5 text-theme-text-muted">
                                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                                Ventas netas
                              </span>
                              <span className="font-bold text-theme-text">{formatCompactMoney(hoveredPoint.sales)}</span>
                            </div>
                            {hasCostData && (
                              <>
                                <div className="flex justify-between items-center gap-4">
                                  <span className="flex items-center gap-1.5 text-theme-text-muted">
                                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                                    Costo vendido est.
                                  </span>
                                  <span className="font-bold text-theme-text">{formatCompactMoney(Math.max(0, hoveredPoint.sales - (hoveredPoint.margin ?? 0)))}</span>
                                </div>
                                <div className="flex justify-between items-center gap-4 pt-1.5 mt-1.5 border-t border-theme-border/30">
                                  <span className="flex items-center gap-1.5 text-theme-text-muted">
                                    <span className="h-2 w-2 rounded-full bg-blue-500" />
                                    Margen bruto
                                  </span>
                                  <span className="font-bold text-theme-text">{formatCompactMoney(hoveredPoint.margin ?? 0)}</span>
                                </div>
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="flex justify-between items-center gap-4">
                              <span className="flex items-center gap-1.5 text-theme-text-muted">
                                <span className="h-2 w-2 rounded-full bg-blue-500" />
                                Compras netas
                              </span>
                              <span className="font-bold text-theme-text">{formatCompactMoney(hoveredPoint.purchases)}</span>
                            </div>
                            <div className="flex justify-between items-center gap-4">
                              <span className="flex items-center gap-1.5 text-theme-text-muted">
                                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                                Ventas netas
                              </span>
                              <span className="font-bold text-theme-text">{formatCompactMoney(hoveredPoint.sales)}</span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

              </div>
            </div>

            <div className="mt-3 w-full pl-14 pr-4">
              <div className="flex text-[10px] font-bold text-theme-text-muted uppercase tracking-wider">
                {monthBoundaries.map((mb) => (
                  <div key={mb.label} className="text-center first:text-left last:text-right" style={{ flex: mb.weeks.length }}>
                    {mb.label}
                  </div>
                ))}
              </div>
            </div>

            {loadingModal && (
              <div className="mt-6 mx-5 rounded-lg border border-theme-border bg-theme-bg/60 p-5 shadow-sm animate-in fade-in">
                <div className="flex items-center justify-center gap-2 text-sm text-theme-text-muted">
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-theme-border border-t-blue-500" />
                  Cargando detalle semanal...
                </div>
              </div>
            )}

            <div className="mt-8 mx-5 mb-5 overflow-hidden rounded-lg border border-theme-border bg-theme-bg/50">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs whitespace-nowrap">
                  <thead>
                    <tr className="border-b border-theme-border/70 bg-theme-surface/50">
                      <th className="py-3 pl-4 pr-3 font-semibold text-theme-text">Semana</th>
                      {isProfit ? (
                        hasCostData
                          ? <><th className="px-3 py-3 text-right font-semibold text-theme-text">Ventas netas</th><th className="px-3 py-3 text-right font-semibold text-theme-text">Costo est.</th><th className="px-3 py-3 text-right font-semibold text-theme-text">Margen</th><th className="py-3 pl-3 pr-4 text-right font-semibold text-theme-text">Margen %</th></>
                          : <><th className="px-3 py-3 text-right font-semibold text-theme-text">Ventas netas</th><th colSpan={3} className="py-3 pl-3 pr-4 text-right font-semibold text-theme-text-muted/60">Margen: Sin costo</th></>
                      ) : (
                        <><th className="px-3 py-3 text-right font-semibold text-theme-text">Compras netas</th><th className="px-3 py-3 text-right font-semibold text-theme-text">Ventas netas</th><th className="py-3 pl-3 pr-4 text-right font-semibold text-theme-text">Brecha</th></>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border/30">
                    {weekly.map((w) => {
                      const margin = w.margin ?? w.sales - w.purchases
                      const cost = w.sales - margin
                      const marginPct = w.sales > 0 ? Math.round((margin / w.sales) * 100) : null
                      return (
                        <tr key={w.weekStart} onDoubleClick={() => handleOpenModal(w, isProfit ? 'SALE' : 'PURCHASE')} className="cursor-pointer hover:bg-theme-surface/80 border-l-2 border-l-transparent hover:border-l-blue-500 transition-colors">
                          <td className="py-2.5 pl-4 pr-3 font-medium text-theme-text-muted/90">{w.label}</td>
                          {isProfit ? (
                            hasCostData ? (
                              <>
                                <td className="px-3 py-2.5 text-right font-medium tabular-nums text-theme-text">{money(w.sales)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-theme-text-muted/90">{money(cost)}</td>
                                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${margin > 0 ? 'text-emerald-600' : margin < 0 ? 'text-rose-600' : ''}`}>{margin > 0 ? '+' : ''}{money(margin)}</td>
                                <td className={`py-2.5 pl-3 pr-4 text-right tabular-nums ${marginPct !== null ? 'font-semibold' : ''} ${marginPct !== null && marginPct > 0 ? 'text-emerald-600' : marginPct !== null && marginPct < 0 ? 'text-rose-600' : 'text-theme-text-muted/60'}`}>{marginPct !== null ? `${marginPct}%` : '—'}</td>
                              </>
                            ) : (
                              <td className="px-3 py-2.5 text-right font-medium tabular-nums text-theme-text" colSpan={4}>{money(w.sales)}</td>
                            )
                          ) : (
                            <>
                              <td className="px-3 py-2.5 text-right tabular-nums text-theme-text-muted/90">{money(w.purchases)}</td>
                              <td className="px-3 py-2.5 text-right font-medium tabular-nums text-theme-text">{money(w.sales)}</td>
                              <td className={`py-2.5 pl-3 pr-4 text-right tabular-nums font-semibold ${w.purchases > w.sales ? 'text-emerald-600' : w.purchases < w.sales ? 'text-rose-600' : 'text-theme-text-muted/60'}`}>{formatCompactMoney(w.purchases - w.sales)}</td>
                            </>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      <SupplierDocumentModal
        weeklyDetail={modalData}
        modalType={modalType}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        supplierId={supplierId}
      />

      {!hasReceptionData && (
        <div className="mt-5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-400 mx-5 mb-5">
          Recepciones Bsale aún no sincronizadas. Para completar el análisis cruzado de compras se requiere el espejo de recepciones.
        </div>
      )}
    </section>
  )
}
