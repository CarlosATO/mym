'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileText,
  Info,
  Loader2,
  Lock,
  PackageCheck,
  ReceiptText,
  RotateCcw,
  ShieldAlert,
  Wallet,
  X,
} from 'lucide-react'
import {
  getCxpBsaleDocumentSignedUrl,
  getCxpWarehouseReceiptDocuments,
  getCxpWarehouseReceiptDocumentSignedUrl,
  reopenInvoiceValidation,
  reverseInvoicePayment,
  setInvoiceDueDate,
} from '@/app/actions/cuentas-por-pagar'
import type { PurchaseOrderInvoiceDocument } from '@/app/actions/adquisiciones/purchase-orders'
import { formatCivilDate } from '@/lib/datetime'
import { erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import { PurchaseOrderInvoiceViewerModal } from '@/modules/adquisiciones/ordenes-compra/purchase-order-invoice-viewer-modal'
import type { ReconciledInvoiceEntry } from './bsale-bodega-reconciliation'
import type { InvoiceFinancialStatusOverlay } from './bsale-financial-balance-resolver'
import {
  resolveOperationIdForAttempt,
  type OperationAttemptTracker,
} from './financial-detail-model'
import {
  buildDocumentaryAlertsForEntry,
  codeSiiShortLabel,
  formatSignedClpDifference,
  HISTORICAL_PAYMENT_PENDING_DESCRIPTION,
  HISTORICAL_PAYMENT_PENDING_LABEL,
  resolveFinancialAccreditationBadge,
  resolveMonetaryReconciliationBadge,
  resolvePhysicalReceptionBadge,
  type BsaleBadgeTone,
} from './bsale-reconciliation-view-model'
import { formatClp, formatRut } from './validation-rules'

function createClientOperationUuid(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

interface BsaleReconciliationDetailPanelProps {
  entry: ReconciledInvoiceEntry | null
  financial?: InvoiceFinancialStatusOverlay | null
  onClose: () => void
}

type ViewerMode =
  | {
      kind: 'BSALE_PDF'
      bsaleDocumentId: number
      correlative: string
      supplierName: string
      documents: PurchaseOrderInvoiceDocument[]
      initialDocumentId?: string
    }
  | {
      kind: 'BODEGA_RECEIPTS'
      receiptIds: string[]
      correlative: string
      supplierName: string
      documents: PurchaseOrderInvoiceDocument[]
      initialDocumentId?: string
    }

function badgeClasses(tone: BsaleBadgeTone): string {
  switch (tone) {
    case 'emerald':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'amber':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'sky':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    case 'red':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
    default:
      return 'border-theme-border bg-theme-bg text-theme-text-muted'
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
  tone?: 'default' | 'match' | 'difference' | 'muted'
}) {
  return (
    <div className="min-w-0 px-3 py-2">
      <p className="truncate text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
        {label}
      </p>
      <p
        className={cn(
          'truncate text-sm font-bold tabular-nums',
          tone === 'match' && 'text-emerald-700 dark:text-emerald-300',
          tone === 'difference' && 'text-amber-700 dark:text-amber-300',
          tone === 'muted' && 'text-theme-text-muted',
          tone === 'default' && 'text-theme-text',
        )}
        title={value}
      >
        {value}
      </p>
      {subtext && (
        <p
          className="truncate text-[10.5px] leading-tight text-theme-text-muted"
          title={subtext}
        >
          {subtext}
        </p>
      )}
    </div>
  )
}

function CompactMeta({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[9.5px] font-bold uppercase tracking-wider text-theme-text-muted">
        {label}
      </p>
      <p
        className={cn(
          'truncate text-[11.5px] font-semibold text-theme-text',
          mono && 'font-mono',
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  )
}

function BsaleReconciliationDetailPanelContent({
  entry,
  financial,
  onClose,
}: {
  entry: ReconciledInvoiceEntry
  financial?: InvoiceFinancialStatusOverlay | null
  onClose: () => void
}) {
  const router = useRouter()
  const [viewer, setViewer] = useState<ViewerMode | null>(null)
  const [loadingBodegaDocs, setLoadingBodegaDocs] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [dueDateDraft, setDueDateDraft] = useState(
    financial?.dueDateInfo.dueDate ?? '',
  )
  const [savingDueDate, setSavingDueDate] = useState(false)
  const [dueDateFeedback, setDueDateFeedback] = useState<{
    tone: 'emerald' | 'red'
    message: string
  } | null>(null)

  // Parte 1: Anulación auditada e inmutable de pagos registrados
  const [localFinancial, setLocalFinancial] =
    useState<InvoiceFinancialStatusOverlay | null>(financial ?? null)
  const [reversingPaymentId, setReversingPaymentId] = useState<string | null>(
    null,
  )
  const [reversalReason, setReversalReason] = useState('')
  const [reversalError, setReversalError] = useState<string | null>(null)
  const [reversalNotice, setReversalNotice] = useState<string | null>(null)
  const [isSubmittingReversal, setIsSubmittingReversal] = useState(false)
  const reversalAttemptRef = useRef<OperationAttemptTracker | null>(null)

  // Parte 2: Reapertura administrativa auditada de validación (independiente de la anulación de pagos)
  const [isReopeningValidation, setIsReopeningValidation] = useState(false)
  const [reopenReason, setReopenReason] = useState('')
  const [reopenError, setReopenError] = useState<string | null>(null)
  const [reopenNotice, setReopenNotice] = useState<string | null>(null)
  const [isSubmittingReopen, setIsSubmittingReopen] = useState(false)
  const reopenAttemptRef = useRef<OperationAttemptTracker | null>(null)

  const effectiveFinancial = localFinancial ?? financial ?? null

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !viewer) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, viewer])

  const monetaryBadge = useMemo(
    () => resolveMonetaryReconciliationBadge(entry),
    [entry],
  )
  const receptionBadge = useMemo(
    () => resolvePhysicalReceptionBadge(entry),
    [entry],
  )
  const financialBadge = useMemo(
    () => resolveFinancialAccreditationBadge(effectiveFinancial ?? undefined),
    [effectiveFinancial],
  )
  const alerts = useMemo(
    () => buildDocumentaryAlertsForEntry(entry),
    [entry],
  )

  const handleStartReversal = useCallback((paymentId: string) => {
    setReversingPaymentId(paymentId)
    setReversalReason('')
    setReversalError(null)
    setReversalNotice(null)
  }, [])

  const handleCancelReversal = useCallback(() => {
    if (isSubmittingReversal) return
    setReversingPaymentId(null)
    setReversalReason('')
    setReversalError(null)
  }, [isSubmittingReversal])

  const handleConfirmReversal = useCallback(
    async (paymentId: string) => {
      if (isSubmittingReversal) return
      const trimmedReason = reversalReason.trim()
      if (trimmedReason.length < 3 || trimmedReason.length > 500) {
        setReversalError(
          'Ingrese un motivo de anulación de entre 3 y 500 caracteres.',
        )
        return
      }

      setReversalError(null)
      setReversalNotice(null)
      const signature = `${paymentId}|${trimmedReason}`
      const tracker = resolveOperationIdForAttempt(
        reversalAttemptRef.current,
        signature,
        createClientOperationUuid,
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
          if (!result.uncertainOutcome) {
            reversalAttemptRef.current = null
          }
          return
        }

        reversalAttemptRef.current = null
        setReversingPaymentId(null)
        setReversalReason('')
        setReversalError(null)

        if (effectiveFinancial) {
          const nextTotalPaid = Math.round(
            Number(result.balance.total_paid_amount ?? 0),
          )
          const nextCurrentBalance = Math.round(
            Number(result.balance.current_balance ?? 0),
          )
          const nextIsFullyPaid = Boolean(result.balance.is_fully_paid)
          const nextActiveCount = Number(result.balance.payment_count ?? 0)
          const nextReversedCount = Number(
            result.balance.reversed_payment_count ?? 0,
          )
          const nextReversedAmount = Math.round(
            Number(result.balance.reversed_amount ?? 0),
          )
          const nextStatus = nextIsFullyPaid
            ? 'ACCREDITED_PAID'
            : nextTotalPaid > 0
              ? 'ACCREDITED_PARTIAL_BALANCE'
              : 'ACCREDITED_OPEN_BALANCE'
          const nextLabel = nextIsFullyPaid
            ? 'Pagada · Saldo $0'
            : nextTotalPaid > 0
              ? 'Saldo con abonos'
              : 'Saldo acreditado'
          const nextDetail = nextIsFullyPaid
            ? `${nextActiveCount} pago(s) registrado(s)`
            : nextTotalPaid > 0
              ? `Abonado ${formatClp(nextTotalPaid)}`
              : `${nextReversedCount} pago(s) anulado(s) · Saldo disponible`

          setLocalFinancial({
            ...effectiveFinancial,
            financialBalance: {
              ...effectiveFinancial.financialBalance,
              accreditationStatus: nextStatus,
              accreditationLabel: nextLabel,
              accreditationDetail: nextDetail,
              modulePaidAmountClp: Math.round(
                Number(result.balance.module_paid_amount ?? 0),
              ),
              totalPaidAmountClp: nextTotalPaid,
              currentBalanceClp: nextCurrentBalance,
              isFullyPaid: nextIsFullyPaid,
              activePaymentsCount: nextActiveCount,
              reversedPaymentsCount: nextReversedCount,
              reversedAmountClp: nextReversedAmount,
              paymentsHistory:
                effectiveFinancial.financialBalance.paymentsHistory.map(item =>
                  item.id === result.payment.id ? result.payment : item,
                ),
            },
          })
        }

        setReversalNotice(
          result.idempotentReplay
            ? 'La anulación del pago ya se encontraba registrada.'
            : `Pago de ${formatClp(result.payment.amount)} anulado con trazabilidad. El saldo pendiente volvió a ${formatClp(result.balance.current_balance)}.`,
        )
        router.refresh()
      } catch {
        setReversalError(
          'Error de conexión al anular el pago. Puede reintentar conservando la misma operación.',
        )
      } finally {
        setIsSubmittingReversal(false)
      }
    },
    [effectiveFinancial, isSubmittingReversal, reversalReason, router],
  )

  const handleStartReopenValidation = useCallback(() => {
    setIsReopeningValidation(true)
    setReopenReason('')
    setReopenError(null)
    setReopenNotice(null)
  }, [])

  const handleCancelReopenValidation = useCallback(() => {
    if (isSubmittingReopen) return
    setIsReopeningValidation(false)
    setReopenReason('')
    setReopenError(null)
  }, [isSubmittingReopen])

  const handleConfirmReopenValidation = useCallback(async () => {
    const targetInvoiceId = effectiveFinancial?.cxpInvoiceId
    if (!targetInvoiceId || isSubmittingReopen) return

    if ((effectiveFinancial?.financialBalance.activePaymentsCount ?? 0) > 0) {
      setReopenError(
        'No se puede reabrir la validación mientras existan pagos activos vigentes. Anule primero los pagos activos.',
      )
      return
    }

    const trimmedReason = reopenReason.trim()
    if (trimmedReason.length < 3 || trimmedReason.length > 500) {
      setReopenError(
        'Ingrese un motivo obligatorio de entre 3 y 500 caracteres para reabrir la validación.',
      )
      return
    }

    setReopenError(null)
    setReopenNotice(null)
    const signature = `reopen|${targetInvoiceId}|${trimmedReason}`
    const tracker = resolveOperationIdForAttempt(
      reopenAttemptRef.current,
      signature,
      createClientOperationUuid,
    )
    reopenAttemptRef.current = tracker

    setIsSubmittingReopen(true)
    try {
      const result = await reopenInvoiceValidation({
        invoiceId: targetInvoiceId,
        operationId: tracker.operationId,
        reason: trimmedReason,
      })

      if (!result.ok) {
        setReopenError(result.error)
        if (!result.uncertainOutcome) {
          reopenAttemptRef.current = null
        }
        return
      }

      reopenAttemptRef.current = null
      setIsReopeningValidation(false)
      setReopenReason('')
      setReopenError(null)

      if (effectiveFinancial) {
        const preservedReversedCount = Number(
          result.balance.reversed_payment_count ??
            effectiveFinancial.financialBalance.reversedPaymentsCount ??
            0,
        )
        const preservedReversedAmount = Math.round(
          Number(
            result.balance.reversed_amount ??
              effectiveFinancial.financialBalance.reversedAmountClp ??
              0,
          ),
        )
        const hasMonetaryDiff = entry.monetary.status === 'AMOUNT_DIFFERENCE'

        setLocalFinancial({
          ...effectiveFinancial,
          cxpValidationStatus: 'PENDING',
          cxpPriorPaymentStatus: 'UNREVIEWED',
          cxpHistoricalInitialBalance: null,
          cxpHistoricalBalanceCutoffDate: null,
          cxpValidatedAt: null,
          financialBalance: {
            ...effectiveFinancial.financialBalance,
            accreditationStatus: hasMonetaryDiff
              ? 'BLOCKED_BY_DISCREPANCY'
              : 'UNACCREDITED_HISTORICAL_PAYMENT',
            accreditationLabel: hasMonetaryDiff
              ? 'Bloqueada por discrepancia'
              : 'Saldo por acreditar',
            accreditationDetail: hasMonetaryDiff
              ? 'Diferencia SII vs. Bodega sin resolver'
              : preservedReversedCount > 0
                ? `Validación reabierta · ${preservedReversedCount} pago(s) anulado(s)`
                : 'Pendiente conciliación de pagos históricos',
            isBalanceAccredited: false,
            accreditedTotalAmountClp: null,
            initialBalanceClp: null,
            priorPaidAmountClp: null,
            modulePaidAmountClp: null,
            totalPaidAmountClp: null,
            currentBalanceClp: null,
            isFullyPaid: false,
            activePaymentsCount: 0,
            reversedPaymentsCount: preservedReversedCount,
            reversedAmountClp: preservedReversedAmount,
          },
          paymentBlock: {
            isBlocked: true,
            canRegisterPayment: false,
            primaryReasonCode: hasMonetaryDiff
              ? 'UNRESOLVED_MONETARY_DISCREPANCY'
              : 'UNACCREDITED_PRIOR_PAYMENTS',
            primaryReasonLabel: hasMonetaryDiff
              ? 'Pago bloqueado · Diferencia de monto SII vs. Bodega'
              : entry.isHistoricalPreErpReceipts
                ? 'Pago bloqueado · Pendiente de validación financiera histórica'
                : 'Pendiente acreditar pagos históricos',
            reasons: [
              'Situación de pagos históricos no acreditada (no se asume como deuda impaga hasta conciliar pagos previos).',
            ],
          },
        })
      }

      setReopenNotice(
        result.idempotentReplay
          ? 'La validación de la factura ya había sido reabierta a PENDING / UNREVIEWED.'
          : 'Validación reabierta a PENDING / UNREVIEWED. La factura pasó a «Saldo por acreditar» sin presentar el importe como deuda confirmada y conservando su historial.',
      )
      router.refresh()
    } catch {
      setReopenError(
        'Error de conexión al reabrir la validación. Puede reintentar conservando la misma operación.',
      )
    } finally {
      setIsSubmittingReopen(false)
    }
  }, [
    effectiveFinancial,
    entry.isHistoricalPreErpReceipts,
    entry.monetary.status,
    isSubmittingReopen,
    reopenReason,
    router,
  ])

  const handleSaveDueDate = useCallback(async () => {
    if (!financial?.dueDateInfo.canEditDueDate || !dueDateDraft) return
    setSavingDueDate(true)
    setDueDateFeedback(null)
    try {
      const res = await setInvoiceDueDate({
        candidateId: financial.cxpCandidateId ?? undefined,
        invoiceId: financial.cxpInvoiceId ?? undefined,
        dueDate: dueDateDraft,
      })
      if (!res.ok) {
        setDueDateFeedback({ tone: 'red', message: res.error })
        return
      }
      setDueDateFeedback({
        tone: 'emerald',
        message: `Vencimiento actualizado a ${formatCivilDate(dueDateDraft)}.`,
      })
      router.refresh()
    } catch {
      setDueDateFeedback({
        tone: 'red',
        message: 'No se pudo guardar la fecha de vencimiento.',
      })
    } finally {
      setSavingDueDate(false)
    }
  }, [dueDateDraft, financial, router])

  const supplierDisplayName =
    entry.bodegaSupplierName ||
    entry.bsaleSupplierName ||
    'Proveedor no identificado'
  const showDualSupplierName =
    Boolean(entry.bsaleSupplierName) &&
    Boolean(entry.bodegaSupplierName) &&
    entry.bsaleSupplierName!.trim().toUpperCase() !==
      entry.bodegaSupplierName!.trim().toUpperCase()

  const docTypePrefix =
    entry.bodegaDocumentType === 'GD' ? 'GD' : 'FA'
  const folioTitle = entry.documentFolio
    ? `${docTypePrefix} ${entry.documentFolio}`
    : `${docTypePrefix} S/F`

  const receiptIds = useMemo(
    () => entry.receipts.map(r => r.receiptId),
    [entry.receipts],
  )

  const handleOpenBsalePdf = useCallback(() => {
    if (!entry.bsaleDocumentId || !entry.hasBsalePdf) return
    setDocError(null)
    const docId = `bsale:${entry.bsaleDocumentId}`
    setViewer({
      kind: 'BSALE_PDF',
      bsaleDocumentId: entry.bsaleDocumentId,
      correlative: folioTitle,
      supplierName: supplierDisplayName,
      documents: [
        {
          id: docId,
          document_number: `SII ${entry.codeSii ?? 'DTE'} · ${entry.documentFolio ?? ''}`,
          file_name: `Bsale-DTE-${entry.codeSii ?? '33'}-${entry.documentFolio ?? entry.bsaleDocumentId}.pdf`,
          mime_type: 'application/pdf',
          has_file: true,
        },
      ],
    })
  }, [entry, folioTitle, supplierDisplayName])

  const handleOpenBodegaDocuments = useCallback(
    async (targetReceiptIds?: string[]) => {
      const idsToLoad =
        targetReceiptIds && targetReceiptIds.length > 0
          ? targetReceiptIds
          : receiptIds
      if (idsToLoad.length === 0) return

      setLoadingBodegaDocs(true)
      setDocError(null)
      try {
        const res = await getCxpWarehouseReceiptDocuments(idsToLoad)
        if ('error' in res) {
          setDocError(res.error)
          return
        }
        const available = res.documents.filter(d => d.has_file)
        if (available.length === 0) {
          setDocError(
            'Las recepciones asociadas no tienen archivos PDF o imágenes disponibles en Bodega.',
          )
          return
        }
        setViewer({
          kind: 'BODEGA_RECEIPTS',
          receiptIds: idsToLoad,
          correlative: folioTitle,
          supplierName: supplierDisplayName,
          documents: available,
          initialDocumentId: available[0]?.id,
        })
      } catch {
        setDocError('No se pudieron consultar los respaldos de Bodega.')
      } finally {
        setLoadingBodegaDocs(false)
      }
    },
    [receiptIds, folioTitle, supplierDisplayName],
  )

  const loadViewerSignedUrl = useCallback(
    async (documentId: string) => {
      if (!viewer) {
        return { error: 'Visor no inicializado.' }
      }
      if (viewer.kind === 'BSALE_PDF') {
        return getCxpBsaleDocumentSignedUrl(viewer.bsaleDocumentId)
      }
      return getCxpWarehouseReceiptDocumentSignedUrl(
        viewer.receiptIds,
        documentId,
      )
    },
    [viewer],
  )

  const siiBreakdownSubtext = useMemo(() => {
    if (entry.monetary.siiTotalAmountClp === null) {
      return 'Sin documento SII en espejo Bsale'
    }
    const parts: string[] = []
    if (entry.monetary.siiNetAmount && entry.monetary.siiNetAmount > 0) {
      parts.push(`Neto ${formatClp(entry.monetary.siiNetAmount)}`)
    }
    if (entry.monetary.siiTaxAmount && entry.monetary.siiTaxAmount > 0) {
      parts.push(`IVA ${formatClp(entry.monetary.siiTaxAmount)}`)
    }
    if (entry.monetary.siiExemptAmount && entry.monetary.siiExemptAmount > 0) {
      parts.push(`Exento ${formatClp(entry.monetary.siiExemptAmount)}`)
    }
    if (
      entry.monetary.siiSpecificTaxAmount &&
      entry.monetary.siiSpecificTaxAmount > 0
    ) {
      parts.push(`Imp. esp. ${formatClp(entry.monetary.siiSpecificTaxAmount)}`)
    }
    return parts.join(' · ') || 'Total oficial SII'
  }, [entry.monetary])

  const bodegaBreakdownSubtext = useMemo(() => {
    if (entry.monetary.receivedGrossAmountClp === null) {
      return entry.isHistoricalPreErpReceipts
        ? 'Emitida antes de recepciones ERP'
        : 'Sin recepción vinculada en Bodega'
    }
    const exactDiffers =
      entry.monetary.receivedGrossAmountExact !== null &&
      Math.abs(
        entry.monetary.receivedGrossAmountExact -
          entry.monetary.receivedGrossAmountClp,
      ) > 0.001
    const exactNote = exactDiffers
      ? `Exacto $${entry.monetary.receivedGrossAmountExact!.toLocaleString('es-CL', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : `Neto ${formatClp(entry.monetary.receivedNetAmountExact)}`
    return `${exactNote} · ${entry.receiptCount} recep.`
  }, [entry])

  const differenceDisplay = useMemo(() => {
    if (entry.monetary.status === 'EXACT_MATCH') {
      return {
        value: '$0',
        subtext: entry.monetary.hasSubPesoRoundingOnly
          ? `Coincidencia exacta (${entry.monetary.differenceExact! > 0 ? '+' : ''}${entry.monetary.differenceExact!.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} dec.)`
          : 'Coincidencia exacta SII = Bodega',
        tone: 'match' as const,
      }
    }
    if (
      entry.monetary.status === 'AMOUNT_DIFFERENCE' &&
      entry.monetary.differenceClp !== null
    ) {
      return {
        value: formatSignedClpDifference(entry.monetary.differenceClp),
        subtext:
          entry.monetary.differenceClp > 0
            ? 'SII mayor que recepción Bodega'
            : 'Recepción Bodega mayor que SII',
        tone: 'difference' as const,
      }
    }
    return {
      value: 'No comparable',
      subtext:
        entry.receptionStatus === 'NO_RECEIPT'
          ? 'Falta recepción en Bodega'
          : 'Falta factura SII vinculada',
      tone: 'muted' as const,
    }
  }, [entry])

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cxp-bsale-reconciliation-panel-title"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-full flex-col overflow-hidden border-l border-theme-border bg-theme-surface shadow-2xl md:w-[56vw] md:max-w-[780px] xl:w-[52vw] xl:max-w-[820px]"
        onClick={event => event.stopPropagation()}
      >
        {/* CABECERA COMPACTA */}
        <header className="shrink-0 border-b border-theme-border bg-slate-50/90 px-3.5 py-2.5 dark:bg-slate-900/60">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <ReceiptText className="h-4 w-4 shrink-0 text-theme-accent" />
                <h2
                  id="cxp-bsale-reconciliation-panel-title"
                  className="text-[16px] font-bold tracking-tight text-theme-text"
                >
                  {folioTitle}
                </h2>
                {entry.codeSii && (
                  <span className="inline-flex items-center rounded border border-theme-border bg-theme-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
                    {codeSiiShortLabel(entry.codeSii)}
                  </span>
                )}
                <span
                  className={cn(
                    'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                    badgeClasses(monetaryBadge.tone),
                  )}
                >
                  {monetaryBadge.label}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                    badgeClasses(receptionBadge.tone),
                  )}
                >
                  {receptionBadge.label}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                    badgeClasses(financialBadge.tone),
                  )}
                >
                  {financialBadge.label}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
                <span className="inline-flex items-center gap-1 text-[13.5px] font-bold text-theme-text">
                  <span className="truncate">{supplierDisplayName}</span>
                </span>
                {entry.issuerRutNormalized && (
                  <span className="font-mono text-[11.5px] font-medium text-theme-text-muted">
                    {formatRut(entry.issuerRutNormalized)}
                  </span>
                )}
                {entry.dates.siiEmissionDate && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-theme-text-muted">
                    <CalendarDays className="h-3 w-3 shrink-0" />
                    Emisión SII:{' '}
                    <strong className="font-semibold tabular-nums text-theme-text">
                      {formatCivilDate(entry.dates.siiEmissionDate)}
                    </strong>
                  </span>
                )}
              </div>

              {showDualSupplierName && (
                <p className="mt-0.5 truncate text-[10.5px] text-theme-text-muted">
                  Razón social SII Bsale: <span className="font-medium">{entry.bsaleSupplierName}</span>
                </p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {entry.hasBsalePdf && (
                <button
                  type="button"
                  onClick={handleOpenBsalePdf}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 text-[11px] font-semibold text-sky-700 transition-colors hover:bg-sky-500/20 dark:text-sky-300"
                  title="Ver PDF tributario desde Bsale"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>PDF Bsale</span>
                </button>
              )}

              {entry.hasBodegaAttachment && (
                <button
                  type="button"
                  disabled={loadingBodegaDocs}
                  onClick={() => void handleOpenBodegaDocuments()}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2 text-[11px] font-semibold text-theme-text transition-colors hover:bg-theme-surface-hover disabled:opacity-50"
                  title="Ver respaldo adjunto en recepción de Bodega"
                >
                  {loadingBodegaDocs ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-accent" />
                  ) : (
                    <FileText className="h-3.5 w-3.5 text-theme-accent" />
                  )}
                  <span>PDF Bodega</span>
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar panel de conciliación"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </header>

        {/* FRANJA HORIZONTAL COMPACTA: MONTO SII | MONTO RECIBIDO BODEGA | DIFERENCIA */}
        <section
          aria-label="Resumen de importes SII y Bodega"
          className="shrink-0 grid grid-cols-3 divide-x divide-theme-border border-b border-theme-border bg-theme-bg/50"
        >
          <StripMetric
            label="Monto SII (Bsale)"
            value={
              entry.monetary.siiTotalAmountClp !== null
                ? formatClp(entry.monetary.siiTotalAmountClp)
                : 'Sin factura SII'
            }
            subtext={siiBreakdownSubtext}
            tone={entry.monetary.siiTotalAmountClp !== null ? 'default' : 'muted'}
          />
          <StripMetric
            label="Monto recibido (Bodega)"
            value={
              entry.monetary.receivedGrossAmountClp !== null
                ? formatClp(entry.monetary.receivedGrossAmountClp)
                : 'Sin recepción'
            }
            subtext={bodegaBreakdownSubtext}
            tone={
              entry.monetary.receivedGrossAmountClp !== null ? 'default' : 'muted'
            }
          />
          <StripMetric
            label="Diferencia (SII - Bodega)"
            value={differenceDisplay.value}
            subtext={differenceDisplay.subtext}
            tone={differenceDisplay.tone}
          />
        </section>

        {docError && (
          <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-3.5 py-1.5 text-[11px] font-medium text-red-700 dark:text-red-300">
            {docError}
          </div>
        )}

        {/* CONTENIDO INTERNO CON DESPLAZAMIENTO */}
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-theme-border">
          {/* BLOQUE 4A: IDENTIFICACIÓN DE SALDOS FINANCIEROS, VENCIMIENTO Y BLOQUEO DE PAGO */}
          <section className="px-3.5 py-2.5 space-y-2.5 bg-slate-50/40 dark:bg-slate-900/30">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-theme-text-muted">
                <Wallet className="h-3.5 w-3.5 text-theme-accent" />
                <span>Situación financiera, saldo acreditado y vencimiento</span>
              </h3>
              <span
                className={cn(
                  'inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                  badgeClasses(financialBadge.tone),
                )}
              >
                {financialBadge.label}
              </span>
            </div>

            {effectiveFinancial?.financialBalance.accreditationStatus ===
              'HISTORICAL_EXCEL_PENDING' &&
            effectiveFinancial.financialBalance
              .historicalPendingExcelEvidence ? (
              <div className="space-y-2">
                <div className="grid grid-cols-3 divide-x divide-theme-border rounded-lg border border-amber-500/35 bg-amber-500/[0.06]">
                  <StripMetric
                    label="Monto original (Excel / SII)"
                    value={formatClp(
                      effectiveFinancial.financialBalance
                        .historicalPendingExcelEvidence.originalAmountClp,
                    )}
                    subtext={`Fila Excel #${effectiveFinancial.financialBalance.historicalPendingExcelEvidence.sourceRow}`}
                    tone="default"
                  />
                  <StripMetric
                    label="Notas de crédito aplicadas"
                    value={formatClp(
                      effectiveFinancial.financialBalance
                        .historicalPendingExcelEvidence.creditNoteAmountClp,
                    )}
                    subtext={
                      effectiveFinancial.financialBalance
                        .historicalPendingExcelEvidence.creditNoteAmountClp > 0
                        ? 'Descontadas en Excel'
                        : 'Sin notas de crédito'
                    }
                    tone="muted"
                  />
                  <StripMetric
                    label="Saldo según Excel (Col. K)"
                    value={formatClp(
                      effectiveFinancial.financialBalance
                        .historicalPendingExcelEvidence.pendingBalanceClp,
                    )}
                    subtext="Referencia Excel · Sin validar ERP"
                    tone="difference"
                  />
                </div>

                <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  <p className="font-bold">
                    Saldo según Excel (pendiente de validación financiera en el ERP)
                  </p>
                  <p className="mt-0.5 text-[11px] leading-snug opacity-90">
                    El importe mostrado proviene de la columna K de la hoja CAYLO
                    (descontando notas de crédito aplicadas). No constituye deuda
                    validada ni habilita pagos mientras existan bloqueos
                    documentales o de recepción.
                  </p>
                  {effectiveFinancial.financialBalance
                    .historicalPendingExcelEvidence.excelObservation && (
                    <p className="mt-1 font-mono text-[10.5px]">
                      Obs. Excel:{' '}
                      {
                        effectiveFinancial.financialBalance
                          .historicalPendingExcelEvidence.excelObservation
                      }
                    </p>
                  )}
                </div>
              </div>
            ) : effectiveFinancial?.financialBalance.accreditationStatus ===
              'HISTORICAL_EXCEL_PAID' &&
            effectiveFinancial.financialBalance.historicalExcelEvidence ? (
              <div className="space-y-2">
                <div className="grid grid-cols-3 divide-x divide-theme-border rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06]">
                  <StripMetric
                    label="Total documento SII"
                    value={formatClp(
                      effectiveFinancial.financialBalance.siiTotalAmountClp,
                    )}
                    subtext={`Fila Excel #${effectiveFinancial.financialBalance.historicalExcelEvidence.sourceRow}`}
                    tone="default"
                  />
                  <StripMetric
                    label="Evidencia histórica Excel"
                    value={
                      effectiveFinancial.financialBalance.historicalExcelEvidence
                        .declaredPaymentStatus
                    }
                    subtext={formatCivilDate(
                      effectiveFinancial.financialBalance.historicalExcelEvidence
                        .referencePaymentDate,
                    )}
                    tone="match"
                  />
                  <StripMetric
                    label="Saldo histórico"
                    value={formatClp(0)}
                    subtext="Pagada históricamente · Excel"
                    tone="match"
                  />
                </div>

                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold text-emerald-900 dark:text-emerald-200">
                      Fecha de pago de referencia:{' '}
                      <span className="tabular-nums">
                        {formatCivilDate(
                          effectiveFinancial.financialBalance
                            .historicalExcelEvidence.referencePaymentDate,
                        )}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                        effectiveFinancial.financialBalance
                          .historicalExcelEvidence.paymentDateBasis ===
                          'EXCEL_COLUMN_H'
                          ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
                          : 'border-amber-500/35 bg-amber-500/15 text-amber-800 dark:text-amber-200',
                      )}
                    >
                      {effectiveFinancial.financialBalance
                        .historicalExcelEvidence.paymentDateBasis ===
                      'EXCEL_COLUMN_H'
                        ? 'Fecha informada en Excel'
                        : 'Fecha asumida (emisión doc.)'}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-emerald-900/85 dark:text-emerald-200/85">
                    {effectiveFinancial.financialBalance.historicalExcelEvidence
                      .paymentDateBasis === 'EXCEL_COLUMN_H'
                      ? 'Fecha de pago informada explícitamente en la columna H del Excel histórico.'
                      : 'El Excel no informaba fecha de pago en columna H; se asume la fecha de emisión del documento como referencia.'}{' '}
                    Registro de solo lectura: no crea movimientos en Cuentas por
                    Pagar ni valida artificialmente la factura.
                  </p>
                </div>
              </div>
            ) : effectiveFinancial?.financialBalance.isBalanceAccredited ? (
              <div className="space-y-2">
                <div className="grid grid-cols-3 divide-x divide-theme-border rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06]">
                  <StripMetric
                    label="Total factura validada"
                    value={formatClp(
                      effectiveFinancial.financialBalance.accreditedTotalAmountClp,
                    )}
                    subtext="Deuda acreditada en CxP"
                    tone="default"
                  />
                  <StripMetric
                    label="Pagos y abonos acreditados"
                    value={formatClp(
                      effectiveFinancial.financialBalance.totalPaidAmountClp,
                    )}
                    subtext={
                      effectiveFinancial.financialBalance.activePaymentsCount > 0
                        ? `${effectiveFinancial.financialBalance.activePaymentsCount} pago(s) vigente(s)`
                        : effectiveFinancial.financialBalance
                              .reversedPaymentsCount > 0
                          ? `${effectiveFinancial.financialBalance.reversedPaymentsCount} pago(s) anulado(s)`
                          : 'Sin pagos vigentes'
                    }
                    tone="match"
                  />
                  <StripMetric
                    label="Saldo pendiente acreditado"
                    value={formatClp(
                      effectiveFinancial.financialBalance.currentBalanceClp,
                    )}
                    subtext={
                      effectiveFinancial.financialBalance.isFullyPaid
                        ? 'Íntegramente pagada ($0)'
                        : 'Disponible para pago cuando corresponda'
                    }
                    tone={
                      effectiveFinancial.financialBalance.isFullyPaid
                        ? 'match'
                        : 'default'
                    }
                  />
                </div>

                {reversalNotice && (
                  <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span>{reversalNotice}</span>
                  </div>
                )}

                {effectiveFinancial.financialBalance.paymentsHistory.length >
                  0 && (
                  <div className="overflow-x-auto rounded-lg border border-theme-border bg-theme-surface">
                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-theme-border bg-slate-50/80 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted dark:bg-slate-900/40">
                          <th className="px-2.5 py-1.5">Fecha pago</th>
                          <th className="px-2 py-1.5">
                            Referencia / Trazabilidad
                          </th>
                          <th className="px-2 py-1.5 text-right">Importe</th>
                          <th className="px-2.5 py-1.5 text-right">Acción</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-theme-border">
                        {effectiveFinancial.financialBalance.paymentsHistory.map(
                          p => {
                            const isReversingThis = reversingPaymentId === p.id
                            return (
                              <Fragment key={p.id}>
                                <tr
                                  className={cn(
                                    p.is_reversed && 'bg-slate-50/60 dark:bg-slate-900/30',
                                  )}
                                >
                                  <td
                                    className={cn(
                                      'px-2.5 py-1.5 tabular-nums font-medium text-theme-text',
                                      p.is_reversed &&
                                        'opacity-60 line-through',
                                    )}
                                  >
                                    {formatCivilDate(p.payment_date)}
                                  </td>
                                  <td className="px-2 py-1.5 text-[11px] text-theme-text-muted">
                                    {p.is_reversed ? (
                                      <div>
                                        <span className="font-semibold text-red-600 dark:text-red-400">
                                          Anulado ·{' '}
                                          {p.reversal?.reason ?? 'Reversado'}
                                        </span>
                                        {p.reversal?.created_at && (
                                          <span className="block text-[10px] text-theme-text-muted">
                                            Reversado el{' '}
                                            {formatCivilDate(
                                              p.reversal.created_at.slice(0, 10),
                                            )}
                                            {p.reversal.created_by_name
                                              ? ` por ${p.reversal.created_by_name}`
                                              : ''}
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
                                        <CheckCircle2 className="h-3 w-3 shrink-0" />
                                        {p.reference || 'Pago confirmado en CxP'}
                                      </span>
                                    )}
                                  </td>
                                  <td
                                    className={cn(
                                      'px-2 py-1.5 text-right font-bold tabular-nums text-theme-text',
                                      p.is_reversed &&
                                        'opacity-60 line-through',
                                    )}
                                  >
                                    {formatClp(p.amount)}
                                  </td>
                                  <td className="px-2.5 py-1.5 text-right">
                                    {p.is_reversed ? (
                                      <span className="inline-flex items-center rounded border border-red-500/25 bg-red-500/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-red-700 dark:text-red-300">
                                        Anulado
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={isSubmittingReversal}
                                        onClick={() =>
                                          isReversingThis
                                            ? handleCancelReversal()
                                            : handleStartReversal(p.id)
                                        }
                                        className="inline-flex items-center gap-1 rounded border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-800 transition-colors hover:bg-amber-500/20 disabled:opacity-45 dark:text-amber-300"
                                        title="Anular pago conservando trazabilidad en el historial y restituyendo el saldo pendiente"
                                      >
                                        <RotateCcw className="h-2.5 w-2.5" />
                                        <span>
                                          {isReversingThis
                                            ? 'Cancelar'
                                            : 'Anular pago'}
                                        </span>
                                      </button>
                                    )}
                                  </td>
                                </tr>

                                {isReversingThis && !p.is_reversed && (
                                  <tr className="bg-amber-500/[0.06]">
                                    <td colSpan={4} className="px-2.5 py-2">
                                      <div className="space-y-1.5">
                                        <p className="text-[11px] font-semibold text-amber-900 dark:text-amber-200">
                                          Anular pago de {formatClp(p.amount)}{' '}
                                          (se conservará en el historial como
                                          anulado y el saldo volverá a quedar
                                          pendiente para pagarse cuando
                                          corresponda):
                                        </p>
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <input
                                            type="text"
                                            value={reversalReason}
                                            onChange={e =>
                                              setReversalReason(e.target.value)
                                            }
                                            placeholder="Motivo de anulación (ej. Operación ficticia utilizada para pruebas)"
                                            aria-label="Motivo de anulación del pago"
                                            maxLength={500}
                                            className={cn(
                                              erpInputClass,
                                              'h-7 min-w-[240px] flex-1 px-2 text-xs',
                                            )}
                                          />
                                          <button
                                            type="button"
                                            disabled={isSubmittingReversal}
                                            onClick={() =>
                                              void handleConfirmReversal(p.id)
                                            }
                                            className="inline-flex h-7 items-center gap-1 rounded-md border border-red-500/40 bg-red-600 px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                                          >
                                            {isSubmittingReversal ? (
                                              <>
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                <span>Anulando…</span>
                                              </>
                                            ) : (
                                              <span>Confirmar anulación</span>
                                            )}
                                          </button>
                                          <button
                                            type="button"
                                            disabled={isSubmittingReversal}
                                            onClick={handleCancelReversal}
                                            className="inline-flex h-7 items-center rounded-md border border-theme-border bg-theme-surface px-2 text-[11px] font-semibold text-theme-text-muted hover:bg-theme-surface-hover"
                                          >
                                            Cancelar
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
                          },
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* FUNCIÓN ADMINISTRATIVA INDEPENDIENTE: REABRIR VALIDACIÓN (0 PAGOS ACTIVOS) */}
                {effectiveFinancial.cxpInvoiceId && (
                  <div className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[10.5px] font-bold uppercase tracking-wider text-theme-text">
                          Reapertura administrativa de validación
                        </p>
                        <p className="text-[11px] text-theme-text-muted">
                          {effectiveFinancial.financialBalance
                            .activePaymentsCount > 0
                            ? `Requiere 0 pagos activos (actualmente registra ${effectiveFinancial.financialBalance.activePaymentsCount} pago(s) activo(s); anúlelos antes de reabrir).`
                            : 'Devuelve la factura a PENDING / UNREVIEWED («Saldo por acreditar»), conservando el historial de validaciones, pagos y reversas.'}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={
                          isSubmittingReopen ||
                          effectiveFinancial.financialBalance
                            .activePaymentsCount > 0
                        }
                        onClick={() =>
                          isReopeningValidation
                            ? handleCancelReopenValidation()
                            : handleStartReopenValidation()
                        }
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 text-[11px] font-semibold text-amber-900 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45 dark:text-amber-200"
                        title={
                          effectiveFinancial.financialBalance
                            .activePaymentsCount > 0
                            ? 'Anule primero los pagos activos vigentes para habilitar la reapertura de validación'
                            : 'Reabrir validación para devolver la factura a PENDING / UNREVIEWED'
                        }
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>
                          {isReopeningValidation
                            ? 'Cancelar'
                            : 'Reabrir validación'}
                        </span>
                      </button>
                    </div>

                    {isReopeningValidation &&
                      effectiveFinancial.financialBalance.activePaymentsCount ===
                        0 && (
                        <div className="mt-2 space-y-1.5 border-t border-theme-border pt-2">
                          <p className="text-[11px] font-medium text-amber-900 dark:text-amber-200">
                            Indique el motivo obligatorio para retirar la
                            acreditación financiera y devolver la factura a{' '}
                            <strong className="font-semibold">
                              PENDING / UNREVIEWED («Saldo por acreditar»)
                            </strong>
                            :
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <input
                              type="text"
                              value={reopenReason}
                              onChange={e => setReopenReason(e.target.value)}
                              placeholder="Motivo obligatorio (ej. Regularización de validación de prueba)"
                              aria-label="Motivo de reapertura de validación"
                              maxLength={500}
                              className={cn(
                                erpInputClass,
                                'h-7 min-w-[240px] flex-1 px-2 text-xs',
                              )}
                            />
                            <button
                              type="button"
                              disabled={isSubmittingReopen}
                              onClick={() =>
                                void handleConfirmReopenValidation()
                              }
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-600 bg-amber-600 px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
                            >
                              {isSubmittingReopen ? (
                                <>
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  <span>Reabriendo…</span>
                                </>
                              ) : (
                                <span>Confirmar reapertura</span>
                              )}
                            </button>
                            <button
                              type="button"
                              disabled={isSubmittingReopen}
                              onClick={handleCancelReopenValidation}
                              className="inline-flex h-7 items-center rounded-md border border-theme-border bg-theme-bg px-2 text-[11px] font-semibold text-theme-text-muted hover:bg-theme-surface-hover"
                            >
                              Cancelar
                            </button>
                          </div>
                          {reopenError && (
                            <p className="text-[11px] font-medium text-red-700 dark:text-red-300">
                              {reopenError}
                            </p>
                          )}
                        </div>
                      )}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {reopenNotice && (
                  <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span>{reopenNotice}</span>
                  </div>
                )}

                <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-amber-900 dark:text-amber-200">
                      Saldo por acreditar · {HISTORICAL_PAYMENT_PENDING_LABEL}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-amber-800/90 dark:text-amber-300/90">
                      El importe del documento no se presenta como deuda
                      confirmada ni saldo impago.{' '}
                      {HISTORICAL_PAYMENT_PENDING_DESCRIPTION}
                    </p>
                  </div>
                </div>

                {/* Conservar historial de pagos y reversas aun cuando la factura esté en PENDING / UNREVIEWED */}
                {effectiveFinancial &&
                  effectiveFinancial.financialBalance.paymentsHistory.length >
                    0 && (
                    <div className="overflow-x-auto rounded-lg border border-theme-border bg-theme-surface">
                      <div className="border-b border-theme-border bg-slate-50/80 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-theme-text-muted dark:bg-slate-900/40">
                        Historial conservado de movimientos y reversas (
                        {
                          effectiveFinancial.financialBalance.paymentsHistory
                            .length
                        }
                        )
                      </div>
                      <table className="w-full border-collapse text-left text-xs">
                        <thead>
                          <tr className="border-b border-theme-border bg-slate-50/50 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted dark:bg-slate-900/20">
                            <th className="px-2.5 py-1.5">Fecha pago</th>
                            <th className="px-2 py-1.5">
                              Estado / Trazabilidad
                            </th>
                            <th className="px-2.5 py-1.5 text-right">
                              Importe
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-theme-border">
                          {effectiveFinancial.financialBalance.paymentsHistory.map(
                            p => (
                              <tr
                                key={p.id}
                                className={cn(
                                  p.is_reversed &&
                                    'bg-slate-50/60 dark:bg-slate-900/30',
                                )}
                              >
                                <td
                                  className={cn(
                                    'px-2.5 py-1.5 tabular-nums font-medium text-theme-text',
                                    p.is_reversed && 'opacity-60 line-through',
                                  )}
                                >
                                  {formatCivilDate(p.payment_date)}
                                </td>
                                <td className="px-2 py-1.5 text-[11px] text-theme-text-muted">
                                  {p.is_reversed ? (
                                    <div>
                                      <span className="font-semibold text-red-600 dark:text-red-400">
                                        Anulado ·{' '}
                                        {p.reversal?.reason ?? 'Reversado'}
                                      </span>
                                      {p.reversal?.created_at && (
                                        <span className="block text-[10px] text-theme-text-muted">
                                          Reversado el{' '}
                                          {formatCivilDate(
                                            p.reversal.created_at.slice(0, 10),
                                          )}
                                          {p.reversal.created_by_name
                                            ? ` por ${p.reversal.created_by_name}`
                                            : ''}
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span>
                                      {p.reference || 'Movimiento registrado'}
                                    </span>
                                  )}
                                </td>
                                <td
                                  className={cn(
                                    'px-2.5 py-1.5 text-right font-bold tabular-nums text-theme-text',
                                    p.is_reversed && 'opacity-60 line-through',
                                  )}
                                >
                                  {formatClp(p.amount)}
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
              </div>
            )}

            {/* VENCIMIENTO Y BLOQUEO DE PAGO */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9.5px] font-bold uppercase tracking-wider text-theme-text-muted">
                    {effectiveFinancial?.financialBalance.isBalanceAccredited &&
                    !effectiveFinancial?.financialBalance.isFullyPaid
                      ? 'Vencimiento de obligación confirmada'
                      : effectiveFinancial?.financialBalance.isFullyPaid
                        ? 'Vencimiento (Sin obligación pendiente)'
                        : 'Vencimiento referencial (Sin deuda acreditada)'}
                  </p>
                  <span className="inline-flex items-center rounded bg-theme-bg px-1.5 py-0.5 text-[9.5px] font-semibold text-theme-text-muted">
                    Fuente: {effectiveFinancial?.dueDateInfo.sourceLabel ?? 'Por confirmar'}
                  </span>
                </div>
                <p className="mt-0.5 text-xs font-bold tabular-nums text-theme-text">
                  {effectiveFinancial?.dueDateInfo.dueDate
                    ? formatCivilDate(effectiveFinancial.dueDateInfo.dueDate)
                    : 'Pendiente de confirmación'}
                </p>
                {financial?.dueDateInfo.rawTermsSummary && (
                  <p className="mt-0.5 text-[10.5px] text-theme-text-muted">
                    Condición detectada: {financial.dueDateInfo.rawTermsSummary}
                  </p>
                )}

                {financial?.dueDateInfo.canEditDueDate && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <input
                      type="date"
                      value={dueDateDraft}
                      onChange={e => setDueDateDraft(e.target.value)}
                      aria-label="Fecha de vencimiento de factura"
                      className={cn(erpInputClass, 'h-7 flex-1 px-2 text-xs')}
                    />
                    <button
                      type="button"
                      disabled={
                        savingDueDate ||
                        !dueDateDraft ||
                        dueDateDraft === (financial.dueDateInfo.dueDate ?? '')
                      }
                      onClick={() => void handleSaveDueDate()}
                      className="inline-flex h-7 items-center rounded-md border border-theme-border bg-theme-bg px-2.5 text-[11px] font-semibold text-theme-text transition-colors hover:bg-theme-surface-hover disabled:opacity-45"
                    >
                      {savingDueDate ? 'Guardando…' : 'Guardar'}
                    </button>
                  </div>
                )}

                {dueDateFeedback && (
                  <p
                    className={cn(
                      'mt-1 text-[10.5px] font-medium',
                      dueDateFeedback.tone === 'emerald'
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-red-700 dark:text-red-300',
                    )}
                  >
                    {dueDateFeedback.message}
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9.5px] font-bold uppercase tracking-wider text-theme-text-muted">
                    Control de bloqueo de pago
                  </p>
                  {financial?.paymentBlock.isBlocked ? (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-bold text-amber-800 dark:text-amber-300">
                      <Lock className="h-2.5 w-2.5" />
                      Bloqueado
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-bold text-emerald-800 dark:text-emerald-300">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      {financial?.financialBalance.isFullyPaid
                        ? 'Pagada ($0)'
                        : 'Verificado'}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs font-bold text-theme-text">
                  {financial?.paymentBlock.primaryReasonLabel ??
                    'Pendiente acreditar pagos históricos'}
                </p>
                {financial && financial.paymentBlock.reasons.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[10.5px] text-theme-text-muted">
                    {financial.paymentBlock.reasons.map((reason, idx) => (
                      <li key={idx} className="leading-snug">
                        • {reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          {/* DATOS TRIBUTARIOS Y ESTADOS SEPARADOS */}
          <section className="px-3.5 py-2.5 space-y-2">
            <h3 className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-theme-text-muted">
              <ReceiptText className="h-3.5 w-3.5 text-theme-accent" />
              <span>Datos tributarios y estados independientes</span>
            </h3>

            <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 sm:grid-cols-4">
              <CompactMeta
                label="Conciliación monetaria"
                value={monetaryBadge.label}
              />
              <CompactMeta
                label="Estado físico recepción"
                value={receptionBadge.label}
              />
              <CompactMeta
                label="ID Bsale / Estado SII"
                value={
                  entry.bsaleDocumentId
                    ? `#${entry.bsaleDocumentId} · ${
                        entry.siiStatus && entry.siiStatus.length > 0
                          ? entry.siiStatus.join(', ')
                          : 'siiStatus: null'
                      }`
                    : 'No registrado en Bsale'
                }
                mono
              />
              <CompactMeta
                label="Respaldos disponibles"
                value={
                  entry.hasBsalePdf && entry.hasBodegaAttachment
                    ? 'PDF Bsale + PDF Bodega'
                    : entry.hasBsalePdf
                      ? 'Solo PDF Bsale'
                      : entry.hasBodegaAttachment
                        ? 'Solo PDF Bodega'
                        : 'Sin PDF adjunto'
                }
              />
              <CompactMeta
                label="Emisión SII"
                value={
                  entry.dates.siiEmissionDate
                    ? formatCivilDate(entry.dates.siiEmissionDate)
                    : '—'
                }
              />
              <CompactMeta
                label="Fecha doc. Bodega"
                value={
                  entry.dates.receiptDocumentDates.length > 0
                    ? entry.dates.receiptDocumentDates
                        .map(d => formatCivilDate(d))
                        .join(', ')
                    : '—'
                }
              />
              <CompactMeta
                label="Fecha recepción física"
                value={
                  entry.dates.receiptReceivedDates.length > 0
                    ? entry.dates.receiptReceivedDates
                        .map(d => formatCivilDate(d))
                        .join(', ')
                    : '—'
                }
              />
              <CompactMeta
                label="Órdenes de compra"
                value={
                  entry.purchaseOrderCorrelatives.length > 0
                    ? entry.purchaseOrderCorrelatives.join(', ')
                    : 'Sin OC vinculada'
                }
                mono
              />
            </div>
          </section>

          {/* ALERTAS DOCUMENTALES Y FECHAS DISCREPANTES */}
          {alerts.length > 0 && (
            <section className="px-3.5 py-2.5 space-y-1.5">
              <h3 className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-theme-text-muted">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                <span>Observaciones documentales y de fechas ({alerts.length})</span>
              </h3>

              <div className="space-y-1.5">
                {alerts.map(alert => (
                  <div
                    key={alert.id}
                    className={cn(
                      'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs',
                      alert.tone === 'amber' &&
                        'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200',
                      alert.tone === 'sky' &&
                        'border-sky-500/30 bg-sky-500/10 text-sky-900 dark:text-sky-200',
                      alert.tone === 'slate' &&
                        'border-theme-border bg-theme-bg text-theme-text',
                    )}
                  >
                    {alert.tone === 'amber' ? (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    ) : (
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{alert.title}</p>
                      <p className="mt-0.5 text-[11px] opacity-90">
                        {alert.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* RECEPCIONES Y ÓRDENES DE COMPRA VINCULADAS */}
          <section className="px-3.5 py-2.5 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-theme-text-muted">
                <PackageCheck className="h-3.5 w-3.5 text-theme-accent" />
                <span>
                  Recepciones de Bodega y OC vinculadas ({entry.receipts.length})
                </span>
              </h3>
              {entry.receipts.length > 1 && (
                <span className="inline-flex items-center rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                  Consolidada ({entry.receiptCount} recepciones ·{' '}
                  {entry.purchaseOrderCount} OC)
                </span>
              )}
            </div>

            {entry.receipts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-theme-border bg-theme-bg/40 px-3 py-3 text-center text-xs text-theme-text-muted">
                {entry.isHistoricalPreErpReceipts
                  ? 'Documento histórico emitido antes de la puesta en marcha de las recepciones de Bodega en el ERP.'
                  : 'No existen recepciones de Bodega vinculadas a este documento por RUT y folio.'}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-theme-border bg-theme-surface">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-theme-border bg-slate-50/80 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted dark:bg-slate-900/40">
                      <th className="px-2.5 py-1.5">OC / Estado</th>
                      <th className="px-2 py-1.5">Doc. Bodega</th>
                      <th className="px-2 py-1.5">F. Doc. / Recep.</th>
                      <th className="px-2 py-1.5 text-right">Unid.</th>
                      <th className="px-2 py-1.5 text-right">Neto atrib.</th>
                      <th className="px-2.5 py-1.5 text-right">Bruto atrib.</th>
                      <th className="px-2 py-1.5 text-right">Respaldo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border">
                    {entry.receipts.map(rec => (
                      <tr key={rec.receiptId} className="hover:bg-theme-surface-hover/60">
                        <td className="px-2.5 py-1.5">
                          <div className="font-mono text-[11px] font-semibold text-theme-text">
                            {rec.purchaseOrderCorrelative ?? 'Sin OC'}
                          </div>
                          <div className="text-[10px] text-theme-text-muted">
                            {rec.purchaseOrderReceiptStatus === 'RECEPCION_TOTAL'
                              ? 'OC Recepción total'
                              : rec.purchaseOrderReceiptStatus === 'RECEPCION_PARCIAL'
                                ? 'OC Recepción parcial'
                                : rec.purchaseOrderReceiptStatus ?? '—'}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="font-semibold text-theme-text">
                            {rec.documentType} {rec.documentFolio ?? 'S/F'}
                          </span>
                          {rec.receiptNumber && (
                            <span className="block font-mono text-[10px] text-theme-text-muted">
                              {rec.receiptNumber}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 tabular-nums text-[11px]">
                          <div>
                            Doc: {formatCivilDate(rec.documentDate)}
                          </div>
                          <div className="text-[10px] text-theme-text-muted">
                            Rec: {formatCivilDate(rec.receivedDate)}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          <span className="font-semibold text-theme-text">
                            {rec.unitsReceived.toLocaleString('es-CL')}
                          </span>
                          <span className="block text-[10px] text-theme-text-muted">
                            {rec.itemsCount} ítem(s)
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-theme-text-muted">
                          {formatClp(rec.attributableNetAmount)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          <div className="font-bold text-theme-text">
                            {formatClp(rec.attributableGrossAmountClp)}
                          </div>
                          {Math.abs(
                            rec.attributableGrossAmountExact -
                              rec.attributableGrossAmountClp,
                          ) > 0.001 && (
                            <div className="text-[10px] text-theme-text-muted">
                              $
                              {rec.attributableGrossAmountExact.toLocaleString(
                                'es-CL',
                                {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                },
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {rec.hasAttachmentInBodega ? (
                            <button
                              type="button"
                              disabled={loadingBodegaDocs}
                              onClick={() =>
                                void handleOpenBodegaDocuments([rec.receiptId])
                              }
                              className="inline-flex items-center gap-0.5 rounded border border-theme-border bg-theme-bg px-1.5 py-0.5 text-[10px] font-semibold text-theme-accent hover:bg-theme-surface-hover"
                            >
                              <FileText className="h-2.5 w-2.5" />
                              PDF
                            </button>
                          ) : (
                            <span className="text-[10px] text-theme-text-muted">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {entry.receipts.length > 1 && (
                    <tfoot>
                      <tr className="border-t border-theme-border bg-slate-50/90 text-[11px] font-bold text-theme-text dark:bg-slate-900/50">
                        <td colSpan={4} className="px-2.5 py-1.5">
                          Total consolidado atribuible ({entry.receipts.length}{' '}
                          recepciones sin duplicar OC)
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {formatClp(entry.monetary.receivedNetAmountExact)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {formatClp(entry.monetary.receivedGrossAmountClp)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </section>
        </div>

        {viewer && (
          <PurchaseOrderInvoiceViewerModal
            key={`${viewer.kind}:${viewer.initialDocumentId ?? viewer.documents[0]?.id ?? 'doc'}`}
            correlative={viewer.correlative}
            supplierName={viewer.supplierName}
            documents={viewer.documents}
            initialDocumentId={viewer.initialDocumentId}
            loadSignedUrl={loadViewerSignedUrl}
            onClose={() => setViewer(null)}
          />
        )}
      </aside>
    </div>
  )
}

export function BsaleReconciliationDetailPanel({
  entry,
  financial,
  onClose,
}: BsaleReconciliationDetailPanelProps) {
  if (!entry) return null
  return (
    <BsaleReconciliationDetailPanelContent
      key={`${entry.reconciliationKey}:${financial?.dueDateInfo.dueDate ?? ''}`}
      entry={entry}
      financial={financial}
      onClose={onClose}
    />
  )
}
