import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as contract from '../src/lib/integraciones/invoice-emission-contract.ts'

const original = {
  company_id: 'company', canonical_bsale_token: 'token', current_bsale_nv_id: 100,
  historical_bsale_nv_id: 100, folio: '100', client_id: 12, office_id: 1,
  sale_condition_id: '15', payment_type_id: 18, seller_id: 15, price_list_id: 4,
  emission_date: '2026-11-12', expiration_date: '2026-11-12',
  totals: { net: 100, tax: 19, total: 119 }, total: 119,
  details: [{ detail_id: 10, variant_id: 20, sku: 'SKU', quantity: 1, billable_quantity: 1, net_unit_value: 100, total_unit_value: 119, net_amount: 100, tax_amount: 19, total_amount: 119, net_discount: 0 }],
}
const identity = contract.buildInvoiceEmissionIdentity(original)
const payload = contract.buildInvoiceEmissionPayload({ officeId: 1, priceListId: 4, saleConditionId: 15, emissionDate: contract.chileDateToBsaleEpoch('2026-11-12'), expirationDate: contract.chileDateToBsaleEpoch('2026-11-12'), clientId: 12, sellerId: 15, salesId: identity.salesId, details: [{ detailId: 10, quantity: 1 }], payments: [{ paymentTypeId: 18, amount: 119, recordDate: contract.chileDateToBsaleEpoch('2026-11-12') }] })
const makeAttempt = () => ({ id: 'attempt', status: 'FAILED_RETRYABLE', sales_id: identity.salesId, fingerprint: identity.fingerprint, payload_snapshot: structuredClone(payload), last_error: 'BSALE_REJECTED|http_status=400|message=Bad Request|body={"error":"client blocked"}', bsale_invoice_id: null, bsale_invoice_number: null, retry_count: 0 })
const today = { ...original, emission_date: '2026-11-13', expiration_date: '2026-11-13' }

test('el día siguiente conserva fingerprint y salesId al reconstruir con fechas originales', () => {
  assert.notEqual(contract.buildInvoiceEmissionIdentity(today).fingerprint, identity.fingerprint)
  assert.deepEqual(contract.recoverRejectedInvoiceIdentity(today, makeAttempt()), identity)
})

test('cambios comerciales o identidad persistida incorrecta rechazan la recuperación', () => {
  const changes = [
    { client_id: 13 }, { office_id: 2 }, { current_bsale_nv_id: 101 },
    { payment_type_id: 8 }, { sale_condition_id: '16' }, { seller_id: 16 }, { price_list_id: 5 },
    { total: 120 }, { totals: { ...today.totals, total: 120 } },
    { details: [{ ...today.details[0], variant_id: 21 }] },
    { details: [{ ...today.details[0], quantity: 2 }] },
    { details: [{ ...today.details[0], net_unit_value: 101 }] },
  ]
  for (const change of changes) assert.equal(contract.recoverRejectedInvoiceIdentity({ ...today, ...change }, makeAttempt()), null)
  assert.equal(contract.recoverRejectedInvoiceIdentity(today, { ...makeAttempt(), fingerprint: 'other' }), null)
  assert.equal(contract.recoverRejectedInvoiceIdentity(today, { ...makeAttempt(), sales_id: 'other' }), null)
})

test('payload de reintento solo cambia fechas y rechaza cambio de dirección o pago', () => {
  const updated = { ...structuredClone(payload), emissionDate: contract.chileDateToBsaleEpoch('2026-11-13'), expirationDate: contract.chileDateToBsaleEpoch('2026-11-13'), payments: [{ ...payload.payments[0], recordDate: contract.chileDateToBsaleEpoch('2026-11-13') }] }
  assert.equal(contract.sameInvoiceRetryPayloadExceptDates(payload, updated), true)
  assert.equal(contract.sameInvoiceRetryPayloadExceptDates(payload, { ...updated, addressId: 99 }), false)
  assert.equal(contract.sameInvoiceRetryPayloadExceptDates(payload, { ...updated, payments: [{ ...updated.payments[0], amount: 120 }] }), false)
  assert.equal(contract.sameInvoiceRetryPayloadExceptDates(payload, { ...updated, dispatch: 0 }), false)
})

test('no recupera estados prohibidos, facturas asociadas o rechazos no explícitos', () => {
  for (const status of ['UNKNOWN', 'SUBMITTING', 'RECONCILIATION_REQUIRED', 'CONFIRMED', 'PREPARED', 'FAILED_TERMINAL']) {
    assert.equal(contract.recoverRejectedInvoiceIdentity(today, { ...makeAttempt(), status }), null)
  }
  for (const patch of [{ bsale_invoice_id: 123 }, { bsale_invoice_number: '10' }, { last_error: 'BSALE_TIMEOUT' }, { last_error: 'BSALE_REJECTED|http_status=500|message=fail' }, { last_error: 'BSALE_REJECTED|http_status=400|body={"error":"invoice exists"}' }, { payload_snapshot: {} }, { payload_snapshot: { ...payload, emissionDate: 1 } }]) {
    assert.equal(contract.recoverRejectedInvoiceIdentity(today, { ...makeAttempt(), ...patch }), null)
  }
})

test('acción usa el mismo intento y registra payload efectivo solo al reintentar explícitamente', async () => {
  let attempt = makeAttempt()
  let history = [{ phase: 'INITIAL', payload: structuredClone(payload) }]
  let beginCalls = []
  let mockPosts = []
  let attemptEvidence = []
  let mirrorEvidence = []
  let changedQuantity = 1
  let shouldThrowEvidence = false
  let retryTargetOverride
  let startedIdOverride
  const details = () => [{ id: 10, variant: { id: 20, code: 'SKU' }, quantity: changedQuantity, netUnitValue: 100, totalUnitValue: 119, netAmount: 100, taxAmount: 19, totalAmount: 119, netDiscount: 0 }]
  const nv = () => ({ id: 100, number: 100, client: { id: 12 }, office: { id: 1 }, priceList: { id: 4 }, netAmount: 100, taxAmount: 19, totalAmount: 119, details: { items: details() } })
  const table = name => {
    let columns = ''
    const builder = {
      select(value) { columns = value; return this }, eq() { return this }, order() { return this }, limit() { return this }, or() { return this },
      async maybeSingle() {
        if (name === 'sales_order_preparation_cards') return { data: { id: 'card', status: 'AUDITED', current_bsale_nv_id: 100, bsale_nv_id: 100, canonical_bsale_token: 'token' }, error: null }
        if (name === 'bsale_clients') return { data: { payment_type_id: 18 }, error: null }
        if (name === 'sales_order_invoice_attempts') return { data: columns === 'id' && retryTargetOverride !== undefined ? retryTargetOverride : attempt, error: null }
        throw new Error(`Unexpected maybeSingle ${name}`)
      },
      then(resolve, reject) {
        const result = name === 'bsale_document_details' ? { data: [{ bsale_id: 10, quantity: changedQuantity }], error: null }
          : name === 'bsale_invoice_sales_order_links' ? { data: [], error: null }
            : name === 'sales_order_invoice_attempts' && columns === 'id' ? { data: attemptEvidence, error: shouldThrowEvidence ? { message: 'blocked' } : null }
              : name === 'bsale_documents' ? { data: mirrorEvidence, error: null } : null
        if (!result) return Promise.reject(new Error(`Unexpected query ${name}`)).then(resolve, reject)
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return builder
  }
  const db = { schema: () => ({ from: table, rpc: async (name, args) => {
    if (name === 'invoice_attempt_prevalidate') return { data: { ready: true, current_bsale_nv_id: 100 }, error: null }
    if (name === 'begin_sales_order_invoice_submission') {
      beginCalls.push(args)
      history = [...history, { phase: 'RETRY', payload: structuredClone(args.p_payload_snapshot) }]
      return { data: { ok: true, attempt_id: startedIdOverride ?? attempt?.id ?? 'new-attempt' }, error: null }
    }
    if (name === 'mark_sales_order_invoice_unknown') return { data: {}, error: null }
    throw new Error(`Unexpected rpc ${name}`)
  } }) }
  class BsaleApiError extends Error { constructor(status) { super('mock rejection'); this.status = status } }
  const modules = {
    './authorization': { requireWmsPermission: async () => ({ companyId: 'company', isOperatorBodega: false }) },
    '@/lib/supabase/server': { createClient: async () => db }, '@/lib/supabase/admin': {},
    '@/lib/bsale/client': { BsaleApiError, bsaleFetchResourceForCompany: async ({ path }) => path.startsWith('/clients/') ? { id: 12 } : nv(), bsaleFetchForCompany: async ({ path }) => path.includes('/sellers') ? { items: [{ id: 15 }] } : { items: [] } },
    '@/lib/bsale/write-client': { bsaleWriteForCompany: async ({ body }) => { mockPosts.push(body); throw new BsaleApiError(400) } },
    '@/lib/integraciones/invoice-emission-contract': { ...contract, invoiceEmissionEnabled: () => true, invoiceAddressResolutionEnabled: () => false, chileToday: () => '2026-11-13' },
    '@/lib/integraciones/bsale-address-resolution': {},
    '@/lib/integraciones/invoice-commercial-validation': { evaluateInvoiceCommercialValidation: () => ({ selectedPaymentTypeId: 18, saleConditionId: 15, confirmedExpirationDate: '2026-11-13', missingCommercialFields: false, commercialBlockTriggered: false }) },
    '@/lib/integraciones/invoice-stock-verification': {},
  }
  const source = readFileSync(new URL('../src/app/actions/logistica/sales-order-invoice-attempts.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, { exports, require: key => { if (!modules[key]) throw new Error(`Unexpected import ${key}`); return modules[key] }, console, Date, Number, Error, setTimeout, process: { env: {} } })
  const emit = () => exports.emitSalesOrderInvoice('card', { payment_type_id: 18, sale_condition_id: 15, expiration_date: '2026-11-13' })
  const rejected = await emit()
  assert.equal(rejected.status, 'BSALE_REJECTED')
  assert.equal(beginCalls.length, 1)
  assert.equal(mockPosts.length, 1)
  assert.equal(beginCalls[0].p_sales_id, identity.salesId)
  assert.equal(beginCalls[0].p_fingerprint, identity.fingerprint)
  assert.equal(beginCalls[0].p_payload_snapshot.emissionDate, contract.chileDateToBsaleEpoch('2026-11-13'))
  assert.deepEqual(history[0].payload, payload)
  assert.equal(history[1].phase, 'RETRY')
  assert.deepEqual(attempt.payload_snapshot, payload)
  for (const evidence of ['attempt', 'mirror', 'own']) {
    beginCalls = []; mockPosts = []; attempt = makeAttempt(); attemptEvidence = []; mirrorEvidence = []
    if (evidence === 'attempt') attemptEvidence = [{ id: 'other' }]
    if (evidence === 'mirror') mirrorEvidence = [{ bsale_id: 1 }]
    if (evidence === 'own') attempt.bsale_invoice_id = 99
    assert.equal((await emit()).status, 'ALREADY_INVOICED')
    assert.equal(beginCalls.length, 0); assert.equal(mockPosts.length, 0)
  }
  attempt = makeAttempt(); attemptEvidence = []; mirrorEvidence = []; shouldThrowEvidence = true
  assert.equal((await emit()).status, 'PREVALIDATION_FAILED')
  assert.equal(beginCalls.length, 0); assert.equal(mockPosts.length, 0)
  shouldThrowEvidence = false; changedQuantity = 2
  assert.equal((await emit()).status, 'PREVALIDATION_FAILED')
  assert.equal(beginCalls.length, 0); assert.equal(mockPosts.length, 0)
  changedQuantity = 1
  retryTargetOverride = { id: 'other' }
  assert.equal((await emit()).status, 'PREVALIDATION_FAILED')
  assert.equal(beginCalls.length, 0); assert.equal(mockPosts.length, 0)
  retryTargetOverride = undefined; startedIdOverride = 'other'
  assert.equal((await emit()).status, 'RECONCILIATION_REQUIRED')
  assert.equal(mockPosts.length, 0)
  startedIdOverride = undefined
  for (const status of ['UNKNOWN', 'SUBMITTING', 'RECONCILIATION_REQUIRED', 'CONFIRMED']) {
    attempt = { ...makeAttempt(), status }; beginCalls = []; mockPosts = []
    const blocked = await emit()
    assert.equal(blocked.status, status === 'CONFIRMED' ? 'ALREADY_INVOICED' : 'INVOICE_IN_PROGRESS')
    assert.equal(beginCalls.length, 0); assert.equal(mockPosts.length, 0)
  }
  attempt = null; beginCalls = []; mockPosts = []
  assert.equal((await emit()).status, 'BSALE_REJECTED')
  assert.equal(beginCalls.length, 1)
  assert.equal(beginCalls[0].p_fingerprint, contract.buildInvoiceEmissionIdentity(today).fingerprint)
  assert.equal(mockPosts.length, 1)
})
