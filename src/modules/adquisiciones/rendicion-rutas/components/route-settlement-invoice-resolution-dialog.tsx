'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Eye, Trash2 } from 'lucide-react'
import {
  setRouteSettlementItemResolution,
  type RouteSettlementDetailInvoice,
  type RouteSettlementDetailPayment,
  type RouteSettlementResolutionType,
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
import { formatCurrency, formatExpectedPaymentMethod } from '../utils/route-settlement-formatters'

const RESOLUTION_OPTIONS: Array<{ value: RouteSettlementResolutionType; label: string }> = [
  { value: 'PENDING_PAYMENT', label: 'Pago pendiente' },
  { value: 'CREDIT', label: 'Crédito' },
  { value: 'NOT_DELIVERED', label: 'No entregada' },
  { value: 'REVIEW_REQUIRED', label: 'Requiere revisión' },
]

export function RouteSettlementInvoiceResolutionDialog({
  invoice,
  payments,
  open,
  canUpdateSettlement,
  onOpenChange,
  onSaved,
}: {
  invoice: RouteSettlementDetailInvoice | null
  payments: RouteSettlementDetailPayment[]
  open: boolean
  canUpdateSettlement: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  if (!invoice) return null

  return (
    <InvoiceResolutionForm
      key={`${invoice.settlement_item_id}-${invoice.resolution_type ?? 'none'}-${invoice.resolution_notes ?? ''}`}
      invoice={invoice}
      payments={payments}
      open={open}
      canUpdateSettlement={canUpdateSettlement}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />
  )
}

function InvoiceResolutionForm({
  invoice,
  payments,
  open,
  canUpdateSettlement,
  onOpenChange,
  onSaved,
}: {
  invoice: RouteSettlementDetailInvoice
  payments: RouteSettlementDetailPayment[]
  open: boolean
  canUpdateSettlement: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [resolutionType, setResolutionType] = useState<RouteSettlementResolutionType>(invoice.resolution_type ?? 'PENDING_PAYMENT')
  const [notes, setNotes] = useState(invoice.resolution_notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [manualOverride, setManualOverride] = useState(false)
  const hasAppliedAmount = invoice.applied_amount > 0
  const requiresNotes = resolutionType === 'NOT_DELIVERED' || resolutionType === 'REVIEW_REQUIRED'
  const coveredBy = payments.filter(payment =>
    !payment.voided_at && payment.allocations.some(allocation => allocation.settlement_item_id === invoice.settlement_item_id)
  )

  async function save() {
    if (requiresNotes && !notes.trim()) {
      setError('Debes ingresar un motivo.')
      return
    }
    setIsSaving(true)
    setError(null)
    const result = await setRouteSettlementItemResolution(invoice.settlement_item_id, resolutionType, notes)
    if (result.error) {
      setError(result.error)
      setIsSaving(false)
      return
    }
    onOpenChange(false)
    setIsSaving(false)
    await onSaved()
  }

  async function clear() {
    if (!window.confirm(`¿Quitar la situación de la factura ${invoice.invoice_number}?`)) return
    setIsSaving(true)
    setError(null)
    const result = await setRouteSettlementItemResolution(invoice.settlement_item_id, null, null)
    if (result.error) {
      setError(result.error)
      setIsSaving(false)
      return
    }
    onOpenChange(false)
    setIsSaving(false)
    await onSaved()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-theme-border bg-theme-surface text-theme-text">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-theme-text">
            <Eye className="h-4 w-4 text-theme-text-muted" />
            Detalle de factura
          </DialogTitle>
          <DialogDescription className="text-theme-text-muted">
            Factura {invoice.invoice_number} · Saldo pendiente: {formatCurrency(Number(invoice.unapplied_amount) || 0)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-theme-border px-3 py-3">
            <DetailValue label="Monto esperado" value={formatCurrency(Number(invoice.expected_amount) || 0)} />
            <DetailValue label="Aplicado" value={formatCurrency(Number(invoice.applied_amount) || 0)} />
            <DetailValue label="Medio esperado" value={formatExpectedPaymentMethod(invoice.expected_payment_method)} />
            <DetailValue label="Estado" value={invoice.invoice_result === 'PAID' ? 'Pagada' : invoice.invoice_result === 'PARTIAL' ? 'Parcial' : 'Pendiente'} />
          </div>

          {coveredBy.length > 0 && (
            <section>
              <h3 className="mb-2 font-semibold text-theme-text">Payments que la cubren</h3>
              <div className="space-y-1.5 rounded-lg border border-theme-border px-3 py-2 text-theme-text-muted">
                {coveredBy.map(payment => {
                  const applied = payment.allocations.find(allocation => allocation.settlement_item_id === invoice.settlement_item_id)?.amount_applied ?? 0
                  return <div key={payment.id} className="flex justify-between gap-3"><span>{paymentMethodLabel(payment.payment_method_received)}</span><span className="font-semibold tabular-nums text-theme-text">{formatCurrency(Number(applied) || 0)}</span></div>
                })}
              </div>
            </section>
          )}

          <section className="space-y-3 border-t border-theme-border pt-4">
            <div>
              <p className="mb-1.5 font-semibold text-theme-text">Situación del saldo</p>
              {invoice.applied_amount >= invoice.expected_amount ? (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Pagada</div>
              ) : invoice.resolution_source === 'DERIVED' && !manualOverride && canUpdateSettlement ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-300">
                  Pago pendiente derivado automáticamente del saldo: <span className="font-semibold">{formatCurrency(Number(invoice.unapplied_amount) || 0)}</span>.
                  Puedes registrar otro pago o editar el Payment existente. Si corresponde una decisión operacional distinta, puedes indicarla explícitamente.
                  <button type="button" onClick={() => setManualOverride(true)} className="mt-2 block font-semibold underline underline-offset-2">Indicar situación manual</button>
                </div>
              ) : !canUpdateSettlement ? (
                <p className="text-theme-text-muted">No tienes permisos para modificar esta rendición.</p>
              ) : (
                <>
                  <select
                    value={resolutionType}
                    onChange={event => { setResolutionType(event.target.value as RouteSettlementResolutionType); setError(null) }}
                    className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm outline-none focus:border-theme-accent"
                    disabled={isSaving}
                  >
                    {RESOLUTION_OPTIONS.map(option => (
                      <option key={option.value} value={option.value} disabled={option.value === 'NOT_DELIVERED' && hasAppliedAmount}>
                        {option.label}{option.value === 'NOT_DELIVERED' && hasAppliedAmount ? ' (requiere pago cero)' : ''}
                      </option>
                    ))}
                  </select>
                  {resolutionType === 'NOT_DELIVERED' && hasAppliedAmount && <p className="mt-1.5 text-amber-700 dark:text-amber-300">No entregada no está disponible porque ya existe un pago aplicado.</p>}
                  <label className="mt-3 block font-semibold text-theme-text">
                    Observación{requiresNotes && <span className="text-red-600"> *</span>}
                    <textarea value={notes} onChange={event => { setNotes(event.target.value); setError(null) }} rows={3} className="mt-1.5 w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm font-normal outline-none focus:border-theme-accent" disabled={isSaving} />
                  </label>
                </>
              )}
            </div>
            {invoice.resolution_type && <p className="border-l-2 border-theme-accent px-3 py-1 text-theme-text-muted">Situación actual: <span className="font-semibold text-theme-text">{resolutionLabel(invoice.resolution_type)}</span></p>}
          </section>
        </div>

        {error && <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}
        <DialogFooter className="border-theme-border bg-theme-text/[0.02]">
          {canUpdateSettlement && invoice.resolution_type && <Button type="button" variant="ghost" onClick={clear} disabled={isSaving}><Trash2 className="h-3.5 w-3.5" /> Quitar situación</Button>}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>Cancelar</Button>
          {canUpdateSettlement && invoice.applied_amount < invoice.expected_amount && <Button type="button" onClick={save} disabled={isSaving}>{isSaving ? 'Guardando...' : invoice.resolution_type ? 'Guardar cambio' : 'Guardar situación'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function resolutionLabel(type: RouteSettlementResolutionType) {
  return RESOLUTION_OPTIONS.find(option => option.value === type)?.label ?? type
}

function paymentMethodLabel(method: string) {
  if (method === 'CASH') return 'Efectivo'
  if (method === 'CHECK') return 'Cheque'
  if (method === 'TRANSFER') return 'Transferencia'
  return method
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-0.5 text-theme-text">{value}</p></div>
}
