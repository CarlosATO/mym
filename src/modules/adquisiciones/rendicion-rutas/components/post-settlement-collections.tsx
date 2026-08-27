'use client'

import { useState } from 'react'
import { Eye, Search, XCircle } from 'lucide-react'
import {
  type PostSettlementReceivable,
  registerGroupedPostSettlementPayment,
  searchPostSettlementReceivables,
  voidPostSettlementPayment,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '../utils/route-settlement-formatters'

export function PostSettlementCollections() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PostSettlementReceivable[]>([])
  const [detailItem, setDetailItem] = useState<PostSettlementReceivable | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const selectedItems = results.filter(item => selectedIds.includes(item.settlement_item_id))
  const selectedCustomerId = selectedItems[0]?.customer_bsale_id ?? null
  const selectableItems = selectedCustomerId === null
    ? results
    : results.filter(item => item.customer_bsale_id === selectedCustomerId)
  const allSelectableSelected = selectableItems.length > 0
    && selectableItems.every(item => selectedIds.includes(item.settlement_item_id))
  const selectedTotal = selectedItems.reduce((total, item) => total + item.current_outstanding_amount, 0)

  async function search() {
    setLoading(true)
    setError(null)
    setSuccess(null)
    const response = await searchPostSettlementReceivables(query)
    if (response.error) {
      setError(response.error)
    } else {
      setResults(response.data ?? [])
      setSelectedIds([])
      setSelectionError(null)
    }
    setLoading(false)
  }

  function toggleItem(item: PostSettlementReceivable) {
    if (selectedIds.includes(item.settlement_item_id)) {
      setSelectedIds(current => current.filter(id => id !== item.settlement_item_id))
      setSelectionError(null)
      return
    }
    if (selectedCustomerId !== null && selectedCustomerId !== item.customer_bsale_id) {
      setSelectionError('Sólo puedes incluir facturas del mismo cliente en un cobro.')
      return
    }
    setSelectedIds(current => [...current, item.settlement_item_id])
    setSelectionError(null)
  }

  function toggleAll() {
    if (selectedCustomerId === null) {
      const customerIds = new Set(results.map(item => item.customer_bsale_id))
      if (customerIds.size > 1) {
        setSelectionError('Selecciona primero una factura para definir el cliente del cobro.')
        return
      }
    }
    if (allSelectableSelected) {
      setSelectedIds([])
    } else {
      setSelectedIds(selectableItems.map(item => item.settlement_item_id))
    }
    setSelectionError(null)
  }

  async function handleSaved() {
    const count = selectedItems.length
    setPaymentOpen(false)
    setSelectedIds([])
    setSuccess(`Cobro registrado para ${count} ${count === 1 ? 'factura' : 'facturas'}.`)
    setLoading(true)
    const response = await searchPostSettlementReceivables(query)
    if (response.error) setError(response.error)
    else setResults(response.data ?? [])
    setLoading(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 lg:p-5">
      <header className="shrink-0 rounded-xl border border-theme-border bg-theme-surface px-4 py-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-theme-text-muted">Cobros posteriores</p>
        <div className="mt-1 flex flex-col gap-1 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-bold text-theme-text">Facturas con saldo actual</h2>
            <p className="text-xs text-theme-text-muted">Selecciona facturas del mismo cliente y registra un único cobro sin modificar la Rendición cerrada.</p>
          </div>
          <div className="flex w-full gap-2 lg:w-[28rem]">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted" />
              <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === 'Enter' && void search()} placeholder="Factura, cliente o RUT..." className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-xs text-theme-text outline-none focus:border-theme-accent" />
            </div>
            <Button type="button" onClick={() => void search()} disabled={loading}>{loading ? 'Buscando...' : 'Buscar'}</Button>
          </div>
        </div>
      </header>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">{error}</p>}
      {selectionError && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">{selectionError}</p>}
      {success && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-300">{success}</p>}

      {selectedItems.length > 0 && (
        <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-theme-accent/30 bg-theme-accent/[0.045] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-5 text-xs">
            <div><span className="text-theme-text-muted">Facturas seleccionadas</span><strong className="ml-2 text-theme-text">{selectedItems.length}</strong></div>
            <div><span className="text-theme-text-muted">Saldo total</span><strong className="ml-2 text-base tabular-nums text-theme-text">{formatCurrency(selectedTotal)}</strong></div>
          </div>
          <Button type="button" onClick={() => setPaymentOpen(true)}>Registrar cobro</Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-theme-border bg-theme-surface">
        <table className="w-full min-w-[1080px] text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-theme-border bg-theme-surface text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
            <tr>
              <th className="w-36 px-4 py-3">
                <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap normal-case tracking-normal">
                  <input type="checkbox" checked={allSelectableSelected} onChange={toggleAll} aria-label="Seleccionar todas" className="h-3.5 w-3.5 accent-theme-accent" />
                  Seleccionar todas
                </label>
              </th>
              <th className="px-3 py-3">Factura</th>
              <th className="px-3 py-3">Cliente</th>
              <th className="px-3 py-3">Guía / Rendición</th>
              <th className="px-3 py-3 text-right">Original</th>
              <th className="px-3 py-3 text-right">En RR</th>
              <th className="px-3 py-3 text-right">Posterior</th>
              <th className="px-3 py-3 text-right">Saldo actual</th>
              <th className="px-4 py-3 text-right">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/70">
            {results.map(item => {
              const checked = selectedIds.includes(item.settlement_item_id)
              const belongsToAnotherCustomer = selectedCustomerId !== null && selectedCustomerId !== item.customer_bsale_id
              return (
                <tr key={item.settlement_item_id} className={`transition-colors ${checked ? 'bg-theme-accent/[0.045]' : 'hover:bg-theme-text/[0.025]'}`}>
                  <td className="px-4 py-3">
                    <label className={`inline-flex items-center gap-2 ${belongsToAnotherCustomer ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'}`} title={belongsToAnotherCustomer ? 'El cobro sólo puede incluir facturas del mismo cliente.' : undefined}>
                      <input type="checkbox" checked={checked} onChange={() => toggleItem(item)} aria-label={`Seleccionar factura ${item.invoice_number}`} aria-disabled={belongsToAnotherCustomer} className="h-3.5 w-3.5 accent-theme-accent" />
                      <span className="text-[10px] text-theme-text-muted">Incluir</span>
                    </label>
                  </td>
                  <td className="px-3 py-3 font-semibold text-theme-text">{item.invoice_number}</td>
                  <td className="px-3 py-3"><p className="font-semibold text-theme-text">{item.customer_name}</p><p className="text-[10px] text-theme-text-muted">{item.rut ?? `Cliente ${item.customer_bsale_id}`}</p></td>
                  <td className="px-3 py-3 text-theme-text-muted">{item.guide_number ?? '-'}<span className="block text-[10px]">{item.settlement_number}</span></td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(item.original_amount)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(item.during_settlement_confirmed)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(item.post_settlement_confirmed)}</td>
                  <td className="px-3 py-3 text-right font-bold tabular-nums text-amber-700 dark:text-amber-300">{formatCurrency(item.current_outstanding_amount)}</td>
                  <td className="px-4 py-3 text-right"><Button type="button" variant="ghost" size="sm" onClick={() => setDetailItem(item)}><Eye className="h-3.5 w-3.5" /> Ver</Button></td>
                </tr>
              )
            })}
            {!loading && results.length === 0 && <tr><td colSpan={9} className="px-4 py-12 text-center text-theme-text-muted">No hay facturas cerradas con saldo que coincidan con la búsqueda.</td></tr>}
          </tbody>
        </table>
      </div>

      <PostSettlementDetail item={detailItem} onClose={() => setDetailItem(null)} onChanged={async () => { setDetailItem(null); await search() }} />
      {paymentOpen && selectedItems.length > 0 && (
        <GroupedPostSettlementPaymentForm
          key={selectedIds.join(':')}
          items={selectedItems}
          open={paymentOpen}
          onOpenChange={setPaymentOpen}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}

function PostSettlementDetail({ item, onClose, onChanged }: { item: PostSettlementReceivable | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const [voiding, setVoiding] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  if (!item) return null

  async function voidPayment() {
    if (!voiding || !reason.trim()) return
    const response = await voidPostSettlementPayment(voiding, reason)
    if (!response.error) {
      setVoiding(null)
      setReason('')
      await onChanged()
    }
  }

  return (
    <>
      <Dialog open onOpenChange={open => !open && onClose()}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-3xl overflow-y-auto border-theme-border bg-theme-surface text-theme-text">
          <DialogHeader><DialogTitle>Factura {item.invoice_number}</DialogTitle><DialogDescription>{item.customer_name} · {item.guide_number ?? 'Guía'} · {item.settlement_number}</DialogDescription></DialogHeader>
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-theme-border p-3 sm:grid-cols-4"><Value label="Situación RR" value={item.resolution_type ?? 'Sin resolución'} /><Value label="Medio esperado" value={item.expected_payment_method} /><Value label="Monto factura" value={formatCurrency(item.original_amount)} /><Value label="Saldo actual" value={formatCurrency(item.current_outstanding_amount)} /></div>
            <div className="grid grid-cols-2 gap-3 rounded-lg bg-theme-text/[0.03] p-3 sm:grid-cols-3"><Value label="Cobrado en Rendición" value={formatCurrency(item.during_settlement_confirmed)} /><Value label="Cobrado posteriormente" value={formatCurrency(item.post_settlement_confirmed)} /><Value label="Estado" value={item.current_outstanding_amount > 0 ? 'Saldo pendiente' : 'Pagada'} /></div>
            <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">Este cobro no modifica la Rendición cerrada.</p>
            <section>
              <h3 className="mb-2 font-semibold">Historial de cobros posteriores</h3>
              {item.post_settlement_history.length === 0 ? <p className="rounded-lg border border-dashed border-theme-border px-3 py-4 text-center text-theme-text-muted">Sin cobros posteriores.</p> : (
                <div className="divide-y divide-theme-border rounded-lg border border-theme-border">
                  {item.post_settlement_history.map(payment => (
                    <div key={payment.payment_id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div><p className="font-semibold">{payment.payment_method_received} · {formatDate(payment.received_at)}</p><p className="text-[10px] text-theme-text-muted">Aplicado {formatCurrency(payment.amount_applied)} · {payment.verification_status}</p></div>
                      <div className="flex items-center gap-2"><span className="font-bold tabular-nums">{formatCurrency(payment.amount_received)}</span>{!payment.voided_at && <Button type="button" variant="ghost" size="sm" onClick={() => setVoiding(payment.payment_id)}><XCircle className="h-3.5 w-3.5" /> Anular</Button>}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={voiding !== null} onOpenChange={open => { if (!open) { setVoiding(null); setReason('') } }}>
        <DialogContent className="border-theme-border bg-theme-surface text-theme-text sm:max-w-md">
          <DialogHeader><DialogTitle>Anular cobro posterior</DialogTitle><DialogDescription>Las facturas vinculadas recuperarán el saldo aplicado por este cobro.</DialogDescription></DialogHeader>
          <label className="text-xs font-semibold">Motivo<textarea value={reason} onChange={event => setReason(event.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 font-normal outline-none focus:border-theme-accent" /></label>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setVoiding(null)}>Cancelar</Button><Button type="button" variant="destructive" disabled={!reason.trim()} onClick={() => void voidPayment()}>Anular cobro</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function GroupedPostSettlementPaymentForm({ items, open, onOpenChange, onSaved }: { items: PostSettlementReceivable[]; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const [method, setMethod] = useState<'CASH' | 'CHECK' | 'TRANSFER'>('CASH')
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().slice(0, 10))
  const [checkNumber, setCheckNumber] = useState('')
  const [bankName, setBankName] = useState('')
  const [checkDate, setCheckDate] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const customer = items[0]
  const total = items.reduce((sum, item) => sum + item.current_outstanding_amount, 0)

  async function submit() {
    if (!receivedDate) {
      setError('La fecha de ingreso es obligatoria.')
      return
    }
    if (method === 'CHECK' && (!bankName.trim() || !checkNumber.trim() || !checkDate)) {
      setError('Para cheque debes indicar banco, número y fecha del cheque.')
      return
    }
    setSaving(true)
    setError(null)
    const response = await registerGroupedPostSettlementPayment({
      customerBsaleId: customer.customer_bsale_id,
      settlementItemIds: items.map(item => item.settlement_item_id),
      paymentMethod: method,
      receivedAt: `${receivedDate}T12:00:00.000Z`,
      referenceNumber,
      bankName,
      checkNumber,
      checkDate,
      notes,
      idempotencyKey,
    })
    if (response.error) setError(response.error)
    else await onSaved()
    setSaving(false)
  }

  const fieldClassName = 'mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 font-normal text-theme-text outline-none transition-colors focus:border-theme-accent'
  const methodLabel = method === 'CASH' ? 'Efectivo' : method === 'CHECK' ? 'Cheque' : 'Transferencia'

  return (
    <Dialog open={open} onOpenChange={openValue => !saving && onOpenChange(openValue)}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-2rem)] flex-col overflow-hidden border-theme-border bg-theme-surface p-0 text-theme-text sm:max-w-[680px]">
        <DialogHeader className="border-b border-theme-border px-5 py-4 pr-12 sm:px-6">
          <DialogTitle className="text-lg">Registrar cobro posterior</DialogTitle>
          <DialogDescription className="mt-1 text-xs text-theme-text-muted"><span className="font-semibold text-theme-text">Cliente: {customer.customer_name}</span><span className="mx-2">·</span>{items.length} {items.length === 1 ? 'factura seleccionada' : 'facturas seleccionadas'}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 sm:px-6">
          <div className="flex items-end justify-between gap-4 border-b border-theme-border/70 pb-4">
            <div><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-theme-text-muted">Monto del cobro</p><p className="mt-0.5 text-2xl font-bold tabular-nums text-theme-text">{formatCurrency(total)}</p></div>
            <p className="max-w-[16rem] text-right text-[11px] leading-relaxed text-theme-text-muted">El backend recalculará el saldo exacto antes de registrar.</p>
          </div>

          <section>
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-theme-text-muted">Facturas incluidas</h3>
            <div className="divide-y divide-theme-border rounded-lg border border-theme-border">
              {items.map(item => <div key={item.settlement_item_id} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2 text-xs"><div><p className="font-semibold text-theme-text">Factura {item.invoice_number}</p><p className="text-[10px] text-theme-text-muted">{item.guide_number ?? 'Guía'} · {item.settlement_number}</p></div><span className="self-center font-bold tabular-nums">{formatCurrency(item.current_outstanding_amount)}</span></div>)}
            </div>
          </section>

          <section>
            <h3 className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-theme-text-muted">Datos del cobro</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-semibold text-theme-text">Medio recibido<select value={method} onChange={event => setMethod(event.target.value as typeof method)} className={fieldClassName}><option value="CASH">Efectivo</option><option value="CHECK">Cheque</option><option value="TRANSFER">Transferencia</option></select></label>
              <label className="block text-xs font-semibold text-theme-text">Fecha de ingreso / recepción<input type="date" value={receivedDate} onChange={event => setReceivedDate(event.target.value)} className={fieldClassName} /></label>
            </div>
          </section>

          {method === 'CHECK' && <section className="border-t border-theme-border/70 pt-4"><h3 className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-theme-text-muted">Datos del cheque</h3><div className="grid gap-3 sm:grid-cols-3"><label className="block text-xs font-semibold text-theme-text">Banco<input value={bankName} onChange={event => setBankName(event.target.value)} placeholder="Banco de Chile" className={fieldClassName} /></label><label className="block text-xs font-semibold text-theme-text">N.º de cheque<input value={checkNumber} onChange={event => setCheckNumber(event.target.value)} placeholder="475478" className={fieldClassName} /></label><label className="block text-xs font-semibold text-theme-text">Fecha del cheque<input type="date" value={checkDate} onChange={event => setCheckDate(event.target.value)} className={fieldClassName} /></label></div></section>}

          {method === 'TRANSFER' && <section className="border-t border-theme-border/70 pt-4"><h3 className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.12em] text-theme-text-muted">Datos de la transferencia</h3><label className="block text-xs font-semibold text-theme-text">Referencia / N.º de operación<input value={referenceNumber} onChange={event => setReferenceNumber(event.target.value)} placeholder="Referencia de la transferencia" className={fieldClassName} /><span className="mt-1 block text-[10px] font-normal text-theme-text-muted">La transferencia no genera fondo físico.</span></label></section>}

          <section className="border-t border-theme-border/70 pt-4"><div className="flex items-baseline justify-between gap-2"><label htmlFor="grouped-post-settlement-notes" className="text-xs font-semibold text-theme-text">Observación</label><span className="text-[10px] text-theme-text-muted">Opcional</span></div><textarea id="grouped-post-settlement-notes" value={notes} onChange={event => setNotes(event.target.value)} rows={2} className="mt-1 w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text outline-none transition-colors focus:border-theme-accent" /></section>

          <section className="rounded-lg border border-theme-border bg-theme-text/[0.025] p-3 text-xs"><h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-theme-text-muted">Confirmación</h3><div className="grid grid-cols-2 gap-x-4 gap-y-2"><Value label="Cliente" value={customer.customer_name} /><Value label="Facturas" value={items.map(item => item.invoice_number).join(', ')} /><Value label="Total" value={formatCurrency(total)} /><Value label="Medio" value={methodLabel} /></div></section>

          {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">{error}</p>}
        </div>

        <DialogFooter className="border-t border-theme-border px-5 py-3 sm:px-6"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button><Button type="button" onClick={() => void submit()} disabled={saving}>{saving ? 'Guardando...' : `Confirmar ${formatCurrency(total)}`}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Value({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-0.5 font-semibold text-theme-text">{value}</p></div>
}
