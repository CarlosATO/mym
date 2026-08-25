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
import { RouteSettlementCloseDialog } from './route-settlement-close-dialog'
import { formatCurrency, formatDate } from '../utils/route-settlement-formatters'
import { RouteSettlementExpenses } from './route-settlement-expenses'

interface RouteSettlementClientViewProps {
  detail: RouteSettlementDetail
  onClose: () => void
  canUpdateSettlement: boolean
  canCloseSettlement: boolean
  onPaymentSaved: () => Promise<void>
}

function clientOperationalStatus(client: RouteSettlementDetailClient) {
  const resolvedCount = client.invoices.filter(invoice => invoice.resolved_for_settlement).length
  const hasReviewRequired = client.invoices.some(invoice =>
    invoice.resolution_type === 'REVIEW_REQUIRED' || invoice.invoice_result === 'REVIEW_REQUIRED',
  )

  if (hasReviewRequired) {
    return {
      label: 'Revisar',
      className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
    }
  }
  if (resolvedCount === 0) {
    return {
      label: 'Pendiente',
      className: 'border-theme-border bg-theme-text/5 text-theme-text-muted',
    }
  }
  if (resolvedCount < client.invoice_count) {
    return {
      label: `Parcial · ${resolvedCount}/${client.invoice_count}`,
      className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
    }
  }
  return {
    label: client.pending_amount > 0 ? 'Rendido con saldo' : 'Rendido',
    className: client.pending_amount > 0
      ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300',
  }
}

function invoiceSituationLabel(invoice: RouteSettlementDetailInvoice) {
  if (invoice.invoice_result === 'PAID') return 'Pagada'
  if (invoice.resolution_type === 'CREDIT') return 'Crédito'
  if (invoice.resolution_type === 'PENDING_PAYMENT') return 'Pago pendiente'
  if (invoice.resolution_type === 'NOT_DELIVERED') return 'No entregada'
  if (invoice.resolution_type === 'REVIEW_REQUIRED') return 'Revisar'
  if (invoice.invoice_result === 'PARTIAL') return 'Parcial'
  return 'Pendiente'
}

function invoiceSituationClass(invoice: RouteSettlementDetailInvoice) {
  if (invoice.invoice_result === 'PAID') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300'
  if (invoice.resolution_type === 'CREDIT' || invoice.resolution_type === 'NOT_DELIVERED') return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
  if (invoice.resolution_type === 'PENDING_PAYMENT' || invoice.resolution_type === 'REVIEW_REQUIRED' || invoice.invoice_result === 'PARTIAL') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300'
  return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
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
  const [pendingFlowActive, setPendingFlowActive] = useState(false)
  const [pendingInvoiceId, setPendingInvoiceId] = useState<string | null>(null)
  const selectedClient = detail.clients.find(client => client.customer_bsale_id === selectedClientId) ?? null
  const summary = detail.settlement
  const isClosed = summary.workflow_status === 'CLOSED'
  const canModify = canUpdateSettlement && !isClosed
  const blockingInvoices = (summary.blocking_invoices ?? []).map(invoice => ({
    ...invoice,
    unapplied_amount: detail.clients.flatMap(client => client.invoices).find(item => item.settlement_item_id === invoice.settlement_item_id)?.unapplied_amount ?? 0,
  }))

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
        <div className="mt-3 flex flex-col gap-2 border-t border-theme-border/60 pt-3 text-xs lg:flex-row lg:items-center lg:justify-end">
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
          <SettlementSummary detail={detail} isClosed={isClosed} />
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-theme-text">Clientes de la rendición</h2>
              <p className="mt-0.5 text-xs text-theme-text-muted">Selecciona un cliente para revisar sus facturas y pagos registrados.</p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                <tr>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-3 py-3 text-center">Facturas</th>
                  <th className="px-3 py-3 text-right">Esperado</th>
                  <th className="px-3 py-3 text-right">Recibido</th>
                  <th className="px-3 py-3 text-right">Sin aplicar</th>
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
                      <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold ${clientOperationalStatus(client).className}`}>
                         {clientOperationalStatus(client).label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => { setPendingFlowActive(false); setSelectedClientId(client.customer_bsale_id) }}
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

          <RouteSettlementExpenses
            settlementId={summary.id}
            expenses={detail.expenses ?? []}
            total={summary.total_route_expenses ?? 0}
            canModify={canModify}
            onChanged={onPaymentSaved}
          />
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
              openInvoiceId={pendingFlowActive ? pendingInvoiceId : null}
              onInvoiceResolutionSaved={async () => {
                if (pendingFlowActive) {
                  setPendingInvoiceId(null)
                  setSelectedClientId(null)
                  await onPaymentSaved()
                  setBlockingDialogOpen(true)
                  return
                }
                await onPaymentSaved()
              }}
              onPendingFlowExit={() => {
                if (!pendingFlowActive) return
                setPendingInvoiceId(null)
                setSelectedClientId(null)
                setBlockingDialogOpen(true)
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      {!isClosed && canCloseSettlement && blockingInvoices.length > 0 && (
        <BlockingInvoicesDialog
          invoices={blockingInvoices}
          open={blockingDialogOpen}
          onOpenChange={setBlockingDialogOpen}
          onSelectInvoice={(customerId, settlementItemId) => {
            setBlockingDialogOpen(false)
            setPendingFlowActive(true)
            setPendingInvoiceId(settlementItemId)
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

function SettlementSummary({ detail, isClosed }: { detail: RouteSettlementDetail; isClosed: boolean }) {
  const summary = detail.settlement
  const invoices = detail.clients.flatMap(client => client.invoices)
  const activeConfirmedPayments = detail.clients.flatMap(client => client.payments).filter(payment => !payment.voided_at && payment.verification_status === 'CONFIRMED')
  const totalExpected = invoices.reduce((total, invoice) => total + Number(invoice.expected_amount || 0), 0)
  const totalApplied = invoices.reduce((total, invoice) => total + Number(invoice.applied_amount || 0), 0)
  const totalReceived = activeConfirmedPayments.reduce((total, payment) => total + Number(payment.amount_received || 0), 0)
  const balanceToCover = Math.max(totalExpected - totalApplied, 0)
  const paymentMethods = {
    CASH: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'CASH').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
    TRANSFER: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'TRANSFER').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
    CHECK: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'CHECK').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
  }
  const situations = invoices.reduce((counts, invoice) => {
    if (invoice.invoice_result === 'PAID') counts.paid += 1
    if (invoice.invoice_result === 'PENDING_PAYMENT') counts.pending += 1
    if (invoice.invoice_result === 'CREDIT') counts.credit += 1
    if (invoice.invoice_result === 'NOT_DELIVERED') counts.notDelivered += 1
    if (invoice.invoice_result === 'REVIEW_REQUIRED') counts.review += 1
    return counts
  }, { paid: 0, pending: 0, credit: 0, notDelivered: 0, review: 0 })
  const workflowLabel = isClosed
    ? 'Cerrada'
    : summary.can_close || summary.derived_workflow_status === 'READY_TO_CLOSE'
      ? 'Lista para cerrar'
      : 'En progreso'

  return (
    <section className="mb-6 rounded-xl border border-theme-border bg-theme-surface/70 p-4 lg:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-bold text-theme-text">Resumen de la rendición</h2>
          <p className="mt-0.5 text-xs text-theme-text-muted">Estado financiero y operacional actual.</p>
        </div>
        <span className="inline-flex w-fit rounded-full border border-theme-border bg-theme-text/5 px-2.5 py-1 text-[11px] font-semibold text-theme-text">{workflowLabel}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryMetric label="Total esperado" value={displayAmount(totalExpected)} />
        <SummaryMetric label="Total recibido" value={displayAmount(totalReceived)} />
        <SummaryMetric label="Sin aplicar" value={displayAmount(balanceToCover)} />
        <SummaryMetric label="Gastos de ruta" value={displayAmount(Number(summary.total_route_expenses) || 0)} />
      </div>

      <div className="mt-4 border-t border-theme-border/70 pt-3">
        <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Medios recibidos</p>
        <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <SummaryInline label="Efectivo" value={displayAmount(paymentMethods.CASH)} />
          <SummaryInline label="Transferencias" value={displayAmount(paymentMethods.TRANSFER)} />
          <SummaryInline label="Cheques" value={displayAmount(paymentMethods.CHECK)} />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-theme-border/70 pt-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Estado operacional</p>
          <div className="mt-2 text-xs text-theme-text-muted">
            <p><strong className="text-theme-text">{summary.resolved_invoice_count} de {summary.invoice_count} facturas resueltas</strong></p>
            <p className="mt-1">{summary.unresolved_invoice_count} por resolver <span className="mx-1">·</span> {summary.review_required_count} en revisión</p>
          </div>
        </div>
        <div className="mt-3 border-t border-theme-border/70 pt-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Situaciones</p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <SituationBadge label="Pagadas" value={situations.paid} />
            <SituationBadge label="Pago pendiente" value={situations.pending} />
            <SituationBadge label="Crédito" value={situations.credit} />
            <SituationBadge label="No entregadas" value={situations.notDelivered} />
            <SituationBadge label="Revisión" value={situations.review} warning />
          </div>
        </div>
      </div>
    </section>
  )
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2.5"><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-1 text-base font-bold tabular-nums text-theme-text">{value}</p></div>
}

function SummaryInline({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 rounded-lg bg-theme-text/[0.03] px-3 py-2"><span className="text-theme-text-muted">{label}</span><strong className="tabular-nums text-theme-text">{value}</strong></div>
}

function SituationBadge({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 font-semibold ${warning ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300' : 'border-theme-border bg-theme-text/[0.03] text-theme-text-muted'}`}>{label} {value}</span>
}

type BlockingInvoiceRow = RouteSettlementBlockingInvoice & { unapplied_amount: number }

function BlockingInvoicesDialog({
  invoices,
  open,
  onOpenChange,
  onSelectInvoice,
}: {
  invoices: BlockingInvoiceRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectInvoice: (customerId: number, settlementItemId: string) => void
}) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'REVIEW'>('ALL')
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredInvoices = invoices.filter(invoice => {
    const isReview = invoice.reason === 'Requiere revisión'
    const matchesFilter = filter === 'ALL' || (filter === 'REVIEW' ? isReview : !isReview)
    const matchesSearch = !normalizedSearch || `${invoice.customer_name} ${invoice.invoice_number}`.toLocaleLowerCase().includes(normalizedSearch)
    return matchesFilter && matchesSearch
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-[90vw] flex-col overflow-hidden border-theme-border bg-theme-surface p-0 text-theme-text sm:max-w-[1000px]">
        <DialogHeader>
          <div className="border-b border-theme-border bg-white px-5 py-4 dark:bg-theme-surface sm:px-6">
            <DialogTitle className="text-theme-text">Facturas pendientes de resolver</DialogTitle>
            <DialogDescription className="mt-1 text-theme-text-muted">{invoices.length} {invoices.length === 1 ? 'pendiente' : 'pendientes'} para completar la rendición.</DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-theme-surface">
          <div className="flex flex-col gap-3 border-b border-theme-border px-5 py-3 sm:flex-row sm:items-center sm:px-6">
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar por cliente o factura..." className="h-9 min-w-0 flex-1 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text outline-none focus:border-theme-accent" />
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-theme-border p-1 text-xs">
              {([['ALL', 'Todos'], ['PENDING', 'Pendientes'], ['REVIEW', 'Revisión']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-md px-2.5 py-1.5 font-semibold transition-colors ${filter === value ? 'bg-theme-accent text-white' : 'text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'}`}>{label}</button>)}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-theme-border bg-theme-text/[0.03] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                <tr><th className="px-5 py-2.5 sm:px-6">Cliente</th><th className="px-3 py-2.5">Factura</th><th className="px-3 py-2.5 text-right">Sin aplicar</th><th className="px-3 py-2.5">Situación</th><th className="px-5 py-2.5 text-right sm:px-6">Acción</th></tr>
              </thead>
              <tbody className="divide-y divide-theme-border/70">
                {filteredInvoices.length === 0 ? <tr><td colSpan={5} className="px-5 py-10 text-center text-theme-text-muted sm:px-6">No hay facturas que coincidan con los filtros.</td></tr> : filteredInvoices.map(invoice => {
                  const isReview = invoice.reason === 'Requiere revisión'
                  return <tr key={invoice.settlement_item_id} className="hover:bg-theme-text/[0.025]">
                    <td className="max-w-[320px] px-5 py-3 font-semibold text-theme-text sm:px-6" title={invoice.customer_name}><span className="block truncate">{invoice.customer_name}</span></td>
                    <td className="px-3 py-3 font-semibold tabular-nums text-theme-text">{invoice.invoice_number}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums text-theme-text">{formatCurrency(Number(invoice.unapplied_amount) || 0)}</td>
                    <td className="px-3 py-3"><span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold ${isReview ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300' : 'border-theme-border bg-theme-text/5 text-theme-text-muted'}`}>{isReview ? 'Revisión' : 'Pendiente'}</span></td>
                    <td className="px-5 py-3 text-right sm:px-6"><button type="button" onClick={() => invoice.customer_bsale_id !== null && onSelectInvoice(invoice.customer_bsale_id, invoice.settlement_item_id)} disabled={invoice.customer_bsale_id === null} className="font-semibold text-theme-accent hover:text-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40">{isReview ? 'Revisar' : 'Resolver'}</button></td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-theme-border px-5 py-2 text-[11px] text-theme-text-muted sm:px-6">Mostrando {filteredInvoices.length} de {invoices.length}</div>
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
  openInvoiceId,
  onInvoiceResolutionSaved,
  onPendingFlowExit,
}: {
  client: RouteSettlementDetailClient
  settlementId: string
  canUpdateSettlement: boolean
  onPaymentSaved: () => Promise<void>
  openInvoiceId: string | null
  onInvoiceResolutionSaved: () => Promise<void>
  onPendingFlowExit: () => void
}) {
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false)
  const [editingPayment, setEditingPayment] = useState<RouteSettlementDetailPayment | null | undefined>(undefined)
  const [selectedPayment, setSelectedPayment] = useState<RouteSettlementDetailPayment | null>(null)
  const [voidingPayment, setVoidingPayment] = useState<RouteSettlementDetailPayment | null>(null)
  const [selectedInvoice, setSelectedInvoice] = useState<RouteSettlementDetailClient['invoices'][number] | null>(null)
  const targetedInvoice = openInvoiceId
    ? client.invoices.find(item => item.settlement_item_id === openInvoiceId) ?? null
    : null
  const activeInvoice = selectedInvoice ?? targetedInvoice

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
          <span>{client.invoice_count} {client.invoice_count === 1 ? 'factura' : 'facturas'}</span>
        </SheetDescription>
        <div className="mt-3 flex items-center gap-5 text-xs">
          <SummaryValue label="Esperado" value={displayAmount(client.expected_amount)} emphasized />
          <SummaryValue label="Recibido nuevo" value={displayAmount(client.applied_amount)} />
          <SummaryValue label="Sin aplicar" value={displayAmount(client.pending_amount)} />
        </div>
        {canUpdateSettlement && client.pending_amount > 0 && <button
          type="button"
          onClick={() => { setEditingPayment(null); setPaymentDialogOpen(true) }}
          className="mt-4 inline-flex h-8 items-center justify-center rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
        >
          {client.payments.some(payment => !payment.voided_at) ? 'Registrar otro pago' : 'Registrar pago'}
        </button>}
      </SheetHeader>

      <div className="space-y-6 px-5 pb-8">
        <section>
          <SectionHeading icon={<FileText className="h-4 w-4" />} title="Facturas" />
          <div className="overflow-x-auto rounded-lg border border-theme-border">
            <table className="w-full table-fixed text-xs">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[21%]" />
                <col className="w-[21%]" />
                <col className="w-[19%]" />
                <col className="w-[13%]" />
              </colgroup>
              <thead className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Factura</th>
                  <th className="px-3 py-2 text-right">Esperado</th>
                  <th className="px-3 py-2 text-right">Aplicado</th>
                  <th className="px-2 py-2 text-left">Situación</th>
                  <th className="px-2 py-2 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border/70">
                {client.invoices.map(invoice => (
                  <tr key={invoice.settlement_item_id}>
                    <td className="px-3 py-2.5 font-semibold text-theme-text">{invoice.invoice_number}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-theme-text">{displayAmount(invoice.expected_amount)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-theme-text">{displayAmount(invoice.applied_amount)}</td>
                    <td className="whitespace-normal px-2 py-2.5">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${invoiceSituationClass(invoice)}`}>
                        {invoiceSituationLabel(invoice)}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right">
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
        invoices={client.invoices}
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
        key={activeInvoice?.settlement_item_id ?? 'no-invoice'}
        invoice={activeInvoice}
        payments={client.payments}
        open={activeInvoice !== null}
        canUpdateSettlement={canUpdateSettlement}
        onOpenChange={open => {
          if (open) return
          setSelectedInvoice(null)
          if (openInvoiceId) onPendingFlowExit()
        }}
        onSaved={async () => {
          setSelectedInvoice(null)
          await onInvoiceResolutionSaved()
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
