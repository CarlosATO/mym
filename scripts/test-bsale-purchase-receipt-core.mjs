import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPurchaseReceiptNote, buildPurchaseReceiptPayload, numericDocumentNumber, sendPurchaseReceipt, verifyPurchaseReceipt } from '../src/lib/integraciones/bsale-purchase-receipt-core.ts'

const base = { documentType: 'FA', documentNumber: '4545', officeId: 1, receiptNumber: 'REC-000001', poCorrelative: 'OC-2026-000031', serviceVariantId: 4554 }
test('note preserves identifiers and truncates unicode observation to 100 chars', () => {
  for (const text of ['', 'corto', 'x'.repeat(100), 'á'.repeat(200)]) {
    const note = buildPurchaseReceiptNote(base.receiptNumber, base.poCorrelative, text)
    assert.ok(note.length <= 100)
    assert.ok(note.startsWith('REC-000001 | OC-2026-000031'))
  }
})
test('payload maps FA/GD, accepted conditions, weighted product and one service line', () => {
  const payload = buildPurchaseReceiptPayload({ ...base, lines: [
    { itemType: 'PRODUCT', condition: 'CONFORME', variantId: 10, quantity: 10, netAmount: 50000 },
    { itemType: 'PRODUCT', condition: 'DANADO', variantId: 10, quantity: 2, netAmount: 16000 },
    { itemType: 'PRODUCT', condition: 'RECHAZADO', variantId: 11, quantity: 3, netAmount: 3000 },
    { itemType: 'SERVICE', condition: 'CONFORME', quantity: 1, netAmount: 50000 },
    { itemType: 'SERVICE', condition: 'DANADO', quantity: 1, netAmount: 30000 },
  ] })
  assert.equal(payload.document, 'FACTURA')
  assert.deepEqual(payload.details, [{ variantId: 10, quantity: 12, cost: 5500 }, { variantId: 4554, quantity: 1, cost: 80000 }])
  assert.equal(buildPurchaseReceiptPayload({ ...base, documentType: 'GD', lines: [{ itemType: 'SERVICE', condition: 'CONFORME', quantity: 1, netAmount: 1 }] }).document, 'GUÍA')
})
test('invalid document number and missing product variant are rejected', () => {
  assert.throws(() => numericDocumentNumber('45-A'))
  assert.throws(() => buildPurchaseReceiptPayload({ ...base, lines: [{ itemType: 'PRODUCT', condition: 'CONFORME', quantity: 1, netAmount: 1 }] }))
})
test('remote timeout is reconciliation-required and definitive 4xx is failed', async () => {
  const snapshot = buildPurchaseReceiptPayload({ ...base, lines: [{ itemType: 'SERVICE', condition: 'CONFORME', quantity: 1, netAmount: 10 }] })
  const timeout = await sendPurchaseReceipt(snapshot, { createReception: async () => { const e = new Error('timeout'); e.status = 504; throw e }, getReception: async () => ({}), getDetails: async () => [], findReceptions: async () => [] })
  assert.equal(timeout.status, 'RECONCILIATION_REQUIRED')
  const bad = await sendPurchaseReceipt(snapshot, { createReception: async () => { const e = new Error('bad payload'); e.status = 422; throw e }, getReception: async () => ({}), getDetails: async () => [], findReceptions: async () => [] })
  assert.equal(bad.status, 'FAILED')
})
test('verification rejects a remote payload with different details', () => {
  const snapshot = buildPurchaseReceiptPayload({ ...base, lines: [{ itemType: 'SERVICE', condition: 'CONFORME', quantity: 1, netAmount: 10 }] })
  assert.equal(verifyPurchaseReceipt(snapshot, { id: 7, office: { id: 1 }, document: 'FACTURA', documentNumber: 4545, note: snapshot.note }, [{ variant: { id: 4554 }, quantity: 2, cost: 10 }], 7), false)
})
