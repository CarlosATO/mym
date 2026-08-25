'use client'

import { useMemo, useState } from 'react'
import { RefreshCw, WalletCards } from 'lucide-react'
import {
  registerRouteSettlementPayment,
  RouteSettlementDetailClient,
  RouteSettlementDetailPayment,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '../utils/route-settlement-formatters'

interface RegisterRouteSettlementPaymentDialogProps {
  open: boolean
  settlementId: string
  client: RouteSettlementDetailClient
  payment?: RouteSettlementDetailPayment | null
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}

type PaymentMethod = 'CASH' | 'TRANSFER' | 'CHECK'
const ZERO = BigInt(0)

function digits(value: string) {
  return value.replace(/\D/g, '')
}

function displayDigits(value: string) {
  if (!value) return ''
  return new Intl.NumberFormat('es-CL').format(Number(value))
}

function amountValue(value: number) {
  return BigInt(Math.max(0, Math.round(Number(value) || 0)))
}

function displayBigInt(value: bigint) {
  return formatCurrency(Number(value))
}

function initialAllocationValues(payment: RouteSettlementDetailPayment | null | undefined) {
  return Object.fromEntries(
    (payment?.allocations ?? [])
      .filter(allocation => !allocation.voided_at)
      .map(allocation => [allocation.settlement_item_id, String(Math.round(allocation.amount_applied))])
  )
}

export function RegisterRouteSettlementPaymentDialog({
  open,
  settlementId,
  client,
  payment = null,
  onOpenChange,
  onSaved,
}: RegisterRouteSettlementPaymentDialogProps) {
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(() => (payment?.payment_method_received as PaymentMethod) || 'CASH')
  const [amountReceived, setAmountReceived] = useState(() => payment?.amount_received ? String(Math.round(payment.amount_received)) : '')
  const [allocations, setAllocations] = useState<Record<string, string>>(() => initialAllocationValues(payment))
  const [referenceNumber, setReferenceNumber] = useState(() => payment?.reference_number || '')
  const [bankName, setBankName] = useState(() => payment?.bank_name || '')
  const [checkNumber, setCheckNumber] = useState(() => payment?.check_number || '')
  const [checkDate, setCheckDate] = useState(() => payment?.check_date || '')
  const [notes, setNotes] = useState(() => payment?.notes || '')
  const [manualDistribution, setManualDistribution] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const availableByInvoice = useMemo(
    () => new Map(client.invoices.map(invoice => {
      const otherApplied = client.payments
        .filter(currentPayment => currentPayment.id !== payment?.id && !currentPayment.voided_at)
        .flatMap(currentPayment => currentPayment.allocations)
        .filter(allocation => allocation.settlement_item_id === invoice.settlement_item_id && !allocation.voided_at)
        .reduce((sum, allocation) => sum + BigInt(Math.round(allocation.amount_applied)), ZERO)
      return [invoice.settlement_item_id, amountValue(invoice.expected_amount) - otherApplied] as const
    })),
    [client.invoices, client.payments, payment?.id]
  )
  const receivedAmount = amountReceived ? BigInt(amountReceived) : ZERO
  const appliedAmount = Object.values(allocations).reduce((sum, value) => sum + (value ? BigInt(value) : ZERO), ZERO)
  const unallocatedAmount = receivedAmount > appliedAmount ? receivedAmount - appliedAmount : ZERO

  function resetForm() {
    setPaymentMethod((payment?.payment_method_received as PaymentMethod) || 'CASH')
    setAmountReceived(payment?.amount_received ? String(Math.round(payment.amount_received)) : '')
    setAllocations(initialAllocationValues(payment))
    setReferenceNumber(payment?.reference_number || '')
    setBankName(payment?.bank_name || '')
    setCheckNumber(payment?.check_number || '')
    setCheckDate(payment?.check_date || '')
    setNotes(payment?.notes || '')
    setManualDistribution(false)
    setIsSaving(false)
    setError(null)
  }

  function distribute(value: string) {
    let remaining = value ? BigInt(value) : ZERO
    const next: Record<string, string> = {}

    for (const invoice of client.invoices) {
      const pending = availableByInvoice.get(invoice.settlement_item_id) ?? ZERO
      const applied = remaining > pending ? pending : remaining
      next[invoice.settlement_item_id] = applied.toString()
      remaining -= applied
    }

    setAllocations(next)
  }

  function handleAmountChange(value: string) {
    const nextValue = digits(value)
    setAmountReceived(nextValue)
    if (!manualDistribution) distribute(nextValue)
    setError(null)
  }

  function handleAllocationChange(invoiceId: string, value: string) {
    setManualDistribution(true)
    setAllocations(current => ({ ...current, [invoiceId]: digits(value) }))
    setError(null)
  }

  function validate() {
    if (receivedAmount <= ZERO) return 'Ingresa un monto recibido mayor que cero.'
    if (paymentMethod === 'CHECK' && !checkNumber.trim()) return 'El número de cheque es obligatorio.'
    if (appliedAmount <= ZERO) return 'Aplica un monto a al menos una factura.'
    if (appliedAmount > receivedAmount) return 'El monto aplicado no puede superar el monto recibido.'

    for (const invoice of client.invoices) {
      const applied = allocations[invoice.settlement_item_id] ? BigInt(allocations[invoice.settlement_item_id]) : ZERO
      const pending = availableByInvoice.get(invoice.settlement_item_id) ?? ZERO
      if (applied > pending) return `La factura ${invoice.invoice_number} supera su saldo pendiente.`
    }

    return null
  }

  async function handleSubmit() {
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setIsSaving(true)
    setError(null)
    const result = await registerRouteSettlementPayment({
      settlementId,
      paymentId: payment?.id ?? null,
      customerBsaleId: client.customer_bsale_id as number,
      paymentMethod,
      amountReceived,
      referenceNumber,
      bankName,
      checkNumber,
      checkDate,
      notes,
      allocations: client.invoices
        .map(invoice => ({
          settlementItemId: invoice.settlement_item_id,
          amountApplied: allocations[invoice.settlement_item_id] || '0',
        }))
        .filter(allocation => allocation.amountApplied !== '0'),
    })

    if (result.error) {
      setError(result.error)
      setIsSaving(false)
      return
    }

    onOpenChange(false)
    resetForm()
    await onSaved()
  }

  function handleDialogChange(nextOpen: boolean) {
    if (!nextOpen) resetForm()
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] max-h-[min(90dvh,760px)] overflow-y-auto border-theme-border bg-theme-surface text-theme-text sm:max-w-[880px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-theme-text">
            <WalletCards className="h-4 w-4 text-theme-text-muted" /> {payment ? 'Editar pago' : 'Registrar pago'}
          </DialogTitle>
          <DialogDescription className="text-theme-text-muted">
            Cliente: <span className="font-semibold text-theme-text">{client.customer_name}</span>
            <span className="mx-1.5">·</span>{client.invoice_count} {client.invoice_count === 1 ? 'factura' : 'facturas'}
            <span className="mx-1.5">·</span>Pendiente total: {displayBigInt(amountValue(client.pending_amount))}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-semibold text-theme-text">
              <span>Medio recibido</span>
              <select
                value={paymentMethod}
                onChange={event => setPaymentMethod(event.target.value as PaymentMethod)}
                className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-normal outline-none focus:border-theme-accent"
              >
                <option value="CASH">Efectivo</option>
                <option value="TRANSFER">Transferencia</option>
                <option value="CHECK">Cheque</option>
              </select>
            </label>
            <label className="space-y-1.5 text-xs font-semibold text-theme-text">
              <span>Monto recibido</span>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-theme-text-muted">$</span>
                <input
                  inputMode="numeric"
                  value={displayDigits(amountReceived)}
                  onChange={event => handleAmountChange(event.target.value)}
                  placeholder="0"
                  className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-7 pr-3 text-right text-sm tabular-nums outline-none focus:border-theme-accent"
                />
              </div>
              <span className="font-normal text-theme-text-muted">Pendiente del cliente: {displayBigInt(amountValue(client.pending_amount))}</span>
            </label>
          </div>

          {paymentMethod === 'TRANSFER' && (
            <label className="block space-y-1.5 text-xs font-semibold text-theme-text">
              <span>Referencia / N° de operación <span className="font-normal text-theme-text-muted">(opcional)</span></span>
              <input value={referenceNumber} onChange={event => setReferenceNumber(event.target.value)} className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-normal outline-none focus:border-theme-accent" />
            </label>
          )}

          {paymentMethod === 'CHECK' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Número de cheque" value={checkNumber} onChange={setCheckNumber} required />
              <Field label="Banco" value={bankName} onChange={setBankName} />
              <label className="space-y-1.5 text-xs font-semibold text-theme-text">
                <span>Fecha del cheque</span>
                <input type="date" value={checkDate} onChange={event => setCheckDate(event.target.value)} className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-normal outline-none focus:border-theme-accent" />
              </label>
            </div>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-theme-text">Distribuir entre facturas</h3>
                <p className="text-xs text-theme-text-muted">Sólo se muestran facturas de este cliente.</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setManualDistribution(false); distribute(amountReceived) }}>
                <RefreshCw className="h-3.5 w-3.5" /> Redistribuir
              </Button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-theme-border">
              <table className="w-full min-w-[520px] text-xs">
                <thead className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Factura</th>
                    <th className="px-3 py-2 text-right">{payment ? 'Disponible' : 'Pendiente'}</th>
                    <th className="px-3 py-2 text-right">Aplicar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/70">
                  {client.invoices.map(invoice => (
                    <tr key={invoice.settlement_item_id}>
                      <td className="px-3 py-2.5 font-semibold text-theme-text">{invoice.invoice_number}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-theme-text-muted">{displayBigInt(availableByInvoice.get(invoice.settlement_item_id) ?? ZERO)}</td>
                      <td className="px-3 py-2.5">
                          <div className="relative ml-auto w-40 max-w-full">
                          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-theme-text-muted">$</span>
                          <input
                            inputMode="numeric"
                            disabled={(availableByInvoice.get(invoice.settlement_item_id) ?? ZERO) <= ZERO}
                            value={displayDigits(allocations[invoice.settlement_item_id] || '')}
                            onChange={event => handleAllocationChange(invoice.settlement_item_id, event.target.value)}
                            className="h-8 w-full rounded-md border border-theme-border bg-theme-surface pl-6 pr-2 text-right tabular-nums outline-none focus:border-theme-accent disabled:cursor-not-allowed disabled:bg-theme-text/5"
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-2 rounded-lg border border-theme-border bg-theme-text/[0.02] px-3 py-3 text-xs sm:grid-cols-3">
            <TotalLine label="Monto recibido" value={displayBigInt(receivedAmount)} />
            <TotalLine label="Monto aplicado" value={displayBigInt(appliedAmount)} />
            <TotalLine label="Saldo sin aplicar" value={displayBigInt(unallocatedAmount)} warning={unallocatedAmount > ZERO} />
          </div>

          <label className="block space-y-1.5 text-xs font-semibold text-theme-text">
            <span>Observación <span className="font-normal text-theme-text-muted">(opcional)</span></span>
            <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} className="w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm font-normal outline-none focus:border-theme-accent" />
          </label>

          {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">{error}</p>}
        </div>

        <DialogFooter className="mt-2 border-theme-border bg-theme-text/[0.02]">
          <Button type="button" variant="outline" onClick={() => handleDialogChange(false)} disabled={isSaving}>Cancelar</Button>
          <Button type="button" onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? 'Guardando...' : payment ? 'Guardar cambios' : 'Registrar pago'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value, onChange, required = false }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return (
    <label className="space-y-1.5 text-xs font-semibold text-theme-text">
      <span>{label}{required && <span className="ml-1 text-red-600">*</span>}</span>
      <input value={value} onChange={event => onChange(event.target.value)} className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-normal outline-none focus:border-theme-accent" />
    </label>
  )
}

function TotalLine({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p>
      <p className={`mt-0.5 font-semibold tabular-nums ${warning ? 'text-amber-700 dark:text-amber-300' : 'text-theme-text'}`}>{value}</p>
    </div>
  )
}
