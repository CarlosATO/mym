'use client'

import { useState } from 'react'
import { AlertTriangle, Eye, Pencil, XCircle } from 'lucide-react'
import {
  RouteSettlementDetailPayment,
  voidRouteSettlementPayment,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '../utils/route-settlement-formatters'

interface PaymentDetailDialogProps {
  payment: RouteSettlementDetailPayment | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: () => void
  onVoid: () => void
  canUpdateSettlement: boolean
}

export function RouteSettlementPaymentDetailDialog({ payment, open, onOpenChange, onEdit, onVoid, canUpdateSettlement }: PaymentDetailDialogProps) {
  if (!payment) return null

  const method = payment.payment_method_received === 'CASH'
    ? 'Efectivo'
    : payment.payment_method_received === 'CHECK' ? 'Cheque' : 'Transferencia'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-theme-border bg-theme-surface text-theme-text">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-theme-text">
            <Eye className="h-4 w-4 text-theme-text-muted" /> Detalle del pago
          </DialogTitle>
          <DialogDescription className="text-theme-text-muted">
            {method} · {formatCurrency(payment.amount_received)} · {payment.allocations.length} {payment.allocations.length === 1 ? 'factura' : 'facturas'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg border border-theme-border px-3 py-3">
            <DetailValue label="Medio" value={method} />
            <DetailValue label="Estado" value={payment.voided_at ? 'Anulado' : 'Confirmado'} />
            <DetailValue label="Monto recibido" value={formatCurrency(payment.amount_received)} />
            <DetailValue label="Monto aplicado" value={formatCurrency(payment.amount_applied)} />
            <DetailValue label="Saldo sin aplicar" value={formatCurrency(payment.unallocated_amount)} />
            <DetailValue label="Fecha y hora" value={formatDateTime(payment.received_at)} />
            {payment.reference_number && <DetailValue label="Referencia" value={payment.reference_number} />}
            {payment.check_number && <DetailValue label="Cheque" value={payment.check_number} />}
            {payment.bank_name && <DetailValue label="Banco" value={payment.bank_name} />}
            {payment.check_date && <DetailValue label="Fecha cheque" value={formatDate(payment.check_date)} />}
            {payment.custody_user_id && <DetailValue label="Custodia" value="Registrada" />}
            {payment.void_reason && <DetailValue label="Motivo de anulación" value={payment.void_reason} />}
          </div>

          <section>
            <h3 className="mb-2 font-semibold text-theme-text">Allocations</h3>
            <div className="divide-y divide-theme-border rounded-lg border border-theme-border">
              {payment.allocations.map(allocation => (
                <div key={allocation.allocation_id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="text-theme-text-muted">Factura {allocation.invoice_number}</span>
                  <span className="font-semibold tabular-nums text-theme-text">
                    {formatCurrency(allocation.amount_applied)}{allocation.voided_at && <span className="ml-2 text-[10px] font-normal text-theme-text-muted">Anulada</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {payment.notes && <p className="rounded-lg bg-theme-text/[0.03] px-3 py-2 text-theme-text-muted">{payment.notes}</p>}
        </div>

        <DialogFooter className="border-theme-border bg-theme-text/[0.02]">
          {!payment.voided_at && canUpdateSettlement && (
            <>
              <Button type="button" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Editar</Button>
              <Button type="button" variant="ghost" onClick={onVoid}><XCircle className="h-3.5 w-3.5" /> Anular pago</Button>
            </>
          )}
          {payment.voided_at && <span className="text-xs text-theme-text-muted">Este pago se conserva sólo como historial.</span>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface VoidPaymentDialogProps {
  payment: RouteSettlementDetailPayment | null
  customerName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onVoided: () => Promise<void>
}

export function VoidRouteSettlementPaymentDialog({ payment, customerName, open, onOpenChange, onVoided }: VoidPaymentDialogProps) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  if (!payment) return null
  const paymentId = payment.id

  async function handleVoid() {
    if (!reason.trim()) {
      setError('Ingresa un motivo de anulación.')
      return
    }
    setIsSaving(true)
    setError(null)
    const result = await voidRouteSettlementPayment(paymentId, reason)
    if (result.error) {
      setError(result.error)
      setIsSaving(false)
      return
    }
    onOpenChange(false)
    setReason('')
    setIsSaving(false)
    await onVoided()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-theme-border bg-theme-surface text-theme-text">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-theme-text"><AlertTriangle className="h-4 w-4 text-amber-600" /> Anular pago</DialogTitle>
          <DialogDescription className="text-theme-text-muted">
            {customerName} · {formatCurrency(payment.amount_received)} · {payment.allocations.length} {payment.allocations.length === 1 ? 'factura' : 'facturas'}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs leading-5 text-theme-text-muted">Al anular este pago, dejará de aplicarse a las facturas asociadas. El registro permanecerá en el historial.</p>
        <label className="space-y-1.5 text-xs font-semibold text-theme-text">
          <span>Motivo de anulación <span className="text-red-600">*</span></span>
          <textarea value={reason} onChange={event => { setReason(event.target.value); setError(null) }} rows={3} className="w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm font-normal outline-none focus:border-theme-accent" />
        </label>
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">{error}</p>}
        <DialogFooter className="border-theme-border bg-theme-text/[0.02]">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>Cancelar</Button>
          <Button type="button" variant="destructive" onClick={handleVoid} disabled={isSaving}>{isSaving ? 'Anulando...' : 'Confirmar anulación'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p>
      <p className="mt-0.5 text-theme-text">{value}</p>
    </div>
  )
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}
