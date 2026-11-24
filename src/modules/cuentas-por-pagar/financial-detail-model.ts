import type {
  DiscrepancyStatus,
  InvoiceDetail,
  InvoiceInboxSummary,
  InvoicePaymentBalanceSummary,
  InvoicePaymentRecord,
  InvoicePaymentReversal,
  InvoicePaymentsHistory,
  InvoiceValidationStatus,
  PriorPaymentStatus,
  PurchaseType,
  ReceiptInvoiceCandidate,
  SaveInvoiceValidationResult,
} from './types'

export type PaymentMovementMode = 'FULL' | 'PARTIAL'

export interface OperationAttemptTracker {
  signature: string
  operationId: string
}

export interface FinancialDetailTarget {
  candidate: ReceiptInvoiceCandidate
  summary?: InvoiceInboxSummary
  effectiveStatus: InvoiceValidationStatus | string | null
  state: 'NEW' | 'PENDING' | 'VALIDATED' | 'OTHER'
  effectiveIssueDate: string | null
  effectiveDueDate: string | null
  dueSource: 'SAVED' | 'MANUAL' | 'PURCHASE_ORDER' | 'SUPPLIER' | null
  hasInboxDocument: boolean | null
}

export interface FinancialDetailFetchPlan {
  invoiceId: string | null
  shouldFetchInvoiceDetail: boolean
  shouldFetchPayments: boolean
}

export interface FinancialStripModel {
  totalLabel: string
  totalSubtext: string | null
  paidLabel: string
  paidSubtext: string | null
  balanceLabel: string
  balanceSubtext: string | null
  confirmed: boolean
}

export interface FinancialStatusBadgeModel {
  label: string
  tone: 'neutral' | 'amber' | 'emerald' | 'red' | 'sky'
}

export interface InvoiceConfirmationInitialDraft {
  totalAmountText: string
  referenceAmountRounded: number | null
  isReferenceProposal: boolean
  issueDate: string
  dueDate: string
  priorPaymentStatus: PriorPaymentStatus
  historicalInitialBalanceText: string
  historicalBalanceCutoffDate: string
  discrepancyResolutionNote: string
}

export interface InvoiceConfirmationDiscrepancyInfo {
  referenceAmountRounded: number | null
  amountDifference: number | null
  hasAmountDiscrepancy: boolean
  hasDateDiscrepancy: boolean
  hasAnyDiscrepancy: boolean
  structuralBlockers: string[]
}

export interface ConfirmInvoiceFromPanelInput {
  candidateId: string
  invoiceId: string | null
  purchaseType?: PurchaseType
  issueDate: string
  dueDate: string | null
  totalAmount: number | null
  netAmount?: number | null
  taxAmount?: number | null
  priorPaymentStatus: PriorPaymentStatus
  historicalInitialBalance: number | null
  historicalBalanceCutoffDate: string | null
  discrepancyResolutionNote: string | null
}

export type ConfirmInvoiceFromPanelResult =
  | {
      ok: true
      invoiceId: string
      validationStatus: 'VALIDATED'
      wasIncorporated: boolean
      alreadyValidated: boolean
      validation: SaveInvoiceValidationResult
      detail: InvoiceDetail | null
      payments: InvoicePaymentsHistory | null
      paymentsError: string | null
    }
  | {
      ok: false
      error: string
      incorporatedInvoiceId: string | null
      validationStatus: 'PENDING' | null
      detail?: InvoiceDetail | null
    }

const clpFormatter = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'CLP',
  maximumFractionDigits: 0,
})

const clpDetailedFormatter = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'CLP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

export function formatFinancialClp(
  amount: number | null | undefined,
  options?: { allowDecimals?: boolean },
): string {
  if (amount == null || !Number.isFinite(Number(amount))) return '—'
  const numeric = Number(amount)
  if (options?.allowDecimals && Math.abs(numeric - Math.round(numeric)) >= 0.005) {
    return clpDetailedFormatter.format(numeric)
  }
  return clpFormatter.format(numeric)
}

export function amountToEditableString(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) return ''
  const num = Number(value)
  if (Math.abs(num - Math.round(num)) < 0.005) return String(Math.round(num))
  return String(Math.round(num * 100) / 100)
}

export function parseClpAmountInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withoutCurrency = trimmed.replace(/\$/g, '').replace(/\s+/g, '')
  let normalized = withoutCurrency

  if (/^-?\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(withoutCurrency)) {
    normalized = withoutCurrency.replace(/\./g, '').replace(',', '.')
  } else if (/^-?\d+(,\d{1,2})$/.test(withoutCurrency)) {
    normalized = withoutCurrency.replace(',', '.')
  } else if (/^-?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(withoutCurrency)) {
    normalized = withoutCurrency.replace(/,/g, '')
  }

  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function isValidCivilDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const dt = new Date(Date.UTC(year, month - 1, day))
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  )
}

export function buildInitialConfirmationDraft(
  target: FinancialDetailTarget,
  detail: InvoiceDetail | null,
  todaySantiago: string,
): InvoiceConfirmationInitialDraft {
  const refAmountRaw =
    detail?.reference?.reference_gross_rounded ??
    (target.candidate.reference_amount != null
      ? Math.round(Number(target.candidate.reference_amount))
      : null)
  const referenceAmountRounded =
    refAmountRaw != null && Number.isFinite(refAmountRaw) && refAmountRaw > 0
      ? Math.round(refAmountRaw)
      : null

  const savedTotal = detail?.invoice.total_amount ?? target.summary?.total_amount ?? null
  const effectiveInitialTotal =
    savedTotal != null && Number(savedTotal) > 0 ? Number(savedTotal) : referenceAmountRounded

  const savedPriorStatus =
    detail?.invoice.prior_payment_status ?? target.summary?.prior_payment_status ?? 'UNREVIEWED'
  // Preselecciona NO_PRIOR_PAYMENTS cuando aún está UNREVIEWED para evitar pasos innecesarios,
  // manteniendo visible el selector de 3 opciones.
  const priorPaymentStatus: PriorPaymentStatus =
    savedPriorStatus === 'UNREVIEWED' ? 'NO_PRIOR_PAYMENTS' : savedPriorStatus

  const savedInitialBal =
    detail?.invoice.historical_initial_balance ??
    target.summary?.historical_initial_balance ??
    null
  const savedCutoff =
    detail?.invoice.historical_balance_cutoff_date ??
    target.summary?.historical_balance_cutoff_date ??
    null

  const issueDate =
    detail?.invoice.issue_date ??
    target.effectiveIssueDate ??
    target.candidate.issue_date ??
    ''
  const dueDate =
    detail?.invoice.due_date ??
    target.effectiveDueDate ??
    target.candidate.due_date ??
    ''

  return {
    totalAmountText: amountToEditableString(effectiveInitialTotal),
    referenceAmountRounded,
    isReferenceProposal: savedTotal == null,
    issueDate,
    dueDate,
    priorPaymentStatus,
    historicalInitialBalanceText:
      priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS'
        ? amountToEditableString(savedInitialBal)
        : '',
    historicalBalanceCutoffDate:
      priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS' ||
      priorPaymentStatus === 'FULLY_PAID_PRIOR'
        ? savedCutoff || todaySantiago
        : '',
    discrepancyResolutionNote: detail?.invoice.discrepancy_resolution_note ?? '',
  }
}

export function evaluateConfirmationDiscrepancy(args: {
  target: FinancialDetailTarget
  detail: InvoiceDetail | null
  totalAmount: number | null
  issueDate: string
}): InvoiceConfirmationDiscrepancyInfo {
  const { target, detail, totalAmount, issueDate } = args
  const structuralBlockers: string[] = []

  if (!target.candidate.invoice_id && target.candidate.blocked_reason) {
    structuralBlockers.push(target.candidate.blocked_reason)
  }

  const totalValid =
    totalAmount !== null && Number.isFinite(totalAmount) && totalAmount > 0
  const issueValid = Boolean(issueDate && isValidCivilDateString(issueDate))

  if (detail) {
    const ref = detail.reference
    const completedCount = Number(ref.linked_receipts_count ?? 0)
    const cancelledCount = Number(ref.cancelled_linked_receipts_count ?? 0)
    const unlinkedCount = Number(ref.unlinked_completed_receipts_count ?? 0)
    const missingDatesCount = Number(ref.missing_receipt_dates_count ?? 0)
    const refDates = Array.isArray(ref.receipt_document_dates) ? ref.receipt_document_dates : []
    const referenceAmountRounded =
      completedCount > 0 ? Math.round(Number(ref.reference_gross_amount ?? 0)) : null

    if (detail.invoice.origin === 'RECEIPT') {
      if (completedCount === 0) {
        structuralBlockers.push('La factura no cuenta con recepciones completadas vinculadas.')
      }
      if (cancelledCount > 0) {
        structuralBlockers.push('Existen recepciones vinculadas anuladas o incompletas.')
      }
      if (unlinkedCount > 0) {
        structuralBlockers.push(
          'Existen recepciones completadas recientes para este folio sin incorporar.',
        )
      }
    }

    const amountDifference =
      totalValid && referenceAmountRounded !== null
        ? Math.round(((totalAmount as number) - referenceAmountRounded) * 100) / 100
        : null

    const hasAmountDiscrepancy =
      totalValid &&
      referenceAmountRounded !== null &&
      Math.round((totalAmount as number) * 100) !== Math.round(referenceAmountRounded * 100)

    const hasDateDiscrepancy =
      completedCount > 0 &&
      issueValid &&
      (missingDatesCount > 0 || refDates.length !== 1 || refDates[0] !== issueDate)

    return {
      referenceAmountRounded,
      amountDifference,
      hasAmountDiscrepancy,
      hasDateDiscrepancy,
      hasAnyDiscrepancy: hasAmountDiscrepancy || hasDateDiscrepancy,
      structuralBlockers,
    }
  }

  // Factura NEW (aún sin detail de DB): compara contra la referencia consolidada del candidato
  const isReceiptCandidate = target.candidate.purchase_type !== 'SERVICES'
  const candRef =
    isReceiptCandidate && target.candidate.reference_amount != null
      ? Math.round(Number(target.candidate.reference_amount))
      : null

  const amountDifference =
    totalValid && candRef !== null
      ? Math.round(((totalAmount as number) - candRef) * 100) / 100
      : null

  const hasAmountDiscrepancy =
    totalValid &&
    candRef !== null &&
    Math.round((totalAmount as number) * 100) !== Math.round(candRef * 100)

  const hasDateDiscrepancy =
    isReceiptCandidate &&
    issueValid &&
    Boolean(target.candidate.issue_date) &&
    target.candidate.issue_date !== issueDate

  return {
    referenceAmountRounded: candRef,
    amountDifference,
    hasAmountDiscrepancy,
    hasDateDiscrepancy,
    hasAnyDiscrepancy: hasAmountDiscrepancy || hasDateDiscrepancy,
    structuralBlockers,
  }
}

export function validateInvoiceConfirmationDraft(args: {
  target: FinancialDetailTarget
  detail: InvoiceDetail | null
  totalAmountText: string
  issueDate: string
  dueDate: string
  priorPaymentStatus: PriorPaymentStatus
  historicalInitialBalanceText: string
  historicalBalanceCutoffDate: string
  discrepancyResolutionNote: string
}):
  | {
      ok: true
      payload: ConfirmInvoiceFromPanelInput
      discrepancy: InvoiceConfirmationDiscrepancyInfo
    }
  | {
      ok: false
      errors: string[]
      discrepancy: InvoiceConfirmationDiscrepancyInfo
    } {
  const errors: string[] = []
  const parsedTotal = parseClpAmountInput(args.totalAmountText)
  const totalValid =
    parsedTotal !== null && !Number.isNaN(parsedTotal) && parsedTotal > 0
  const roundedTotal = totalValid ? Math.round(parsedTotal * 100) / 100 : null

  const issueTrimmed = args.issueDate.trim()
  const dueTrimmed = args.dueDate.trim()

  const discrepancy = evaluateConfirmationDiscrepancy({
    target: args.target,
    detail: args.detail,
    totalAmount: roundedTotal,
    issueDate: issueTrimmed,
  })

  if (discrepancy.structuralBlockers.length > 0) {
    errors.push(...discrepancy.structuralBlockers)
  }

  if (!totalValid || roundedTotal === null) {
    errors.push('Ingrese el monto total real de la factura (mayor a $0).')
  }

  if (!issueTrimmed || !isValidCivilDateString(issueTrimmed)) {
    errors.push('La fecha de emisión es obligatoria y debe ser válida.')
  }

  if (!dueTrimmed || !isValidCivilDateString(dueTrimmed)) {
    errors.push('La fecha de vencimiento es obligatoria para confirmar la factura.')
  } else if (
    issueTrimmed &&
    isValidCivilDateString(issueTrimmed) &&
    dueTrimmed < issueTrimmed
  ) {
    errors.push('La fecha de vencimiento no puede ser anterior a la emisión.')
  }

  if (args.priorPaymentStatus === 'UNREVIEWED') {
    errors.push('Seleccione la situación de pagos anteriores.')
  }

  let historicalInitialBalance: number | null = null
  let historicalBalanceCutoffDate: string | null = null

  if (args.priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS') {
    const parsedBal = parseClpAmountInput(args.historicalInitialBalanceText)
    if (
      parsedBal === null ||
      Number.isNaN(parsedBal) ||
      parsedBal <= 0 ||
      (roundedTotal !== null && parsedBal >= roundedTotal)
    ) {
      errors.push(
        'El saldo de apertura pendiente debe ser mayor a $0 y menor al monto total de la factura.',
      )
    } else {
      historicalInitialBalance = Math.round(parsedBal * 100) / 100
    }

    const cutoffTrimmed = args.historicalBalanceCutoffDate.trim()
    if (!cutoffTrimmed || !isValidCivilDateString(cutoffTrimmed)) {
      errors.push('La fecha de corte del saldo de apertura es obligatoria.')
    } else if (
      issueTrimmed &&
      isValidCivilDateString(issueTrimmed) &&
      cutoffTrimmed < issueTrimmed
    ) {
      errors.push('La fecha de corte del saldo inicial no puede ser anterior a la emisión.')
    } else {
      historicalBalanceCutoffDate = cutoffTrimmed
    }
  } else if (args.priorPaymentStatus === 'FULLY_PAID_PRIOR') {
    historicalInitialBalance = 0
    const cutoffTrimmed = args.historicalBalanceCutoffDate.trim()
    if (!cutoffTrimmed || !isValidCivilDateString(cutoffTrimmed)) {
      errors.push('La fecha de corte es obligatoria para facturas pagadas con anterioridad.')
    } else if (
      issueTrimmed &&
      isValidCivilDateString(issueTrimmed) &&
      cutoffTrimmed < issueTrimmed
    ) {
      errors.push('La fecha de corte no puede ser anterior a la fecha de emisión.')
    } else {
      historicalBalanceCutoffDate = cutoffTrimmed
    }
  }

  const noteTrimmed = args.discrepancyResolutionNote.trim()
  if (discrepancy.hasAnyDiscrepancy && noteTrimmed.length < 10) {
    errors.push(
      'Existe diferencia respecto a la recepción (monto o fecha). Ingrese una justificación de al menos 10 caracteres para confirmar.',
    )
  }

  if (errors.length > 0 || roundedTotal === null) {
    return {
      ok: false,
      errors,
      discrepancy,
    }
  }

  // Preserva Neto/IVA solo si siguen cuadrando con el monto total confirmado;
  // en caso contrario envía NULL/NULL (o recalcula en servicios) para respetar invoices_tax_breakdown_chk.
  const existingNet = args.detail?.invoice.net_amount ?? args.target.summary?.net_amount ?? null
  const existingTax = args.detail?.invoice.tax_amount ?? args.target.summary?.tax_amount ?? null
  const purchaseType =
    args.detail?.invoice.purchase_type ?? args.target.candidate.purchase_type ?? 'PRODUCTS'

  let netAmount: number | null = null
  let taxAmount: number | null = null

  if (
    existingNet !== null &&
    existingTax !== null &&
    Math.round((Number(existingNet) + Number(existingTax)) * 100) ===
      Math.round(roundedTotal * 100)
  ) {
    netAmount = Number(existingNet)
    taxAmount = Number(existingTax)
  } else if (purchaseType === 'SERVICES') {
    const roundedIntTotal = Math.round(roundedTotal)
    netAmount = Math.round(roundedIntTotal / 1.19)
    taxAmount = roundedIntTotal - netAmount
  }

  return {
    ok: true,
    discrepancy,
    payload: {
      candidateId: args.target.candidate.candidate_id,
      invoiceId: args.detail?.invoice.id ?? args.target.candidate.invoice_id ?? null,
      purchaseType,
      issueDate: issueTrimmed,
      dueDate: dueTrimmed,
      totalAmount: roundedTotal,
      netAmount,
      taxAmount,
      priorPaymentStatus: args.priorPaymentStatus,
      historicalInitialBalance,
      historicalBalanceCutoffDate,
      discrepancyResolutionNote: discrepancy.hasAnyDiscrepancy ? noteTrimmed : null,
    },
  }
}

function toValidationResultFromDetail(detail: InvoiceDetail): SaveInvoiceValidationResult {
  const inv = detail.invoice
  const refRounded = Math.round(Number(detail.reference.reference_gross_rounded ?? 0))
  const total = inv.total_amount != null ? Number(inv.total_amount) : null
  const diff = total !== null ? Math.round((total - refRounded) * 100) / 100 : null
  return {
    id: inv.id,
    validation_status: inv.validation_status,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    net_amount: inv.net_amount,
    tax_amount: inv.tax_amount,
    total_amount: inv.total_amount,
    prior_payment_status: inv.prior_payment_status,
    historical_initial_balance: inv.historical_initial_balance,
    historical_balance_cutoff_date: inv.historical_balance_cutoff_date,
    discrepancy_status: inv.discrepancy_status,
    discrepancy_resolution_note: inv.discrepancy_resolution_note,
    validated_at: inv.validated_at,
    validated_by: inv.validated_by,
    reference_gross_amount: Number(detail.reference.reference_gross_amount ?? 0),
    reference_gross_rounded: refRounded,
    amount_difference: diff,
    has_amount_discrepancy: diff !== null && Math.abs(diff) >= 0.005,
    has_date_discrepancy: false,
  }
}

export async function executeConfirmInvoiceFromPanel(
  deps: {
    incorporateCandidate: (candidateId: string) => Promise<{ ok: true; invoiceId: string; wasIncorporated?: boolean } | { ok: false; error: string }>
    saveValidation: (input: {
      invoiceId: string
      issueDate: string
      dueDate: string | null
      netAmount: number | null
      taxAmount: number | null
      totalAmount: number | null
      priorPaymentStatus: PriorPaymentStatus
      historicalInitialBalance: number | null
      historicalBalanceCutoffDate: string | null
      resolveDiscrepancy: boolean
      discrepancyResolutionNote: string | null
      confirmValidation: boolean
    }) => Promise<{ ok: true; data: SaveInvoiceValidationResult } | { ok: false; error: string }>
    loadDetail?: (invoiceId: string) => Promise<{ ok: true; data: InvoiceDetail } | { ok: false; error: string }>
    loadPayments?: (invoiceId: string) => Promise<{ ok: true; data: InvoicePaymentsHistory } | { ok: false; error: string }>
  },
  input: ConfirmInvoiceFromPanelInput,
): Promise<ConfirmInvoiceFromPanelResult> {
  let resolvedInvoiceId = input.invoiceId
  let wasIncorporated = false

  if (!resolvedInvoiceId) {
    try {
      const inc = await deps.incorporateCandidate(input.candidateId)
      if (!inc.ok) {
        return {
          ok: false,
          error: inc.error,
          incorporatedInvoiceId: null,
          validationStatus: null,
        }
      }
      resolvedInvoiceId = inc.invoiceId
      wasIncorporated = inc.wasIncorporated ?? true
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'No se pudo incorporar la factura.',
        incorporatedInvoiceId: null,
        validationStatus: null,
      }
    }
  }

  // Si la factura ya fue validada previamente (ej. reintento tras confirmación exitosa),
  // no repetir saveValidation.
  if (deps.loadDetail) {
    const preDetail = await deps.loadDetail(resolvedInvoiceId).catch(() => null)
    if (preDetail && preDetail.ok && preDetail.data.invoice.validation_status === 'VALIDATED') {
      const paymentsRes = deps.loadPayments
        ? await deps.loadPayments(resolvedInvoiceId).catch(() => ({
            ok: false as const,
            error: 'Historial de pagos temporalmente no disponible.',
          }))
        : null
      return {
        ok: true,
        invoiceId: resolvedInvoiceId,
        validationStatus: 'VALIDATED',
        wasIncorporated,
        alreadyValidated: true,
        validation: toValidationResultFromDetail(preDetail.data),
        detail: preDetail.data,
        payments: paymentsRes && paymentsRes.ok ? paymentsRes.data : null,
        paymentsError:
          paymentsRes && !paymentsRes.ok
            ? paymentsRes.error || 'Historial de pagos temporalmente no disponible.'
            : null,
      }
    }
  }

  const noteTrimmed = input.discrepancyResolutionNote?.trim() || null
  const resolveDiscrepancy = Boolean(noteTrimmed && noteTrimmed.length >= 10)

  let saveRes: { ok: true; data: SaveInvoiceValidationResult } | { ok: false; error: string }
  try {
    saveRes = await deps.saveValidation({
      invoiceId: resolvedInvoiceId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      netAmount: input.netAmount ?? null,
      taxAmount: input.taxAmount ?? null,
      totalAmount: input.totalAmount,
      priorPaymentStatus: input.priorPaymentStatus,
      historicalInitialBalance: input.historicalInitialBalance,
      historicalBalanceCutoffDate: input.historicalBalanceCutoffDate,
      resolveDiscrepancy,
      discrepancyResolutionNote: resolveDiscrepancy ? noteTrimmed : null,
      confirmValidation: true,
    })
  } catch (err) {
    saveRes = {
      ok: false,
      error: err instanceof Error ? err.message : 'No se pudo validar la factura.',
    }
  }

  if (!saveRes.ok) {
    const fallbackDetail = deps.loadDetail
      ? await deps.loadDetail(resolvedInvoiceId).catch(() => null)
      : null

    // Si en paralelo o en un intento previo ya quedó VALIDATED, devolver éxito idempotente
    if (
      fallbackDetail &&
      fallbackDetail.ok &&
      fallbackDetail.data.invoice.validation_status === 'VALIDATED'
    ) {
      const paymentsRes = deps.loadPayments
        ? await deps.loadPayments(resolvedInvoiceId).catch(() => ({
            ok: false as const,
            error: 'Historial de pagos temporalmente no disponible.',
          }))
        : null
      return {
        ok: true,
        invoiceId: resolvedInvoiceId,
        validationStatus: 'VALIDATED',
        wasIncorporated,
        alreadyValidated: true,
        validation: toValidationResultFromDetail(fallbackDetail.data),
        detail: fallbackDetail.data,
        payments: paymentsRes && paymentsRes.ok ? paymentsRes.data : null,
        paymentsError:
          paymentsRes && !paymentsRes.ok
            ? paymentsRes.error || 'Historial de pagos temporalmente no disponible.'
            : null,
      }
    }

    return {
      ok: false,
      error: saveRes.error,
      incorporatedInvoiceId: resolvedInvoiceId,
      validationStatus: 'PENDING',
      detail: fallbackDetail && fallbackDetail.ok ? fallbackDetail.data : null,
    }
  }

  const [detailRes, paymentsRes] = await Promise.all([
    deps.loadDetail ? deps.loadDetail(resolvedInvoiceId).catch(() => null) : Promise.resolve(null),
    deps.loadPayments
      ? deps.loadPayments(resolvedInvoiceId).catch(() => ({
          ok: false as const,
          error: 'Historial de pagos temporalmente no disponible.',
        }))
      : Promise.resolve(null),
  ])

  const paymentsLoaded = paymentsRes && paymentsRes.ok ? paymentsRes.data : null
  const paymentsError =
    paymentsRes && !paymentsRes.ok
      ? paymentsRes.error || 'Historial de pagos temporalmente no disponible.'
      : null

  return {
    ok: true,
    invoiceId: resolvedInvoiceId,
    validationStatus: 'VALIDATED',
    wasIncorporated,
    alreadyValidated: false,
    validation: saveRes.data,
    detail: detailRes && detailRes.ok ? detailRes.data : null,
    payments: paymentsLoaded,
    paymentsError,
  }
}

export function resolveDefaultPaymentAmountText(
  mode: PaymentMovementMode,
  currentBalance: number | null | undefined,
): string {
  if (mode === 'FULL') {
    return amountToEditableString(currentBalance)
  }
  return ''
}

export function resolveOperationIdForAttempt(
  previous: OperationAttemptTracker | null,
  signature: string,
  generateId: () => string,
): OperationAttemptTracker {
  if (previous && previous.signature === signature && previous.operationId) {
    return previous
  }
  return {
    signature,
    operationId: generateId(),
  }
}

export function validatePaymentFormDraft(input: {
  mode: PaymentMovementMode
  amountText: string
  paymentDate: string
  referenceText: string
  currentBalance: number | null | undefined
  todaySantiago: string
  priorPaymentStatus?: PriorPaymentStatus | null
  historicalBalanceCutoffDate?: string | null
}):
  | {
      ok: true
      amount: number
      paymentDate: string
      reference: string | null
    }
  | {
      ok: false
      error: string
    } {
  const balance = input.currentBalance != null ? Number(input.currentBalance) : 0
  if (!Number.isFinite(balance) || balance <= 0) {
    return { ok: false, error: 'La factura no tiene saldo pendiente por pagar.' }
  }

  const parsedAmount =
    input.mode === 'FULL' && !input.amountText.trim()
      ? balance
      : parseClpAmountInput(input.amountText)

  if (parsedAmount === null || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
    return { ok: false, error: 'Ingrese un monto en CLP válido y mayor a $0.' }
  }

  const roundedAmount = Math.round(parsedAmount * 100) / 100
  if (roundedAmount > balance + 0.0001) {
    return {
      ok: false,
      error: `El monto ingresado (${formatFinancialClp(roundedAmount, { allowDecimals: true })}) supera el saldo disponible (${formatFinancialClp(balance, { allowDecimals: true })}).`,
    }
  }

  if (input.mode === 'FULL' && Math.abs(roundedAmount - balance) >= 0.005) {
    return {
      ok: false,
      error: `Para Pago total el monto debe coincidir con el saldo vigente (${formatFinancialClp(balance, { allowDecimals: true })}), o seleccione «Abono».`,
    }
  }

  const dateTrimmed = input.paymentDate.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTrimmed)) {
    return { ok: false, error: 'Seleccione una fecha efectiva de pago válida.' }
  }

  if (input.todaySantiago && dateTrimmed > input.todaySantiago) {
    return {
      ok: false,
      error: 'La fecha efectiva del pago no puede ser futura respecto de Chile.',
    }
  }

  if (
    input.priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS' &&
    input.historicalBalanceCutoffDate &&
    dateTrimmed <= input.historicalBalanceCutoffDate
  ) {
    return {
      ok: false,
      error: `La fecha del pago debe ser posterior a la fecha de corte histórico (${input.historicalBalanceCutoffDate}).`,
    }
  }

  const trimmedRef = input.referenceText.trim() || null
  if (trimmedRef && trimmedRef.length > 500) {
    return {
      ok: false,
      error: 'La referencia u observación no puede superar los 500 caracteres.',
    }
  }

  return {
    ok: true,
    amount: roundedAmount,
    paymentDate: dateTrimmed,
    reference: trimmedRef,
  }
}

export function applyConfirmedPaymentToHistory(
  current: InvoicePaymentsHistory | null,
  payment: InvoicePaymentRecord,
  balance: InvoicePaymentBalanceSummary,
): InvoicePaymentsHistory {
  const existingPayments = current?.payments ?? []
  const alreadyPresent = existingPayments.some(item => item.id === payment.id)
  const nextPayments = alreadyPresent
    ? existingPayments.map(item => (item.id === payment.id ? { ...item, ...payment } : item))
    : [...existingPayments, payment]

  nextPayments.sort((a, b) => {
    if (a.payment_date !== b.payment_date) return a.payment_date.localeCompare(b.payment_date)
    if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at)
    return a.id.localeCompare(b.id)
  })

  return {
    ...balance,
    payments: nextPayments,
  }
}

export function applyConfirmedReversalToHistory(
  current: InvoicePaymentsHistory | null,
  reversal: InvoicePaymentReversal,
  payment: InvoicePaymentRecord,
  balance: InvoicePaymentBalanceSummary,
): InvoicePaymentsHistory {
  const existingPayments = current?.payments ?? []
  const nextPayments = existingPayments.map(item => {
    if (item.id !== payment.id) return item
    return {
      ...item,
      ...payment,
      created_by_name: item.created_by_name ?? payment.created_by_name ?? null,
      is_reversed: true,
      status: 'REVERSED' as const,
      reversal: {
        ...reversal,
        created_by_name: reversal.created_by_name ?? item.reversal?.created_by_name ?? null,
      },
    }
  })

  return {
    ...balance,
    payments: nextPayments,
  }
}

export function getFinancialDetailFetchPlan(target: FinancialDetailTarget): FinancialDetailFetchPlan {
  const invoiceId = target.candidate.invoice_id ?? null
  if (!invoiceId) {
    return {
      invoiceId: null,
      shouldFetchInvoiceDetail: false,
      shouldFetchPayments: false,
    }
  }

  return {
    invoiceId,
    shouldFetchInvoiceDetail: true,
    shouldFetchPayments: target.effectiveStatus === 'VALIDATED',
  }
}

export function shouldFetchPaymentsAfterDetail(
  detailStatus: InvoiceValidationStatus | null | undefined,
  alreadyRequested: boolean,
): boolean {
  return detailStatus === 'VALIDATED' && !alreadyRequested
}

export function resolveFinancialStatusBadge(
  state: FinancialDetailTarget['state'],
  effectiveStatus: InvoiceValidationStatus | string | null,
  payments: InvoicePaymentsHistory | null,
): FinancialStatusBadgeModel {
  if (state === 'NEW') {
    return { label: 'Por incorporar', tone: 'neutral' }
  }
  if (effectiveStatus === 'PENDING' || state === 'PENDING') {
    return { label: 'Pendiente de validación', tone: 'amber' }
  }
  if (effectiveStatus === 'REJECTED') {
    return { label: 'Rechazada', tone: 'red' }
  }
  if (effectiveStatus === 'VALIDATED' || state === 'VALIDATED') {
    if (payments?.is_fully_paid) {
      return { label: 'Validada · Saldada', tone: 'emerald' }
    }
    if (payments && (payments.total_paid_amount ?? 0) > 0) {
      return { label: 'Validada · Pago parcial', tone: 'sky' }
    }
    return { label: 'Validada', tone: 'emerald' }
  }
  return {
    label: effectiveStatus ? String(effectiveStatus) : 'Sin estado',
    tone: 'neutral',
  }
}

export function priorPaymentShortLabel(status: PriorPaymentStatus | null | undefined): string {
  switch (status) {
    case 'NO_PRIOR_PAYMENTS':
      return 'Sin pagos previos'
    case 'PARTIAL_PRIOR_PAYMENTS':
      return 'Pagos parciales previos'
    case 'FULLY_PAID_PRIOR':
      return 'Pagada con anterioridad'
    case 'UNREVIEWED':
      return 'Sin revisar'
    default:
      return 'Sin revisar'
  }
}

export function buildFinancialStripModel(args: {
  target: FinancialDetailTarget
  detail: InvoiceDetail | null
  payments: InvoicePaymentsHistory | null
  paymentsLoading: boolean
  paymentsError: string | null
}): FinancialStripModel {
  const { target, detail, payments, paymentsLoading, paymentsError } = args
  const { candidate, summary, state } = target
  const status = detail?.invoice.validation_status ?? target.effectiveStatus

  if (!candidate.invoice_id || state === 'NEW') {
    return {
      totalLabel: 'Por confirmar',
      totalSubtext:
        candidate.reference_amount != null
          ? `Propuesta ref. ${formatFinancialClp(candidate.reference_amount)} (no validada)`
          : 'Factura sin incorporar',
      paidLabel: '—',
      paidSubtext: 'Sin incorporar',
      balanceLabel: '—',
      balanceSubtext: 'Pendiente de confirmación',
      confirmed: false,
    }
  }

  const draftTotal = detail?.invoice.total_amount ?? summary?.total_amount ?? null

  if (status === 'REJECTED') {
    return {
      totalLabel: draftTotal != null ? formatFinancialClp(draftTotal, { allowDecimals: true }) : '—',
      totalSubtext: 'Factura rechazada',
      paidLabel: '—',
      paidSubtext: 'No aplica',
      balanceLabel: '—',
      balanceSubtext: 'Obligación rechazada',
      confirmed: false,
    }
  }

  if (status !== 'VALIDATED') {
    return {
      totalLabel: draftTotal != null ? formatFinancialClp(draftTotal, { allowDecimals: true }) : 'Por confirmar',
      totalSubtext:
        draftTotal != null
          ? 'Importe borrador · Sin validar'
          : candidate.reference_amount != null
            ? `Propuesta ref. ${formatFinancialClp(candidate.reference_amount)} (no validada)`
            : 'Pendiente de validación',
      paidLabel: '—',
      paidSubtext: 'Disponible al confirmar',
      balanceLabel: '—',
      balanceSubtext: 'Saldo sin confirmar',
      confirmed: false,
    }
  }

  const validatedTotal = payments?.total_amount ?? draftTotal
  const taxBreakdownText =
    detail?.invoice.net_amount != null && detail?.invoice.tax_amount != null
      ? `Neto ${formatFinancialClp(detail.invoice.net_amount)} · IVA ${formatFinancialClp(detail.invoice.tax_amount)}`
      : 'Obligación validada'

  if (paymentsLoading) {
    return {
      totalLabel: validatedTotal != null ? formatFinancialClp(validatedTotal, { allowDecimals: true }) : 'Cargando…',
      totalSubtext: taxBreakdownText,
      paidLabel: 'Cargando…',
      paidSubtext: 'Consultando movimientos',
      balanceLabel: 'Cargando…',
      balanceSubtext: 'Calculando saldo',
      confirmed: false,
    }
  }

  if (paymentsError || !payments) {
    return {
      totalLabel: validatedTotal != null ? formatFinancialClp(validatedTotal, { allowDecimals: true }) : 'No disponible',
      totalSubtext: taxBreakdownText,
      paidLabel: 'No disponible',
      paidSubtext: 'Error al consultar',
      balanceLabel: 'No disponible',
      balanceSubtext: 'Reintente la consulta',
      confirmed: false,
    }
  }

  const priorPaid = Number(payments.prior_paid_amount ?? 0)
  const modulePaid = Number(payments.module_paid_amount ?? 0)
  let paidSubtext = 'Sin pagos registrados'
  if (priorPaid > 0 && modulePaid > 0) {
    paidSubtext = `Previos ${formatFinancialClp(priorPaid, { allowDecimals: true })} · ERP ${formatFinancialClp(modulePaid, { allowDecimals: true })}`
  } else if (priorPaid > 0) {
    paidSubtext = 'Pagos históricos previos'
  } else if (modulePaid > 0) {
    paidSubtext = `${payments.payment_count} ${payments.payment_count === 1 ? 'pago en ERP' : 'pagos en ERP'}`
  }

  let balanceSubtext = 'Pendiente de pago'
  if (payments.is_fully_paid) {
    balanceSubtext =
      payments.prior_payment_status === 'FULLY_PAID_PRIOR' && payments.payment_count === 0
        ? 'Saldada con anterioridad'
        : 'Saldada'
  } else if (payments.reversed_payment_count > 0) {
    balanceSubtext = `${payments.reversed_payment_count} ${payments.reversed_payment_count === 1 ? 'movimiento reversado' : 'movimientos reversados'}`
  }

  return {
    totalLabel: formatFinancialClp(payments.total_amount, { allowDecimals: true }),
    totalSubtext: taxBreakdownText,
    paidLabel: formatFinancialClp(payments.total_paid_amount, { allowDecimals: true }),
    paidSubtext,
    balanceLabel: formatFinancialClp(payments.current_balance, { allowDecimals: true }),
    balanceSubtext,
    confirmed: true,
  }
}

export type { DiscrepancyStatus }
