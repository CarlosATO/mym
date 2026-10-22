'use client'

import { useEffect, useRef, useState } from 'react'
import { FileText, Loader2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { calculateInvoiceExpirationDate, type InvoiceCommercialSelection, type InvoiceDraftPayload, type InvoicePaymentTypeOption, type InvoiceSaleConditionOption } from './invoice-commercial'

export type InvoiceReviewLine = {
  detail_id: number
  sku: string | null
  product_name: string
  quantity: number
  unit_value: number | null
  total_amount: number | null
}

export type InvoiceReviewSnapshot = {
  card_id: string
  historical_bsale_nv_id: number
  current_bsale_nv_id: number
  folio: string
  client_name: string
  emission_date: string | null
  office_name: string | null
  sale_condition_name: string | null
  client_id?: number | null
  default_payment_type_id?: number | null
  default_payment_type_name?: string | null
  default_sale_condition_id?: number | null
  default_sale_condition_name?: string | null
  effective_sale_condition_id?: number | null
  effective_sale_condition_label?: string | null
  effective_sale_condition_source?: string | null
  effective_time_condition?: number | null
  effective_time_unity?: number | null
  invoice_emission_date?: string | null
  nv_expiration_date?: string | null
  payment_type_options: InvoicePaymentTypeOption[]
  sale_condition_options: InvoiceSaleConditionOption[]
  credit_enabled?: boolean
  credit_limit?: number | null
  price_list_id?: number | null
  expiration_date?: string | null
  seller_name: string | null
  price_list_name: string | null
  client_rut: string | null
  client_activity: string | null
  client_address: string | null
  client_commune: string | null
  client_city: string | null
  client_region: string | null
  client_email: string | null
  client_phone: string | null
  total_amount: number | null
  net_amount: number | null
  tax_amount: number | null
  readiness: 'READY_TO_INVOICE' | 'NOT_READY_CONTRACT' | 'BLOCKED'
  lines: InvoiceReviewLine[]
  commercial_selection?: InvoiceCommercialSelection | null
  draft_payload?: InvoiceDraftPayload | null
}

export type InvoiceDocumentPreview = {
  invoice_bsale_id?: number
  invoice_folio: string
  invoice_date: string | null
  client_name: string
  client_rut?: string | null
  net_amount?: number | null
  tax_amount?: number | null
  total_amount: number | null
  status: 'CONFIRMED' | 'CANCELLED'
  document_status?: 'CONFIRMED' | 'CANCELLED' | 'UNKNOWN'
  sales_order_folio: string
  credit_note_folio?: string | null
  official_url?: string | null
  pdf_url?: string | null
  xml_url?: string | null
  related_detail_count?: number
  related_detail_ids?: number[]
}

export const invoiceUiFixture5032: InvoiceReviewSnapshot = {
  card_id: 'fixture-5032',
  historical_bsale_nv_id: 92486,
  current_bsale_nv_id: 92513,
  folio: '5032',
  client_name: 'ANA TERESA GONZALEZ ALVARADO',
  emission_date: '2026-10-19',
  office_name: null,
  sale_condition_name: null,
  client_id: 1005,
  default_payment_type_id: 8,
  default_payment_type_name: 'TRANSFERENCIA',
  default_sale_condition_id: null,
  default_sale_condition_name: null,
  effective_sale_condition_id: null,
  effective_sale_condition_label: null,
  effective_sale_condition_source: null,
  effective_time_condition: null,
  effective_time_unity: null,
  invoice_emission_date: '2026-10-21',
  payment_type_options: [
    { bsale_id: 1, name: 'EFECTIVO' },
    { bsale_id: 5, name: 'CHEQUE' },
    { bsale_id: 8, name: 'TRANSFERENCIA' },
    { bsale_id: 17, name: 'AUT. GERENCIA' },
    { bsale_id: 18, name: 'CONTADO' },
    { bsale_id: 20, name: 'CREDITO' },
  ],
  sale_condition_options: [
    { bsale_id: 10, name: 'CONTADO', time_condition: 1, time_unity: 0 },
    { bsale_id: 14, name: 'CREDITO 12 DIAS', time_condition: 12, time_unity: 0 },
    { bsale_id: 4, name: 'CREDITO 20 DIAS', time_condition: 20, time_unity: 0 },
    { bsale_id: 6, name: 'CREDITO A 30 DIAS', time_condition: 1, time_unity: 1 },
    { bsale_id: 9, name: 'EFECTIVO', time_condition: 1, time_unity: 0 },
    { bsale_id: 15, name: 'PAGO CONTRA ENTREGA', time_condition: 0, time_unity: 0 },
    { bsale_id: 8, name: 'PREPAGO', time_condition: 1, time_unity: 0 },
    { bsale_id: 7, name: 'TRANSFERENCIA BANCARIA', time_condition: 1, time_unity: 0 },
  ],
  credit_enabled: false,
  credit_limit: null,
  price_list_id: 4,
  expiration_date: '2026-10-21',
  seller_name: null,
  price_list_name: null,
  client_rut: '25583255-7',
  client_activity: 'Sin Giro',
  client_address: 'Calle Temuco 1986',
  client_commune: 'Talca',
  client_city: 'Talca',
  client_region: 'Maule',
  client_email: 'anateresag.21@gmail.com',
  client_phone: '988683022',
  total_amount: 5598,
  net_amount: 4704,
  tax_amount: 894,
  readiness: 'READY_TO_INVOICE',
  lines: [
    { detail_id: 334791, sku: '78304283511852', product_name: 'GOOFY NATURAL YOGURT 20UND', quantity: 1, unit_value: 3235, total_amount: 3850 },
    { detail_id: 334790, sku: 'PW28210', product_name: 'PAWISE BOLA LUMINOSA 3.5CM', quantity: 1, unit_value: 1469, total_amount: 1748 },
  ],
}

export function formatInvoiceClp(value: number | null): string {
  return value == null ? '—' : `$${Math.round(value).toLocaleString('es-CL')}`
}

function formatInvoiceDate(value: string | null): string | null {
  if (!value) return 'No disponible'
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return 'No disponible'
  return date.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '')
}

function formatInvoiceRut(value: string | null): string | null {
  if (!value) return null
  const normalized = value.replace(/[^0-9kK]/g, '').toUpperCase()
  if (normalized.length < 2) return value
  const body = normalized.slice(0, -1)
  const verifier = normalized.slice(-1)
  return `${Number(body).toLocaleString('es-CL')}-${verifier}`
}

function formatInvoicePhone(value: string | null): string | null {
  if (!value) return null
  const digits = value.replace(/\D/g, '')
  if (digits.length === 9 && digits.startsWith('9')) return `+56 9 ${digits.slice(1, 5)} ${digits.slice(5)}`
  return value
}

export function InvoiceReviewModal({
  open, snapshot, loading = false, error = null, onOpenChange, onContinue, onConfigureClient,
}: {
  open: boolean
  snapshot: InvoiceReviewSnapshot | null
  loading?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onContinue: (selection: InvoiceCommercialSelection) => void
  onConfigureClient?: () => void
}) {
  const [paymentTypeId, setPaymentTypeId] = useState<number | null>(null)
  const [saleConditionId, setSaleConditionId] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    setPaymentTypeId(snapshot?.default_payment_type_id ?? null)
    setSaleConditionId(snapshot?.effective_sale_condition_id ?? snapshot?.default_sale_condition_id ?? null)
    setEditing(false)
  }, [snapshot?.card_id, snapshot?.default_payment_type_id, snapshot?.effective_sale_condition_id, snapshot?.default_sale_condition_id])

  const condition = snapshot?.sale_condition_options.find(option => option.bsale_id === saleConditionId) ?? null
  const automaticCondition = snapshot?.effective_sale_condition_id != null
    ? condition
    : snapshot?.default_sale_condition_id != null
      ? snapshot.sale_condition_options.find(option => option.bsale_id === snapshot.default_sale_condition_id) ?? null
      : snapshot?.effective_time_condition != null && snapshot.effective_time_unity != null
        ? { time_condition: snapshot.effective_time_condition, time_unity: snapshot.effective_time_unity }
        : null
  const expirationDate = calculateInvoiceExpirationDate(snapshot?.invoice_emission_date ?? snapshot?.emission_date ?? null, editing ? (condition ?? automaticCondition) : automaticCondition)
  const conditionLabel = editing
    ? condition?.name ?? snapshot?.effective_sale_condition_label ?? snapshot?.default_sale_condition_name ?? 'Sin configurar'
    : snapshot?.effective_sale_condition_label ?? snapshot?.default_sale_condition_name ?? 'Sin configurar'
  const canContinue = Boolean(snapshot && snapshot.readiness === 'READY_TO_INVOICE' && paymentTypeId != null && expirationDate)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[85vw] !max-w-[1100px] max-h-[88vh] overflow-hidden border-[#DDD4CA] bg-[#FCFAF7] p-0 text-[#322D29] sm:!max-w-[1100px]">
        <DialogHeader className="flex-row items-start justify-between border-b border-[#E5DDD5] px-6 py-5 pr-12">
          <div><DialogTitle className="flex items-center gap-2 text-lg"><FileText className="h-4 w-4 text-[#72383D]" /> Revisar facturación</DialogTitle><DialogDescription className="mt-1 text-xs">Verifica los datos antes de emitir la factura.</DialogDescription></div>
          {snapshot && <div className="text-right text-xs leading-5 text-[#6B625C]"><p className="font-bold text-[#322D29]">NV #{snapshot.folio}</p><p>{formatInvoiceDate(snapshot.emission_date)}</p></div>}
        </DialogHeader>
        <div className="max-h-[calc(88vh-142px)] space-y-5 overflow-y-auto bg-white px-6 py-5">
          {loading && <div className="flex items-center gap-2 text-sm text-[#6B625C]"><Loader2 className="h-4 w-4 animate-spin" /> Preparando revisión…</div>}
          {error && <p className="rounded-md border border-[#8A4B4B]/25 bg-[#8A4B4B]/8 p-3 text-xs text-[#8A4B4B]">No se pudo cargar la revisión de facturación.</p>}
          {snapshot && (
            <>
              <section className="border-b border-[#E5DDD5] pb-5"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B625C]">Cliente / receptor</p><p className="text-base font-bold tracking-tight">{snapshot.client_name}</p><div className="mt-1.5 space-y-0.5 text-xs leading-5 text-[#4F4842]"><p>{[formatInvoiceRut(snapshot.client_rut), snapshot.client_activity].filter(Boolean).join(' · ')}</p><p>{snapshot.client_address}</p><p>{[snapshot.client_city, snapshot.client_region].filter(Boolean).join(', ')}</p><p>{[snapshot.client_email, formatInvoicePhone(snapshot.client_phone)].filter(Boolean).join(' · ')}</p></div></section>
              {(!snapshot.client_rut || !snapshot.client_address) && <p className="text-[11px] text-[#806238]">Faltan datos de facturación del cliente.</p>}
              <section><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B625C]">Detalle</p><div className="overflow-x-auto"><div className="min-w-[620px]"><div className="grid grid-cols-[180px_minmax(0,1fr)_80px_110px] gap-4 border-y border-[#E5DDD5] bg-[#FAF8F5] px-2 py-2 text-[9px] font-semibold uppercase tracking-wider text-[#6B625C]"><span>SKU</span><span>Producto</span><span>Cant.</span><span className="text-right">Total</span></div>{snapshot.lines.map(line => <div key={line.detail_id} className="grid grid-cols-[180px_minmax(0,1fr)_80px_110px] gap-4 border-b border-[#F0EBE5] px-2 py-2.5 text-xs last:border-0"><span className="font-medium text-[#6B625C]">{line.sku ?? '—'}</span><span className="min-w-0 font-medium">{line.product_name}</span><span className="tabular-nums">{line.quantity}</span><span className="text-right tabular-nums">{formatInvoiceClp(line.total_amount)}</span></div>)}</div></div>
               </section>
              <section className="rounded-lg border border-[#E5DDD5] bg-[#FCFAF7] p-3"><div className="mb-2 flex items-center justify-between"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B625C]">Condiciones comerciales</p>{!editing && <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} className="h-7 gap-1 px-2 text-[10px] font-bold uppercase tracking-wider text-[#72383D]"><Pencil className="h-3 w-3" /> Cambiar</Button>}</div>{!editing ? <div className="grid gap-2 text-xs sm:grid-cols-3"><div><span className="block text-[10px] font-semibold text-[#6B625C]">Forma de pago</span><p className="mt-1 font-bold">{paymentTypeId == null ? 'Sin configurar' : snapshot.payment_type_options.find(option => option.bsale_id === paymentTypeId)?.name ?? 'Sin configurar'}</p>{paymentTypeId == null && <Button type="button" variant="link" onClick={onConfigureClient} className="h-auto p-0 text-[10px] text-[#72383D]">Configurar cliente</Button>}</div><div><span className="block text-[10px] font-semibold text-[#6B625C]">Condición de venta</span><p className="mt-1 font-bold">{conditionLabel}</p></div><div><span className="block text-[10px] font-semibold text-[#6B625C]">Vencimiento</span><p className="mt-1 font-bold">{formatInvoiceDate(expirationDate)}</p><span className="text-[10px] text-[#6B625C]">Fecha emisión factura: {formatInvoiceDate(snapshot.invoice_emission_date ?? snapshot.emission_date)}</span></div></div> : <div className="grid gap-3 sm:grid-cols-3"><label className="block text-xs"><span className="mb-1 block font-semibold text-[#4F4842]">Forma de pago</span><select aria-label="Forma de pago" value={paymentTypeId ?? ''} onChange={event => setPaymentTypeId(event.target.value ? Number(event.target.value) : null)} className="h-9 w-full rounded-md border border-[#D8CFC5] bg-white px-2 text-xs text-[#322D29] outline-none focus:border-[#72383D]"><option value="">Seleccionar</option>{snapshot.payment_type_options.map(option => <option key={option.bsale_id} value={option.bsale_id}>{option.name}</option>)}</select>{paymentTypeId == null && <span className="mt-1 block text-[10px] text-[#8A4B4B]">Cliente sin forma de pago configurada.</span>}</label><label className="block text-xs"><span className="mb-1 block font-semibold text-[#4F4842]">Condición de venta</span><select aria-label="Condición de venta" value={saleConditionId ?? ''} onChange={event => setSaleConditionId(event.target.value ? Number(event.target.value) : null)} className="h-9 w-full rounded-md border border-[#D8CFC5] bg-white px-2 text-xs text-[#322D29] outline-none focus:border-[#72383D]"><option value="">Mantener automática</option>{snapshot.sale_condition_options.map(option => <option key={option.bsale_id} value={option.bsale_id}>{option.name}</option>)}</select></label><div className="text-xs"><span className="mb-1 block font-semibold text-[#4F4842]">Fecha de vencimiento</span><div className="flex h-9 items-center rounded-md border border-[#D8CFC5] bg-white px-2 text-[#322D29]">{formatInvoiceDate(expirationDate)}</div><span className="mt-1 block text-[10px] text-[#6B625C]">El cambio no modifica el cliente.</span></div></div>}</section>
               <div className="ml-auto w-full max-w-xs border-t border-[#D8CFC5] pt-3 text-xs">
                {snapshot.net_amount != null && <div className="flex justify-between py-0.5"><span className="text-[#6B625C]">Neto</span><span className="tabular-nums">{formatInvoiceClp(snapshot.net_amount)}</span></div>}
                {snapshot.tax_amount != null && <div className="flex justify-between py-0.5"><span className="text-[#6B625C]">IVA</span><span className="tabular-nums">{formatInvoiceClp(snapshot.tax_amount)}</span></div>}
                {snapshot.total_amount != null && <div className="mt-1 flex justify-between border-t border-[#E5DDD5] pt-2 text-sm font-bold"><span>TOTAL</span><span className="tabular-nums text-[#72383D]">{formatInvoiceClp(snapshot.total_amount)}</span></div>}
              </div>
              {snapshot.readiness !== 'READY_TO_INVOICE' && <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900"><p className="font-bold">Facturación todavía no habilitada</p><p className="mt-0.5">Faltan validaciones del contrato tributario Bsale.</p></div>}
            </>
          )}
        </div>
        <DialogFooter className="border-[#E5DDD5] bg-[#FCFAF7] px-6 py-3">
          <p className="mr-auto text-[11px] text-[#6B625C]">Al continuar se solicitará una confirmación antes de emitir la factura.</p><Button variant="outline" onClick={() => onOpenChange(false)}>Cerrar</Button>
           <Button disabled={!canContinue || loading} onClick={() => onContinue({ payment_type_id: paymentTypeId, sale_condition_id: saleConditionId, expiration_date: expirationDate })} className="bg-[#72383D] text-white hover:bg-[#612F34]">Continuar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InvoiceConfirmationModal({ open, snapshot, onOpenChange, onEmissionBlocked, onConfirm, resetAfterMs }: { open: boolean; snapshot: InvoiceReviewSnapshot | null; onOpenChange: (open: boolean) => void; onEmissionBlocked: () => void; onConfirm?: () => Promise<{ status: string; error?: string | null }>; resetAfterMs?: number }) {
  const [submitting, setSubmitting] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const submittingRef = useRef(false)
  useEffect(() => { submittingRef.current = false; setSubmitting(false); setBlocked(false); setErrorMessage(null) }, [snapshot?.card_id])
  if (!snapshot) return null
  const handleSubmit = async () => {
    if (submittingRef.current || blocked) return
    submittingRef.current = true
    setSubmitting(true)
    if (!onConfirm) {
      onEmissionBlocked()
      if (resetAfterMs) window.setTimeout(() => { submittingRef.current = false; setSubmitting(false) }, resetAfterMs)
      return
    }
    try {
      const result = await onConfirm()
      if (result.status === 'EMISSION_DISABLED') onEmissionBlocked()
      else if (result.status === 'CONFIRMED') onOpenChange(false)
      else {
        setErrorMessage(result.error ?? 'No fue posible emitir la factura en Bsale.')
        if (['UNKNOWN', 'BSALE_REJECTED', 'INVOICE_IN_PROGRESS', 'RECONCILIATION_REQUIRED'].includes(result.status)) setBlocked(true)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'No fue posible emitir la factura en Bsale.')
    } finally {
      if (!blocked) {
        submittingRef.current = false
        setSubmitting(false)
      }
    }
  }
  return <Dialog open={open} onOpenChange={next => { if (!submitting && !blocked) onOpenChange(next) }}>
    <DialogContent className="w-[calc(100vw-2rem)] max-w-lg border-[#DDD4CA] bg-[#FCFAF7] text-[#322D29]">
      <DialogHeader><DialogTitle>Confirmar facturación real</DialogTitle><DialogDescription>Está a punto de realizar una facturación real para el cliente {snapshot.client_name} por un monto de {formatInvoiceClp(snapshot.total_amount)} correspondiente a la NV #{snapshot.folio}. ¿Está seguro de continuar?</DialogDescription></DialogHeader>
       <div className="rounded-md border border-[#E5DDD5] bg-white px-3 py-2 text-xs"><p><strong>NV:</strong> #{snapshot.folio}</p><p><strong>Cliente:</strong> {snapshot.client_name}</p><p><strong>Monto:</strong> {formatInvoiceClp(snapshot.total_amount)}</p></div>
        {snapshot.commercial_selection && <div className="rounded-md border border-[#E5DDD5] bg-white px-3 py-2 text-xs"><p><strong>Forma de pago:</strong> {snapshot.payment_type_options.find(option => option.bsale_id === snapshot.commercial_selection?.payment_type_id)?.name ?? 'No seleccionada'}</p><p><strong>Condición:</strong> {snapshot.sale_condition_options.find(option => option.bsale_id === snapshot.commercial_selection?.sale_condition_id)?.name ?? 'No seleccionada'}</p><p><strong>Vencimiento:</strong> {formatInvoiceDate(snapshot.commercial_selection.expiration_date)}</p></div>}
        {errorMessage && <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-950"><p>{errorMessage}</p>{blocked && <p className="mt-1 font-semibold">La emisión queda bloqueada hasta reconciliar el intento existente.</p>}</div>}
       <DialogFooter><Button variant="outline" disabled={submitting || blocked} onClick={() => onOpenChange(false)}>Cancelar</Button><Button disabled={submitting || blocked} onClick={handleSubmit} className="bg-[#72383D] text-white hover:bg-[#612F34]">{submitting ? 'Emitiendo factura…' : blocked ? 'Reconciliación requerida' : 'Emitir factura'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export function CreditNoteConfirmationModal({ open, document, onOpenChange, onEmissionBlocked, resetAfterMs }: { open: boolean; document: InvoiceDocumentPreview | null; onOpenChange: (open: boolean) => void; onEmissionBlocked: () => void; resetAfterMs?: number }) {
  const [submitting, setSubmitting] = useState(false)
  if (!document) return null
  const handleSubmit = () => { if (submitting) return; setSubmitting(true); onEmissionBlocked(); if (resetAfterMs) window.setTimeout(() => setSubmitting(false), resetAfterMs) }
  return <Dialog open={open} onOpenChange={next => { if (!submitting) onOpenChange(next) }}>
    <DialogContent className="w-[calc(100vw-2rem)] max-w-lg border-[#DDD4CA] bg-[#FCFAF7] text-[#322D29]"><DialogHeader><DialogTitle>Emitir Nota de Crédito</DialogTitle><DialogDescription>Está a punto de emitir una Nota de Crédito real para anular la Factura #{document.invoice_folio} por {formatInvoiceClp(document.total_amount)} del cliente {document.client_name}. Esta operación genera un documento tributario real. ¿Está seguro de continuar?</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>Cancelar</Button><Button disabled={submitting} onClick={handleSubmit} className="bg-[#72383D] text-white hover:bg-[#612F34]">{submitting ? 'Emitiendo Nota de Crédito…' : 'Emitir Nota de Crédito'}</Button></DialogFooter></DialogContent>
  </Dialog>
}

function InvoiceDocumentBlock({ document, onCreditNote }: { document: InvoiceDocumentPreview; onCreditNote: (document: InvoiceDocumentPreview) => void }) {
  const cancelled = (document.document_status ?? document.status) === 'CANCELLED'
  const knownStatus = document.document_status && document.document_status !== 'UNKNOWN'
  return <section className="space-y-4 rounded-lg border border-[#E5DDD5] bg-white p-4"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#72383D]" /><h3 className="text-sm font-bold">Factura N.º {document.invoice_folio}</h3></div><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${cancelled ? 'bg-[#F5EDE9] text-[#8A4B4B]' : 'bg-emerald-50 text-emerald-800'}`}>{cancelled ? 'Anulada' : 'Facturada'}</span></div><section><p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#6B625C]">Datos del documento</p><div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4"><div><p className="text-[9px] uppercase text-[#6B625C]">NV origen</p><p className="font-bold">#{document.sales_order_folio}</p></div><div><p className="text-[9px] uppercase text-[#6B625C]">Fecha emisión</p><p className="font-bold">{formatInvoiceDate(document.invoice_date)}</p></div><div><p className="text-[9px] uppercase text-[#6B625C]">Cliente</p><p className="truncate font-bold">{document.client_name}</p></div><div><p className="text-[9px] uppercase text-[#6B625C]">RUT</p><p className="font-bold">{formatInvoiceRut(document.client_rut ?? null) ?? 'No disponible'}</p></div></div><div className="mt-3 ml-auto w-full max-w-xs border-t border-[#E5DDD5] pt-2 text-xs">{document.net_amount != null && <div className="flex justify-between py-0.5"><span className="text-[#6B625C]">Neto</span><span>{formatInvoiceClp(document.net_amount)}</span></div>}{document.tax_amount != null && <div className="flex justify-between py-0.5"><span className="text-[#6B625C]">IVA</span><span>{formatInvoiceClp(document.tax_amount)}</span></div>}<div className="mt-1 flex justify-between border-t border-[#E5DDD5] pt-2 text-sm font-bold"><span>Total</span><span className="text-[#72383D]">{formatInvoiceClp(document.total_amount)}</span></div></div></section><section className="rounded-lg border border-[#D8CFC5] bg-[#FCFAF7] p-3"><p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#6B625C]">Documento oficial Bsale</p>{knownStatus && <p className="mb-2 text-xs text-[#4F4842]">Estado Bsale: <strong>{cancelled ? 'Anulada' : 'Confirmada'}</strong></p>}<div className="flex flex-wrap items-center gap-2">{document.official_url && <a href={document.official_url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md bg-[#72383D] px-3 text-xs font-bold text-white hover:bg-[#612F34]">Ver factura oficial</a>}{document.pdf_url && <a href={document.pdf_url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md border border-[#B8ABA0] px-3 text-xs font-semibold text-[#4F4842] hover:bg-white">Descargar PDF</a>}{document.xml_url && <a href={document.xml_url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-md px-2 text-[11px] font-semibold text-[#6B625C] underline underline-offset-2">XML</a>}{!document.official_url && !document.pdf_url && !document.xml_url && <span className="text-xs text-[#6B625C]">Documento oficial no disponible en el mirror.</span>}</div></section>{cancelled && document.credit_note_folio && <p className="text-xs font-semibold text-[#8A4B4B]">Nota de Crédito #{document.credit_note_folio} conservada como documento relacionado.</p>}{!cancelled && <div className="border-t border-[#E5DDD5] pt-3"><p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#6B625C]">Acción secundaria</p><Button variant="outline" size="sm" onClick={() => onCreditNote(document)} className="text-[#72383D]">Anular con Nota de Crédito</Button></div>}</section>
}

export function InvoiceDocumentsDetail({ documents, onCreditNote }: { documents: InvoiceDocumentPreview[]; onCreditNote: (document: InvoiceDocumentPreview) => void }) {
  return <div className="space-y-4">{documents.map(document => <InvoiceDocumentBlock key={`${document.invoice_bsale_id ?? document.invoice_folio}:${document.invoice_folio}`} document={document} onCreditNote={onCreditNote} />)}</div>
}

export function InvoiceDocumentDetail({ document, onCreditNote }: { document: InvoiceDocumentPreview; onCreditNote: () => void }) {
  return <InvoiceDocumentsDetail documents={[document]} onCreditNote={() => onCreditNote()} />
}

export const invoiceUiSafetyCopy = {
  noEmission: 'La emisión real permanece deshabilitada en este bloque.',
  noProductionFixture: 'Los fixtures son locales y no modifican Supabase.',
}
