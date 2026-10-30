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

test('los valores monetarios oficiales de Bsale no se comparan por línea', () => {
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
  assert.equal(validateInvoiceDocument({ ...source, details: { items: [{ ...source.details.items[0], netUnitValue: 1, totalUnitValue: 1, netAmount: 17, taxAmount: 3, totalAmount: 20 }] } }, expected).ok, true)
  assert.equal(validateInvoiceDocument({ ...source, totalAmount: 125 }, expected).ok, false)
  assert.match(emissionAction, /net_unit_value: Number\(detail\.netUnitValue\)/)
  assert.doesNotMatch(emissionAction, /normalizeInvoiceDetailsForBsale|netUnitValue: 1|bonusNetAdjustment/)
})

test('factura Bsale 24869 de NV 5148 acepta redistribución neta compensada con bruto y totales iguales', () => {
  const stableExpectedDetails = [
    ...Array.from({ length: 12 }, (_, index) => ({ detailId: 514803 + index, quantity: 5, netUnitValue: 18000, netAmount: 18000, taxAmount: 3420, totalUnitValue: 4284, totalAmount: 21420, netDiscount: 0 })),
    { detailId: 514815, quantity: 8, netUnitValue: 16729, netAmount: 16729, taxAmount: 3178, totalUnitValue: 19907, totalAmount: 19907, netDiscount: 0 },
  ]
  const expected = {
    salesId: 'PETGROUP:FACTURA:5148', clientId: 2042, officeId: 3,
    totals: { net: 250618, tax: 47617, total: 298235 },
    details: [
      { detailId: 514801, quantity: 1, netUnitValue: 16419, netAmount: 16419, taxAmount: 3120, totalUnitValue: 19539, totalAmount: 19539, netDiscount: 9122 },
      { detailId: 514802, quantity: 1, netUnitValue: 1470, netAmount: 1470, taxAmount: 279, totalUnitValue: 1749, totalAmount: 1749, netDiscount: 489 },
      ...stableExpectedDetails,
    ],
  }
  const document = {
    document_type: { id: 5 }, client: { id: 2042 }, office: { id: 3 }, salesId: expected.salesId,
    netAmount: 250618, taxAmount: 47617, totalAmount: 298235,
    details: { items: [
      { relatedDetailId: 514801, quantity: 1, netUnitValue: 16420, netAmount: 16420, taxAmount: 3119, totalUnitValue: 19539, totalAmount: 19539, netDiscount: 9121 },
      { relatedDetailId: 514802, quantity: 1, netUnitValue: 1469, netAmount: 1469, taxAmount: 280, totalUnitValue: 1749, totalAmount: 1749, netDiscount: 490 },
      ...stableExpectedDetails.map(({ detailId, quantity, netUnitValue, netAmount, taxAmount, totalUnitValue, totalAmount, netDiscount }) => ({ relatedDetailId: detailId, quantity, netUnitValue, netAmount, taxAmount, totalUnitValue, totalAmount, netDiscount })),
    ] },
  }
  assert.deepEqual(validateInvoiceDocument(document, expected), { ok: true })
})

test('cambio de precio de línea no bloquea porque Bsale es la fuente de verdad', () => {
  const expected = {
    salesId: 'invoice-price-change', clientId: 1, officeId: 1, totals: { net: 100, tax: 19, total: 119 },
    details: [{ detailId: 1, quantity: 1, netUnitValue: 100, netAmount: 100, taxAmount: 19, totalUnitValue: 119, totalAmount: 119, netDiscount: 0 }],
  }
  const document = {
    document_type: { id: 5 }, client: { id: 1 }, office: { id: 1 }, salesId: expected.salesId,
    netAmount: 101, taxAmount: 18, totalAmount: 119,
    details: { items: [{ relatedDetailId: 1, quantity: 1, netUnitValue: 101, netAmount: 101, taxAmount: 18, totalUnitValue: 119, totalAmount: 119, netDiscount: 0 }] },
  }
  assert.equal(validateInvoiceDocument(document, expected).ok, true)
})

test('totales fuera de rango y líneas no exactas se rechazan', () => {
  const expected = {
    salesId: 'invoice-controls', clientId: 1, officeId: 1, totals: { net: 250, tax: 48, total: 298 },
    details: [
      { detailId: 1, quantity: 1, netUnitValue: 100, netAmount: 100, taxAmount: 19, totalUnitValue: 119, totalAmount: 119, netDiscount: 0 },
      { detailId: 2, quantity: 1, netUnitValue: 150, netAmount: 150, taxAmount: 29, totalUnitValue: 179, totalAmount: 179, netDiscount: 0 },
    ],
  }
  const base = {
    document_type: { id: 5 }, client: { id: 1 }, office: { id: 1 }, salesId: expected.salesId,
    netAmount: 250, taxAmount: 48, totalAmount: 298,
    details: { items: [
      { relatedDetailId: 1, quantity: 1, netUnitValue: 101, netAmount: 101, taxAmount: 18, totalUnitValue: 119, totalAmount: 119, netDiscount: 0 },
      { relatedDetailId: 2, quantity: 1, netUnitValue: 150, netAmount: 150, taxAmount: 29, totalUnitValue: 179, totalAmount: 179, netDiscount: 0 },
    ] },
  }
  assert.equal(validateInvoiceDocument(base, expected).ok, true)
  assert.equal(validateInvoiceDocument({ ...base, totalAmount: 304 }, expected).reason, 'TOTALS_MISMATCH')
  assert.equal(validateInvoiceDocument({ ...base, details: { items: base.details.items.map(item => ({ ...item, quantity: 2 })) } }, expected).reason, 'RELATED_DETAIL_ID_NOT_PROVABLE')
  assert.equal(validateInvoiceDocument({ ...base, details: { items: [{ ...base.details.items[0], relatedDetailId: 1 }, { ...base.details.items[1], relatedDetailId: 1 }] } }, expected).reason, 'RELATED_DETAIL_ID_NOT_PROVABLE')
  assert.equal(validateInvoiceDocument({ ...base, details: { items: [{ ...base.details.items[0], relatedDetailId: 99 }, base.details.items[1]] } }, expected).reason, 'RELATED_DETAIL_ID_NOT_PROVABLE')
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
  const acceptedDifference = validateInvoiceDocument({ ...dynamic, totalAmount: 11901 }, {
    salesId: dynamic.salesId,
    clientId: 2042,
    officeId: 3,
    totals: { net: 10000, tax: 1900, total: 11900 },
    details: dynamic.details.items.map(detail => ({ detailId: detail.relatedDetailId, quantity: detail.quantity })),
  })
  assert.deepEqual(acceptedDifference, { ok: true, audit: { code: 'INVOICE_TOTAL_DIFFERENCE_ACCEPTED', totalDifference: 1, limit: 5 } })
  const negativeBoundary = validateInvoiceDocument({ ...dynamic, totalAmount: 11895 }, {
    salesId: dynamic.salesId,
    clientId: 2042,
    officeId: 3,
    totals: { net: 10000, tax: 1900, total: 11900 },
    details: dynamic.details.items.map(detail => ({ detailId: detail.relatedDetailId, quantity: detail.quantity })),
  })
  assert.deepEqual(negativeBoundary, { ok: true, audit: { code: 'INVOICE_TOTAL_DIFFERENCE_ACCEPTED', totalDifference: -5, limit: 5 } })
  assert.equal(validateInvoiceDocument({ ...dynamic, totalAmount: 11906 }, {
    salesId: dynamic.salesId,
    clientId: 2042,
    officeId: 3,
    totals: { net: 10000, tax: 1900, total: 11900 },
    details: dynamic.details.items.map(detail => ({ detailId: detail.relatedDetailId, quantity: detail.quantity })),
  }).reason, 'TOTALS_MISMATCH')
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
