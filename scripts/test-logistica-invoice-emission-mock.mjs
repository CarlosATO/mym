import assert from 'node:assert/strict'
import test from 'node:test'
import { createControlledInvoiceCoordinator } from '../src/lib/integraciones/invoice-emission-coordinator.ts'
import { buildInvoiceEmissionPayload, chileToday, invoiceEmissionEnabled, validateTargetInvoiceDocument } from '../src/lib/integraciones/invoice-emission-contract.ts'

const payload = buildInvoiceEmissionPayload({
  officeId: 1,
  priceListId: 4,
  emissionDate: '2026-10-21',
  expirationDate: '2026-10-21',
  clientId: 1005,
  sellerId: 28,
  salesId: 'PETGROUP:FACTURA:demo-5032',
  details: [{ detailId: 334790, quantity: 1 }, { detailId: 334791, quantity: 1 }],
})

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
  assert.equal('dispatch' in payload, false)
  assert.equal(validateTargetInvoiceDocument({ document_type: { id: 5 }, client: { id: 1005 }, office: { id: 1 }, netAmount: 4704, taxAmount: 894, totalAmount: 5598, salesId: payload.salesId, details: { items: document.details } }, payload.salesId).ok, true)
  assert.match(chileToday(new Date('2026-10-21T15:00:00Z')), /^2026-10-21$/)
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
