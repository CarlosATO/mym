import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCobranzaPaymentOverlay, buildCobranzaClients, cobranzaPriority, daysOverdue } from '../src/modules/analisis-comercial/lib/cobranza-metrics.ts'

const document = (overrides = {}) => ({
  document_id: 1,
  emission_date: '2026-08-01',
  folio: 101,
  document_type_name: 'Factura',
  total_amount: '100000',
  net_amount: null,
  tax_amount: null,
  expiration_date: '2026-09-01',
  pending_amount: '100000',
  client_id: 10,
  client_code: '76.123.456-7',
  client_name: 'Cliente Demo',
  url_pdf: null,
  overdue: true,
  events: [],
  ...overrides,
})

test('aggregates documents by client without losing overdue totals', () => {
  const clients = buildCobranzaClients([
    document(),
    document({ document_id: 2, pending_amount: '50000', overdue: false, expiration_date: '2026-10-06' }),
  ], '2026-10-06')
  assert.equal(clients.length, 1)
  assert.equal(clients[0].totalAmount, 150000)
  assert.equal(clients[0].overdueAmount, 100000)
  assert.equal(clients[0].pendingDocuments, 2)
})

test('uses deterministic priority thresholds from amount and age', () => {
  assert.equal(cobranzaPriority(1_000_000, 0), 'Alta')
  assert.equal(cobranzaPriority(0, 30), 'Alta')
  assert.equal(cobranzaPriority(250_000, 0), 'Media')
  assert.equal(cobranzaPriority(0, 15), 'Media')
  assert.equal(cobranzaPriority(249_999, 14), 'Normal')
})

test('does not count the cutoff date as overdue days', () => {
  assert.equal(daysOverdue('2026-10-06', '2026-10-06'), 0)
  assert.equal(daysOverdue('2026-10-05', '2026-10-06'), 1)
})

test('overlay confirmado posterior al snapshot elimina factura con saldo cero', () => {
  const documents = [document({ document_id: 91576, pending_amount: '113940' }), document({ document_id: 24270, pending_amount: '115518' })]
  const current = applyCobranzaPaymentOverlay(documents, [{ documentId: 91576, pendingAmount: 0 }])
  assert.deepEqual(current.map(item => item.document_id), [24270])
  assert.equal(buildCobranzaClients(current, '2026-10-06')[0].totalAmount, 115518)
})

test('overlay confirmado parcial conserva documento con saldo posterior', () => {
  const current = applyCobranzaPaymentOverlay([document({ document_id: 91576, pending_amount: '200000' })], [{ documentId: 91576, pendingAmount: 100000 }])
  assert.equal(current[0].pending_amount, '100000')
})

test('overlay es determinista y no modifica el snapshot original', () => {
  const snapshot = [document({ document_id: 91576, pending_amount: '113940' })]
  const current = applyCobranzaPaymentOverlay(snapshot, [{ documentId: 91576, pendingAmount: 0 }])
  assert.equal(snapshot[0].pending_amount, '113940')
  assert.equal(current.length, 0)
  assert.equal(applyCobranzaPaymentOverlay(snapshot, []).length, 1)
})
