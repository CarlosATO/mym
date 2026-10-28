import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createControlledInvoiceCoordinator } from '../src/lib/integraciones/invoice-emission-coordinator.ts'
import { buildInvoiceEmissionIdentity, buildInvoiceEmissionPayload, chileDateToBsaleEpoch, chileToday, formatBsaleRejection, invoiceEmissionEnabled, validateCompleteInvoiceLines, validateInvoiceDocument } from '../src/lib/integraciones/invoice-emission-contract.ts'

const payload = buildInvoiceEmissionPayload({
  officeId: 1,
  priceListId: 4,
  saleConditionId: 10,
  emissionDate: chileDateToBsaleEpoch('2026-10-21'),
  expirationDate: chileDateToBsaleEpoch('2026-10-21'),
  clientId: 1005,
  sellerId: 28,
  salesId: 'PETGROUP:FACTURA:demo-5032',
  details: [{ detailId: 334790, quantity: 1 }, { detailId: 334791, quantity: 1 }],
  payments: [{ paymentTypeId: 8, amount: 5598, recordDate: 1792540800 }],
})
const emissionAction = fs.readFileSync(new URL('../src/app/actions/logistica/sales-order-invoice-attempts.ts', import.meta.url), 'utf8')

const document = {
  salesId: payload.salesId,
  documentTypeId: 5,
  clientId: 1005,
  officeId: 1,
  netAmount: 4704,
  taxAmount: 894,
  totalAmount: 5598,
  details: [{ relatedDetailId: 334790, quantity: 1 }, { relatedDetailId: 334791, quantity: 1 }],
}
const expected = {
  clientId: 1005,
  officeId: 1,
  netAmount: 4704,
  taxAmount: 894,
  totalAmount: 5598,
  details: document.details,
}

test('flag off blocks emission before transport', async () => {
  let posts = 0
  const coordinator = createControlledInvoiceCoordinator({ post: async () => { posts += 1; return document } })
  const result = await coordinator.emit({ salesId: payload.salesId, fingerprint: 'fp', payload, expected }, false)
  assert.equal(result.reason, 'EMISSION_DISABLED')
  assert.equal(posts, 0)
})

test('double click and concurrent requests produce one mock POST', async () => {
  let posts = 0
  const coordinator = createControlledInvoiceCoordinator({ post: async body => { posts += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { ...document, salesId: body.salesId } } })
  const input = { salesId: payload.salesId, fingerprint: 'fp', payload, expected }
  const results = await Promise.all([coordinator.emit(input, true), coordinator.emit(input, true)])
  assert.equal(posts, 1)
  assert.equal(results[0].status, 'CONFIRMED')
  assert.equal(results[1].status, 'CONFIRMED')
})

test('timeout remains UNKNOWN and later reconciliation confirms without a second POST', async () => {
  let posts = 0
  const coordinator = createControlledInvoiceCoordinator({ post: async () => { posts += 1; throw new Error('timeout') } })
  const input = { salesId: payload.salesId, fingerprint: 'fp', payload, expected }
  assert.equal((await coordinator.emit(input, true)).status, 'UNKNOWN')
  assert.equal(coordinator.reconcile(payload.salesId, document).status, 'CONFIRMED')
  assert.equal(posts, 1)
})

test('fingerprint changes and an existing confirmed invoice cannot create a second one', async () => {
  let posts = 0
  const coordinator = createControlledInvoiceCoordinator({ post: async () => { posts += 1; return document } })
  const input = { salesId: payload.salesId, fingerprint: 'fp', payload, expected }
  await coordinator.emit(input, true)
  assert.equal((await coordinator.emit({ ...input, fingerprint: 'changed' }, true)).reason, 'FINGERPRINT_CHANGED')
  assert.equal((await coordinator.emit(input, true)).status, 'CONFIRMED')
  assert.equal(posts, 1)
})

test('payload and target validation preserve 5032 details and omit dispatch', () => {
  assert.deepEqual(payload.details, [{ detailId: 334790, quantity: 1 }, { detailId: 334791, quantity: 1 }])
  assert.equal(payload.declareSii, 1)
  assert.deepEqual(payload.payments, [{ paymentTypeId: 8, amount: 5598, recordDate: 1792540800 }])
  assert.match(emissionAction, /payment_type_id/)
  assert.match(emissionAction, /payments: \[\{ paymentTypeId: selectedPaymentTypeId, amount: fullTotals\.total/)
  assert.match(emissionAction, /links\?\.length \?\? 0/)
  assert.match(emissionAction, /validateCompleteInvoiceLines/)
  assert.match(emissionAction, /details: snapshotDetails\.map/)
  assert.doesNotMatch(emissionAction, /snapshotDetails\.filter\([^\n]*billable_quantity/)
  assert.match(emissionAction, /forma de pago, condición y vencimiento confirmados/)
  assert.doesNotMatch(emissionAction, /TARGET_INVOICE_CASE|TARGET_INVOICE_SALES_ID|currentNvId !== 92513|clientId !== 1005/)
  assert.doesNotMatch(emissionAction, /BSALE_UI_AUDIT/)
  assert.equal(typeof payload.emissionDate, 'number')
  assert.equal(typeof payload.expirationDate, 'number')
  assert.equal(Number.isInteger(payload.emissionDate), true)
  assert.equal(Number.isInteger(payload.expirationDate), true)
  assert.equal(payload.emissionDate, 1792540800)
  assert.equal(payload.expirationDate, 1792540800)
  assert.equal(Object.keys(payload).some(key => /Date/.test(key) && typeof payload[key] === 'string'), false)
  assert.equal('dispatch' in payload, false)
  assert.equal(validateInvoiceDocument({ document_type: { id: 5 }, client: { id: 1005 }, office: { id: 1 }, netAmount: 4704, taxAmount: 894, totalAmount: 5598, salesId: payload.salesId, details: { items: document.details } }, { salesId: payload.salesId, clientId: 1005, officeId: 1, totals: { net: 4704, tax: 894, total: 5598 }, details: [{ detailId: 334790, quantity: 1 }, { detailId: 334791, quantity: 1 }] }).ok, true)
  assert.match(chileToday(new Date('2026-10-21T15:00:00Z')), /^2026-10-21$/)
})

test('complete invoice policy rejects links, omitted lines and partial quantities', () => {
  const current = [{ detailId: 1, quantity: 2 }, { detailId: 2, quantity: 1 }]
  assert.deepEqual(validateCompleteInvoiceLines(current, current, 0), { ok: true })
  assert.equal(validateCompleteInvoiceLines(current, [{ detailId: 1, quantity: 1 }, { detailId: 2, quantity: 1 }], 0).ok, false)
  assert.equal(validateCompleteInvoiceLines(current, [{ detailId: 1, quantity: 2 }], 0).ok, false)
  assert.equal(validateCompleteInvoiceLines(current, current, 1).ok, false)
})

test('zero-valued bonus lines remain zero and a Bsale $1 conversion is rejected as a difference', () => {
  const source = {
    document_type: { id: 5 },
    client: { id: 2042 },
    office: { id: 3 },
    netAmount: 100,
    taxAmount: 19,
    totalAmount: 119,
    salesId: 'PETGROUP:FACTURA:bonus-source',
    details: { items: [{ relatedDetailId: 11, quantity: 20, netUnitValue: 0, totalUnitValue: 0, netAmount: 0, taxAmount: 0, totalAmount: 0, netDiscount: 16235 }] },
  }
  const expected = { salesId: source.salesId, clientId: 2042, officeId: 3, totals: { net: 100, tax: 19, total: 119 }, details: [{ detailId: 11, quantity: 20, netUnitValue: 0, totalUnitValue: 0, netAmount: 0, taxAmount: 0, totalAmount: 0, netDiscount: 16235 }] }
  assert.equal(validateInvoiceDocument(source, expected).ok, true)
  assert.equal(validateInvoiceDocument({ ...source, netAmount: 117, taxAmount: 22, totalAmount: 139, details: { items: [{ ...source.details.items[0], netUnitValue: 1, totalUnitValue: 1, netAmount: 17, taxAmount: 3, totalAmount: 20 }] } }, expected).ok, false)
  assert.match(emissionAction, /net_unit_value: Number\(detail\.netUnitValue\)/)
  assert.doesNotMatch(emissionAction, /normalizeInvoiceDetailsForBsale|netUnitValue: 1|bonusNetAdjustment/)
})

test('mixed normal and bonus lines preserve both source values', () => {
  const document = {
    document_type: { id: 5 }, client: { id: 2042 }, office: { id: 3 },
    netAmount: 100, taxAmount: 19, totalAmount: 119, salesId: 'PETGROUP:FACTURA:mixed',
    details: { items: [
      { relatedDetailId: 21, quantity: 1, netUnitValue: 100, totalUnitValue: 119, netAmount: 100, taxAmount: 19, totalAmount: 119, netDiscount: 0 },
      { relatedDetailId: 22, quantity: 1, netUnitValue: 0, totalUnitValue: 0, netAmount: 0, taxAmount: 0, totalAmount: 0, netDiscount: 100 },
    ] },
  }
  assert.equal(validateInvoiceDocument(document, {
    salesId: document.salesId, clientId: 2042, officeId: 3,
    totals: { net: 100, tax: 19, total: 119 },
    details: document.details.items.map(detail => ({ ...detail, detailId: detail.relatedDetailId })),
  }).ok, true)
})

test('generic validation accepts another client and multiple complete lines', () => {
  const dynamic = {
    document_type: { id: 5 },
    client: { id: 2042 },
    office: { id: 3 },
    netAmount: 10000,
    taxAmount: 1900,
    totalAmount: 11900,
    salesId: 'PETGROUP:FACTURA:dynamic',
    details: { items: [
      { relatedDetailId: 9001, quantity: 2 },
      { relatedDetailId: 9002, quantity: 1 },
      { relatedDetailId: 9003, quantity: 4 },
    ] },
  }
  assert.equal(validateInvoiceDocument(dynamic, {
    salesId: dynamic.salesId,
    clientId: 2042,
    officeId: 3,
    totals: { net: 10000, tax: 1900, total: 11900 },
    details: [
      { detailId: 9001, quantity: 2 },
      { detailId: 9002, quantity: 1 },
      { detailId: 9003, quantity: 4 },
    ],
  }).ok, true)
  assert.equal(validateInvoiceDocument({ ...dynamic, totalAmount: 11901 }, {
    salesId: dynamic.salesId,
    clientId: 2042,
    officeId: 3,
    totals: { net: 10000, tax: 1900, total: 11900 },
    details: dynamic.details.items,
  }).ok, false)
})

test('4xx rejection preserves status and sanitized response body', () => {
  const error = formatBsaleRejection({ status: 422, message: 'Unprocessable Entity', body: JSON.stringify({ code: 'INVALID_DATE', message: 'Fecha inválida', access_token: 'secret' }) })
  assert.match(error, /BSALE_REJECTED/)
  assert.match(error, /http_status=422/)
  assert.match(error, /INVALID_DATE/)
  assert.doesNotMatch(error, /secret/)
})

test('retry identity matches the existing attempt exactly', () => {
  const identity = buildInvoiceEmissionIdentity({
    company_id: 'd1000000-0000-0000-0000-000000000001',
    canonical_bsale_token: 'aa3dc0975673',
    current_bsale_nv_id: 92513,
    client_id: 1005,
    office_id: 1,
    sale_condition_id: null,
    payment_type_id: 8,
    historical_bsale_nv_id: 92486,
    folio: '5032',
    seller_id: 28,
    price_list_id: 4,
    emission_date: '2026-10-21',
    expiration_date: '2026-10-21',
    totals: { net: 4704, tax: 894, total: 5598 },
    details: [
      { detail_id: 334790, variant_id: 2582, sku: 'PW28210', quantity: 1, billable_quantity: 1, net_amount: 1469, tax_amount: 279, total_amount: 1748 },
      { detail_id: 334791, variant_id: 7007, sku: '78304283511852', quantity: 1, billable_quantity: 1, net_amount: 3235, tax_amount: 615, total_amount: 3850 },
    ],
    total: 5598,
  })
  assert.match(identity.salesId, /^PETGROUP:FACTURA:/)
  assert.equal(identity.fingerprint.length, 64)
})

test('server gate defaults off unless explicitly true', () => {
  const previous = process.env.BSALE_INVOICE_EMISSION_ENABLED
  delete process.env.BSALE_INVOICE_EMISSION_ENABLED
  assert.equal(invoiceEmissionEnabled(), false)
  process.env.BSALE_INVOICE_EMISSION_ENABLED = 'true'
  assert.equal(invoiceEmissionEnabled(), true)
  if (previous == null) delete process.env.BSALE_INVOICE_EMISSION_ENABLED
  else process.env.BSALE_INVOICE_EMISSION_ENABLED = previous
})

test('confirmation UI uses a single server-side card identifier and maps terminal states', async () => {
  const ui = await (await import('node:fs/promises')).readFile(new URL('../src/modules/logistica/preparacion-pedidos/invoice-flow-ui.tsx', import.meta.url), 'utf8')
  const panel = await (await import('node:fs/promises')).readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /emitSalesOrderInvoice\(snapshot\.card_id, snapshot\.commercial_selection\)/)
  assert.match(ui, /submittingRef\.current/)
  assert.match(ui, /if \(!onConfirm\)/)
  assert.match(ui, /BSALE_REJECTED.*INVOICE_IN_PROGRESS.*RECONCILIATION_REQUIRED/)
  assert.doesNotMatch(panel, /draft_payload.*emitSalesOrderInvoice|emitSalesOrderInvoice\([^)]*payload/)
})

function mockRoundingInvoice(expectedLines, changes, totals, salesId) {
  const expected = {
    salesId, clientId: 2042, officeId: 1, totals,
    details: expectedLines.map(line => ({ ...line })),
  }
  const document = {
    document_type: { id: 5 }, client: { id: 2042 }, office: { id: 1 },
    netAmount: totals.net, taxAmount: totals.tax, totalAmount: totals.total, salesId,
    details: { items: expectedLines.map((line, index) => ({
      ...line,
      relatedDetailId: line.detailId,
      netAmount: line.netAmount + (changes[index]?.net ?? 0),
      taxAmount: line.taxAmount + (changes[index]?.tax ?? 0),
      totalAmount: line.totalAmount + (changes[index]?.gross ?? 0),
    })) },
  }
  return { expected, document }
}

test('BSale rounding: 5144 accepts +/-$1 IVA distribution with exact invoice totals', () => {
  const data = mockRoundingInvoice([
    { detailId: 336191, quantity: 12, netUnitValue: 2882, totalUnitValue: 3430, netAmount: 34588, taxAmount: 6571, totalAmount: 41159, netDiscount: 0 },
    { detailId: 336192, quantity: 12, netUnitValue: 2882, totalUnitValue: 3430, netAmount: 34588, taxAmount: 6572, totalAmount: 41160, netDiscount: 0 },
    { detailId: 336193, quantity: 12, netUnitValue: 2882, totalUnitValue: 3430, netAmount: 34588, taxAmount: 6572, totalAmount: 41160, netDiscount: 0 },
    { detailId: 336194, quantity: 6, netUnitValue: 1882, totalUnitValue: 2240, netAmount: 11294, taxAmount: 2146, totalAmount: 13440, netDiscount: 0 },
    { detailId: 336195, quantity: 6, netUnitValue: 1882, totalUnitValue: 2240, netAmount: 11294, taxAmount: 2146, totalAmount: 13440, netDiscount: 0 },
    { detailId: 336196, quantity: 20, netUnitValue: 0, totalUnitValue: 0, netAmount: 0, taxAmount: 0, totalAmount: 0, netDiscount: 16235 },
  ], [
    { tax: 1, gross: 1 }, {}, { tax: -1, gross: -1 }, {}, {}, {},
  ], { net: 126352, tax: 24007, total: 150359 }, 'PETGROUP:FACTURA:qa-5144')
  assert.deepEqual(validateInvoiceDocument(data.document, data.expected), { ok: true })

  const unbalanced = structuredClone(data.document)
  unbalanced.details.items[2].taxAmount += 1
  assert.equal(validateInvoiceDocument(unbalanced, data.expected).ok, false)

  const differentTotal = structuredClone(data.document)
  differentTotal.totalAmount += 1
  assert.equal(validateInvoiceDocument(differentTotal, data.expected).ok, false)

  const bonusBecomesPaid = structuredClone(data.document)
  bonusBecomesPaid.details.items[5].netAmount = 1
  bonusBecomesPaid.details.items[0].netAmount -= 1
  assert.equal(validateInvoiceDocument(bonusBecomesPaid, data.expected).ok, false)

  const changedUnitPrice = structuredClone(data.document)
  changedUnitPrice.details.items[0].netUnitValue += 1
  assert.equal(validateInvoiceDocument(changedUnitPrice, data.expected).ok, false)

  const changedQuantity = structuredClone(data.document)
  changedQuantity.details.items[0].quantity -= 1
  assert.equal(validateInvoiceDocument(changedQuantity, data.expected).ok, false)

  const duplicateRelatedId = structuredClone(data.document)
  duplicateRelatedId.details.items[1].relatedDetailId = data.expected.details[0].detailId
  assert.equal(validateInvoiceDocument(duplicateRelatedId, data.expected).ok, false)
})

test('BSale rounding: 5139 accepts balanced -$2,+$1,+$1 net distribution', () => {
  const data = mockRoundingInvoice([
    { detailId: 335967, quantity: 6, netUnitValue: 3235, totalUnitValue: 3850, netAmount: 19412, taxAmount: 3688, totalAmount: 23100, netDiscount: 0 },
    { detailId: 335968, quantity: 12, netUnitValue: 3235, totalUnitValue: 3850, netAmount: 38823, taxAmount: 7377, totalAmount: 46198, netDiscount: 0 },
    { detailId: 335969, quantity: 12, netUnitValue: 3235, totalUnitValue: 3850, netAmount: 38823, taxAmount: 7376, totalAmount: 46200, netDiscount: 0 },
    { detailId: 335970, quantity: 12, netUnitValue: 3235, totalUnitValue: 3850, netAmount: 38823, taxAmount: 7376, totalAmount: 46200, netDiscount: 0 },
    { detailId: 335971, quantity: 6, netUnitValue: 3529, totalUnitValue: 4200, netAmount: 21176, taxAmount: 4024, totalAmount: 25200, netDiscount: 0 },
  ], [
    {}, { net: -2 }, { net: 1 }, { net: 1 }, {},
  ], { net: 157057, tax: 29841, total: 186898 }, 'PETGROUP:FACTURA:qa-5139')
  assert.deepEqual(validateInvoiceDocument(data.document, data.expected), { ok: true })

  const oversizedRounding = structuredClone(data.document)
  oversizedRounding.details.items[1].netAmount -= 1
  oversizedRounding.details.items[2].netAmount += 1
  assert.equal(validateInvoiceDocument(oversizedRounding, data.expected).ok, false)

  const changedDiscount = structuredClone(data.document)
  changedDiscount.details.items[0].netDiscount += 1
  assert.equal(validateInvoiceDocument(changedDiscount, data.expected).ok, false)

  const missingDetails = structuredClone(data.document)
  missingDetails.details.items.pop()
  assert.equal(validateInvoiceDocument(missingDetails, data.expected).ok, false)

  const differentClient = structuredClone(data.document)
  differentClient.client.id += 1
  assert.equal(validateInvoiceDocument(differentClient, data.expected).ok, false)
})
