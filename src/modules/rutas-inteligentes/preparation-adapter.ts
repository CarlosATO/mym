import type { SalesOrderPreparationCardInfo } from '../../app/actions/logistica/sales-order-preparation'
import { getPreparationCardAmount, summarizePreparationBoard } from '../logistica/preparacion-pedidos/preparation-board-utils'
import { aggregatePreparationProfitability } from '../logistica/preparacion-pedidos/preparation-profitability'
import type { PreparationProfitabilityAggregate, PreparationProfitabilitySummaryV1 } from '../logistica/preparacion-pedidos/preparation-profitability'
import type { DocumentReference, Profitability, RouteEvaluation } from './types'

type PreparationRouteCard = Omit<SalesOrderPreparationCardInfo, 'nv_folio' | 'invoice_folio' | 'read_model_invoice_folio'> & {
  nv_folio: string | number | null
  invoice_folio: string | number | null
  read_model_invoice_folio?: string | number | null
}

function clean(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null
}

function cleanFolio(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return clean(value)
}

function isInvalidText(value: unknown): boolean {
  return value != null && typeof value !== 'string'
}

function isInvalidFolio(value: unknown): boolean {
  return value != null && typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function profitability(value: PreparationProfitabilityAggregate | null): Profitability {
  if (!value) return {
    availability: 'MISSING', costStatus: null, estimatedGrossProfit: null,
    estimatedMarginPct: null, costCoveragePct: null, salesNetTotal: null,
    coveredSalesNet: null, uncoveredSalesNet: null,
  }
  return {
    availability: 'AVAILABLE',
    costStatus: value.costStatus,
    estimatedGrossProfit: value.costStatus === 'UNAVAILABLE' ? null : value.estimatedGrossProfit,
    estimatedMarginPct: value.estimatedMarginPct,
    costCoveragePct: value.costCoveragePct,
    salesNetTotal: value.salesNetTotal,
    coveredSalesNet: value.coveredSalesNet,
    uncoveredSalesNet: value.uncoveredSalesNet,
  }
}

/**
 * Recibe exactamente filteredCards del tablero, después de aplicar sus filtros.
 * No consulta datos, no aplica filtros ni utiliza la selección de tarjetas.
 * Las tarjetas deben ser únicas por NV y pertenecer a la empresa indicada.
 */
export function adaptFilteredPreparationCards(params: {
  companyId: string
  filteredCards: readonly PreparationRouteCard[]
  profitabilityByNv: Readonly<Record<string, PreparationProfitabilitySummaryV1>>
}): RouteEvaluation {
  const { companyId, filteredCards, profitabilityByNv } = params
  if (!companyId.trim()) throw new Error('Empresa inválida')
  const seenCards = new Set<string>()
  const seenNvs = new Set<number>()
  for (const card of filteredCards) {
    if (card.company_id !== companyId) throw new Error('La tarjeta pertenece a otra empresa')
    if (!card.card_id || !Number.isSafeInteger(card.nv_bsale_id) || card.nv_bsale_id <= 0) throw new Error('Identidad de tarjeta o NV inválida')
    if (seenCards.has(card.card_id) || seenNvs.has(card.nv_bsale_id)) throw new Error('Tarjeta o NV duplicada')
    seenCards.add(card.card_id)
    seenNvs.add(card.nv_bsale_id)
  }

  // Los datos de dirección pasan por la misma validación antes de llegar al
  // resumen compartido, que espera strings para construir las comunas.
  const cards = filteredCards.map(card => ({
    ...card,
    nv_folio: cleanFolio(card.nv_folio) ?? '',
    normalized_city: clean(card.normalized_city),
    municipality_raw: clean(card.municipality_raw),
    city_raw: clean(card.city_raw),
    address_raw: clean(card.address_raw),
  }))
  const board = summarizePreparationBoard(cards)
  return {
    companyId,
    origin: 'PREPARATION',
    deliveries: cards.map((card, index) => {
      const original = filteredCards[index]
      const invalidSourceFields = [
        ...(['address_raw', 'normalized_city', 'municipality_raw', 'city_raw', 'client_name'] as const).filter(field => isInvalidText(original[field])),
        ...(['nv_folio', 'invoice_folio', 'read_model_invoice_folio'] as const).filter(field => isInvalidFolio(original[field])),
      ]
      const address = clean(card.address_raw)
      const normalizedCity = clean(card.normalized_city)
      const municipality = clean(card.municipality_raw)
      const city = clean(card.city_raw)
      const commune = normalizedCity ?? municipality ?? city
      const documents: DocumentReference[] = [{ type: 'SALES_ORDER', system: 'BSALE', id: card.nv_bsale_id, folio: cleanFolio(original.nv_folio) }]
      const invoiceId = card.read_model_invoice_bsale_id ?? null
      const invoiceFolio = invoiceId != null ? cleanFolio(card.read_model_invoice_folio) : cleanFolio(card.read_model_invoice_folio) ?? cleanFolio(card.invoice_folio)
      if (invoiceId != null || invoiceFolio != null) documents.push({ type: 'INVOICE', system: 'BSALE', id: invoiceId, folio: invoiceFolio })
      return {
        stopId: `preparation:${card.card_id}`,
        source: { type: 'PREPARATION', recordId: card.card_id },
        invalidSourceFields,
        documents,
        routeGuide: { guideId: null, itemId: null, lineNumber: null },
        customer: { id: card.client_id ?? null, name: clean(card.client_name) },
        destination: {
          address, commune, city,
          addressSource: address ? 'PREPARATION_CARD' : 'UNKNOWN',
          communeSource: normalizedCity ? 'NORMALIZED_CITY' : municipality ? 'MUNICIPALITY_RAW' : city ? 'CITY_RAW' : 'UNKNOWN',
          completeness: address && commune ? 'COMPLETE' : 'INCOMPLETE',
        },
        commercial: {
          netAmount: card.net_amount ?? null,
          taxAmount: card.tax_amount ?? null,
          grossAmount: card.gross_amount ?? null,
          totalAmount: card.total_amount ?? null,
          profitability: profitability(aggregatePreparationProfitability([card], profitabilityByNv)),
        },
      }
    }),
    commercialSummary: {
      documentCount: board.nvCount,
      units: board.units,
      grossAmount: board.amount,
      missingGrossAmountCount: cards.filter(card => getPreparationCardAmount(card) === null).length,
      communes: board.comunas,
      profitability: profitability(aggregatePreparationProfitability(cards, profitabilityByNv)),
    },
  }
}
