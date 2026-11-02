import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  buildInvoiceStockEvidencePayload,
  buildInvoiceStockEvidenceLines,
} from '../src/lib/integraciones/invoice-stock-verification.ts'

const actionSource = await readFile(new URL('../src/app/actions/logistica/sales-order-invoice-attempts.ts', import.meta.url), 'utf8')

test('buildInvoiceStockEvidenceLines formatea correctamente line_key según convención SQL', () => {
  const observedActive = [
    { shippingId: 501, officeId: 1, variantId: 101, sku: 'prod-a', quantity: 2 },
    { shippingId: 502, officeId: 1, variantId: null, sku: 'only-sku', quantity: 3 },
  ]
  const expected = [
    { variantId: 101, sku: 'PROD-A', quantity: 2, key: 'variant:101' },
    { variantId: undefined, sku: 'ONLY-SKU', quantity: 3, key: 'sku:ONLY-SKU' },
  ]

  const lines = buildInvoiceStockEvidenceLines(observedActive, expected)
  assert.equal(lines.length, 2)

  const variantLine = lines.find(l => l.line_key === 'variant:101')
  assert.ok(variantLine)
  assert.equal(variantLine.variant_id, 101)
  assert.equal(variantLine.sku, 'PROD-A')
  assert.equal(variantLine.expected_quantity, 2)
  assert.equal(variantLine.dispatched_quantity, 2)
  assert.deepEqual(variantLine.shipping_ids, [501])

  const skuLine = lines.find(l => l.line_key === 'sku:ONLY-SKU')
  assert.ok(skuLine)
  assert.equal(skuLine.variant_id, null)
  assert.equal(skuLine.sku, 'ONLY-SKU')
  assert.equal(skuLine.expected_quantity, 3)
  assert.equal(skuLine.dispatched_quantity, 3)
  assert.deepEqual(skuLine.shipping_ids, [502])
})

test('buildInvoiceStockEvidenceLines agrega productos repetidos y consolida despachos', () => {
  // Caso de productos repetidos: el mismo variantId despachado en varios envíos
  const observedActive = [
    { shippingId: 501, officeId: 1, variantId: 101, sku: 'PROD-A', quantity: 2 },
    { shippingId: 502, officeId: 1, variantId: 101, sku: 'PROD-A', quantity: 3 },
    { shippingId: 501, officeId: 1, variantId: 101, sku: 'PROD-A', quantity: 1 }, // despacho parcial en mismo shipping
  ]

  const lines = buildInvoiceStockEvidenceLines(observedActive)
  assert.equal(lines.length, 1)

  const line = lines[0]
  assert.equal(line.line_key, 'variant:101')
  assert.equal(line.variant_id, 101)
  assert.equal(line.dispatched_quantity, 6)
  assert.equal(line.expected_quantity, 6)
  // shipping_ids debe estar deduplicado y ordenado
  assert.deepEqual(line.shipping_ids, [501, 502])
})

test('buildInvoiceStockEvidencePayload genera todos los campos requeridos por la RPC SQL', () => {
  const verification = {
    status: 'VERIFIED',
    invoiceId: 998877,
    reasons: [],
    expected: [
      { variantId: 101, sku: 'PROD-A', quantity: 4, key: 'variant:101' },
    ],
    observed: {
      active: [
        { shippingId: 501, officeId: 2, variantId: 101, sku: 'PROD-A', quantity: 4 },
      ],
      inactiveShippingIds: [],
      wrongOfficeShippingIds: [],
    },
    evidence: {
      shippingIds: [501],
      activeShippingIds: [501],
      costsAvailable: true,
    },
  }

  const payload = buildInvoiceStockEvidencePayload({
    companyId: 'd1000000-0000-0000-0000-000000000001',
    attemptId: 'att-1234-5678',
    invoiceBsaleId: 998877,
    salesId: 'PETGROUP:FACTURA:test-1',
    attemptFingerprint: 'fp-1234567890abcdef',
    officeId: 2,
    verification,
    verifiedAt: '2026-11-02T10:00:00.000Z',
  })

  assert.equal(payload.p_company_id, 'd1000000-0000-0000-0000-000000000001')
  assert.equal(payload.p_attempt_id, 'att-1234-5678')
  assert.equal(payload.p_invoice_bsale_id, 998877)
  assert.equal(payload.p_sales_id, 'PETGROUP:FACTURA:test-1')
  assert.equal(payload.p_attempt_fingerprint, 'fp-1234567890abcdef')
  assert.equal(payload.p_office_id, 2)
  assert.deepEqual(payload.p_shipping_ids, [501])
  assert.deepEqual(payload.p_active_shipping_ids, [501])
  assert.equal(payload.p_verified_at, '2026-11-02T10:00:00.000Z')
  assert.equal(payload.p_lines.length, 1)
  assert.equal(payload.p_lines[0].line_key, 'variant:101')
  assert.equal(payload.p_lines[0].expected_quantity, 4)
  assert.equal(payload.p_lines[0].dispatched_quantity, 4)
  assert.deepEqual(payload.p_lines[0].shipping_ids, [501])
  assert.equal(payload.p_raw_evidence.status, 'VERIFIED')
})

test('contrato de orden: POST Bsale -> validar -> verificar despacho -> mirror -> registrar evidencia -> confirmar', () => {
  const postPos = actionSource.indexOf('await bsaleWriteForCompany')
  const validatePos = actionSource.indexOf('validateInvoiceDocument(invoice,', postPos)
  const verifyPos = actionSource.indexOf('await verifyStockWithBoundedReads(', validatePos)
  const mirrorPos = actionSource.indexOf('await mirrorConfirmedInvoice(', verifyPos)
  const guardPos = actionSource.indexOf("if (stockVerification.status !== 'VERIFIED')", mirrorPos)
  const recordPos = actionSource.indexOf("record_sales_order_invoice_stock_evidence", guardPos)
  const confirmPos = actionSource.indexOf("confirm_sales_order_invoice_attempt", recordPos)

  assert.ok(postPos !== -1, 'Debe existir POST Bsale')
  assert.ok(validatePos !== -1, 'Debe existir validación de factura')
  assert.ok(verifyPos !== -1, 'Debe existir verificación de stock')
  assert.ok(mirrorPos !== -1, 'Debe existir actualización de mirror')
  assert.ok(guardPos !== -1, 'Debe existir chequeo status !== VERIFIED')
  assert.ok(recordPos !== -1, 'Debe registrar evidencia tras VERIFIED')
  assert.ok(confirmPos !== -1, 'Debe confirmar intento tras registrar evidencia')

  assert.ok(postPos < validatePos, 'POST debe ocurrir antes de validar')
  assert.ok(validatePos < verifyPos, 'Validación debe ocurrir antes de verificar stock')
  assert.ok(verifyPos < mirrorPos, 'Verificación debe ocurrir antes de espejar')
  assert.ok(mirrorPos < guardPos, 'Mirror debe ocurrir antes del guard')
  assert.ok(guardPos < recordPos, 'Guard debe proteger antes de registrar evidencia')
  assert.ok(recordPos < confirmPos, 'Evidencia debe registrarse antes de confirmar')
})

test('PENDING y UNABLE_TO_VERIFY nunca registran evidencia ni confirman', () => {
  const guardStart = actionSource.indexOf("if (stockVerification.status !== 'VERIFIED')")
  const guardReturn = actionSource.indexOf('return {', guardStart)
  const guardEnd = actionSource.indexOf('const admin = createAdminClient()', guardReturn)
  const guardBlock = actionSource.slice(guardStart, guardEnd)

  assert.match(guardBlock, /markAttempt\(db, 'mark_sales_order_invoice_reconciliation_required'/)
  assert.match(guardBlock, /status: 'RECONCILIATION_REQUIRED'/)
  assert.doesNotMatch(guardBlock, /record_sales_order_invoice_stock_evidence/)
  assert.doesNotMatch(guardBlock, /confirm_sales_order_invoice_attempt/)
})

test('fallo en la RPC de evidencia no confirma y preserva estado pendiente de conciliación', () => {
  const recordPos = actionSource.indexOf("record_sales_order_invoice_stock_evidence")
  const errorCheckPos = actionSource.indexOf("if (evidenceError || evidenceResult?.status !== 'VERIFIED')", recordPos)
  const confirmPos = actionSource.indexOf("confirm_sales_order_invoice_attempt", errorCheckPos)
  const errorBlock = actionSource.slice(errorCheckPos, confirmPos)

  assert.match(errorBlock, /markAttempt\(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, `STOCK_EVIDENCE_FAILED:/)
  assert.match(errorBlock, /status: 'RECONCILIATION_REQUIRED'/)
  assert.match(errorBlock, /invoice_id: invoice\.id/)
  assert.match(errorBlock, /folio: invoice\.number/)
  assert.doesNotMatch(errorBlock, /confirm_sales_order_invoice_attempt/)
  assert.doesNotMatch(errorBlock, /bsaleWriteForCompany/)
})

test('ejecución administrativa usa service_role exclusivamente en servidor', () => {
  assert.match(actionSource, /^'use server'/m, 'El archivo debe ser Server Action estricto')
  assert.match(actionSource, /const admin = createAdminClient\(\)/)
  assert.match(actionSource, /admin\.schema\('logistica'\)\.rpc\(\s*'record_sales_order_invoice_stock_evidence'/)
  assert.doesNotMatch(actionSource, /createClient\(\)\.schema\('logistica'\)\.rpc\(\s*'record_sales_order_invoice_stock_evidence'/)
})

test('solicitudes concurrentes o repetidas no generan facturas adicionales', () => {
  assert.match(actionSource, /if \(existingAttempt\?\.status === 'CONFIRMED'\) return \{ status: 'ALREADY_INVOICED'/)
  assert.match(actionSource, /if \(existingAttempt && \['SUBMITTING', 'UNKNOWN', 'RECONCILIATION_REQUIRED'\]\.includes\(existingAttempt\.status\)\)/)
})
