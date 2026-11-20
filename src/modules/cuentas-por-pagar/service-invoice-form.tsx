'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  FileText,
  Loader2,
  Plus,
  ReceiptText,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { createServiceInvoice } from '@/app/actions/cuentas-por-pagar'
import { LocalCombobox, type ComboboxOption } from '@/components/ui/local-combobox'
import { formatCivilDate, todayInSantiago } from '@/lib/datetime'
import { erpErrorInputClass, erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import type { ServiceDeliveryStatus, ServiceSupplierOption } from './types'
import {
  addDaysToCivilDate,
  calculateChileanTaxBreakdown,
  formatClp,
  formatRut,
  parseNumericAmount,
} from './validation-rules'
import {
  isValidNormalizedRut,
  upsertSupplierOption,
  validateServiceInvoiceDraft,
} from './service-rules'
import { QuickSupplierModal } from './quick-supplier-modal'

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function ServiceInvoiceForm({ suppliers }: { suppliers: ServiceSupplierOption[] }) {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [supplierList, setSupplierList] = useState<ServiceSupplierOption[]>(suppliers)
  const [quickSupplierOpen, setQuickSupplierOpen] = useState(false)
  const [supplierId, setSupplierId] = useState('')
  const [folio, setFolio] = useState('')
  const [serviceDescription, setServiceDescription] = useState('')
  const [issueDate, setIssueDate] = useState(() => todayInSantiago())
  const [dueDate, setDueDate] = useState('')
  const [netText, setNetText] = useState('')
  const [taxText, setTaxText] = useState('')
  const [totalText, setTotalText] = useState('')
  const [deliveryStatus, setDeliveryStatus] = useState<ServiceDeliveryStatus>('PENDING')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const supplierById = useMemo(
    () => new Map(supplierList.map(supplier => [supplier.id, supplier])),
    [supplierList],
  )

  const selectedSupplier = supplierId ? supplierById.get(supplierId) ?? null : null

  const supplierOptions = useMemo<ComboboxOption[]>(
    () =>
      supplierList.map(supplier => ({
        value: supplier.id,
        label: supplier.rut
          ? `${supplier.business_name} · ${formatRut(supplier.rut)}`
          : `${supplier.business_name} · Sin RUT`,
      })),
    [supplierList],
  )

  const parsedNet = useMemo(() => parseNumericAmount(netText), [netText])
  const parsedTax = useMemo(() => parseNumericAmount(taxText), [taxText])
  const parsedTotal = useMemo(() => parseNumericAmount(totalText), [totalText])

  const validationErrors = useMemo(
    () =>
      validateServiceInvoiceDraft({
        supplierId,
        supplierRut: selectedSupplier?.rut ?? null,
        folio,
        serviceDescription,
        issueDate,
        dueDate,
        netAmount: parsedNet !== null && !Number.isNaN(parsedNet) ? parsedNet : null,
        taxAmount: parsedTax !== null && !Number.isNaN(parsedTax) ? parsedTax : null,
        totalAmount: parsedTotal !== null && !Number.isNaN(parsedTotal) ? parsedTotal : null,
        serviceDeliveryStatus: deliveryStatus,
        attachment: attachment ? { size: attachment.size, type: attachment.type, name: attachment.name } : null,
      }),
    [
      supplierId,
      selectedSupplier?.rut,
      folio,
      serviceDescription,
      issueDate,
      dueDate,
      parsedNet,
      parsedTax,
      parsedTotal,
      deliveryStatus,
      attachment,
    ],
  )

  const hasNumericParseError =
    Number.isNaN(parsedNet) || Number.isNaN(parsedTax) || Number.isNaN(parsedTotal)

  const canSubmit = !isPending && !hasNumericParseError && validationErrors.length === 0

  function handleCalculateFromTotal() {
    if (parsedTotal === null || Number.isNaN(parsedTotal) || parsedTotal <= 0) {
      setSubmitError('Ingrese primero un monto total mayor a $0 para calcular neto e IVA.')
      return
    }
    const { netAmount, taxAmount } = calculateChileanTaxBreakdown(parsedTotal)
    setNetText(String(netAmount))
    setTaxText(String(taxAmount))
    setSubmitError(null)
  }

  function handleCalculateFromNet() {
    if (parsedNet === null || Number.isNaN(parsedNet) || parsedNet < 0) {
      setSubmitError('Ingrese un monto neto válido para calcular IVA (19%) y total.')
      return
    }
    const taxAmount = Math.round(parsedNet * 0.19)
    const totalAmount = Math.round(parsedNet + taxAmount)
    setTaxText(String(taxAmount))
    setTotalText(String(totalAmount))
    setSubmitError(null)
  }

  function handleSuggestDueDate() {
    const days = selectedSupplier?.credit_days ?? 0
    if (!issueDate || days <= 0) return
    const suggested = addDaysToCivilDate(issueDate, days)
    if (suggested) {
      setDueDate(suggested)
      setSubmitError(null)
    }
  }

  function handleReset() {
    setSupplierId('')
    setFolio('')
    setServiceDescription('')
    setIssueDate(todayInSantiago())
    setDueDate('')
    setNetText('')
    setTaxText('')
    setTotalText('')
    setDeliveryStatus('PENDING')
    setAttachment(null)
    setSubmitError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitError(null)
    if (!canSubmit || parsedNet === null || parsedTax === null || parsedTotal === null || !attachment) {
      setSubmitError(validationErrors[0] || 'Complete los campos obligatorios y adjunte el respaldo de la factura.')
      return
    }

    const formData = new FormData()
    formData.set('supplierId', supplierId)
    formData.set('folio', folio.trim())
    formData.set('serviceDescription', serviceDescription.trim())
    formData.set('issueDate', issueDate)
    formData.set('dueDate', dueDate)
    formData.set('netAmount', String(parsedNet))
    formData.set('taxAmount', String(parsedTax))
    formData.set('totalAmount', String(parsedTotal))
    formData.set('serviceDeliveryStatus', deliveryStatus)
    if (attachment) formData.set('attachment', attachment)

    startTransition(async () => {
      const result = await createServiceInvoice(formData)
      if (!result.ok) {
        setSubmitError(result.error)
        toast.error(result.error)
        return
      }
      toast.success(`Factura de servicio FA ${result.data.document_folio} registrada en estado PENDING.`)
      router.push('/dashboard/cuentas-por-pagar')
      router.refresh()
    })
  }

  const supplierMissingRut = Boolean(selectedSupplier && !isValidNormalizedRut(selectedSupplier.rut))

  return (
    <div className="w-full space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <h1 className="text-[16px] font-bold tracking-tight text-theme-text">
            Ingreso de Servicios
          </h1>
          <span className="inline-flex items-center rounded-md border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300">
            Facturas sin OC · Caylo
          </span>
        </div>
        <Link
          href="/dashboard/cuentas-por-pagar"
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-semibold text-theme-text transition-colors hover:bg-theme-surface-hover"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Volver a bandeja
        </Link>
      </header>

      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        {/* Formulario principal */}
        <section className="xl:col-span-8 rounded-xl border border-theme-border bg-theme-surface shadow-xs overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-theme-border px-4 py-2.5">
            <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-theme-text">
              <ReceiptText className="h-3.5 w-3.5 text-theme-accent" />
              Datos de factura de servicio
            </h2>
            <span className="text-[11px] text-theme-text-muted">
              Ingresa directo a Cuentas por Pagar en estado PENDING
            </span>
          </div>

          <div className="p-4 space-y-4">
            {/* Proveedor + RUT */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <div className="sm:col-span-8">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="block text-xs font-semibold text-theme-text">
                    Proveedor <span className="text-red-500">*</span>
                  </label>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setQuickSupplierOpen(true)}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-theme-accent transition-colors hover:bg-theme-accent/10 disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    Nuevo proveedor
                  </button>
                </div>
                <LocalCombobox
                  value={supplierId}
                  onChange={nextId => {
                    setSupplierId(nextId)
                    setSubmitError(null)
                  }}
                  options={supplierOptions}
                  placeholder="Buscar proveedor por razón social o RUT…"
                  emptyText="No se encontraron proveedores activos"
                  clearable
                  disabled={isPending}
                />
                {supplierMissingRut && (
                  <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                    Este proveedor no tiene RUT válido en el catálogo; actualice su ficha antes de ingresar la factura.
                  </p>
                )}
              </div>

              <div className="sm:col-span-4">
                <label htmlFor="svc-rut" className="block text-xs font-semibold text-theme-text mb-1">
                  RUT emisor
                </label>
                <input
                  id="svc-rut"
                  type="text"
                  readOnly
                  value={selectedSupplier ? formatRut(selectedSupplier.rut) : ''}
                  placeholder="Se completa al elegir proveedor"
                  className={cn(
                    erpInputClass,
                    'h-8.5 w-full px-2.5 font-mono text-xs bg-theme-bg/50 text-theme-text-muted',
                    supplierMissingRut && erpErrorInputClass,
                  )}
                />
              </div>
            </div>

            {/* Folio + Estado prestación */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <div className="sm:col-span-4">
                <label htmlFor="svc-folio" className="block text-xs font-semibold text-theme-text mb-1">
                  Folio FA <span className="text-red-500">*</span>
                </label>
                <input
                  id="svc-folio"
                  type="text"
                  inputMode="numeric"
                  disabled={isPending}
                  value={folio}
                  onChange={e => { setFolio(e.target.value.replace(/[^\d]/g, '')); setSubmitError(null) }}
                  placeholder="Ej: 15420"
                  className={cn(erpInputClass, 'h-8.5 w-full px-2.5 text-xs tabular-nums')}
                />
              </div>

              <div className="sm:col-span-4">
                <label htmlFor="svc-issue-date" className="block text-xs font-semibold text-theme-text mb-1">
                  Fecha de emisión <span className="text-red-500">*</span>
                </label>
                <input
                  id="svc-issue-date"
                  type="date"
                  disabled={isPending}
                  value={issueDate}
                  onChange={e => { setIssueDate(e.target.value); setSubmitError(null) }}
                  className={cn(erpInputClass, 'h-8.5 w-full px-2.5 text-xs')}
                />
              </div>

              <div className="sm:col-span-4">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label htmlFor="svc-due-date" className="block text-xs font-semibold text-theme-text">
                    Vencimiento <span className="text-red-500">*</span>
                  </label>
                  {(selectedSupplier?.credit_days ?? 0) > 0 && issueDate && (
                    <button
                      type="button"
                      onClick={handleSuggestDueDate}
                      className="text-[11px] font-semibold text-theme-accent hover:underline"
                    >
                      +{selectedSupplier?.credit_days}d
                    </button>
                  )}
                </div>
                <input
                  id="svc-due-date"
                  type="date"
                  disabled={isPending}
                  value={dueDate}
                  onChange={e => { setDueDate(e.target.value); setSubmitError(null) }}
                  className={cn(
                    erpInputClass,
                    'h-8.5 w-full px-2.5 text-xs',
                    dueDate && issueDate && dueDate < issueDate && erpErrorInputClass,
                  )}
                />
              </div>
            </div>

            {/* Descripción + Estado de prestación */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <div className="sm:col-span-8">
                <label htmlFor="svc-description" className="block text-xs font-semibold text-theme-text mb-1">
                  Descripción del servicio <span className="text-red-500">*</span>
                </label>
                <input
                  id="svc-description"
                  type="text"
                  maxLength={240}
                  disabled={isPending}
                  value={serviceDescription}
                  onChange={e => { setServiceDescription(e.target.value); setSubmitError(null) }}
                  placeholder="Ej: Arriendo bodega mes noviembre, servicio de flete o mantención"
                  className={cn(erpInputClass, 'h-8.5 w-full px-2.5 text-xs')}
                />
              </div>

              <div className="sm:col-span-4">
                <span className="block text-xs font-semibold text-theme-text mb-1">
                  Estado de prestación <span className="text-red-500">*</span>
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setDeliveryStatus('PENDING')}
                    className={cn(
                      'h-8.5 rounded-lg border text-xs font-semibold transition-colors',
                      deliveryStatus === 'PENDING'
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300'
                        : 'border-theme-border bg-theme-surface text-theme-text-muted hover:bg-theme-surface-hover',
                    )}
                  >
                    Pendiente
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setDeliveryStatus('DELIVERED')}
                    className={cn(
                      'h-8.5 rounded-lg border text-xs font-semibold transition-colors',
                      deliveryStatus === 'DELIVERED'
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
                        : 'border-theme-border bg-theme-surface text-theme-text-muted hover:bg-theme-surface-hover',
                    )}
                  >
                    Prestado
                  </button>
                </div>
              </div>
            </div>

            {/* Montos: Neto / IVA / Total */}
            <div className="rounded-lg border border-theme-border bg-theme-bg/40 p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-theme-text-muted">
                  Importes de la factura (CLP)
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleCalculateFromNet}
                    disabled={isPending}
                    className="text-[11px] font-semibold text-theme-accent hover:underline"
                  >
                    Calcular IVA desde Neto
                  </button>
                  <button
                    type="button"
                    onClick={handleCalculateFromTotal}
                    disabled={isPending}
                    className="text-[11px] font-semibold text-theme-accent hover:underline"
                  >
                    Desglosar desde Total (19%)
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="svc-net" className="block text-xs font-medium text-theme-text mb-1">
                    Neto <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="svc-net"
                    type="text"
                    inputMode="decimal"
                    disabled={isPending}
                    value={netText}
                    onChange={e => { setNetText(e.target.value); setSubmitError(null) }}
                    placeholder="Ej: 100000"
                    className={cn(
                      erpInputClass,
                      'h-8.5 w-full px-2.5 text-xs tabular-nums',
                      Number.isNaN(parsedNet) && erpErrorInputClass,
                    )}
                  />
                </div>

                <div>
                  <label htmlFor="svc-tax" className="block text-xs font-medium text-theme-text mb-1">
                    IVA <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="svc-tax"
                    type="text"
                    inputMode="decimal"
                    disabled={isPending}
                    value={taxText}
                    onChange={e => { setTaxText(e.target.value); setSubmitError(null) }}
                    placeholder="Ej: 19000 (0 si exenta)"
                    className={cn(
                      erpInputClass,
                      'h-8.5 w-full px-2.5 text-xs tabular-nums',
                      Number.isNaN(parsedTax) && erpErrorInputClass,
                    )}
                  />
                </div>

                <div>
                  <label htmlFor="svc-total" className="block text-xs font-medium text-theme-text mb-1">
                    Total factura <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="svc-total"
                    type="text"
                    inputMode="decimal"
                    disabled={isPending}
                    value={totalText}
                    onChange={e => { setTotalText(e.target.value); setSubmitError(null) }}
                    placeholder="Ej: 119000"
                    className={cn(
                      erpInputClass,
                      'h-8.5 w-full px-2.5 text-xs font-semibold tabular-nums',
                      Number.isNaN(parsedTotal) && erpErrorInputClass,
                    )}
                  />
                </div>
              </div>
            </div>

            {/* Respaldo PDF o imagen */}
            <div className="space-y-1.5">
              <label htmlFor="svc-attachment" className="block text-xs font-semibold text-theme-text">
                Respaldo de factura (PDF o imagen, máx. 20 MB) <span className="text-red-500">*</span>
              </label>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-theme-border bg-theme-bg/30 px-3 py-2.5">
                <input
                  ref={fileInputRef}
                  id="svc-attachment"
                  type="file"
                  required
                  disabled={isPending}
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  onChange={e => {
                    const file = e.target.files?.[0] ?? null
                    setAttachment(file)
                    setSubmitError(null)
                  }}
                  className="hidden"
                />
                {attachment ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                    <FileText className="h-4 w-4 shrink-0 text-theme-accent" />
                    <span className="truncate font-medium text-theme-text">{attachment.name}</span>
                    <span className="shrink-0 text-[11px] text-theme-text-muted">
                      ({formatFileSize(attachment.size)})
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-theme-text-muted">
                    Adjunte el PDF o imagen de la factura (obligatorio para registrar).
                  </p>
                )}

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-theme-border bg-theme-surface px-2.5 text-xs font-semibold text-theme-text hover:bg-theme-surface-hover"
                  >
                    <Upload className="h-3.5 w-3.5 text-theme-accent" />
                    {attachment ? 'Cambiar archivo' : 'Seleccionar archivo'}
                  </button>
                  {attachment && (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => {
                        setAttachment(null)
                        if (fileInputRef.current) fileInputRef.current.value = ''
                      }}
                      aria-label="Quitar archivo"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-theme-border text-theme-text-muted hover:bg-theme-surface-hover hover:text-theme-text"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {submitError && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/35 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{submitError}</span>
              </div>
            )}
          </div>
        </section>

        {/* Ficha resumen derecha (mismo patrón visual de referencia) */}
        <aside className="xl:col-span-4 space-y-3">
          <div className="rounded-xl border border-theme-border bg-theme-surface shadow-xs overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-theme-border px-4 py-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-theme-text">
                Resumen de registro
              </h2>
              <span className="inline-flex items-center rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
                PENDING
              </span>
            </div>

            <div className="p-4 space-y-3 text-xs">
              <dl className="space-y-2">
                <div className="flex justify-between gap-2">
                  <dt className="text-theme-text-muted flex items-center gap-1">
                    <Building2 className="h-3.5 w-3.5" /> Proveedor
                  </dt>
                  <dd className="font-semibold text-theme-text text-right truncate max-w-[190px]">
                    {selectedSupplier?.business_name || 'Sin seleccionar'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-theme-text-muted">Tipo de compra</dt>
                  <dd className="font-semibold text-violet-700 dark:text-violet-300">Servicio</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-theme-text-muted">Documento</dt>
                  <dd className="font-semibold tabular-nums text-theme-text">
                    {folio ? `FA ${folio}` : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-theme-text-muted">Prestación</dt>
                  <dd className="font-semibold text-theme-text">
                    {deliveryStatus === 'DELIVERED' ? 'Prestado' : 'Pendiente'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-theme-text-muted">Emisión / Vence</dt>
                  <dd className="tabular-nums text-theme-text">
                    {formatCivilDate(issueDate) || '—'} · {formatCivilDate(dueDate) || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2 border-t border-theme-border pt-2">
                  <dt className="text-theme-text-muted">Neto / IVA</dt>
                  <dd className="tabular-nums text-theme-text-muted">
                    {parsedNet !== null && !Number.isNaN(parsedNet) ? formatClp(parsedNet, { allowDecimals: true }) : '—'} /{' '}
                    {parsedTax !== null && !Number.isNaN(parsedTax) ? formatClp(parsedTax, { allowDecimals: true }) : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="font-semibold text-theme-text">Total factura</dt>
                  <dd className="text-sm font-bold tabular-nums text-theme-accent">
                    {parsedTotal !== null && !Number.isNaN(parsedTotal) ? formatClp(parsedTotal, { allowDecimals: true }) : '—'}
                  </dd>
                </div>
              </dl>

              <div className="rounded-lg border border-theme-border bg-theme-bg/50 p-2.5 text-[11px] text-theme-text-muted space-y-1">
                <p>
                  <strong className="text-theme-text">Sin impacto en Bodega:</strong> no crea OC ni recepciones en Logística.
                </p>
                <p>
                  Registrar esta factura no implica que esté pagada ni validada; quedará en <strong className="text-theme-text">PENDING</strong> para revisión en bandeja.
                </p>
              </div>

              {validationErrors.length > 0 && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  {validationErrors[0]}
                </p>
              )}

              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {isPending ? 'Registrando…' : 'Registrar factura de servicio'}
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={handleReset}
                  className="inline-flex h-8 w-full items-center justify-center rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text hover:bg-theme-surface-hover disabled:opacity-50"
                >
                  Limpiar formulario
                </button>
              </div>
            </div>
          </div>
        </aside>
      </form>

      <QuickSupplierModal
        open={quickSupplierOpen}
        onClose={() => setQuickSupplierOpen(false)}
        onCreated={created => {
          setSupplierList(prev => upsertSupplierOption(prev, created))
          setSupplierId(created.id)
          setSubmitError(null)
          setQuickSupplierOpen(false)
        }}
      />
    </div>
  )
}
