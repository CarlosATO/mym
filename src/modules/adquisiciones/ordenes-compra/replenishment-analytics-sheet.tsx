'use client'

import { useMemo, useState } from 'react'
import { Check, Info, X } from 'lucide-react'
import type { BreakSummary60d, ReplenishmentAvailabilityDaily, ReplenishmentDataset, ReplenishmentKardexEvent } from '@/app/actions/integraciones/bsale-dataset'
import { buildReplenishmentTimeline, type SkuRow, type ReplenishmentTimelineData } from './replenishment-derive'
import type { SkuForecastResult } from './replenishment-forecast'
import { fmt, fmtN } from './replenishment-format'
import { getProductName, getPseudoSupplierName, getRealSupplierName } from './replenishment-names'

interface Props {
  row: SkuRow
  dataset: ReplenishmentDataset
  breakSummary: BreakSummary60d
  dailyAvailability: ReplenishmentAvailabilityDaily[] | null
  dailyAvailabilityLoading: boolean
  kardex: ReplenishmentKardexEvent[] | null
  kardexLoading: boolean
  forecast: SkuForecastResult | null
  forecastError: string | null
  confirmed: boolean
  onClose: () => void
  onUpdateQty: (sku: string, qty: number) => void
  onConfirm: (sku: string) => void
}

const NO_DATA = 'Sin datos'

function numberOrNoData(value: number | null) {
  return value === null ? NO_DATA : fmtN(value)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)).replace('.', '')
}

function formatForecastValue(value: number | null) {
  return value === null ? NO_DATA : value.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function forecastModelLabel(model: SkuForecastResult['selectedModel']) {
  if (model === 'SUAVIZAMIENTO_EXPONENCIAL_SIMPLE') return 'Suavizamiento exponencial simple'
  if (model === 'CROSTON') return 'Croston'
  if (model === 'SBA') return 'SBA'
  if (model === 'TSB') return 'TSB'
  if (model === 'BASELINE_ULTIMA_SEMANA_VALIDA') return 'Baseline última semana válida'
  return NO_DATA
}

type ForecastModel = NonNullable<SkuForecastResult['selectedModel']>

const FORECAST_MODEL_DESCRIPTIONS: Partial<Record<ForecastModel, string>> = {
  SBA: 'Modelo pensado para productos con ventas irregulares.',
  TSB: 'Modelo pensado para productos que venden de forma intermitente y pueden cambiar su frecuencia de venta.',
  SUAVIZAMIENTO_EXPONENCIAL_SIMPLE: 'Modelo que da mayor importancia al comportamiento reciente de las ventas.',
  CROSTON: 'Modelo diseñado para productos que pasan períodos sin ventas.',
  BASELINE_ULTIMA_SEMANA_VALIDA: 'Método simple que usa como referencia la última semana válida.',
}

function forecastModelDescription(model: SkuForecastResult['selectedModel']) {
  return (model ? FORECAST_MODEL_DESCRIPTIONS[model] : undefined) ?? 'Método estadístico basado en el historial de ventas.'
}

function ForecastHint({ text }: { text: string }) {
  return <span title={text} aria-label={text}><Info className="ml-1 inline-block h-3 w-3 align-[-2px] text-theme-text-muted" /></span>
}

function formatApproxUnits(value: number | null) {
  return value === null ? NO_DATA : `≈ ${fmtN(Math.round(value))} uds.`
}

function baselineComparisonLabel(value: SkuForecastResult['comparisonToBaseline']) {
  if (value === 'MEJORA') return 'Mejora frente al método simple'
  if (value === 'NO MEJORA SOBRE BASELINE') return 'No mejora frente al método simple'
  return 'Método simple no disponible para comparar'
}

function baselineComparisonHelp(value: SkuForecastResult['comparisonToBaseline']) {
  if (value === 'MEJORA') return 'Este modelo obtuvo mejores resultados que utilizar una estimación básica como referencia.'
  if (value === 'NO MEJORA SOBRE BASELINE') return 'Este modelo no obtuvo mejores resultados que utilizar una estimación básica como referencia.'
  return 'No fue posible comparar este modelo con una estimación básica.'
}

function ForecastSection({ forecast, error }: { forecast: SkuForecastResult | null; error: string | null }) {
  const [showDetails, setShowDetails] = useState(false)
  const frameClass = 'rounded-lg border p-2.5'

  if (error) return <section className={`${frameClass} h-[116px] overflow-hidden lg:h-[104px] border-amber-400/40 bg-amber-50/50`}><div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Pronóstico de demanda</h3><span className="text-[10px] text-amber-700 dark:text-amber-300">No disponible</span></div><p className="mt-2 text-sm font-semibold text-amber-700 dark:text-amber-300">{error}</p></section>
  if (!forecast) return <section className={`${frameClass} h-[116px] overflow-hidden lg:h-[104px] border-theme-border/70 bg-theme-bg/20`}><div className="flex items-center justify-between"><div><h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Pronóstico de demanda</h3><p className="mt-0.5 text-[10px] text-theme-text-muted">Estimación de las ventas futuras basada en el comportamiento histórico del producto.</p></div><span className="text-[10px] text-theme-text-muted">Cargando…</span></div><div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-5">{['Modelo', 'Próxima semana', 'Próximas 4 semanas', 'Confiabilidad', 'Error histórico'].map(label => <div key={label} className="h-8 animate-pulse rounded bg-theme-border/30" aria-label={`Cargando ${label}`} />)}</div></section>
  const selectedMetrics = forecast.modelResults.find(model => model.model === forecast.selectedModel)
    || (forecast.baseline.model === forecast.selectedModel ? forecast.baseline : undefined)
  const lowConfidence = forecast.status !== 'OK' || (forecast.wape !== null && forecast.wape >= 1)
  const wape = forecast.wape === null ? NO_DATA : `${(forecast.wape * 100).toLocaleString('es-CL', { maximumFractionDigits: 2 })}%`
  return <section className={`${frameClass} ${showDetails ? 'min-h-[104px]' : 'h-[116px] overflow-hidden lg:h-[104px]'} border-theme-border/70 bg-theme-bg/20`}>
    <div className="flex items-center justify-between gap-3"><div className="min-w-0"><h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Pronóstico de demanda</h3><p className="mt-0.5 truncate text-[10px] text-theme-text-muted">Estimación de las ventas futuras basada en el comportamiento histórico del producto.</p></div><button type="button" onClick={() => setShowDetails(value => !value)} className="shrink-0 rounded border border-theme-border px-2 py-1 text-[10px] font-medium text-theme-text-muted transition hover:bg-theme-surface hover:text-theme-text">{showDetails ? 'Ocultar detalle' : 'Ver detalle'}</button></div>
    {forecast.status === 'HISTORIAL INSUFICIENTE' ? <div className="mt-2"><p className="text-sm font-semibold text-amber-700 dark:text-amber-300">Historial insuficiente</p><p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-theme-text-muted">No existen suficientes semanas con información confiable para generar un pronóstico responsable para este producto.</p></div> : <>
      <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded border border-theme-border/60 bg-theme-border/50 lg:grid-cols-[minmax(140px,1.25fr)_minmax(90px,.8fr)_minmax(220px,2fr)_minmax(125px,1.1fr)_minmax(70px,.7fr)]">
        <div className="min-w-0 bg-theme-surface px-2 py-1.5"><p className="text-[10px] font-medium uppercase tracking-wide text-theme-text-muted">Modelo<ForecastHint text={forecastModelDescription(forecast.selectedModel)} /></p><p className="mt-0.5 truncate text-xs font-semibold text-theme-text" title={forecastModelDescription(forecast.selectedModel)}>{forecastModelLabel(forecast.selectedModel)}</p></div>
        <div className="border-l border-theme-border/45 bg-theme-surface px-2 py-1.5"><p className="text-[10px] font-medium uppercase tracking-wide text-theme-text-muted">Próxima semana<ForecastHint text="Venta estimada para la próxima semana." /></p><p className="mt-0.5 text-xs font-semibold tabular-nums text-theme-text">{formatApproxUnits(forecast.forecastNextWeek)}</p></div>
        <div className="min-w-0 border-l border-theme-border/45 bg-theme-surface px-2 py-1.5"><p className="text-[10px] font-medium uppercase tracking-wide text-theme-text-muted">Próximas 4 semanas<ForecastHint text="Cantidad que el modelo estima vender en cada una de las próximas cuatro semanas." /></p><div className="mt-0.5 flex gap-1 overflow-hidden">{forecast.forecastNext4Weeks.map((value, index) => <span key={index} title={value === null ? NO_DATA : `Valor exacto: ${formatForecastValue(value)} uds.`} className="shrink-0 rounded border border-theme-border bg-theme-bg/40 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-theme-text">Sem. {index + 1} · {formatApproxUnits(value)}</span>)}</div></div>
        <div className="min-w-0 border-l border-theme-border/45 bg-theme-surface px-2 py-1.5"><p className="text-[10px] font-medium uppercase tracking-wide text-theme-text-muted">Confiabilidad<ForecastHint text="Indica qué tan estable ha sido este pronóstico al probarlo con ventas anteriores." /></p><p className={`mt-0.5 truncate text-xs font-semibold ${lowConfidence ? 'text-amber-700 dark:text-amber-300' : 'text-theme-text'}`} title={lowConfidence ? 'Pronóstico de baja confiabilidad' : 'Confiabilidad aceptable'}>{lowConfidence ? 'Baja' : 'Aceptable'}</p></div>
        <div className="border-l border-theme-border/45 bg-theme-surface px-2 py-1.5"><p className="text-[10px] font-medium uppercase tracking-wide text-theme-text-muted">Error histórico<ForecastHint text="Diferencia porcentual observada entre las estimaciones y las ventas reales anteriores. Mientras menor sea, mejor." /></p><p className="mt-0.5 text-xs font-semibold tabular-nums text-theme-text">{wape}</p></div>
      </div>
      {showDetails && <div className="mt-2 space-y-1.5 border-t border-theme-border/50 pt-1.5 text-[10px] text-theme-text-muted"><p><strong className="text-theme-text">{forecastModelLabel(forecast.selectedModel)}:</strong> {forecastModelDescription(forecast.selectedModel)}</p><div className="flex flex-wrap gap-x-4 gap-y-1"><span>Semanas utilizadas: <strong className="text-theme-text">{fmtN(forecast.weeksUsed)}</strong></span><span title={baselineComparisonHelp(forecast.comparisonToBaseline)}>{baselineComparisonLabel(forecast.comparisonToBaseline)} <strong className="text-theme-text">({forecast.comparisonToBaseline})</strong></span><span title="En las pruebas históricas, el pronóstico se desvió en promedio esta cantidad de unidades.">Error promedio: {formatApproxUnits(forecast.mae)} <strong className="text-theme-text">(MAE: {formatForecastValue(forecast.mae)})</strong></span><span title="Menor que 1 significa que este modelo rindió mejor que una predicción simple.">Comparación con pronóstico simple: {formatForecastValue(selectedMetrics?.mase ?? null)} <strong className="text-theme-text">(MASE)</strong></span><span>WAPE: <strong className="text-theme-text">{wape}</strong></span></div></div>}
    </>}
    {forecast.status === 'NO MEJORA SOBRE BASELINE' && <p className="mt-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">No mejora frente al método simple.</p>}
  </section>
}

function TimelineChart({ timeline }: { timeline: ReplenishmentTimelineData }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const width = 900
   const height = 172
   const pad = { top: 14, right: 18, bottom: 26, left: 38 }
  const maxSales = Math.max(1, ...timeline.days.map(day => day.sales))
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const points = timeline.days.map((day, index) => ({
    ...day,
    x: pad.left + (index / Math.max(1, timeline.days.length - 1)) * innerWidth,
    y: pad.top + innerHeight - (day.sales / maxSales) * innerHeight,
  }))
  const line = points.map(point => `${point.x},${point.y}`).join(' ')
  const step = points.length > 1 ? points[1].x - points[0].x : 0
  const bands = timeline.stockoutRanges.flatMap(range => {
    const startIndex = timeline.days.findIndex(day => day.date === range.from)
    const endIndex = timeline.days.findIndex(day => day.date === range.to)
    if (startIndex < 0 || endIndex < startIndex) return []
    const x = Math.max(pad.left, points[startIndex].x - step / 2)
    const end = Math.min(width - pad.right, points[endIndex].x + step / 2)
    return [{ x, width: Math.max(0, end - x), key: `${range.from}-${range.to}` }]
  })
  const hoveredDay = hovered === null ? null : timeline.days[hovered]

  return (
     <div className="relative overflow-hidden rounded-lg border border-theme-border/70 bg-theme-bg/25 p-2">
       <svg viewBox={`0 0 ${width} ${height}`} className="h-[172px] w-full" role="img" aria-label="Evolución histórica de ventas y quiebres"
        onMouseMove={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
          setHovered(Math.round(ratio * (timeline.days.length - 1)))
        }} onMouseLeave={() => setHovered(null)}>
        {[0, 0.5, 1].map(ratio => {
          const y = pad.top + ratio * innerHeight
           return <line key={ratio} x1={pad.left} y1={y} x2={width - pad.right} y2={y} stroke="currentColor" className="text-theme-border/50" strokeDasharray="3 3" />
        })}
        {bands.map(band => <rect key={band.key} x={band.x} y={pad.top} width={band.width} height={innerHeight} fill="rgb(239 68 68 / 0.14)" />)}
        <polyline points={line} fill="none" stroke="currentColor" className="text-theme-accent" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        {points.filter(point => point.sales > 0).map(point => <circle key={point.date} cx={point.x} cy={point.y} r="2.5" fill="var(--theme-accent)" />)}
        <text x={pad.left} y={height - 8} className="fill-theme-text-muted text-[10px]">{formatDate(timeline.days[0].date)}</text>
        <text x={width - pad.right} y={height - 8} textAnchor="end" className="fill-theme-text-muted text-[10px]">{formatDate(timeline.days[timeline.days.length - 1].date)}</text>
        {hovered !== null && points[hovered] && <line x1={points[hovered].x} y1={pad.top} x2={points[hovered].x} y2={height - pad.bottom} stroke="currentColor" className="text-theme-text-muted/50" strokeDasharray="3 3" />}
      </svg>
       {hoveredDay && <div className="absolute right-3 top-3 rounded border border-theme-border/70 bg-theme-surface px-2 py-1 text-[10px] shadow-sm"><strong>{formatDate(hoveredDay.date)}</strong><span className="ml-2 text-theme-text-muted">{fmtN(hoveredDay.sales)} ventas</span></div>}
        <div className="mt-0.5 flex gap-4 border-t border-theme-border/45 px-2 pt-1 text-[10px] text-theme-text-muted"><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-theme-accent" />Ventas</span><span><i className="mr-1 inline-block h-2 w-2 bg-red-400/50" />Quiebre confirmado</span></div>
    </div>
  )
}

function TimelineMatrix({ timeline }: { timeline: ReplenishmentTimelineData }) {
  const rows: Array<[string, (period: ReplenishmentTimelineData['periods'][number]) => string, string]> = [
    ['Ventas', period => fmtN(period.sales), 'text-theme-text'],
    ['Días con stock', period => numberOrNoData(period.daysWithStock), 'text-theme-text-muted'],
    ['Días sin stock', period => numberOrNoData(period.daysWithoutStock), 'text-amber-700 dark:text-amber-300'],
    ['Evidencia conocida', period => numberOrNoData(period.knownDays), 'text-theme-text-muted'],
    ['Stock de cierre', period => numberOrNoData(period.closingStock), 'text-theme-text-muted'],
    ['Recepciones', period => numberOrNoData(period.receptions), 'text-theme-text-muted'],
  ]
  return <div className="overflow-x-auto rounded-lg border border-theme-border/70"><table className="min-w-[760px] w-full border-separate border-spacing-0 text-[11px]"><thead><tr className="bg-theme-bg/45"><th className="sticky left-0 z-[1] min-w-[150px] border-r border-theme-border/60 bg-theme-bg/60 px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-theme-text">Indicador</th>{timeline.periods.map(period => <th key={period.period} className="min-w-[86px] border-l border-theme-border/45 bg-theme-bg/45 px-2 py-1.5 text-right text-[10px] font-semibold text-theme-text-muted">{period.period}</th>)}</tr></thead><tbody>{rows.map(([label, value, cls]) => <tr key={label}><th className="sticky left-0 z-[1] border-r border-t border-theme-border/60 bg-theme-surface px-3 py-1.5 text-left font-semibold text-theme-text-muted">{label}</th>{timeline.periods.map((period, index) => <td key={`${label}-${period.period}`} className={`border-l border-t border-theme-border/45 px-2 py-1.5 text-right tabular-nums ${index % 2 === 1 ? 'bg-theme-bg/15' : 'bg-theme-surface'} ${cls}`}>{value(period)}</td>)}</tr>)}</tbody></table></div>
}

export function ReplenishmentAnalyticsSheet({ row, dataset, breakSummary, dailyAvailability, dailyAvailabilityLoading, kardex, kardexLoading, forecast, forecastError, confirmed, onClose, onUpdateQty, onConfirm }: Props) {
  const s = row.sku
  const m = row.metrics
  const timeline = useMemo(() => buildReplenishmentTimeline({ dataset, sku: s.SKU, breakSummary, availability: dailyAvailability, kardex }), [dataset, s.SKU, breakSummary, dailyAvailability, kardex])
  const rate = m.salesRateWithStock === null ? 'Revisar' : `${m.salesRateWithStock.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ud/día`
  const coverage = m.coverageDays === null ? 'Revisar' : `~${Math.round(m.coverageDays)} días (~${(m.coverageDays / 7).toLocaleString('es-CL', { maximumFractionDigits: 1 })} sem.)`
  const evidenceKnownDays = dailyAvailability === null ? m.knownDays : dailyAvailability.filter(day => day.state_known).length
  const evidenceCoveragePct = dailyAvailability === null ? m.evidenceCoveragePct : (evidenceKnownDays / 60) * 100
  const indicators: Array<[string, string]> = [
    ['Stock actual', fmtN(m.physicalStock)], ['Ventas 60d', fmtN(m.sales60d)], ['Ritmo con stock', rate],
    ['Base del ritmo', m.salesRateWithStock === null ? 'Revisar' : `${fmtN(m.unitsSoldWithStock)} uds en ${fmtN(m.daysWithStock)} días con stock`],
    ['Cobertura ajustada', coverage], ['Stock objetivo', m.targetStock === null ? 'Revisar' : fmtN(m.targetStock)],
    ['Compra sugerida', m.suggestedQty === null ? 'Revisar' : fmtN(m.suggestedQty)], ['Días sin stock 60d', `${fmtN(m.daysWithoutStock)} días`],
    ['Quiebres', fmtN(m.breakCount)], ['Evidencia histórica', `${evidenceCoveragePct.toLocaleString('es-CL', { maximumFractionDigits: 1 })}% · ${evidenceKnownDays}/60 días`],
  ]

  return <div className="fixed inset-0 z-[1100] flex items-stretch justify-center bg-black/35 p-3 backdrop-blur-sm sm:p-5" onClick={onClose}>
    <aside className="flex h-full w-full max-w-[1480px] flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl" onClick={event => event.stopPropagation()}>
       <header className="flex shrink-0 items-start justify-between gap-4 border-b border-theme-border bg-theme-surface px-5 py-3"><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-theme-text-muted">Ficha analítica por SKU</p><h2 className="mt-1 truncate text-lg font-bold text-theme-text">{getProductName(s)}</h2><div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px]"><span className="rounded-full border border-theme-border bg-theme-bg/40 px-2 py-1 font-mono text-theme-accent">SKU {s.SKU}</span><span className="rounded-full border border-theme-border bg-theme-bg/40 px-2 py-1 text-theme-text-muted">{getRealSupplierName(s)}</span><span className="rounded-full border border-theme-border bg-theme-bg/40 px-2 py-1 text-theme-text-muted">{getPseudoSupplierName(s)}</span><span className="rounded-full border border-theme-border bg-theme-bg/40 px-2 py-1 text-theme-text-muted">{s.alerta || 'Normal'}</span></div></div><button onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-theme-border text-theme-text-muted hover:bg-theme-bg/50 hover:text-theme-text" aria-label="Cerrar ficha"><X className="h-4 w-4" /></button></header>
       <div className="min-h-0 flex-1 overflow-y-auto"><div className="space-y-3 p-4">
          <section><div className="mb-2 flex items-center justify-between"><h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Indicadores principales</h3><span className="text-[10px] text-theme-text-muted">Stock actual: {fmtN(m.physicalStock)} uds</span></div><div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-theme-border/70 bg-theme-border/60 md:grid-cols-5">{indicators.map(([label, value]) => <div key={label} className="bg-theme-surface px-3 py-2"><p className="text-[10px] text-theme-text-muted">{label}</p><p className={`mt-1 text-sm font-bold tabular-nums ${value === 'Revisar' ? 'text-amber-600 dark:text-amber-300' : 'text-theme-text'}`}>{value}</p></div>)}</div></section>
          <ForecastSection forecast={forecast} error={forecastError} />
         <section><div className="mb-2 flex items-end justify-between"><div><h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Matriz temporal</h3><p className="mt-1 text-[10px] text-theme-text-muted">Semanas disponibles del Kardex histórico cargado. 0 y Sin datos no representan lo mismo.</p></div><span className="text-[10px] text-theme-text-muted">{kardexLoading || dailyAvailabilityLoading ? 'Cargando histórico…' : `${timeline.periods.length} períodos`}</span></div><TimelineMatrix timeline={timeline} /></section>
         <div className="grid items-start gap-3 lg:grid-cols-[2fr_1fr_1fr]">
           <section className="min-w-0"><div className="mb-2 flex items-center justify-between"><h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Evolución histórica</h3><span className="text-[10px] text-theme-text-muted">Sin forecast</span></div><TimelineChart timeline={timeline} /></section>
            <section className="min-w-0 rounded-lg border border-theme-border/70 bg-theme-bg/25 p-3"><h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Contexto del período seleccionado</h3><div className="grid grid-cols-2 overflow-hidden rounded border border-theme-border/50 bg-theme-border/40">{[['Ventas período', fmtN(row.totalUnits)], ['Promedio semanal', row.avgPer7.toFixed(2)], ['Variación reciente', row.tendenciaPct === null ? '—' : `${(row.tendenciaPct * 100).toFixed(1)}%`], ['Tendencia', row.estadoTendencia]].map(([label, value], index) => <div key={label} className={`bg-theme-surface px-2 py-1.5 ${index % 2 === 1 ? 'border-l border-theme-border/45' : ''} ${index > 1 ? 'border-t border-theme-border/45' : ''}`}><p className="text-[10px] text-theme-text-muted">{label}</p><p className="mt-0.5 text-xs font-semibold text-theme-text">{value}</p></div>)}</div><p className="mt-2 border-t border-theme-border/50 pt-2 text-[10px] leading-relaxed text-theme-text-muted">Unidades vendidas cada 7 días: {row.buckets.map((value, index) => <span key={index} className="ml-2 tabular-nums">{fmtN(value)}</span>)}</p></section>
            <section className="min-w-0 rounded-lg border border-theme-border/70 bg-theme-bg/25 p-3"><h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Confirmación de compra</h3><div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-theme-border/50 bg-theme-border/40"><label className="bg-theme-surface p-2"><span className="block text-[10px] font-semibold text-theme-text-muted">Cantidad confirmada</span><input type="number" min={0} value={row.confirmedQty} onChange={event => onUpdateQty(s.SKU, Number(event.target.value))} className="mt-2 h-8 w-full rounded border border-theme-border bg-theme-bg/40 px-2 text-right text-sm font-semibold text-theme-text outline-none focus:border-theme-accent" /></label><div className="border-l border-theme-border/45 bg-theme-surface p-2"><span className="block text-[10px] font-semibold text-theme-text-muted">Monto confirmado</span><p className="mt-3 text-right text-sm font-bold tabular-nums text-theme-text">{fmt(row.confirmedCost)}</p></div></div><button onClick={() => onConfirm(s.SKU)} className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-theme-accent px-3 text-xs font-bold text-white shadow-sm transition hover:bg-theme-accent-hover"><Check className="h-4 w-4" />{confirmed ? 'Compra confirmada' : 'Confirmar compra'}</button><p className="mt-2 text-[10px] leading-relaxed text-theme-text-muted/80">La cantidad sugerida proviene de ReplenishmentMetrics. Este botón mantiene el flujo actual hacia la OC.</p></section>
         </div>
      </div></div>
    </aside>
  </div>
}
