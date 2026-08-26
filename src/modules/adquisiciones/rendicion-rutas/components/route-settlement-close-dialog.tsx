'use client'

import { useState } from 'react'
import { AlertTriangle, LockKeyhole } from 'lucide-react'
import { closeRouteSettlement, type RouteSettlementDetail, type RouteSettlementDetailExpense } from '@/app/actions/adquisiciones/rendicion-rutas'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatCurrency } from '../utils/route-settlement-formatters'

export function RouteSettlementCloseDialog({
  detail,
  open,
  onOpenChange,
  onClosed,
}: {
  detail: RouteSettlementDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onClosed: () => Promise<void>
}) {
  const [isClosing, setIsClosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { settlement } = detail
  const invoices = detail.clients.flatMap(client => client.invoices)
  const activeConfirmedPayments = detail.clients
    .flatMap(client => client.payments)
    .filter(payment => !payment.voided_at && payment.verification_status === 'CONFIRMED')
  const activeExpenses = detail.expenses.filter(expense => expense.status === 'ACTIVE')
  const totalReceived = activeConfirmedPayments.reduce((total, payment) => total + Number(payment.amount_received || 0), 0)
  const totalUnapplied = invoices.reduce((total, invoice) => total + Number(invoice.unapplied_amount || 0), 0)
  const paymentMethods = {
    CASH: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'CASH').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
    TRANSFER: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'TRANSFER').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
    CHECK: activeConfirmedPayments.filter(payment => payment.payment_method_received === 'CHECK').reduce((total, payment) => total + Number(payment.amount_received || 0), 0),
  }
  const totalExpenses = activeExpenses.reduce((total, expense) => total + Number(expense.amount || 0), 0)
  const isComplete = settlement.can_close && settlement.resolved_invoice_count === settlement.invoice_count

  async function handleClose() {
    setIsClosing(true)
    setError(null)
    const result = await closeRouteSettlement(settlement.id)
    if (result.error) {
      setError(result.error)
      setIsClosing(false)
      return
    }
    onOpenChange(false)
    setIsClosing(false)
    await onClosed()
  }

  return (
    <Dialog open={open} onOpenChange={openState => { if (!isClosing) onOpenChange(openState) }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto border-theme-border bg-theme-surface text-theme-text">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-theme-text"><LockKeyhole className="h-4 w-4 text-theme-text-muted" />Cerrar rendición</DialogTitle>
          <DialogDescription className="text-theme-text-muted">{settlement.settlement_number}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-theme-border px-3 py-3 sm:grid-cols-4">
            <Metric label="Facturas totales" value={settlement.invoice_count} />
            <Metric label="Resueltas" value={`${settlement.resolved_invoice_count} / ${settlement.invoice_count}`} />
            <Metric label="Por resolver" value={settlement.unresolved_invoice_count} />
            <Metric label="En revisión" value={settlement.review_required_count} />
            <Metric label="Pagadas" value={settlement.paid_count} />
            <Metric label="Pago pendiente" value={settlement.pending_payment_count} />
            <Metric label="Crédito" value={settlement.credit_count} />
            <Metric label="No entregadas" value={settlement.not_delivered_count} />
          </div>

          <section className="rounded-lg border border-theme-border px-3 py-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Resumen financiero</p>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Total esperado" value={formatCurrency(Number(settlement.total_expected) || 0)} />
              <Metric label="Total recibido" value={formatCurrency(totalReceived)} />
              <Metric label="Sin aplicar" value={formatCurrency(totalUnapplied)} />
              <Metric label="Gastos de ruta" value={formatCurrency(totalExpenses)} />
            </div>
          </section>

          <section className="rounded-lg border border-theme-border px-3 py-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Medios recibidos</p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <SummaryInline label="Efectivo" value={formatCurrency(paymentMethods.CASH)} />
              <SummaryInline label="Transferencias" value={formatCurrency(paymentMethods.TRANSFER)} />
              <SummaryInline label="Cheques" value={formatCurrency(paymentMethods.CHECK)} />
            </div>
          </section>

          <section className="rounded-lg border border-theme-border px-3 py-3">
            <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Gastos de ruta</p>
            {activeExpenses.length > 0 ? (
              <div className="mt-2 space-y-1 text-xs">
                {activeExpenses.map(expense => (
                  <div key={expense.id} className="flex items-center justify-between gap-3 text-theme-text-muted">
                    <span>{expenseLabel(expense)}</span>
                    <span className="font-semibold tabular-nums text-theme-text">{formatCurrency(Number(expense.amount) || 0)}</span>
                  </div>
                ))}
                <div className="mt-2 flex items-center justify-between gap-3 border-t border-theme-border/70 pt-2 font-bold text-theme-text">
                  <span>Total</span>
                  <span className="tabular-nums">{formatCurrency(totalExpenses)}</span>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-theme-text-muted">No hay gastos de ruta activos.</p>
            )}
          </section>

          <div className="rounded-lg bg-theme-text/[0.03] px-3 py-2">
            <span className="text-theme-text-muted">Estado de la rendición</span>
            <p className="mt-0.5 font-semibold text-theme-text">{isComplete ? 'Completa' : 'Pendiente de completar'}</p>
          </div>
          <p className="leading-5 text-theme-text-muted">Después de cerrar la rendición no podrás registrar, editar o anular pagos, situaciones de facturas ni gastos mediante el flujo normal. La información permanecerá disponible sólo para consulta.</p>
        </div>

        {error && <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}
        <DialogFooter className="border-theme-border bg-theme-text/[0.02]">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isClosing}>Cancelar</Button>
          <Button type="button" onClick={handleClose} disabled={isClosing}>{isClosing ? 'Cerrando...' : 'Cerrar rendición'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-0.5 font-semibold tabular-nums text-theme-text">{value}</p></div>
}

function SummaryInline({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 rounded-lg bg-theme-text/[0.03] px-3 py-2"><span className="text-theme-text-muted">{label}</span><strong className="tabular-nums text-theme-text">{value}</strong></div>
}

function expenseLabel(expense: RouteSettlementDetailExpense) {
  if (expense.expense_type === 'PEAJES') return 'Peajes'
  if (expense.expense_type === 'OTROS') return 'Otros'
  if (expense.expense_type === 'COMBUSTIBLE') return 'Combustible'
  if (expense.expense_type === 'VIATICOS') return 'Viáticos'
  return 'Mantenimiento'
}
