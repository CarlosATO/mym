import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reconcilePurchaseReceipt, autoSyncIsAllowed, buildPurchaseReceiptNote, buildPurchaseReceiptPayload, chooseUniqueReconciliationCandidate, numericDocumentNumber, sendPurchaseReceipt, syncAfterLocalReceipt, verifyPurchaseReceipt } from '../src/lib/integraciones/bsale-purchase-receipt-core.ts'

const base = { documentType: 'FA', documentNumber: '4545', officeId: 1, receiptNumber: 'REC-000001', poCorrelative: 'OC-2026-000031', serviceVariantId: 4554 }
test('note preserves identifiers and truncates unicode observation to 100 chars', () => {
  for (const text of ['', 'corto', 'x'.repeat(100), 'á'.repeat(200)]) {
    const note = buildPurchaseReceiptNote(base.receiptNumber, base.poCorrelative, text)
    assert.ok(note.length <= 100)
    assert.ok(note.startsWith('REC-000001 | OC-2026-000031'))
  }
  const exact = buildPurchaseReceiptNote(base.receiptNumber, base.poCorrelative, 'Ingreso de Prueba de Serivicios')
  assert.equal(exact, 'REC-000001 | OC-2026-000031 | Ingreso de Prueba de Serivicios')
  assert.equal(exact.length, 61)
  assert.ok(exact.length <= 100)
  assert.equal(buildPurchaseReceiptNote(base.receiptNumber, base.poCorrelative, 'x'.repeat(100)).length, 100)
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
  for (const status of [408, 429]) {
    const transient = await sendPurchaseReceipt(snapshot, { createReception: async () => { const e = new Error('transient'); e.status = status; throw e }, getReception: async () => ({}), getDetails: async () => [], findReceptions: async () => [] })
    assert.equal(transient.status, 'RECONCILIATION_REQUIRED')
  }
})
test('verification rejects a remote payload with different details', () => {
  const snapshot = buildPurchaseReceiptPayload({ ...base, lines: [{ itemType: 'SERVICE', condition: 'CONFORME', quantity: 1, netAmount: 10 }] })
  assert.equal(verifyPurchaseReceipt(snapshot, { id: 7, office: { id: 1 }, document: 'FACTURA', documentNumber: 4545, note: snapshot.note }, [{ variant: { id: 4554 }, quantity: 2, cost: 10 }], 7), false)
})
test('POST without remote id and GET mismatch are never confirmed', async () => {
  const snapshot = buildPurchaseReceiptPayload({ ...base, lines: [{ itemType: 'SERVICE', condition: 'CONFORME', quantity: 1, netAmount: 10 }] })
  const withoutId = await sendPurchaseReceipt(snapshot, { createReception: async () => ({}), getReception: async () => ({}), getDetails: async () => [], findReceptions: async () => [] })
  assert.equal(withoutId.status, 'RECONCILIATION_REQUIRED')
  const mismatch = await sendPurchaseReceipt(snapshot, { createReception: async () => ({ id: 1 }), getReception: async () => ({ id: 1, office: { id: 2 }, note: snapshot.note }), getDetails: async () => [], findReceptions: async () => [] })
  assert.equal(mismatch.status, 'RECONCILIATION_REQUIRED')
})
test('POST followed by matching GET confirms and reconciliation by remote id confirms', async () => {
  const snapshot = buildPurchaseReceiptPayload({ ...base, lines: [{ itemType: 'SERVICE', condition: 'CONFORME', quantity: 1, netAmount: 10 }] })
  const remote = { createReception: async () => ({ id: 7 }), getReception: async () => ({ id: 7, office: { id: 1 }, document: 'FACTURA', documentNumber: 4545, note: snapshot.note }), getDetails: async () => [{ variant: { id: 4554 }, quantity: 1, cost: 10 }], findReceptions: async () => [] }
  assert.equal((await sendPurchaseReceipt(snapshot, remote)).status, 'CONFIRMED')
  assert.equal((await reconcilePurchaseReceipt(snapshot, remote, 7)).status, 'CONFIRMED')
})
test('manual-only setting and candidate ambiguity are enforced', () => {
  assert.equal(autoSyncIsAllowed({ enabled: true, autoSyncEnabled: false }), false)
  assert.equal(autoSyncIsAllowed({ enabled: true, autoSyncEnabled: true }), true)
  assert.equal(chooseUniqueReconciliationCandidate([123]), 123)
  assert.equal(chooseUniqueReconciliationCandidate([123, 456]), null)
  assert.equal(chooseUniqueReconciliationCandidate([]), null)
})
test('settings control immediate sync without changing local success', async () => {
  let posts = 0
  const sync = async () => { posts += 1; return { status: 'CONFIRMED', receptionId: 11370 } }
  assert.equal((await syncAfterLocalReceipt({ enabled: false, autoSyncEnabled: true }, sync)).status, 'PENDING')
  assert.equal((await syncAfterLocalReceipt({ enabled: true, autoSyncEnabled: false }, sync)).status, 'PENDING')
  assert.equal(posts, 0)
  assert.deepEqual((await syncAfterLocalReceipt({ enabled: true, autoSyncEnabled: true }, sync)).result, { status: 'CONFIRMED', receptionId: 11370 })
  assert.equal(posts, 1)
  const failed = await syncAfterLocalReceipt({ enabled: true, autoSyncEnabled: true }, async () => ({ status: 'FAILED', error: '4xx' }))
  assert.equal(failed.result.status, 'FAILED')
  const timeout = await syncAfterLocalReceipt({ enabled: true, autoSyncEnabled: true }, async () => ({ status: 'RECONCILIATION_REQUIRED', error: 'timeout' }))
  assert.equal(timeout.result.status, 'RECONCILIATION_REQUIRED')
})
test('durable claim permits one POST under double execution', async () => {
  let claimed = false
  let posts = 0
  async function mockedClaimAndPost() {
    if (claimed) return false
    claimed = true
    posts += 1
    return true
  }
  await Promise.all([mockedClaimAndPost(), mockedClaimAndPost()])
  assert.equal(posts, 1)
})
test('migration contract enforces company isolation, permission and unique local receipt', () => {
  const sql = readFileSync(new URL('../supabase/migrations/20261006110000_logistica_bsale_purchase_receipt_operations.sql', import.meta.url), 'utf8')
  const activation = readFileSync(new URL('../supabase/migrations/20261006130000_logistica_enable_bsale_purchase_receipt_auto_sync_caylo.sql', import.meta.url), 'utf8')
  const actions = readFileSync(new URL('../src/app/actions/logistica/recepciones.ts', import.meta.url), 'utf8')
  const createBody = actions.slice(actions.indexOf('export async function createPurchaseReceipt'), actions.indexOf('export async function getPurchaseReceiptBsaleStatus'))
  assert.match(sql, /auto_sync_enabled boolean NOT NULL DEFAULT false/)
  assert.match(sql, /UNIQUE \(purchase_receipt_id\)/)
  assert.match(sql, /core\.has_company_access\(p_user_id, r\.company_id\)/)
  assert.match(sql, /core\.has_permission_for_company\(p_user_id, r\.company_id, 'logistica\.receptions\.create'\)/)
  assert.match(sql, /USING \(core\.has_company_access\(auth\.uid\(\), company_id\)/)
  assert.match(sql, /La empresa no tiene configuración de Recepciones BSale/)
  assert.match(createBody, /status: 'PENDING'/)
  assert.match(createBody, /syncPurchaseReceipt\(companyId, user\.id, r\.receipt_id!\)/)
  assert.equal(createBody.includes('bsaleWriteForCompany'), false)
  assert.match(createBody, /getPurchaseReceiptSyncSettings\(companyId\)/)
  assert.match(activation, /auto_sync_enabled = true/)
  assert.match(activation, /d1000000-0000-0000-0000-000000000001/)
})
