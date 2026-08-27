'use client'

import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { registerRouteFundClosureDeposit, saveRouteFundClosureDepositAttachment } from '@/app/actions/adquisiciones/route-fund-closures'
import type { PendingRouteFundDepositCheck } from '../fund-closures-types'
import { todayInSantiago } from '@/lib/datetime'

function money(value: number) {
  return `$${Number(value || 0).toLocaleString('es-CL')}`
}

interface RegisterFundClosureDepositDialogProps {
  closureId: string
  maxAmount: number
  cashAvailable?: number
  availableChecks?: PendingRouteFundDepositCheck[]
  onClose: () => void
  onSaved: () => Promise<void>
}

export function RegisterFundClosureDepositDialog({ closureId, maxAmount, cashAvailable, availableChecks = [], onClose, onSaved }: RegisterFundClosureDepositDialogProps) {
  const hasCheckBreakdown = cashAvailable !== undefined
  const initialCash = cashAvailable ?? maxAmount
  const [amount, setAmount] = useState(() => String(initialCash))
  const [selectedCheckIds, setSelectedCheckIds] = useState(() => new Set(availableChecks.map(check => check.payment_id)))
  const [date, setDate] = useState(todayInSantiago())
  const [method, setMethod] = useState<'DEPOSIT' | 'CASH_DELIVERY' | 'TRANSFER' | 'OTHER'>('DEPOSIT')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const cashAmount = Number(amount || 0)
  const selectedCheckTotal = availableChecks.filter(check => selectedCheckIds.has(check.payment_id)).reduce((sum, check) => sum + Number(check.amount || 0), 0)
  const totalAmount = hasCheckBreakdown ? cashAmount + selectedCheckTotal : cashAmount
  const pendingCash = Math.max(0, initialCash - cashAmount)
  const pendingChecks = availableChecks.filter(check => !selectedCheckIds.has(check.payment_id))
  const pendingCheckTotal = pendingChecks.reduce((sum, check) => sum + Number(check.amount || 0), 0)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!Number.isInteger(cashAmount) || cashAmount < 0 || (hasCheckBreakdown && cashAmount > initialCash) || (!hasCheckBreakdown && cashAmount > maxAmount)) {
      setError(`El monto debe estar entre $0 y ${money(hasCheckBreakdown ? initialCash : maxAmount)}.`)
      return
    }
    if (!Number.isInteger(totalAmount) || totalAmount <= 0 || totalAmount > maxAmount) {
      setError(`El total debe estar entre $1 y ${money(maxAmount)}.`)
      return
    }
    setSaving(true)
    setError(null)
    const response = await registerRouteFundClosureDeposit({
      fundClosureId: closureId,
      amount: totalAmount,
      depositDate: date,
      depositMethod: method,
      referenceNumber: reference,
      notes,
      checkPaymentIds: [...selectedCheckIds],
    })
    if (response.error || !response.data) { setError(response.error ?? 'No se pudo registrar el depósito.'); setSaving(false); return }
    if (file) {
      const formData = new FormData()
      formData.set('file', file)
      const attachment = await saveRouteFundClosureDepositAttachment(response.data.deposit_id, closureId, formData)
      if (attachment.error) toast.error(`Depósito registrado, pero no se pudo guardar el comprobante: ${attachment.error}`)
    }
    toast.success('Depósito registrado.')
    await onSaved()
    setSaving(false)
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><form onSubmit={submit} className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl"><div className="flex items-start justify-between border-b border-theme-border px-5 py-4"><div><h3 className="font-bold text-theme-text">Registrar depósito</h3><p className="mt-0.5 text-xs text-theme-text-muted">Disponible para depositar: <strong className="text-theme-text">{money(maxAmount)}</strong></p></div><button type="button" onClick={onClose} className="rounded p-1 text-theme-text-muted hover:bg-theme-text/10" aria-label="Cerrar"><X className="h-4 w-4" /></button></div><div className="grid gap-3 overflow-y-auto p-5 text-xs"><label className="font-semibold text-theme-text">{hasCheckBreakdown ? 'Monto de efectivo a depositar' : 'Monto a depositar'}<input type="number" min={hasCheckBreakdown ? 0 : 1} max={hasCheckBreakdown ? initialCash : maxAmount} step="1" required value={amount} onChange={event => setAmount(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 font-mono outline-none focus:border-theme-accent" /></label>{hasCheckBreakdown && <div className="rounded-lg border border-theme-border px-3 py-2.5"><p className="mb-1.5 font-bold text-theme-text">Cheques disponibles</p>{availableChecks.length === 0 ? <p className="text-theme-text-muted">No hay cheques disponibles.</p> : <div className="divide-y divide-theme-border">{availableChecks.map(check => <label key={check.payment_id} className="flex cursor-pointer items-center justify-between gap-3 py-1.5"><span className="flex min-w-0 items-center gap-2"><input type="checkbox" checked={selectedCheckIds.has(check.payment_id)} onChange={event => setSelectedCheckIds(current => { const next = new Set(current); if (event.target.checked) next.add(check.payment_id); else next.delete(check.payment_id); return next })} className="h-3.5 w-3.5 accent-theme-accent" /><span className="truncate">{check.customer_name} · #{check.check_number ?? 'Sin número'}</span></span><span className="shrink-0 font-mono font-bold">{money(check.amount)}</span></label>)}</div>}</div>}<div className="grid grid-cols-2 gap-2 rounded-lg border border-theme-accent/30 bg-theme-accent/[0.04] px-3 py-2.5"><div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Se deposita ahora</p><p className="mt-0.5 font-mono font-bold text-theme-text">{money(totalAmount)}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Quedará pendiente</p><p className="mt-0.5 font-mono font-semibold text-theme-text">{money(pendingCash + pendingCheckTotal)}</p></div></div><div className="grid gap-3 sm:grid-cols-2"><label className="font-semibold text-theme-text">Fecha del depósito<input type="date" required value={date} onChange={event => setDate(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 outline-none focus:border-theme-accent" /></label><label className="font-semibold text-theme-text">Método<select value={method} onChange={event => setMethod(event.target.value as typeof method)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 outline-none focus:border-theme-accent"><option value="DEPOSIT">Depósito bancario</option><option value="CASH_DELIVERY">Entrega de efectivo</option><option value="TRANSFER">Transferencia</option><option value="OTHER">Otro</option></select></label></div><label className="font-semibold text-theme-text">N.º comprobante / referencia<input value={reference} onChange={event => setReference(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 font-normal outline-none focus:border-theme-accent" /></label><label className="font-semibold text-theme-text">Comprobante<input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={event => setFile(event.target.files?.[0] ?? null)} className="mt-1 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs file:mr-3 file:rounded file:border-0 file:bg-theme-text/10 file:px-2 file:py-1 file:text-xs" /><span className="mt-1 block font-normal text-[10px] text-theme-text-muted">PDF, PNG, JPEG o WEBP · máximo 10 MB.</span></label><label className="font-semibold text-theme-text">Observación<textarea rows={2} value={notes} onChange={event => setNotes(event.target.value)} className="mt-1 w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 font-normal outline-none focus:border-theme-accent" /></label>{error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}</div><div className="flex justify-end gap-2 border-t border-theme-border px-5 py-3"><button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-theme-border px-4 py-2 text-xs font-bold text-theme-text">Cancelar</button><button type="submit" disabled={saving} className="rounded-lg bg-theme-accent px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{saving ? 'Guardando...' : 'Guardar depósito'}</button></div></form></div>
}
