import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInvoiceDraftPayload,
  calculateInvoiceExpirationDate,
} from '../src/modules/logistica/preparacion-pedidos/invoice-commercial.ts'

test('sale condition calculates expiration without changing payment type', () => {
  const condition = { bsale_id: 6, name: 'CREDITO A 30 DIAS', time_condition: 1, time_unity: 1 }
  assert.equal(calculateInvoiceExpirationDate('2026-10-21', condition), '2026-11-21')
})

test('payment and sale condition remain independent in the future payload', () => {
  const payload = buildInvoiceDraftPayload({
    payment_type_id: 8,
    sale_condition_id: 14,
    expiration_date: '2026-11-02',
  }, 5598, '2026-10-21')

  assert.deepEqual(payload, {
    payments: [{ paymentTypeId: 8, amount: 5598, recordDate: 1792540800 }],
    expirationDate: 1793577600,
  })
  assert.equal(payload?.payments[0].paymentTypeId, 8)
})

test('missing payment cannot produce a draft payload', () => {
  assert.equal(buildInvoiceDraftPayload({
    payment_type_id: null,
    sale_condition_id: 10,
    expiration_date: '2026-10-21',
  }, 5598, '2026-10-21'), null)
})

test('missing sale condition defaults expiration to the emission date for non-credit payment', () => {
  assert.equal(calculateInvoiceExpirationDate('2026-10-21', null), '2026-10-21')
})
