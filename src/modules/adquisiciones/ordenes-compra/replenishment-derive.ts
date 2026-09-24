import { buildSkuSummary, classifySkus } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'
import type { NormalizedSale, SkuSummary } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'
import type { BreakSummary60d, ReplenishmentAvailabilityDaily, ReplenishmentDataset, ReplenishmentKardexEvent } from '@/app/actions/integraciones/bsale-dataset'

export interface SkuRow {
  sku: SkuSummary
  variantId: number | null
  metrics: ReplenishmentMetrics
  buckets: number[]
  totalUnits: number
  avgPer7: number
  suggestedQty: number
  confirmedQty: number
  confirmedCost: number
  suggestedCalculable: boolean
  suggestedReason?: string
  suggestedTargetUnits?: number
  suggestedTargetDays?: number
  suggestedRate?: number
  tendenciaPct: number | null
  estadoTendencia: string
}

export interface ReplenishmentMetrics {
  physicalStock: number
  sales60d: number
  salesRateWithStock: number | null
  unitsSoldWithStock: number
  daysWithStock: number
  coverageDays: number | null
  coverageWeeks: number
  daysWithoutStock: number
  breakCount: number
  knownDays: number
  evidenceCoveragePct: number
  targetUnits: number | null
  targetStock: number | null
  suggestedQty: number | null
  suggestedReason?: string
  isSalesIdentityResolved: boolean
}

export type BreakSummaryIndex = Map<number, BreakSummary60d>

export interface ReplenishmentTimelineDay {
  date: string
  sales: number
  stock: number | null
  receptions: number | null
  availableDuringDay: boolean | null
  stockout: boolean | null
  stateKnown: boolean | null
}

export interface ReplenishmentTimelinePeriod {
  periodStart: string
  periodEnd: string
  period: string
  sales: number
  daysWithStock: number | null
  daysWithoutStock: number | null
  knownDays: number | null
  closingStock: number | null
  receptions: number | null
}

export interface ReplenishmentTimelineData {
  days: ReplenishmentTimelineDay[]
  periods: ReplenishmentTimelinePeriod[]
  stockoutRanges: Array<{ from: string; to: string }>
  granularity: 'week'
}

export interface ReplenishmentTimelineAudit {
  expectedDays: number
  timelineDays: number
  uniqueTimelineDays: number
  duplicateDays: string[]
  uncoveredPeriodDays: string[]
  periodDays: number
  totals: {
    sales: number
    daysWithStock: number
    daysWithoutStock: number
    knownDays: number
  }
}

export type SuggestedQtyResult =
  | { calculable: true; quantity: number; targetDays: number; targetUnits: number; rate: number }
  | { calculable: false; quantity: null; reason: string }

export function calculateSuggestedQty(input: {
  salesRateWithStock: number | null
  physicalStock: number
  coverageWeeks: number
  salesIdentityResolved: boolean
}): SuggestedQtyResult {
  if (!input.salesIdentityResolved) {
    return { calculable: false, quantity: null, reason: 'Identidad de ventas no resuelta' }
  }
  if (input.salesRateWithStock === null || !Number.isFinite(input.salesRateWithStock)) {
    return { calculable: false, quantity: null, reason: 'Ritmo con stock no calculable' }
  }
  if (input.salesRateWithStock < 0) {
    return { calculable: false, quantity: null, reason: 'Ritmo con stock inválido' }
  }

  const targetDays = input.coverageWeeks * 7
  const targetUnits = input.salesRateWithStock * targetDays
  return {
    calculable: true,
    quantity: Math.max(0, Math.ceil(targetUnits - input.physicalStock)),
    targetDays,
    targetUnits,
    rate: input.salesRateWithStock,
  }
}

export function buildReplenishmentMetrics(input: {
  physicalStock: number
  breakSummary: BreakSummary60d
  coverageWeeks: number
}): ReplenishmentMetrics {
  const { physicalStock, breakSummary, coverageWeeks } = input
  const rate = breakSummary.salesIdentityResolved && breakSummary.salesRateWithStock !== null
    && Number.isFinite(breakSummary.salesRateWithStock)
    ? breakSummary.salesRateWithStock
    : null
  const coverageDays = rate !== null && rate > 0 ? physicalStock / rate : null
  const suggested = calculateSuggestedQty({
    salesRateWithStock: rate,
    physicalStock,
    coverageWeeks,
    salesIdentityResolved: breakSummary.salesIdentityResolved,
  })

  return {
    physicalStock,
    sales60d: breakSummary.unitsSoldWithStock + breakSummary.unitsSoldUnknownDays,
    salesRateWithStock: rate,
    unitsSoldWithStock: breakSummary.unitsSoldWithStock,
    daysWithStock: breakSummary.daysWithStock,
    coverageDays,
    coverageWeeks,
    daysWithoutStock: breakSummary.daysWithoutStock,
    breakCount: breakSummary.breakCount,
    knownDays: breakSummary.knownDays,
    evidenceCoveragePct: breakSummary.evidenceCoveragePct,
    targetUnits: suggested.calculable ? suggested.targetUnits : null,
    targetStock: suggested.calculable ? Math.ceil(suggested.targetUnits) : null,
    suggestedQty: suggested.calculable ? suggested.quantity : null,
    suggestedReason: suggested.calculable ? undefined : suggested.reason,
    isSalesIdentityResolved: breakSummary.salesIdentityResolved,
  }
}

export function buildBreakSummaryIndex(dataset: ReplenishmentDataset): BreakSummaryIndex {
  return new Map(
    Object.entries(dataset.breakSummary60d).map(([variantId, summary]) => [Number(variantId), summary]),
  )
}

export function getBreakSummary(index: BreakSummaryIndex, variantId: number | null | undefined): BreakSummary60d {
  // Missing read-model rows mean no confirmed break, not missing historical data.
  return (variantId !== null && variantId !== undefined ? index.get(variantId) : undefined) || {
    breakDays: 0,
    breakCount: 0,
    daysWithoutStock: 0,
    daysWithStock: 0,
    daysUnknown: 0,
    unitsSoldWithStock: 0,
    unitsSoldUnknownDays: 0,
    salesRateWithStock: null,
    knownDays: 0,
    evidenceCoveragePct: 0,
    positiveSalesWithoutStock: 0,
    salesIdentityResolved: false,
    salesIdentityMethod: 'NONE',
    stockoutRanges: [],
    lastBreakDate: null,
  }
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function overlapDays(from: string, to: string, periodStart: Date, periodEnd: Date) {
  const start = Math.max(new Date(`${from}T00:00:00Z`).getTime(), periodStart.getTime())
  const end = Math.min(new Date(`${to}T00:00:00Z`).getTime(), periodEnd.getTime())
  return end >= start ? Math.floor((end - start) / 86400000) + 1 : 0
}

/** Builds both views from the same daily source. Missing historical snapshots stay null. */
export function buildReplenishmentTimeline(input: {
  dataset: ReplenishmentDataset
  sku: string
  breakSummary: BreakSummary60d
  availability: ReplenishmentAvailabilityDaily[] | null
  kardex: ReplenishmentKardexEvent[] | null
}): ReplenishmentTimelineData {
  const end = new Date(`${input.dataset.dateTo}T00:00:00Z`)
  const availabilityDates = (input.availability || []).map(row => row.availability_date).sort()
  const kardexDates = (input.kardex || []).map(event => event.event_date).sort()
  const start = input.kardex && kardexDates.length > 0
    ? new Date(`${input.dataset.dateFrom}T00:00:00Z`)
    : input.availability && availabilityDates.length > 0
    ? new Date(`${availabilityDates[0]}T00:00:00Z`)
    : new Date(Math.max(new Date(`${input.dataset.dateFrom}T00:00:00Z`).getTime(), end.getTime() - 59 * 86400000))
  const timelineEnd = end
  const availabilityByDate = new Map((input.availability || []).map(row => [row.availability_date, row]))
  const salesByDate = new Map<string, number>()
  for (const sale of input.dataset.sales) {
    if (sale.SKU !== input.sku) continue
    const date = sale.fechaStr || isoDate(sale.fecha)
    salesByDate.set(date, (salesByDate.get(date) || 0) + (Number(sale.cantidad) || 0))
  }

  const kardexByDate = new Map<string, ReplenishmentKardexEvent[]>()
  for (const event of input.kardex || []) {
    const events = kardexByDate.get(event.event_date) || []
    events.push(event)
    kardexByDate.set(event.event_date, events)
  }

  const days: ReplenishmentTimelineDay[] = []
  for (let cursor = new Date(start); cursor <= timelineEnd; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = isoDate(cursor)
    const availability = availabilityByDate.get(date)
    const events = kardexByDate.get(date) || []
    const closingEvent = [...events].reverse().find(event => event.variant_stock_after !== null)
    days.push({
      date,
      sales: salesByDate.get(date) || 0,
      stock: closingEvent?.variant_stock_after ?? null,
      receptions: events.length > 0
        ? events.reduce((total, event) => event.source_type === 'RECEPTION' || event.source_type === 'RETURN' ? total + event.quantity_delta : total, 0)
        : null,
      availableDuringDay: availability ? availability.available_during_day : null,
      stockout: input.breakSummary.stockoutRanges.some(range => date >= range.from && date <= range.to),
      stateKnown: availability ? availability.state_known : null,
    })
  }

  const periods: ReplenishmentTimelinePeriod[] = []
  for (let index = 0; index < days.length; index += 7) {
    const slice = days.slice(index, index + 7)
    const periodStart = new Date(`${slice[0].date}T00:00:00Z`)
    const periodEnd = new Date(`${slice[slice.length - 1].date}T00:00:00Z`)
    const daysWithoutStock = input.breakSummary.stockoutRanges.reduce(
      (total, range) => total + overlapDays(range.from, range.to, periodStart, periodEnd), 0,
    )
    const availability = input.availability && input.availability.length > 0
      ? slice.map(day => availabilityByDate.get(day.date)).filter((day): day is ReplenishmentAvailabilityDaily => day !== undefined)
      : null
    periods.push({
      periodStart: slice[0].date,
      periodEnd: slice[slice.length - 1].date,
      period: `${slice[0].date.slice(8, 10)}/${slice[0].date.slice(5, 7)}–${slice[slice.length - 1].date.slice(8, 10)}/${slice[slice.length - 1].date.slice(5, 7)}`,
      sales: slice.reduce((total, day) => total + day.sales, 0),
      daysWithStock: availability ? availability.filter(day => day.available_during_day).length : null,
      daysWithoutStock,
      knownDays: availability ? availability.filter(day => day.state_known).length : null,
       closingStock: [...slice].reverse().find(day => day.stock !== null)?.stock ?? null,
       receptions: slice.some(day => day.receptions !== null)
         ? slice.reduce((total, day) => total + (day.receptions || 0), 0)
         : null,
    })
  }

  const windowStart = days[0]?.date || isoDate(start)
  const windowEnd = days[days.length - 1]?.date || isoDate(timelineEnd)
  return {
    days,
    periods,
    stockoutRanges: input.breakSummary.stockoutRanges
      .map(range => ({ from: range.from < windowStart ? windowStart : range.from, to: range.to > windowEnd ? windowEnd : range.to }))
      .filter(range => range.from <= range.to),
    granularity: 'week',
  }
}

/** Reconciliation helper for QA; it does not alter any V2 metric. */
export function auditReplenishmentTimeline(timeline: ReplenishmentTimelineData): ReplenishmentTimelineAudit {
  const timelineCounts = new Map<string, number>()
  timeline.days.forEach(day => timelineCounts.set(day.date, (timelineCounts.get(day.date) || 0) + 1))
  const firstDate = timeline.days[0]?.date
  const lastDate = timeline.days[timeline.days.length - 1]?.date
  const expectedDays = firstDate && lastDate
    ? Math.floor((new Date(`${lastDate}T00:00:00Z`).getTime() - new Date(`${firstDate}T00:00:00Z`).getTime()) / 86400000) + 1
    : 0
  const periodCounts = new Map<string, number>()
  for (const period of timeline.periods) {
    for (const day of timeline.days) {
      if (day.date >= period.periodStart && day.date <= period.periodEnd) {
        periodCounts.set(day.date, (periodCounts.get(day.date) || 0) + 1)
      }
    }
  }
  const duplicateDays = [...timelineCounts.entries()].filter(([, count]) => count > 1).map(([date]) => date)
  const uncoveredPeriodDays = timeline.days.filter(day => !periodCounts.has(day.date)).map(day => day.date)
  return {
    expectedDays,
    timelineDays: timeline.days.length,
    uniqueTimelineDays: timelineCounts.size,
    duplicateDays,
    uncoveredPeriodDays,
    periodDays: [...periodCounts.values()].reduce((sum, count) => sum + count, 0),
    totals: {
      sales: timeline.periods.reduce((sum, period) => sum + period.sales, 0),
      daysWithStock: timeline.periods.reduce((sum, period) => sum + (period.daysWithStock ?? 0), 0),
      daysWithoutStock: timeline.periods.reduce((sum, period) => sum + (period.daysWithoutStock ?? 0), 0),
      knownDays: timeline.periods.reduce((sum, period) => sum + (period.knownDays ?? 0), 0),
    },
  }
}

// Derivación pura: recibe un dataset ya obtenido y construye las filas SkuRow.
// Las recomendaciones usan el ritmo 60d con stock; los buckets siguen siendo
// solo datos históricos de la tabla. No depende de estado del componente.
export function deriveRows(
  dataset: ReplenishmentDataset,
  periodDays: number,
  coverageWeeks: number,
): { rows: SkuRow[]; dayAfterEnd: Date } {
  const { sales, stock, dateFrom, dateTo } = dataset
  const numBuckets = periodDays / 7

  const periodStart = new Date(dateFrom + 'T00:00:00Z')
  const periodEnd = new Date(dateTo + 'T00:00:00Z')
  const dayAfterEnd = new Date(periodEnd.getTime() + 86400000)
  const startDate = new Date(Math.max(dayAfterEnd.getTime() - periodDays * 86400000, periodStart.getTime()))

  // Keep the selected period's historical scope when the dataset also carries
  // extra days reserved for the daily sales index.
  const salesForPeriod = sales.filter(s => s.fecha >= startDate && s.fecha < dayAfterEnd)
  const raw = buildSkuSummary(salesForPeriod, stock, dayAfterEnd, startDate, dayAfterEnd, coverageWeeks)
  const classified = classifySkus(raw)
  const breakSummaryByVariantId = buildBreakSummaryIndex(dataset)

  const bucketEnd = dayAfterEnd.getTime()
  const bucketSize = 7 * 86400000

  const salesBySku = new Map<string, NormalizedSale[]>()
  for (const s of salesForPeriod) {
    if (!salesBySku.has(s.SKU)) salesBySku.set(s.SKU, [])
    salesBySku.get(s.SKU)!.push(s)
  }

  const rows: SkuRow[] = classified.map(sku => {
    const skuSales = salesBySku.get(sku.SKU) || []
    const buckets: number[] = []
    for (let b = 0; b < numBuckets; b++) {
      const bEnd = new Date(bucketEnd - b * bucketSize)
      const bStart = new Date(bEnd.getTime() - bucketSize)
      const units = skuSales
        .filter(s => s.fecha >= bStart && s.fecha < bEnd)
        .reduce((sum, s) => sum + s.cantidad, 0)
      buckets.unshift(units)
    }

    const totalUnits = sku.unidades_6m
    const avgPer7 = numBuckets > 0 ? totalUnits / numBuckets : 0
    const normalizedSku = sku.SKU.trim().toUpperCase()
    const variantId = sku.variant_id ?? dataset.variantIdsBySku?.[normalizedSku] ?? null
    if (normalizedSku === '2008DG') console.info('[replenishment-identity]', { stage: 'deriveRows', skuOriginal: sku.SKU, skuNormalized: normalizedSku, stockVariantId: sku.variant_id ?? null, datasetVariantId: dataset.variantIdsBySku?.[normalizedSku] ?? null, rowVariantId: variantId })
    const breakSummary = getBreakSummary(breakSummaryByVariantId, variantId)
    const metrics = buildReplenishmentMetrics({
      physicalStock: sku.cantidad_disponible,
      breakSummary,
      coverageWeeks,
    })
    const suggestedQty = metrics.suggestedQty ?? 0

    const TREND_THRESHOLD = 0.15
    let tendenciaPct: number | null = null
    let estadoTendencia = 'Sin comparación'
    if (buckets.length >= 2) {
      const mitad = Math.floor(buckets.length / 2)
      const anteriores = buckets.slice(0, mitad).reduce((acc, v) => acc + v, 0)
      const recientes = buckets.slice(mitad).reduce((acc, v) => acc + v, 0)
      if (anteriores > 0) {
        tendenciaPct = (recientes - anteriores) / anteriores
        if (tendenciaPct > TREND_THRESHOLD) estadoTendencia = 'Creciendo'
        else if (tendenciaPct < -TREND_THRESHOLD) estadoTendencia = 'Cayendo'
        else estadoTendencia = 'Estable'
      }
    }

    return {
      sku,
      variantId,
      metrics,
      buckets,
      totalUnits,
      avgPer7,
      suggestedQty,
      confirmedQty: suggestedQty,
      confirmedCost: suggestedQty * sku.costo_unitario,
      suggestedCalculable: metrics.suggestedQty !== null,
      suggestedReason: metrics.suggestedReason,
      suggestedTargetUnits: metrics.targetUnits ?? undefined,
      suggestedTargetDays: metrics.suggestedQty === null ? undefined : metrics.coverageWeeks * 7,
      suggestedRate: metrics.salesRateWithStock ?? undefined,
      tendenciaPct,
      estadoTendencia,
    }
  })

  return { rows, dayAfterEnd }
}
