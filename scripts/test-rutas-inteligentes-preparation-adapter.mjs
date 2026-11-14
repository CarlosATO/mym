import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Permite ejecutar imports TypeScript sin extensión, como en la aplicación Next.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  },
})

const { adaptFilteredPreparationCards } = await import('../src/modules/rutas-inteligentes/preparation-adapter.ts')
const { matchesPreparationSearch, matchesPreparationComunaFilter, matchesPreparationSellerFilter } = await import('../src/modules/logistica/preparacion-pedidos/preparation-board-utils.ts')

function card(id, overrides = {}) {
  return {
    card_id: `card-${id}`, company_id: 'company', nv_bsale_id: id, nv_folio: String(id),
    client_name: `Cliente ${id}`, client_id: id, address_raw: 'Calle 123',
    normalized_city: 'Chillán', municipality_raw: null, city_raw: null,
    seller_name: 'Ana', total_quantity: 2, net_amount: 100, tax_amount: 19,
    gross_amount: 119, total_amount: 119, invoice_folio: null, ...overrides,
  }
}

function summary(id, overrides = {}) {
  return {
    bsale_nv_id: id, nv_folio: String(id), sales_net_total: 100, covered_sales_net: 100,
    uncovered_sales_net: 0, last_purchase_cost_total: 60, estimated_gross_profit: 40,
    estimated_margin_pct: 40, cost_coverage_pct: 100, total_lines: 1,
    covered_lines: 1, uncovered_lines: 0, cost_status: 'COMPLETE', ...overrides,
  }
}

function evaluate(filteredCards, profitabilityByNv = {}) {
  return adaptFilteredPreparationCards({ companyId: 'company', filteredCards, profitabilityByNv })
}

test('evalúa exactamente las tarjetas filtradas, incluyendo filtros combinados y conjunto vacío', () => {
  const all = [card(1), card(2, { normalized_city: 'Los Ángeles', seller_name: 'Bea' }), card(3, { seller_name: 'Bea' })]
  const filter = (search, comunas, seller) => all.filter(c => matchesPreparationSearch(c, search) && matchesPreparationComunaFilter(c, new Set(comunas)) && matchesPreparationSellerFilter(c, seller))
  const bySeller = evaluate(filter('', [], 'bea'))
  assert.deepEqual(bySeller.deliveries.map(d => d.source.recordId), ['card-2', 'card-3'])
  assert.equal(bySeller.commercialSummary.grossAmount, 238)
  const combined = evaluate(filter('cliente 3', ['chillan'], 'bea'))
  assert.deepEqual(combined.deliveries.map(d => d.documents[0].id), [3])
  assert.equal(combined.commercialSummary.units, 2)
  assert.equal(evaluate(filter('inexistente', [], '')).deliveries.length, 0)
})

test('conserva información incompleta y la procedencia de la comuna', () => {
  const result = evaluate([
    card(1, { address_raw: '  ', normalized_city: null, municipality_raw: ' San Carlos ', city_raw: 'Ñuble', gross_amount: null, total_amount: null }),
    card(2, { address_raw: 'Camino', normalized_city: null, municipality_raw: null, city_raw: null }),
    card(3, { normalized_city: null, municipality_raw: null, city_raw: 'Temuco' }),
  ])
  const [a, b, c] = result.deliveries.map(d => d.destination)
  assert.deepEqual(a, { address: null, commune: 'San Carlos', city: 'Ñuble', addressSource: 'UNKNOWN', communeSource: 'MUNICIPALITY_RAW', completeness: 'INCOMPLETE' })
  assert.equal(b.commune, null)
  assert.equal(b.completeness, 'INCOMPLETE')
  assert.equal(c.communeSource, 'CITY_RAW')
  assert.equal(c.completeness, 'COMPLETE')
  assert.equal(result.commercialSummary.missingGrossAmountCount, 1)
})

test('distingue costos parciales, no disponibles y resúmenes comerciales ausentes', () => {
  const partial = summary(1, { covered_sales_net: 50, uncovered_sales_net: 50, last_purchase_cost_total: 30, cost_status: 'PARTIAL' })
  const unavailable = summary(2, { covered_sales_net: 0, uncovered_sales_net: 100, last_purchase_cost_total: 0, covered_lines: 0, uncovered_lines: 1, cost_status: 'UNAVAILABLE' })
  const result = evaluate([card(1), card(2)], { 1: partial, 2: unavailable })
  assert.equal(result.commercialSummary.profitability.costStatus, 'PARTIAL')
  assert.equal(result.commercialSummary.profitability.estimatedGrossProfit, 20)
  assert.equal(result.commercialSummary.profitability.costCoveragePct, 25)
  assert.equal(result.deliveries[1].commercial.profitability.costStatus, 'UNAVAILABLE')
  assert.equal(result.deliveries[1].commercial.profitability.estimatedGrossProfit, null)
  const missing = evaluate([card(1), card(2)], { 1: partial })
  assert.equal(missing.commercialSummary.profitability.availability, 'MISSING')
  assert.equal(missing.commercialSummary.profitability.costStatus, null)
  assert.equal(missing.deliveries[0].commercial.profitability.costStatus, 'PARTIAL')
  assert.equal(missing.deliveries[1].commercial.profitability.estimatedGrossProfit, null)
})

test('referencias de factura no duplican montos; rechaza NV duplicadas y empresa incorrecta', () => {
  const original = card(1, { read_model_invoice_bsale_id: 99, read_model_invoice_folio: '800', read_model_invoice_total_amount: 119 })
  const result = evaluate([original], { 1: summary(1) })
  assert.deepEqual(result.deliveries[0].documents.map(d => d.type), ['SALES_ORDER', 'INVOICE'])
  assert.equal(result.commercialSummary.grossAmount, 119)
  assert.equal(result.commercialSummary.profitability.estimatedGrossProfit, 40)
  assert.ok(result.deliveries[0].documents.every(d => !('amount' in d)))
  assert.throws(() => evaluate([original, { ...original, card_id: 'other' }]), /duplicada/)
  assert.throws(() => evaluate([card(2, { company_id: 'other' })]), /otra empresa/)
})
