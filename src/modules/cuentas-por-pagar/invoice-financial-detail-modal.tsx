'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  FileText,
  History,
  Loader2,
  PackageCheck,
  ReceiptText,
  RotateCcw,
  ShieldCheck,
  Undo2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  confirmInvoiceFromFinancialPanel,
  getCxpInboxDocuments,
  getCxpInboxDocumentSignedUrl,
  getCxpReceiptDocumentSignedUrl,
  getInvoicePayments,
  getInvoiceValidationDetail,
  registerInvoicePayment,
  reverseInvoicePayment,
} from '@/app/actions/cuentas-por-pagar'
import type { PurchaseOrderInvoiceDocument } from '@/app/actions/adquisiciones/purchase-orders'
import { formatCivilDate, formatInstantInSantiago, todayInSantiago } from '@/lib/datetime'
import { erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import { PurchaseOrderInvoiceViewerModal } from '@/modules/adquisiciones/ordenes-compra/purchase-order-invoice-viewer-modal'
import { purchaseTypeLabel, receptionStatusLabel } from './classification'
import {
  amountToEditableString,
  applyConfirmedPaymentToHistory,
  applyConfirmedReversalToHistory,
  buildFinancialStripModel,
  buildInitialConfirmationDraft,
  evaluateConfirmationDiscrepancy,
  formatFinancialClp,
  getFinancialDetailFetchPlan,
  parseClpAmountInput,
  priorPaymentShortLabel,
  resolveDefaultPaymentAmountText,
  resolveFinancialStatusBadge,
  resolveOperationIdForAttempt,
  shouldFetchPaymentsAfterDetail,
  validateInvoiceConfirmationDraft,
  validatePaymentFormDraft,
  type FinancialDetailTarget,
  type FinancialStatusBadgeModel,
  type OperationAttemptTracker,
  type PaymentMovementMode,
} from './financial-detail-model'
import type {
  InvoiceDetail,
  InvoicePaymentsHistory,
  PriorPaymentStatus,
  SaveInvoiceValidationResult,
} from './types'
import { formatRut } from './validation-rules'

interface InvoiceFinancialDetailModalProps {
  target: FinancialDetailTarget | null
  onClose: () => void
  onCandidateIncorporated?: (candidateId: string, invoiceId: string) => void
  onInvoiceConfirmed?: (payload: {
    candidateId: string
    invoiceId: string
    validation: SaveInvoiceValidationResult
  }) => void
}

type PdfViewerState =
  | {
      kind: 'INVOICE'
      invoiceId: string
      correlative: string
      supplierName: string
      documents: PurchaseOrderInvoiceDocument[]
      initialDocumentId?: string
    }
  | {
      kind: 'INBOX'
      candidateKey: string
      correlative: string
      supplierName: string
      documents: PurchaseOrderInvoiceDocument[]
      initialDocumentId?: string
    }

function createOperationUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const r = (Math.random() * 16) | 0
    const v = char === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function statusBadgeClasses(tone: FinancialStatusBadgeModel['tone']): string {
  switch (tone) {
    case 'emerald':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'sky':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    case 'amber':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'red':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
    default:
      return 'border-theme-border bg-theme-bg text-theme-text-muted'
  }
}

function dueSourceLabel(source: FinancialDetailTarget['dueSource']): string | null {
  switch (source) {
    case 'PURCHASE_ORDER':
      return 'Sug. OC'
    case 'SUPPLIER':
      return 'Sug. prov.'
    case 'MANUAL':
      return 'Corregido'
    case 'SAVED':
      return 'Registrado'
    default:
      return null
  }
}

function StripMetric({
  label,
  value,
  subtext,
  tone = 'default',
}: {
  label: string
  value: string
  subtext: string | null
  tone?: 'default' | 'paid' | 'balance'
}) {
  return (
    <div className="min-w-0 px-3 py-1.5">
      <p className="truncate text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
        {label}
      </p>
      <p
        className={cn(
          'truncate text-sm font-bold tabular-nums',
          tone === 'paid' && 'text-emerald-700 dark:text-emerald-300',
          tone === 'balance' && 'text-theme-accent',
          tone === 'default' && 'text-theme-text',
        )}
        title={value}
      >
        {value}
      </p>
      {subtext && (
        <p className="truncate text-[10.5px] leading-tight text-theme-text-muted" title={subtext}>
          {subtext}
        </p>
      )}
    </div>
  )
}

function CompactMeta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[9.5px] font-bold uppercase tracking-wider text-theme-text-muted">
        {label}
      </p>
      <p
        className={cn('truncate text-[11.5px] font-semibold text-theme-text', mono && 'font-mono')}
        title={value}
      >
        {value}
      </p>
    </div>
  )
}

function InvoiceFinancialDetailModalContent({
  target,
  onClose,
  onCandidateIncorporated,
  onInvoiceConfirmed,
}: {
  target: FinancialDetailTarget
  onClose: () => void
  onCandidateIncorporated?: (candidateId: string, invoiceId: string) => void
  onInvoiceConfirmed?: (payload: {
    candidateId: string
    invoiceId: string
    validation: SaveInvoiceValidationResult
  }) => void
}) {
  const initialPlan = useMemo(() => getFinancialDetailFetchPlan(target), [target])
  const todaySantiago = useMemo(() => todayInSantiago(), [])
  const initialConfirmDraft = useMemo(
    () => buildInitialConfirmationDraft(target, null, todaySantiago),
    [target, todaySantiago],
  )

  // Si la factura era NEW y se incorpora durante Confirmar factura, localInvoiceId conserva su ID para no duplicar incorporación
  const [localInvoiceId, setLocalInvoiceId] = useState<string | null>(initialPlan.invoiceId)

  const [detail, setDetail] = useState<InvoiceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(initialPlan.shouldFetchInvoiceDetail)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailNonce, setDetailNonce] = useState(0)

  const [payments, setPayments] = useState<InvoicePaymentsHistory | null>(null)
  const [paymentsRequestedAfterDetail, setPaymentsRequestedAfterDetail] = useState(false)
  const [paymentsLoading, setPaymentsLoading] = useState(initialPlan.shouldFetchPayments)
  const [paymentsError, setPaymentsError] = useState<string | null>(null)
  const [paymentsNonce, setPaymentsNonce] = useState(0)

  // Formulario «Confirmar factura» (para NEW y PENDING)
  const [confirmTotalText, setConfirmTotalText] = useState(initialConfirmDraft.totalAmountText)
  const [confirmIssueDate, setConfirmIssueDate] = useState(initialConfirmDraft.issueDate)
  const [confirmDueDate, setConfirmDueDate] = useState(initialConfirmDraft.dueDate)
  const [confirmPriorStatus, setConfirmPriorStatus] = useState<PriorPaymentStatus>(
    initialConfirmDraft.priorPaymentStatus,
  )
  const [confirmInitialBalanceText, setConfirmInitialBalanceText] = useState(
    initialConfirmDraft.historicalInitialBalanceText,
  )
  const [confirmCutoffDate, setConfirmCutoffDate] = useState(
    initialConfirmDraft.historicalBalanceCutoffDate,
  )
  const [confirmDiscrepancyNote, setConfirmDiscrepancyNote] = useState(
    initialConfirmDraft.discrepancyResolutionNote,
  )
  const [confirmErrors, setConfirmErrors] = useState<string[]>([])
  const [isConfirmingInvoice, setIsConfirmingInvoice] = useState(false)

  // Formulario «Registrar movimiento» (para VALIDATED)
  const [movementMode, setMovementMode] = useState<PaymentMovementMode>('FULL')
  const [amountText, setAmountText] = useState('')
  const [paymentDate, setPaymentDate] = useState(todaySantiago)
  const [referenceText, setReferenceText] = useState('')
  const [paymentFormError, setPaymentFormError] = useState<string | null>(null)
  const [paymentFormNotice, setPaymentFormNotice] = useState<string | null>(null)
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false)
  const paymentAttemptRef = useRef<OperationAttemptTracker | null>(null)

  // Reversa de movimiento vigente
  const [reversingPaymentId, setReversingPaymentId] = useState<string | null>(null)
  const [reversalReason, setReversalReason] = useState('')
  const [reversalError, setReversalError] = useState<string | null>(null)
  const [isSubmittingReversal, setIsSubmittingReversal] = useState(false)
  const reversalAttemptRef = useRef<OperationAttemptTracker | null>(null)

  const [pdfViewer, setPdfViewer] = useState<PdfViewerState | null>(null)
  const [openingInboxPdf, setOpeningInboxPdf] = useState(false)
  const [inboxPdfError, setInboxPdfError] = useState<string | null>(null)

  const shouldFetchPayments =
    initialPlan.shouldFetchPayments || paymentsRequestedAfterDetail

  useEffect(() => {
    if (!initialPlan.shouldFetchInvoiceDetail || !initialPlan.invoiceId) return
    let active = true
    void getInvoiceValidationDetail(initialPlan.invoiceId)
      .then(result => {
        if (!active) return
        if (!result.ok) {
          setDetailError(result.error)
          setDetail(null)
          setDetailLoading(false)
          return
        }
        setDetailError(null)
        setDetail(result.data)
        setDetailLoading(false)

        // Sincroniza valores guardados de la factura PENDING con el formulario de confirmación
        const syncedDraft = buildInitialConfirmationDraft(target, result.data, todaySantiago)
        setConfirmTotalText(syncedDraft.totalAmountText)
        setConfirmIssueDate(syncedDraft.issueDate)
        if (syncedDraft.dueDate) setConfirmDueDate(syncedDraft.dueDate)
        setConfirmPriorStatus(syncedDraft.priorPaymentStatus)
        setConfirmInitialBalanceText(syncedDraft.historicalInitialBalanceText)
        setConfirmCutoffDate(syncedDraft.historicalBalanceCutoffDate)
        if (syncedDraft.discrepancyResolutionNote) {
          setConfirmDiscrepancyNote(syncedDraft.discrepancyResolutionNote)
        }

        if (
          shouldFetchPaymentsAfterDetail(
            result.data.invoice.validation_status,
            initialPlan.shouldFetchPayments,
          )
        ) {
          setPaymentsLoading(true)
          setPaymentsError(null)
          setPaymentsRequestedAfterDetail(true)
        }
      })
      .catch(() => {
        if (!active) return
        setDetailError('No se pudo cargar el detalle documental de la factura.')
        setDetailLoading(false)
      })
    return () => {
      active = false
    }
  }, [
    initialPlan.shouldFetchInvoiceDetail,
    initialPlan.invoiceId,
    initialPlan.shouldFetchPayments,
    detailNonce,
    target,
    todaySantiago,
  ])

  useEffect(() => {
    if (!shouldFetchPayments || !localInvoiceId) return
    let active = true
    void getInvoicePayments(localInvoiceId)
      .then(result => {
        if (!active) return
        if (!result.ok) {
          setPaymentsError(result.error)
          setPayments(null)
          setPaymentsLoading(false)
          return
        }
        setPaymentsError(null)
        setPayments(result.data)
        setPaymentsLoading(false)
        setAmountText(prev =>
          prev.trim()
            ? prev
            : resolveDefaultPaymentAmountText('FULL', result.data.current_balance),
        )
      })
      .catch(() => {
        if (!active) return
        setPaymentsError('No se pudo consultar el historial de pagos de la factura.')
        setPaymentsLoading(false)
      })
    return () => {
      active = false
    }
  }, [shouldFetchPayments, localInvoiceId, paymentsNonce])

  const busy = isSubmittingPayment || isSubmittingReversal || isConfirmingInvoice

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !pdfViewer && !busy) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, pdfViewer, busy])

  const effectiveStatus =
    detail?.invoice.validation_status ??
    (localInvoiceId && !target.candidate.invoice_id ? 'PENDING' : target.effectiveStatus)
  const effectiveState: FinancialDetailTarget['state'] = !localInvoiceId
    ? 'NEW'
    : effectiveStatus === 'PENDING'
      ? 'PENDING'
      : effectiveStatus === 'VALIDATED'
        ? 'VALIDATED'
        : 'OTHER'

  const effectiveTarget = useMemo<FinancialDetailTarget>(
    () => ({
      ...target,
      candidate: {
        ...target.candidate,
        invoice_id: localInvoiceId,
      },
      effectiveStatus,
      state: effectiveState,
    }),
    [target, localInvoiceId, effectiveStatus, effectiveState],
  )

  const statusBadge = useMemo(
    () => resolveFinancialStatusBadge(effectiveState, effectiveStatus, payments),
    [effectiveState, effectiveStatus, payments],
  )

  const stripModel = useMemo(
    () =>
      buildFinancialStripModel({
        target: effectiveTarget,
        detail,
        payments,
        paymentsLoading,
        paymentsError,
      }),
    [effectiveTarget, detail, payments, paymentsLoading, paymentsError],
  )

  const parsedConfirmTotal = useMemo(() => {
    const parsed = parseClpAmountInput(confirmTotalText)
    return parsed !== null && !Number.isNaN(parsed) && parsed > 0 ? parsed : null
  }, [confirmTotalText])

  const confirmationDiscrepancy = useMemo(
    () =>
      evaluateConfirmationDiscrepancy({
        target: effectiveTarget,
        detail,
        totalAmount: parsedConfirmTotal,
        issueDate: confirmIssueDate.trim(),
      }),
    [effectiveTarget, detail, parsedConfirmTotal, confirmIssueDate],
  )

  const previewOpeningBalance = useMemo(() => {
    if (parsedConfirmTotal === null) return null
    if (confirmPriorStatus === 'NO_PRIOR_PAYMENTS') return parsedConfirmTotal
    if (confirmPriorStatus === 'FULLY_PAID_PRIOR') return 0
    if (confirmPriorStatus === 'PARTIAL_PRIOR_PAYMENTS') {
      const bal = parseClpAmountInput(confirmInitialBalanceText)
      return bal !== null && !Number.isNaN(bal) && bal > 0 && bal < parsedConfirmTotal
        ? bal
        : null
    }
    return null
  }, [parsedConfirmTotal, confirmPriorStatus, confirmInitialBalanceText])

  const folioDisplay = detail?.invoice.document_folio ?? target.candidate.folio ?? '—'
  const supplierName = detail?.supplier.business_name ?? target.candidate.supplier_name
  const rutDisplay = formatRut(
    detail?.supplier.rut || detail?.invoice.issuer_rut || target.candidate.issuer_rut,
  )
  const issueDateDisplay =
    formatCivilDate(
      effectiveState === 'VALIDATED'
        ? detail?.invoice.issue_date ?? target.effectiveIssueDate
        : confirmIssueDate || detail?.invoice.issue_date || target.effectiveIssueDate,
    ) || '—'
  const dueDateValue =
    effectiveState === 'VALIDATED'
      ? detail?.invoice.due_date ?? target.effectiveDueDate ?? null
      : confirmDueDate || target.effectiveDueDate || detail?.invoice.due_date || null
  const dueDateDisplay = formatCivilDate(dueDateValue) || 'Por confirmar'
  const dueBadgeText = dueSourceLabel(target.dueSource)
  const purchaseType = detail?.invoice.purchase_type ?? target.candidate.purchase_type

  const currentBalance = payments?.current_balance ?? null
  const canRegisterPayment = Boolean(
    effectiveState === 'VALIDATED' &&
      payments &&
      payments.can_register_payment &&
      currentBalance != null &&
      currentBalance > 0,
  )

  function handleSelectPriorStatus(nextStatus: PriorPaymentStatus) {
    setConfirmPriorStatus(nextStatus)
    setConfirmErrors([])
    if (nextStatus === 'NO_PRIOR_PAYMENTS') {
      setConfirmInitialBalanceText('')
      setConfirmCutoffDate('')
    } else {
      if (!confirmCutoffDate.trim()) {
        const defaultCutoff =
          confirmIssueDate && todaySantiago < confirmIssueDate
            ? confirmIssueDate
            : todaySantiago
        setConfirmCutoffDate(defaultCutoff)
      }
      if (nextStatus === 'FULLY_PAID_PRIOR') {
        setConfirmInitialBalanceText('')
      }
    }
  }

  async function handleConfirmInvoiceSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (isConfirmingInvoice) return

    setConfirmErrors([])

    const checked = validateInvoiceConfirmationDraft({
      target: effectiveTarget,
      detail,
      totalAmountText: confirmTotalText,
      issueDate: confirmIssueDate,
      dueDate: confirmDueDate,
      priorPaymentStatus: confirmPriorStatus,
      historicalInitialBalanceText: confirmInitialBalanceText,
      historicalBalanceCutoffDate: confirmCutoffDate,
      discrepancyResolutionNote: confirmDiscrepancyNote,
    })

    if (!checked.ok) {
      setConfirmErrors(checked.errors)
      return
    }

    setIsConfirmingInvoice(true)
    try {
      const result = await confirmInvoiceFromFinancialPanel({
        ...checked.payload,
        invoiceId: localInvoiceId,
      })

      if (!result.ok) {
        if (result.incorporatedInvoiceId && result.incorporatedInvoiceId !== localInvoiceId) {
          setLocalInvoiceId(result.incorporatedInvoiceId)
          onCandidateIncorporated?.(
            target.candidate.candidate_id,
            result.incorporatedInvoiceId,
          )
        }
        if (result.detail) {
          setDetail(result.detail)
        }
        setConfirmErrors([result.error])
        toast.error(result.error)
        return
      }

      setLocalInvoiceId(result.invoiceId)
      if (result.detail) {
        setDetail(result.detail)
      } else if (detail) {
        setDetail({
          ...detail,
          invoice: {
            ...detail.invoice,
            validation_status: result.validation.validation_status,
            issue_date: result.validation.issue_date,
            due_date: result.validation.due_date,
            net_amount: result.validation.net_amount,
            tax_amount: result.validation.tax_amount,
            total_amount: result.validation.total_amount,
            prior_payment_status: result.validation.prior_payment_status,
            historical_initial_balance: result.validation.historical_initial_balance,
            historical_balance_cutoff_date: result.validation.historical_balance_cutoff_date,
            discrepancy_status: result.validation.discrepancy_status,
            discrepancy_resolution_note: result.validation.discrepancy_resolution_note,
            validated_at: result.validation.validated_at,
            validated_by: result.validation.validated_by,
          },
        })
      }

      setPaymentsLoading(false)
      if (result.payments) {
        setPayments(result.payments)
        setPaymentsError(null)
        setMovementMode('FULL')
        setAmountText(resolveDefaultPaymentAmountText('FULL', result.payments.current_balance))
      } else {
        setPayments(null)
        setPaymentsError(
          result.paymentsError || 'Historial de pagos temporalmente no disponible.',
        )
      }

      setPaymentFormNotice(
        `Factura FA ${folioDisplay} confirmada y validada correctamente.`,
      )
      toast.success(`Factura FA ${folioDisplay} confirmada correctamente.`)

      onInvoiceConfirmed?.({
        candidateId: target.candidate.candidate_id,
        invoiceId: result.invoiceId,
        validation: result.validation,
      })
    } catch {
      const msg = 'Error de conexión al confirmar la factura. Intente nuevamente.'
      setConfirmErrors([msg])
      toast.error(msg)
    } finally {
      setIsConfirmingInvoice(false)
    }
  }

  function handleSelectMode(nextMode: PaymentMovementMode) {
    setMovementMode(nextMode)
    setPaymentFormError(null)
    setPaymentFormNotice(null)
    if (nextMode === 'FULL') {
      setAmountText(amountToEditableString(currentBalance))
    } else if (
      currentBalance != null &&
      amountText.trim() === amountToEditableString(currentBalance)
    ) {
      setAmountText('')
    }
  }

  async function handleSubmitPayment(event: React.FormEvent) {
    event.preventDefault()
    if (!localInvoiceId || isSubmittingPayment) return

    setPaymentFormError(null)
    setPaymentFormNotice(null)

    const validation = validatePaymentFormDraft({
      mode: movementMode,
      amountText,
      paymentDate,
      referenceText,
      currentBalance,
      todaySantiago,
      priorPaymentStatus: payments?.prior_payment_status ?? detail?.invoice.prior_payment_status,
      historicalBalanceCutoffDate:
        payments?.historical_balance_cutoff_date ??
        detail?.invoice.historical_balance_cutoff_date,
    })

    if (!validation.ok) {
      setPaymentFormError(validation.error)
      return
    }

    const signature = [
      localInvoiceId,
      movementMode,
      validation.amount,
      validation.paymentDate,
      validation.reference ?? '',
    ].join('|')
    const tracker = resolveOperationIdForAttempt(
      paymentAttemptRef.current,
      signature,
      createOperationUuid,
    )
    paymentAttemptRef.current = tracker

    setIsSubmittingPayment(true)
    try {
      const result = await registerInvoicePayment({
        invoiceId: localInvoiceId,
        paymentDate: validation.paymentDate,
        amount: validation.amount,
        reference: validation.reference,
        operationId: tracker.operationId,
      })

      if (!result.ok) {
        setPaymentFormError(result.error)
        toast.error(result.error)
        if (!result.uncertainOutcome) {
          paymentAttemptRef.current = null
        }
        return
      }

      paymentAttemptRef.current = null
      const nextHistory = applyConfirmedPaymentToHistory(payments, result.payment, result.balance)
      setPayments(nextHistory)
      setReferenceText('')
      const nextDefaultMode: PaymentMovementMode = 'FULL'
      setMovementMode(nextDefaultMode)
      setAmountText(resolveDefaultPaymentAmountText(nextDefaultMode, result.balance.current_balance))

      const label = movementMode === 'FULL' ? 'Pago' : 'Abono'
      const msg = result.idempotentReplay
        ? `${label} ya estaba registrado (confirmación idempotente).`
        : `${label} de ${formatFinancialClp(result.payment.amount, { allowDecimals: true })} registrado correctamente.`
      setPaymentFormNotice(msg)
      toast.success(msg)
    } catch {
      const fallback =
        'Error de conexión al registrar el movimiento. Puede reintentar sin riesgo de duplicar.'
      setPaymentFormError(fallback)
      toast.error(fallback)
    } finally {
      setIsSubmittingPayment(false)
    }
  }

  function handleStartReversal(paymentId: string) {
    setReversingPaymentId(paymentId)
    setReversalReason('')
    setReversalError(null)
    setPaymentFormNotice(null)
  }

  function handleCancelReversal() {
    if (isSubmittingReversal) return
    setReversingPaymentId(null)
    setReversalReason('')
    setReversalError(null)
  }

  async function handleConfirmReversal(paymentId: string) {
    if (isSubmittingReversal) return
    const trimmedReason = reversalReason.trim()
    if (trimmedReason.length < 3 || trimmedReason.length > 500) {
      setReversalError('Ingrese un motivo de reversa de al menos 3 caracteres.')
      return
    }

    setReversalError(null)
    const signature = `${paymentId}|${trimmedReason}`
    const tracker = resolveOperationIdForAttempt(
      reversalAttemptRef.current,
      signature,
      createOperationUuid,
    )
    reversalAttemptRef.current = tracker

    setIsSubmittingReversal(true)
    try {
      const result = await reverseInvoicePayment({
        paymentId,
        operationId: tracker.operationId,
        reason: trimmedReason,
      })

      if (!result.ok) {
        setReversalError(result.error)
        toast.error(result.error)
        if (!result.uncertainOutcome) {
          reversalAttemptRef.current = null
        }
        return
      }

      reversalAttemptRef.current = null
      const nextHistory = applyConfirmedReversalToHistory(
        payments,
        result.reversal,
        result.payment,
        result.balance,
      )
      setPayments(nextHistory)
      setReversingPaymentId(null)
      setReversalReason('')
      setReversalError(null)
      if (movementMode === 'FULL') {
        setAmountText(amountToEditableString(result.balance.current_balance))
      }

      const msg = result.idempotentReplay
        ? 'La reversa ya estaba registrada.'
        : `Pago de ${formatFinancialClp(result.payment.amount, { allowDecimals: true })} reversado correctamente.`
      setPaymentFormNotice(msg)
      toast.success(msg)
    } catch {
      const fallback =
        'Error de conexión al reversar el pago. Puede reintentar conservando la misma operación.'
      setReversalError(fallback)
      toast.error(fallback)
    } finally {
      setIsSubmittingReversal(false)
    }
  }

  const detailViewerDocuments = useMemo<PurchaseOrderInvoiceDocument[]>(() => {
    if (!detail) return []
    return detail.documents.map(doc => ({
      id: doc.id,
      document_number: doc.document_number || detail.invoice.document_folio,
      file_name: doc.file_name,
      mime_type: doc.mime_type,
      has_file: doc.has_file,
    }))
  }, [detail])

  const firstDetailViewableDoc = useMemo(
    () => detailViewerDocuments.find(doc => doc.has_file) ?? null,
    [detailViewerDocuments],
  )

  const canOpenHeaderPdf = Boolean(
    firstDetailViewableDoc || (!detail && target.hasInboxDocument === true),
  )

  const openDetailPdfViewer = useCallback(
    (documentId?: string) => {
      if (!detail || detailViewerDocuments.length === 0) return
      const targetDocId =
        documentId ?? detailViewerDocuments.find(doc => doc.has_file)?.id ?? detailViewerDocuments[0]?.id
      setPdfViewer({
        kind: 'INVOICE',
        invoiceId: detail.invoice.id,
        correlative:
          detail.purchase_orders.map(po => po.correlative).join(', ') ||
          `FA ${detail.invoice.document_folio}`,
        supplierName: detail.supplier.business_name,
        documents: detailViewerDocuments,
        initialDocumentId: targetDocId,
      })
    },
    [detail, detailViewerDocuments],
  )

  const openInboxPdfViewer = useCallback(async () => {
    setInboxPdfError(null)
    setOpeningInboxPdf(true)
    try {
      const result = await getCxpInboxDocuments(target.candidate.candidate_id)
      if ('error' in result) {
        setInboxPdfError(result.error)
        return
      }
      const mappedDocs: PurchaseOrderInvoiceDocument[] = result.documents.map(doc => ({
        id: doc.id,
        document_number: doc.document_number || folioDisplay,
        file_name: doc.file_name,
        mime_type: doc.mime_type,
        has_file: doc.has_file,
      }))
      const firstViewable = mappedDocs.find(doc => doc.has_file)
      if (!firstViewable) {
        setInboxPdfError('El respaldo ya no está disponible. Actualice la bandeja.')
        return
      }
      setPdfViewer({
        kind: 'INBOX',
        candidateKey: target.candidate.candidate_id,
        correlative: `FA ${folioDisplay}`,
        supplierName,
        documents: mappedDocs,
        initialDocumentId: firstViewable.id,
      })
    } catch {
      setInboxPdfError('No se pudieron consultar los respaldos de la factura.')
    } finally {
      setOpeningInboxPdf(false)
    }
  }, [target.candidate.candidate_id, folioDisplay, supplierName])

  const handleHeaderPdfClick = useCallback(() => {
    if (firstDetailViewableDoc) {
      openDetailPdfViewer(firstDetailViewableDoc.id)
      return
    }
    void openInboxPdfViewer()
  }, [firstDetailViewableDoc, openDetailPdfViewer, openInboxPdfViewer])

  const loadViewerSignedUrl = useCallback(
    (documentId: string) => {
      if (!pdfViewer) return Promise.resolve({ error: 'Seleccione un documento.' })
      if (pdfViewer.kind === 'INVOICE') {
        return getCxpReceiptDocumentSignedUrl(pdfViewer.invoiceId, documentId)
      }
      return getCxpInboxDocumentSignedUrl(pdfViewer.candidateKey, documentId)
    },
    [pdfViewer],
  )

  function handleRetryDetail() {
    if (!localInvoiceId) return
    setDetailLoading(true)
    setDetailError(null)
    setDetailNonce(n => n + 1)
  }

  function handleRetryPayments() {
    if (!localInvoiceId) return
    setPaymentsRequestedAfterDetail(true)
    setPaymentsLoading(true)
    setPaymentsError(null)
    setPaymentsNonce(n => n + 1)
  }

  const showConfirmationForm =
    effectiveState === 'NEW' || effectiveState === 'PENDING'

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="fixed inset-0 bg-black/35 backdrop-blur-[1px] transition-opacity"
        onClick={() => {
          if (!busy) onClose()
        }}
      />

      {/* Panel lateral derecho (~52-55% del ancho de escritorio en 1024x768 y 1366x768) */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="cxp-financial-modal-title"
        onClick={event => event.stopPropagation()}
        className="relative z-10 flex h-full w-full flex-col border-l border-theme-border bg-theme-surface shadow-2xl sm:w-[54vw] sm:min-w-[530px] sm:max-w-[760px]"
      >
        {/* Cabecera compacta */}
        <header className="shrink-0 border-b border-theme-border bg-theme-surface px-3.5 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  id="cxp-financial-modal-title"
                  className="flex items-center gap-1.5 text-lg font-extrabold tracking-tight text-theme-text sm:text-xl"
                >
                  <ReceiptText className="h-5 w-5 shrink-0 text-theme-accent" />
                  <span>FA {folioDisplay}</span>
                </h2>
                <span
                  className={cn(
                    'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                    statusBadgeClasses(statusBadge.tone),
                  )}
                >
                  {statusBadge.label}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold',
                    purchaseType === 'SERVICES'
                      ? 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                      : 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
                  )}
                >
                  {purchaseTypeLabel(purchaseType)}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-theme-text-muted">
                <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm font-bold text-theme-text sm:text-[15px]">
                  <Building2 className="h-4 w-4 shrink-0 text-theme-text-muted" />
                  <span className="truncate" title={supplierName}>
                    {supplierName}
                  </span>
                </span>
                <span className="font-mono text-xs">{rutDisplay}</span>
                <span className="text-theme-border">·</span>
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <CalendarDays className="h-3 w-3 shrink-0" />
                  Emisión: <strong className="font-semibold text-theme-text">{issueDateDisplay}</strong>
                </span>
                <span className="inline-flex items-center gap-1 tabular-nums">
                  Venc.: <strong className="font-semibold text-theme-text">{dueDateDisplay}</strong>
                  {dueBadgeText && (
                    <span className="rounded bg-theme-bg px-1 py-0.2 text-[9.5px] text-theme-text-muted">
                      {dueBadgeText}
                    </span>
                  )}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {canOpenHeaderPdf && (
                <button
                  type="button"
                  disabled={openingInboxPdf}
                  onClick={handleHeaderPdfClick}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2 text-xs font-semibold text-theme-text transition-colors hover:bg-theme-surface-hover disabled:opacity-50"
                >
                  {openingInboxPdf ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-accent" />
                  ) : (
                    <FileText className="h-3.5 w-3.5 text-theme-accent" />
                  )}
                  <span>Ver PDF</span>
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                aria-label="Cerrar panel financiero"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Franja horizontal compacta: Total factura | Pagado | Saldo */}
        <div className="shrink-0 grid grid-cols-3 divide-x divide-theme-border border-b border-theme-border bg-theme-bg/60">
          <StripMetric
            label="Total factura"
            value={stripModel.totalLabel}
            subtext={stripModel.totalSubtext}
          />
          <StripMetric
            label="Pagado"
            value={stripModel.paidLabel}
            subtext={stripModel.paidSubtext}
            tone={stripModel.confirmed ? 'paid' : 'default'}
          />
          <StripMetric
            label="Saldo"
            value={stripModel.balanceLabel}
            subtext={stripModel.balanceSubtext}
            tone={stripModel.confirmed ? 'balance' : 'default'}
          />
        </div>

        {/* Cuerpo vertical compacto con scroll interno */}
        <div className="flex-1 min-h-0 divide-y divide-theme-border overflow-y-auto overflow-x-hidden">
          {/* SECCIÓN 1: «Confirmar factura» (NEW / PENDING) o «Registrar movimiento» (VALIDATED) */}
          <section className="px-3.5 py-2.5">
            {showConfirmationForm && (
              <form onSubmit={e => void handleConfirmInvoiceSubmit(e)} className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-theme-text">
                    <ShieldCheck className="h-3.5 w-3.5 text-theme-accent" />
                    <span>Confirmar factura</span>
                  </h3>
                  <span className="inline-flex items-center rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                    {confirmationDiscrepancy.referenceAmountRounded != null
                      ? `Propuesta pendiente de confirmación · Ref. recepción ${formatFinancialClp(confirmationDiscrepancy.referenceAmountRounded)}`
                      : 'Propuesta pendiente de confirmación (no es deuda validada)'}
                  </span>
                </div>

                {/* Fila horizontal compacta: Monto total | Emisión | Vencimiento */}
                <div className="grid grid-cols-12 gap-2">
                  <label className="col-span-4 block">
                    <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                      Monto total factura (CLP)
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={confirmTotalText}
                      disabled={isConfirmingInvoice}
                      onChange={e => {
                        setConfirmTotalText(e.target.value)
                        setConfirmErrors([])
                      }}
                      placeholder="Ej. 9936381"
                      className={cn(erpInputClass, 'h-7 w-full px-2 text-xs font-semibold tabular-nums')}
                    />
                  </label>

                  <label className="col-span-4 block">
                    <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                      Emisión
                    </span>
                    <input
                      type="date"
                      value={confirmIssueDate}
                      disabled={isConfirmingInvoice}
                      onChange={e => {
                        setConfirmIssueDate(e.target.value)
                        setConfirmErrors([])
                      }}
                      className={cn(erpInputClass, 'h-7 w-full px-2 text-xs tabular-nums')}
                    />
                  </label>

                  <label className="col-span-4 block">
                    <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                      Vencimiento
                    </span>
                    <input
                      type="date"
                      value={confirmDueDate}
                      min={confirmIssueDate || undefined}
                      disabled={isConfirmingInvoice}
                      onChange={e => {
                        setConfirmDueDate(e.target.value)
                        setConfirmErrors([])
                      }}
                      className={cn(erpInputClass, 'h-7 w-full px-2 text-xs tabular-nums')}
                    />
                  </label>
                </div>

                {/* Declaración simple de pagos anteriores */}
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                      Pagos anteriores al módulo
                    </span>
                    <div
                      role="group"
                      aria-label="Declaración de pagos anteriores"
                      className="inline-flex rounded-md border border-theme-border bg-theme-bg p-0.5 text-[11px] font-semibold"
                    >
                      <button
                        type="button"
                        disabled={isConfirmingInvoice}
                        onClick={() => handleSelectPriorStatus('NO_PRIOR_PAYMENTS')}
                        className={cn(
                          'rounded px-2 py-0.5 transition-colors',
                          confirmPriorStatus === 'NO_PRIOR_PAYMENTS'
                            ? 'bg-theme-accent text-white shadow-2xs'
                            : 'text-theme-text-muted hover:text-theme-text',
                        )}
                      >
                        Sin pagos
                      </button>
                      <button
                        type="button"
                        disabled={isConfirmingInvoice}
                        onClick={() => handleSelectPriorStatus('PARTIAL_PRIOR_PAYMENTS')}
                        className={cn(
                          'rounded px-2 py-0.5 transition-colors',
                          confirmPriorStatus === 'PARTIAL_PRIOR_PAYMENTS'
                            ? 'bg-theme-accent text-white shadow-2xs'
                            : 'text-theme-text-muted hover:text-theme-text',
                        )}
                      >
                        Abonos anteriores
                      </button>
                      <button
                        type="button"
                        disabled={isConfirmingInvoice}
                        onClick={() => handleSelectPriorStatus('FULLY_PAID_PRIOR')}
                        className={cn(
                          'rounded px-2 py-0.5 transition-colors',
                          confirmPriorStatus === 'FULLY_PAID_PRIOR'
                            ? 'bg-theme-accent text-white shadow-2xs'
                            : 'text-theme-text-muted hover:text-theme-text',
                        )}
                      >
                        Factura ya pagada
                      </button>
                    </div>
                  </div>

                  {confirmPriorStatus === 'PARTIAL_PRIOR_PAYMENTS' && (
                    <div className="grid grid-cols-12 gap-2 rounded-md border border-theme-border bg-theme-bg/40 p-2">
                      <label className="col-span-6 block">
                        <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                          Saldo de apertura pendiente (CLP)
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={confirmInitialBalanceText}
                          disabled={isConfirmingInvoice}
                          onChange={e => {
                            setConfirmInitialBalanceText(e.target.value)
                            setConfirmErrors([])
                          }}
                          placeholder="Monto aún adeudado"
                          className={cn(erpInputClass, 'h-7 w-full px-2 text-xs font-semibold tabular-nums')}
                        />
                      </label>
                      <label className="col-span-6 block">
                        <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                          Fecha de corte histórico
                        </span>
                        <input
                          type="date"
                          value={confirmCutoffDate}
                          min={confirmIssueDate || undefined}
                          disabled={isConfirmingInvoice}
                          onChange={e => {
                            setConfirmCutoffDate(e.target.value)
                            setConfirmErrors([])
                          }}
                          className={cn(erpInputClass, 'h-7 w-full px-2 text-xs tabular-nums')}
                        />
                      </label>
                    </div>
                  )}

                  {confirmPriorStatus === 'FULLY_PAID_PRIOR' && (
                    <div className="grid grid-cols-12 items-center gap-2 rounded-md border border-theme-border bg-theme-bg/40 p-2">
                      <div className="col-span-6 text-xs text-theme-text-muted">
                        Saldo de apertura reconocido: <strong className="text-theme-text">$0 (Saldada)</strong>
                      </div>
                      <label className="col-span-6 block">
                        <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                          Fecha de corte de pago
                        </span>
                        <input
                          type="date"
                          value={confirmCutoffDate}
                          min={confirmIssueDate || undefined}
                          disabled={isConfirmingInvoice}
                          onChange={e => {
                            setConfirmCutoffDate(e.target.value)
                            setConfirmErrors([])
                          }}
                          className={cn(erpInputClass, 'h-7 w-full px-2 text-xs tabular-nums')}
                        />
                      </label>
                    </div>
                  )}
                </div>

                {/* Justificación automática si el monto o fecha difiere de la recepción */}
                {confirmationDiscrepancy.hasAnyDiscrepancy && (
                  <div className="space-y-1.5 rounded-md border border-amber-500/35 bg-amber-500/10 p-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-amber-900 dark:text-amber-200">
                      <span className="flex items-center gap-1 font-semibold">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        Diferencia detectada respecto a recepción
                      </span>
                      {confirmationDiscrepancy.hasAmountDiscrepancy &&
                        confirmationDiscrepancy.amountDifference !== null && (
                          <span className="font-mono text-[11px] font-bold tabular-nums">
                            {confirmationDiscrepancy.amountDifference > 0 ? '+' : ''}
                            {formatFinancialClp(confirmationDiscrepancy.amountDifference, {
                              allowDecimals: true,
                            })}
                          </span>
                        )}
                    </div>
                    <input
                      type="text"
                      value={confirmDiscrepancyNote}
                      maxLength={500}
                      disabled={isConfirmingInvoice}
                      onChange={e => {
                        setConfirmDiscrepancyNote(e.target.value)
                        setConfirmErrors([])
                      }}
                      placeholder="Justifique la diferencia de monto o fecha (obligatorio, mín. 10 caracteres)…"
                      className={cn(erpInputClass, 'h-7 w-full bg-theme-surface px-2 text-xs')}
                    />
                  </div>
                )}

                {confirmErrors.length > 0 && (
                  <div
                    role="alert"
                    className="space-y-0.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300"
                  >
                    {confirmErrors.map((err, idx) => (
                      <p key={idx}>{err}</p>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                  <span className="text-[11px] text-theme-text-muted">
                    Saldo inicial a confirmar:{' '}
                    <strong className="font-semibold tabular-nums text-theme-text">
                      {previewOpeningBalance != null
                        ? formatFinancialClp(previewOpeningBalance, { allowDecimals: true })
                        : 'Por definir'}
                    </strong>
                  </span>

                  <button
                    type="submit"
                    disabled={
                      isConfirmingInvoice ||
                      confirmationDiscrepancy.structuralBlockers.length > 0
                    }
                    className="inline-flex h-7 items-center gap-1.5 rounded-md bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isConfirmingInvoice ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Confirmando…</span>
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="h-3.5 w-3.5" />
                        <span>Confirmar factura</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}

            {effectiveState === 'VALIDATED' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-theme-text">
                    <CreditCard className="h-3.5 w-3.5 text-theme-accent" />
                    <span>Registrar movimiento</span>
                  </h3>

                  {canRegisterPayment && (
                    <div
                      role="group"
                      aria-label="Tipo de movimiento de pago"
                      className="inline-flex rounded-md border border-theme-border bg-theme-bg p-0.5 text-[11px] font-semibold"
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectMode('FULL')}
                        disabled={isSubmittingPayment}
                        className={cn(
                          'rounded px-2.5 py-0.5 transition-colors',
                          movementMode === 'FULL'
                            ? 'bg-theme-accent text-white shadow-2xs'
                            : 'text-theme-text-muted hover:text-theme-text',
                        )}
                      >
                        Pago total
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSelectMode('PARTIAL')}
                        disabled={isSubmittingPayment}
                        className={cn(
                          'rounded px-2.5 py-0.5 transition-colors',
                          movementMode === 'PARTIAL'
                            ? 'bg-theme-accent text-white shadow-2xs'
                            : 'text-theme-text-muted hover:text-theme-text',
                        )}
                      >
                        Abono
                      </button>
                    </div>
                  )}
                </div>

                {paymentsLoading && (
                  <div className="flex items-center gap-2 rounded-md border border-theme-border bg-theme-bg/40 px-3 py-2 text-xs text-theme-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-accent" />
                    <span>Cargando saldo disponible…</span>
                  </div>
                )}

                {!paymentsLoading && payments && !canRegisterPayment && (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
                    <span className="flex items-center gap-1.5 font-semibold">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      Factura totalmente saldada ($0 pendiente).
                    </span>
                    {payments.payment_count > 0 && (
                      <span className="text-[11px] opacity-85">
                        Puede reversar un pago en la tabla si requiere corregir.
                      </span>
                    )}
                  </div>
                )}

                {!paymentsLoading && canRegisterPayment && (
                  <form onSubmit={e => void handleSubmitPayment(e)} className="space-y-2">
                    <div className="grid grid-cols-12 gap-2">
                      <label className="col-span-4 block">
                        <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                          Monto (CLP)
                        </span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={amountText}
                          disabled={isSubmittingPayment}
                          onChange={e => {
                            setAmountText(e.target.value)
                            setPaymentFormError(null)
                          }}
                          placeholder={
                            movementMode === 'FULL'
                              ? amountToEditableString(currentBalance)
                              : 'Ej. 150000'
                          }
                          className={cn(erpInputClass, 'h-7 w-full px-2 text-xs font-semibold tabular-nums')}
                        />
                      </label>

                      <label className="col-span-4 block">
                        <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                          Fecha efectiva
                        </span>
                        <input
                          type="date"
                          value={paymentDate}
                          max={todaySantiago}
                          min={
                            payments?.prior_payment_status === 'PARTIAL_PRIOR_PAYMENTS' &&
                            payments.historical_balance_cutoff_date
                              ? payments.historical_balance_cutoff_date
                              : undefined
                          }
                          disabled={isSubmittingPayment}
                          onChange={e => {
                            setPaymentDate(e.target.value)
                            setPaymentFormError(null)
                          }}
                          className={cn(erpInputClass, 'h-7 w-full px-2 text-xs tabular-nums')}
                        />
                      </label>

                      <label className="col-span-4 block">
                        <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                          Referencia (opcional)
                        </span>
                        <input
                          type="text"
                          value={referenceText}
                          maxLength={500}
                          disabled={isSubmittingPayment}
                          onChange={e => {
                            setReferenceText(e.target.value)
                            setPaymentFormError(null)
                          }}
                          placeholder="TEF, cartola u obs."
                          className={cn(erpInputClass, 'h-7 w-full px-2 text-xs')}
                        />
                      </label>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] text-theme-text-muted">
                        Saldo vigente:{' '}
                        <strong className="font-semibold tabular-nums text-theme-text">
                          {formatFinancialClp(currentBalance, { allowDecimals: true })}
                        </strong>
                        {payments?.prior_payment_status === 'PARTIAL_PRIOR_PAYMENTS' &&
                          payments.historical_balance_cutoff_date && (
                            <span>
                              {' '}
                              · Posterior a corte {formatCivilDate(payments.historical_balance_cutoff_date)}
                            </span>
                          )}
                      </span>

                      <button
                        type="submit"
                        disabled={isSubmittingPayment}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isSubmittingPayment ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Registrando…</span>
                          </>
                        ) : (
                          <span>
                            {movementMode === 'FULL' ? 'Registrar pago' : 'Registrar abono'}
                          </span>
                        )}
                      </button>
                    </div>
                  </form>
                )}

                {paymentFormError && (
                  <div
                    role="alert"
                    className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300"
                  >
                    {paymentFormError}
                  </div>
                )}

                {paymentFormNotice && !paymentFormError && (
                  <div
                    role="status"
                    className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-200"
                  >
                    {paymentFormNotice}
                  </div>
                )}
              </div>
            )}

            {effectiveState === 'OTHER' && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-800 dark:text-red-200">
                Esta factura se encuentra en estado <strong>{effectiveStatus}</strong> y no admite pagos ni abonos.
              </div>
            )}
          </section>

          {/* SECCIÓN 2: Historial de pagos y abonos */}
          <section className="px-3.5 py-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-theme-text">
                <History className="h-3.5 w-3.5 text-theme-accent" />
                <span>Historial de pagos y abonos</span>
              </h3>

              {effectiveState === 'VALIDATED' && payments && (
                <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-theme-text-muted">
                  {Number(payments.prior_paid_amount ?? 0) > 0 && (
                    <span className="rounded border border-theme-border bg-theme-bg px-1.5 py-0.5 tabular-nums">
                      Previos reconocidos:{' '}
                      <strong className="font-semibold text-theme-text">
                        {formatFinancialClp(payments.prior_paid_amount, { allowDecimals: true })}
                      </strong>
                    </span>
                  )}
                  <span className="rounded border border-theme-border bg-theme-bg px-1.5 py-0.5 font-semibold tabular-nums text-theme-text">
                    {payments.payment_count} {payments.payment_count === 1 ? 'vigente' : 'vigentes'}
                  </span>
                  {payments.reversed_payment_count > 0 && (
                    <span className="rounded border border-red-500/25 bg-red-500/10 px-1.5 py-0.5 font-semibold tabular-nums text-red-700 dark:text-red-300">
                      {payments.reversed_payment_count}{' '}
                      {payments.reversed_payment_count === 1 ? 'reversado' : 'reversados'}
                    </span>
                  )}
                </div>
              )}
            </div>

            {effectiveState !== 'VALIDATED' && (
              <p className="rounded-md border border-dashed border-theme-border bg-theme-bg/30 px-3 py-3 text-center text-xs text-theme-text-muted">
                Sin movimientos confirmados. Confirme la factura arriba para habilitar su saldo e historial de pagos.
              </p>
            )}

            {effectiveState === 'VALIDATED' && !paymentsLoading && paymentsError && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                <span className="font-medium">{paymentsError}</span>
                <button
                  type="button"
                  onClick={handleRetryPayments}
                  className="inline-flex items-center gap-1 rounded border border-red-500/35 bg-theme-surface px-2 py-0.5 text-[11px] font-semibold hover:bg-red-500/10"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reintentar
                </button>
              </div>
            )}

            {effectiveState === 'VALIDATED' && !paymentsLoading && !paymentsError && payments && (
              <>
                {payments.payments.length === 0 ? (
                  <p className="rounded-md border border-dashed border-theme-border bg-theme-bg/30 px-3 py-4 text-center text-xs text-theme-text-muted">
                    {payments.prior_payment_status === 'FULLY_PAID_PRIOR'
                      ? 'Factura saldada con pagos anteriores reconocidos. No registra movimientos individuales en el ERP.'
                      : Number(payments.prior_paid_amount ?? 0) > 0
                        ? `Pagos anteriores reconocidos por ${formatFinancialClp(payments.prior_paid_amount, { allowDecimals: true })} (corte ${formatCivilDate(payments.historical_balance_cutoff_date)}). Sin pagos adicionales en el ERP.`
                        : 'Aún no se han registrado pagos ni abonos en el ERP para esta factura.'}
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-md border border-theme-border bg-theme-surface">
                    <table className="w-full table-fixed border-collapse text-left text-xs">
                      <thead className="border-b border-theme-border bg-theme-bg/70 text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                        <tr>
                          <th className="w-[78px] px-2 py-1.5">Fecha</th>
                          <th className="w-[94px] px-2 py-1.5 text-right">Monto</th>
                          <th className="px-2 py-1.5">Referencia / Motivo</th>
                          <th className="w-[116px] px-2 py-1.5">Usuario</th>
                          <th className="w-[122px] px-2 py-1.5 text-right">Estado / Acción</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-theme-border">
                        {payments.payments.map(payment => {
                          const isReversed = payment.is_reversed || payment.status === 'REVERSED'
                          const isConfirmingThis = reversingPaymentId === payment.id
                          return (
                            <Fragment key={payment.id}>
                              <tr
                                className={cn(
                                  'align-top transition-colors',
                                  isReversed
                                    ? 'bg-red-500/[0.03]'
                                    : 'hover:bg-theme-surface-hover/60',
                                )}
                              >
                                <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-theme-text">
                                  {formatCivilDate(payment.payment_date)}
                                </td>
                                <td
                                  className={cn(
                                    'px-2 py-1.5 text-right whitespace-nowrap font-semibold tabular-nums',
                                    isReversed
                                      ? 'text-theme-text-muted line-through'
                                      : 'text-theme-text',
                                  )}
                                >
                                  {formatFinancialClp(payment.amount, { allowDecimals: true })}
                                </td>
                                <td className="min-w-0 px-2 py-1.5">
                                  <p
                                    className={cn(
                                      'truncate text-theme-text',
                                      (!payment.reference || isReversed) && 'text-theme-text-muted',
                                    )}
                                    title={payment.reference || 'Sin referencia'}
                                  >
                                    {payment.reference || 'Sin referencia'}
                                  </p>
                                  {isReversed && payment.reversal && (
                                    <p
                                      className="mt-0.5 rounded border border-red-500/20 bg-red-500/10 px-1.5 py-0.5 text-[10px] leading-snug text-red-800 dark:text-red-200"
                                      title={payment.reversal.reason}
                                    >
                                      <span className="font-semibold">Reversado:</span>{' '}
                                      {payment.reversal.reason}
                                      <span className="block text-[9.5px] opacity-80">
                                        {payment.reversal.created_by_name || 'Usuario autorizado'} ·{' '}
                                        {formatInstantInSantiago(payment.reversal.created_at)}
                                      </span>
                                    </p>
                                  )}
                                </td>
                                <td className="min-w-0 px-2 py-1.5">
                                  <p
                                    className="truncate text-[11px] font-medium text-theme-text"
                                    title={payment.created_by_name || 'Usuario autorizado'}
                                  >
                                    {payment.created_by_name || 'Usuario autorizado'}
                                  </p>
                                  <p className="truncate text-[9.5px] tabular-nums text-theme-text-muted">
                                    {formatInstantInSantiago(payment.created_at)}
                                  </p>
                                </td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                                  <div className="inline-flex items-center justify-end gap-1.5">
                                    <span
                                      className={cn(
                                        'inline-flex rounded border px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide',
                                        isReversed
                                          ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                                          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                                      )}
                                    >
                                      {isReversed ? 'Reversado' : 'Vigente'}
                                    </span>
                                    {!isReversed && !isConfirmingThis && (
                                      <button
                                        type="button"
                                        disabled={isSubmittingReversal || isSubmittingPayment}
                                        onClick={() => handleStartReversal(payment.id)}
                                        className="inline-flex items-center gap-0.5 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 transition-colors hover:bg-red-500/20 disabled:opacity-50 dark:text-red-300"
                                        title="Reversar este pago"
                                      >
                                        <Undo2 className="h-2.5 w-2.5" />
                                        Reversar
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </tr>

                              {isConfirmingThis && (
                                <tr className="bg-red-500/[0.06]">
                                  <td colSpan={5} className="px-2.5 py-2">
                                    <div className="space-y-1.5">
                                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                                        <span className="font-semibold text-red-800 dark:text-red-200">
                                          Confirmar reversa del pago por{' '}
                                          {formatFinancialClp(payment.amount, { allowDecimals: true })}{' '}
                                          ({formatCivilDate(payment.payment_date)})
                                        </span>
                                        <span className="text-[10px] text-theme-text-muted">
                                          El movimiento original permanecerá auditado como REVERSADO.
                                        </span>
                                      </div>

                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <input
                                          type="text"
                                          value={reversalReason}
                                          maxLength={500}
                                          disabled={isSubmittingReversal}
                                          onChange={e => {
                                            setReversalReason(e.target.value)
                                            setReversalError(null)
                                          }}
                                          placeholder="Indique motivo obligatorio de la reversa (mín. 3 caracteres)…"
                                          className={cn(erpInputClass, 'h-7 flex-1 min-w-[200px] px-2 text-xs')}
                                        />
                                        <button
                                          type="button"
                                          disabled={isSubmittingReversal}
                                          onClick={handleCancelReversal}
                                          className="inline-flex h-7 items-center rounded border border-theme-border bg-theme-surface px-2.5 text-[11px] font-semibold text-theme-text hover:bg-theme-surface-hover"
                                        >
                                          Cancelar
                                        </button>
                                        <button
                                          type="button"
                                          disabled={isSubmittingReversal}
                                          onClick={() => void handleConfirmReversal(payment.id)}
                                          className="inline-flex h-7 items-center gap-1 rounded bg-red-600 px-2.5 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                                        >
                                          {isSubmittingReversal && (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                          )}
                                          <span>
                                            {isSubmittingReversal ? 'Reversando…' : 'Confirmar reversa'}
                                          </span>
                                        </button>
                                      </div>

                                      {reversalError && (
                                        <p className="text-[11px] font-medium text-red-700 dark:text-red-300">
                                          {reversalError}
                                        </p>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>

          {/* SECCIÓN 3: Respaldo documental y recepción (secundaria y compacta) */}
          <section className="bg-theme-bg/25 px-3.5 py-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-theme-text-muted">
                <PackageCheck className="h-3.5 w-3.5 text-theme-accent" />
                <span>Respaldo documental y recepción</span>
              </h3>

              {detailLoading && (
                <span className="inline-flex items-center gap-1 text-[11px] text-theme-text-muted">
                  <Loader2 className="h-3 w-3 animate-spin" /> Cargando…
                </span>
              )}
              {!detailLoading && detailError && (
                <button
                  type="button"
                  onClick={handleRetryDetail}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 hover:underline"
                >
                  <RotateCcw className="h-3 w-3" /> Reintentar detalle
                </button>
              )}
            </div>

            {detail ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md border border-theme-border bg-theme-surface px-2.5 py-2 sm:grid-cols-4">
                  <CompactMeta
                    label="Neto / IVA"
                    value={
                      detail.invoice.net_amount != null && detail.invoice.tax_amount != null
                        ? `${formatFinancialClp(detail.invoice.net_amount)} / ${formatFinancialClp(detail.invoice.tax_amount)}`
                        : 'Sin desglose'
                    }
                  />
                  <CompactMeta
                    label="Pagos previos"
                    value={priorPaymentShortLabel(detail.invoice.prior_payment_status)}
                  />
                  <CompactMeta
                    label={purchaseType === 'SERVICES' ? 'Prestación' : 'Órdenes compra'}
                    value={
                      purchaseType === 'SERVICES'
                        ? detail.invoice.service_delivery_status === 'DELIVERED'
                          ? 'Prestado'
                          : 'Pendiente'
                        : detail.purchase_orders.map(po => po.correlative).join(', ') || 'Sin OC'
                    }
                    mono={purchaseType !== 'SERVICES'}
                  />
                  <CompactMeta
                    label={detail.invoice.validated_by_name ? 'Validada por' : 'Condición'}
                    value={
                      detail.invoice.validated_by_name ||
                      detail.supplier.payment_terms ||
                      (detail.supplier.credit_days ? `${detail.supplier.credit_days} días` : '—')
                    }
                  />
                </div>

                {purchaseType === 'SERVICES' && detail.invoice.service_description && (
                  <p className="rounded-md border border-theme-border bg-theme-surface px-2.5 py-1.5 text-xs text-theme-text">
                    <span className="font-semibold text-theme-text-muted">Servicio:</span>{' '}
                    {detail.invoice.service_description}
                  </p>
                )}

                {detail.receipts.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {detail.receipts.map(receipt => {
                      const pdfDoc = receipt.documents.find(d => d.has_file) ?? null
                      return (
                        <div
                          key={receipt.id}
                          className="inline-flex items-center gap-1.5 rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px]"
                        >
                          <span className="font-semibold text-theme-text">
                            {receipt.receipt_number}
                          </span>
                          <span className="font-mono text-theme-text-muted">
                            ({receipt.purchase_order_correlative})
                          </span>
                          <span className="tabular-nums text-theme-text-muted">
                            {formatFinancialClp(receipt.receipt_total_gross)}
                          </span>
                          {pdfDoc && (
                            <button
                              type="button"
                              onClick={() => openDetailPdfViewer(pdfDoc.id)}
                              className="inline-flex items-center gap-0.5 rounded bg-theme-bg px-1.5 py-0.5 text-[10px] font-semibold text-theme-accent hover:bg-theme-surface-hover"
                            >
                              <FileText className="h-2.5 w-2.5" /> PDF
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2 rounded-md border border-theme-border bg-theme-surface px-2.5 py-2">
                <CompactMeta
                  label="Recepción"
                  value={receptionStatusLabel(
                    target.candidate.reception_status,
                    target.candidate.purchase_type,
                  )}
                />
                <CompactMeta
                  label="OC asociada"
                  value={target.candidate.purchase_orders.join(', ') || 'Sin OC'}
                  mono
                />
                <CompactMeta
                  label="Ref. recepción"
                  value={
                    target.candidate.reference_amount != null
                      ? formatFinancialClp(target.candidate.reference_amount)
                      : '—'
                  }
                />
              </div>
            )}

            {inboxPdfError && (
              <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-700 dark:text-red-300">
                {inboxPdfError}
              </p>
            )}
          </section>
        </div>

        {pdfViewer && (
          <PurchaseOrderInvoiceViewerModal
            key={`${pdfViewer.kind}:${pdfViewer.initialDocumentId ?? 'first'}`}
            correlative={pdfViewer.correlative}
            supplierName={pdfViewer.supplierName}
            documents={pdfViewer.documents}
            initialDocumentId={pdfViewer.initialDocumentId}
            loadSignedUrl={loadViewerSignedUrl}
            onClose={() => setPdfViewer(null)}
          />
        )}
      </aside>
    </div>
  )
}

export function InvoiceFinancialDetailModal({
  target,
  onClose,
  onCandidateIncorporated,
  onInvoiceConfirmed,
}: InvoiceFinancialDetailModalProps) {
  if (!target) return null
  return (
    <InvoiceFinancialDetailModalContent
      key={target.candidate.candidate_id}
      target={target}
      onClose={onClose}
      onCandidateIncorporated={onCandidateIncorporated}
      onInvoiceConfirmed={onInvoiceConfirmed}
    />
  )
}
