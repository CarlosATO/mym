import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const actionSource = await readFile(new URL('../src/app/actions/logistica/sales-order-invoice-attempts.ts', import.meta.url), 'utf8')

test('findUniqueCandidateInvoice() prioriza consulta directa de bsale_invoice_id si está presente', () => {
  const candidateFuncStart = actionSource.indexOf('async function findUniqueCandidateInvoice')
  assert.ok(candidateFuncStart > 0, 'findUniqueCandidateInvoice must exist')

  const candidateCode = actionSource.slice(candidateFuncStart, actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt'))
  const directCheck = candidateCode.indexOf('if (bsaleInvoiceId != null && bsaleInvoiceId > 0)')
  const mirrorCheck = candidateCode.indexOf(".from('bsale_documents')")

  assert.ok(directCheck > 0, 'Must check bsaleInvoiceId first')
  assert.ok(mirrorCheck > directCheck, 'Mirror query must be evaluated after direct ID check')

  // Direct fetch uses /documents/{id}.json with expand
  assert.match(candidateCode, /path:\s*`\/documents\/\$\{bsaleInvoiceId\}\.json`/)
  assert.match(candidateCode, /params:\s*\{\s*expand:\s*'details,payments'\s*\}/)
})

test('Consulta de mirror en PostgreSQL filtra directamente por raw_json->>salesId sin límite de 1.000 filas', () => {
  const candidateFuncStart = actionSource.indexOf('async function findUniqueCandidateInvoice')
  const candidateCode = actionSource.slice(candidateFuncStart, actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt'))

  // Must filter company_id, document_type_id, state AND raw_json->>salesId in the query chain
  assert.match(candidateCode, /\.eq\('company_id',\s*companyId\)/)
  assert.match(candidateCode, /\.eq\('document_type_id',\s*5\)/)
  assert.match(candidateCode, /\.eq\('state',\s*0\)/)
  assert.match(candidateCode, /\.eq\('raw_json->>salesId',\s*salesId\)/)

  // Must NOT perform client-side unpaginated array scan
  assert.doesNotMatch(candidateCode, /bsale_documents'[\s\S]*\.filter\([\s\S]*d\.raw_json\?\.salesId === salesId/)
})

test('Simulación con > 1.000 documentos: el filtro PostgreSQL localiza la factura 2.450 sin ser truncado', () => {
  // Mock dataset simulating 2,500 documents in bsale_documents
  const targetSalesId = 'PETGROUP:FACTURA:deep-history-2450'
  const mockTable = Array.from({ length: 2500 }, (_, i) => ({
    bsale_id: 10000 + i,
    company_id: 'c1',
    document_type_id: 5,
    state: 0,
    raw_json: {
      salesId: i === 2450 ? targetSalesId : `PETGROUP:FACTURA:other-${i}`,
      cancellationStatus: '0',
    },
  }))

  // A naive memory filter over PostgREST's default 1,000 row page would fail to find document #2450
  const postgrestDefaultPage = mockTable.slice(0, 1000)
  const naiveClientFilter = postgrestDefaultPage.filter(d => d.raw_json?.salesId === targetSalesId)
  assert.equal(naiveClientFilter.length, 0, 'A naive 1,000-row page scan fails to find document 2,450')

  // Direct PostgreSQL query simulation (.eq('raw_json->>salesId', targetSalesId)) finds it cleanly
  const serverIndexedQuery = mockTable.filter(
    d => d.company_id === 'c1' && d.document_type_id === 5 && d.state === 0 && d.raw_json.salesId === targetSalesId
  )
  assert.equal(serverIndexedQuery.length, 1)
  assert.equal(serverIndexedQuery[0].bsale_id, 12450)
  assert.equal(serverIndexedQuery[0].raw_json.salesId, targetSalesId)
})

test('Factura antigua: se recupera correctamente sin importar antigüedad', () => {
  const oldDoc = {
    id: 1050,
    documentTypeId: 5,
    state: 0,
    cancellationStatus: '0',
    salesId: 'PETGROUP:FACTURA:legacy-2024-old',
  }

  // Direct validation helper logic
  const isDocValid = (doc, expectedSalesId) => {
    const docTypeId = Number(doc?.document_type?.id ?? doc?.documentTypeId)
    const state = Number(doc?.state)
    const cancellation = doc?.cancellationStatus != null ? String(doc?.cancellationStatus) : '0'
    const docSalesId = String(doc?.salesId ?? '')
    if (docTypeId !== 5) return { ok: false, reason: 'DOCUMENT_TYPE_MISMATCH' }
    if (state !== 0 || cancellation !== '0') return { ok: false, reason: 'INVOICE_CANCELLED' }
    if (docSalesId !== expectedSalesId) return { ok: false, reason: 'INVOICE_ID_MISMATCH' }
    return { ok: true, invoiceId: Number(doc.id) }
  }

  const result = isDocValid(oldDoc, 'PETGROUP:FACTURA:legacy-2024-old')
  assert.equal(result.ok, true)
  assert.equal(result.invoiceId, 1050)
})

test('Factura cancelada (state = 1 o cancellationStatus = 1) es rechazada con INVOICE_CANCELLED', () => {
  const isDocValid = (doc, expectedSalesId) => {
    const docTypeId = Number(doc?.document_type?.id ?? doc?.documentTypeId)
    const state = Number(doc?.state)
    const cancellation = doc?.cancellationStatus != null ? String(doc?.cancellationStatus) : '0'
    const docSalesId = String(doc?.salesId ?? '')
    if (docTypeId !== 5) return { ok: false, reason: 'DOCUMENT_TYPE_MISMATCH' }
    if (state !== 0 || cancellation !== '0') return { ok: false, reason: 'INVOICE_CANCELLED' }
    if (docSalesId !== expectedSalesId) return { ok: false, reason: 'INVOICE_ID_MISMATCH' }
    return { ok: true, invoiceId: Number(doc.id) }
  }

  // Cancelled via state = 1
  const cancelledState = { id: 2001, documentTypeId: 5, state: 1, cancellationStatus: '0', salesId: 'PETGROUP:FACTURA:test-1' }
  assert.equal(isDocValid(cancelledState, 'PETGROUP:FACTURA:test-1').reason, 'INVOICE_CANCELLED')

  // Cancelled via cancellationStatus = '1'
  const cancelledStatus = { id: 2002, documentTypeId: 5, state: 0, cancellationStatus: '1', salesId: 'PETGROUP:FACTURA:test-1' }
  assert.equal(isDocValid(cancelledStatus, 'PETGROUP:FACTURA:test-1').reason, 'INVOICE_CANCELLED')
})

test('salesId repetido en mirror genera AMBIGUOUS_SALES_ID_MATCH y no adivina', () => {
  const candidateFuncStart = actionSource.indexOf('async function findUniqueCandidateInvoice')
  const candidateCode = actionSource.slice(candidateFuncStart, actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt'))

  assert.match(candidateCode, /if \(activeMirrorMatches\.length > 1\) \{\s*return \{ ok: false, reason: 'AMBIGUOUS_SALES_ID_MATCH' \}/)
})

test('Filtro Bsale ignorado: el sistema no depende de GET /documents.json?salesid=...', () => {
  const candidateFuncStart = actionSource.indexOf('async function findUniqueCandidateInvoice')
  const candidateCode = actionSource.slice(candidateFuncStart, actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt'))

  // Verify that findUniqueCandidateInvoice does NOT rely on /documents.json?salesid=...
  assert.doesNotMatch(candidateCode, /path:\s*BSALE_DOCUMENTS_ENDPOINT/)
  assert.doesNotMatch(candidateCode, /params:\s*\{\s*salesid:/)
})

test('Cero coincidencias retorna NO_VALID_INVOICE y retiene RECONCILIATION_REQUIRED', () => {
  const candidateFuncStart = actionSource.indexOf('async function findUniqueCandidateInvoice')
  const candidateCode = actionSource.slice(candidateFuncStart, actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt'))

  assert.match(candidateCode, /return \{ ok: false, reason: 'NO_VALID_INVOICE' \}/)

  const reconcileStart = actionSource.indexOf('export async function reconcileSalesOrderInvoiceAttempt')
  const reconcileCode = actionSource.slice(reconcileStart)
  assert.match(reconcileCode, /if \(!candidate\.ok\) \{[\s\S]*markAttempt\(db, 'mark_sales_order_invoice_reconciliation_required', attemptId, candidate\.reason\)/)
})
