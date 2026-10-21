'use client'

import { useState } from 'react'
import { FileText, Map, ShieldAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  CreditNoteConfirmationModal,
  formatInvoiceClp,
  InvoiceConfirmationModal,
  InvoiceDocumentDetail,
  InvoiceReviewModal,
  invoiceUiFixture5032,
  type InvoiceDocumentPreview,
} from './invoice-flow-ui'

const invoiceFixture: InvoiceDocumentPreview = {
  invoice_folio: '1842',
  invoice_date: '21-10-2026',
  client_name: invoiceUiFixture5032.client_name,
  total_amount: 5598,
  status: 'CONFIRMED',
  sales_order_folio: invoiceUiFixture5032.folio,
}

const cancelledInvoiceFixture: InvoiceDocumentPreview = {
  ...invoiceFixture,
  status: 'CANCELLED',
  credit_note_folio: '921',
}

function PreviewCard({ invoiced = false }: { invoiced?: boolean }) {
  const [reviewOpen, setReviewOpen] = useState(false)
  const [confirmationOpen, setConfirmationOpen] = useState(false)

  return (
    <article className="rounded-xl border border-[#D8CFC5] bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold">NV #{invoiceUiFixture5032.folio}</p>
        {invoiced ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-800">Facturada</span> : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-800">Lista para facturar</span>}
      </div>
      <p className="mt-2 truncate text-sm font-semibold">{invoiceUiFixture5032.client_name}</p>
      <div className="mt-2 flex items-center justify-between text-xs text-[#6B625C]"><span>1 unidad · PW28210</span><strong className="text-sm text-[#322D29]">{formatInvoiceClp(invoiceUiFixture5032.total_amount || invoiceFixture.total_amount)}</strong></div>
      {invoiced ? <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-[#72383D]"><FileText className="h-3.5 w-3.5" /> Factura #{invoiceFixture.invoice_folio}</p> : <Button size="sm" onClick={() => setReviewOpen(true)} className="mt-3 h-7 bg-[#72383D] text-[10px] text-white hover:bg-[#612F34]">Facturar</Button>}
      <InvoiceReviewModal open={reviewOpen} snapshot={invoiceUiFixture5032} onOpenChange={setReviewOpen} onContinue={() => { setReviewOpen(false); setConfirmationOpen(true) }} />
      <InvoiceConfirmationModal open={confirmationOpen} snapshot={invoiceUiFixture5032} onOpenChange={setConfirmationOpen} onEmissionBlocked={() => undefined} resetAfterMs={900} />
    </article>
  )
}

export function InvoiceFlowPreview() {
  const [documentOpen, setDocumentOpen] = useState(false)
  const [creditNoteOpen, setCreditNoteOpen] = useState(false)
  const [cancelledOpen, setCancelledOpen] = useState(false)

  return (
    <main className="min-h-screen bg-[#EFE9E1] px-4 py-8 text-[#322D29] sm:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-2xl border border-[#D8CFC5] bg-[#FCFAF7] p-5 shadow-sm"><div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 text-[#72383D]" /><div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#72383D]">Preview dev-only · fixtures locales</p><h1 className="mt-1 text-2xl font-bold tracking-tight">Flujo de facturación y ruta</h1><p className="mt-1 text-sm text-[#6B625C]">NV #{invoiceUiFixture5032.folio} · {invoiceUiFixture5032.client_name}</p></div></div></header>

        <section className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-2xl border border-[#D8CFC5] bg-[#F8F5F1] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Pendientes de facturación</p><p className="text-xs text-[#6B625C]">Card READY_TO_INVOICE</p></div><span className="h-2 w-2 rounded-full bg-emerald-500" /></div><PreviewCard /></div>
          <div className="rounded-2xl border border-[#D8CFC5] bg-[#F8F5F1] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Facturado en espera de Guía de Ruta</p><p className="text-xs text-[#6B625C]">Card INVOICED_READY_FOR_ROUTE</p></div><Map className="h-4 w-4 text-sky-600" /></div><PreviewCard invoiced /></div>
        </section>

        <section className="rounded-2xl border border-[#D8CFC5] bg-[#FCFAF7] p-4"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#72383D]" /><h2 className="text-sm font-bold">Documento tributario</h2></div><p className="mt-1 text-xs text-[#6B625C]">Factura confirmada y acciones de anulación, sin persistencia.</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setDocumentOpen(true)}>Abrir detalle tributario</Button><Button variant="outline" size="sm" onClick={() => setCancelledOpen(true)} className="text-[#8A4B4B]">Ver factura anulada</Button></div></section>

        <section className="rounded-2xl border border-[#D8CFC5] bg-[#FCFAF7] p-4"><div className="flex items-center gap-2"><XCircle className="h-4 w-4 text-[#8A4B4B]" /><h2 className="text-sm font-bold">Estado factura anulada</h2></div><div className="mt-3 flex items-center gap-2 rounded-lg border border-[#E5DDD5] bg-white p-3 text-xs"><span className="rounded-full bg-[#F5EDE9] px-2 py-0.5 font-bold uppercase text-[#8A4B4B]">Anulada</span><span>Factura #{cancelledInvoiceFixture.invoice_folio}</span><span className="text-[#6B625C]">·</span><span>Nota de Crédito #{cancelledInvoiceFixture.credit_note_folio}</span></div></section>

        <p className="text-center text-[11px] font-semibold text-[#6B625C]">Sin lecturas productivas · sin escrituras · sin emisión real</p>
      </div>

      <Dialog open={documentOpen} onOpenChange={setDocumentOpen}><DialogContent className="w-[calc(100vw-2rem)] max-w-2xl border-[#DDD4CA] bg-[#FCFAF7] text-[#322D29]"><DialogHeader><DialogTitle>Detalle de factura</DialogTitle><DialogDescription>Documento tributario asociado a la NV. Vista local de solo lectura.</DialogDescription></DialogHeader><InvoiceDocumentDetail document={invoiceFixture} onCreditNote={() => setCreditNoteOpen(true)} /></DialogContent></Dialog>
      <CreditNoteConfirmationModal open={creditNoteOpen} document={invoiceFixture} onOpenChange={setCreditNoteOpen} onEmissionBlocked={() => undefined} resetAfterMs={900} />
      <Dialog open={cancelledOpen} onOpenChange={setCancelledOpen}><DialogContent className="w-[calc(100vw-2rem)] max-w-2xl border-[#DDD4CA] bg-[#FCFAF7] text-[#322D29]"><DialogHeader><DialogTitle>Factura anulada</DialogTitle><DialogDescription>Vista local de documento anulado y su Nota de Crédito relacionada.</DialogDescription></DialogHeader><InvoiceDocumentDetail document={cancelledInvoiceFixture} onCreditNote={() => undefined} /></DialogContent></Dialog>
    </main>
  )
}
