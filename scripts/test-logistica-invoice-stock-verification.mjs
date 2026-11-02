import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyInvoiceStockDispatch } from '../src/lib/integraciones/invoice-stock-verification.ts'

const input = {
  companyId: 'company-fixture',
  invoiceId: 92819,
  invoiceNumber: 24874,
  salesId: 'PETGROUP:FACTURA:fixture-24874',
  officeId: 1,
  details: [
    { variantId: 6209, sku: '557025', quantity: 1 },
    { variantId: 6462, sku: 'ANC001', quantity: 10 },
    { variantId: 6072, sku: 'ALK02', quantity: 3 },
  ],
}

const document = {
  id: 92819,
  number: 24874,
  salesId: input.salesId,
  state: 0,
  document_type: { id: 5 },
  office: { id: 1 },
  details: { items: input.details.map(detail => ({ variant: { id: detail.variantId, code: detail.sku }, quantity: detail.quantity })) },
}

const completeShipping = {
  id: 81839,
  state: 0,
  office: { id: 1 },
  details: input.details.map(detail => ({ variant: { id: detail.variantId, code: detail.sku }, quantity: detail.quantity })),
}

function transport({ shippings = [completeShipping], costs = true, fail = null } = {}) {
  const calls = []
  return {
    calls,
    getResource: async path => {
      calls.push({ method: 'GET', path })
      if (fail === path) throw new Error('fixture read failure')
      if (path === '/documents/92819.json') return document
      throw new Error(`unexpected resource ${path}`)
    },
    getCollection: async (path) => {
      calls.push({ method: 'GET', path })
      if (fail === path) throw new Error('fixture read failure')
      if (path === '/shippings.json') return shippings
      const match = /^\/shippings\/(\d+)\/details\.json$/.exec(path)
      if (match) return shippings.find(item => item.id === Number(match[1]))?.details ?? []
      throw new Error(`unexpected collection ${path}`)
    },
    getCosts: async invoiceId => {
      calls.push({ method: 'GET', path: '/documents/costs.json', invoiceId })
      if (!costs) throw new Error('costs unavailable')
      return { totalCost: 100 }
    },
  }
}

test('reconoce el despacho completo de la factura #24874', async () => {
  const fixture = transport()
  const result = await verifyInvoiceStockDispatch(input, fixture)
  assert.equal(result.status, 'VERIFIED')
  assert.deepEqual(result.evidence.activeShippingIds, [81839])
  assert.equal(result.observed.active.reduce((sum, detail) => sum + detail.quantity, 0), 14)
  assert.equal(result.evidence.costsAvailable, true)
})

test('clasifica despacho parcial y ausencia de despacho como PENDING', async () => {
  const partial = transport({ shippings: [{ ...completeShipping, details: [{ ...completeShipping.details[0], quantity: 1 }] }] })
  assert.equal((await verifyInvoiceStockDispatch(input, partial)).status, 'PENDING')
  const absent = transport({ shippings: [] })
  const absentResult = await verifyInvoiceStockDispatch(input, absent)
  assert.equal(absentResult.status, 'PENDING')
  assert.match(absentResult.reasons.join('|'), /NO_ACTIVE_SHIPPING/)
})

test('ignora movimientos inactivos y no confunde una sucursal distinta', async () => {
  const inactive = transport({ shippings: [{ ...completeShipping, state: 1 }] })
  assert.equal((await verifyInvoiceStockDispatch(input, inactive)).status, 'PENDING')
  const wrongOffice = transport({ shippings: [{ ...completeShipping, office: { id: 2 } }] })
  const result = await verifyInvoiceStockDispatch(input, wrongOffice)
  assert.equal(result.status, 'PENDING')
  assert.deepEqual(result.observed.wrongOfficeShippingIds, [81839])
})

test('rechaza producto o cantidad incorrectos', async () => {
  const wrongProduct = transport({ shippings: [{ ...completeShipping, details: [{ variant: { id: 9999, code: 'OTHER' }, quantity: 14 }] }] })
  const result = await verifyInvoiceStockDispatch(input, wrongProduct)
  assert.equal(result.status, 'PENDING')
  assert.match(result.reasons.join('|'), /SHIPPING_PRODUCTS_OR_QUANTITIES_MISMATCH/)
})

test('agrega varias líneas del mismo producto antes de comparar', async () => {
  const repeatedInput = { ...input, details: [{ variantId: 6209, sku: '557025', quantity: 1 }, { variantId: 6209, sku: '557025', quantity: 2 }] }
  const repeatedDocument = { ...document, details: { items: [{ variant: { id: 6209, code: '557025' }, quantity: 3 }] } }
  const fixture = transport({ shippings: [{ ...completeShipping, details: [{ variant: { id: 6209, code: '557025' }, quantity: 3 }] }] })
  const originalResource = fixture.getResource
  fixture.getResource = async path => path === '/documents/92819.json' ? repeatedDocument : originalResource(path)
  assert.equal((await verifyInvoiceStockDispatch(repeatedInput, fixture)).status, 'VERIFIED')
})

test('devuelve UNABLE_TO_VERIFY ante error o respuesta incompleta de Bsale', async () => {
  assert.equal((await verifyInvoiceStockDispatch(input, transport({ fail: '/documents/92819.json' }))).status, 'UNABLE_TO_VERIFY')
  const incomplete = transport({ shippings: [{ id: 81839, state: 0, office: { id: 1 } }] })
  assert.equal((await verifyInvoiceStockDispatch(input, incomplete)).status, 'UNABLE_TO_VERIFY')
})

test('repetir la verificación sólo ejecuta GET y no produce efectos secundarios', async () => {
  const fixture = transport({ costs: false })
  const first = await verifyInvoiceStockDispatch(input, fixture)
  const second = await verifyInvoiceStockDispatch(input, fixture)
  assert.equal(first.status, 'VERIFIED')
  assert.equal(second.status, 'VERIFIED')
  assert.equal(fixture.calls.every(call => call.method === 'GET'), true)
  assert.equal(fixture.calls.some(call => call.method !== 'GET'), false)
})
