import type { SalesOrderPreparationCardInfo } from '../../app/actions/logistica/sales-order-preparation'
import { getPreparationCardAmount, summarizePreparationBoard } from '../logistica/preparacion-pedidos/preparation-board-utils'
import { aggregatePreparationProfitability } from '../logistica/preparacion-pedidos/preparation-profitability'
import type { PreparationProfitabilityAggregate, PreparationProfitabilitySummaryV1 } from '../logistica/preparacion-pedidos/preparation-profitability'
import type { DocumentReference, Profitability, RouteEvaluation } from './types'

function clean(value: string | null | undefined): string | null {
  return value?.trim() || null
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
  filteredCards: readonly SalesOrderPreparationCardInfo[]
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

  const cards = [...filteredCards]
  const board = summarizePreparationBoard(cards)
  return {
    companyId,
    origin: 'PREPARATION',
    deliveries: cards.map(card => {
      const address = clean(card.address_raw)
      const normalizedCity = clean(card.normalized_city)
      const municipality = clean(card.municipality_raw)
      const city = clean(card.city_raw)
      const commune = normalizedCity ?? municipality ?? city
      const documents: DocumentReference[] = [{ type: 'SALES_ORDER', system: 'BSALE', id: card.nv_bsale_id, folio: clean(card.nv_folio) }]
      const invoiceId = card.read_model_invoice_bsale_id ?? null
      const invoiceFolio = invoiceId != null ? clean(card.read_model_invoice_folio) : clean(card.read_model_invoice_folio) ?? clean(card.invoice_folio)
      if (invoiceId != null || invoiceFolio != null) documents.push({ type: 'INVOICE', system: 'BSALE', id: invoiceId, folio: invoiceFolio })
      return {
        stopId: `preparation:${card.card_id}`,
        source: { type: 'PREPARATION', recordId: card.card_id },
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
