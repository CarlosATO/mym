/** Contrato independiente de la pantalla y del origen de las entregas. */
export type EvaluationOrigin = 'PREPARATION' | 'ROUTE_GUIDE'
export type CostStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'

export type Profitability = {
  availability: 'AVAILABLE' | 'MISSING'
  costStatus: CostStatus | null
  estimatedGrossProfit: number | null
  estimatedMarginPct: number | null
  costCoveragePct: number | null
  salesNetTotal: number | null
  coveredSalesNet: number | null
  uncoveredSalesNet: number | null
}

/** Las referencias no contienen montos: son vínculos, no partidas adicionales. */
export type DocumentReference = {
  type: 'SALES_ORDER' | 'INVOICE'
  system: 'BSALE'
  id: number | null
  folio: string | null
}

export type EvaluationDelivery = {
  /** Identificador provisional por entrega; no presupone agrupación geográfica. */
  stopId: string
  source: { type: EvaluationOrigin; recordId: string }
  /** Campos recibidos con tipos incompatibles; se mantienen identificados para revisión. */
  invalidSourceFields?: string[]
  documents: DocumentReference[]
  routeGuide: { guideId: string | null; itemId: string | null; lineNumber: number | null }
  customer: { id: number | null; name: string | null }
  destination: {
    address: string | null
    commune: string | null
    city: string | null
    addressSource: 'PREPARATION_CARD' | 'ROUTE_GUIDE_ITEM' | 'UNKNOWN'
    communeSource: 'NORMALIZED_CITY' | 'MUNICIPALITY_RAW' | 'CITY_RAW' | 'ROUTE_GUIDE_ITEM' | 'UNKNOWN'
    completeness: 'COMPLETE' | 'INCOMPLETE'
  }
  commercial: {
    netAmount: number | null
    taxAmount: number | null
    grossAmount: number | null
    totalAmount: number | null
    profitability: Profitability
  }
}

export type RouteEvaluation = {
  companyId: string
  origin: EvaluationOrigin
  deliveries: EvaluationDelivery[]
  commercialSummary: {
    documentCount: number
    units: number
    /** Mismo total visible del tablero; los importes ausentes aportan cero. */
    grossAmount: number
    missingGrossAmountCount: number
    communes: string[]
    profitability: Profitability
  }
}
