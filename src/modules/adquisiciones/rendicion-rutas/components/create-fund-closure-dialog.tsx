'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { createFundClosureFromPayments, getPendingFundExpenses, getPendingFundPayments } from '@/app/actions/adquisiciones/route-fund-closures'
import { PendingFundExpense, PendingFundPayment, PendingRouteFundGroup } from '../fund-closures-types'

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
  onCreated: () => void
}

export function CreateFundClosureDialog({ groups, onClose, onCreated }: CreateFundClosureDialogProps) {
  const [payments, setPayments] = useState<PendingFundPayment[]>([])
  const [expenses, setExpenses] = useState<PendingFundExpense[]>([])
  const cashReceived = groups.reduce((sum, group) => sum + Number(group.cash_received || 0), 0)
  const expenseTotal = groups.reduce((sum, group) => sum + Number(group.active_route_expenses || 0), 0)
  const cashExpected = cashReceived - expenseTotal
  const [cashDeliveredInput, setCashDeliveredInput] = useState('')
  const [cashDelivered, setCashDelivered] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [confirmedChecks, setConfirmedChecks] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const paymentIds = groups.flatMap(group => group.payment_ids)
  const expectedChecks = groups.reduce((sum, group) => sum + Number(group.checks_received || 0), 0)
  const delivered = cashDelivered ?? 0
  const difference = delivered - cashExpected
  const checks = payments.filter(payment => payment.payment_method_received === 'CHECK')
  const hasUnconfirmedCheck = checks.some(check => !confirmedChecks.has(check.id))
  const hasCashDelivered = cashDelivered !== null
  const hasDifference = hasCashDelivered && difference !== 0

  useEffect(() => {
    let active = true
    const previewPaymentIds = groups.flatMap(group => group.payment_ids)
    const previewSettlementIds = groups.map(group => group.route_settlement_id)
    Promise.all([getPendingFundPayments(previewPaymentIds), getPendingFundExpenses(previewSettlementIds)])
      .then(([loadedPayments, loadedExpenses]) => {
        if (!active) return
        setPayments(loadedPayments)
        setExpenses(loadedExpenses)
        setConfirmedChecks(new Set(loadedPayments.filter(payment => payment.payment_method_received === 'CHECK' && payment.custody_received_at).map(payment => payment.id)))
      })
      .catch(error => toast.error(error instanceof Error ? error.message : 'No fue posible cargar el detalle del cierre.'))
      .finally(() => active && setIsLoading(false))
    return () => { active = false }
  }, [groups])

  const submit = async () => {
    if (!hasCashDelivered) return
    if (hasDifference && notes.trim().length === 0) return
    if (hasUnconfirmedCheck) return
    setIsSubmitting(true)
    try {
      await createFundClosureFromPayments({
        paymentIds,
        checkPaymentIds: checks.map(check => check.id).filter(id => confirmedChecks.has(id)),
        cashDelivered: delivered,
        notes: notes.trim() || null,
      })
      toast.success('Cierre de Fondos creado y confirmado.')
      onCreated()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No fue posible confirmar el cierre.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="create-fund-closure-title">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-start justify-between border-b border-theme-border px-5 py-4">
          <div>
            <h2 id="create-fund-closure-title" className="text-lg font-bold text-theme-text">Crear cierre de fondos</h2>
            <p className="mt-1 text-xs text-theme-text-muted">Verifica la entrega física antes de confirmar. Abrir este modal no crea ningún cierre.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-theme-text-muted hover:bg-theme-text/10" aria-label="Cerrar"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <div className="grid gap-3 rounded-lg border border-theme-border p-4 sm:grid-cols-2">
            <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Custodio</p><p className="mt-1 font-semibold text-theme-text">{groups[0]?.custody_name ?? groups[0]?.custody_user_id}</p></div>
            <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Rendiciones</p><p className="mt-1 font-semibold text-theme-text">{groups.length}</p></div>
          </div>

          <section>
            <h3 className="mb-2 text-sm font-bold text-theme-text">Rendiciones incluidas</h3>
            <div className="divide-y divide-theme-border rounded-lg border border-theme-border">
              {groups.map(group => <div key={`${group.route_settlement_id}:${group.custody_user_id}`} className="flex items-center justify-between px-3 py-2 text-sm"><span className="font-semibold text-theme-text">{group.settlement_number} <span className="font-normal text-theme-text-muted">/ {group.guide_number}</span></span><span className="font-mono text-theme-text">{money(group.net_cash_pending)}</span></div>)}
            </div>
           </section>

           <section>
            <h3 className="mb-2 text-sm font-bold text-theme-text">Resumen esperado</h3>
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-theme-border p-4 sm:grid-cols-4">
              <div><p className="text-[10px] uppercase text-theme-text-muted">Efectivo recibido</p><p className="font-mono font-bold">{money(cashReceived)}</p></div>
              <div><p className="text-[10px] uppercase text-theme-text-muted">Gastos</p><p className="font-mono font-bold">{money(expenseTotal)}</p></div>
              <div><p className="text-[10px] uppercase text-theme-text-muted">Efectivo a entregar</p><p className="font-mono font-bold text-theme-text">{money(cashExpected)}</p></div>
              <div><p className="text-[10px] uppercase text-theme-text-muted">Cheques esperados</p><p className="font-mono font-bold">{money(expectedChecks)}</p></div>
            </div>
           </section>

           <section>
             <h3 className="mb-2 text-sm font-bold text-theme-text">Registro físico</h3>
             <label className="block text-sm font-semibold text-theme-text">Efectivo realmente entregado
               <input
                 type="text"
                 inputMode="numeric"
                 minLength={1}
                 value={cashDeliveredInput}
                 onChange={event => {
                   const digits = event.target.value.replace(/\D/g, '')
                   setCashDeliveredInput(formatCashInput(event.target.value))
                   setCashDelivered(digits ? Number(digits) : null)
                 }}
                 required
                 aria-required="true"
                 placeholder="$0"
                 className="mt-1 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 font-mono text-theme-text outline-none focus:border-theme-accent"
               />
             </label>
             <div className={`mt-3 flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between ${!hasCashDelivered ? 'border-theme-border bg-theme-text/5 text-theme-text-muted' : hasDifference ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300' : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300'}`}>
               <span className="font-semibold">Estado previsto</span><span className="font-bold">{!hasCashDelivered ? 'Pendiente de ingresar efectivo recibido' : hasDifference ? `${difference < 0 ? 'Faltante' : 'Sobrante'} ${money(Math.abs(difference))}` : 'Cuadrado'}</span>
             </div>
           </section>

           <section className="rounded-lg border border-theme-border p-3">
             <label className="block text-sm font-semibold text-theme-text">Observación {hasDifference && <span className="text-amber-700">(obligatoria por diferencia)</span>}
               <textarea value={notes} onChange={event => setNotes(event.target.value)} rows={3} required={hasDifference} className="mt-1 w-full resize-y rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" placeholder="Comentario opcional del cierre" />
             </label>
           </section>
           {(!hasCashDelivered || hasDifference && notes.trim().length === 0) && <div className="flex items-start gap-2 text-xs text-amber-700"><AlertTriangle className="h-4 w-4 shrink-0" />{!hasCashDelivered ? 'Ingresa el efectivo recibido para continuar.' : 'Ingresa el motivo del faltante o sobrante para continuar.'}</div>}

           <section>
            <h3 className="mb-2 text-sm font-bold text-theme-text">Gastos justificados</h3>
            {isLoading ? <div className="flex items-center gap-2 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Cargando gastos y cheques...</div> : expenses.length === 0 ? <p className="text-sm text-theme-text-muted">Sin gastos registrados.</p> : <div className="divide-y divide-theme-border rounded-lg border border-theme-border">{expenses.map(expense => <div key={expense.id} className="flex justify-between px-3 py-2 text-sm"><span>{expenseLabel(expense.expense_type)}</span><span className="font-mono">{money(expense.amount)}</span></div>)}</div>}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-bold text-theme-text">Cheques</h3>
            {checks.length === 0 ? <p className="text-sm text-theme-text-muted">Sin cheques por recibir</p> : <div className="space-y-2">{checks.map(check => <label key={check.id} className="flex items-center gap-3 rounded-lg border border-theme-border px-3 py-2 text-sm"><input type="checkbox" checked={confirmedChecks.has(check.id)} onChange={event => setConfirmedChecks(current => { const next = new Set(current); if (event.target.checked) next.add(check.id); else next.delete(check.id); return next })} /><span className="flex-1">Cheque {check.check_number ?? check.reference_number ?? check.id}</span><span className="font-mono">{money(check.amount_received)}</span></label>)}</div>}
          </section>

           {hasUnconfirmedCheck && <div className="flex items-start gap-2 text-xs text-amber-700"><AlertTriangle className="h-4 w-4 shrink-0" />Confirma la recepción física de cada cheque para continuar.</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-theme-border px-5 py-4">
          <button type="button" onClick={onClose} disabled={isSubmitting} className="rounded-lg border border-theme-border px-4 py-2 text-sm font-semibold text-theme-text">Cancelar</button>
           <button type="button" onClick={submit} disabled={isLoading || isSubmitting || !hasCashDelivered || hasDifference && notes.trim().length === 0 || hasUnconfirmedCheck} className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">{isSubmitting ? 'Confirmando...' : 'Confirmar cierre'}</button>
        </div>
      </div>
    </div>
  )
}
