export type MermaGrossLine = {
  consumptionId: number
  detailId: number
  variantId: number
  requestId: string | null
  date: string
  quantity: number
  cost: number | null
}

export type MermaReturnLine = {
  sourceConsumptionId: number | null
  sourceDetailId: number | null
  variantId: number
  requestId: string | null
  date: string
  quantity: number
  unitCost: number
}

export type MermaAnalyticsProduct = {
  sku: string
  name: string
  gross_units: number
  gross_cost: number
  returned_units: number
  returned_cost: number
  net_units: number
  net_cost: number
  units: number
  cost: number
}

export type MermaAnalyticsResult = {
  totals: {
    gross_cost: number
    gross_units: number
    returned_cost: number
    returned_units: number
    net_cost: number
    net_units: number
    products: number
    uncosted_lines: number
    uncosted_units: number
    previous_net_cost: number
    cost_variation: number | null
    inconsistencies: Array<{ variantId: number; requestId: string | null; grossUnits: number; returnedUnits: number }>
  }
  monthly: Array<{ month: string; gross_cost: number; gross_units: number; returned_cost: number; returned_units: number; net_cost: number; net_units: number; cost: number; units: number }>
  products: MermaAnalyticsProduct[]
}

type ProductLabel = { sku: string; name: string }

function lineKey(consumptionId: number | null, detailId: number | null, variantId: number, requestId: string | null) {
  return `${consumptionId ?? ''}|${detailId ?? ''}|${variantId}|${requestId ?? ''}`
}

function inPeriod(date: string, from: string, to: string) {
  return date >= from && date <= to
}

function emptyProduct(label: ProductLabel) {
  return { ...label, gross_units: 0, gross_cost: 0, returned_units: 0, returned_cost: 0, net_units: 0, net_cost: 0, units: 0, cost: 0 }
}

export function calculateMermasAnalytics(input: {
  from: string
  to: string
  previousFrom: string
  previousTo: string
  grossLines: MermaGrossLine[]
  returnLines: MermaReturnLine[]
  labels: Map<number, ProductLabel>
}): MermaAnalyticsResult {
  const grossByKey = new Map<string, MermaGrossLine>()
  for (const line of input.grossLines) grossByKey.set(lineKey(line.consumptionId, line.detailId, line.variantId, line.requestId), line)

  const returnsByKey = new Map<string, MermaReturnLine[]>()
  for (const line of input.returnLines) {
    const key = lineKey(line.sourceConsumptionId, line.sourceDetailId, line.variantId, line.requestId)
    returnsByKey.set(key, [...(returnsByKey.get(key) ?? []), line])
  }

  const allKeys = new Set([...grossByKey.keys(), ...returnsByKey.keys()])
  const currentProducts = new Map<number, MermaAnalyticsProduct>()
  const monthly = new Map<string, { gross_cost: number; gross_units: number; returned_cost: number; returned_units: number }>()
  const inconsistencies: MermaAnalyticsResult['totals']['inconsistencies'] = []
  let currentGrossCost = 0
  let currentGrossUnits = 0
  let currentReturnedCost = 0
  let currentReturnedUnits = 0
  let previousNetCost = 0
  let uncostedLines = 0
  let uncostedUnits = 0

  const addMonthly = (month: string) => {
    const value = monthly.get(month) ?? { gross_cost: 0, gross_units: 0, returned_cost: 0, returned_units: 0 }
    monthly.set(month, value)
    return value
  }

  for (const key of allKeys) {
    const gross = grossByKey.get(key)
    const returned = returnsByKey.get(key) ?? []
    const returnedUnits = returned.reduce((sum, line) => sum + line.quantity, 0)
    const grossUnits = gross?.quantity ?? 0
    const grossCost = gross?.cost == null || !Number.isFinite(gross.cost) ? 0 : gross.quantity * gross.cost
    if (returnedUnits > grossUnits) inconsistencies.push({ variantId: gross?.variantId ?? returned[0].variantId, requestId: gross?.requestId ?? returned[0].requestId, grossUnits, returnedUnits })
    const productId = gross?.variantId ?? returned[0]?.variantId
    if (!productId) continue
    const product = currentProducts.get(productId) ?? emptyProduct(input.labels.get(productId) ?? { sku: `BS-${productId}`, name: 'Producto Bsale' })

    if (gross && inPeriod(gross.date, input.from, input.to)) {
      product.gross_units += grossUnits
      product.gross_cost += grossCost
      currentGrossUnits += grossUnits
      currentGrossCost += grossCost
      const bucket = addMonthly(gross.date.slice(0, 7))
      bucket.gross_units += grossUnits
      bucket.gross_cost += grossCost
      if (gross.cost == null || !Number.isFinite(gross.cost)) {
        uncostedLines += 1
        uncostedUnits += grossUnits
      }
    }
    if (gross && inPeriod(gross.date, input.previousFrom, input.previousTo)) {
      previousNetCost += grossCost
    }
    for (const line of returned) {
      if (!inPeriod(line.date, input.from, input.to)) {
        if (inPeriod(line.date, input.previousFrom, input.previousTo)) previousNetCost -= line.quantity * line.unitCost
        continue
      }
      product.returned_units += line.quantity
      product.returned_cost += line.quantity * line.unitCost
      currentReturnedUnits += line.quantity
      currentReturnedCost += line.quantity * line.unitCost
      const bucket = addMonthly(line.date.slice(0, 7))
      bucket.returned_units += line.quantity
      bucket.returned_cost += line.quantity * line.unitCost
    }
    product.net_units = product.gross_units - product.returned_units
    product.net_cost = product.gross_cost - product.returned_cost
    product.units = product.net_units
    product.cost = product.net_cost
    currentProducts.set(productId, product)
  }

  const netCost = currentGrossCost - currentReturnedCost
  const netUnits = currentGrossUnits - currentReturnedUnits
  return {
    totals: {
      gross_cost: currentGrossCost,
      gross_units: currentGrossUnits,
      returned_cost: currentReturnedCost,
      returned_units: currentReturnedUnits,
      net_cost: netCost,
      net_units: netUnits,
      products: currentProducts.size,
      uncosted_lines: uncostedLines,
      uncosted_units: uncostedUnits,
      previous_net_cost: previousNetCost,
      cost_variation: previousNetCost === 0 ? null : (netCost - previousNetCost) / previousNetCost * 100,
      inconsistencies,
    },
    monthly: [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, value]) => ({
      month,
      ...value,
      net_cost: value.gross_cost - value.returned_cost,
      net_units: value.gross_units - value.returned_units,
      cost: value.gross_cost - value.returned_cost,
      units: value.gross_units - value.returned_units,
    })),
    products: [...currentProducts.values()].map(product => ({ ...product })).sort((a, b) => b.net_cost - a.net_cost || b.net_units - a.net_units),
  }
}
