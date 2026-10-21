'use client'

import { useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

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
}

export type InvoiceDocumentPreview = {
  invoice_folio: string
  invoice_date: string | null
  client_name: string
  total_amount: number | null
  status: 'CONFIRMED' | 'CANCELLED'
  sales_order_folio: string
  credit_note_folio?: string | null
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
  open, snapshot, loading = false, error = null, onOpenChange, onContinue,
}: {
  open: boolean
  snapshot: InvoiceReviewSnapshot | null
  loading?: boolean
  error?: string | null
  onOpenChange: (open: boolean) => void
  onContinue: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-[85vw] !max-w-[1100px] max-h-[88vh] overflow-hidden border-[#DDD4CA] bg-[#FCFAF7] p-0 text-[#322D29] sm:!max-w-[1100px]">
        <DialogHeader className="flex-row items-start justify-between border-b border-[#E5DDD5] px-6 py-5 pr-12">
          <div><DialogTitle className="flex items-center gap-2 text-lg"><FileText className="h-4 w-4 text-[#72383D]" /> Revisar facturación</DialogTitle><DialogDescription className="mt-1 text-xs">Verifica los datos antes de emitir la factura.</DialogDescription></div>
          {snapshot && <div className="text-right text-xs leading-5 text-[#6B625C]"><p className="font-bold text-[#322D29]">NV #{snapshot.folio}</p><p>{formatInvoiceDate(snapshot.emission_date)}</p></div>}
        </DialogHeader>
        <div className="max-h-[calc(88vh-142px)] space-y-5 overflow-y-auto bg-white px-6 py-5">
          {loading && <div className="flex items-center gap-2 text-sm text-[#6B625C]"><Loader2 className="h-4 w-4 animate-spin" /> Cargando versión vigente…</div>}
          {error && <p className="rounded-md border border-[#8A4B4B]/25 bg-[#8A4B4B]/8 p-3 text-xs text-[#8A4B4B]">No se pudo cargar la revisión de facturación.</p>}
          {snapshot && (
            <>
              <section className="border-b border-[#E5DDD5] pb-5"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B625C]">Cliente / receptor</p><p className="text-base font-bold tracking-tight">{snapshot.client_name}</p><div className="mt-1.5 space-y-0.5 text-xs leading-5 text-[#4F4842]"><p>{[formatInvoiceRut(snapshot.client_rut), snapshot.client_activity].filter(Boolean).join(' · ')}</p><p>{snapshot.client_address}</p><p>{[snapshot.client_city, snapshot.client_region].filter(Boolean).join(', ')}</p><p>{[snapshot.client_email, formatInvoicePhone(snapshot.client_phone)].filter(Boolean).join(' · ')}</p></div></section>
              {(!snapshot.client_rut || !snapshot.client_address) && <p className="text-[11px] text-[#806238]">Faltan datos de facturación del cliente.</p>}
              <section><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6B625C]">Detalle</p><div className="overflow-x-auto"><div className="min-w-[620px]"><div className="grid grid-cols-[180px_minmax(0,1fr)_80px_110px] gap-4 border-y border-[#E5DDD5] bg-[#FAF8F5] px-2 py-2 text-[9px] font-semibold uppercase tracking-wider text-[#6B625C]"><span>SKU</span><span>Producto</span><span>Cant.</span><span className="text-right">Total</span></div>{snapshot.lines.map(line => <div key={line.detail_id} className="grid grid-cols-[180px_minmax(0,1fr)_80px_110px] gap-4 border-b border-[#F0EBE5] px-2 py-2.5 text-xs last:border-0"><span className="font-medium text-[#6B625C]">{line.sku ?? '—'}</span><span className="min-w-0 font-medium">{line.product_name}</span><span className="tabular-nums">{line.quantity}</span><span className="text-right tabular-nums">{formatInvoiceClp(line.total_amount)}</span></div>)}</div></div>
              </section>
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
          <Button disabled={!snapshot || snapshot.readiness !== 'READY_TO_INVOICE' || loading} onClick={onContinue} className="bg-[#72383D] text-white hover:bg-[#612F34]">Continuar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InvoiceConfirmationModal({ open, snapshot, onOpenChange, onEmissionBlocked, resetAfterMs }: { open: boolean; snapshot: InvoiceReviewSnapshot | null; onOpenChange: (open: boolean) => void; onEmissionBlocked: () => void; resetAfterMs?: number }) {
  const [submitting, setSubmitting] = useState(false)
  if (!snapshot) return null
  const handleSubmit = () => { if (submitting) return; setSubmitting(true); onEmissionBlocked(); if (resetAfterMs) window.setTimeout(() => setSubmitting(false), resetAfterMs) }
  return <Dialog open={open} onOpenChange={next => { if (!submitting) onOpenChange(next) }}>
    <DialogContent className="w-[calc(100vw-2rem)] max-w-lg border-[#DDD4CA] bg-[#FCFAF7] text-[#322D29]">
      <DialogHeader><DialogTitle>Confirmar facturación real</DialogTitle><DialogDescription>Está a punto de realizar una facturación real para el cliente {snapshot.client_name} por un monto de {formatInvoiceClp(snapshot.total_amount)} correspondiente a la NV #{snapshot.folio}. ¿Está seguro de continuar?</DialogDescription></DialogHeader>
      <div className="rounded-md border border-[#E5DDD5] bg-white px-3 py-2 text-xs"><p><strong>NV:</strong> #{snapshot.folio}</p><p><strong>Cliente:</strong> {snapshot.client_name}</p><p><strong>Monto:</strong> {formatInvoiceClp(snapshot.total_amount)}</p></div>
      <DialogFooter><Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>Cancelar</Button><Button disabled={submitting} onClick={handleSubmit} className="bg-[#72383D] text-white hover:bg-[#612F34]">{submitting ? 'Emitiendo factura…' : 'Emitir factura'}</Button></DialogFooter>
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

export function InvoiceDocumentDetail({ document, onCreditNote }: { document: InvoiceDocumentPreview; onCreditNote: () => void }) {
  const cancelled = document.status === 'CANCELLED'
  return <section className="space-y-3 rounded-lg border border-[#E5DDD5] bg-white p-4"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#72383D]" /><h3 className="text-xs font-bold uppercase tracking-wider">Documento tributario</h3></div><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${cancelled ? 'bg-[#F5EDE9] text-[#8A4B4B]' : 'bg-emerald-50 text-emerald-800'}`}>{cancelled ? 'Anulada' : 'Facturada'}</span></div><div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4"><div><p className="text-[9px] uppercase text-[#6B625C]">Factura</p><p className="font-bold">#{document.invoice_folio}</p></div><div><p className="text-[9px] uppercase text-[#6B625C]">NV relacionada</p><p className="font-bold">#{document.sales_order_folio}</p></div><div><p className="text-[9px] uppercase text-[#6B625C]">Cliente</p><p className="truncate font-bold">{document.client_name}</p></div><div><p className="text-[9px] uppercase text-[#6B625C]">Monto</p><p className="font-bold">{formatInvoiceClp(document.total_amount)}</p></div></div>{cancelled && document.credit_note_folio && <p className="text-xs font-semibold text-[#8A4B4B]">Nota de Crédito #{document.credit_note_folio}</p>}{!cancelled && <Button variant="outline" size="sm" onClick={onCreditNote} className="text-[#72383D]">Anular con Nota de Crédito</Button>}</section>
}

export const invoiceUiSafetyCopy = {
  noEmission: 'La emisión real permanece deshabilitada en este bloque.',
  noProductionFixture: 'Los fixtures son locales y no modifican Supabase.',
}
