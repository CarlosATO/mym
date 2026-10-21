import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createControlledInvoiceCoordinator } from '../src/lib/integraciones/invoice-emission-coordinator.ts'
import { buildInvoiceEmissionIdentity, buildInvoiceEmissionPayload, chileDateToBsaleEpoch, chileToday, formatBsaleRejection, invoiceEmissionEnabled, TARGET_INVOICE_SALES_ID, validateTargetInvoiceDocument } from '../src/lib/integraciones/invoice-emission-contract.ts'

const payload = buildInvoiceEmissionPayload({
  officeId: 1,
  priceListId: 4,
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

test('flag off blocks emission before transport', async () => {
  let posts = 0
  const coordinator = createControlledInvoiceCoordinator({ post: async () => { posts += 1; return document } })
  const result = await coordinator.emit({ salesId: payload.salesId, fingerprint: 'fp', payload }, false)
  assert.equal(result.reason, 'EMISSION_DISABLED')
  assert.equal(posts, 0)
})

test('double click and concurrent requests produce one mock POST', async () => {
  let posts = 0
  const coordinator = createControlledInvoiceCoordinator({ post: async body => { posts += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { ...document, salesId: body.salesId } } })
  const input = { salesId: payload.salesId, fingerprint: 'fp', payload }
  const results = await Promise.all([coordinator.emit(input, true), coordinator.emit(input, true)])
  assert.equal(posts, 1)
  assert.equal(results[0].status, 'CONFIRMED')
  assert.equal(results[1].status, 'CONFIRMED')
})

test('timeout remains UNKNOWN and later reconciliation confirms without a second POST', async () => {
  let posts = 0
  const coordinator = createControlledInvoiceCoordinator({ post: async () => { posts += 1; throw new Error('timeout') } })
  const input = { salesId: payload.salesId, fingerprint: 'fp', payload }
  assert.equal((await coordinator.emit(input, true)).status, 'UNKNOWN')
  assert.equal(coordinator.reconcile(payload.salesId, document).status, 'CONFIRMED')
  assert.equal(posts, 1)
})

test('fingerprint changes and an existing confirmed invoice cannot create a second one', async () => {
  let posts = 0
  const coordinator = createControlledInvoiceCoordinator({ post: async () => { posts += 1; return document } })
  const input = { salesId: payload.salesId, fingerprint: 'fp', payload }
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
  assert.match(emissionAction, /payments: \[\{ paymentTypeId: configuredPaymentTypeId, amount: 5598/)
  assert.match(emissionAction, /No es posible facturar porque el cliente no tiene una forma de pago configurada\./)
  assert.doesNotMatch(emissionAction, /BSALE_UI_AUDIT/)
  assert.equal(typeof payload.emissionDate, 'number')
  assert.equal(typeof payload.expirationDate, 'number')
  assert.equal(Number.isInteger(payload.emissionDate), true)
  assert.equal(Number.isInteger(payload.expirationDate), true)
  assert.equal(payload.emissionDate, 1792540800)
  assert.equal(payload.expirationDate, 1792540800)
  assert.equal(Object.keys(payload).some(key => /Date/.test(key) && typeof payload[key] === 'string'), false)
  assert.equal('dispatch' in payload, false)
  assert.equal(validateTargetInvoiceDocument({ document_type: { id: 5 }, client: { id: 1005 }, office: { id: 1 }, netAmount: 4704, taxAmount: 894, totalAmount: 5598, salesId: payload.salesId, details: { items: document.details } }, payload.salesId).ok, true)
  assert.match(chileToday(new Date('2026-10-21T15:00:00Z')), /^2026-10-21$/)
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
  assert.equal(identity.salesId, TARGET_INVOICE_SALES_ID)
  assert.equal(identity.fingerprint, 'c6bb8efd34562b54de2e1ebb5d0e732efdffebddc9917d291a71fc1e2c5123d6')
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
  assert.match(panel, /emitSalesOrderInvoice\(snapshot\.card_id\)/)
  assert.match(ui, /submittingRef\.current/)
  assert.match(ui, /if \(!onConfirm\)/)
  assert.match(ui, /BSALE_REJECTED.*INVOICE_IN_PROGRESS.*RECONCILIATION_REQUIRED/)
  assert.doesNotMatch(panel, /draft_payload.*emitSalesOrderInvoice|emitSalesOrderInvoice\([^)]*payload/)
})
