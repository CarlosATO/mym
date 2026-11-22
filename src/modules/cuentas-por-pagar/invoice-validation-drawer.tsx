'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  CheckCircle2,
  FileText,
  Loader2,
  PackageCheck,
  ReceiptText,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getCxpReceiptDocumentSignedUrl,
  getInvoiceValidationDetail,
  saveInvoiceValidation,
} from '@/app/actions/cuentas-por-pagar'
import { formatCivilDate, formatInstantInSantiago, todayInSantiago } from '@/lib/datetime'
import { erpErrorInputClass, erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import type { PurchaseOrderInvoiceDocument } from '@/app/actions/adquisiciones/purchase-orders'
import { PurchaseOrderInvoiceViewerModal } from '@/modules/adquisiciones/ordenes-compra/purchase-order-invoice-viewer-modal'
import type {
  InvoiceDetail,
  PriorPaymentStatus,
  SaveInvoiceValidationResult,
} from './types'
import {
  addDaysToCivilDate,
  calculateChileanTaxBreakdown,
  evaluateInvoiceValidation,
  formatClp,
  formatRut,
  parseNumericAmount,
} from './validation-rules'

interface InvoiceValidationDrawerProps {
  invoiceId: string | null
  suggestedDueDate?: string | null
  onClose: () => void
  onUpdated: (result: SaveInvoiceValidationResult) => void
}

function amountToInputString(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return ''
  const num = Number(value)
  if (Math.abs(num - Math.round(num)) < 0.005) return String(Math.round(num))
  return String(num)
}

function parseFieldAmount(raw: string): { value: number | null; valid: boolean } {
  const parsed = parseNumericAmount(raw)
  if (parsed === null) return { value: null, valid: true }
  if (Number.isNaN(parsed)) return { value: null, valid: false }
  return { value: parsed, valid: true }
}

function priorPaymentLabel(status: PriorPaymentStatus): string {
  switch (status) {
    case 'NO_PRIOR_PAYMENTS':
      return 'Sin pagos anteriores (100% pendiente)'
    case 'PARTIAL_PRIOR_PAYMENTS':
      return 'Con pagos parciales anteriores'
    case 'FULLY_PAID_PRIOR':
      return 'Pagada totalmente con anterioridad'
    default:
      return 'Pendiente de revisión'
  }
}

function HeaderStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">{label}</p>
      <p className={cn('truncate text-xs font-bold tabular-nums', accent ? 'text-theme-accent' : 'text-theme-text')} title={value}>
        {value}
      </p>
    </div>
  )
}

function ReadinessChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        ok
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </span>
  )
}

function InvoiceValidationDrawerContent({
  invoiceId,
  suggestedDueDate,
  onClose,
  onUpdated,
}: {
  invoiceId: string
  suggestedDueDate?: string | null
  onClose: () => void
  onUpdated: (result: SaveInvoiceValidationResult) => void
}) {
  const [detail, setDetail] = useState<InvoiceDetail | null>(null)
  const initialDueSuggestion = useRef(suggestedDueDate ?? null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const [totalAmountText, setTotalAmountText] = useState('')
  const [netAmountText, setNetAmountText] = useState('')
  const [taxAmountText, setTaxAmountText] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [priorPaymentStatus, setPriorPaymentStatus] = useState<PriorPaymentStatus>('UNREVIEWED')
  const [initialBalanceText, setInitialBalanceText] = useState('')
  const [cutoffDate, setCutoffDate] = useState('')
  const [resolveDiscrepancy, setResolveDiscrepancy] = useState(false)
  const [discrepancyNote, setDiscrepancyNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [viewerDocumentId, setViewerDocumentId] = useState<string | null>(null)
  const [isSaving, startSaving] = useTransition()

  const applyInvoiceToForm = useCallback((loaded: InvoiceDetail) => {
    const inv = loaded.invoice
    setTotalAmountText(amountToInputString(inv.total_amount))
    setNetAmountText(amountToInputString(inv.net_amount))
    setTaxAmountText(amountToInputString(inv.tax_amount))
    setIssueDate(inv.issue_date ?? '')
    setDueDate(inv.due_date ?? '')
    setPriorPaymentStatus(inv.prior_payment_status ?? 'UNREVIEWED')
    setInitialBalanceText(
      inv.prior_payment_status === 'PARTIAL_PRIOR_PAYMENTS'
        ? amountToInputString(inv.historical_initial_balance)
        : '',
    )
    setCutoffDate(inv.historical_balance_cutoff_date ?? '')
    setResolveDiscrepancy(inv.discrepancy_status === 'RESOLVED')
    setDiscrepancyNote(inv.discrepancy_resolution_note ?? '')
    setFormError(null)
  }, [])

  useEffect(() => {
    let active = true
    void getInvoiceValidationDetail(invoiceId)
      .then(result => {
        if (!active) return
        if (!result.ok) {
          setLoadError(result.error)
          setDetail(null)
          setLoading(false)
          return
        }
        setLoadError(null)
        setDetail(result.data)
        applyInvoiceToForm(result.data)
        if (!result.data.invoice.due_date && initialDueSuggestion.current) {
          setDueDate(initialDueSuggestion.current)
        }
        initialDueSuggestion.current = null
        setLoading(false)
      })
      .catch(() => {
        if (!active) return
        setLoadError('No se pudo cargar el detalle de la factura.')
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [invoiceId, reloadNonce, applyInvoiceToForm])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !viewerDocumentId && !isSaving) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, viewerDocumentId, isSaving])

  const parsedTotal = useMemo(() => parseFieldAmount(totalAmountText), [totalAmountText])
  const parsedNet = useMemo(() => parseFieldAmount(netAmountText), [netAmountText])
  const parsedTax = useMemo(() => parseFieldAmount(taxAmountText), [taxAmountText])
  const parsedBalance = useMemo(() => parseFieldAmount(initialBalanceText), [initialBalanceText])

  const evaluation = useMemo(() => {
    if (!detail) return null

    let balanceForEval: number | null = null
    let cutoffForEval: string | null = null
    if (priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS') {
      balanceForEval = parsedBalance.value
      cutoffForEval = cutoffDate.trim() || null
    } else if (priorPaymentStatus === 'FULLY_PAID_PRIOR') {
      balanceForEval = 0
      cutoffForEval = cutoffDate.trim() || null
    } else if (initialBalanceText.trim() || cutoffDate.trim()) {
      balanceForEval = parsedBalance.value
      cutoffForEval = cutoffDate.trim() || null
    }

    return evaluateInvoiceValidation(
      {
        issueDate: issueDate.trim(),
        dueDate: dueDate.trim() || null,
        netAmount: parsedNet.value,
        taxAmount: parsedTax.value,
        totalAmount: parsedTotal.value,
        priorPaymentStatus,
        historicalInitialBalance: balanceForEval,
        historicalBalanceCutoffDate: cutoffForEval,
        resolveDiscrepancy,
        discrepancyResolutionNote: discrepancyNote,
      },
      detail.reference,
      detail.invoice.origin,
    )
  }, [
    detail,
    issueDate,
    dueDate,
    parsedNet.value,
    parsedTax.value,
    parsedTotal.value,
    priorPaymentStatus,
    parsedBalance.value,
    initialBalanceText,
    cutoffDate,
    resolveDiscrepancy,
    discrepancyNote,
  ])

  const invalidNumberErrors = useMemo(() => {
    const errors: string[] = []
    if (!parsedTotal.valid) errors.push('El monto total real debe ser numérico.')
    if (!parsedNet.valid) errors.push('El monto neto debe ser numérico.')
    if (!parsedTax.valid) errors.push('El IVA debe ser numérico.')
    if (priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS' && !parsedBalance.valid) {
      errors.push('El saldo inicial pendiente debe ser numérico.')
    }
    return errors
  }, [parsedTotal.valid, parsedNet.valid, parsedTax.valid, parsedBalance.valid, priorPaymentStatus])

  const hasInvalidNumbers = invalidNumberErrors.length > 0
  const isValidated = detail?.invoice.validation_status === 'VALIDATED'
  const isRejected = detail?.invoice.validation_status === 'REJECTED'
  const isReadOnly = Boolean(isValidated || isRejected)

  const viewerDocuments = useMemo<PurchaseOrderInvoiceDocument[]>(() => {
    if (!detail) return []
    return detail.documents.map(doc => ({
      id: doc.id,
      document_number: doc.document_number || detail.invoice.document_folio,
      file_name: doc.file_name,
      mime_type: doc.mime_type,
      has_file: doc.has_file,
    }))
  }, [detail])

  const firstViewableDoc = useMemo(
    () => detail?.documents.find(doc => doc.has_file) ?? null,
    [detail],
  )

  const loadSignedDocumentUrl = useCallback(
    (documentId: string) => getCxpReceiptDocumentSignedUrl(invoiceId, documentId),
    [invoiceId],
  )

  function handleTotalAmountChange(value: string) {
    setTotalAmountText(value)
    setResolveDiscrepancy(false)
    setFormError(null)
  }

  function handleIssueDateChange(value: string) {
    setIssueDate(value)
    setResolveDiscrepancy(false)
    setFormError(null)
  }

  function handlePriorStatusChange(nextStatus: PriorPaymentStatus) {
    setPriorPaymentStatus(nextStatus)
    setFormError(null)
    if (nextStatus === 'UNREVIEWED' || nextStatus === 'NO_PRIOR_PAYMENTS') {
      setInitialBalanceText('')
      setCutoffDate('')
    } else if (!cutoffDate.trim()) {
      const today = todayInSantiago()
      const suggested = issueDate && today < issueDate ? issueDate : today
      setCutoffDate(suggested)
    }
  }

  function handleCalculateTaxBreakdown() {
    if (!parsedTotal.valid || parsedTotal.value === null || parsedTotal.value <= 0) {
      setFormError('Ingrese primero un monto total real mayor a $0 para calcular neto e IVA.')
      return
    }
    const { netAmount, taxAmount } = calculateChileanTaxBreakdown(parsedTotal.value)
    setNetAmountText(String(netAmount))
    setTaxAmountText(String(taxAmount))
    setFormError(null)
  }

  function handleSuggestDueDate() {
    const creditDays = detail?.supplier.credit_days ?? 0
    if (!issueDate || creditDays <= 0) return
    const suggested = addDaysToCivilDate(issueDate, creditDays)
    if (suggested) {
      setDueDate(suggested)
      setFormError(null)
    }
  }

  function handleSave(confirmValidation: boolean) {
    if (!detail || !evaluation || hasInvalidNumbers || isReadOnly) return
    setFormError(null)

    if (confirmValidation && !evaluation.canConfirmValidation) {
      setFormError(evaluation.validationBlockers[0] || 'Complete los datos requeridos antes de validar.')
      return
    }
    if (!confirmValidation && !evaluation.canSavePending) {
      setFormError(evaluation.hardErrors[0] || 'Revise la consistencia de los montos o fechas ingresadas.')
      return
    }

    const balancePayload =
      priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS'
        ? parsedBalance.value
        : priorPaymentStatus === 'FULLY_PAID_PRIOR'
          ? 0
          : null

    const cutoffPayload =
      priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS' || priorPaymentStatus === 'FULLY_PAID_PRIOR'
        ? cutoffDate.trim() || null
        : null

    startSaving(async () => {
      const response = await saveInvoiceValidation({
        invoiceId: detail.invoice.id,
        issueDate: issueDate.trim(),
        dueDate: dueDate.trim() || null,
        netAmount: parsedNet.value,
        taxAmount: parsedTax.value,
        totalAmount: parsedTotal.value,
        priorPaymentStatus,
        historicalInitialBalance: balancePayload,
        historicalBalanceCutoffDate: cutoffPayload,
        resolveDiscrepancy,
        discrepancyResolutionNote: discrepancyNote.trim() || null,
        confirmValidation,
      })

      if (!response.ok) {
        setFormError(response.error)
        toast.error(response.error)
        return
      }

      onUpdated(response.data)

      if (response.data.validation_status === 'VALIDATED') {
        toast.success(`Factura FA ${detail.invoice.document_folio} validada correctamente.`)
        onClose()
        return
      }

      toast.success('Cambios guardados. La factura conserva estado PENDING.')
      const refreshed = await getInvoiceValidationDetail(detail.invoice.id)
      if (refreshed.ok) {
        setDetail(refreshed.data)
        applyInvoiceToForm(refreshed.data)
      }
    })
  }

  function handleRetryLoad() {
    setLoading(true)
    setLoadError(null)
    setReloadNonce(n => n + 1)
  }

  let openingSummaryValue = '—'
  if (detail) {
    if (priorPaymentStatus === 'UNREVIEWED') openingSummaryValue = 'Sin revisar'
    else if (evaluation?.openingPendingBalance != null) openingSummaryValue = formatClp(evaluation.openingPendingBalance, { allowDecimals: true })
    else if (priorPaymentStatus === 'NO_PRIOR_PAYMENTS') openingSummaryValue = 'Pendiente monto'
  }

  const statusBadge = useMemo(() => {
    if (!detail) return null
    if (detail.invoice.validation_status === 'VALIDATED') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" /> Validada
        </span>
      )
    }
    if (detail.invoice.validation_status === 'REJECTED') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-red-700 dark:text-red-300">
          Rechazada
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
        Pendiente de validación
      </span>
    )
  }, [detail])

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="fixed inset-0 bg-black/35 backdrop-blur-[1px] animate-in fade-in duration-150"
        onClick={() => { if (!isSaving) onClose() }}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="cxp-validation-drawer-title"
        className="relative z-10 flex h-full w-full flex-col border-l border-theme-border bg-theme-surface shadow-2xl sm:max-w-2xl lg:max-w-3xl animate-in slide-in-from-right-full duration-200"
      >
        <header className="shrink-0 border-b border-theme-border bg-theme-surface">
          <div className="flex items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-theme-accent">
                  Cuentas por Pagar · Validación
                </span>
                {statusBadge}
                {detail && detail.invoice.validation_status === 'PENDING' && evaluation?.effectiveDiscrepancyStatus === 'UNRESOLVED' && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="h-3 w-3" /> Con discrepancia
                  </span>
                )}
              </div>
              <h2 id="cxp-validation-drawer-title" className="mt-1 truncate text-base font-bold text-theme-text sm:text-lg">
                {detail ? `Factura FA ${detail.invoice.document_folio}` : 'Detalle de factura'}
              </h2>
              {detail && (
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-theme-text-muted">
                  <span className="font-semibold text-theme-text">{detail.supplier.business_name}</span>
                  <span>·</span>
                  <span className="font-mono">{formatRut(detail.supplier.rut || detail.invoice.issuer_rut)}</span>
                </p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {firstViewableDoc && (
                <button
                  type="button"
                  onClick={() => setViewerDocumentId(firstViewableDoc.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 py-1.5 text-xs font-semibold text-theme-text transition-colors hover:bg-theme-surface-hover"
                >
                  <FileText className="h-3.5 w-3.5 text-theme-accent" />
                  <span className="hidden sm:inline">Ver PDF recepción</span>
                  <span className="sm:hidden">PDF</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => { if (!isSaving) onClose() }}
                aria-label="Cerrar detalle de factura"
                className="rounded-lg p-1.5 text-theme-text-muted transition-colors hover:bg-theme-text/10 hover:text-theme-text"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {detail && (
            <div className="grid grid-cols-2 gap-3 border-t border-theme-border bg-theme-bg/50 px-4 py-2.5 sm:grid-cols-4 sm:px-5">
              {detail.invoice.purchase_type === 'SERVICES' ? (
                <>
                  <HeaderStat label="Tipo de compra" value="Servicio (sin OC)" />
                  <HeaderStat
                    label="Prestación"
                    value={detail.invoice.service_delivery_status === 'DELIVERED' ? 'Prestado' : 'Pendiente'}
                  />
                  <HeaderStat
                    label="Monto registrado"
                    value={formatClp(detail.invoice.total_amount, { allowDecimals: true })}
                    accent
                  />
                  <HeaderStat label="Saldo inicial" value={openingSummaryValue} />
                </>
              ) : (
                <>
                  <HeaderStat
                    label="OC vinculadas"
                    value={detail.purchase_orders.map(po => po.correlative).join(', ') || 'Sin OC'}
                  />
                  <HeaderStat
                    label="Recepciones"
                    value={`${detail.reference.linked_receipts_count} completada(s)`}
                  />
                  <HeaderStat
                    label="Referencia recepción"
                    value={formatClp(evaluation?.referenceGrossRounded ?? detail.reference.reference_gross_rounded)}
                    accent
                  />
                  <HeaderStat
                    label="Saldo inicial"
                    value={openingSummaryValue}
                  />
                </>
              )}
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5 space-y-5">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-theme-text-muted">
              <Loader2 className="h-6 w-6 animate-spin text-theme-accent" />
              <p className="text-sm font-medium">Cargando respaldos y datos de la factura…</p>
            </div>
          )}

          {!loading && loadError && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300 space-y-3">
              <p className="font-semibold">{loadError}</p>
              <button
                type="button"
                onClick={handleRetryLoad}
                className="rounded-lg border border-red-500/40 bg-theme-surface px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-500/10 dark:text-red-300"
              >
                Reintentar carga
              </button>
            </div>
          )}

          {!loading && !loadError && detail && evaluation && (
            <>
              {isValidated && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-900 dark:text-emerald-200 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-bold">
                      <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      Obligación validada (sólo lectura)
                    </p>
                    <span className="text-xs font-medium">
                      {detail.invoice.validated_at ? formatInstantInSantiago(detail.invoice.validated_at) : ''}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider opacity-75">Validada por</p>
                      <p className="font-semibold">{detail.invoice.validated_by_name || 'Usuario autorizado'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider opacity-75">Monto real</p>
                      <p className="font-semibold tabular-nums">{formatClp(detail.invoice.total_amount, { allowDecimals: true })}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider opacity-75">Vencimiento</p>
                      <p className="font-semibold">{formatCivilDate(dueDate) || '—'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider opacity-75">Pagos anteriores</p>
                      <p className="font-semibold">{priorPaymentLabel(detail.invoice.prior_payment_status)}</p>
                    </div>
                  </div>
                </div>
              )}

              {(detail.reference.unlinked_completed_receipts_count > 0 ||
                detail.reference.cancelled_linked_receipts_count > 0 ||
                (detail.invoice.origin === 'RECEIPT' && detail.reference.linked_receipts_count === 0)) && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 text-xs text-red-800 dark:text-red-200 space-y-1">
                  <p className="flex items-center gap-1.5 font-bold">
                    <ShieldAlert className="h-4 w-4 shrink-0" />
                    Revisión de respaldos requerida antes de validar
                  </p>
                  {detail.reference.unlinked_completed_receipts_count > 0 && (
                    <p>
                      Hay {detail.reference.unlinked_completed_receipts_count} recepción(es) completada(s) nueva(s) para este folio que aún no están incorporadas desde la bandeja.
                    </p>
                  )}
                  {detail.reference.cancelled_linked_receipts_count > 0 && (
                    <p>
                      Existen {detail.reference.cancelled_linked_receipts_count} recepción(es) vinculada(s) en estado anulado o no completado.
                    </p>
                  )}
                  {detail.invoice.origin === 'RECEIPT' && detail.reference.linked_receipts_count === 0 && (
                    <p>La factura no tiene recepciones completadas vinculadas.</p>
                  )}
                </div>
              )}

              {/* Section 1: Respaldos */}
              <section className="space-y-3 rounded-xl border border-theme-border bg-theme-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-theme-text">
                    <PackageCheck className="h-4 w-4 text-theme-accent" />
                    {detail.invoice.purchase_type === 'SERVICES'
                      ? 'Respaldo de servicio y proveedor'
                      : 'Respaldos: Proveedor, OC y Recepciones vinculadas'}
                  </h3>
                  <span className="text-[11px] text-theme-text-muted">
                    Origen: {detail.invoice.purchase_type === 'SERVICES' ? 'Servicio directo' : detail.invoice.origin === 'RECEIPT' ? 'Recepción' : detail.invoice.origin}
                  </span>
                </div>

                {detail.invoice.purchase_type === 'SERVICES' && (
                  <div className="grid grid-cols-1 gap-3 rounded-lg border border-theme-border bg-theme-bg/40 p-3 text-xs sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Descripción del servicio</p>
                      <p className="mt-0.5 font-medium text-theme-text">{detail.invoice.service_description || '—'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Estado de prestación</p>
                      <p className="mt-0.5 font-semibold text-theme-text">
                        {detail.invoice.service_delivery_status === 'DELIVERED' ? 'Prestado' : 'Pendiente'}
                      </p>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 rounded-lg border border-theme-border bg-theme-bg/40 p-3 text-xs sm:grid-cols-3">
                  <div>
                    <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                      <Building2 className="h-3 w-3" /> Proveedor
                    </p>
                    <p className="mt-0.5 font-semibold text-theme-text">{detail.supplier.business_name}</p>
                    <p className="font-mono text-[11px] text-theme-text-muted">
                      {formatRut(detail.supplier.rut || detail.invoice.issuer_rut)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Condición proveedor</p>
                    <p className="mt-0.5 font-medium text-theme-text">
                      {detail.supplier.payment_terms || (detail.supplier.credit_days ? `${detail.supplier.credit_days} días crédito` : 'Sin condición registrada')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Órdenes de compra</p>
                    {detail.purchase_orders.length > 0 ? (
                      <div className="mt-0.5 space-y-0.5">
                        {detail.purchase_orders.map(po => (
                          <p key={po.id} className="font-medium text-theme-text">
                            {po.correlative}{' '}
                            <span className="text-[11px] font-normal text-theme-text-muted">
                              ({formatClp(po.grand_total)} · {po.status ?? '—'})
                            </span>
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-0.5 text-theme-text-muted">Sin OC vinculada</p>
                    )}
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-theme-border">
                  <table className="w-full min-w-[540px] text-left text-xs">
                    <thead className="border-b border-theme-border bg-theme-bg/60 text-[10px] uppercase tracking-wider text-theme-text-muted">
                      <tr>
                        <th className="px-3 py-2">Recepción</th>
                        <th className="px-3 py-2">OC</th>
                        <th className="px-3 py-2">Fecha doc.</th>
                        <th className="px-3 py-2 text-right">Neto ref.</th>
                        <th className="px-3 py-2 text-right">IVA ref.</th>
                        <th className="px-3 py-2 text-right">Total ref.</th>
                        <th className="px-3 py-2 text-right">Respaldo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.receipts.map(receipt => {
                        const pdfDoc = receipt.documents.find(d => d.has_file) ?? receipt.documents[0] ?? null
                        return (
                          <tr key={receipt.id} className="border-b border-theme-border last:border-0">
                            <td className="px-3 py-2">
                              <div className="font-semibold text-theme-text">{receipt.receipt_number}</div>
                              <div className="text-[11px] text-theme-text-muted">
                                {receipt.status === 'COMPLETED' ? 'Completada' : receipt.status}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-theme-text">{receipt.purchase_order_correlative}</td>
                            <td className="px-3 py-2 text-theme-text">{formatCivilDate(receipt.document_date) || 'Sin fecha'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-theme-text-muted">
                              {formatClp(receipt.receipt_total_net, { allowDecimals: true })}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-theme-text-muted">
                              {formatClp(receipt.receipt_total_tax, { allowDecimals: true })}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold tabular-nums text-theme-text">
                              {formatClp(receipt.receipt_total_gross, { allowDecimals: true })}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {pdfDoc?.has_file ? (
                                <button
                                  type="button"
                                  onClick={() => setViewerDocumentId(pdfDoc.id)}
                                  className="inline-flex items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px] font-semibold text-theme-accent hover:bg-theme-surface-hover"
                                >
                                  <FileText className="h-3 w-3" /> Ver PDF
                                </button>
                              ) : (
                                <span className="text-[11px] text-theme-text-muted">Sin adjunto</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                      {detail.receipts.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-3 py-4 text-center text-theme-text-muted">
                            No hay recepciones vinculadas a esta factura.
                          </td>
                        </tr>
                      )}
                    </tbody>
                    {detail.receipts.length > 0 && (
                      <tfoot className="border-t border-theme-border bg-theme-bg/60 font-semibold">
                        <tr>
                          <td colSpan={3} className="px-3 py-2 text-theme-text">
                            Total referencial consolidado ({detail.reference.linked_receipts_count} recepción/es)
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-theme-text-muted">
                            {formatClp(detail.reference.reference_net_amount, { allowDecimals: true })}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-theme-text-muted">
                            {formatClp(detail.reference.reference_tax_amount, { allowDecimals: true })}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-theme-text">
                            {formatClp(evaluation.referenceGrossRounded)}
                          </td>
                          <td className="px-3 py-2 text-right text-[10px] font-normal text-theme-text-muted">
                            Solo referencia
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                <p className="text-[11px] text-theme-text-muted">
                  El monto calculado desde recepciones es solo referencial; la obligación se confirma contra los datos reales del documento tributario.
                </p>
              </section>

              {/* Section 2: Datos reales de la factura */}
              <section className="space-y-3 rounded-xl border border-theme-border bg-theme-surface p-4">
                <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-theme-text">
                  <ReceiptText className="h-4 w-4 text-theme-accent" />
                  Datos reales de la factura
                </h3>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label htmlFor="cxp-total-amount" className="block text-xs font-medium text-theme-text">
                      Monto total real (CLP) <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="cxp-total-amount"
                      type="text"
                      inputMode="decimal"
                      disabled={isReadOnly || isSaving}
                      value={totalAmountText}
                      onChange={e => handleTotalAmountChange(e.target.value)}
                      placeholder="Ej: 119000"
                      className={cn(
                        erpInputClass,
                        'mt-1 w-full px-3 py-2 text-sm tabular-nums',
                        !parsedTotal.valid && erpErrorInputClass,
                      )}
                    />
                  </div>

                  <div>
                    <label htmlFor="cxp-issue-date" className="block text-xs font-medium text-theme-text">
                      Fecha de emisión <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="cxp-issue-date"
                      type="date"
                      disabled={isReadOnly || isSaving}
                      value={issueDate}
                      onChange={e => handleIssueDateChange(e.target.value)}
                      className={cn(erpInputClass, 'mt-1 w-full px-3 py-2 text-sm')}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor="cxp-due-date" className="block text-xs font-medium text-theme-text">
                        Vencimiento <span className="text-red-500">*</span>
                      </label>
                      {!isReadOnly && (detail.supplier.credit_days ?? 0) > 0 && issueDate && (
                        <button
                          type="button"
                          onClick={handleSuggestDueDate}
                          className="text-[11px] font-semibold text-theme-accent hover:underline"
                        >
                          Sugerir (+{detail.supplier.credit_days}d)
                        </button>
                      )}
                    </div>
                    <input
                      id="cxp-due-date"
                      type="date"
                      disabled={isReadOnly || isSaving}
                      value={dueDate}
                      onChange={e => { setDueDate(e.target.value); setFormError(null) }}
                      className={cn(
                        erpInputClass,
                        'mt-1 w-full px-3 py-2 text-sm',
                        dueDate && issueDate && dueDate < issueDate && erpErrorInputClass,
                      )}
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-theme-border bg-theme-bg/40 p-3 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-theme-text-muted">
                      Desglose neto e IVA (opcional; si se informa, debe cuadrar con el total real)
                    </span>
                    {!isReadOnly && (
                      <button
                        type="button"
                        onClick={handleCalculateTaxBreakdown}
                        disabled={isSaving}
                        className="text-[11px] font-semibold text-theme-accent hover:underline disabled:opacity-50"
                      >
                        Calcular neto e IVA (19%)
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="cxp-net-amount" className="block text-xs font-medium text-theme-text">
                        Neto factura
                      </label>
                      <input
                        id="cxp-net-amount"
                        type="text"
                        inputMode="decimal"
                        disabled={isReadOnly || isSaving}
                        value={netAmountText}
                        onChange={e => { setNetAmountText(e.target.value); setFormError(null) }}
                        placeholder="Opcional"
                        className={cn(
                          erpInputClass,
                          'mt-1 w-full px-3 py-1.5 text-sm tabular-nums',
                          !parsedNet.valid && erpErrorInputClass,
                        )}
                      />
                    </div>
                    <div>
                      <label htmlFor="cxp-tax-amount" className="block text-xs font-medium text-theme-text">
                        IVA factura
                      </label>
                      <input
                        id="cxp-tax-amount"
                        type="text"
                        inputMode="decimal"
                        disabled={isReadOnly || isSaving}
                        value={taxAmountText}
                        onChange={e => { setTaxAmountText(e.target.value); setFormError(null) }}
                        placeholder="Opcional"
                        className={cn(
                          erpInputClass,
                          'mt-1 w-full px-3 py-1.5 text-sm tabular-nums',
                          !parsedTax.valid && erpErrorInputClass,
                        )}
                      />
                    </div>
                  </div>
                </div>
              </section>

              {/* Section 3: Comparación con recepciones y discrepancias */}
              {detail.invoice.purchase_type !== 'SERVICES' && (
              <section className="space-y-3 rounded-xl border border-theme-border bg-theme-surface p-4">
                <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-theme-text">
                  <CalendarDays className="h-4 w-4 text-theme-accent" />
                  Comparación con recepciones
                </h3>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-theme-border bg-theme-bg/40 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Referencia recepciones</p>
                    <p className="mt-1 text-sm font-bold tabular-nums text-theme-text">
                      {formatClp(evaluation.referenceGrossRounded)}
                    </p>
                    {Math.abs(detail.reference.reference_gross_amount - evaluation.referenceGrossRounded) >= 0.005 && (
                      <p className="text-[11px] text-theme-text-muted tabular-nums">
                        Exacto: {formatClp(detail.reference.reference_gross_amount, { allowDecimals: true })}
                      </p>
                    )}
                  </div>

                  <div className="rounded-lg border border-theme-border bg-theme-bg/40 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Importe real factura</p>
                    <p className="mt-1 text-sm font-bold tabular-nums text-theme-text">
                      {parsedTotal.valid && parsedTotal.value !== null
                        ? formatClp(parsedTotal.value, { allowDecimals: true })
                        : 'Sin ingresar'}
                    </p>
                  </div>

                  <div
                    className={cn(
                      'rounded-lg border p-3',
                      evaluation.hasAmountDiscrepancy
                        ? 'border-amber-500/40 bg-amber-500/10'
                        : 'border-emerald-500/30 bg-emerald-500/10',
                    )}
                  >
                    <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Diferencia</p>
                    <p
                      className={cn(
                        'mt-1 text-sm font-bold tabular-nums',
                        evaluation.hasAmountDiscrepancy
                          ? 'text-amber-800 dark:text-amber-300'
                          : 'text-emerald-700 dark:text-emerald-300',
                      )}
                    >
                      {evaluation.amountDifference === null
                        ? 'Por comparar'
                        : evaluation.amountDifference === 0
                          ? '$0 (Sin diferencia)'
                          : `${evaluation.amountDifference > 0 ? '+' : '-'}${formatClp(Math.abs(evaluation.amountDifference), { allowDecimals: true })}${
                              evaluation.amountDifferencePercent !== null ? ` (${evaluation.amountDifferencePercent > 0 ? '+' : ''}${evaluation.amountDifferencePercent}%)` : ''
                            }`}
                    </p>
                  </div>
                </div>

                {!evaluation.hasAnyDiscrepancy && parsedTotal.valid && parsedTotal.value !== null && detail.reference.linked_receipts_count > 0 && (
                  <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    Importe real y fecha de emisión coinciden con las recepciones vinculadas.
                  </p>
                )}

                {evaluation.hasAnyDiscrepancy && (
                  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 space-y-3">
                    <div className="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      <div className="space-y-1">
                        <p className="font-bold">Discrepancia detectada respecto a las recepciones vinculadas</p>
                        {evaluation.hasAmountDiscrepancy && (
                          <p>
                            El monto real ingresado difiere de la referencia calculada en recepción por{' '}
                            <span className="font-semibold tabular-nums">
                              {formatClp(Math.abs(evaluation.amountDifference ?? 0), { allowDecimals: true })}
                            </span>.
                          </p>
                        )}
                        {evaluation.hasDateDiscrepancy && (
                          <p>
                            La fecha de emisión ingresada ({formatCivilDate(issueDate) || '—'}) no coincide unívocamente con la fecha registrada en recepciones (
                            {detail.reference.receipt_document_dates.length > 0
                              ? detail.reference.receipt_document_dates.map(d => formatCivilDate(d)).join(', ')
                              : 'sin fecha en recepción'}
                            ).
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2 border-t border-amber-500/25 pt-2.5 text-xs">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="cxp-discrepancy-mode"
                          disabled={isReadOnly || isSaving}
                          checked={!resolveDiscrepancy}
                          onChange={() => { setResolveDiscrepancy(false); setFormError(null) }}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="font-semibold text-theme-text">
                            Mantener diferencia sin resolver (conservar estado PENDING)
                          </p>
                          <p className="text-[11px] text-theme-text-muted">
                            No permite confirmar la validación hasta revisar la diferencia con Logística o el proveedor.
                          </p>
                        </div>
                      </label>

                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="cxp-discrepancy-mode"
                          disabled={isReadOnly || isSaving}
                          checked={resolveDiscrepancy}
                          onChange={() => { setResolveDiscrepancy(true); setFormError(null) }}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="font-semibold text-theme-text">
                            Diferencia verificada contra respaldo y resuelta
                          </p>
                          <p className="text-[11px] text-theme-text-muted">
                            Requiere justificación explícita (ej. flete, ajuste de precio o fecha verificada en PDF).
                          </p>
                        </div>
                      </label>

                      {resolveDiscrepancy && (
                        <div className="pt-1">
                          <label htmlFor="cxp-discrepancy-note" className="block text-xs font-medium text-theme-text">
                            Justificación de la diferencia <span className="text-red-500">*</span>
                          </label>
                          <textarea
                            id="cxp-discrepancy-note"
                            rows={2}
                            disabled={isReadOnly || isSaving}
                            value={discrepancyNote}
                            onChange={e => { setDiscrepancyNote(e.target.value); setFormError(null) }}
                            placeholder="Explique por qué el monto o la fecha de la factura real difiere de la referencia de recepción (mínimo 10 caracteres)…"
                            className={cn(
                              erpInputClass,
                              'mt-1 w-full px-3 py-2 text-xs',
                              discrepancyNote.trim().length > 0 && discrepancyNote.trim().length < 10 && erpErrorInputClass,
                            )}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
              )}

              {/* Section 4: Pagos anteriores y saldo de apertura */}
              <section className="space-y-3 rounded-xl border border-theme-border bg-theme-surface p-4">
                <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-theme-text">
                  <ShieldCheck className="h-4 w-4 text-theme-accent" />
                  Pagos anteriores y saldo de apertura
                </h3>

                <div className="space-y-2 text-xs">
                  <label className={cn(
                    'flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors',
                    priorPaymentStatus === 'NO_PRIOR_PAYMENTS'
                      ? 'border-theme-accent bg-theme-accent-muted'
                      : 'border-theme-border hover:bg-theme-surface-hover',
                  )}>
                    <input
                      type="radio"
                      name="cxp-prior-payment"
                      disabled={isReadOnly || isSaving}
                      checked={priorPaymentStatus === 'NO_PRIOR_PAYMENTS'}
                      onChange={() => handlePriorStatusChange('NO_PRIOR_PAYMENTS')}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <p className="font-semibold text-theme-text">Sin pagos anteriores</p>
                      <p className="text-[11px] text-theme-text-muted">
                        La factura ingresa con el 100% de su monto real como saldo pendiente.
                      </p>
                    </div>
                  </label>

                  <label className={cn(
                    'flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors',
                    priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS'
                      ? 'border-theme-accent bg-theme-accent-muted'
                      : 'border-theme-border hover:bg-theme-surface-hover',
                  )}>
                    <input
                      type="radio"
                      name="cxp-prior-payment"
                      disabled={isReadOnly || isSaving}
                      checked={priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS'}
                      onChange={() => handlePriorStatusChange('PARTIAL_PRIOR_PAYMENTS')}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <p className="font-semibold text-theme-text">Con pagos parciales anteriores (saldo de apertura)</p>
                      <p className="text-[11px] text-theme-text-muted">
                        Registre el saldo pendiente a la fecha de corte para reflejar abonos previos a la puesta en marcha.
                      </p>
                    </div>
                  </label>

                  <label className={cn(
                    'flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer transition-colors',
                    priorPaymentStatus === 'FULLY_PAID_PRIOR'
                      ? 'border-theme-accent bg-theme-accent-muted'
                      : 'border-theme-border hover:bg-theme-surface-hover',
                  )}>
                    <input
                      type="radio"
                      name="cxp-prior-payment"
                      disabled={isReadOnly || isSaving}
                      checked={priorPaymentStatus === 'FULLY_PAID_PRIOR'}
                      onChange={() => handlePriorStatusChange('FULLY_PAID_PRIOR')}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <p className="font-semibold text-theme-text">Pagada totalmente con anterioridad</p>
                      <p className="text-[11px] text-theme-text-muted">
                        La factura ya fue pagada antes del corte; queda validada con saldo de apertura $0.
                      </p>
                    </div>
                  </label>
                </div>

                {priorPaymentStatus === 'UNREVIEWED' && !isReadOnly && (
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    Seleccione una de las opciones de pagos anteriores para habilitar la confirmación.
                  </p>
                )}

                {(priorPaymentStatus === 'PARTIAL_PRIOR_PAYMENTS' || priorPaymentStatus === 'FULLY_PAID_PRIOR') && (
                  <div className="grid grid-cols-1 gap-3 rounded-lg border border-theme-border bg-theme-bg/40 p-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="cxp-initial-balance" className="block text-xs font-medium text-theme-text">
                        Saldo inicial pendiente (CLP) <span className="text-red-500">*</span>
                      </label>
                      {priorPaymentStatus === 'FULLY_PAID_PRIOR' ? (
                        <input
                          id="cxp-initial-balance"
                          type="text"
                          disabled
                          value="$0 (Pagada totalmente)"
                          className={cn(erpInputClass, 'mt-1 w-full px-3 py-1.5 text-sm')}
                        />
                      ) : (
                        <input
                          id="cxp-initial-balance"
                          type="text"
                          inputMode="decimal"
                          disabled={isReadOnly || isSaving}
                          value={initialBalanceText}
                          onChange={e => { setInitialBalanceText(e.target.value); setFormError(null) }}
                          placeholder="Ej: 45000"
                          className={cn(
                            erpInputClass,
                            'mt-1 w-full px-3 py-1.5 text-sm tabular-nums',
                            !parsedBalance.valid && erpErrorInputClass,
                          )}
                        />
                      )}
                    </div>

                    <div>
                      <label htmlFor="cxp-cutoff-date" className="block text-xs font-medium text-theme-text">
                        Fecha de corte saldo inicial <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="cxp-cutoff-date"
                        type="date"
                        disabled={isReadOnly || isSaving}
                        value={cutoffDate}
                        onChange={e => { setCutoffDate(e.target.value); setFormError(null) }}
                        className={cn(
                          erpInputClass,
                          'mt-1 w-full px-3 py-1.5 text-sm',
                          cutoffDate && issueDate && cutoffDate < issueDate && erpErrorInputClass,
                        )}
                      />
                    </div>

                    {evaluation.priorPaidAmount !== null && evaluation.openingPendingBalance !== null && (
                      <div className="sm:col-span-2 flex flex-wrap items-center gap-4 text-xs text-theme-text-muted pt-1 border-t border-theme-border">
                        <span>
                          Pagado previamente:{' '}
                          <strong className="text-theme-text tabular-nums">
                            {formatClp(evaluation.priorPaidAmount, { allowDecimals: true })}
                          </strong>
                        </span>
                        <span>
                          Saldo apertura pendiente:{' '}
                          <strong className="text-theme-accent tabular-nums">
                            {formatClp(evaluation.openingPendingBalance, { allowDecimals: true })}
                          </strong>
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {(formError || hasInvalidNumbers) && (
                <div role="alert" className="rounded-xl border border-red-500/35 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
                  {formError || invalidNumberErrors[0]}
                </div>
              )}
            </>
          )}
        </div>

        {/* Sticky Footer */}
        <footer className="shrink-0 border-t border-theme-border bg-theme-surface px-4 py-3 sm:px-5">
          {detail && evaluation && !isReadOnly ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <ReadinessChip ok={evaluation.checklist.consistentData && !hasInvalidNumbers} label="Datos consistentes" />
                <ReadinessChip ok={evaluation.checklist.openingBalanceReviewed} label="Saldo inicial revisado" />
                <ReadinessChip ok={evaluation.checklist.noUnresolvedDiscrepancies} label="Sin diferencias pendientes" />
                <ReadinessChip ok={evaluation.checklist.receiptsConsistent} label="Respaldos consistentes" />
              </div>

              {(!evaluation.canConfirmValidation || hasInvalidNumbers) && (
                <p className="text-xs text-theme-text-muted">
                  {invalidNumberErrors[0] || evaluation.validationBlockers[0]}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSaving}
                  className="rounded-lg border border-theme-border px-3.5 py-2 text-xs font-semibold text-theme-text hover:bg-theme-surface-hover disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => handleSave(false)}
                  disabled={isSaving || hasInvalidNumbers || !evaluation.canSavePending}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3.5 py-2 text-xs font-semibold text-theme-text hover:bg-theme-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Guardar pendiente
                </button>
                <button
                  type="button"
                  onClick={() => handleSave(true)}
                  disabled={isSaving || hasInvalidNumbers || !evaluation.canConfirmValidation}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-theme-accent px-4 py-2 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  Confirmar validación
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-theme-border px-4 py-2 text-xs font-semibold text-theme-text hover:bg-theme-surface-hover"
              >
                Cerrar
              </button>
            </div>
          )}
        </footer>

        {viewerDocumentId && detail && (
          <PurchaseOrderInvoiceViewerModal
            key={viewerDocumentId}
            correlative={detail.purchase_orders.map(po => po.correlative).join(', ') || `FA ${detail.invoice.document_folio}`}
            supplierName={detail.supplier.business_name}
            documents={viewerDocuments}
            initialDocumentId={viewerDocumentId}
            loadSignedUrl={loadSignedDocumentUrl}
            onClose={() => setViewerDocumentId(null)}
          />
        )}
      </aside>
    </div>
  )
}

export function InvoiceValidationDrawer({ invoiceId, suggestedDueDate, onClose, onUpdated }: InvoiceValidationDrawerProps) {
  if (!invoiceId) return null
  return (
    <InvoiceValidationDrawerContent
      key={invoiceId}
      invoiceId={invoiceId}
      suggestedDueDate={suggestedDueDate}
      onClose={onClose}
      onUpdated={onUpdated}
    />
  )
}
