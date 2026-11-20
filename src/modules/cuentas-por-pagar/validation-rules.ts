import type {
  DiscrepancyStatus,
  InvoiceReferenceSummary,
  PriorPaymentStatus,
} from './types.ts'

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

export function formatClp(amount: number | null | undefined, options?: { allowDecimals?: boolean }): string {
  if (amount == null || !Number.isFinite(Number(amount))) return '—'
  const numeric = Number(amount)
  if (options?.allowDecimals && Math.abs(numeric - Math.round(numeric)) >= 0.005) {
    return clpDetailedFormatter.format(numeric)
  }
  return clpFormatter.format(numeric)
}

export function formatRut(rut: string | null | undefined): string {
  if (!rut) return 'Sin RUT'
  const cleaned = rut.replace(/[.-\s]/g, '').toUpperCase()
  if (cleaned.length < 2) return rut
  const body = cleaned.slice(0, -1)
  const dv = cleaned.slice(-1)
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${dv}`
}

export function parseNumericAmount(raw: string): number | null {
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

export function calculateChileanTaxBreakdown(totalAmount: number): { netAmount: number; taxAmount: number } {
  const roundedTotal = Math.round(totalAmount)
  const netAmount = Math.round(roundedTotal / 1.19)
  const taxAmount = roundedTotal - netAmount
  return { netAmount, taxAmount }
}

function isValidCivilDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function addDaysToCivilDate(civilDate: string, days: number): string | null {
  if (!isValidCivilDate(civilDate) || !Number.isFinite(days)) return null
  const [year, month, day] = civilDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + Math.trunc(days)))
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0')
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export interface InvoiceValidationEvaluationInput {
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
}

export interface InvoiceValidationEvaluation {
  referenceGrossRounded: number
  amountDifference: number | null
  amountDifferencePercent: number | null
  hasAmountDiscrepancy: boolean
  hasDateDiscrepancy: boolean
  hasAnyDiscrepancy: boolean
  effectiveDiscrepancyStatus: DiscrepancyStatus
  openingPendingBalance: number | null
  priorPaidAmount: number | null
  hardErrors: string[]
  validationBlockers: string[]
  canSavePending: boolean
  canConfirmValidation: boolean
  checklist: {
    consistentData: boolean
    openingBalanceReviewed: boolean
    noUnresolvedDiscrepancies: boolean
    receiptsConsistent: boolean
  }
}

export function evaluateInvoiceValidation(
  input: InvoiceValidationEvaluationInput,
  reference: InvoiceReferenceSummary,
  origin: 'MANUAL' | 'RECEIPT' | 'HISTORICAL_IMPORT' = 'RECEIPT',
): InvoiceValidationEvaluation {
  const hardErrors: string[] = []
  const validationBlockers: string[] = []

  const referenceGrossRounded = Math.round(Number(reference.reference_gross_amount ?? 0))
  const issueValid = Boolean(input.issueDate && isValidCivilDate(input.issueDate))
  if (!issueValid) {
    hardErrors.push('La fecha de emisión es obligatoria y debe tener un formato válido.')
  }

  const dueTrimmed = input.dueDate?.trim() || null
  if (dueTrimmed) {
    if (!isValidCivilDate(dueTrimmed)) {
      hardErrors.push('La fecha de vencimiento no es válida.')
    } else if (issueValid && dueTrimmed < input.issueDate) {
      hardErrors.push('La fecha de vencimiento no puede ser anterior a la fecha de emisión.')
    }
  }

  const totalProvided = input.totalAmount !== null
  const totalValid = input.totalAmount !== null && Number.isFinite(input.totalAmount) && input.totalAmount > 0
  if (totalProvided && !totalValid) {
    hardErrors.push('El monto total real debe ser mayor a 0.')
  }

  const hasNet = input.netAmount !== null
  const hasTax = input.taxAmount !== null
  if (hasNet !== hasTax) {
    hardErrors.push('Debe informar tanto el monto neto como el IVA, o dejar ambos vacíos.')
  } else if (hasNet && hasTax) {
    const net = input.netAmount as number
    const tax = input.taxAmount as number
    if (!Number.isFinite(net) || net < 0 || !Number.isFinite(tax) || tax < 0) {
      hardErrors.push('Neto e IVA deben ser montos válidos mayores o iguales a 0.')
    } else if (!totalValid || Math.round((net + tax) * 100) !== Math.round((input.totalAmount as number) * 100)) {
      hardErrors.push('La suma de neto más IVA debe coincidir exactamente con el monto total real.')
    }
  }

  let openingPendingBalance: number | null = null
  let priorPaidAmount: number | null = null

  if (input.priorPaymentStatus === 'UNREVIEWED' || input.priorPaymentStatus === 'NO_PRIOR_PAYMENTS') {
    if (input.historicalInitialBalance !== null || Boolean(input.historicalBalanceCutoffDate?.trim())) {
      hardErrors.push('No corresponde registrar saldo de apertura ni fecha de corte para la situación seleccionada.')
    }
    if (input.priorPaymentStatus === 'NO_PRIOR_PAYMENTS' && totalValid) {
      openingPendingBalance = Math.round((input.totalAmount as number) * 100) / 100
      priorPaidAmount = 0
    }
  } else if (input.priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS') {
    if (!totalValid) {
      hardErrors.push('Debe registrar el monto total real antes de informar un saldo de apertura parcial.')
    } else {
      const bal = input.historicalInitialBalance
      if (bal === null || !Number.isFinite(bal) || bal <= 0 || bal >= (input.totalAmount as number)) {
        hardErrors.push('El saldo inicial pendiente debe ser mayor a $0 y menor al monto total de la factura.')
      } else {
        openingPendingBalance = Math.round(bal * 100) / 100
        priorPaidAmount = Math.round(((input.totalAmount as number) - bal) * 100) / 100
      }
    }
    const cutoff = input.historicalBalanceCutoffDate?.trim() || null
    if (!cutoff || !isValidCivilDate(cutoff)) {
      hardErrors.push('La fecha de corte del saldo de apertura es obligatoria.')
    } else if (issueValid && cutoff < input.issueDate) {
      hardErrors.push('La fecha de corte del saldo inicial no puede ser anterior a la emisión.')
    }
  } else if (input.priorPaymentStatus === 'FULLY_PAID_PRIOR') {
    if (!totalValid) {
      hardErrors.push('Debe registrar el monto total real antes de marcar la factura como pagada con anterioridad.')
    } else if (input.historicalInitialBalance !== null && Number(input.historicalInitialBalance) !== 0) {
      hardErrors.push('Una factura pagada totalmente con anterioridad debe tener saldo de apertura igual a $0.')
    } else {
      openingPendingBalance = 0
      priorPaidAmount = Math.round((input.totalAmount as number) * 100) / 100
    }
    const cutoff = input.historicalBalanceCutoffDate?.trim() || null
    if (!cutoff || !isValidCivilDate(cutoff)) {
      hardErrors.push('La fecha de corte del saldo inicial es obligatoria.')
    } else if (issueValid && cutoff < input.issueDate) {
      hardErrors.push('La fecha de corte del saldo inicial no puede ser anterior a la emisión.')
    }
  }

  const completedCount = Number(reference.linked_receipts_count ?? 0)
  const cancelledCount = Number(reference.cancelled_linked_receipts_count ?? 0)
  const unlinkedCount = Number(reference.unlinked_completed_receipts_count ?? 0)
  const missingDatesCount = Number(reference.missing_receipt_dates_count ?? 0)
  const refDates = Array.isArray(reference.receipt_document_dates) ? reference.receipt_document_dates : []

  const amountDifference =
    totalValid && completedCount > 0
      ? Math.round(((input.totalAmount as number) - referenceGrossRounded) * 100) / 100
      : null

  const amountDifferencePercent =
    amountDifference !== null && referenceGrossRounded > 0
      ? Math.round((amountDifference / referenceGrossRounded) * 1000) / 10
      : null

  const hasAmountDiscrepancy =
    totalValid &&
    completedCount > 0 &&
    Math.round((input.totalAmount as number) * 100) !== Math.round(referenceGrossRounded * 100)

  const hasDateDiscrepancy =
    completedCount > 0 &&
    issueValid &&
    (missingDatesCount > 0 || refDates.length !== 1 || refDates[0] !== input.issueDate)

  const hasAnyDiscrepancy = hasAmountDiscrepancy || hasDateDiscrepancy
  const noteTrimmed = input.discrepancyResolutionNote?.trim() ?? ''

  let effectiveDiscrepancyStatus: DiscrepancyStatus = 'NONE'
  if (hasAnyDiscrepancy) {
    if (input.resolveDiscrepancy && noteTrimmed.length >= 10) {
      effectiveDiscrepancyStatus = 'RESOLVED'
    } else {
      effectiveDiscrepancyStatus = 'UNRESOLVED'
    }
  }

  if (hasAnyDiscrepancy && input.resolveDiscrepancy && noteTrimmed.length < 10) {
    hardErrors.push('La justificación de resolución de discrepancia debe tener al menos 10 caracteres.')
  }

  // Structural blockers for RECEIPT origin
  const receiptsConsistent =
    origin !== 'RECEIPT' ||
    (completedCount > 0 && cancelledCount === 0 && unlinkedCount === 0)

  validationBlockers.push(...hardErrors)

  if (!totalValid) {
    validationBlockers.push('Debe ingresar el monto total real de la factura.')
  }
  if (!dueTrimmed) {
    validationBlockers.push('Debe ingresar la fecha de vencimiento.')
  }
  if (input.priorPaymentStatus === 'UNREVIEWED') {
    validationBlockers.push('Debe revisar y seleccionar la situación de pagos anteriores.')
  }
  if (origin === 'RECEIPT') {
    if (completedCount === 0) {
      validationBlockers.push('La factura no cuenta con recepciones completadas vinculadas.')
    }
    if (cancelledCount > 0) {
      validationBlockers.push('Existen recepciones vinculadas anuladas o incompletas.')
    }
    if (unlinkedCount > 0) {
      validationBlockers.push('Hay recepciones completadas recientes para este folio sin incorporar a la factura.')
    }
  }
  if (hasAnyDiscrepancy && effectiveDiscrepancyStatus === 'UNRESOLVED') {
    if (input.resolveDiscrepancy && noteTrimmed.length < 10) {
      // already in hardErrors
    } else {
      validationBlockers.push('Existen diferencias sin resolver respecto a las recepciones; la factura conservará estado PENDING.')
    }
  }

  const consistentData =
    issueValid &&
    Boolean(dueTrimmed) &&
    totalValid &&
    hardErrors.length === 0

  const openingBalanceReviewed =
    input.priorPaymentStatus !== 'UNREVIEWED' &&
    openingPendingBalance !== null

  const noUnresolvedDiscrepancies = effectiveDiscrepancyStatus !== 'UNRESOLVED'

  return {
    referenceGrossRounded,
    amountDifference,
    amountDifferencePercent,
    hasAmountDiscrepancy,
    hasDateDiscrepancy,
    hasAnyDiscrepancy,
    effectiveDiscrepancyStatus,
    openingPendingBalance,
    priorPaidAmount,
    hardErrors,
    validationBlockers,
    canSavePending: hardErrors.length === 0,
    canConfirmValidation: validationBlockers.length === 0,
    checklist: {
      consistentData,
      openingBalanceReviewed,
      noUnresolvedDiscrepancies,
      receiptsConsistent,
    },
  }
}
