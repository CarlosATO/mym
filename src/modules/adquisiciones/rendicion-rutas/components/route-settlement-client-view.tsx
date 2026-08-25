'use client'

import { useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, FileText, LockKeyhole, WalletCards } from 'lucide-react'
import {
  RouteSettlementDetail,
  RouteSettlementDetailClient,
  RouteSettlementDetailInvoice,
  RouteSettlementDetailPayment,
  RouteSettlementBlockingInvoice,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RegisterRouteSettlementPaymentDialog } from './register-route-settlement-payment-dialog'
import { RouteSettlementPaymentDetailDialog, VoidRouteSettlementPaymentDialog } from './route-settlement-payment-detail-dialog'
import { RouteSettlementInvoiceResolutionDialog } from './route-settlement-invoice-resolution-dialog'
import { RouteSettlementCloseDialog, financialResultLabel } from './route-settlement-close-dialog'
import { formatCurrency, formatDate, formatExpectedPaymentMethod } from '../utils/route-settlement-formatters'

interface RouteSettlementClientViewProps {
  detail: RouteSettlementDetail
  onClose: () => void
  canUpdateSettlement: boolean
  canCloseSettlement: boolean
  onPaymentSaved: () => Promise<void>
}

function statusLabel(status: RouteSettlementDetailClient['status'], resolved = false) {
  if (resolved) return 'Rendido'
  if (status === 'PAID') return 'Pagada'
  if (status === 'PARTIAL') return 'Parcial'
  return 'Pendiente'
}

function statusClass(status: RouteSettlementDetailClient['status'] | RouteSettlementDetailInvoice['invoice_result'], resolved = false) {
  if (resolved) return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-300'
  if (status === 'PAID') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300'
  if (status === 'PARTIAL') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300'
  if (status === 'REVIEW_REQUIRED') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300'
  if (status === 'PENDING_PAYMENT') return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300'
  if (status === 'CREDIT' || status === 'NOT_DELIVERED') return 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-300'
  return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
}

function invoiceStatusLabel(invoice: RouteSettlementDetailClient['invoices'][number]) {
  if (invoice.invoice_result === 'PAID') return 'Pagada'
  if (invoice.invoice_result === 'PENDING_PAYMENT') return 'Pago pendiente'
  if (invoice.invoice_result === 'CREDIT') return 'Crédito'
  if (invoice.invoice_result === 'NOT_DELIVERED') return 'No entregada'
  if (invoice.invoice_result === 'REVIEW_REQUIRED') return 'Revisar'
  if (invoice.invoice_result === 'PARTIAL') return 'Parcial'
  return 'Pendiente'
}

function displayAmount(value: number) {
  return formatCurrency(Number(value) || 0)
}

function paymentMethodLabel(method: string) {
  if (method === 'CASH') return 'Efectivo'
  if (method === 'CHECK') return 'Cheque'
  if (method === 'TRANSFER') return 'Transferencia'
  return method
}

export function RouteSettlementClientView({ detail, onClose, canUpdateSettlement, canCloseSettlement, onPaymentSaved }: RouteSettlementClientViewProps) {
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null)
  const [blockingDialogOpen, setBlockingDialogOpen] = useState(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const selectedClient = detail.clients.find(client => client.customer_bsale_id === selectedClientId) ?? null
  const summary = detail.settlement
  const isClosed = summary.workflow_status === 'CLOSED'
  const canModify = canUpdateSettlement && !isClosed
  const blockingInvoices = summary.blocking_invoices ?? []
  const financialLabel = summary.unresolved_invoice_count > 0
    ? 'Pendiente de resolución'
    : financialResultLabel(summary.derived_financial_result ?? summary.financial_result)

  return (
    <div className="flex h-full min-h-0 flex-col animate-in fade-in duration-200">
      <header className="shrink-0 border-b border-theme-border bg-theme-surface/80 px-4 py-3 lg:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              aria-label="Volver a la bandeja"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-theme-text-muted">Rendición de rutas</p>
              <h1 className="truncate text-lg font-bold text-theme-text">{summary.settlement_number}</h1>
              <p className="text-xs text-theme-text-muted">
                Guía: <span className="font-semibold text-theme-text">{summary.route_guide_number}</span>
                <span className="mx-1.5">·</span>{formatDate(summary.guide_date)}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 border-t border-theme-border/60 pt-3 text-left lg:border-t-0 lg:pt-0">
            <SummaryValue label="Clientes" value={summary.customer_count} />
            <SummaryValue label="Facturas" value={summary.invoice_count} />
            <SummaryValue label="Total esperado" value={displayAmount(summary.total_expected)} emphasized />
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 border-t border-theme-border/60 pt-3 text-xs lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-theme-text-muted">
            <span><strong className="text-theme-text">Resueltas:</strong> {summary.resolved_invoice_count} / {summary.invoice_count}</span>
            <span><strong className="text-theme-text">Por resolver:</strong> {summary.unresolved_invoice_count}</span>
            <span>Resultado: <strong className="text-theme-text">{isClosed ? financialResultLabel(summary.financial_result) : financialLabel}</strong></span>
          </div>
          {isClosed ? (
            <div className="inline-flex items-center gap-1.5 font-semibold text-theme-text"><LockKeyhole className="h-3.5 w-3.5" /> Rendición cerrada</div>
          ) : canCloseSettlement ? (
            <div className="flex flex-wrap items-center gap-2">
              {summary.can_close && summary.derived_workflow_status === 'READY_TO_CLOSE' && <span className="font-semibold text-theme-text">Rendición lista para cerrar</span>}
              {!summary.can_close && blockingInvoices.length > 0 && <button type="button" onClick={() => setBlockingDialogOpen(true)} className="font-semibold text-theme-text-muted underline decoration-theme-border underline-offset-2 hover:text-theme-text">Ver pendientes ({blockingInvoices.length})</button>}
              <button type="button" onClick={() => setCloseDialogOpen(true)} disabled={!summary.can_close} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-45" title={!summary.can_close ? 'Todavía existen facturas por resolver.' : undefined}>
                <LockKeyhole className="h-3.5 w-3.5" /> Cerrar rendición
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-theme-text">Clientes de la rendición</h2>
              <p className="mt-0.5 text-xs text-theme-text-muted">Selecciona un cliente para revisar sus facturas y pagos registrados.</p>
            </div>
            <p className="hidden text-xs text-theme-text-muted sm:block">
              Recibido nuevo: <span className="font-semibold text-theme-text">{displayAmount(summary.total_applied_new)}</span>
            </p>
          </div>

          <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                <tr>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-3 py-3 text-center">Facturas</th>
                  <th className="px-3 py-3 text-right">Esperado</th>
                  <th className="px-3 py-3 text-right">Recibido</th>
                  <th className="px-3 py-3 text-right">Pendiente</th>
                  <th className="px-3 py-3">Estado</th>
                  <th className="px-4 py-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border/70">
                {detail.clients.map(client => (
                  <tr key={`${client.customer_bsale_id ?? 'unknown'}-${client.customer_name}`} className="transition-colors hover:bg-theme-text/[0.025]">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-theme-text">{client.customer_name}</div>
                      {client.rut && <div className="mt-0.5 text-[11px] text-theme-text-muted">{client.rut}</div>}
                    </td>
                    <td className="px-3 py-3 text-center tabular-nums text-theme-text-muted">{client.invoice_count}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums text-theme-text">{displayAmount(client.expected_amount)}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-theme-text">{displayAmount(client.applied_amount)}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums text-theme-text">{displayAmount(client.pending_amount)}</td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold ${statusClass(client.status)}`}>
                         {statusLabel(client.status, client.unresolved_invoice_count === 0)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedClientId(client.customer_bsale_id)}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                      >
                        Ver <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <Sheet open={selectedClient !== null} onOpenChange={open => !open && setSelectedClientId(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto border-theme-border bg-theme-surface sm:max-w-2xl">
          {selectedClient && (
            <ClientDetail
              client={selectedClient}
              settlementId={summary.id}
              canUpdateSettlement={canModify}
              onPaymentSaved={onPaymentSaved}
            />
          )}
        </SheetContent>
      </Sheet>

      {!isClosed && canCloseSettlement && blockingInvoices.length > 0 && (
        <BlockingInvoicesDialog
          invoices={blockingInvoices}
          open={blockingDialogOpen}
          onOpenChange={setBlockingDialogOpen}
          onSelectClient={customerId => {
            setBlockingDialogOpen(false)
            setSelectedClientId(customerId)
          }}
        />
      )}

      {!isClosed && canCloseSettlement && summary.can_close && (
        <RouteSettlementCloseDialog
          settlement={summary}
          open={closeDialogOpen}
          onOpenChange={setCloseDialogOpen}
          onClosed={onPaymentSaved}
        />
      )}
    </div>
  )
}

function SummaryValue({ label, value, emphasized = false }: { label: string; value: string | number; emphasized?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p>
      <p className={`mt-0.5 text-sm tabular-nums ${emphasized ? 'font-bold text-theme-text' : 'font-semibold text-theme-text'}`}>{value}</p>
    </div>
  )
}

function BlockingInvoicesDialog({
  invoices,
  open,
  onOpenChange,
  onSelectClient,
}: {
  invoices: RouteSettlementBlockingInvoice[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectClient: (customerId: number) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-theme-border bg-theme-surface text-theme-text">
        <DialogHeader>
          <DialogTitle className="text-theme-text">Facturas pendientes de resolver</DialogTitle>
          <DialogDescription className="text-theme-text-muted">No puedes cerrar todavía. Estas facturas requieren una situación operacional.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(60vh,28rem)] overflow-y-auto rounded-lg border border-theme-border text-xs">
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-theme-border bg-theme-text/[0.03] px-3 py-2 font-bold uppercase tracking-wide text-[10px] text-theme-text-muted">
            <span>Cliente</span><span>Factura</span><span>Motivo</span>
          </div>
          <div className="divide-y divide-theme-border/70">
            {invoices.map(invoice => (
              <div key={invoice.settlement_item_id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2.5">
                {invoice.customer_bsale_id !== null ? (
                  <button type="button" onClick={() => onSelectClient(invoice.customer_bsale_id as number)} className="truncate text-left font-semibold text-theme-text underline decoration-theme-border underline-offset-2 hover:text-theme-accent">{invoice.customer_name}</button>
                ) : <span className="truncate font-semibold text-theme-text">{invoice.customer_name}</span>}
                <span className="font-semibold tabular-nums text-theme-text">{invoice.invoice_number}</span>
                <span className="text-right text-theme-text-muted">{invoice.reason}</span>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ClientDetail({
  client,
  settlementId,
  canUpdateSettlement,
  onPaymentSaved,
}: {
  client: RouteSettlementDetailClient
  settlementId: string
  canUpdateSettlement: boolean
  onPaymentSaved: () => Promise<void>
}) {
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false)
  const [editingPayment, setEditingPayment] = useState<RouteSettlementDetailPayment | null | undefined>(undefined)
  const [selectedPayment, setSelectedPayment] = useState<RouteSettlementDetailPayment | null>(null)
  const [voidingPayment, setVoidingPayment] = useState<RouteSettlementDetailPayment | null>(null)
  const [selectedInvoice, setSelectedInvoice] = useState<RouteSettlementDetailClient['invoices'][number] | null>(null)

  async function refreshAfterPaymentChange() {
    setPaymentDialogOpen(false)
    setEditingPayment(undefined)
    setSelectedPayment(null)
    setVoidingPayment(null)
    await onPaymentSaved()
  }

  return (
    <>
      <SheetHeader className="border-b border-theme-border px-5 py-5 pr-12">
        <SheetTitle className="text-lg text-theme-text">{client.customer_name}</SheetTitle>
        <SheetDescription className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-theme-text-muted">
          {client.rut && <span>RUT {client.rut}</span>}
          {client.customer_bsale_id !== null && <span>Cliente Bsale {client.customer_bsale_id}</span>}
          <span>{client.invoice_count} facturas</span>
        </SheetDescription>
        <div className="mt-3 flex items-center gap-5 text-xs">
          <SummaryValue label="Esperado" value={displayAmount(client.expected_amount)} emphasized />
          <SummaryValue label="Recibido nuevo" value={displayAmount(client.applied_amount)} />
          <SummaryValue label="Pendiente" value={displayAmount(client.pending_amount)} />
        </div>
        {canUpdateSettlement && <button
          type="button"
          onClick={() => { setEditingPayment(null); setPaymentDialogOpen(true) }}
          className="mt-4 inline-flex h-8 items-center justify-center rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
        >
          Registrar pago
        </button>}
      </SheetHeader>

      <div className="space-y-6 px-5 pb-8">
        <section>
          <SectionHeading icon={<FileText className="h-4 w-4" />} title="Facturas" />
          <div className="overflow-x-auto rounded-lg border border-theme-border">
            <table className="w-full min-w-[580px] text-xs">
              <thead className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Factura</th>
                  <th className="px-3 py-2 text-right">Esperado</th>
                  <th className="px-3 py-2 text-left">Medio esperado</th>
                  <th className="px-3 py-2 text-right">Aplicado</th>
                  <th className="px-3 py-2 text-right">Pendiente</th>
                    <th className="px-3 py-2 text-left">Estado</th>
                    <th className="px-3 py-2 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border/70">
                {client.invoices.map(invoice => (
                  <tr key={invoice.settlement_item_id}>
                    <td className="px-3 py-2.5 font-semibold text-theme-text">{invoice.invoice_number}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-theme-text">{displayAmount(invoice.expected_amount)}</td>
                    <td className="px-3 py-2.5 text-theme-text-muted">{formatExpectedPaymentMethod(invoice.expected_payment_method)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-theme-text">{displayAmount(invoice.applied_amount)}</td>
                     <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text">{displayAmount(invoice.unapplied_amount)}</td>
                     <td className="px-3 py-2.5">
                       <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass(invoice.invoice_result)}`}>
                         {invoiceStatusLabel(invoice)}
                       </span>
                     </td>
                     <td className="px-3 py-2.5 text-right">
                       <button type="button" onClick={() => setSelectedInvoice(invoice)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text">
                         Ver <ChevronRight className="h-3.5 w-3.5" />
                       </button>
                     </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {client.invoices.some(invoice => invoice.legacy_status || invoice.legacy_notes) && (
            <details className="mt-3 rounded-lg border border-theme-border/70 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-semibold text-theme-text-muted">Información de rendición anterior</summary>
              <div className="mt-2 space-y-1.5 text-theme-text-muted">
                {client.invoices.map(invoice => (
                  <div key={`legacy-${invoice.settlement_item_id}`} className="flex flex-wrap gap-x-2 gap-y-1">
                    <span className="font-semibold text-theme-text">{invoice.invoice_number}</span>
                    <span>{invoice.legacy_status}</span>
                    <span>{displayAmount(invoice.legacy_received_amount)} registrado</span>
                    {invoice.legacy_notes && <span>· {invoice.legacy_notes}</span>}
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>

        <section>
          <SectionHeading icon={<WalletCards className="h-4 w-4" />} title="Pagos registrados" />
          {client.payments.length === 0 ? (
            <div className="rounded-lg border border-dashed border-theme-border px-4 py-6 text-center text-xs text-theme-text-muted">
              No hay pagos registrados
            </div>
          ) : (
            <div className="space-y-2">
              {client.payments.map(payment => (
                <div key={payment.id} className="rounded-lg border border-theme-border px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="font-semibold text-theme-text">
                        {paymentMethodLabel(payment.payment_method_received)}
                        {payment.check_number && <span className="ml-1 text-theme-text-muted">{payment.check_number}</span>}
                      </span>
                      <p className="mt-1 text-theme-text-muted">
                        {displayAmount(payment.amount_received)} · {payment.allocations.length} {payment.allocations.length === 1 ? 'factura' : 'facturas'} · {payment.voided_at ? 'Anulado' : 'Confirmado'}
                      </p>
                    </div>
                    <button type="button" onClick={() => setSelectedPayment(payment)} className="rounded-lg px-2 py-1.5 font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text">Ver</button>
                  </div>
                  <p className="mt-1 text-theme-text-muted">Aplicado {displayAmount(payment.amount_applied)}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <RegisterRouteSettlementPaymentDialog
        key={editingPayment?.id ?? 'new-payment'}
        open={paymentDialogOpen}
        settlementId={settlementId}
        client={client}
        payment={editingPayment}
        onOpenChange={open => { setPaymentDialogOpen(open); if (!open) setEditingPayment(undefined) }}
        onSaved={refreshAfterPaymentChange}
      />

      <RouteSettlementPaymentDetailDialog
        payment={selectedPayment}
        open={selectedPayment !== null}
        onOpenChange={open => !open && setSelectedPayment(null)}
        canUpdateSettlement={canUpdateSettlement}
        onEdit={() => {
          if (!selectedPayment || selectedPayment.voided_at) return
          setEditingPayment(selectedPayment)
          setSelectedPayment(null)
          setPaymentDialogOpen(true)
        }}
        onVoid={() => {
          if (selectedPayment && !selectedPayment.voided_at) {
            setVoidingPayment(selectedPayment)
            setSelectedPayment(null)
          }
        }}
      />

      <RouteSettlementInvoiceResolutionDialog
        key={selectedInvoice?.settlement_item_id ?? 'no-invoice'}
        invoice={selectedInvoice}
        payments={client.payments}
        open={selectedInvoice !== null}
        canUpdateSettlement={canUpdateSettlement}
        onOpenChange={open => !open && setSelectedInvoice(null)}
        onSaved={async () => {
          setSelectedInvoice(null)
          await refreshAfterPaymentChange()
        }}
      />

      <VoidRouteSettlementPaymentDialog
        payment={voidingPayment}
        customerName={client.customer_name}
        open={voidingPayment !== null}
        onOpenChange={open => !open && setVoidingPayment(null)}
        onVoided={refreshAfterPaymentChange}
      />
    </>
  )
}

function SectionHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <h2 className="mb-2.5 flex items-center gap-2 text-sm font-bold text-theme-text">
      <span className="text-theme-text-muted">{icon}</span>{title}
    </h2>
  )
}
