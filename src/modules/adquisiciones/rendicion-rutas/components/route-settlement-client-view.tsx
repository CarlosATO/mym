'use client'

import { Fragment, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, FileText, LockKeyhole, Search, WalletCards, X } from 'lucide-react'
import {
  RouteSettlementDetail,
  RouteSettlementDetailClient,
  RouteSettlementDetailInvoice,
  RouteSettlementDetailPayment,
  RouteSettlementBlockingInvoice,
  markRouteSettlementTransferReview,
  recordRouteSettlementBulk,
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

function invoiceSituationLabel(invoice: RouteSettlementDetailInvoice) {
  if (invoice.invoice_result === 'PAID') return 'Pagada'
  if (invoice.invoice_result === 'TRANSFER_PENDING_REVIEW') return 'Transferencia · Por revisar'
  if (invoice.resolution_type === 'CREDIT') return 'Crédito'
  if (invoice.resolution_type === 'PENDING_PAYMENT') return 'Pago pendiente'
  if (invoice.resolution_type === 'NOT_DELIVERED') return 'No entregada'
  if (invoice.resolution_type === 'REVIEW_REQUIRED') return 'Revisar'
  if (invoice.invoice_result === 'PARTIAL') return 'Parcial'
  return 'Pendiente'
}

function invoiceSituationClass(invoice: RouteSettlementDetailInvoice) {
  if (invoice.invoice_result === 'PAID') return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300'
  if (invoice.invoice_result === 'TRANSFER_PENDING_REVIEW') return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300'
  if (invoice.resolution_type === 'CREDIT' || invoice.resolution_type === 'NOT_DELIVERED') return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
  if (invoice.resolution_type === 'PENDING_PAYMENT' || invoice.resolution_type === 'REVIEW_REQUIRED' || invoice.invoice_result === 'PARTIAL') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300'
  return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
}

function displayAmount(value: number) {
  return formatCurrency(Number(value) || 0)
}

function paymentMethodLabel(method: string) {
  if (method === 'AL_DIA') return 'Al día'
  if (method === 'CASH') return 'Efectivo'
  if (method === 'CHECK') return 'Cheque'
  if (method === 'TRANSFER') return 'Transferencia'
  return method
}

type QuickResult = 'CASH' | 'CHECK' | 'TRANSFER' | 'CREDIT'
type QuickSelection = QuickResult | ''

const quickResultLabels: Record<QuickResult, string> = {
  CASH: 'Efectivo',
  CHECK: 'Cheque',
  TRANSFER: 'Transferencia',
  CREDIT: 'Crédito',
}

function quickResultFor(invoice: RouteSettlementDetailInvoice): QuickSelection {
  if (invoice.expected_payment_method === 'AL_DIA') return ''
  if (invoice.expected_payment_method === 'CHECK') return 'CHECK'
  if (invoice.expected_payment_method === 'TRANSFER') return 'TRANSFER'
  if (invoice.expected_payment_method === 'CREDIT') return 'CREDIT'
  return 'CASH'
}

function persistedQuickResult(invoice: RouteSettlementDetailInvoice, payments: RouteSettlementDetailPayment[]): QuickSelection {
  if (invoice.resolution_type === 'CREDIT' || invoice.invoice_result === 'CREDIT') return 'CREDIT'

  const receivedMethod = payments.find(payment =>
    !payment.voided_at && payment.allocations.some(allocation =>
      !allocation.voided_at && allocation.settlement_item_id === invoice.settlement_item_id,
    ),
  )?.payment_method_received
  if (receivedMethod === 'CASH' || receivedMethod === 'CHECK' || receivedMethod === 'TRANSFER') return receivedMethod

  if (invoice.invoice_result === 'TRANSFER_PENDING_REVIEW') return 'TRANSFER'
  return quickResultFor(invoice)
}

function quickEligible(invoice: RouteSettlementDetailInvoice) {
  return !invoice.resolved_for_settlement && quickAmount(invoice) > 0
}

function quickAmount(invoice: RouteSettlementDetailInvoice) {
  return Math.max(Number(invoice.unapplied_amount) || 0, Number(invoice.expected_amount) - Number(invoice.applied_amount || 0))
}

function quickPaymentGroupKey(invoice: RouteSettlementDetailInvoice, result: QuickResult) {
  const customerKey = invoice.customer_bsale_id?.toString() ?? invoice.settlement_item_id
  return `quick:${customerKey}:${result}`
}

function clientUiKey(client: RouteSettlementDetailClient) {
  if (client.customer_bsale_id !== null) return `bsale:${client.customer_bsale_id}`
  return `unresolved:${client.invoices[0]?.settlement_item_id ?? client.customer_name}`
}

function splitUnidentifiedClients(clients: RouteSettlementDetailClient[]): RouteSettlementDetailClient[] {
  return clients.flatMap(client => {
    if (client.customer_bsale_id !== null || client.invoices.length <= 1) return [client]
    return client.invoices.map(invoice => ({
      ...client,
      invoice_count: 1,
      expected_amount: invoice.expected_amount,
      applied_amount: invoice.applied_amount,
      pending_amount: invoice.unapplied_amount,
      status: (invoice.invoice_result === 'PAID' ? 'PAID' : invoice.applied_amount > 0 ? 'PARTIAL' : 'PENDING') as RouteSettlementDetailClient['status'],
      invoices: [invoice],
      payments: [],
    }))
  })
}

function normalizeQuickSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function invoiceReceivedMethods(invoice: RouteSettlementDetailInvoice, payments: RouteSettlementDetailPayment[]) {
  const methods = payments
    .filter(payment => !payment.voided_at && payment.allocations.some(allocation => allocation.settlement_item_id === invoice.settlement_item_id))
    .map(payment => paymentMethodLabel(payment.payment_method_received))
  return [...new Set(methods)].join(', ') || 'Sin Payment'
}

function QuickInvoiceRows({
  client,
  selectedIds,
  results,
  onToggle,
  onResultChange,
}: {
  client: RouteSettlementDetailClient
  selectedIds: string[]
  results: Record<string, QuickSelection>
  onToggle: (invoiceId: string) => void
  onResultChange: (invoiceId: string, result: QuickResult) => void
}) {
  return <div className="ml-5 border-l-2 border-theme-accent/30 bg-theme-text/[0.018] pl-3 sm:ml-8 sm:pl-5">
    <div className="grid min-w-[720px] grid-cols-[4.5rem_1.2fr_0.9fr_1fr_1.15fr_1.15fr] items-center gap-2 border-b border-theme-border/50 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-theme-text-muted">
      <span>Procesar</span><span>Factura</span><span className="text-right">Monto</span><span>Medio esperado</span><span>Resultado</span><span>Estado actual</span>
    </div>
    <div className="min-w-[720px] divide-y divide-theme-border/40">
        {client.invoices.map(invoice => {
          const eligible = quickEligible(invoice)
           const result = results[invoice.settlement_item_id] ?? persistedQuickResult(invoice, client.payments)
           const needsResult = invoice.expected_payment_method === 'AL_DIA' && result === ''
           return <div key={invoice.settlement_item_id} className={`grid grid-cols-[4.5rem_1.2fr_0.9fr_1fr_1.15fr_1.15fr] items-center gap-2 px-2 py-1 text-xs transition-colors ${needsResult ? 'bg-amber-500/10' : eligible && selectedIds.includes(invoice.settlement_item_id) ? 'bg-theme-accent/[0.045]' : 'hover:bg-theme-text/[0.025]'}`}>
            <span><input type="checkbox" checked={eligible && selectedIds.includes(invoice.settlement_item_id)} disabled={!eligible} onChange={() => onToggle(invoice.settlement_item_id)} aria-label={`Procesar factura ${invoice.invoice_number}`} className="h-3.5 w-3.5 accent-theme-accent" /></span>
            <span className="font-semibold text-theme-text">{invoice.invoice_number}</span>
            <span className="text-right font-mono tabular-nums text-theme-text">{displayAmount(quickAmount(invoice))}</span>
             <span className={invoice.expected_payment_method === 'AL_DIA' ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-theme-text-muted'}>{paymentMethodLabel(invoice.expected_payment_method)}</span>
             <span><select value={result} disabled={!eligible} onChange={event => onResultChange(invoice.settlement_item_id, event.target.value as QuickResult)} className={`h-7 max-w-full rounded-md border bg-theme-surface px-1.5 text-xs text-theme-text ${needsResult ? 'border-amber-500' : 'border-theme-border'}`}><option value="">Seleccionar resultado…</option><option value="CASH">Efectivo</option><option value="CHECK">Cheque</option><option value="TRANSFER">Transferencia</option><option value="CREDIT">Crédito</option></select></span>
            <span><span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${invoiceSituationClass(invoice)}`}>{invoiceSituationLabel(invoice)}</span></span>
          </div>
        })}
    </div>
  </div>
}

function ClientSelectionCheckbox({
  eligibleCount,
  selectedCount,
  onChange,
}: {
  eligibleCount: number
  selectedCount: number
  onChange: (checked: boolean) => void
}) {
  const checked = eligibleCount > 0 && selectedCount === eligibleCount
  const indeterminate = selectedCount > 0 && selectedCount < eligibleCount
  return <input
    type="checkbox"
    checked={checked}
    disabled={eligibleCount === 0}
    ref={element => { if (element) element.indeterminate = indeterminate }}
    onChange={event => onChange(event.target.checked)}
    aria-label="Seleccionar facturas elegibles del cliente"
    className="h-3.5 w-3.5 accent-theme-accent"
  />
}

export function RouteSettlementClientView({ detail, onClose, canUpdateSettlement, canCloseSettlement, onPaymentSaved }: RouteSettlementClientViewProps) {
  const [selectedClientKey, setSelectedClientKey] = useState<string | null>(null)
  const [blockingDialogOpen, setBlockingDialogOpen] = useState(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [pendingFlowActive, setPendingFlowActive] = useState(false)
  const [pendingInvoiceId, setPendingInvoiceId] = useState<string | null>(null)
  const [quickSearch, setQuickSearch] = useState('')
  const uiClients = splitUnidentifiedClients(detail.clients)
  const quickInvoices = uiClients.flatMap(client => client.invoices).filter(quickEligible)
  const [selectedQuickInvoices, setSelectedQuickInvoices] = useState<string[]>(() => quickInvoices.map(invoice => invoice.settlement_item_id))
  const [quickResults, setQuickResults] = useState<Record<string, QuickSelection>>(() => Object.fromEntries(quickInvoices.map(invoice => [invoice.settlement_item_id, quickResultFor(invoice)])))
  const [checkDetails, setCheckDetails] = useState<Record<string, { bank_name: string; check_number: string; check_date: string }>>({})
  const [bulkConfirmationOpen, setBulkConfirmationOpen] = useState(false)
  const [bulkIdempotencyKey, setBulkIdempotencyKey] = useState<string | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [isBulkSaving, setIsBulkSaving] = useState(false)
  const selectedClient = uiClients.find(client => clientUiKey(client) === selectedClientKey) ?? null
  const summary = detail.settlement
  const isClosed = summary.workflow_status === 'CLOSED'
  const canModify = canUpdateSettlement && !isClosed
  const blockingInvoices = (summary.blocking_invoices ?? []).map(invoice => ({
    ...invoice,
    unapplied_amount: uiClients.flatMap(client => client.invoices).find(item => item.settlement_item_id === invoice.settlement_item_id)?.unapplied_amount ?? 0,
  }))
  const selectedQuickRows = quickInvoices.filter(invoice => selectedQuickInvoices.includes(invoice.settlement_item_id))
  const quickTotals = selectedQuickRows.reduce((totals, invoice) => {
    const result = quickResults[invoice.settlement_item_id] ?? quickResultFor(invoice)
    if (!result) return totals
    totals[result].count += 1
    totals[result].amount += quickAmount(invoice)
    return totals
  }, { CASH: { count: 0, amount: 0 }, CHECK: { count: 0, amount: 0 }, TRANSFER: { count: 0, amount: 0 }, CREDIT: { count: 0, amount: 0 } } as Record<QuickResult, { count: number; amount: number }>)
  const quickExpectedAmounts = quickInvoices.reduce((totals, invoice) => {
    const result = quickResultFor(invoice)
    if (result) totals[result] += quickAmount(invoice)
    return totals
  }, { CASH: 0, CHECK: 0, TRANSFER: 0, CREDIT: 0 } as Record<QuickResult, number>)
  const quickExpectedTotal = quickInvoices.reduce((total, invoice) => total + quickAmount(invoice), 0)
  const quickPreparedTotal = Object.values(quickTotals).reduce((total, result) => total + result.amount, 0)
  const normalizedQuickSearch = normalizeQuickSearch(quickSearch)
  const filteredClients = normalizedQuickSearch
    ? uiClients.filter(client =>
      normalizeQuickSearch(`${client.customer_name} ${client.rut ?? ''}`).includes(normalizedQuickSearch) ||
      client.invoices.some(invoice => normalizeQuickSearch(invoice.invoice_number).includes(normalizedQuickSearch)),
    )
    : uiClients
  const checkGroups = Object.values(selectedQuickRows.reduce((groups, invoice) => {
    const result = quickResults[invoice.settlement_item_id] ?? quickResultFor(invoice)
    if (result !== 'CHECK') return groups
    const paymentGroupKey = quickPaymentGroupKey(invoice, result)
    const client = uiClients.find(item => item.invoices.some(clientInvoice => clientInvoice.settlement_item_id === invoice.settlement_item_id))
    const group = groups[paymentGroupKey] ?? {
      paymentGroupKey,
      customerName: client?.customer_name ?? 'Cliente sin identificar',
      rut: client?.rut ?? null,
      invoices: [],
      amount: 0,
    }
    group.invoices.push(invoice)
    group.amount += quickAmount(invoice)
    groups[paymentGroupKey] = group
    return groups
  }, {} as Record<string, { paymentGroupKey: string; customerName: string; rut: string | null; invoices: RouteSettlementDetailInvoice[]; amount: number }>))

  function toggleQuickInvoice(invoiceId: string) {
    setSelectedQuickInvoices(current => current.includes(invoiceId) ? current.filter(id => id !== invoiceId) : [...current, invoiceId])
  }

  function toggleClientInvoices(client: RouteSettlementDetailClient, checked: boolean) {
    const clientInvoiceIds = client.invoices.filter(quickEligible).map(invoice => invoice.settlement_item_id)
    setSelectedQuickInvoices(current => checked
      ? [...new Set([...current, ...clientInvoiceIds])]
      : current.filter(id => !clientInvoiceIds.includes(id)))
  }

  async function saveQuickRows() {
    const missingAlDia = selectedQuickRows.filter(invoice => {
      const result = quickResults[invoice.settlement_item_id] ?? quickResultFor(invoice)
      return invoice.expected_payment_method === 'AL_DIA' && !result
    })
    if (missingAlDia.length > 0) {
      setBulkError('Hay facturas seleccionadas con forma de pago \'Al día\' que requieren indicar cómo fueron pagadas.')
      return
    }
    const missingCheck = checkGroups.find(group => {
      const details = checkDetails[group.paymentGroupKey]
      return !details?.bank_name.trim() || !details.check_number.trim() || !details.check_date
    })
    if (missingCheck) {
      setBulkError('Completa banco, número y fecha para cada grupo de cheques seleccionado.')
      return
    }
    setIsBulkSaving(true)
    setBulkError(null)
    try {
      const rows = selectedQuickRows.map(invoice => {
        const result = quickResults[invoice.settlement_item_id] ?? quickResultFor(invoice)
        if (!result) throw new Error('Hay facturas seleccionadas con forma de pago \'Al día\' que requieren indicar cómo fueron pagadas.')
        const paymentGroupKey = quickPaymentGroupKey(invoice, result)
        return {
          settlement_item_id: invoice.settlement_item_id,
          result,
          amount: quickAmount(invoice),
          payment_group_key: paymentGroupKey,
          metadata: result === 'CHECK' ? checkDetails[paymentGroupKey] : undefined,
        }
      })
      const response = await recordRouteSettlementBulk(summary.id, bulkIdempotencyKey ?? crypto.randomUUID(), rows)
      if (response.error) throw new Error(response.error)
      setBulkConfirmationOpen(false)
      setBulkIdempotencyKey(null)
      setSelectedQuickInvoices([])
      await onPaymentSaved()
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : 'No se pudo grabar la rendición.')
    } finally {
      setIsBulkSaving(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col animate-in fade-in duration-200">
      <header className="shrink-0 border-b border-theme-border bg-theme-surface px-4 py-2 lg:px-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              aria-label="Volver a la bandeja"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold leading-tight text-theme-text sm:text-lg">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">Guía de Ruta </span>
                <span>{summary.route_guide_number}</span>
                <span className="font-normal text-theme-text-muted"> · {formatDate(summary.guide_date)} · </span>
                <span className="text-sm font-semibold text-theme-text">Rendición {summary.settlement_number}</span>
              </h1>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-4 text-left">
            <SummaryValue label="Clientes" value={summary.customer_count} />
            <SummaryValue label="Facturas" value={summary.invoice_count} />
            <SummaryValue label="Total esperado" value={displayAmount(summary.total_expected)} emphasized />
          </div>
          <div className="ml-auto shrink-0 text-xs">
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
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
         <div className="mx-auto max-w-6xl">
           <SettlementSummary detail={detail} isClosed={isClosed} />
           {quickInvoices.length > 0 && <QuickPreparationSummary expected={quickExpectedAmounts} prepared={quickTotals} expectedTotal={quickExpectedTotal} preparedTotal={quickPreparedTotal} routeExpenses={Number(summary.total_route_expenses) || 0} />}
           <div className="relative mb-3 max-w-md">
             <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted" />
             <input type="search" value={quickSearch} onChange={event => setQuickSearch(event.target.value)} placeholder="Buscar cliente, RUT o factura…" aria-label="Buscar cliente, RUT o factura" className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-9 text-xs text-theme-text outline-none transition-colors placeholder:text-theme-text-muted focus:border-theme-accent" />
             {quickSearch && <button type="button" onClick={() => setQuickSearch('')} aria-label="Limpiar búsqueda" className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"><X className="h-3.5 w-3.5" /></button>}
           </div>
           <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
             <div>
               <h2 className="text-sm font-bold text-theme-text">Clientes de la rendición</h2>
               <p className="mt-0.5 text-xs text-theme-text-muted">Prepara las facturas directamente en la mesa. Marcar no produce efectos hasta grabar.</p>
             </div>
              <div className="flex shrink-0 flex-col items-end gap-1 sm:justify-end">
                {canModify && <button type="button" onClick={() => {
                  const missingAlDia = selectedQuickRows.some(invoice => invoice.expected_payment_method === 'AL_DIA' && !(quickResults[invoice.settlement_item_id] ?? quickResultFor(invoice)))
                  if (missingAlDia) {
                    setBulkError('Hay facturas seleccionadas con forma de pago \'Al día\' que requieren indicar cómo fueron pagadas.')
                    return
                  }
                  setBulkError(null); setBulkIdempotencyKey(crypto.randomUUID()); setBulkConfirmationOpen(true)
                }} disabled={selectedQuickRows.length === 0 || isBulkSaving} className="rounded-lg bg-theme-accent px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45">Grabar seleccionadas ({selectedQuickRows.length})</button>}
                {bulkError && <p role="alert" className="max-w-sm text-right text-[11px] font-semibold text-red-600 dark:text-red-400">{bulkError}</p>}
              </div>
           </div>

           <div className="overflow-x-auto rounded-lg border border-theme-border bg-theme-surface">
             <table className="w-full min-w-[780px] border-collapse text-left text-xs">
               <tbody>
                 {filteredClients.map(client => {
                   const clientKey = client.invoices[0]?.settlement_item_id ?? `${client.customer_bsale_id ?? 'unknown'}-${client.customer_name}`
                   const eligibleCount = client.invoices.filter(quickEligible).length
                   const selectedCount = client.invoices.filter(invoice => quickEligible(invoice) && selectedQuickInvoices.includes(invoice.settlement_item_id)).length
                   return <Fragment key={clientKey}>
                     <tr className="border-t-2 border-theme-border bg-theme-text/[0.045] transition-colors first:border-t-0 hover:bg-theme-text/[0.06]">
                       <td className="w-12 px-2 py-2 text-center"><ClientSelectionCheckbox eligibleCount={eligibleCount} selectedCount={selectedCount} onChange={checked => toggleClientInvoices(client, checked)} /></td>
                       <td className="px-3 py-2">
                         <div className="truncate font-bold text-theme-text" title={client.customer_name}>{client.customer_name}</div>
                         {client.rut && <div className="truncate text-[10px] leading-3.5 text-theme-text-muted">{client.rut}</div>}
                       </td>
                       <td className="w-36 whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums text-theme-text"><span className="mr-1 text-[10px] font-medium uppercase tracking-wide text-theme-text-muted">Total</span>{displayAmount(client.expected_amount)}</td>
                      <td className="w-20 px-3 py-2 text-right"><button type="button" onClick={() => { setPendingFlowActive(false); setSelectedClientKey(clientUiKey(client)) }} className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text">Ver <ChevronRight className="h-3 w-3" /></button></td>
                     </tr>
                     <tr className="border-b border-theme-border"><td colSpan={4} className="bg-theme-text/[0.02] px-3 py-1.5"><QuickInvoiceRows client={client} selectedIds={selectedQuickInvoices} results={quickResults} onToggle={toggleQuickInvoice} onResultChange={(id, result) => setQuickResults(current => ({ ...current, [id]: result }))} /></td></tr>
                   </Fragment>
                 })}
                 {filteredClients.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-xs text-theme-text-muted">No se encontraron clientes ni facturas para “{quickSearch.trim()}”.</td></tr>}
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

      {bulkConfirmationOpen && (
        <Dialog open onOpenChange={open => !open && !isBulkSaving && setBulkConfirmationOpen(false)}>
          <DialogContent className="border-theme-border bg-theme-surface text-theme-text sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Confirmar grabación</DialogTitle>
              <DialogDescription>Hasta confirmar no se crearán Payments, allocations ni resoluciones.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-lg border border-theme-border bg-theme-text/[0.03] p-3 text-sm">
                <p className="font-bold">Facturas a grabar: {selectedQuickRows.length}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-theme-text-muted">
                  {(['CASH', 'CHECK', 'TRANSFER', 'CREDIT'] as QuickResult[]).map(result => result === 'CHECK'
                    ? <span key={result}>Cheque: {quickTotals.CHECK.count} {quickTotals.CHECK.count === 1 ? 'factura' : 'facturas'} · {checkGroups.length} {checkGroups.length === 1 ? 'cheque' : 'cheques'} · {displayAmount(quickTotals.CHECK.amount)}</span>
                    : <span key={result}>{quickResultLabels[result]}: {quickTotals[result].count} · {displayAmount(quickTotals[result].amount)}</span>)}
                </div>
              </div>
              {quickTotals.CHECK.count > 0 && <div className="space-y-3 rounded-lg border border-theme-border p-3">
                <p className="text-sm font-bold">Datos de cheque</p>
                {checkGroups.map((group, index) => {
                  const details = checkDetails[group.paymentGroupKey] ?? { bank_name: '', check_number: '', check_date: '' }
                  return <div key={group.paymentGroupKey} className={index === 0 ? '' : 'border-t border-theme-border/70 pt-3'}>
                    <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-theme-text">{group.customerName}</p>
                        {group.rut && <p className="text-[10px] text-theme-text-muted">RUT {group.rut}</p>}
                        <p className="mt-0.5 text-[11px] text-theme-text-muted">Facturas {group.invoices.map(invoice => invoice.invoice_number).join(', ')} · {group.invoices.length} {group.invoices.length === 1 ? 'factura' : 'facturas'}</p>
                      </div>
                      <p className="shrink-0 text-xs font-bold tabular-nums text-theme-text">Cheque: {displayAmount(group.amount)}</p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <input aria-label={`Banco cheque de ${group.customerName}`} placeholder="Banco" value={details.bank_name} onChange={event => setCheckDetails(current => ({ ...current, [group.paymentGroupKey]: { ...details, bank_name: event.target.value } }))} className="rounded border border-theme-border bg-theme-surface px-2 py-1.5 text-xs text-theme-text" />
                      <input aria-label={`Número de cheque de ${group.customerName}`} placeholder="Nº cheque" value={details.check_number} onChange={event => setCheckDetails(current => ({ ...current, [group.paymentGroupKey]: { ...details, check_number: event.target.value } }))} className="rounded border border-theme-border bg-theme-surface px-2 py-1.5 text-xs text-theme-text" />
                      <input aria-label={`Fecha de cheque de ${group.customerName}`} type="date" value={details.check_date} onChange={event => setCheckDetails(current => ({ ...current, [group.paymentGroupKey]: { ...details, check_date: event.target.value } }))} className="rounded border border-theme-border bg-theme-surface px-2 py-1.5 text-xs text-theme-text" />
                    </div>
                  </div>
                })}
              </div>}
              {bulkError && <p className="text-xs font-semibold text-red-600 dark:text-red-400">{bulkError}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => { setBulkConfirmationOpen(false); setBulkIdempotencyKey(null) }} disabled={isBulkSaving} className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold">Cancelar</button>
                <button type="button" onClick={saveQuickRows} disabled={isBulkSaving} className="rounded-lg bg-theme-accent px-3 py-2 text-xs font-bold text-white disabled:opacity-45">{isBulkSaving ? 'Grabando...' : 'Confirmar y grabar'}</button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <Sheet open={selectedClient !== null} onOpenChange={open => !open && setSelectedClientKey(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto border-theme-border bg-theme-surface sm:max-w-3xl lg:max-w-5xl">
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
                   setSelectedClientKey(null)
                  await onPaymentSaved()
                  setBlockingDialogOpen(true)
                  return
                }
                await onPaymentSaved()
              }}
              onPendingFlowExit={() => {
                if (!pendingFlowActive) return
                setPendingInvoiceId(null)
                 setSelectedClientKey(null)
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
             const client = uiClients.find(item => item.customer_bsale_id === customerId)
             setSelectedClientKey(client ? clientUiKey(client) : null)
          }}
        />
      )}

      {!isClosed && canCloseSettlement && summary.can_close && (
        <RouteSettlementCloseDialog
          detail={detail}
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

function QuickPreparationSummary({
  expected,
  prepared,
  expectedTotal,
  preparedTotal,
  routeExpenses,
}: {
  expected: Record<QuickResult, number>
  prepared: Record<QuickResult, { count: number; amount: number }>
  expectedTotal: number
  preparedTotal: number
  routeExpenses: number
}) {
  const incomplete = preparedTotal < expectedTotal
  const estimatedCashToDeliver = prepared.CASH.amount - routeExpenses

  return (
    <section className="mb-4 rounded-lg border border-theme-border bg-theme-surface px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xs font-bold text-theme-text">Preparación actual</h2>
          <p className="mt-0.5 text-[10px] text-theme-text-muted">Proyección local según las facturas seleccionadas y su Resultado.</p>
        </div>
        <div className={`shrink-0 text-left sm:text-right ${incomplete ? 'text-amber-700 dark:text-amber-300' : 'text-theme-text'}`}>
          <p className="text-[9px] font-bold uppercase tracking-wide">Total preparado</p>
          <p className="text-sm font-bold tabular-nums">{displayAmount(preparedTotal)}</p>
          {incomplete && <p className="text-[10px] font-medium">{displayAmount(expectedTotal - preparedTotal)} sin preparar</p>}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-[minmax(6.5rem,1fr)_repeat(3,minmax(5rem,auto))] items-center gap-x-3 gap-y-1 border-t border-theme-border/70 pt-2 text-[11px]">
        <span />
        <span className="text-right text-[9px] font-bold uppercase tracking-wide text-theme-text-muted">Esperado</span>
        <span className="text-right text-[9px] font-bold uppercase tracking-wide text-theme-text-muted">Preparado</span>
        <span className="text-right text-[9px] font-bold uppercase tracking-wide text-theme-text-muted">Diferencia</span>
        {(['CASH', 'CHECK', 'TRANSFER', 'CREDIT'] as QuickResult[]).map(result => {
          const difference = prepared[result].amount - expected[result]
          return <Fragment key={result}>
            <span className="font-semibold text-theme-text-muted">{quickResultLabels[result]}</span>
            <span className="text-right tabular-nums text-theme-text">{displayAmount(expected[result])}</span>
            <span className="text-right font-semibold tabular-nums text-theme-text">{displayAmount(prepared[result].amount)}</span>
            <span className={`text-right font-semibold tabular-nums ${difference === 0 ? 'text-theme-text-muted' : difference > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>{formatSignedAmount(difference)}</span>
          </Fragment>
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-theme-border/70 pt-2 text-[11px]">
        <span className="text-theme-text-muted">Gastos registrados: <strong className="tabular-nums text-theme-text">{displayAmount(routeExpenses)}</strong></span>
        <span className="font-semibold text-theme-text">Efectivo estimado a entregar: <strong className="tabular-nums">{displayAmount(estimatedCashToDeliver)}</strong></span>
      </div>
    </section>
  )
}

function SettlementSummary({ detail, isClosed }: { detail: RouteSettlementDetail; isClosed: boolean }) {
  const summary = detail.settlement
  const invoices = detail.clients.flatMap(client => client.invoices)
  const activeConfirmedPayments = detail.clients.flatMap(client => client.payments).filter(payment => !payment.voided_at && payment.verification_status === 'CONFIRMED')
  const transferPendingInvoiceIds = new Set(detail.clients.flatMap(client => client.payments)
    .filter(payment => !payment.voided_at && payment.payment_method_received === 'TRANSFER' && payment.verification_status === 'PENDING')
    .flatMap(payment => payment.allocations.filter(allocation => !allocation.voided_at).map(allocation => allocation.settlement_item_id)))
  const totalExpected = invoices.reduce((total, invoice) => total + Number(invoice.expected_amount || 0), 0)
  const totalApplied = invoices.reduce((total, invoice) => total + Number(invoice.applied_amount || 0), 0)
  const totalReceived = activeConfirmedPayments.reduce((total, payment) => total + Number(payment.amount_received || 0), 0)
  const balanceToCover = Math.max(totalExpected - totalApplied, 0)
  const paymentMethods = {
    CASH: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'CASH').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
    TRANSFER: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'TRANSFER').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
    CHECK: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'CHECK').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
  }
  const expectedMethods = {
    CASH: invoices.filter(invoice => invoice.expected_payment_method === 'CASH').reduce((total, invoice) => total + Number(invoice.expected_amount || 0), 0),
    CHECK: invoices.filter(invoice => invoice.expected_payment_method === 'CHECK').reduce((total, invoice) => total + Number(invoice.expected_amount || 0), 0),
    TRANSFER: invoices.filter(invoice => invoice.expected_payment_method === 'TRANSFER').reduce((total, invoice) => total + Number(invoice.expected_amount || 0), 0),
    CREDIT: invoices.filter(invoice => invoice.expected_payment_method === 'CREDIT').reduce((total, invoice) => total + Number(invoice.expected_amount || 0), 0),
  }
  const resolvedMethods = {
    ...paymentMethods,
    CREDIT: invoices.filter(invoice => invoice.resolution_type === 'CREDIT').reduce((total, invoice) => total + Number(invoice.unapplied_amount || 0), 0),
  }
  const situations = invoices.reduce((counts, invoice) => {
    if (invoice.invoice_result === 'TRANSFER_PENDING_REVIEW' || transferPendingInvoiceIds.has(invoice.settlement_item_id)) counts.transferReview += 1
    else if (invoice.invoice_result === 'PAID') counts.paid += 1
    else if (invoice.invoice_result === 'PENDING_PAYMENT') counts.pending += 1
    else if (invoice.invoice_result === 'CREDIT') counts.credit += 1
    else if (invoice.invoice_result === 'NOT_DELIVERED') counts.notDelivered += 1
    else if (invoice.invoice_result === 'REVIEW_REQUIRED') counts.review += 1
    return counts
  }, { paid: 0, transferReview: 0, pending: 0, credit: 0, notDelivered: 0, review: 0 })
  const workflowLabel = isClosed
    ? 'Cerrada'
    : summary.can_close || summary.derived_workflow_status === 'READY_TO_CLOSE'
      ? 'Lista para cerrar'
      : 'En progreso'

  return (
    <section className="mb-4 rounded-xl border border-theme-border bg-theme-surface/70 p-3 lg:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-bold text-theme-text">Resumen de la rendición</h2>
          <p className="mt-0.5 text-[11px] text-theme-text-muted">Estado financiero y operacional actual.</p>
        </div>
        <span className="inline-flex w-fit rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-[10px] font-semibold text-theme-text">{workflowLabel}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SummaryMetric label="Total esperado" value={displayAmount(totalExpected)} />
        <SummaryMetric label="Total recibido" value={displayAmount(totalReceived)} />
        <SummaryMetric label="Sin aplicar" value={displayAmount(balanceToCover)} />
        <SummaryMetric label="Gastos de ruta" value={displayAmount(Number(summary.total_route_expenses) || 0)} />
      </div>

      <div className="mt-3 border-t border-theme-border/70 pt-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Comparación de medios</p>
          <p className="text-[10px] text-theme-text-muted">Esperado · Real · Diferencia</p>
        </div>
        <div className="mt-1.5 grid grid-cols-[minmax(6.5rem,1fr)_repeat(3,minmax(4.5rem,auto))] items-center gap-x-2 gap-y-1 text-[11px]">
          <span />
          <span className="text-right font-semibold text-theme-text-muted">Esperado</span>
          <span className="text-right font-semibold text-theme-text-muted">Real</span>
          <span className="text-right font-semibold text-theme-text-muted">Dif.</span>
          {(['CASH', 'CHECK', 'TRANSFER', 'CREDIT'] as const).map(method => (
            <MethodComparisonRow
              key={method}
              label={method === 'CASH' ? 'Efectivo' : method === 'CHECK' ? 'Cheques' : method === 'TRANSFER' ? 'Transferencia' : 'Crédito'}
              expected={expectedMethods[method]}
              real={resolvedMethods[method]}
            />
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2 border-t border-theme-border/70 pt-2.5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Estado operacional</p>
          <div className="mt-1 text-xs text-theme-text-muted">
            <p><strong className="text-theme-text">{summary.resolved_invoice_count} de {summary.invoice_count} facturas resueltas</strong></p>
            <p className="mt-0.5">{summary.unresolved_invoice_count} por resolver <span className="mx-1">·</span> {summary.review_required_count} en revisión</p>
          </div>
        </div>
        <div className="mt-2 border-t border-theme-border/70 pt-2 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Situaciones</p>
           <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px]">
             <SituationBadge label="Pagadas" value={situations.paid} />
             <SituationBadge label="Transferencias por revisar" value={situations.transferReview} info />
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
  return <div className="rounded-lg border border-theme-border bg-theme-surface px-2.5 py-1.5"><p className="text-[9px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-0.5 text-sm font-bold tabular-nums text-theme-text">{value}</p></div>
}

function formatSignedAmount(value: number) {
  if (value === 0) return '$0'
  const formatted = formatCurrency(Math.abs(value))
  return value > 0 ? `+${formatted}` : `-${formatted}`
}

function MethodComparisonRow({ label, expected, real }: { label: string; expected: number; real: number }) {
  const difference = real - expected
  return (
    <>
      <span className="rounded-md bg-theme-text/[0.03] px-2 py-1 font-semibold text-theme-text-muted">{label}</span>
      <span className="text-right tabular-nums text-theme-text">{displayAmount(expected)}</span>
      <span className="text-right tabular-nums text-theme-text">{displayAmount(real)}</span>
      <span className={`text-right font-semibold tabular-nums ${difference === 0 ? 'text-theme-text-muted' : difference > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>{formatSignedAmount(difference)}</span>
    </>
  )
}

function SituationBadge({ label, value, warning = false, info = false }: { label: string; value: number; warning?: boolean; info?: boolean }) {
  const className = warning
    ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300'
    : info
      ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300'
      : 'border-theme-border bg-theme-text/[0.03] text-theme-text-muted'
  return <span className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${className}`}>{label} {value}</span>
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
  const [selectedTransferIds, setSelectedTransferIds] = useState<string[]>([])
  const [isMarkingTransfers, setIsMarkingTransfers] = useState(false)
  const [transferError, setTransferError] = useState<string | null>(null)
  const targetedInvoice = openInvoiceId
    ? client.invoices.find(item => item.settlement_item_id === openInvoiceId) ?? null
    : null
  const activeInvoice = selectedInvoice ?? targetedInvoice
  const eligibleTransferInvoices = client.invoices.filter(invoice =>
    invoice.expected_payment_method === 'TRANSFER' && invoice.unapplied_amount > 0 &&
    invoice.resolution_type === null && !client.payments.some(payment =>
      payment.verification_status === 'CONFIRMED' && !payment.voided_at &&
      payment.allocations.some(allocation => allocation.settlement_item_id === invoice.settlement_item_id && !allocation.voided_at),
    ),
  )

  async function markTransfersForReview() {
    if (client.customer_bsale_id === null || selectedTransferIds.length === 0) return
    setIsMarkingTransfers(true)
    setTransferError(null)
    const result = await markRouteSettlementTransferReview(settlementId, client.customer_bsale_id, selectedTransferIds)
    if (result.error) setTransferError(result.error)
    else setSelectedTransferIds([])
    setIsMarkingTransfers(false)
    if (!result.error) await onPaymentSaved()
  }

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
           {client.customer_bsale_id !== null ? <span>Cliente Bsale {client.customer_bsale_id}</span> : <span>Cliente sin ID Bsale</span>}
          <span>{client.invoice_count} {client.invoice_count === 1 ? 'factura' : 'facturas'}</span>
        </SheetDescription>
        <div className="mt-3 flex items-center gap-5 text-xs">
          <SummaryValue label="Esperado" value={displayAmount(client.expected_amount)} emphasized />
          <SummaryValue label="Recibido nuevo" value={displayAmount(client.applied_amount)} />
          <SummaryValue label="Sin aplicar" value={displayAmount(client.pending_amount)} />
        </div>
        {canUpdateSettlement && eligibleTransferInvoices.length > 0 && (
          <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900/50 dark:bg-blue-950/20">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-theme-text">Transferencias por revisar</p>
              <button type="button" onClick={markTransfersForReview} disabled={isMarkingTransfers || selectedTransferIds.length === 0} className="inline-flex h-8 items-center rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white disabled:opacity-45">
                {isMarkingTransfers ? 'Guardando...' : `Marcar seleccionadas (${selectedTransferIds.length})`}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {eligibleTransferInvoices.map(invoice => (
                <label key={invoice.settlement_item_id} className="inline-flex items-center gap-1.5 text-xs text-theme-text">
                  <input type="checkbox" checked={selectedTransferIds.includes(invoice.settlement_item_id)} onChange={event => setSelectedTransferIds(current => event.target.checked ? [...current, invoice.settlement_item_id] : current.filter(id => id !== invoice.settlement_item_id))} />
                  {invoice.invoice_number}
                </label>
              ))}
            </div>
            {transferError && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{transferError}</p>}
          </div>
        )}
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
            <table className="w-full min-w-[960px] table-fixed text-xs">
              <colgroup>
                <col className="w-[15%]" />
                <col className="w-[14%]" />
                <col className="w-[18%]" />
                <col className="w-[13%]" />
                <col className="w-[18%]" />
                <col className="w-[14%]" />
                <col className="w-[8%]" />
              </colgroup>
              <thead className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Factura</th>
                   <th className="px-3 py-2 text-right">Monto esperado</th>
                    <th className="min-w-[150px] px-3 py-2 text-left">Medio esperado</th>
                   <th className="px-3 py-2 text-right">Aplicado</th>
                    <th className="min-w-[150px] px-3 py-2 text-left">Payment real</th>
                   <th className="min-w-[120px] px-3 py-2 pr-4 text-left">Situación</th>
                   <th className="min-w-[85px] border-l border-theme-border/60 px-3 py-2 pl-4 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border/70">
                {client.invoices.map(invoice => (
                  <tr key={invoice.settlement_item_id}>
                    <td className="px-3 py-2.5 font-semibold text-theme-text">{invoice.invoice_number}</td>
                   <td className="px-3 py-2.5 text-right tabular-nums text-theme-text">{displayAmount(invoice.expected_amount)}</td>
                    <td className="min-w-[150px] px-3 py-2.5 text-left text-theme-text-muted">{paymentMethodLabel(invoice.expected_payment_method)}{invoice.expected_payment_method_original && invoice.expected_payment_method_original !== invoice.expected_payment_method ? <span className="block text-[10px]">({invoice.expected_payment_method_original})</span> : null}</td>
                   <td className="px-3 py-2.5 text-right tabular-nums text-theme-text">{displayAmount(invoice.applied_amount)}</td>
                    <td className="min-w-[150px] px-3 py-2.5 text-left text-theme-text-muted">{invoiceReceivedMethods(invoice, client.payments)}</td>
                     <td className="min-w-[120px] whitespace-normal px-3 py-2.5 pr-4">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${invoiceSituationClass(invoice)}`}>
                        {invoiceSituationLabel(invoice)}
                      </span>
                    </td>
                    <td className="min-w-[85px] border-l border-theme-border/60 px-3 py-2.5 pl-4 text-right">
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
                         {displayAmount(payment.amount_received)} · {payment.allocations.length} {payment.allocations.length === 1 ? 'factura' : 'facturas'} · {payment.voided_at ? 'Anulado' : payment.verification_status === 'PENDING' ? 'Por revisar' : payment.verification_status === 'REJECTED' ? 'Rechazado' : 'Confirmado'}
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
