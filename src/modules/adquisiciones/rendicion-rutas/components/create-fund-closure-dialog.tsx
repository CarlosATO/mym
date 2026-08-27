'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatInstantInSantiago } from '@/lib/datetime'
import { createFundClosureFromMixedPayments, getPendingFundExpenses, getPendingFundPayments, registerRouteFundClosureDeposit, saveRouteFundClosureDepositAttachment } from '@/app/actions/adquisiciones/route-fund-closures'
import { PendingFundExpense, PendingFundPayment, PendingRouteFundGroup } from '../fund-closures-types'
import { SETTLEMENT_ATTACHMENT_ALLOWED_MIMES, SETTLEMENT_ATTACHMENT_MAX_SIZE } from '../utils/settlement-attachment-config'

function money(value: number) {
  return `$${Number(value || 0).toLocaleString('es-CL')}`
}

function formatCashInput(value: string) {
  const digits = value.replace(/\D/g, '')
  return digits ? `$${Number(digits).toLocaleString('es-CL')}` : ''
}

function expenseLabel(type: string) {
  return type === 'PEAJES' ? 'Peajes' : type === 'OTROS' ? 'Otros' : type
}

interface CreateFundClosureDialogProps {
  groups: PendingRouteFundGroup[]
  onClose: () => void
  onCreated: (closureId: string) => void
  onPartialFailure: (closureId: string, message: string) => void
}

export function CreateFundClosureDialog({ groups, onClose, onCreated, onPartialFailure }: CreateFundClosureDialogProps) {
  const [payments, setPayments] = useState<PendingFundPayment[]>([])
  const [expenses, setExpenses] = useState<PendingFundExpense[]>([])
  const cashReceived = groups.reduce((sum, group) => sum + Number(group.cash_received || 0), 0)
  const expenseTotal = groups.reduce((sum, group) => sum + Number(group.active_route_expenses || 0), 0)
  const cashExpected = cashReceived - expenseTotal
  const cashDeliveredGroupKey = groups.map(group => `${group.route_settlement_id}:${group.custody_user_id}`).sort().join('|')
  const proposedCashDelivered = cashExpected > 0 ? cashExpected : 0
  const [cashDeliveredInput, setCashDeliveredInput] = useState(() => formatCashInput(String(proposedCashDelivered)))
  const [cashDelivered, setCashDelivered] = useState<number | null>(proposedCashDelivered)
  const cashDeliveredWasEdited = useRef(false)
  const previousCashDeliveredGroupKey = useRef(cashDeliveredGroupKey)
  const [notes, setNotes] = useState('')
  const [confirmedChecks, setConfirmedChecks] = useState<Set<string>>(new Set())
  const [depositCheckIds, setDepositCheckIds] = useState<Set<string>>(new Set())
  const [traceOpen, setTraceOpen] = useState(false)
  const [registerDepositNow, setRegisterDepositNow] = useState(false)
  const [depositAmount, setDepositAmount] = useState(() => String(proposedCashDelivered))
  const depositAmountWasEdited = useRef(false)
  const depositCheckSelectionWasEdited = useRef(false)
  const [depositDate, setDepositDate] = useState(new Date().toISOString().slice(0, 10))
  const [depositMethod, setDepositMethod] = useState<'DEPOSIT' | 'CASH_DELIVERY' | 'TRANSFER' | 'OTHER'>('DEPOSIT')
  const [depositReference, setDepositReference] = useState('')
  const [depositNotes, setDepositNotes] = useState('')
  const [depositFile, setDepositFile] = useState<File | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const checks = payments.filter(payment => payment.payment_method_received === 'CHECK')
  const includedPayments = payments.filter(payment => payment.payment_method_received === 'CASH' || confirmedChecks.has(payment.id))
  const paymentIds = includedPayments.filter(payment => payment.source_type !== 'POST_SETTLEMENT_PAYMENT').map(payment => payment.id)
  const postSettlementPaymentIds = includedPayments.filter(payment => payment.source_type === 'POST_SETTLEMENT_PAYMENT').map(payment => payment.post_settlement_payment_id ?? payment.id)
  const expectedChecks = checks.filter(check => confirmedChecks.has(check.id)).reduce((sum, check) => sum + Number(check.amount_received || 0), 0)
  const totalExpected = cashExpected + expectedChecks
  const includedPaymentCount = paymentIds.length + postSettlementPaymentIds.length
  const delivered = cashDelivered ?? 0
  const requiresCashDelivery = cashExpected > 0
  const difference = delivered - cashExpected
  const pendingChecks = checks.filter(check => !confirmedChecks.has(check.id))
  const depositChecks = checks.filter(check => confirmedChecks.has(check.id))
  const depositCheckTotal = depositChecks.filter(check => depositCheckIds.has(check.id)).reduce((sum, check) => sum + Number(check.amount_received || 0), 0)
  const hasCashDelivered = !requiresCashDelivery || cashDelivered !== null
  const hasDifference = hasCashDelivered && difference !== 0
  const depositCashAvailable = delivered
  const depositTotal = Number(depositAmount || 0) + depositCheckTotal
  const depositAvailable = depositCashAvailable + expectedChecks
  const depositCashPending = Math.max(0, depositCashAvailable - Number(depositAmount || 0))
  const depositChecksPending = Math.max(0, expectedChecks - depositCheckTotal)

  useEffect(() => {
    if (registerDepositNow && !depositAmountWasEdited.current) setDepositAmount(String(depositCashAvailable))
  }, [registerDepositNow, depositCashAvailable])

  useEffect(() => {
    const groupChanged = previousCashDeliveredGroupKey.current !== cashDeliveredGroupKey
    if (groupChanged) {
      previousCashDeliveredGroupKey.current = cashDeliveredGroupKey
      cashDeliveredWasEdited.current = false
    }
    if (groupChanged || !cashDeliveredWasEdited.current) {
      setCashDeliveredInput(formatCashInput(String(proposedCashDelivered)))
      setCashDelivered(proposedCashDelivered)
    }
  }, [cashDeliveredGroupKey, proposedCashDelivered])

  useEffect(() => {
    let active = true
    const previewPaymentIds = groups.flatMap(group => group.payment_ids)
    const previewPostPaymentIds = groups.flatMap(group => group.post_settlement_payment_ids ?? [])
    const previewSettlementIds = groups.map(group => group.route_settlement_id)
    Promise.all([getPendingFundPayments({ paymentIds: previewPaymentIds, postSettlementPaymentIds: previewPostPaymentIds }), getPendingFundExpenses(previewSettlementIds)])
      .then(([loadedPayments, loadedExpenses]) => {
        if (!active) return
        setPayments(loadedPayments)
        setExpenses(loadedExpenses)
        const loadedCheckIds = loadedPayments.filter(payment => payment.payment_method_received === 'CHECK' && payment.custody_received_at).map(payment => payment.id)
        setConfirmedChecks(new Set(loadedCheckIds))
        if (!depositCheckSelectionWasEdited.current) setDepositCheckIds(new Set(loadedCheckIds))
      })
      .catch(error => toast.error(error instanceof Error ? error.message : 'No fue posible cargar el detalle del cierre.'))
      .finally(() => active && setIsLoading(false))
    return () => { active = false }
  }, [groups])

  const submit = async () => {
    if (!hasCashDelivered) return
    if (hasDifference && notes.trim().length === 0) return
    if (registerDepositNow) {
      if (!Number.isInteger(Number(depositAmount)) || Number(depositAmount) < 0 || Number(depositAmount) > depositCashAvailable) {
        setFormError(`El efectivo a depositar debe estar entre $0 y ${money(depositCashAvailable)}.`)
        return
      }
      if (!Number.isInteger(depositTotal) || depositTotal <= 0 || depositTotal > depositAvailable) {
        setFormError(`El total del depósito debe estar entre $1 y ${money(depositAvailable)}.`)
        return
      }
      if (depositCheckTotal > depositTotal) {
        setFormError(`El monto de los cheques seleccionados supera el total del depósito de ${money(depositTotal)}.`)
        return
      }
      if (!depositDate) { setFormError('La fecha del depósito es obligatoria.'); return }
      if (depositFile) {
        if (depositFile.size > SETTLEMENT_ATTACHMENT_MAX_SIZE) { setFormError('El comprobante no puede superar 10 MB.'); return }
        if (!(SETTLEMENT_ATTACHMENT_ALLOWED_MIMES as readonly string[]).includes(depositFile.type)) { setFormError('El comprobante debe ser PDF, PNG, JPEG o WEBP.'); return }
      }
    }
    setIsSubmitting(true)
    setFormError(null)
    try {
      const closure = await createFundClosureFromMixedPayments({
        paymentIds,
        postSettlementPaymentIds,
        checkPaymentIds: checks.map(check => check.id).filter(id => confirmedChecks.has(id)),
        cashDelivered: delivered,
        notes: notes.trim() || null,
      })
      if (!registerDepositNow) {
        toast.success('Cierre de Fondos creado y confirmado.')
        onCreated(closure.closure_id)
        return
      }

      const deposit = await registerRouteFundClosureDeposit({
        fundClosureId: closure.closure_id,
        amount: depositTotal,
        depositDate,
        depositMethod,
        referenceNumber: depositReference,
        notes: depositNotes,
        checkPaymentIds: [...depositCheckIds],
      })
      if (deposit.error || !deposit.data) {
        onPartialFailure(closure.closure_id, `Cierre creado. No se pudo registrar el depósito. Detalle: ${deposit.error ?? 'error desconocido'}`)
        return
      }

      if (depositFile) {
        const attachmentForm = new FormData()
        attachmentForm.set('file', depositFile)
        const attachment = await saveRouteFundClosureDepositAttachment(deposit.data.deposit_id, closure.closure_id, attachmentForm)
        if (attachment.error) {
          onPartialFailure(closure.closure_id, `Cierre y depósito creados. No se pudo adjuntar el comprobante. Detalle: ${attachment.error}`)
          return
        }
      }
      toast.success('Cierre de Fondos y depósito registrados.')
      onCreated(closure.closure_id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No fue posible confirmar el cierre.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="create-fund-closure-title">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <header className="shrink-0 border-b border-theme-border px-5 py-3.5">
          <div className="flex items-start justify-between">
            <div>
              <h2 id="create-fund-closure-title" className="text-lg font-bold text-theme-text">Crear cierre de fondos</h2>
              <p className="mt-0.5 text-xs text-theme-text-muted">Verifica la entrega física antes de confirmar.</p>
            </div>
            <button type="button" onClick={onClose} className="rounded p-1 text-theme-text-muted hover:bg-theme-text/10" aria-label="Cerrar"><X className="h-5 w-5" /></button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-theme-text-muted">
            <span>Custodio: <strong className="font-semibold text-theme-text">{groups[0]?.custody_name ?? groups[0]?.custody_user_id}</strong></span>
            <span>Rendiciones: <strong className="font-semibold text-theme-text">{paymentIds.length}</strong></span>
            <span>Cobros posteriores: <strong className="font-semibold text-theme-text">{postSettlementPaymentIds.length}</strong></span>
            <span>Cobros incluidos: <strong className="font-semibold text-theme-text">{includedPaymentCount}</strong></span>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 lg:px-5">
          <section className="grid grid-cols-2 overflow-hidden rounded-lg border border-theme-border sm:grid-cols-5">
            <SummaryAmount label="Efectivo recibido" value={cashReceived} />
            <SummaryAmount label="Gastos" value={expenseTotal} bordered />
            <SummaryAmount label="Efectivo a entregar" value={cashExpected} bordered responsiveTop />
            <SummaryAmount label="Cheques" value={expectedChecks} bordered responsiveTop />
            <div className="col-span-2 border-t border-theme-accent/30 bg-theme-accent/[0.07] px-3 py-2.5 sm:col-span-1 sm:border-l sm:border-t-0">
              <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-theme-accent">Total esperado a rendir</p>
              <p className="mt-0.5 font-mono text-lg font-black text-theme-text">{money(totalExpected)}</p>
            </div>
          </section>

          <div className="grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
            <section className="rounded-lg border border-theme-border p-3.5">
              <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.08em] text-theme-text">Registro físico</h3>
              <label className="block text-xs font-semibold text-theme-text">Efectivo realmente entregado
                <input
                  type="text"
                  inputMode="numeric"
                  minLength={1}
                  value={cashDeliveredInput}
                  onChange={event => {
                    const digits = event.target.value.replace(/\D/g, '')
                    cashDeliveredWasEdited.current = true
                    setCashDeliveredInput(formatCashInput(event.target.value))
                    setCashDelivered(digits ? Number(digits) : null)
                  }}
                   required={requiresCashDelivery}
                   aria-required={requiresCashDelivery}
                  placeholder="$0"
                  className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 font-mono text-sm font-semibold text-theme-text outline-none focus:border-theme-accent"
                />
              </label>
              <div className={`mt-2 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${!hasCashDelivered ? 'border-theme-border bg-theme-text/5 text-theme-text-muted' : hasDifference ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300' : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300'}`}>
                <span className="font-semibold">Estado previsto</span>
                <span className="font-bold">{!hasCashDelivered ? 'Pendiente' : hasDifference ? `${difference < 0 ? 'Faltante' : 'Sobrante'} ${money(Math.abs(difference))}` : 'Cuadrado'}</span>
              </div>

              <label className="mt-3 block text-xs font-semibold text-theme-text">Observación {hasDifference && <span className="text-amber-700">(obligatoria por diferencia)</span>}
                <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={2} required={hasDifference} className="mt-1 w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text outline-none focus:border-theme-accent" placeholder="Comentario opcional del cierre" />
              </label>

              <div className="mt-3 border-t border-theme-border pt-2.5">
                <div className="mb-1.5 flex items-center justify-between"><h4 className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Gastos justificados</h4><span className="font-mono text-xs font-bold text-theme-text">{money(expenseTotal)}</span></div>
                {isLoading ? <div className="flex items-center gap-2 text-xs text-theme-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Cargando gastos...</div> : expenses.length === 0 ? <p className="text-xs text-theme-text-muted">Sin gastos registrados.</p> : <div className="divide-y divide-theme-border">{expenses.map(expense => <div key={expense.id} className="flex justify-between py-1.5 text-xs"><span>{expenseLabel(expense.expense_type)}</span><span className="font-mono font-semibold">{money(expense.amount)}</span></div>)}</div>}
              </div>

               {((requiresCashDelivery && !hasCashDelivered) || hasDifference && notes.trim().length === 0) && <div className="mt-2.5 flex items-start gap-2 text-[11px] text-amber-700"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{!hasCashDelivered ? 'Ingresa el efectivo entregado para continuar.' : 'Ingresa el motivo del faltante o sobrante.'}</div>}

              <label className="mt-3 flex cursor-pointer items-center gap-2 border-t border-theme-border pt-3 text-xs font-semibold text-theme-text"><input type="checkbox" checked={registerDepositNow} onChange={event => { setRegisterDepositNow(event.target.checked); setFormError(null) }} className="h-3.5 w-3.5 accent-theme-accent" />Registrar depósito ahora</label>
            </section>

            <section className="rounded-lg border border-theme-border p-3.5">
              <div className="mb-2.5 flex items-baseline justify-between gap-3">
                <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-theme-text">Cheques recibidos</h3>
                 <span className="text-[10px] text-theme-text-muted">Disponibles: {checks.length} · Incluidos: {checks.filter(check => confirmedChecks.has(check.id)).length} · Pendientes: {pendingChecks.length}</span>
              </div>
              {isLoading ? <div className="flex items-center gap-2 text-xs text-theme-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />Cargando cheques...</div> : checks.length === 0 ? <p className="rounded-lg bg-theme-text/[0.035] px-3 py-4 text-center text-xs text-theme-text-muted">Sin cheques por recibir.</p> : (
                <div className="divide-y divide-theme-border overflow-hidden rounded-lg border border-theme-border">
                  {checks.map(check => (
                    <label key={check.id} className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-xs hover:bg-theme-text/[0.025]">
                      <input type="checkbox" checked={confirmedChecks.has(check.id)} onChange={event => setConfirmedChecks(current => { const next = new Set(current); if (event.target.checked) next.add(check.id); else next.delete(check.id); return next })} className="h-3.5 w-3.5 accent-theme-accent" />
                      <span className="min-w-0"><strong className="block truncate text-theme-text">{check.customer_name || 'Cliente no disponible'}</strong><span className="block truncate text-[10px] text-theme-text-muted">{check.bank_name || 'Banco no informado'} · #{check.check_number ?? check.reference_number ?? 'Sin número'}{check.check_date ? ` · ${check.check_date}` : ''}</span></span>
                      <span className="font-mono font-bold tabular-nums text-theme-text">{money(check.amount_received)}</span>
                    </label>
                  ))}
                </div>
              )}
               {pendingChecks.length > 0 && <div className="mt-2.5 flex items-start gap-2 text-[11px] text-theme-text-muted"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />Los cheques no incluidos permanecerán disponibles para un próximo Cierre de Fondos.</div>}
            </section>
          </div>

          {registerDepositNow && <section className="rounded-lg border border-theme-accent/30 bg-theme-accent/[0.035] p-3.5">
            <div className="mb-2.5 flex items-baseline justify-between gap-3"><h3 className="text-xs font-bold uppercase tracking-[0.08em] text-theme-text">Depósito</h3><span className="text-[10px] text-theme-text-muted">Disponible para depositar: <strong className="text-theme-text">{money(depositAvailable)}</strong></span></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-xs font-semibold text-theme-text">Monto de efectivo a depositar<input type="number" min="0" max={depositCashAvailable} step="1" required={registerDepositNow} value={depositAmount} onChange={event => { depositAmountWasEdited.current = true; setDepositAmount(event.target.value) }} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 font-mono outline-none focus:border-theme-accent" /></label>
              <label className="text-xs font-semibold text-theme-text">Fecha del depósito<input type="date" required={registerDepositNow} value={depositDate} onChange={event => setDepositDate(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 outline-none focus:border-theme-accent" /></label>
              <label className="text-xs font-semibold text-theme-text">Método<select value={depositMethod} onChange={event => setDepositMethod(event.target.value as typeof depositMethod)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 outline-none focus:border-theme-accent"><option value="DEPOSIT">Depósito bancario</option><option value="CASH_DELIVERY">Entrega de efectivo</option><option value="TRANSFER">Transferencia</option><option value="OTHER">Otro</option></select></label>
              <label className="text-xs font-semibold text-theme-text">N.º comprobante / referencia<input value={depositReference} onChange={event => setDepositReference(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 outline-none focus:border-theme-accent" /></label>
            </div>
             <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-theme-text">Adjuntar comprobante<input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={event => setDepositFile(event.target.files?.[0] ?? null)} className="mt-1 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs file:mr-3 file:rounded file:border-0 file:bg-theme-text/10 file:px-2 file:py-1 file:text-xs" /><span className="mt-1 block font-normal text-[10px] text-theme-text-muted">PDF, PNG, JPEG o WEBP · máximo 10 MB.</span>{depositFile && <span className="mt-1 flex items-center gap-2 font-normal text-theme-text"><span className="truncate">{depositFile.name}</span><button type="button" onClick={() => setDepositFile(null)} className="font-bold text-red-600">Quitar</button></span>}</label><label className="text-xs font-semibold text-theme-text">Observación<span className="ml-1 font-normal text-theme-text-muted">(opcional)</span><textarea value={depositNotes} onChange={event => setDepositNotes(event.target.value)} rows={2} className="mt-1 w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 font-normal outline-none focus:border-theme-accent" /></label></div>
              <div className="mt-3 rounded-lg border border-theme-border bg-theme-surface px-3 py-2.5"><div className="flex items-baseline justify-between gap-2"><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Cheques incluidos en este depósito</p><span className="text-[10px] text-theme-text-muted">{money(depositCheckTotal)}</span></div>{depositChecks.length === 0 ? <p className="mt-1 text-[11px] text-theme-text-muted">Depósito sólo de efectivo o sin cheques seleccionados.</p> : <div className="mt-1 divide-y divide-theme-border">{depositChecks.map(check => <label key={check.id} className="flex cursor-pointer items-center justify-between gap-3 py-1.5 text-xs"><span className="flex min-w-0 items-center gap-2"><input type="checkbox" checked={depositCheckIds.has(check.id)} onChange={event => { depositCheckSelectionWasEdited.current = true; setDepositCheckIds(current => { const next = new Set(current); if (event.target.checked) next.add(check.id); else next.delete(check.id); return next }) }} className="h-3.5 w-3.5 accent-theme-accent" /><span className="truncate">{check.customer_name || 'Cliente no disponible'} · #{check.check_number ?? check.reference_number ?? 'Sin número'}</span></span><span className="shrink-0 font-mono font-bold">{money(check.amount_received)}</span></label>)}</div>}</div>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-theme-accent/30 bg-theme-accent/[0.04] px-3 py-2.5 text-xs sm:grid-cols-4"><div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Se deposita ahora</p><p className="mt-0.5 font-mono font-bold text-theme-text">{money(depositTotal)}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Total depósito</p><p className="mt-0.5 font-mono font-bold text-theme-text">{money(depositTotal)}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Efectivo pendiente</p><p className="mt-0.5 font-mono font-semibold text-theme-text">{money(depositCashPending)}</p></div><div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Cheques pendientes</p><p className="mt-0.5 font-mono font-semibold text-theme-text">{money(depositChecksPending)}</p></div></div>
            {formError && <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">{formError}</p>}
          </section>}

          <section className="rounded-lg border border-theme-border">
            <button type="button" onClick={() => setTraceOpen(current => !current)} aria-expanded={traceOpen} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-semibold text-theme-text hover:bg-theme-text/[0.025]">
              <span>{includedPaymentCount} {includedPaymentCount === 1 ? 'cobro incluido' : 'cobros incluidos'} <span className="font-normal text-theme-text-muted">· Ver trazabilidad</span></span>
              <ChevronDown className={`h-4 w-4 text-theme-text-muted transition-transform ${traceOpen ? 'rotate-180' : ''}`} />
            </button>
            {traceOpen && <div className="max-h-52 overflow-y-auto border-t border-theme-border text-xs">{isLoading ? <p className="px-3 py-2 text-theme-text-muted">Cargando fondos...</p> : <div className="divide-y divide-theme-border">{payments.map(payment => <div key={`${payment.source_type}:${payment.id}`} className="grid gap-1 px-3 py-2 sm:grid-cols-[1.05fr_1.3fr_0.9fr_auto] sm:items-center"><span className="font-semibold text-theme-text">{payment.source_type === 'POST_SETTLEMENT_PAYMENT' ? 'Cobro posterior' : 'Rendición'} · {payment.customer_name || 'Cliente no disponible'}</span><span className="text-theme-text-muted">Factura {payment.invoice_number || '---'} · GR {payment.guide_number || '---'} · RR {payment.settlement_number || '---'}</span><span className="text-theme-text-muted">{payment.received_at ? formatInstantInSantiago(payment.received_at) : 'Fecha no disponible'} · {payment.payment_method_received === 'CASH' ? 'Efectivo' : 'Cheque'}</span><span className="font-mono font-bold text-theme-text">{money(payment.amount_received)}</span></div>)}</div>}</div>}
          </section>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-theme-border bg-theme-surface px-5 py-3">
          <button type="button" onClick={onClose} disabled={isSubmitting} className="rounded-lg border border-theme-border px-4 py-2 text-sm font-semibold text-theme-text">Cancelar</button>
           <button type="button" onClick={submit} disabled={isLoading || isSubmitting || includedPaymentCount === 0 || !hasCashDelivered || hasDifference && notes.trim().length === 0} className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">{isSubmitting ? 'Confirmando...' : registerDepositNow ? 'Confirmar cierre y depósito' : 'Confirmar cierre'}</button>
        </footer>
      </div>
    </div>
  )
}

function SummaryAmount({ label, value, bordered = false, responsiveTop = false }: { label: string; value: number; bordered?: boolean; responsiveTop?: boolean }) {
  return <div className={`px-3 py-2.5 ${bordered ? 'border-l border-theme-border' : ''} ${responsiveTop ? 'border-t border-theme-border sm:border-t-0' : ''}`}><p className="text-[9px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-0.5 font-mono text-sm font-bold text-theme-text">{money(value)}</p></div>
}
