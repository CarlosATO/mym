'use client'

import { useState } from 'react'
import { FileText, Map, ShieldAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  CreditNoteConfirmationModal,
  InvoiceConfirmationModal,
  InvoiceDocumentsDetail,
  InvoiceReviewModal,
  invoiceUiFixture5032,
  type InvoiceDocumentPreview,
} from './invoice-flow-ui'

const oneInvoiceFixture: InvoiceDocumentPreview = {
  invoice_bsale_id: 99001,
  invoice_folio: 'DEMO-5032-A',
  invoice_date: '2026-10-21',
  client_name: invoiceUiFixture5032.client_name,
  client_rut: invoiceUiFixture5032.client_rut,
  net_amount: 4704,
  tax_amount: 894,
  total_amount: 5598,
  status: 'CONFIRMED',
  document_status: 'CONFIRMED',
  sales_order_folio: invoiceUiFixture5032.folio,
  official_url: 'https://demo.invalid/bsale/DEMO-5032-A',
  pdf_url: 'https://demo.invalid/bsale/DEMO-5032-A.pdf',
  xml_url: 'https://demo.invalid/bsale/DEMO-5032-A.xml',
  related_detail_count: 2,
  related_detail_ids: [334790, 334791],
}

const partialInvoiceFixture: InvoiceDocumentPreview = {
  invoice_bsale_id: 99002,
  invoice_folio: 'DEMO-5032-B',
  invoice_date: '2026-10-21',
  client_name: invoiceUiFixture5032.client_name,
  client_rut: invoiceUiFixture5032.client_rut,
  net_amount: 2100,
  tax_amount: 399,
  total_amount: 2499,
  status: 'CONFIRMED',
  document_status: 'CONFIRMED',
  sales_order_folio: invoiceUiFixture5032.folio,
  official_url: 'https://demo.invalid/bsale/DEMO-5032-B',
  pdf_url: null,
  xml_url: null,
  related_detail_count: 1,
  related_detail_ids: [334790],
}

const cancelledInvoiceFixture: InvoiceDocumentPreview = {
  ...oneInvoiceFixture,
  invoice_folio: 'DEMO-5032-C',
  status: 'CANCELLED',
  document_status: 'CANCELLED',
  official_url: 'https://demo.invalid/bsale/DEMO-5032-C',
  pdf_url: 'https://demo.invalid/bsale/DEMO-5032-C.pdf',
  xml_url: null,
  credit_note_folio: 'DEMO-NC-5032-A',
}

function PreviewCard({ documents, onView }: { documents: InvoiceDocumentPreview[]; onView: () => void }) {
  const amount = documents.reduce((sum, document) => sum + (document.total_amount ?? 0), 0)
  return <article className="rounded-xl border border-emerald-200 bg-white p-3 shadow-sm"><div className="flex items-center justify-between gap-2"><p className="text-xs font-bold">NV #{invoiceUiFixture5032.folio}</p><span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-800">Facturada</span></div><p className="mt-2 truncate text-sm font-semibold">{invoiceUiFixture5032.client_name}</p><div className="mt-2 flex items-center justify-between text-xs text-[#6B625C]"><span>{documents.length > 1 ? `${documents.length} facturas · ${new Intl.NumberFormat('es-CL').format(amount)} facturado` : `Factura #${documents[0].invoice_folio}`}</span><strong className="text-sm text-[#322D29]">${new Intl.NumberFormat('es-CL').format(amount)}</strong></div><Button variant="outline" size="sm" onClick={onView} className="mt-3 h-7 border-[#72383D]/35 text-[10px] font-bold uppercase tracking-wider text-[#72383D]"> <FileText className="mr-1 h-3 w-3" /> Ver factura</Button></article>
}

export function InvoiceFlowPreview() {
  const [reviewOpen, setReviewOpen] = useState(false)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [documents, setDocuments] = useState<InvoiceDocumentPreview[]>([])
  const [creditNoteOpen, setCreditNoteOpen] = useState(false)
  const [creditNoteDocument, setCreditNoteDocument] = useState<InvoiceDocumentPreview | null>(null)
  const [cancelledOpen, setCancelledOpen] = useState(false)

  const openDocuments = (next: InvoiceDocumentPreview[]) => setDocuments(next)

  return <main className="min-h-screen bg-[#EFE9E1] px-4 py-8 text-[#322D29] sm:px-8"><div className="mx-auto max-w-7xl space-y-6"><header className="rounded-2xl border border-[#D8CFC5] bg-[#FCFAF7] p-5 shadow-sm"><div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 text-[#72383D]" /><div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#72383D]">Preview dev-only · fixtures DEMO locales</p><h1 className="mt-1 text-2xl font-bold tracking-tight">Facturado en espera de Guía de Ruta</h1><p className="mt-1 text-sm text-[#6B625C]">NV #{invoiceUiFixture5032.folio} · {invoiceUiFixture5032.client_name} · $5.598</p></div></div></header>

    <section className="grid gap-4 xl:grid-cols-2"><div className="rounded-2xl border border-[#D8CFC5] bg-[#F8F5F1] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">A · Una factura</p><p className="text-xs text-[#6B625C]">Fixture visual, relación N:M</p></div><Map className="h-4 w-4 text-sky-600" /></div><PreviewCard documents={[oneInvoiceFixture]} onView={() => openDocuments([oneInvoiceFixture])} /><p className="mt-2 text-[10px] text-[#6B625C]">D · PDF y XML disponibles bajo demanda</p></div><div className="rounded-2xl border border-[#D8CFC5] bg-[#F8F5F1] p-4"><div className="mb-3 flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">B · Facturación parcial</p><p className="text-xs text-[#6B625C]">Dos facturas asociadas a la misma NV</p></div><Map className="h-4 w-4 text-sky-600" /></div><PreviewCard documents={[oneInvoiceFixture, partialInvoiceFixture]} onView={() => openDocuments([oneInvoiceFixture, partialInvoiceFixture])} /><p className="mt-2 text-[10px] text-[#6B625C]">E · PDF/XML no disponibles para DEMO-5032-B</p></div></section>

    <section className="rounded-2xl border border-[#D8CFC5] bg-[#FCFAF7] p-4"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-[#72383D]" /><h2 className="text-sm font-bold">Flujo pendiente y documento oficial</h2></div><p className="mt-1 text-xs text-[#6B625C]">La revisión de emisión permanece bloqueada y la factura oficial se consulta bajo demanda.</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={() => setReviewOpen(true)} className="bg-[#72383D] text-white hover:bg-[#612F34]">Revisar facturación</Button><Button variant="outline" size="sm" onClick={() => setCancelledOpen(true)} className="text-[#8A4B4B]">Ver factura anulada</Button></div></section>

    <section className="rounded-2xl border border-[#D8CFC5] bg-[#FCFAF7] p-4"><div className="flex items-center gap-2"><XCircle className="h-4 w-4 text-[#8A4B4B]" /><h2 className="text-sm font-bold">G · Factura anulada + NC</h2></div><div className="mt-3 flex items-center gap-2 rounded-lg border border-[#E5DDD5] bg-white p-3 text-xs"><span className="rounded-full bg-[#F5EDE9] px-2 py-0.5 font-bold uppercase text-[#8A4B4B]">Anulada</span><span>Factura #{cancelledInvoiceFixture.invoice_folio}</span><span className="text-[#6B625C]">·</span><span>Nota de Crédito #{cancelledInvoiceFixture.credit_note_folio}</span></div></section>

    <p className="text-center text-[11px] font-semibold text-[#6B625C]">PDF/XML no se descargan en precarga · sin lecturas productivas · sin escrituras · sin emisión real</p></div>

    <InvoiceReviewModal open={reviewOpen} snapshot={invoiceUiFixture5032} onOpenChange={setReviewOpen} onContinue={() => { setReviewOpen(false); setConfirmationOpen(true) }} />
    <InvoiceConfirmationModal open={confirmationOpen} snapshot={invoiceUiFixture5032} onOpenChange={setConfirmationOpen} onEmissionBlocked={() => undefined} resetAfterMs={900} />
    {documents.length > 0 && <Dialog open onOpenChange={open => { if (!open) setDocuments([]) }}><DialogContent className="w-[calc(100vw-2rem)] !max-w-[1100px] max-h-[88vh] overflow-y-auto border-[#DDD4CA] bg-[#FCFAF7] text-[#322D29]"><DialogHeader><DialogTitle>Documento tributario</DialogTitle><DialogDescription>Fixture documental local. Los enlaces oficiales son demostrativos.</DialogDescription></DialogHeader><InvoiceDocumentsDetail documents={documents} onCreditNote={document => { setCreditNoteDocument(document); setCreditNoteOpen(true) }} /></DialogContent></Dialog>}
    <CreditNoteConfirmationModal open={creditNoteOpen} document={creditNoteDocument} onOpenChange={setCreditNoteOpen} onEmissionBlocked={() => undefined} resetAfterMs={900} />
    <Dialog open={cancelledOpen} onOpenChange={setCancelledOpen}><DialogContent className="w-[calc(100vw-2rem)] !max-w-[1100px] max-h-[88vh] overflow-y-auto border-[#DDD4CA] bg-[#FCFAF7] text-[#322D29]"><DialogHeader><DialogTitle>Factura anulada</DialogTitle><DialogDescription>Factura y Nota de Crédito conservadas en el fixture local.</DialogDescription></DialogHeader><InvoiceDocumentsDetail documents={[cancelledInvoiceFixture]} onCreditNote={() => undefined} /></DialogContent></Dialog>
  </main>
}
