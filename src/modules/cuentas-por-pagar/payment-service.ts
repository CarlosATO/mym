import type {
  GetInvoicePaymentsResult,
  InvoicePaymentBalanceSummary,
  InvoicePaymentRecord,
  InvoicePaymentReversal,
  InvoicePaymentStatus,
  InvoicePaymentsHistory,
  InvoiceValidationReopeningRecord,
  PaymentActionErrorCode,
  RegisterInvoicePaymentInput,
  RegisterInvoicePaymentResult,
  ReopenInvoiceValidationInput,
  ReopenInvoiceValidationResult,
  ReverseInvoicePaymentInput,
  ReverseInvoicePaymentResult,
} from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface RpcErrorLike {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

export interface CxpRpcClient {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcErrorLike | null }>
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function isValidCivilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !CIVIL_DATE_RE.test(value)) return false
  const [yearStr, monthStr, dayStr] = value.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const dt = new Date(Date.UTC(year, month - 1, day))
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  )
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-8
}

export interface InvoiceFinancialBreakdown {
  totalAmountClp: number
  creditNoteAmountClp: number
  netPayableAmountClp: number
  initialBalanceClp: number
  priorPaidAmountClp: number
  modulePaidAmountClp: number
  totalPaidAmountClp: number
  currentBalanceClp: number
  isFullyPaid: boolean
  canRegisterPayment: boolean
}

/**
 * Calcula el desglose financiero separando monto original, notas de crédito,
 * pagos anteriores, pagos del módulo y saldo pendiente (espejo exacto de compute_invoice_balance).
 */
export function computeInvoiceFinancialBreakdown(params: {
  totalAmount: number
  creditNoteAmountClp?: number | null
  priorPaymentStatus: InvoicePaymentBalanceSummary['prior_payment_status']
  historicalInitialBalance?: number | null
  modulePaidAmount?: number | null
}): { ok: true; data: InvoiceFinancialBreakdown } | { ok: false; error: string } {
  const totalAmountClp = Math.round(Number(params.totalAmount) * 100) / 100
  const creditNoteAmountClp =
    Math.round(Number(params.creditNoteAmountClp ?? 0) * 100) / 100
  const modulePaidAmountClp =
    Math.round(Number(params.modulePaidAmount ?? 0) * 100) / 100

  if (!Number.isFinite(totalAmountClp) || totalAmountClp <= 0) {
    return { ok: false, error: 'El monto original de la factura debe ser mayor a 0.' }
  }
  if (!Number.isFinite(creditNoteAmountClp) || creditNoteAmountClp < 0) {
    return { ok: false, error: 'El monto de nota de crédito no puede ser negativo.' }
  }
  if (creditNoteAmountClp > totalAmountClp) {
    return {
      ok: false,
      error: 'La nota de crédito no puede superar el monto original de la factura.',
    }
  }
  if (!Number.isFinite(modulePaidAmountClp) || modulePaidAmountClp < 0) {
    return { ok: false, error: 'El monto pagado en el módulo no puede ser negativo.' }
  }

  const netPayableAmountClp =
    Math.round((totalAmountClp - creditNoteAmountClp) * 100) / 100

  let initialBalanceClp = netPayableAmountClp
  if (params.priorPaymentStatus === 'NO_PRIOR_PAYMENTS') {
    initialBalanceClp = netPayableAmountClp
  } else if (params.priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS') {
    const rawInitial = params.historicalInitialBalance
    if (rawInitial == null || !Number.isFinite(Number(rawInitial))) {
      return {
        ok: false,
        error: 'Falta el saldo inicial histórico para pagos parciales previos.',
      }
    }
    initialBalanceClp = Math.round(Number(rawInitial) * 100) / 100
    if (initialBalanceClp <= 0 || initialBalanceClp >= netPayableAmountClp) {
      return {
        ok: false,
        error:
          'El saldo inicial histórico debe ser mayor a 0 y menor al monto neto tras notas de crédito.',
      }
    }
  } else if (params.priorPaymentStatus === 'FULLY_PAID_PRIOR') {
    initialBalanceClp = 0
  } else {
    return {
      ok: false,
      error: 'La situación de pagos anteriores debe estar revisada.',
    }
  }

  const priorPaidAmountClp =
    Math.round(Math.max(0, netPayableAmountClp - initialBalanceClp) * 100) / 100
  const totalPaidAmountClp =
    Math.round((priorPaidAmountClp + modulePaidAmountClp) * 100) / 100
  const currentBalanceClp =
    Math.round((initialBalanceClp - modulePaidAmountClp) * 100) / 100

  if (currentBalanceClp < 0) {
    return {
      ok: false,
      error: 'Los pagos superan el saldo neto permitido (el saldo no puede ser negativo).',
    }
  }

  return {
    ok: true,
    data: {
      totalAmountClp,
      creditNoteAmountClp,
      netPayableAmountClp,
      initialBalanceClp,
      priorPaidAmountClp,
      modulePaidAmountClp,
      totalPaidAmountClp,
      currentBalanceClp,
      isFullyPaid: currentBalanceClp === 0,
      canRegisterPayment: currentBalanceClp > 0,
    },
  }
}

function normalizeReversalRecord(raw: Record<string, unknown>): InvoicePaymentReversal {
  return {
    id: String(raw.id),
    ...(raw.company_id !== undefined ? { company_id: String(raw.company_id) } : {}),
    ...(raw.invoice_id !== undefined ? { invoice_id: String(raw.invoice_id) } : {}),
    ...(raw.payment_id !== undefined ? { payment_id: String(raw.payment_id) } : {}),
    reason: String(raw.reason),
    operation_id: String(raw.operation_id),
    created_at: String(raw.created_at),
    created_by: String(raw.created_by),
    ...(raw.created_by_name !== undefined
      ? { created_by_name: raw.created_by_name == null ? null : String(raw.created_by_name) }
      : {}),
  }
}

function normalizePaymentRecord(raw: Record<string, unknown>): InvoicePaymentRecord {
  const reversalRaw =
    raw.reversal && typeof raw.reversal === 'object'
      ? normalizeReversalRecord(raw.reversal as Record<string, unknown>)
      : null
  const isReversed =
    typeof raw.is_reversed === 'boolean'
      ? raw.is_reversed
      : raw.status === 'REVERSED' || reversalRaw !== null
  const status: InvoicePaymentStatus =
    raw.status === 'REVERSED' || isReversed ? 'REVERSED' : 'ACTIVE'

  return {
    id: String(raw.id),
    company_id: String(raw.company_id),
    invoice_id: String(raw.invoice_id),
    payment_date: String(raw.payment_date),
    amount: Number(raw.amount),
    reference: raw.reference == null ? null : String(raw.reference),
    operation_id: String(raw.operation_id),
    created_at: String(raw.created_at),
    created_by: String(raw.created_by),
    ...(raw.created_by_name !== undefined
      ? { created_by_name: raw.created_by_name == null ? null : String(raw.created_by_name) }
      : {}),
    is_reversed: isReversed,
    status,
    reversal: reversalRaw,
  }
}

function normalizeBalanceSummary(raw: Record<string, unknown>): InvoicePaymentBalanceSummary {
  return {
    invoice_id: String(raw.invoice_id),
    company_id: String(raw.company_id),
    validation_status: raw.validation_status as InvoicePaymentBalanceSummary['validation_status'],
    total_amount: raw.total_amount == null ? null : Number(raw.total_amount),
    credit_note_amount_clp: Number(raw.credit_note_amount_clp ?? 0),
    net_payable_amount:
      raw.net_payable_amount == null ? null : Number(raw.net_payable_amount),
    prior_payment_status: raw.prior_payment_status as InvoicePaymentBalanceSummary['prior_payment_status'],
    historical_initial_balance:
      raw.historical_initial_balance == null ? null : Number(raw.historical_initial_balance),
    historical_balance_cutoff_date:
      raw.historical_balance_cutoff_date == null ? null : String(raw.historical_balance_cutoff_date),
    initial_balance: raw.initial_balance == null ? null : Number(raw.initial_balance),
    prior_paid_amount: raw.prior_paid_amount == null ? null : Number(raw.prior_paid_amount),
    module_paid_amount: Number(raw.module_paid_amount ?? 0),
    total_paid_amount: raw.total_paid_amount == null ? null : Number(raw.total_paid_amount),
    current_balance: raw.current_balance == null ? null : Number(raw.current_balance),
    payment_count: Number(raw.payment_count ?? 0),
    reversed_payment_count: Number(raw.reversed_payment_count ?? 0),
    reversed_amount: Number(raw.reversed_amount ?? 0),
    is_fully_paid: Boolean(raw.is_fully_paid),
    can_register_payment: Boolean(raw.can_register_payment),
  }
}

export function classifyPaymentRpcError(
  error: RpcErrorLike | null | undefined,
  fallbackMessage: string,
): { code: PaymentActionErrorCode; error: string; uncertainOutcome: boolean } {
  const code = error?.code ?? null
  const message = (error?.message ?? '').trim()

  if (code === '42501') {
    return {
      code: 'ACCESS_DENIED',
      error: 'No tiene acceso autorizado a Cuentas por Pagar.',
      uncertainOutcome: false,
    }
  }

  if (code === 'P0001' && message) {
    const lower = message.toLowerCase()
    if (lower.includes('supera el saldo pendiente') || lower.includes('no tiene saldo pendiente')) {
      return { code: 'OVERPAYMENT', error: message, uncertainOutcome: false }
    }
    if (lower.includes('facturas validadas') || lower.includes('estado validated')) {
      return { code: 'INVOICE_NOT_VALIDATED', error: message, uncertainOutcome: false }
    }
    if (lower.includes('pagos activos vigentes') || lower.includes('anule primero los pagos activos')) {
      return { code: 'HAS_ACTIVE_PAYMENTS', error: message, uncertainOutcome: false }
    }
    if (lower.includes('ya fue reversado')) {
      return { code: 'ALREADY_REVERSED', error: message, uncertainOutcome: false }
    }
    if (
      lower.includes('fecha') ||
      lower.includes('america/santiago') ||
      lower.includes('fecha de corte')
    ) {
      return { code: 'INVALID_DATE', error: message, uncertainOutcome: false }
    }
    return { code: 'VALIDATION_ERROR', error: message, uncertainOutcome: false }
  }

  return {
    code: 'CONNECTION_OR_UNKNOWN_ERROR',
    error: fallbackMessage,
    uncertainOutcome: true,
  }
}

export function classifyThrownPaymentError(
  err: unknown,
  fallbackMessage: string,
): { code: PaymentActionErrorCode; error: string; uncertainOutcome: boolean } {
  const message = err instanceof Error ? err.message : ''
  const lower = message.toLowerCase()
  if (lower.includes('seleccione caylo') || lower.includes('usuario autorizado') || lower.includes('acceso')) {
    return {
      code: 'ACCESS_DENIED',
      error: message || 'No tiene acceso autorizado a Cuentas por Pagar.',
      uncertainOutcome: false,
    }
  }
  return {
    code: 'CONNECTION_OR_UNKNOWN_ERROR',
    error: fallbackMessage,
    uncertainOutcome: true,
  }
}

export async function fetchInvoicePayments(
  db: CxpRpcClient,
  invoiceId: string,
): Promise<GetInvoicePaymentsResult> {
  if (!isUuid(invoiceId)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Identificador de factura inválido.',
      uncertainOutcome: false,
    }
  }

  try {
    const { data, error } = await db.rpc('cxp_invoice_payments', {
      p_invoice_id: invoiceId,
    })

    if (error) {
      const classified = classifyPaymentRpcError(
        error,
        'No se pudo consultar el historial de pagos por un error de conexión o respuesta desconocida.',
      )
      return { ok: false, ...classified }
    }

    if (!data || typeof data !== 'object') {
      return {
        ok: false,
        code: 'CONNECTION_OR_UNKNOWN_ERROR',
        error: 'No se recibió una respuesta verificable al consultar los pagos de la factura.',
        uncertainOutcome: true,
      }
    }

    const raw = data as Record<string, unknown>
    const rawPayments = Array.isArray(raw.payments) ? raw.payments : []
    const history: InvoicePaymentsHistory = {
      ...normalizeBalanceSummary(raw),
      payments: rawPayments.map((item) => normalizePaymentRecord(item as Record<string, unknown>)),
    }

    return { ok: true, data: history }
  } catch (err) {
    const classified = classifyThrownPaymentError(
      err,
      'Error de conexión al consultar los pagos de la factura.',
    )
    return { ok: false, ...classified }
  }
}

export async function executeRegisterInvoicePayment(
  db: CxpRpcClient,
  input: RegisterInvoicePaymentInput,
): Promise<RegisterInvoicePaymentResult> {
  const operationId = typeof input?.operationId === 'string' ? input.operationId : ''

  if (!input || !isUuid(input.invoiceId)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Identificador de factura inválido.',
      uncertainOutcome: false,
      operationId,
    }
  }

  if (!isUuid(input.operationId)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'El identificador único de operación (operationId) es obligatorio y debe ser un UUID válido.',
      uncertainOutcome: false,
      operationId,
    }
  }

  if (!isValidCivilDate(input.paymentDate)) {
    return {
      ok: false,
      code: 'INVALID_DATE',
      error: 'La fecha efectiva del pago es obligatoria y debe tener formato YYYY-MM-DD válido.',
      uncertainOutcome: false,
      operationId: input.operationId,
    }
  }

  if (
    typeof input.amount !== 'number' ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0 ||
    !hasAtMostTwoDecimals(input.amount)
  ) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'El monto del pago debe ser un número mayor a 0 con hasta 2 decimales.',
      uncertainOutcome: false,
      operationId: input.operationId,
    }
  }

  const trimmedReference =
    input.reference == null ? null : input.reference.trim() || null
  if (trimmedReference !== null && trimmedReference.length > 500) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'La referencia u observación no puede superar los 500 caracteres.',
      uncertainOutcome: false,
      operationId: input.operationId,
    }
  }

  try {
    const { data, error } = await db.rpc('cxp_register_invoice_payment', {
      p_invoice_id: input.invoiceId,
      p_payment_date: input.paymentDate,
      p_amount: Math.round(input.amount * 100) / 100,
      p_operation_id: input.operationId,
      p_reference: trimmedReference,
    })

    if (error) {
      const classified = classifyPaymentRpcError(
        error,
        'Error de conexión o resultado desconocido al registrar el pago. Conserve el mismo operationId si reintenta.',
      )
      return {
        ok: false,
        ...classified,
        operationId: input.operationId,
      }
    }

    if (!data || typeof data !== 'object') {
      return {
        ok: false,
        code: 'CONNECTION_OR_UNKNOWN_ERROR',
        error: 'No se recibió confirmación verificable de la base de datos. No reintente con un operationId nuevo.',
        uncertainOutcome: true,
        operationId: input.operationId,
      }
    }

    const raw = data as Record<string, unknown>
    if (!raw.payment || typeof raw.payment !== 'object' || !raw.balance || typeof raw.balance !== 'object') {
      return {
        ok: false,
        code: 'CONNECTION_OR_UNKNOWN_ERROR',
        error: 'Respuesta incompleta de la base de datos al registrar el pago.',
        uncertainOutcome: true,
        operationId: input.operationId,
      }
    }

    const idempotentReplay = Boolean(raw.idempotent_replay)
    return {
      ok: true,
      code: idempotentReplay ? 'IDEMPOTENT_REPLAY' : 'PAYMENT_REGISTERED',
      idempotentReplay,
      operationId: input.operationId,
      payment: normalizePaymentRecord(raw.payment as Record<string, unknown>),
      balance: normalizeBalanceSummary(raw.balance as Record<string, unknown>),
    }
  } catch (err) {
    const classified = classifyThrownPaymentError(
      err,
      'Error de conexión o resultado desconocido al registrar el pago. Conserve el mismo operationId si reintenta.',
    )
    return {
      ok: false,
      ...classified,
      operationId: input.operationId,
    }
  }
}

export type EnableHistoricalPreBodegaResult =
  | {
    ok: true
    idempotentReplay: boolean
    invoiceId: string
    validationStatus: 'VALIDATED'
    origin: 'HISTORICAL_IMPORT'
    dueDate: string | null
    balance: InvoicePaymentBalanceSummary
  }
  | {
    ok: false
    code: PaymentActionErrorCode
    error: string
  }

/**
 * Habilita una factura histórica pre-Bodega (< 01/10/2026) mediante la RPC autorizada,
 * reutilizando el saldo conciliado Excel ↔ Bsale y separando notas de crédito de pagos.
 */
export async function executeEnableHistoricalPreBodegaInvoice(
  db: CxpRpcClient,
  bsaleDocumentId: number,
): Promise<EnableHistoricalPreBodegaResult> {
  if (!Number.isInteger(bsaleDocumentId) || bsaleDocumentId <= 0) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Identificador de documento Bsale inválido.',
    }
  }

  try {
    const { data, error } = await db.rpc('cxp_enable_historical_pending_invoice', {
      p_bsale_document_id: bsaleDocumentId,
    })

    if (error || !data || typeof data !== 'object') {
      const classified = classifyPaymentRpcError(
        error,
        'No se pudo habilitar la factura histórica pre-Bodega.',
      )
      return {
        ok: false,
        code: classified.code,
        error: classified.error,
      }
    }

    const raw = data as Record<string, unknown>
    if (!isUuid(raw.invoice_id) || !raw.balance || typeof raw.balance !== 'object') {
      return {
        ok: false,
        code: 'CONNECTION_OR_UNKNOWN_ERROR',
        error: 'Respuesta incompleta al habilitar la factura histórica.',
      }
    }

    return {
      ok: true,
      idempotentReplay: Boolean(raw.idempotent_replay),
      invoiceId: String(raw.invoice_id),
      validationStatus: 'VALIDATED',
      origin: 'HISTORICAL_IMPORT',
      dueDate: raw.due_date == null ? null : String(raw.due_date),
      balance: normalizeBalanceSummary(raw.balance as Record<string, unknown>),
    }
  } catch (err) {
    const classified = classifyThrownPaymentError(
      err,
      'No se pudo habilitar la factura histórica pre-Bodega.',
    )
    return {
      ok: false,
      code: classified.code,
      error: classified.error,
    }
  }
}


export async function executeReverseInvoicePayment(
  db: CxpRpcClient,
  input: ReverseInvoicePaymentInput,
): Promise<ReverseInvoicePaymentResult> {
  const operationId = typeof input?.operationId === 'string' ? input.operationId : ''

  if (!input || !isUuid(input.paymentId)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Identificador de pago inválido.',
      uncertainOutcome: false,
      operationId,
    }
  }

  if (!isUuid(input.operationId)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'El identificador único de operación (operationId) es obligatorio y debe ser un UUID válido.',
      uncertainOutcome: false,
      operationId,
    }
  }

  const trimmedReason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (trimmedReason.length < 3 || trimmedReason.length > 500) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'El motivo de reversa es obligatorio y debe tener entre 3 y 500 caracteres.',
      uncertainOutcome: false,
      operationId: input.operationId,
    }
  }

  try {
    const { data, error } = await db.rpc('cxp_reverse_invoice_payment', {
      p_payment_id: input.paymentId,
      p_operation_id: input.operationId,
      p_reason: trimmedReason,
    })

    if (error) {
      const classified = classifyPaymentRpcError(
        error,
        'Error de conexión o resultado desconocido al reversar el pago. Conserve el mismo operationId si reintenta.',
      )
      return {
        ok: false,
        ...classified,
        operationId: input.operationId,
      }
    }

    if (!data || typeof data !== 'object') {
      return {
        ok: false,
        code: 'CONNECTION_OR_UNKNOWN_ERROR',
        error: 'No se recibió confirmación verificable de la base de datos. No reintente con un operationId nuevo.',
        uncertainOutcome: true,
        operationId: input.operationId,
      }
    }

    const raw = data as Record<string, unknown>
    if (
      !raw.reversal ||
      typeof raw.reversal !== 'object' ||
      !raw.payment ||
      typeof raw.payment !== 'object' ||
      !raw.balance ||
      typeof raw.balance !== 'object'
    ) {
      return {
        ok: false,
        code: 'CONNECTION_OR_UNKNOWN_ERROR',
        error: 'Respuesta incompleta de la base de datos al reversar el pago.',
        uncertainOutcome: true,
        operationId: input.operationId,
      }
    }

    const idempotentReplay = Boolean(raw.idempotent_replay)
    return {
      ok: true,
      code: idempotentReplay ? 'IDEMPOTENT_REPLAY' : 'REVERSAL_REGISTERED',
      idempotentReplay,
      operationId: input.operationId,
      reversal: normalizeReversalRecord(raw.reversal as Record<string, unknown>),
      payment: normalizePaymentRecord(raw.payment as Record<string, unknown>),
      balance: normalizeBalanceSummary(raw.balance as Record<string, unknown>),
    }
  } catch (err) {
    const classified = classifyThrownPaymentError(
      err,
      'Error de conexión o resultado desconocido al reversar el pago. Conserve el mismo operationId si reintenta.',
    )
    return {
      ok: false,
      ...classified,
      operationId: input.operationId,
    }
  }
}

function normalizeValidationReopeningRecord(
  raw: Record<string, unknown>,
): InvoiceValidationReopeningRecord {
  return {
    id: String(raw.id),
    company_id: String(raw.company_id),
    invoice_id: String(raw.invoice_id),
    reason: String(raw.reason),
    operation_id: String(raw.operation_id),
    previous_validation_status:
      raw.previous_validation_status as InvoiceValidationReopeningRecord['previous_validation_status'],
    previous_prior_payment_status:
      raw.previous_prior_payment_status as InvoiceValidationReopeningRecord['previous_prior_payment_status'],
    previous_total_amount:
      raw.previous_total_amount == null
        ? null
        : Number(raw.previous_total_amount),
    previous_validated_at:
      raw.previous_validated_at == null
        ? null
        : String(raw.previous_validated_at),
    previous_validated_by:
      raw.previous_validated_by == null
        ? null
        : String(raw.previous_validated_by),
    created_at: String(raw.created_at),
    created_by: String(raw.created_by),
  }
}

export async function executeReopenInvoiceValidation(
  db: CxpRpcClient,
  input: ReopenInvoiceValidationInput,
): Promise<ReopenInvoiceValidationResult> {
  const operationId =
    typeof input?.operationId === 'string' ? input.operationId : ''

  if (!input || !isUuid(input.invoiceId)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Identificador de factura inválido.',
      uncertainOutcome: false,
      operationId,
    }
  }

  if (!isUuid(input.operationId)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error:
        'El identificador único de operación (operationId) es obligatorio y debe ser un UUID válido.',
      uncertainOutcome: false,
      operationId,
    }
  }

  const trimmedReason =
    typeof input.reason === 'string' ? input.reason.trim() : ''
  if (trimmedReason.length < 3 || trimmedReason.length > 500) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error:
        'El motivo de reapertura es obligatorio y debe tener entre 3 y 500 caracteres.',
      uncertainOutcome: false,
      operationId: input.operationId,
    }
  }

  try {
    const { data, error } = await db.rpc('cxp_reopen_invoice_validation', {
      p_invoice_id: input.invoiceId,
      p_operation_id: input.operationId,
      p_reason: trimmedReason,
    })

    if (error) {
      const classified = classifyPaymentRpcError(
        error,
        'Error de conexión o resultado desconocido al reabrir la validación. Conserve el mismo operationId si reintenta.',
      )
      return {
        ok: false,
        ...classified,
        operationId: input.operationId,
      }
    }

    if (!data || typeof data !== 'object') {
      return {
        ok: false,
        code: 'CONNECTION_OR_UNKNOWN_ERROR',
        error:
          'No se recibió confirmación verificable de la base de datos. No reintente con un operationId nuevo.',
        uncertainOutcome: true,
        operationId: input.operationId,
      }
    }

    const raw = data as Record<string, unknown>
    if (
      !raw.reopening ||
      typeof raw.reopening !== 'object' ||
      !raw.balance ||
      typeof raw.balance !== 'object'
    ) {
      return {
        ok: false,
        code: 'CONNECTION_OR_UNKNOWN_ERROR',
        error:
          'Respuesta incompleta de la base de datos al reabrir la validación de la factura.',
        uncertainOutcome: true,
        operationId: input.operationId,
      }
    }

    const idempotentReplay = Boolean(raw.idempotent_replay)
    return {
      ok: true,
      code: idempotentReplay ? 'IDEMPOTENT_REPLAY' : 'VALIDATION_REOPENED',
      idempotentReplay,
      operationId: input.operationId,
      reopening: normalizeValidationReopeningRecord(
        raw.reopening as Record<string, unknown>,
      ),
      balance: normalizeBalanceSummary(raw.balance as Record<string, unknown>),
    }
  } catch (err) {
    const classified = classifyThrownPaymentError(
      err,
      'Error de conexión o resultado desconocido al reabrir la validación. Conserve el mismo operationId si reintenta.',
    )
    return {
      ok: false,
      ...classified,
      operationId: input.operationId,
    }
  }
}
