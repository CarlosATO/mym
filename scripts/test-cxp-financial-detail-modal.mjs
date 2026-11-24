import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  applyConfirmedPaymentToHistory,
  applyConfirmedReversalToHistory,
  buildFinancialStripModel,
  buildInitialConfirmationDraft,
  evaluateConfirmationDiscrepancy,
  executeConfirmInvoiceFromPanel,
  getFinancialDetailFetchPlan,
  resolveDefaultPaymentAmountText,
  resolveFinancialStatusBadge,
  resolveOperationIdForAttempt,
  shouldFetchPaymentsAfterDetail,
  validateInvoiceConfirmationDraft,
  validatePaymentFormDraft,
} from '../src/modules/cuentas-por-pagar/financial-detail-model.ts'

const root = new URL('../src/modules/cuentas-por-pagar/', import.meta.url)
const modalSource = await readFile(new URL('invoice-financial-detail-modal.tsx', root), 'utf8')
const inboxSource = await readFile(new URL('invoice-inbox.tsx', root), 'utf8')

function makeTarget(overrides = {}) {
  return {
    candidate: {
      candidate_id: 'cand-1',
      issuer_rut: '761234567',
      supplier_name: 'ATOMPET CHILE SPA',
      folio: '4079',
      issue_date: '2026-11-20',
      due_date: '2026-12-18',
      purchase_orders: ['OC-2026-000077'],
      receipt_ids: ['rec-1'],
      reference_amount: 9936381,
      has_document: true,
      invoice_id: 'inv-1',
      invoice_status: 'VALIDATED',
      blocked_reason: null,
      purchase_type: 'PRODUCTS',
      reception_status: 'RECEIVED',
      service_description: null,
      ...(overrides.candidate ?? {}),
    },
    summary: overrides.summary,
    effectiveStatus: overrides.effectiveStatus ?? 'VALIDATED',
    state: overrides.state ?? 'VALIDATED',
    effectiveIssueDate: overrides.effectiveIssueDate ?? '2026-11-20',
    effectiveDueDate: overrides.effectiveDueDate ?? '2026-12-18',
    dueSource: overrides.dueSource ?? 'PURCHASE_ORDER',
    hasInboxDocument: overrides.hasInboxDocument ?? true,
  }
}

test('Plan de carga bajo demanda: solo consulta pagos en facturas incorporadas y validadas', () => {
  const notIncorporated = getFinancialDetailFetchPlan(
    makeTarget({
      candidate: { invoice_id: null, invoice_status: null },
      effectiveStatus: null,
      state: 'NEW',
    }),
  )
  assert.deepEqual(notIncorporated, {
    invoiceId: null,
    shouldFetchInvoiceDetail: false,
    shouldFetchPayments: false,
  })

  const pending = getFinancialDetailFetchPlan(
    makeTarget({
      candidate: { invoice_status: 'PENDING' },
      effectiveStatus: 'PENDING',
      state: 'PENDING',
    }),
  )
  assert.deepEqual(pending, {
    invoiceId: 'inv-1',
    shouldFetchInvoiceDetail: true,
    shouldFetchPayments: false,
  })

  const validated = getFinancialDetailFetchPlan(makeTarget())
  assert.deepEqual(validated, {
    invoiceId: 'inv-1',
    shouldFetchInvoiceDetail: true,
    shouldFetchPayments: true,
  })

  assert.equal(shouldFetchPaymentsAfterDetail('VALIDATED', false), true)
  assert.equal(shouldFetchPaymentsAfterDetail('VALIDATED', true), false)
  assert.equal(shouldFetchPaymentsAfterDetail('PENDING', false), false)
})

test('Factura NEW y PENDING: precarga propuesta referencial, fechas y pagos anteriores sin inventar deuda validada', () => {
  const newTarget = makeTarget({
    candidate: { invoice_id: null, invoice_status: null, reference_amount: 9936381 },
    effectiveStatus: null,
    state: 'NEW',
  })

  const draft = buildInitialConfirmationDraft(newTarget, null, '2026-11-22')
  assert.equal(draft.totalAmountText, '9936381')
  assert.equal(draft.referenceAmountRounded, 9936381)
  assert.equal(draft.isReferenceProposal, true)
  assert.equal(draft.issueDate, '2026-11-20')
  assert.equal(draft.dueDate, '2026-12-18')
  assert.equal(draft.priorPaymentStatus, 'NO_PRIOR_PAYMENTS')

  // La franja superior mantiene Total factura como "Por confirmar" y propuesta no validada
  const newStrip = buildFinancialStripModel({
    target: newTarget,
    detail: null,
    payments: null,
    paymentsLoading: false,
    paymentsError: null,
  })
  assert.equal(newStrip.confirmed, false)
  assert.equal(newStrip.totalLabel, 'Por confirmar')
  assert.match(newStrip.totalSubtext ?? '', /Propuesta ref\..*no validada/)
  assert.equal(newStrip.paidLabel, '—')
  assert.equal(newStrip.balanceLabel, '—')
})

test('Confirmación de factura: diferencias de monto/fecha, datos incompletos y pagos históricos', () => {
  const newTarget = makeTarget({
    candidate: { invoice_id: null, invoice_status: null, reference_amount: 9936381 },
    effectiveStatus: null,
    state: 'NEW',
  })

  // 1. Confirmación exacta con propuesta referencial -> ok sin requerir nota
  const exactOk = validateInvoiceConfirmationDraft({
    target: newTarget,
    detail: null,
    totalAmountText: '9.936.381',
    issueDate: '2026-11-20',
    dueDate: '2026-12-18',
    priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
    historicalInitialBalanceText: '',
    historicalBalanceCutoffDate: '',
    discrepancyResolutionNote: '',
  })
  assert.equal(exactOk.ok, true)
  assert.equal(exactOk.discrepancy.hasAnyDiscrepancy, false)
  assert.equal(exactOk.payload.totalAmount, 9936381)
  assert.equal(exactOk.payload.discrepancyResolutionNote, null)

  // 2. Diferencia de monto vs recepción sin justificación -> bloquea confirmación
  const diffBlocked = validateInvoiceConfirmationDraft({
    target: newTarget,
    detail: null,
    totalAmountText: '9.950.000',
    issueDate: '2026-11-20',
    dueDate: '2026-12-18',
    priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
    historicalInitialBalanceText: '',
    historicalBalanceCutoffDate: '',
    discrepancyResolutionNote: 'corta',
  })
  assert.equal(diffBlocked.ok, false)
  assert.equal(diffBlocked.discrepancy.hasAmountDiscrepancy, true)
  assert.equal(diffBlocked.discrepancy.amountDifference, 13619)
  assert.ok(diffBlocked.errors.some(e => /justificación de al menos 10 caracteres/i.test(e)))

  // 3. Diferencia de monto con justificación >= 10 chars -> permite confirmar
  const diffResolved = validateInvoiceConfirmationDraft({
    target: newTarget,
    detail: null,
    totalAmountText: '9.950.000',
    issueDate: '2026-11-20',
    dueDate: '2026-12-18',
    priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
    historicalInitialBalanceText: '',
    historicalBalanceCutoffDate: '',
    discrepancyResolutionNote: 'Ajuste por flete incluido en factura real del proveedor',
  })
  assert.equal(diffResolved.ok, true)
  assert.equal(
    diffResolved.payload.discrepancyResolutionNote,
    'Ajuste por flete incluido en factura real del proveedor',
  )

  // 4. Datos incompletos: sin vencimiento o abonos previos sin saldo de apertura válido
  const incomplete = validateInvoiceConfirmationDraft({
    target: newTarget,
    detail: null,
    totalAmountText: '9936381',
    issueDate: '2026-11-20',
    dueDate: '',
    priorPaymentStatus: 'PARTIAL_PRIOR_PAYMENTS',
    historicalInitialBalanceText: '10000000', // >= total
    historicalBalanceCutoffDate: '2026-11-15', // < issueDate
    discrepancyResolutionNote: '',
  })
  assert.equal(incomplete.ok, false)
  assert.ok(incomplete.errors.some(e => /vencimiento es obligatoria/i.test(e)))
  assert.ok(incomplete.errors.some(e => /saldo de apertura pendiente/i.test(e)))
  assert.ok(incomplete.errors.some(e => /fecha de corte/i.test(e)))
})

test('Escenario 1: Incorporación confirmada pero validación falla devuelve invoiceId y estado PENDING para reintentar solo validación', async () => {
  let incorporateCalls = 0
  let saveCalls = 0

  const validationFixture = {
    id: 'inv-incorporated-1',
    validation_status: 'VALIDATED',
    issue_date: '2026-11-20',
    due_date: '2026-12-18',
    net_amount: null,
    tax_amount: null,
    total_amount: 9936381,
    prior_payment_status: 'NO_PRIOR_PAYMENTS',
    historical_initial_balance: null,
    historical_balance_cutoff_date: null,
    discrepancy_status: 'NONE',
    discrepancy_resolution_note: null,
    validated_at: '2026-11-22T21:00:00Z',
    validated_by: 'u-1',
    reference_gross_amount: 9936381,
    reference_gross_rounded: 9936381,
    amount_difference: 0,
    has_amount_discrepancy: false,
    has_date_discrepancy: false,
  }

  let failValidationOnce = true
  const deps = {
    async incorporateCandidate(candidateId) {
      incorporateCalls += 1
      assert.equal(candidateId, 'cand-1')
      return { ok: true, invoiceId: 'inv-incorporated-1', wasIncorporated: true }
    },
    async saveValidation(input) {
      saveCalls += 1
      assert.equal(input.invoiceId, 'inv-incorporated-1')
      if (failValidationOnce) {
        failValidationOnce = false
        return {
          ok: false,
          error: 'Existen diferencias sin resolver respecto a las recepciones vinculadas',
        }
      }
      return { ok: true, data: validationFixture }
    },
  }

  const partialFail = await executeConfirmInvoiceFromPanel(deps, {
    candidateId: 'cand-1',
    invoiceId: null,
    issueDate: '2026-11-20',
    dueDate: '2026-12-18',
    totalAmount: 9936381,
    priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
    historicalInitialBalance: null,
    historicalBalanceCutoffDate: null,
    discrepancyResolutionNote: null,
  })

  assert.equal(partialFail.ok, false)
  assert.equal(partialFail.incorporatedInvoiceId, 'inv-incorporated-1')
  assert.equal(partialFail.validationStatus, 'PENDING')
  assert.equal(incorporateCalls, 1)
  assert.equal(saveCalls, 1)

  const secondTry = await executeConfirmInvoiceFromPanel(deps, {
    candidateId: 'cand-1',
    invoiceId: partialFail.incorporatedInvoiceId,
    issueDate: '2026-11-20',
    dueDate: '2026-12-18',
    totalAmount: 9936381,
    priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
    historicalInitialBalance: null,
    historicalBalanceCutoffDate: null,
    discrepancyResolutionNote: 'Diferencia de fecha verificada con bodega',
  })

  assert.equal(secondTry.ok, true)
  assert.equal(secondTry.invoiceId, 'inv-incorporated-1')
  assert.equal(secondTry.validationStatus, 'VALIDATED')
  assert.equal(secondTry.wasIncorporated, false)
  assert.equal(incorporateCalls, 1, 'No debe repetir la incorporación tras fallo parcial')
  assert.equal(saveCalls, 2)
})

test('Escenario 2: Validación confirmada pero getInvoicePayments falla o RPC no existe conserva VALIDATED y reporta historial no disponible', async () => {
  const validationFixture = {
    id: 'inv-val-2',
    validation_status: 'VALIDATED',
    issue_date: '2026-11-20',
    due_date: '2026-12-18',
    net_amount: null,
    tax_amount: null,
    total_amount: 500000,
    prior_payment_status: 'NO_PRIOR_PAYMENTS',
    historical_initial_balance: null,
    historical_balance_cutoff_date: null,
    discrepancy_status: 'NONE',
    discrepancy_resolution_note: null,
    validated_at: '2026-11-22T21:05:00Z',
    validated_by: 'u-1',
    reference_gross_amount: 500000,
    reference_gross_rounded: 500000,
    amount_difference: 0,
    has_amount_discrepancy: false,
    has_date_discrepancy: false,
  }

  // Caso 2A: loadPayments devuelve { ok: false, error } (ej. RPC cxp_invoice_payments aún no aplicada)
  const resRpcError = await executeConfirmInvoiceFromPanel(
    {
      async incorporateCandidate() {
        return { ok: true, invoiceId: 'inv-val-2', wasIncorporated: true }
      },
      async saveValidation() {
        return { ok: true, data: validationFixture }
      },
      async loadPayments() {
        return {
          ok: false,
          error: 'Could not find the function public.cxp_invoice_payments(p_invoice_id) in the schema cache',
        }
      },
    },
    {
      candidateId: 'cand-2',
      invoiceId: 'inv-val-2',
      issueDate: '2026-11-20',
      dueDate: '2026-12-18',
      totalAmount: 500000,
      priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
      historicalInitialBalance: null,
      historicalBalanceCutoffDate: null,
      discrepancyResolutionNote: null,
    },
  )

  assert.equal(resRpcError.ok, true, 'La confirmación de la factura debe considerarse exitosa')
  assert.equal(resRpcError.validationStatus, 'VALIDATED')
  assert.equal(resRpcError.payments, null)
  assert.ok(resRpcError.paymentsError, 'Debe informar que el historial de pagos no está disponible')

  // Caso 2B: loadPayments lanza excepción de red
  const resThrown = await executeConfirmInvoiceFromPanel(
    {
      async incorporateCandidate() {
        return { ok: true, invoiceId: 'inv-val-2' }
      },
      async saveValidation() {
        return { ok: true, data: validationFixture }
      },
      async loadPayments() {
        throw new Error('fetch failed')
      },
    },
    {
      candidateId: 'cand-2',
      invoiceId: 'inv-val-2',
      issueDate: '2026-11-20',
      dueDate: '2026-12-18',
      totalAmount: 500000,
      priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
      historicalInitialBalance: null,
      historicalBalanceCutoffDate: null,
      discrepancyResolutionNote: null,
    },
  )

  assert.equal(resThrown.ok, true)
  assert.equal(resThrown.validationStatus, 'VALIDATED')
  assert.equal(resThrown.payments, null)
  assert.match(resThrown.paymentsError ?? '', /temporalmente no disponible/i)
})

test('Escenario 3: Reintentos sobre factura ya validada no incorporan duplicados ni repiten saveValidation', async () => {
  let incorporateCalls = 0
  let saveCalls = 0

  const validatedDetail = {
    invoice: {
      id: 'inv-already-val',
      company_id: 'd1000000-0000-0000-0000-000000000001',
      supplier_id: 'sup-1',
      issuer_rut: '761234567',
      document_type: 'FA',
      document_folio: '4079',
      issue_date: '2026-11-20',
      due_date: '2026-12-18',
      net_amount: null,
      tax_amount: null,
      total_amount: 9936381,
      prior_payment_status: 'NO_PRIOR_PAYMENTS',
      historical_initial_balance: null,
      historical_balance_cutoff_date: null,
      discrepancy_status: 'NONE',
      discrepancy_resolution_note: null,
      origin: 'RECEIPT',
      validation_status: 'VALIDATED',
      validated_at: '2026-11-22T21:00:00Z',
      validated_by: 'u-1',
      validated_by_name: 'María González',
    },
    supplier: {
      id: 'sup-1',
      business_name: 'ATOMPET CHILE SPA',
      fantasy_name: null,
      rut: '76123456-7',
      payment_terms: null,
      credit_days: 30,
    },
    purchase_orders: [],
    receipts: [],
    documents: [],
    reference: {
      linked_receipts_count: 1,
      cancelled_linked_receipts_count: 0,
      unlinked_completed_receipts_count: 0,
      reference_net_amount: 0,
      reference_tax_amount: 0,
      reference_gross_amount: 9936381,
      reference_gross_rounded: 9936381,
      receipt_document_dates: ['2026-11-20'],
      missing_receipt_dates_count: 0,
    },
  }

  const retryRes = await executeConfirmInvoiceFromPanel(
    {
      async incorporateCandidate() {
        incorporateCalls += 1
        return { ok: true, invoiceId: 'inv-already-val', wasIncorporated: false }
      },
      async saveValidation() {
        saveCalls += 1
        return { ok: false, error: 'Solo se pueden editar o validar facturas en estado PENDING' }
      },
      async loadDetail() {
        return { ok: true, data: validatedDetail }
      },
      async loadPayments() {
        return { ok: false, error: 'RPC no disponible' }
      },
    },
    {
      candidateId: 'cand-1',
      invoiceId: 'inv-already-val',
      issueDate: '2026-11-20',
      dueDate: '2026-12-18',
      totalAmount: 9936381,
      priorPaymentStatus: 'NO_PRIOR_PAYMENTS',
      historicalInitialBalance: null,
      historicalBalanceCutoffDate: null,
      discrepancyResolutionNote: null,
    },
  )

  assert.equal(retryRes.ok, true)
  assert.equal(retryRes.validationStatus, 'VALIDATED')
  assert.equal(retryRes.alreadyValidated, true)
  assert.equal(incorporateCalls, 0, 'No debe llamar incorporación cuando invoiceId ya existe')
  assert.equal(saveCalls, 0, 'No debe repetir saveValidation cuando la factura ya está VALIDATED')
})

test('Formulario de pago total vs abono, idempotencia y reversa siguen operativos tras confirmación', () => {
  assert.equal(resolveDefaultPaymentAmountText('FULL', 350000), '350000')
  assert.equal(resolveDefaultPaymentAmountText('PARTIAL', 350000), '')

  const fullOk = validatePaymentFormDraft({
    mode: 'FULL',
    amountText: '350.000',
    paymentDate: '2026-11-22',
    referenceText: 'TEF 900',
    currentBalance: 350000,
    todaySantiago: '2026-11-22',
  })
  assert.equal(fullOk.ok, true)
  assert.equal(fullOk.amount, 350000)

  let seq = 0
  const gen = () => `op-${++seq}`
  const first = resolveOperationIdForAttempt(null, 'inv-1|PARTIAL|100000|2026-11-22|', gen)
  const retrySame = resolveOperationIdForAttempt(first, 'inv-1|PARTIAL|100000|2026-11-22|', gen)
  assert.equal(first.operationId, retrySame.operationId)

  const baseBalance = {
    invoice_id: 'inv-1',
    company_id: 'c1',
    validation_status: 'VALIDATED',
    total_amount: 500000,
    prior_payment_status: 'NO_PRIOR_PAYMENTS',
    historical_initial_balance: null,
    historical_balance_cutoff_date: null,
    initial_balance: 500000,
    prior_paid_amount: 0,
    module_paid_amount: 150000,
    total_paid_amount: 150000,
    current_balance: 350000,
    payment_count: 1,
    reversed_payment_count: 0,
    reversed_amount: 0,
    is_fully_paid: false,
    can_register_payment: true,
  }
  const paymentRecord = {
    id: 'pay-1',
    company_id: 'c1',
    invoice_id: 'inv-1',
    payment_date: '2026-11-20',
    amount: 150000,
    reference: 'TEF 1',
    operation_id: 'op-1',
    created_at: '2026-11-20T12:00:00Z',
    created_by: 'u-1',
    created_by_name: 'María González',
    is_reversed: false,
    status: 'ACTIVE',
    reversal: null,
  }
  const afterPay = applyConfirmedPaymentToHistory(null, paymentRecord, baseBalance)
  const afterReversal = applyConfirmedReversalToHistory(
    afterPay,
    {
      id: 'rev-1',
      reason: 'Error de digitación',
      operation_id: 'op-rev-1',
      created_at: '2026-11-22T15:00:00Z',
      created_by: 'u-2',
      created_by_name: 'Carlos Gerente',
    },
    { ...paymentRecord, is_reversed: true, status: 'REVERSED' },
    {
      ...baseBalance,
      module_paid_amount: 0,
      total_paid_amount: 0,
      current_balance: 500000,
      payment_count: 0,
      reversed_payment_count: 1,
      reversed_amount: 150000,
    },
  )
  assert.equal(afterReversal.current_balance, 500000)
  assert.equal(afterReversal.payments[0].status, 'REVERSED')
  assert.equal(resolveFinancialStatusBadge('VALIDATED', 'VALIDATED', afterReversal).label, 'Validada')
})

test('Contrato UI: panel lateral incluye Confirmar factura, Historial de pagos y abonos y sincronización con bandeja', () => {
  assert.match(modalSource, /Confirmar factura/)
  assert.match(modalSource, /Propuesta pendiente de confirmación/)
  assert.match(modalSource, /Sin pagos/)
  assert.match(modalSource, /Abonos anteriores/)
  assert.match(modalSource, /Factura ya pagada/)
  assert.match(modalSource, /confirmInvoiceFromFinancialPanel\(/)
  assert.match(modalSource, /Historial de pagos y abonos/)
  assert.match(inboxSource, /BsaleReconciliationDetailPanel/)
  assert.match(inboxSource, /Por pagar según Excel/)
  assert.match(inboxSource, /Pagadas según Excel/)
  assert.match(inboxSource, /Sin clasificar/)
})
