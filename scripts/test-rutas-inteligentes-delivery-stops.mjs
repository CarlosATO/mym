import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDeliveryStops } from '../src/modules/rutas-inteligentes/delivery-stops.ts'

function delivery(id, overrides = {}) {
  return {
    stopId: `preparation:${id}`,
    source: { type: 'PREPARATION', recordId: String(id) },
    documents: [{ type: 'SALES_ORDER', system: 'BSALE', id, folio: String(id) }],
    routeGuide: { guideId: null, itemId: null, lineNumber: null },
    customer: { id: 10, name: 'Cliente' },
    destination: { address: 'Calle 123', commune: 'Chillán', city: null, addressSource: 'PREPARATION_CARD', communeSource: 'MUNICIPALITY_RAW', completeness: 'COMPLETE' },
    commercial: { netAmount: 100, taxAmount: 19, grossAmount: 119, totalAmount: 119, profitability: { availability: 'MISSING', costStatus: null, estimatedGrossProfit: null, estimatedMarginPct: null, costCoveragePct: null, salesNetTotal: null, coveredSalesNet: null, uncoveredSalesNet: null } },
    ...overrides,
  }
}

test('agrupa NV del mismo cliente y destino conservando referencias y montos', () => {
  const first = delivery(1)
  const second = delivery(2, { destination: { ...first.destination, address: ' CALLE   123 ', commune: 'CHILLÁN' }, documents: [{ type: 'SALES_ORDER', system: 'BSALE', id: 2, folio: '2' }, { type: 'INVOICE', system: 'BSALE', id: 99, folio: '900' }] })
  const result = buildDeliveryStops([first, second])
  assert.equal(result.stops.length, 1)
  assert.equal(result.unresolved.length, 0)
  assert.equal(result.stops[0].durationMinutes, 20)
  assert.deepEqual(result.stops[0].deliveries.map(d => d.documents[0].id), [1, 2])
  assert.equal(result.stops[0].deliveries.reduce((sum, d) => sum + d.commercial.grossAmount, 0), 238)
  assert.equal(result.stops[0].deliveries[1].documents[1].id, 99)
  assert.equal(buildDeliveryStops([first], { durationMinutes: 35 }).stops[0].durationMinutes, 35)
})

test('separa direcciones, comunas y clientes diferentes sin equivalencias ambiguas', () => {
  const one = delivery(1)
  const items = [one,
    delivery(2, { destination: { ...one.destination, address: 'Calle 124' } }),
    delivery(3, { customer: { id: 11, name: 'Cliente' } }),
    delivery(4, { destination: { ...one.destination, commune: 'Pinto' } }),
    delivery(5, { destination: { ...one.destination, address: 'Cl. 123' } }),
  ]
  assert.equal(buildDeliveryStops(items).stops.length, 5)
})

test('conserva separadas las direcciones incompletas o ambiguas y la identidad desconocida', () => {
  const base = delivery(1)
  const items = [
    delivery(1, { destination: { ...base.destination, address: null, completeness: 'INCOMPLETE' } }),
    delivery(2, { destination: { ...base.destination, commune: null, completeness: 'INCOMPLETE' } }),
    delivery(3, { destination: { ...base.destination, address: 'Calle sin número' } }),
    delivery(4, { destination: { ...base.destination, communeSource: 'CITY_RAW' } }),
    delivery(5, { customer: { id: null, name: 'Cliente' } }),
    delivery(6, { documents: [] }),
  ]
  const result = buildDeliveryStops(items)
  assert.equal(result.stops.length, 0)
  assert.deepEqual(result.unresolved.map(entry => entry.issues[0]), ['MISSING_ADDRESS', 'MISSING_COMMUNE', 'AMBIGUOUS_ADDRESS', 'AMBIGUOUS_COMMUNE', 'MISSING_CUSTOMER_ID', 'MISSING_DOCUMENT_IDENTITY'])
  assert.deepEqual(result.unresolved.map(entry => entry.delivery.source.recordId), ['1', '2', '3', '4', '5', '6'])
})

test('señala documentos comerciales repetidos sin descartar entregas ni duplicar totales', () => {
  const nv = { type: 'SALES_ORDER', system: 'BSALE', id: 77, folio: '77' }
  const sharedInvoice = { type: 'INVOICE', system: 'BSALE', id: 88, folio: '88' }
  const items = [delivery(1, { documents: [nv, sharedInvoice] }), delivery(2, { documents: [nv, sharedInvoice] }), delivery(3, { documents: [{ ...nv, id: 79, folio: '79' }, sharedInvoice] })]
  const result = buildDeliveryStops(items)
  assert.equal(result.stops.length, 1)
  assert.deepEqual(result.stops[0].deliveries.map(d => d.source.recordId), ['3'])
  assert.equal(result.unresolved.length, 2)
  assert.ok(result.unresolved.every(entry => entry.issues.includes('DUPLICATE_DOCUMENT')))
  assert.equal(result.unresolved[0].delivery.commercial.grossAmount, 119)
  assert.ok(!('grossAmount' in result.stops[0]))
})

test('resultado e identificadores son deterministas frente a distintos órdenes', () => {
  const first = delivery(1)
  const items = [first, delivery(2), delivery(3, { customer: { id: 11, name: 'Otro' } }), delivery(4, { destination: { ...first.destination, address: null, completeness: 'INCOMPLETE' } })]
  const before = structuredClone(items)
  assert.deepEqual(buildDeliveryStops(items), buildDeliveryStops([...items].reverse()))
  assert.deepEqual(items, before)
  assert.throws(() => buildDeliveryStops([first, first]), /origen.*duplicada/)
  assert.throws(() => buildDeliveryStops(items, { durationMinutes: 0 }), /Duración/)
})

test('factura independiente vinculada a una NV se marca para revisión junto a ella', () => {
  const invoice = { type: 'INVOICE', system: 'BSALE', id: 42, folio: '900' }
  const first = delivery(1, { documents: [...delivery(1).documents, invoice] })
  const second = delivery(2, { documents: [invoice] })
  const result = buildDeliveryStops([first, second])
  assert.equal(result.stops.length, 0)
  assert.equal(result.unresolved.length, 2)
  assert.ok(result.unresolved.every(entry => entry.issues.includes('DUPLICATE_DOCUMENT')))
})
