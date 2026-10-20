export type PreparationProfitabilityStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'

export type PreparationProfitabilitySummaryV1 = {
  bsale_nv_id: number
  nv_folio: string | null
  sales_net_total: number
  covered_sales_net: number
  uncovered_sales_net: number
  last_purchase_cost_total: number
  estimated_gross_profit: number
  estimated_margin_pct: number | null
  cost_coverage_pct: number | null
  total_lines: number
  covered_lines: number
  uncovered_lines: number
  cost_status: PreparationProfitabilityStatus
}

export type PreparationProfitabilityAggregate = {
  salesNetTotal: number
  coveredSalesNet: number
  uncoveredSalesNet: number
  lastPurchaseCostTotal: number
  estimatedGrossProfit: number
  estimatedMarginPct: number | null
  costCoveragePct: number | null
  costStatus: PreparationProfitabilityStatus
  totalLines: number
  coveredLines: number
  uncoveredLines: number
}

type ProfitabilityCard = {
  nv_bsale_id: number
}

const profitabilityCache = new Map<number, PreparationProfitabilitySummaryV1>()

export function getCachedPreparationProfitability(nvBsaleId: number): PreparationProfitabilitySummaryV1 | undefined {
  return profitabilityCache.get(nvBsaleId)
}

export function cachePreparationProfitability(rows: PreparationProfitabilitySummaryV1[]): void {
  for (const row of rows) {
    profitabilityCache.set(Number(row.bsale_nv_id), row)
  }
}

export function getCachedPreparationProfitabilityMap(nvBsaleIds: number[]): Record<string, PreparationProfitabilitySummaryV1> {
  const result: Record<string, PreparationProfitabilitySummaryV1> = {}
  for (const nvBsaleId of nvBsaleIds) {
    const cached = profitabilityCache.get(Number(nvBsaleId))
    if (cached) result[String(nvBsaleId)] = cached
  }
  return result
}

export function invalidatePreparationProfitabilityCache(): void {
  profitabilityCache.clear()
}

export function aggregatePreparationProfitability<T extends ProfitabilityCard>(
  cards: T[],
  summariesByNv: Record<string, PreparationProfitabilitySummaryV1>,
): PreparationProfitabilityAggregate | null {
  if (cards.length === 0) return null

  let salesNetTotal = 0
  let coveredSalesNet = 0
  let uncoveredSalesNet = 0
  let lastPurchaseCostTotal = 0
  let totalLines = 0
  let coveredLines = 0
  let uncoveredLines = 0

  for (const card of cards) {
    const summary = summariesByNv[String(card.nv_bsale_id)]
    if (!summary) return null

    salesNetTotal += Number(summary.sales_net_total ?? 0)
    coveredSalesNet += Number(summary.covered_sales_net ?? 0)
    uncoveredSalesNet += Number(summary.uncovered_sales_net ?? 0)
    lastPurchaseCostTotal += Number(summary.last_purchase_cost_total ?? 0)
    totalLines += Number(summary.total_lines ?? 0)
    coveredLines += Number(summary.covered_lines ?? 0)
    uncoveredLines += Number(summary.uncovered_lines ?? 0)
  }

  const estimatedGrossProfit = coveredSalesNet - lastPurchaseCostTotal
  return {
    salesNetTotal,
    coveredSalesNet,
    uncoveredSalesNet,
    lastPurchaseCostTotal,
    estimatedGrossProfit,
    estimatedMarginPct: coveredSalesNet !== 0 ? (estimatedGrossProfit / coveredSalesNet) * 100 : null,
    costCoveragePct: salesNetTotal !== 0 ? (coveredSalesNet / salesNetTotal) * 100 : null,
    costStatus: coveredSalesNet === 0
      ? 'UNAVAILABLE'
      : coveredSalesNet < salesNetTotal
        ? 'PARTIAL'
        : 'COMPLETE',
    totalLines,
    coveredLines,
    uncoveredLines,
  }
}

export function formatPreparationProfitabilityPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${new Intl.NumberFormat('es-CL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}%`
}
