'use client'

import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { getDevelopmentInvoicePrintDocument } from '@/app/actions/logistica/sales-order-preparation'
import { Button } from '@/components/ui/button'
import { openConfirmedInvoicePdf, prepareInvoicePrintWindow, setInvoicePrintWindowStatus } from '@/lib/integraciones/invoice-print-assistant'
import { InvoiceConfirmationModal, invoiceUiFixture5032, type InvoiceEmissionUiResult } from './invoice-flow-ui'

export function InvoiceFlowPreview() {
  const [confirmationOpen, setConfirmationOpen] = useState(true)
  const [message, setMessage] = useState<string | null>(null)

  const simulateConfirmedEmission = async (): Promise<InvoiceEmissionUiResult> => {
    const printWindow = prepareInvoicePrintWindow(url => window.open(url, '_blank'))
    setInvoicePrintWindowStatus(printWindow, 'Simulación: esperando confirmación', 'No se emitirá ningún documento tributario. Se leerá la factura 24758 ya confirmada.')
    try {
      const documentResult = await getDevelopmentInvoicePrintDocument('24758')
      if (documentResult.error || !documentResult.data) throw new Error(documentResult.error ?? 'No se encontró la factura de prueba.')
      if (documentResult.data.status !== 'CONFIRMED') throw new Error('La factura de prueba no está confirmada.')
      const printResult = openConfirmedInvoicePdf(printWindow, documentResult.data.pdf_url, undefined, error => {
        setMessage(`Chrome no abrió automáticamente el diálogo: ${error}`)
      })
      if (!printResult.opened) {
        setInvoicePrintWindowStatus(printWindow, 'Simulación confirmada sin impresión automática', 'Chrome bloqueó la ventana o la URL PDF no fue válida.')
        setMessage('La simulación terminó sin emitir. Permite ventanas emergentes y vuelve a cargar la prueba.')
      } else {
        setMessage('Simulación CONFIRMED completada. El PDF oficial se abrió y Chrome solicitó la impresión nativa.')
      }
      return { status: 'CONFIRMED', error: null, invoice_id: documentResult.data.invoice_bsale_id, folio: documentResult.data.invoice_folio, urls: { pdf: documentResult.data.pdf_url } }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'No se pudo ejecutar la simulación.'
      setInvoicePrintWindowStatus(printWindow, 'Simulación detenida', detail)
      setMessage(detail)
      return { status: 'PREVALIDATION_FAILED', error: detail }
    }
  }

  return <main className="min-h-screen bg-[#EFE9E1] px-4 py-8 text-[#322D29]"><section className="mx-auto max-w-3xl rounded-2xl border border-sky-200 bg-sky-50/60 p-5"><div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-sky-700" /><h1 className="text-base font-bold text-sky-950">Simulación local de impresión posterior a facturación</h1></div><p className="mt-2 text-xs text-sky-900">Sólo desarrollo: no emite facturas, no crea intentos y no escribe en Bsale ni Supabase. La simulación usa la factura confirmada N.º 24758 de la NV 5032.</p><div className="mt-4 rounded-lg border border-sky-200 bg-white p-3 text-xs text-sky-950"><p className="font-bold">Secuencia esperada</p><p className="mt-1">Pulsa una vez «Emitir factura» en el diálogo. Se abrirá la ventana auxiliar, se leerá el PDF oficial confirmado y Chrome solicitará su diálogo nativo. Sólo debes confirmar «Imprimir».</p></div><div className="mt-4 flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => setConfirmationOpen(true)} className="border-sky-300 text-sky-950">Abrir confirmación simulada</Button></div>{message && <p className="mt-4 rounded-md border border-sky-200 bg-white p-3 text-xs font-medium text-sky-950">{message}</p>}</section><InvoiceConfirmationModal open={confirmationOpen} snapshot={invoiceUiFixture5032} onOpenChange={setConfirmationOpen} onConfirm={simulateConfirmedEmission} onEmissionBlocked={() => setMessage('La simulación está deshabilitada. No se ejecutó ninguna emisión.')} /></main>
}
