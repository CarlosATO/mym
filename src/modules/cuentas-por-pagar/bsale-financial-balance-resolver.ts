import type {
  BsaleBodegaReconciliationReport,
  ReconciledInvoiceEntry,
} from './bsale-bodega-reconciliation'
import type {
  DiscrepancyStatus,
  InvoiceInboxSummary,
  InvoicePaymentRecord,
  InvoicePaymentsHistory,
  InvoiceValidationStatus,
  PriorPaymentStatus,
  ReceiptInvoiceCandidate,
} from './types'

export type DueDateSourceKind =
  | 'SAVED'
  | 'MANUAL'
  | 'PURCHASE_ORDER'
  | 'SUPPLIER'
  | null

export type FinancialAccreditationStatus =
  | 'ACCREDITED_PAID'
  | 'HISTORICAL_EXCEL_PAID'
  | 'HISTORICAL_EXCEL_PENDING'
  | 'ACCREDITED_PARTIAL_BALANCE'
  | 'ACCREDITED_OPEN_BALANCE'
  | 'BLOCKED_BY_DISCREPANCY'
  | 'UNACCREDITED_HISTORICAL_PAYMENT'

export type PaymentBlockReasonCode =
  | 'NONE'
  | 'ALREADY_FULLY_PAID'
  | 'UNRESOLVED_MONETARY_DISCREPANCY'
  | 'UNRESOLVED_DATE_OR_RECEIPT_DISCREPANCY'
  | 'NO_WAREHOUSE_RECEIPT'
  | 'PENDING_DOCUMENTARY_LINK'
  | 'UNACCREDITED_PRIOR_PAYMENTS'
  | 'MISSING_DUE_DATE'

export interface PurchaseOrderPaymentTermsInput {
  id: string
  correlative?: string | null
  payment_terms?: string | null
}

export interface SupplierCreditTermsInput {
  id: string
  business_name?: string | null
  rut?: string | null
  rut_normalized?: string | null
  payment_terms?: string | null
  credit_days?: number | null
}

export interface CxpReceiptDueDateRow {
  candidate_id: string
  invoice_id: string | null
  due_date: string | null
  suggested_due_date: string | null
  due_date_source: DueDateSourceKind
}

export interface ResolvedInvoiceDueDateInfo {
  dueDate: string | null
  suggestedDueDate: string | null
  source: DueDateSourceKind
  sourceLabel: string
  creditDaysApplied: number | null
  rawTermsSummary: string | null
  hasAmbiguousPurchaseOrderTerms: boolean
  canEditDueDate: boolean
}

export type HistoricalExcelPaymentDateBasis =
  | 'EXCEL_COLUMN_H'
  | 'ASSUMED_DOCUMENT_DATE'

export interface HistoricalPaidExcelMatchInput {
  batch_id: string
  source_row: number
  issuer_rut_normalized: string
  document_folio: string
  document_issue_date: string
  reference_payment_date: string
  payment_date_basis: HistoricalExcelPaymentDateBasis
  document_total_clp: number
  credit_note_amount_clp: number | null
  has_excel_observation: boolean
  declared_payment_status: 'FULLY_PAID_PRIOR'
  declared_pending_balance_clp: number
  sii_matches: number
  sii_document_id: number | null
  sii_emission_date: string | null
  sii_total_clp: number | null
  sii_code: string | null
  sii_match_status: string
}

export interface HistoricalPaidExcelEvidence {
  batchId: string
  sourceRow: number
  referencePaymentDate: string
  paymentDateBasis: HistoricalExcelPaymentDateBasis
  paymentDateBasisLabel: string
  documentTotalClp: number
  creditNoteAmountClp: number | null
  hasExcelObservation: boolean
  declaredPaymentStatus: 'FULLY_PAID_PRIOR'
  declaredPendingBalanceClp: number
}

export interface HistoricalPendingExcelMatchInput {
  batch_id: string
  source_row: number
  issuer_rut_normalized: string
  supplier_name: string | null
  document_folio: string
  document_issue_date: string
  excel_due_date: string | null
  original_amount_clp: number
  credit_note_amount_clp: number
  pending_balance_clp: number
  excel_observation: string | null
  declared_payment_status: 'HISTORICAL_PENDING_EXCEL'
  sii_matches: number
  sii_document_id: number | null
  sii_emission_date: string | null
  sii_total_clp: number | null
  sii_code: string | null
  sii_match_status: string
}

export interface HistoricalPendingExcelEvidence {
  batchId: string
  sourceRow: number
  originalAmountClp: number
  creditNoteAmountClp: number
  pendingBalanceClp: number
  excelObservation: string | null
  declaredPaymentStatus: 'HISTORICAL_PENDING_EXCEL'
}

export interface ResolvedInvoiceFinancialBalance {
  accreditationStatus: FinancialAccreditationStatus
  accreditationLabel: string
  accreditationDetail: string
  isBalanceAccredited: boolean
  siiTotalAmountClp: number | null
  accreditedTotalAmountClp: number | null
  initialBalanceClp: number | null
  priorPaidAmountClp: number | null
  modulePaidAmountClp: number | null
  totalPaidAmountClp: number | null
  currentBalanceClp: number | null
  isFullyPaid: boolean
  activePaymentsCount: number
  reversedPaymentsCount: number
  reversedAmountClp: number
  paymentsHistory: InvoicePaymentRecord[]
  historicalExcelEvidence: HistoricalPaidExcelEvidence | null
  historicalPendingExcelEvidence: HistoricalPendingExcelEvidence | null
}

export interface ResolvedPaymentBlockInfo {
  isBlocked: boolean
  canRegisterPayment: boolean
  primaryReasonCode: PaymentBlockReasonCode
  primaryReasonLabel: string
  reasons: string[]
}

export interface InvoiceFinancialStatusOverlay {
  reconciliationKey: string
  cxpCandidateId: string | null
  cxpInvoiceId: string | null
  cxpValidationStatus: InvoiceValidationStatus | null
  cxpDiscrepancyStatus: DiscrepancyStatus | null
  cxpDiscrepancyResolutionNote: string | null
  cxpPriorPaymentStatus: PriorPaymentStatus | null
  cxpHistoricalInitialBalance: number | null
  cxpHistoricalBalanceCutoffDate: string | null
  cxpValidatedAt: string | null
  dueDateInfo: ResolvedInvoiceDueDateInfo
  financialBalance: ResolvedInvoiceFinancialBalance
  paymentBlock: ResolvedPaymentBlockInfo
}

export interface BsaleFinancialSummaryCounts {
  totalEvaluatedInvoices: number
  accreditedBalanceInvoicesCount: number
  accreditedFullyPaidCount: number
  historicalExcelPaidCount: number
  historicalExcelInformedDateCount: number
  historicalExcelAssumedDateCount: number
  historicalExcelPendingCount: number
  historicalExcelPendingTotalClp: number
  accreditedPartialBalanceCount: number
  accreditedOpenBalanceCount: number
  unaccreditedHistoricalPaymentCount: number
  blockedByMonetaryOrDocumentaryDiscrepancyCount: number
  withEffectiveDueDateCount: number
  dueDateBySource: {
    SAVED: number
    MANUAL: number
    PURCHASE_ORDER: number
    SUPPLIER: number
    UNRESOLVED: number
  }
}

export interface BsaleBodegaFinancialReconciliationView {
  report: BsaleBodegaReconciliationReport
  financialByKey: Record<string, InvoiceFinancialStatusOverlay>
  financialCounts: BsaleFinancialSummaryCounts
}

/**
 * Replica en TypeScript la regla exacta de PostgreSQL `cuentas_por_pagar.explicit_credit_days(p_terms)`:
 * Solo acepta un número explícito (1 a 3650), opcionalmente seguido de "día" o "días".
 * No interpreta textos ambiguos como "PRE PAGO", "CONTADO" o RUTs mal cargados en el campo.
 */
export function parseExplicitCreditDays(
  rawTerms: string | null | undefined,
): number | null {
  const trimmed = String(rawTerms ?? '').trim()
  if (!trimmed) return null
  const match = /^([0-9]{1,4})(?:\s+d[ií]as?)?$/i.exec(trimmed)
  if (!match) return null
  const days = Number(match[1])
  if (!Number.isInteger(days) || days < 1 || days > 3650) return null
  return days
}

export function addCivilDaysToIsoDate(
  isoDate: string | null | undefined,
  days: number,
): string | null {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null
  if (!Number.isInteger(days) || days < 0 || days > 3650) return null
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString().slice(0, 10)
}

function normalizeRutKey(rawRut: string | null | undefined): string | null {
  const cleaned = String(rawRut ?? '')
    .trim()
    .toUpperCase()
    .replace(/[.-\s]/g, '')
  return /^[0-9]{7,8}[0-9K]$/.test(cleaned) ? cleaned : null
}

function normalizeFolioKey(rawFolio: string | null | undefined): string | null {
  const trimmed = String(rawFolio ?? '').trim()
  if (!/^[0-9]+$/.test(trimmed)) return null
  return trimmed.replace(/^0+([0-9])/, '$1')
}

export function dueDateSourceShortLabel(source: DueDateSourceKind): string {
  switch (source) {
    case 'SAVED':
      return 'Confirmado CxP'
    case 'MANUAL':
      return 'Corregido manual'
    case 'PURCHASE_ORDER':
      return 'Sugerido OC'
    case 'SUPPLIER':
      return 'Sugerido proveedor'
    default:
      return 'Por confirmar'
  }
}

/**
 * Resuelve la fecha de vencimiento y su fuente verificada para una entrada del motor Bsale ↔ Bodega,
 * respetando la jerarquía de `public.cxp_receipt_due_dates()`:
 *   1. SAVED (`cuentas_por_pagar.invoices.due_date`)
 *   2. MANUAL (`cuentas_por_pagar.pending_due_dates.due_date`)
 *   3. PURCHASE_ORDER (`issue_date + explicit_credit_days(po.payment_terms)`)
 *   4. SUPPLIER (`issue_date + supplier.credit_days` entre 1 y 3650)
 */
export function resolveEntryDueDateInfo(params: {
  entry: ReconciledInvoiceEntry
  cxpCandidate: ReceiptInvoiceCandidate | undefined
  cxpSummary: InvoiceInboxSummary | undefined
  cxpDueDateRow: CxpReceiptDueDateRow | undefined
  purchaseOrdersById: Map<string, PurchaseOrderPaymentTermsInput>
  suppliersByRut: Map<string, SupplierCreditTermsInput>
}): ResolvedInvoiceDueDateInfo {
  const {
    entry,
    cxpCandidate,
    cxpSummary,
    cxpDueDateRow,
    purchaseOrdersById,
    suppliersByRut,
  } = params

  const baseEmissionDate =
    cxpSummary?.issue_date ??
    entry.dates.siiEmissionDate ??
    entry.dates.receiptDocumentDates[0] ??
    null

  const canEditDueDate =
    Boolean(cxpCandidate?.candidate_id && !cxpCandidate.blocked_reason) ||
    Boolean(cxpSummary?.id)

  // Evaluar términos de OC vinculadas y proveedor para conocer los días de crédito aplicables
  const linkedPos = entry.purchaseOrderIds
    .map(id => purchaseOrdersById.get(id))
    .filter((p): p is PurchaseOrderPaymentTermsInput => Boolean(p))

  let hasAmbiguousPurchaseOrderTerms = false
  const explicitPoDaysSet = new Set<number>()
  const rawPoTermsList: string[] = []

  for (const po of linkedPos) {
    const rawTerm = String(po.payment_terms ?? '').trim()
    if (!rawTerm) continue
    rawPoTermsList.push(rawTerm)
    const parsed = parseExplicitCreditDays(rawTerm)
    if (parsed === null) {
      hasAmbiguousPurchaseOrderTerms = true
    } else {
      explicitPoDaysSet.add(parsed)
    }
  }

  if (explicitPoDaysSet.size > 1) {
    hasAmbiguousPurchaseOrderTerms = true
  }

  const singlePoDays =
    !hasAmbiguousPurchaseOrderTerms && explicitPoDaysSet.size === 1
      ? Array.from(explicitPoDaysSet)[0]
      : null

  const supplier = entry.issuerRutNormalized
    ? suppliersByRut.get(entry.issuerRutNormalized)
    : undefined

  const supplierCreditDays =
    supplier &&
    typeof supplier.credit_days === 'number' &&
    Number.isInteger(supplier.credit_days) &&
    supplier.credit_days >= 1 &&
    supplier.credit_days <= 3650
      ? supplier.credit_days
      : supplier
        ? parseExplicitCreditDays(supplier.payment_terms)
        : null

  const computedSuggestedDays =
    hasAmbiguousPurchaseOrderTerms
      ? null
      : singlePoDays !== null
        ? singlePoDays
        : supplierCreditDays
  const computedSuggestedSource: DueDateSourceKind =
    hasAmbiguousPurchaseOrderTerms
      ? null
      : singlePoDays !== null
        ? 'PURCHASE_ORDER'
        : supplierCreditDays !== null
          ? 'SUPPLIER'
          : null
  const computedSuggestedDate =
    baseEmissionDate && computedSuggestedDays !== null
      ? addCivilDaysToIsoDate(baseEmissionDate, computedSuggestedDays)
      : null

  const rawTermsSummary =
    rawPoTermsList.length > 0
      ? `OC: ${Array.from(new Set(rawPoTermsList)).join(', ')}`
      : supplierCreditDays !== null
        ? `Proveedor: ${supplierCreditDays} días`
        : supplier?.payment_terms
          ? `Proveedor: ${supplier.payment_terms}`
          : null

  // 1. Si existe factura incorporada con due_date guardado en cuentas_por_pagar.invoices
  if (cxpSummary?.due_date) {
    return {
      dueDate: cxpSummary.due_date,
      suggestedDueDate:
        cxpDueDateRow?.suggested_due_date ?? computedSuggestedDate,
      source: 'SAVED',
      sourceLabel: dueDateSourceShortLabel('SAVED'),
      creditDaysApplied: computedSuggestedDays,
      rawTermsSummary,
      hasAmbiguousPurchaseOrderTerms,
      canEditDueDate,
    }
  }

  // 2. Si public.cxp_receipt_due_dates() devolvió una fecha (SAVED, MANUAL, PURCHASE_ORDER o SUPPLIER)
  //    Recalculamos sobre la fecha oficial de emisión SII cuando la fuente es PURCHASE_ORDER o SUPPLIER
  //    y la fecha digitada en Bodega difería de la emisión SII.
  if (cxpDueDateRow) {
    if (
      cxpDueDateRow.due_date_source === 'SAVED' ||
      cxpDueDateRow.due_date_source === 'MANUAL'
    ) {
      return {
        dueDate: cxpDueDateRow.due_date,
        suggestedDueDate:
          cxpDueDateRow.suggested_due_date ?? computedSuggestedDate,
        source: cxpDueDateRow.due_date_source,
        sourceLabel: dueDateSourceShortLabel(cxpDueDateRow.due_date_source),
        creditDaysApplied: computedSuggestedDays,
        rawTermsSummary,
        hasAmbiguousPurchaseOrderTerms,
        canEditDueDate,
      }
    }
  }

  // 3. Sugerencia calculada desde OC vinculada o días de crédito del proveedor sobre la fecha de emisión SII
  if (computedSuggestedDate && computedSuggestedSource) {
    return {
      dueDate: computedSuggestedDate,
      suggestedDueDate: computedSuggestedDate,
      source: computedSuggestedSource,
      sourceLabel: dueDateSourceShortLabel(computedSuggestedSource),
      creditDaysApplied: computedSuggestedDays,
      rawTermsSummary,
      hasAmbiguousPurchaseOrderTerms,
      canEditDueDate,
    }
  }

  // 4. Fallback a sugerencia de cxp_receipt_due_dates si existiera
  if (cxpDueDateRow?.due_date && cxpDueDateRow.due_date_source) {
    return {
      dueDate: cxpDueDateRow.due_date,
      suggestedDueDate: cxpDueDateRow.suggested_due_date,
      source: cxpDueDateRow.due_date_source,
      sourceLabel: dueDateSourceShortLabel(cxpDueDateRow.due_date_source),
      creditDaysApplied: computedSuggestedDays,
      rawTermsSummary,
      hasAmbiguousPurchaseOrderTerms,
      canEditDueDate,
    }
  }

  return {
    dueDate: null,
    suggestedDueDate: null,
    source: null,
    sourceLabel: dueDateSourceShortLabel(null),
    creditDaysApplied: null,
    rawTermsSummary,
    hasAmbiguousPurchaseOrderTerms,
    canEditDueDate,
  }
}

/**
 * Calcula el estado financiero acreditado, pagos asociados de forma inequívoca y
 * bloqueos de pago para cada entrada del reporte de conciliación Bsale ↔ Bodega.
 *
 * Reglas fundamentales:
 * - Solo acredita saldo cuando la factura está vinculada por identidad documental exacta
 *   `(company_id, issuer_rut_normalized, document_folio)` a un registro `VALIDATED` en
 *   `cuentas_por_pagar.invoices` con `prior_payment_status <> 'UNREVIEWED'`.
 * - Las facturas cuyo estado de pagos históricos aún no se ha acreditado NUNCA se clasifican
 *   como impagas ni exponen `currentBalanceClp = siiTotalAmountClp` (`currentBalanceClp: null`).
 * - Respeta estrictamente el bloqueo de pago ante discrepancias monetarias o documentales no resueltas.
 */
export function buildBsaleBodegaFinancialReconciliationView(params: {
  report: BsaleBodegaReconciliationReport
  cxpCandidates?: ReceiptInvoiceCandidate[]
  cxpSummaries?: InvoiceInboxSummary[]
  cxpDueDates?: CxpReceiptDueDateRow[]
  cxpPaymentsByInvoiceId?: Record<string, InvoicePaymentsHistory>
  historicalPaidExcelMatches?: HistoricalPaidExcelMatchInput[]
  historicalPendingExcelMatches?: HistoricalPendingExcelMatchInput[]
  purchaseOrders?: PurchaseOrderPaymentTermsInput[]
  suppliers?: SupplierCreditTermsInput[]
}): BsaleBodegaFinancialReconciliationView {
  const { report } = params
  const cxpCandidates = params.cxpCandidates ?? []
  const cxpSummaries = params.cxpSummaries ?? []
  const cxpDueDates = params.cxpDueDates ?? []
  const cxpPaymentsByInvoiceId = params.cxpPaymentsByInvoiceId ?? {}

  const historicalExcelByBsaleId = new Map<
    number,
    HistoricalPaidExcelMatchInput
  >()
  for (const row of params.historicalPaidExcelMatches ?? []) {
    if (
      row.sii_match_status === 'EXACT' &&
      row.sii_matches === 1 &&
      row.sii_document_id !== null &&
      row.declared_payment_status === 'FULLY_PAID_PRIOR' &&
      Number(row.declared_pending_balance_clp) === 0
    ) {
      historicalExcelByBsaleId.set(Number(row.sii_document_id), row)
    }
  }

  const historicalPendingExcelByBsaleId = new Map<
    number,
    HistoricalPendingExcelMatchInput
  >()
  for (const row of params.historicalPendingExcelMatches ?? []) {
    if (
      row.sii_match_status === 'EXACT' &&
      row.sii_matches === 1 &&
      row.sii_document_id !== null &&
      row.declared_payment_status === 'HISTORICAL_PENDING_EXCEL' &&
      Number(row.pending_balance_clp) > 0 &&
      !historicalExcelByBsaleId.has(Number(row.sii_document_id))
    ) {
      historicalPendingExcelByBsaleId.set(Number(row.sii_document_id), row)
    }
  }

  const candidateByIdentity = new Map<string, ReceiptInvoiceCandidate>()
  for (const cand of cxpCandidates) {
    const rut = normalizeRutKey(cand.issuer_rut)
    const folio = normalizeFolioKey(cand.folio)
    if (rut && folio) {
      candidateByIdentity.set(`${rut}:${folio}`, cand)
    }
  }

  const summaryByInvoiceId = new Map<string, InvoiceInboxSummary>()
  for (const sum of cxpSummaries) {
    summaryByInvoiceId.set(sum.id, sum)
  }

  const dueByCandidateId = new Map<string, CxpReceiptDueDateRow>()
  const dueByInvoiceId = new Map<string, CxpReceiptDueDateRow>()
  for (const d of cxpDueDates) {
    if (d.candidate_id) dueByCandidateId.set(d.candidate_id, d)
    if (d.invoice_id) dueByInvoiceId.set(d.invoice_id, d)
  }

  const purchaseOrdersById = new Map<string, PurchaseOrderPaymentTermsInput>()
  for (const po of params.purchaseOrders ?? []) {
    purchaseOrdersById.set(po.id, po)
  }

  const suppliersByRut = new Map<string, SupplierCreditTermsInput>()
  for (const sup of params.suppliers ?? []) {
    const rut = normalizeRutKey(sup.rut || sup.rut_normalized)
    if (!rut) continue
    const existing = suppliersByRut.get(rut)
    if (
      !existing ||
      ((existing.credit_days ?? 0) <= 0 && (sup.credit_days ?? 0) > 0)
    ) {
      suppliersByRut.set(rut, sup)
    }
  }

  const financialByKey: Record<string, InvoiceFinancialStatusOverlay> = {}
  const dueDateBySource = {
    SAVED: 0,
    MANUAL: 0,
    PURCHASE_ORDER: 0,
    SUPPLIER: 0,
    UNRESOLVED: 0,
  }

  let totalEvaluatedInvoices = 0
  let accreditedBalanceInvoicesCount = 0
  let accreditedFullyPaidCount = 0
  let historicalExcelPaidCount = 0
  let historicalExcelInformedDateCount = 0
  let historicalExcelAssumedDateCount = 0
  let historicalExcelPendingCount = 0
  let historicalExcelPendingTotalClp = 0
  let accreditedPartialBalanceCount = 0
  let accreditedOpenBalanceCount = 0
  let unaccreditedHistoricalPaymentCount = 0
  let blockedByMonetaryOrDocumentaryDiscrepancyCount = 0
  let withEffectiveDueDateCount = 0

  for (const entry of report.entries) {
    const identityKey =
      entry.issuerRutNormalized && entry.documentFolio
        ? `${entry.issuerRutNormalized}:${entry.documentFolio}`
        : null

    const cxpCandidate =
      identityKey && entry.bodegaDocumentType !== 'GD'
        ? candidateByIdentity.get(identityKey)
        : undefined
    const cxpInvoiceId = cxpCandidate?.invoice_id ?? null
    const cxpSummary = cxpInvoiceId
      ? summaryByInvoiceId.get(cxpInvoiceId)
      : undefined
    const cxpDueDateRow =
      (cxpInvoiceId ? dueByInvoiceId.get(cxpInvoiceId) : undefined) ??
      (cxpCandidate
        ? dueByCandidateId.get(cxpCandidate.candidate_id)
        : undefined)

    const dueDateInfo = resolveEntryDueDateInfo({
      entry,
      cxpCandidate,
      cxpSummary,
      cxpDueDateRow,
      purchaseOrdersById,
      suppliersByRut,
    })

    // Evaluar discrepancias documentales y monetarias
    const hasMonetaryDifference = entry.monetary.status === 'AMOUNT_DIFFERENCE'
    const isDiscrepancyResolvedInCxp =
      cxpSummary?.validation_status === 'VALIDATED' &&
      cxpSummary?.discrepancy_status === 'RESOLVED'

    const hasUnresolvedMonetaryDiscrepancy =
      hasMonetaryDifference && !isDiscrepancyResolvedInCxp

    const hasUnresolvedDateOrReceiptDiscrepancy =
      ((entry.dates.hasInconsistentReceiptDates ||
        entry.dates.hasDocumentDateMismatch) &&
        entry.receiptCount > 0 &&
        cxpSummary?.validation_status !== 'VALIDATED') ||
      cxpSummary?.discrepancy_status === 'UNRESOLVED'

    const hasNoWarehouseReceipt = entry.receptionStatus === 'NO_RECEIPT'
    const hasPendingDocumentaryLink =
      entry.receptionStatus === 'PENDING_DOCUMENT_LINK' ||
      entry.category === 'RECEIPT_WITHOUT_BSALE_INVOICE' ||
      entry.category === 'GD_RECEIPT_WITHOUT_LINKED_INVOICE' ||
      entry.category === 'AMBIGUOUS_DOCUMENT_IDENTITY'

    // Verificar si la factura tiene su saldo acreditado de manera inequívoca en Cuentas por Pagar
    const isValidatedInCxp =
      cxpSummary?.validation_status === 'VALIDATED' &&
      cxpSummary.prior_payment_status !== 'UNREVIEWED' &&
      cxpSummary.total_amount !== null &&
      Number(cxpSummary.total_amount) > 0 &&
      !hasUnresolvedMonetaryDiscrepancy &&
      cxpSummary.discrepancy_status !== 'UNRESOLVED'

    const paymentsHistoryRecord =
      cxpInvoiceId && cxpPaymentsByInvoiceId[cxpInvoiceId]
        ? cxpPaymentsByInvoiceId[cxpInvoiceId]
        : null

    let financialBalance: ResolvedInvoiceFinancialBalance

    if (isValidatedInCxp && cxpSummary) {
      const accreditedTotal = Math.round(Number(cxpSummary.total_amount))
      let initialBalance = accreditedTotal
      if (cxpSummary.prior_payment_status === 'PARTIAL_PRIOR_PAYMENTS') {
        initialBalance = Math.round(
          Number(cxpSummary.historical_initial_balance ?? accreditedTotal),
        )
      } else if (cxpSummary.prior_payment_status === 'FULLY_PAID_PRIOR') {
        initialBalance = 0
      }

      const priorPaid = Math.max(0, accreditedTotal - initialBalance)
      const modulePaid = paymentsHistoryRecord
        ? Math.round(Number(paymentsHistoryRecord.module_paid_amount))
        : 0
      const totalPaid = paymentsHistoryRecord
        ? Math.round(
            Number(
              paymentsHistoryRecord.total_paid_amount ??
                priorPaid + modulePaid,
            ),
          )
        : priorPaid
      const currentBalance = paymentsHistoryRecord
        ? Math.round(
            Number(
              paymentsHistoryRecord.current_balance ??
                Math.max(0, initialBalance - modulePaid),
            ),
          )
        : Math.max(0, initialBalance - modulePaid)
      const isFullyPaid = currentBalance === 0
      const reversedCount = paymentsHistoryRecord?.reversed_payment_count ?? 0

      let accreditationStatus: FinancialAccreditationStatus =
        'ACCREDITED_OPEN_BALANCE'
      let accreditationLabel = 'Saldo acreditado'
      let accreditationDetail =
        reversedCount > 0 && totalPaid === 0
          ? `${reversedCount} pago(s) anulado(s) · Saldo disponible`
          : `Validada · Pagado $${totalPaid.toLocaleString('es-CL')}`

      if (isFullyPaid) {
        accreditationStatus = 'ACCREDITED_PAID'
        accreditationLabel = 'Pagada · Saldo $0'
        accreditationDetail =
          paymentsHistoryRecord && paymentsHistoryRecord.payment_count > 0
            ? `${paymentsHistoryRecord.payment_count} pago(s) registrado(s)`
            : 'Pagada con anterioridad'
      } else if (totalPaid > 0) {
        accreditationStatus = 'ACCREDITED_PARTIAL_BALANCE'
        accreditationLabel = 'Saldo con abonos'
        accreditationDetail = `Abonado $${totalPaid.toLocaleString('es-CL')}`
      }

      financialBalance = {
        accreditationStatus,
        accreditationLabel,
        accreditationDetail,
        isBalanceAccredited: true,
        siiTotalAmountClp: entry.monetary.siiTotalAmountClp,
        accreditedTotalAmountClp: accreditedTotal,
        initialBalanceClp: initialBalance,
        priorPaidAmountClp: priorPaid,
        modulePaidAmountClp: modulePaid,
        totalPaidAmountClp: totalPaid,
        currentBalanceClp: currentBalance,
        isFullyPaid,
        activePaymentsCount: paymentsHistoryRecord?.payment_count ?? 0,
        reversedPaymentsCount:
          paymentsHistoryRecord?.reversed_payment_count ?? 0,
        reversedAmountClp: Math.round(
          Number(paymentsHistoryRecord?.reversed_amount ?? 0),
        ),
        paymentsHistory: paymentsHistoryRecord?.payments ?? [],
        historicalExcelEvidence: null,
        historicalPendingExcelEvidence: null,
      }
    } else {
      const candidateExcel =
        entry.bsaleDocumentId !== null &&
        (entry.codeSii === '33' || entry.codeSii === '34')
          ? historicalExcelByBsaleId.get(entry.bsaleDocumentId)
          : undefined

      const isExactHistoricalExcelMatch = Boolean(
        candidateExcel &&
          entry.issuerRutNormalized &&
          entry.documentFolio &&
          candidateExcel.issuer_rut_normalized === entry.issuerRutNormalized &&
          candidateExcel.document_folio === entry.documentFolio,
      )

      const candidatePendingExcel =
        !isExactHistoricalExcelMatch &&
        entry.bsaleDocumentId !== null &&
        (entry.codeSii === '33' || entry.codeSii === '34')
          ? historicalPendingExcelByBsaleId.get(entry.bsaleDocumentId)
          : undefined

      const isExactHistoricalPendingExcelMatch = Boolean(
        candidatePendingExcel &&
          entry.issuerRutNormalized &&
          entry.documentFolio &&
          candidatePendingExcel.issuer_rut_normalized ===
            entry.issuerRutNormalized &&
          candidatePendingExcel.document_folio === entry.documentFolio,
      )

      if (isExactHistoricalExcelMatch && candidateExcel) {
        const basisLabel =
          candidateExcel.payment_date_basis === 'EXCEL_COLUMN_H'
            ? 'Fecha informada en Excel'
            : 'Fecha asumida (emisión doc.)'
        const siiTotal =
          entry.monetary.siiTotalAmountClp ??
          Math.round(Number(candidateExcel.document_total_clp))

        financialBalance = {
          accreditationStatus: 'HISTORICAL_EXCEL_PAID',
          accreditationLabel: 'Pagada según Excel',
          accreditationDetail: `Saldo $0 · ${basisLabel}: ${candidateExcel.reference_payment_date}`,
          isBalanceAccredited: true,
          siiTotalAmountClp: entry.monetary.siiTotalAmountClp,
          accreditedTotalAmountClp: null,
          initialBalanceClp: null,
          priorPaidAmountClp: siiTotal,
          modulePaidAmountClp: 0,
          totalPaidAmountClp: siiTotal,
          currentBalanceClp: 0,
          isFullyPaid: true,
          activePaymentsCount: paymentsHistoryRecord?.payment_count ?? 0,
          reversedPaymentsCount:
            paymentsHistoryRecord?.reversed_payment_count ?? 0,
          reversedAmountClp: Math.round(
            Number(paymentsHistoryRecord?.reversed_amount ?? 0),
          ),
          paymentsHistory: paymentsHistoryRecord?.payments ?? [],
          historicalExcelEvidence: {
            batchId: candidateExcel.batch_id,
            sourceRow: candidateExcel.source_row,
            referencePaymentDate: candidateExcel.reference_payment_date,
            paymentDateBasis: candidateExcel.payment_date_basis,
            paymentDateBasisLabel: basisLabel,
            documentTotalClp: Math.round(
              Number(candidateExcel.document_total_clp),
            ),
            creditNoteAmountClp:
              candidateExcel.credit_note_amount_clp !== null
                ? Math.round(Number(candidateExcel.credit_note_amount_clp))
                : null,
            hasExcelObservation: candidateExcel.has_excel_observation,
            declaredPaymentStatus: 'FULLY_PAID_PRIOR',
            declaredPendingBalanceClp: 0,
          },
          historicalPendingExcelEvidence: null,
        }
      } else if (isExactHistoricalPendingExcelMatch && candidatePendingExcel) {
        const originalClp = Math.round(
          Number(candidatePendingExcel.original_amount_clp),
        )
        const ncClp = Math.round(
          Number(candidatePendingExcel.credit_note_amount_clp ?? 0),
        )
        const pendingClp = Math.round(
          Number(candidatePendingExcel.pending_balance_clp),
        )

        financialBalance = {
          accreditationStatus: 'HISTORICAL_EXCEL_PENDING',
          accreditationLabel: 'Saldo según Excel',
          accreditationDetail:
            ncClp > 0
              ? `Orig. $${originalClp.toLocaleString('es-CL')} − NC $${ncClp.toLocaleString('es-CL')}`
              : 'Pendiente según Excel · Sin validar ERP',
          isBalanceAccredited: false,
          siiTotalAmountClp: entry.monetary.siiTotalAmountClp,
          accreditedTotalAmountClp: null,
          initialBalanceClp: null,
          priorPaidAmountClp: null,
          modulePaidAmountClp: null,
          totalPaidAmountClp: null,
          currentBalanceClp: null,
          isFullyPaid: false,
          activePaymentsCount: paymentsHistoryRecord?.payment_count ?? 0,
          reversedPaymentsCount:
            paymentsHistoryRecord?.reversed_payment_count ?? 0,
          reversedAmountClp: Math.round(
            Number(paymentsHistoryRecord?.reversed_amount ?? 0),
          ),
          paymentsHistory: paymentsHistoryRecord?.payments ?? [],
          historicalExcelEvidence: null,
          historicalPendingExcelEvidence: {
            batchId: candidatePendingExcel.batch_id,
            sourceRow: candidatePendingExcel.source_row,
            originalAmountClp: originalClp,
            creditNoteAmountClp: ncClp,
            pendingBalanceClp: pendingClp,
            excelObservation: candidatePendingExcel.excel_observation,
            declaredPaymentStatus: 'HISTORICAL_PENDING_EXCEL',
          },
        }
      } else {
        const isBlockedByDiscrepancy =
          hasUnresolvedMonetaryDiscrepancy || hasPendingDocumentaryLink
        const preservedReversedCount =
          paymentsHistoryRecord?.reversed_payment_count ?? 0
        const preservedReversedAmount = Math.round(
          Number(paymentsHistoryRecord?.reversed_amount ?? 0),
        )
        financialBalance = {
          accreditationStatus: isBlockedByDiscrepancy
            ? 'BLOCKED_BY_DISCREPANCY'
            : 'UNACCREDITED_HISTORICAL_PAYMENT',
          accreditationLabel: isBlockedByDiscrepancy
            ? 'Bloqueada por discrepancia'
            : 'Saldo por acreditar',
          accreditationDetail: isBlockedByDiscrepancy
            ? hasUnresolvedMonetaryDiscrepancy
              ? 'Diferencia SII vs. Bodega sin resolver'
              : 'Vínculo documental pendiente'
            : preservedReversedCount > 0
              ? `Validación reabierta · ${preservedReversedCount} pago(s) anulado(s)`
              : 'Sin clasificación en Excel',
          isBalanceAccredited: false,
          siiTotalAmountClp: entry.monetary.siiTotalAmountClp,
          accreditedTotalAmountClp: null,
          initialBalanceClp: null,
          priorPaidAmountClp: null,
          modulePaidAmountClp: null,
          totalPaidAmountClp: null,
          currentBalanceClp: null,
          isFullyPaid: false,
          activePaymentsCount: paymentsHistoryRecord?.payment_count ?? 0,
          reversedPaymentsCount: preservedReversedCount,
          reversedAmountClp: preservedReversedAmount,
          paymentsHistory: paymentsHistoryRecord?.payments ?? [],
          historicalExcelEvidence: null,
          historicalPendingExcelEvidence: null,
        }
      }
    }

    // Construir razones de bloqueo de pago en orden de prioridad
    const reasons: string[] = []
    let primaryReasonCode: PaymentBlockReasonCode = 'NONE'

    if (hasPendingDocumentaryLink) {
      primaryReasonCode = 'PENDING_DOCUMENTARY_LINK'
      reasons.push(
        entry.category === 'GD_RECEIPT_WITHOUT_LINKED_INVOICE'
          ? 'Recepción con Guía de Despacho (GD) sin factura SII vinculada.'
          : entry.category === 'RECEIPT_WITHOUT_BSALE_INVOICE'
            ? 'Recepción de Bodega sin documento tributario en el espejo Bsale.'
            : 'Identidad documental ambigua o incompleta.',
      )
    }

    if (hasUnresolvedMonetaryDiscrepancy) {
      if (primaryReasonCode === 'NONE') {
        primaryReasonCode = 'UNRESOLVED_MONETARY_DISCREPANCY'
      }
      reasons.push(
        `Diferencia monetaria no resuelta entre SII y Bodega (${
          (entry.monetary.differenceClp ?? 0) > 0 ? '+' : ''
        }${(entry.monetary.differenceClp ?? 0).toLocaleString('es-CL')} CLP).`,
      )
    }

    if (hasNoWarehouseReceipt) {
      if (entry.isHistoricalPreErpReceipts) {
        reasons.push(
          'Factura emitida antes de la implementación del módulo de recepciones de Bodega (01/10/2026); la ausencia de recepción no constituye una incidencia operativa.',
        )
      } else {
        if (primaryReasonCode === 'NONE') {
          primaryReasonCode = 'NO_WAREHOUSE_RECEIPT'
        }
        reasons.push('Factura SII sin recepción vinculada en Bodega.')
      }
    }

    if (hasUnresolvedDateOrReceiptDiscrepancy && !hasNoWarehouseReceipt) {
      if (primaryReasonCode === 'NONE') {
        primaryReasonCode = 'UNRESOLVED_DATE_OR_RECEIPT_DISCREPANCY'
      }
      if (entry.dates.hasInconsistentReceiptDates) {
        reasons.push(
          'Las recepciones consolidadas registran múltiples fechas de documento distintas.',
        )
      } else if (entry.dates.hasDocumentDateMismatch) {
        reasons.push(
          'La fecha de documento digitada en Bodega difiere de la fecha de emisión SII.',
        )
      }
    }

    if (!financialBalance.isBalanceAccredited) {
      if (primaryReasonCode === 'NONE') {
        primaryReasonCode = 'UNACCREDITED_PRIOR_PAYMENTS'
      }
      reasons.push(
        entry.isHistoricalPreErpReceipts
          ? 'Pendiente de validación financiera histórica en el ERP (no se habilita el pago hasta acreditar su situación financiera).'
          : 'Situación de pagos históricos no acreditada (no se asume como deuda impaga hasta conciliar pagos previos).',
      )
    }

    if (!dueDateInfo.dueDate && !financialBalance.isFullyPaid) {
      if (primaryReasonCode === 'NONE') {
        primaryReasonCode = 'MISSING_DUE_DATE'
      }
      reasons.push('Fecha de vencimiento pendiente de confirmación.')
    }

    if (
      financialBalance.isBalanceAccredited &&
      financialBalance.isFullyPaid &&
      primaryReasonCode === 'NONE'
    ) {
      primaryReasonCode = 'ALREADY_FULLY_PAID'
      reasons.push('La factura ya se encuentra íntegramente pagada (Saldo $0).')
    }

    const canRegisterPayment =
      financialBalance.isBalanceAccredited &&
      !financialBalance.isFullyPaid &&
      primaryReasonCode === 'NONE' &&
      (financialBalance.currentBalanceClp ?? 0) > 0

    const isBlocked = !canRegisterPayment && !financialBalance.isFullyPaid

    const primaryReasonLabel =
      primaryReasonCode === 'ALREADY_FULLY_PAID'
        ? 'Factura pagada (Saldo $0)'
        : primaryReasonCode === 'UNRESOLVED_MONETARY_DISCREPANCY'
          ? 'Pago bloqueado · Diferencia de monto SII vs. Bodega'
          : primaryReasonCode === 'PENDING_DOCUMENTARY_LINK'
            ? 'Pago bloqueado · Sin vínculo documental SII'
            : primaryReasonCode === 'NO_WAREHOUSE_RECEIPT'
              ? 'Pago bloqueado · Sin recepción en Bodega'
              : primaryReasonCode === 'UNRESOLVED_DATE_OR_RECEIPT_DISCREPANCY'
                ? 'Pago bloqueado · Discrepancia de fecha por validar'
                : primaryReasonCode === 'UNACCREDITED_PRIOR_PAYMENTS'
                  ? entry.isHistoricalPreErpReceipts
                    ? 'Pago bloqueado · Pendiente de validación financiera histórica'
                    : 'Pendiente acreditar pagos históricos'
                  : primaryReasonCode === 'MISSING_DUE_DATE'
                    ? 'Pendiente confirmar fecha de vencimiento'
                    : 'Habilitada para registro de pagos'

    const overlay: InvoiceFinancialStatusOverlay = {
      reconciliationKey: entry.reconciliationKey,
      cxpCandidateId: cxpCandidate?.candidate_id ?? null,
      cxpInvoiceId,
      cxpValidationStatus: cxpSummary?.validation_status ?? null,
      cxpDiscrepancyStatus: cxpSummary?.discrepancy_status ?? null,
      cxpDiscrepancyResolutionNote: null,
      cxpPriorPaymentStatus: cxpSummary?.prior_payment_status ?? null,
      cxpHistoricalInitialBalance:
        cxpSummary?.historical_initial_balance !== null &&
        cxpSummary?.historical_initial_balance !== undefined
          ? Number(cxpSummary.historical_initial_balance)
          : null,
      cxpHistoricalBalanceCutoffDate:
        cxpSummary?.historical_balance_cutoff_date ?? null,
      cxpValidatedAt: cxpSummary?.validated_at ?? null,
      dueDateInfo,
      financialBalance,
      paymentBlock: {
        isBlocked,
        canRegisterPayment,
        primaryReasonCode,
        primaryReasonLabel,
        reasons,
      },
    }

    financialByKey[entry.reconciliationKey] = overlay

    // Contabilizar métricas sobre las 777 facturas SII (33 y 34)
    if (
      entry.bsaleDocumentId !== null &&
      (entry.codeSii === '33' || entry.codeSii === '34')
    ) {
      totalEvaluatedInvoices++
      if (dueDateInfo.dueDate && dueDateInfo.source) {
        withEffectiveDueDateCount++
        dueDateBySource[dueDateInfo.source]++
      } else {
        dueDateBySource.UNRESOLVED++
      }

      if (financialBalance.isBalanceAccredited) {
        accreditedBalanceInvoicesCount++
        if (
          financialBalance.accreditationStatus === 'HISTORICAL_EXCEL_PAID' &&
          financialBalance.historicalExcelEvidence
        ) {
          historicalExcelPaidCount++
          if (
            financialBalance.historicalExcelEvidence.paymentDateBasis ===
            'EXCEL_COLUMN_H'
          ) {
            historicalExcelInformedDateCount++
          } else {
            historicalExcelAssumedDateCount++
          }
        } else if (
          financialBalance.accreditationStatus === 'ACCREDITED_PAID'
        ) {
          accreditedFullyPaidCount++
        } else if (
          financialBalance.accreditationStatus === 'ACCREDITED_PARTIAL_BALANCE'
        ) {
          accreditedPartialBalanceCount++
        } else {
          accreditedOpenBalanceCount++
        }
      } else {
        unaccreditedHistoricalPaymentCount++
        if (
          financialBalance.accreditationStatus === 'HISTORICAL_EXCEL_PENDING' &&
          financialBalance.historicalPendingExcelEvidence
        ) {
          historicalExcelPendingCount++
          historicalExcelPendingTotalClp +=
            financialBalance.historicalPendingExcelEvidence.pendingBalanceClp
        }
        if (
          financialBalance.accreditationStatus === 'BLOCKED_BY_DISCREPANCY'
        ) {
          blockedByMonetaryOrDocumentaryDiscrepancyCount++
        }
      }
    }
  }

  return {
    report,
    financialByKey,
    financialCounts: {
      totalEvaluatedInvoices,
      accreditedBalanceInvoicesCount,
      accreditedFullyPaidCount,
      historicalExcelPaidCount,
      historicalExcelInformedDateCount,
      historicalExcelAssumedDateCount,
      historicalExcelPendingCount,
      historicalExcelPendingTotalClp,
      accreditedPartialBalanceCount,
      accreditedOpenBalanceCount,
      unaccreditedHistoricalPaymentCount,
      blockedByMonetaryOrDocumentaryDiscrepancyCount,
      withEffectiveDueDateCount,
      dueDateBySource,
    },
  }
}
