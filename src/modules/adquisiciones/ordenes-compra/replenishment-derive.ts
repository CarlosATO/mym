import { buildSkuSummary, classifySkus } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'
import type { NormalizedSale, SkuSummary } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'
import type { BreakSummary60d, ReplenishmentDataset } from '@/app/actions/integraciones/bsale-dataset'

export interface SkuRow {
  sku: SkuSummary
  variantId: number | null
  buckets: number[]
  totalUnits: number
  avgPer7: number
  suggestedQty: number
  confirmedQty: number
  confirmedCost: number
  tendenciaPct: number | null
  estadoTendencia: string
}

export interface DailySalesPoint {
  date: string
  units: number
}

export type DailySalesIndex = Map<string, DailySalesPoint[]>

export type BreakSummaryIndex = Map<number, BreakSummary60d>

export function buildBreakSummaryIndex(dataset: ReplenishmentDataset): BreakSummaryIndex {
  return new Map(
    Object.entries(dataset.breakSummary60d).map(([variantId, summary]) => [Number(variantId), summary]),
  )
}

export function getBreakSummary(index: BreakSummaryIndex, variantId: number | null | undefined): BreakSummary60d {
  // Missing read-model rows mean no confirmed break, not missing historical data.
  return (variantId !== null && variantId !== undefined ? index.get(variantId) : undefined) || { breakDays: 0, breakCount: 0, daysWithoutStock: 0, daysWithStock: 0, stockoutRanges: [], lastBreakDate: null }
}

export function buildDailySalesIndex(
  dataset: ReplenishmentDataset,
  days = 60,
): DailySalesIndex {
  const dateTo = new Date(dataset.dateTo + 'T00:00:00Z')
  const startDate = new Date(dateTo)
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1))
  const endDateExclusive = new Date(dateTo)
  endDateExclusive.setUTCDate(endDateExclusive.getUTCDate() + 1)

  const grouped = new Map<string, Map<string, number>>()
  for (const sale of dataset.sales) {
    const date = sale.fechaStr || sale.fecha.toISOString().split('T')[0]
    const saleDate = new Date(date + 'T00:00:00Z')
    if (saleDate < startDate || saleDate >= endDateExclusive) continue

    const units = Number(sale.cantidad) || 0
    if (units === 0) continue

    if (!grouped.has(sale.SKU)) grouped.set(sale.SKU, new Map())
    const byDate = grouped.get(sale.SKU)!
    byDate.set(date, (byDate.get(date) || 0) + units)
  }

  return new Map(
    [...grouped.entries()].map(([sku, byDate]) => [
      sku,
      [...byDate.entries()]
        .filter(([, units]) => units !== 0)
        .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
        .map(([date, units]) => ({ date, units })),
    ]),
  )
}

// Derivación pura: recibe un dataset ya obtenido y construye las filas SkuRow
// con la MISMA fórmula del motor existente (buildSkuSummary + classifySkus +
// buckets semanales). No depende de estado del componente.
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
    const suggestedQty = Math.max(0, Math.ceil(avgPer7 * coverageWeeks) - sku.cantidad_disponible)

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
      variantId: sku.variant_id ?? null,
      buckets,
      totalUnits,
      avgPer7,
      suggestedQty,
      confirmedQty: suggestedQty,
      confirmedCost: suggestedQty * sku.costo_unitario,
      tendenciaPct,
      estadoTendencia,
    }
  })

  return { rows, dayAfterEnd }
}
