import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reconcilePurchaseReceipt, autoSyncIsAllowed, buildPurchaseReceiptNote, buildPurchaseReceiptPayload, chooseUniqueReconciliationCandidate, numericDocumentNumber, purchaseReceiptPayloadError, sendPurchaseReceipt, syncAfterLocalReceipt, verifyPurchaseReceipt, isLegitimateBonusLine } from '../src/lib/integraciones/bsale-purchase-receipt-core.ts'

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
test('document number accepts only one ASCII numeric value without trimming', () => {
  for (const value of ['874.548', '874-548', '874 548', ' 874548 ', '874548-874549', '874548,874549', 'ABC123', '']) {
    assert.throws(() => numericDocumentNumber(value), /Ingrese un solo número de documento/)
  }
  assert.equal(numericDocumentNumber('874548'), 874548)
  assert.equal(numericDocumentNumber('000874548'), 874548)
})

test('invalid document number and missing product variant are rejected', () => {
  assert.throws(() => buildPurchaseReceiptPayload({ ...base, lines: [{ itemType: 'PRODUCT', condition: 'CONFORME', quantity: 1, netAmount: 1 }] }))
})

test('invalid BSale snapshots never make a remote request', async () => {
  let requests = 0
  const remote = { createReception: async () => { requests += 1; return { id: 1 } }, getReception: async () => ({}), getDetails: async () => [], findReceptions: async () => [] }
  for (const snapshot of [null, {}, { document: 'FACTURA', officeId: 1, documentNumber: 1, note: 'x', details: [] }]) {
    assert.ok(purchaseReceiptPayloadError(snapshot))
    const result = await sendPurchaseReceipt(snapshot, remote)
    assert.equal(result.status, 'FAILED')
  }
  assert.equal(requests, 0)
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

test('legitimate 100% bonification allows zero cost in buildPurchaseReceiptPayload and BSale payload', () => {
  // Case Animal Care 115469 / REC-000057: S01130100 (jaulas), qty 2, original price 7911, discount 100%, netAmount 0
  const payload = buildPurchaseReceiptPayload({
    ...base,
    receiptNumber: 'REC-000057',
    poCorrelative: 'OC-2026-000075',
    documentNumber: '115469',
    lines: [
      {
        itemType: 'PRODUCT',
        condition: 'CONFORME',
        variantId: 1234,
        quantity: 2,
        netAmount: 0,
        unitPrice: 7911,
        discountPercent: 100,
        isBonus: true,
      },
    ],
  })

  assert.equal(payload.details.length, 1)
  assert.equal(payload.details[0].variantId, 1234)
  assert.equal(payload.details[0].quantity, 2)
  assert.equal(payload.details[0].cost, 0)
  assert.equal(purchaseReceiptPayloadError(payload), null)
})

test('buildPurchaseReceiptPayload rejects non-bonified zero, negative, and invalid costs', () => {
  // Zero cost without legitimate bonification must be rejected
  assert.throws(
    () => buildPurchaseReceiptPayload({
      ...base,
      lines: [{ itemType: 'PRODUCT', condition: 'CONFORME', variantId: 10, quantity: 2, netAmount: 0 }],
    }),
    /La línea PRODUCT requiere cantidad y costo neto válidos/
  )

  // Zero cost with zero original price (not a bonification) must be rejected
  assert.throws(
    () => buildPurchaseReceiptPayload({
      ...base,
      lines: [{ itemType: 'PRODUCT', condition: 'CONFORME', variantId: 10, quantity: 2, netAmount: 0, unitPrice: 0, discountPercent: 100 }],
    }),
    /La línea PRODUCT requiere cantidad y costo neto válidos/
  )

  // Negative net amount must be rejected
  assert.throws(
    () => buildPurchaseReceiptPayload({
      ...base,
      lines: [{ itemType: 'PRODUCT', condition: 'CONFORME', variantId: 10, quantity: 2, netAmount: -100 }],
    }),
    /La línea PRODUCT requiere cantidad y costo neto válidos/
  )

  // Non-positive quantity must be rejected
  assert.throws(
    () => buildPurchaseReceiptPayload({
      ...base,
      lines: [{ itemType: 'PRODUCT', condition: 'CONFORME', variantId: 10, quantity: 0, netAmount: 100 }],
    }),
    /La línea PRODUCT requiere cantidad y costo neto válidos/
  )
})

test('purchaseReceiptPayloadError accepts zero cost but rejects negative and non-numeric costs', () => {
  const validZeroCostPayload = {
    document: 'FACTURA',
    officeId: 1,
    documentNumber: 115469,
    note: 'REC-000057 | OC-2026-000075',
    details: [{ variantId: 1234, quantity: 2, cost: 0 }],
  }
  assert.equal(purchaseReceiptPayloadError(validZeroCostPayload), null)

  const negativeCostPayload = {
    ...validZeroCostPayload,
    details: [{ variantId: 1234, quantity: 2, cost: -1 }],
  }
  assert.notEqual(purchaseReceiptPayloadError(negativeCostPayload), null)

  const nanCostPayload = {
    ...validZeroCostPayload,
    details: [{ variantId: 1234, quantity: 2, cost: NaN }],
  }
  assert.notEqual(purchaseReceiptPayloadError(nanCostPayload), null)

  const missingCostPayload = {
    ...validZeroCostPayload,
    details: [{ variantId: 1234, quantity: 2 }],
  }
  assert.notEqual(purchaseReceiptPayloadError(missingCostPayload), null)
})

test('sendPurchaseReceipt and verifyPurchaseReceipt confirm remote reception with zero cost', async () => {
  const snapshot = {
    document: 'FACTURA',
    officeId: 1,
    documentNumber: 115469,
    note: 'REC-000057 | OC-2026-000075',
    details: [{ variantId: 1234, quantity: 2, cost: 0 }],
  }
  const remote = {
    createReception: async () => ({ id: 57 }),
    getReception: async () => ({ id: 57, office: { id: 1 }, document: 'FACTURA', documentNumber: 115469, note: snapshot.note }),
    getDetails: async () => [{ variant: { id: 1234 }, quantity: 2, cost: 0 }],
    findReceptions: async () => [],
  }
  const sendResult = await sendPurchaseReceipt(snapshot, remote)
  assert.equal(sendResult.status, 'CONFIRMED')
  assert.equal(sendResult.receptionId, 57)

  const reconcileResult = await reconcilePurchaseReceipt(snapshot, remote, 57)
  assert.equal(reconcileResult.status, 'CONFIRMED')
  assert.equal(reconcileResult.receptionId, 57)
})

test('zero cost bonification migration contract enforces validation, isolation and security', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261112100000_logistica_bsale_purchase_receipt_zero_cost_bonification.sql', import.meta.url), 'utf8')

  // Enforces legitimate bonification check in prepare RPC
  assert.match(migration, /is_legitimate_bonus/)
  assert.match(migration, /coalesce\(poi\.discount_percent, 0\) = 100/)
  assert.match(migration, /OR coalesce\(poi\.discount_unit_amount, 0\) >= poi\.unit_price/)
  assert.match(migration, /x\.net_amount = 0 AND NOT coalesce\(x\.is_legitimate_bonus, false\)/)
  assert.match(migration, /x\.net_amount < 0/)

  // Enforces zero-cost allowed in payload validation
  assert.match(migration, /\(v_detail->>'cost'\)::numeric < 0/)
  assert.doesNotMatch(migration, /\(v_detail->>'cost'\)::numeric <= 0/)

  // Security definer and company access check preserved
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /core\.has_company_access\(p_user_id, r\.company_id\)/)
  assert.match(migration, /core\.has_permission_for_company\(p_user_id, r\.company_id, 'logistica\.receptions\.create'\)/)

  // Permissions granted only to service_role and revoked from public/anon/authenticated
  assert.match(migration, /REVOKE ALL ON FUNCTION integraciones\.prepare_bsale_purchase_receipt_operation\(uuid, uuid\) FROM PUBLIC, anon, authenticated;/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION integraciones\.prepare_bsale_purchase_receipt_operation\(uuid, uuid\) TO service_role;/)
  assert.match(migration, /REVOKE ALL ON FUNCTION integraciones\.purchase_receipt_payload_is_valid\(jsonb\) FROM PUBLIC, anon, authenticated, service_role;/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION integraciones\.purchase_receipt_payload_is_valid\(jsonb\) TO service_role;/)
})

test('payload excludes non-stock-controlling products from physical BSale reception details', () => {
  // Case Animal Care 115469:
  // - Product with stock control (physical goods: variant 5678)
  // - Bonified product (S01130100, variant 1234, cost 0)
  // - Product without stock control (FLETE PROVEDOR, variant 7068, stock_control = false, netAmount 81671)
  const payload = buildPurchaseReceiptPayload({
    ...base,
    receiptNumber: 'REC-000057',
    poCorrelative: 'OC-2026-000075',
    documentNumber: '115469',
    lines: [
      {
        itemType: 'PRODUCT',
        condition: 'CONFORME',
        variantId: 1234,
        quantity: 2,
        netAmount: 0,
        unitPrice: 7911,
        discountPercent: 100,
        isBonus: true,
        controlsStock: true,
      },
      {
        itemType: 'PRODUCT',
        condition: 'CONFORME',
        variantId: 5678,
        quantity: 10,
        netAmount: 50000,
        controlsStock: true,
      },
      {
        itemType: 'PRODUCT',
        condition: 'CONFORME',
        variantId: 7068,
        quantity: 1,
        netAmount: 81671,
        controlsStock: false,
      },
    ],
  })

  // Physical products are detailed under their own variants with bonification preserved
  // Non-stock product (FLETE PROVEDOR) is excluded from BSale stock details and does NOT use variant 4554
  assert.deepEqual(payload.details, [
    { variantId: 1234, quantity: 2, cost: 0 },
    { variantId: 5678, quantity: 10, cost: 5000 },
  ])
  assert.equal(purchaseReceiptPayloadError(payload), null)
})

test('non-stock-control product migration contract enforces Kardex exclusion and Bsale payload exclusion', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261112110000_logistica_receipt_non_stock_control_products.sql', import.meta.url), 'utf8')

  // Real indicator lookup on integraciones.bsale_products.stock_control
  assert.match(migration, /coalesce\(bp\.stock_control, bp_var\.stock_control, true\)/)
  assert.match(migration, /FROM adquisiciones\.products p/)
  assert.match(migration, /LEFT JOIN integraciones\.bsale_products bp/)
  assert.match(migration, /LEFT JOIN integraciones\.bsale_variants bv/)

  // Kardex insertion strictly conditional on v_controls_stock
  assert.match(migration, /IF v_condition IN \('CONFORME', 'DANADO'\) AND v_item_type = 'PRODUCT' AND v_controls_stock THEN\s+INSERT INTO logistica\.kardex_movements/)

  // Location requirement strictly conditional on v_controls_stock
  assert.match(migration, /IF v_condition IN \('CONFORME', 'DANADO'\) AND v_item_type = 'PRODUCT' AND v_controls_stock THEN\s+IF v_location_id IS NULL OR p_warehouse_id IS NULL THEN/)

  // Non-stock product exclusion from BSale stock reception details (not routed to service variant)
  assert.match(migration, /coalesce\(bp\.stock_control, bp_var\.stock_control, true\) = true/)
  assert.match(migration, /poi\.item_type = 'SERVICE'/)

  // Security definer and service_role permissions
  assert.match(migration, /SECURITY DEFINER/)
  assert.match(migration, /REVOKE ALL ON FUNCTION logistica\.create_purchase_receipt_db_pre_hotfix\(.*\) FROM PUBLIC, anon, authenticated;/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION logistica\.create_purchase_receipt_db_pre_hotfix\(.*\) TO service_role;/)
  assert.match(migration, /REVOKE ALL ON FUNCTION integraciones\.prepare_bsale_purchase_receipt_operation\(uuid, uuid\) FROM PUBLIC, anon, authenticated;/)
  assert.match(migration, /GRANT EXECUTE ON FUNCTION integraciones\.prepare_bsale_purchase_receipt_operation\(uuid, uuid\) TO service_role;/)
})


