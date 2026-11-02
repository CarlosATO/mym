import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  buildInvoiceStockEvidencePayload,
  buildInvoiceStockEvidenceLines,
} from '../src/lib/integraciones/invoice-stock-verification.ts'
import { validateInvoiceDocument } from '../src/lib/integraciones/invoice-emission-contract.ts'

const actionSource = await readFile(new URL('../src/app/actions/logistica/sales-order-invoice-attempts.ts', import.meta.url), 'utf8')
const d1Migration = await readFile(new URL('../supabase/migrations/20261030150000_logistica_invoice_stock_verification_guard.sql', import.meta.url), 'utf8')
const strictRpcMigration = await readFile(new URL('../supabase/migrations/20261030120743_logistica_invoice_reconciliation_strict.sql', import.meta.url), 'utf8')

// Fixtures for testing
const mockCompanyId = 'd1000000-0000-0000-0000-000000000001'
const mockAttemptId = 'a1000000-0000-0000-0000-000000000001'
const mockSalesId = 'PETGROUP:FACTURA:test-sales-100'
const mockFingerprint = 'fp-test-sales-100-hash'
const mockOfficeId = 1
const mockClientId = 1005

const validAttemptSnapshot = {
  id: mockAttemptId,
  company_id: mockCompanyId,
  status: 'RECONCILIATION_REQUIRED',
  sales_id: mockSalesId,
  fingerprint: mockFingerprint,
  bsale_invoice_id: 24874,
  bsale_invoice_number: '24874',
  current_bsale_nv_id: 5148,
  canonical_bsale_token: 'tok-5148',
  nv_snapshot: {
    client_id: mockClientId,
    office_id: mockOfficeId,
    totals: { net: 100000, tax: 19000, total: 119000 },
  },
  detail_snapshots: [
    { detail_id: 301, variant_id: 101, sku: 'PROD-A', quantity: 2, net_unit_value: 30000, total_unit_value: 35700, net_amount: 60000, tax_amount: 11400, total_amount: 71400, net_discount: 0 },
    { detail_id: 302, variant_id: 102, sku: 'PROD-B', quantity: 1, net_unit_value: 40000, total_unit_value: 47600, net_amount: 40000, tax_amount: 7600, total_amount: 47600, net_discount: 0 },
  ],
}

const validBsaleInvoiceDocument = {
  id: 24874,
  number: 24874,
  state: 0,
  cancellationStatus: '0',
  document_type: { id: 5 },
  client: { id: mockClientId },
  office: { id: mockOfficeId },
  salesId: mockSalesId,
  totalAmount: 119000,
  netAmount: 100000,
  taxAmount: 19000,
  details: {
    items: [
      { id: 401, relatedDetailId: 301, quantity: 2, variant: { id: 101, code: 'PROD-A' }, netAmount: 60000, taxAmount: 11400, totalAmount: 71400 },
      { id: 402, relatedDetailId: 302, quantity: 1, variant: { id: 102, code: 'PROD-B' }, netAmount: 40000, taxAmount: 7600, totalAmount: 47600 },
    ],
  },
}

test('Garantía absoluta de cero POST a Bsale y cero solicitudes de despacho en reconciliación', () => {
  // Extract candidate discovery helper and reconcileSalesOrderInvoiceAttempt
  const reconcileStart = actionSource.indexOf('async function findUniqueCandidateInvoice')
  assert.ok(reconcileStart > 0, 'findUniqueCandidateInvoice must exist')
  const reconcileCode = actionSource.slice(reconcileStart)

  // Verify write client is NEVER called in reconciliation
  assert.doesNotMatch(reconcileCode, /bsaleWriteForCompany/)
  assert.doesNotMatch(reconcileCode, /method:\s*['"]POST['"]/i)
  assert.doesNotMatch(reconcileCode, /method:\s*['"]PUT['"]/i)
  assert.doesNotMatch(reconcileCode, /method:\s*['"]DELETE['"]/i)
  assert.doesNotMatch(reconcileCode, /dispatch:\s*1/)

  // Only GET resources are fetched
  assert.match(reconcileCode, /bsaleFetchResourceForCompany/)
  assert.match(reconcileCode, /verifyStockWithBoundedReads/)
})

test('Contrato de orden en recuperación: candidate -> validar -> mirror -> verificar despacho -> evidencia admin -> confirmar', () => {
  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)

  const candidateIdx = reconcileCode.indexOf('findUniqueCandidateInvoice')
  const validateIdx = reconcileCode.indexOf('validateInvoiceDocument')
  const mirrorIdx = reconcileCode.indexOf('mirrorConfirmedInvoice')
  const verifyStockIdx = reconcileCode.indexOf('verifyStockWithBoundedReads')
  const recordEvidenceIdx = reconcileCode.indexOf('record_sales_order_invoice_stock_evidence')
  const rpcConfirmIdx = reconcileCode.lastIndexOf("rpc('reconcile_sales_order_invoice_attempt'")

  assert.ok(candidateIdx > 0, 'candidate lookup must be invoked')
  assert.ok(validateIdx > candidateIdx, 'validation must follow candidate lookup')
  assert.ok(mirrorIdx > validateIdx, 'mirror update must follow validation')
  assert.ok(verifyStockIdx > mirrorIdx, 'stock verification must follow mirror update')
  assert.ok(recordEvidenceIdx > verifyStockIdx, 'evidence registration must follow stock verification')
  assert.ok(rpcConfirmIdx > recordEvidenceIdx, 'final reconcile RPC must follow evidence registration')
})

test('Factura existente y despacho completo: recuperación correcta registra evidencia y confirma', () => {
  const verification = {
    status: 'VERIFIED',
    invoiceId: 24874,
    reasons: [],
    expected: [
      { variantId: 101, sku: 'PROD-A', quantity: 2, key: 'variant:101' },
      { variantId: 102, sku: 'PROD-B', quantity: 1, key: 'variant:102' },
    ],
    observed: {
      active: [
        { shippingId: 601, officeId: mockOfficeId, variantId: 101, sku: 'PROD-A', quantity: 2 },
        { shippingId: 601, officeId: mockOfficeId, variantId: 102, sku: 'PROD-B', quantity: 1 },
      ],
      inactiveShippingIds: [],
      wrongOfficeShippingIds: [],
    },
    evidence: {
      shippingIds: [601],
      activeShippingIds: [601],
      costsAvailable: true,
    },
  }

  const payload = buildInvoiceStockEvidencePayload({
    companyId: mockCompanyId,
    attemptId: mockAttemptId,
    invoiceBsaleId: 24874,
    salesId: mockSalesId,
    attemptFingerprint: mockFingerprint,
    officeId: mockOfficeId,
    verification,
    rawEvidence: {
      source: 'BSALE_GET',
      reasons: [],
      costsAvailable: true,
      reconciliation: true,
    },
  })

  assert.equal(payload.p_company_id, mockCompanyId)
  assert.equal(payload.p_attempt_id, mockAttemptId)
  assert.equal(payload.p_invoice_bsale_id, 24874)
  assert.equal(payload.p_sales_id, mockSalesId)
  assert.equal(payload.p_attempt_fingerprint, mockFingerprint)
  assert.equal(payload.p_office_id, mockOfficeId)
  assert.deepEqual(payload.p_shipping_ids, [601])
  assert.deepEqual(payload.p_active_shipping_ids, [601])
  assert.equal(payload.p_lines.length, 2)
  assert.equal(payload.p_lines[0].dispatched_quantity, payload.p_lines[0].expected_quantity)
  assert.equal(payload.p_lines[1].dispatched_quantity, payload.p_lines[1].expected_quantity)
  assert.equal(payload.p_raw_evidence.reconciliation, true)
})

test('Factura existente con mirror incompleto: reparación controlada espeja documento y detalles exactos', () => {
  // Mirroring helper mirrors document without altering amounts
  assert.match(actionSource, /mirrorConfirmedInvoice/)
  assert.match(actionSource, /from\('bsale_documents'\)\.upsert\(documentRow/)
  assert.match(actionSource, /from\('bsale_document_details'\)\.upsert\(detailRows/)
  assert.doesNotMatch(actionSource, /total_amount:\s*expected_total/) // Does NOT replace official amounts
})

test('Intento sin invoice ID pero con salesId válido descubre factura vía mirror directo en PostgreSQL', () => {
  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)

  // Verify findUniqueCandidateInvoice handles null bsale_invoice_id using sales_id
  assert.match(reconcileCode, /attempt\.bsale_invoice_id \? Number\(attempt\.bsale_invoice_id\) : null/)
  assert.match(actionSource, /async function findUniqueCandidateInvoice/)
  assert.match(actionSource, /\.eq\('raw_json->>salesId', salesId\)/)
})

test('Factura inexistente o identidad ambigua conserva RECONCILIATION_REQUIRED', () => {
  assert.match(actionSource, /return \{ ok: false, reason: 'AMBIGUOUS_SALES_ID_MATCH' \}/)
  assert.match(actionSource, /return \{ ok: false, reason: 'NO_VALID_INVOICE' \}/)
  assert.match(actionSource, /return \{ ok: false, reason: 'INVOICE_ID_MISMATCH' \}/)

  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)
  assert.match(reconcileCode, /if \(!candidate\.ok\) \{[\s\S]*markAttempt\(db, 'mark_sales_order_invoice_reconciliation_required'/)
})

test('Factura comercialmente incompatible no registra evidencia ni confirma', () => {
  // 1. Client mismatch
  const badClient = { ...validBsaleInvoiceDocument, client: { id: 9999 } }
  const vClient = validateInvoiceDocument(badClient, {
    salesId: mockSalesId,
    clientId: mockClientId,
    officeId: mockOfficeId,
    totals: validAttemptSnapshot.nv_snapshot.totals,
    details: [{ detailId: 301, quantity: 2 }, { detailId: 302, quantity: 1 }],
  })
  assert.equal(vClient.ok, false)
  assert.equal(vClient.reason, 'CLIENT_MISMATCH')

  // 2. Office mismatch
  const badOffice = { ...validBsaleInvoiceDocument, office: { id: 99 } }
  const vOffice = validateInvoiceDocument(badOffice, {
    salesId: mockSalesId,
    clientId: mockClientId,
    officeId: mockOfficeId,
    totals: validAttemptSnapshot.nv_snapshot.totals,
    details: [{ detailId: 301, quantity: 2 }, { detailId: 302, quantity: 1 }],
  })
  assert.equal(vOffice.ok, false)
  assert.equal(vOffice.reason, 'OFFICE_MISMATCH')

  // 3. Totals mismatch > 5
  const badTotals = { ...validBsaleInvoiceDocument, totalAmount: 119010 }
  const vTotals = validateInvoiceDocument(badTotals, {
    salesId: mockSalesId,
    clientId: mockClientId,
    officeId: mockOfficeId,
    totals: validAttemptSnapshot.nv_snapshot.totals,
    details: [{ detailId: 301, quantity: 2 }, { detailId: 302, quantity: 1 }],
  })
  assert.equal(vTotals.ok, false)
  assert.equal(vTotals.reason, 'TOTALS_MISMATCH')

  // 4. Detail quantity mismatch
  const badQuantity = {
    ...validBsaleInvoiceDocument,
    details: {
      items: [
        { id: 401, relatedDetailId: 301, quantity: 5, variant: { id: 101, code: 'PROD-A' } },
        { id: 402, relatedDetailId: 302, quantity: 1, variant: { id: 102, code: 'PROD-B' } },
      ],
    },
  }
  const vQuantity = validateInvoiceDocument(badQuantity, {
    salesId: mockSalesId,
    clientId: mockClientId,
    officeId: mockOfficeId,
    totals: validAttemptSnapshot.nv_snapshot.totals,
    details: [{ detailId: 301, quantity: 2 }, { detailId: 302, quantity: 1 }],
  })
  assert.equal(vQuantity.ok, false)
  assert.equal(vQuantity.reason, 'RELATED_DETAIL_ID_NOT_PROVABLE')
})

test('Despacho parcial, ausente o cancelado no registra evidencia ni confirma', () => {
  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)

  const verificationGuardStart = reconcileCode.indexOf("if (stockVerification.status !== 'VERIFIED')")
  const rpcAdminStart = reconcileCode.indexOf("record_sales_order_invoice_stock_evidence", verificationGuardStart)
  const guardBlock = reconcileCode.slice(verificationGuardStart, rpcAdminStart)

  assert.match(guardBlock, /markAttempt\(db, 'mark_sales_order_invoice_reconciliation_required'/)
  assert.match(guardBlock, /status: 'RECONCILIATION_REQUIRED'/)
  assert.doesNotMatch(guardBlock, /record_sales_order_invoice_stock_evidence/)
  assert.doesNotMatch(guardBlock, /reconcile_sales_order_invoice_attempt/)
})

test('Error GET de Bsale captura el error y mantiene RECONCILIATION_REQUIRED sin caerse', () => {
  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)

  assert.match(reconcileCode, /try \{[\s\S]*invoice = await bsaleFetchResourceForCompany[\s\S]*\} catch \(error\) \{[\s\S]*BSALE_GET_FAILED/)
  assert.match(reconcileCode, /try \{[\s\S]*stockVerification = await verifyStockWithBoundedReads[\s\S]*\} catch \(error\) \{[\s\S]*BSALE_GET_FAILED/)
})

test('Error al persistir evidencia conserva intento pendiente sin confirmar', () => {
  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)

  const evidenceCheckStart = reconcileCode.indexOf("if (evidenceError || evidenceResult?.status !== 'VERIFIED')")
  const rpcCallStart = reconcileCode.indexOf("db.schema('logistica').rpc('reconcile_sales_order_invoice_attempt'", evidenceCheckStart)
  const evidenceBlock = reconcileCode.slice(evidenceCheckStart, rpcCallStart)

  assert.match(evidenceBlock, /STOCK_EVIDENCE_FAILED/)
  assert.match(evidenceBlock, /markAttempt\(db, 'mark_sales_order_invoice_reconciliation_required'/)
  assert.doesNotMatch(evidenceBlock, /reconcile_sales_order_invoice_attempt/)
})

test('Reconciliación repetida e intento histórico CONFIRMED responden de forma idempotente con cero llamadas Bsale', () => {
  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)

  const confirmedCheckStart = reconcileCode.indexOf("if (attempt.status === 'CONFIRMED')")
  const candidateCallStart = reconcileCode.indexOf("const candidate = await findUniqueCandidateInvoice")
  const confirmedBlock = reconcileCode.slice(confirmedCheckStart, candidateCallStart)

  // Direct return via RPC without running Bsale candidate discovery or verification
  assert.match(confirmedBlock, /db\.schema\('logistica'\)\.rpc\('reconcile_sales_order_invoice_attempt'/)
  assert.doesNotMatch(confirmedBlock, /bsaleFetch|findUniqueCandidateInvoice|verifyStockWithBoundedReads/)
})

test('Peticiones concurrentes: la RPC SQL y la evidencia serializan mediante FOR UPDATE', () => {
  assert.match(d1Migration, /WHERE id = p_attempt_id\s+-- Serialize evidence writers[\s\S]*FOR UPDATE/)
  assert.match(strictRpcMigration, /SELECT \* INTO a[\s\S]*FROM logistica\.sales_order_invoice_attempts[\s\S]*WHERE id = p_attempt_id[\s\S]*FOR UPDATE/)
})

test('Aislamiento por empresa y control de permisos en servidor', () => {
  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)

  assert.match(reconcileCode, /requireWmsPermission\('module\.logistica\.view'\)/)
  assert.match(reconcileCode, /if \(auth\.isOperatorBodega\) throw new Error\('No autorizado para facturación'\)/)
  assert.match(reconcileCode, /\.eq\('company_id', auth\.companyId\)/)
})

test('Compatibilidad con MEJ-03 (tolerancia ±5) y estructuras D1/D2', () => {
  // Accepted within ±5
  const invoiceWithinLimit = { ...validBsaleInvoiceDocument, totalAmount: 119003 } // diff +3
  const vLimit = validateInvoiceDocument(invoiceWithinLimit, {
    salesId: mockSalesId,
    clientId: mockClientId,
    officeId: mockOfficeId,
    totals: validAttemptSnapshot.nv_snapshot.totals,
    details: [{ detailId: 301, quantity: 2 }, { detailId: 302, quantity: 1 }],
  })
  assert.equal(vLimit.ok, true)
  if (vLimit.ok && vLimit.audit) {
    assert.equal(vLimit.audit.code, 'INVOICE_TOTAL_DIFFERENCE_ACCEPTED')
    assert.equal(vLimit.audit.totalDifference, 3)
    assert.equal(vLimit.audit.limit, 5)
  }
})
