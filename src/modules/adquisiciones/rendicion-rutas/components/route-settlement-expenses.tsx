'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { CalendarDays, Eye, FileText, Loader2, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react'
import Image from 'next/image'
import { toast } from 'sonner'
import {
  deleteRouteSettlementExpenseAttachment,
  getRouteSettlementExpenseAttachmentSignedUrl,
  getRouteSettlementExpenseUploadContext,
  saveRouteSettlementExpenseAttachment,
  upsertRouteSettlementExpense,
  voidRouteSettlementExpense,
  type RouteSettlementDetailExpense,
  type RouteSettlementExpenseType,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import { createClient } from '@/lib/supabase/client'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SETTLEMENT_ATTACHMENT_ALLOWED_MIMES, SETTLEMENT_ATTACHMENT_BUCKET, SETTLEMENT_ATTACHMENT_MAX_SIZE } from '../utils/settlement-attachment-config'
import { formatCurrency } from '../utils/route-settlement-formatters'

const EXPENSE_TYPES: { value: RouteSettlementExpenseType; label: string }[] = [
  { value: 'PEAJES', label: 'Peajes' },
  { value: 'COMBUSTIBLE', label: 'Combustible' },
  { value: 'VIATICOS', label: 'Viáticos' },
  { value: 'MANTENIMIENTO', label: 'Mantenimiento' },
  { value: 'OTROS', label: 'Otros' },
]

const MAX_FILE_SIZE = SETTLEMENT_ATTACHMENT_MAX_SIZE

function chileToday() {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function formatCivilDate(value: string) {
  const [year, month, day] = value.split('-')
  return year && month && day ? `${day}/${month}/${year}` : value
}

function normalizeAmount(value: string) {
  return value.replace(/\D/g, '')
}

function expenseLabel(value: RouteSettlementExpenseType) {
  return EXPENSE_TYPES.find(type => type.value === value)?.label ?? value
}

function attachmentAccept() {
  return SETTLEMENT_ATTACHMENT_ALLOWED_MIMES.join(',')
}

interface RouteSettlementExpensesProps {
  settlementId: string
  expenses: RouteSettlementDetailExpense[]
  total: number
  canModify: boolean
  onChanged: () => Promise<void>
}

export function RouteSettlementExpenses({ settlementId, expenses, total, canModify, onChanged }: RouteSettlementExpensesProps) {
  const [formOpen, setFormOpen] = useState(false)
  const [selectedExpense, setSelectedExpense] = useState<RouteSettlementDetailExpense | null>(null)
  const [editingExpense, setEditingExpense] = useState<RouteSettlementDetailExpense | null>(null)
  const [voidingExpense, setVoidingExpense] = useState<RouteSettlementDetailExpense | null>(null)

  return (
    <section className="mt-6 rounded-xl border border-theme-border bg-theme-surface/70 p-4 lg:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-bold text-theme-text">Gastos de ruta</h2>
          <p className="mt-0.5 text-xs text-theme-text-muted">Gastos asociados a esta rendición, independientes de los pagos de clientes.</p>
        </div>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <div className="text-left sm:text-right">
            <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Total gastos</p>
            <p className="text-base font-bold tabular-nums text-theme-text">{formatCurrency(Number(total) || 0)}</p>
          </div>
          {canModify && <button type="button" onClick={() => setFormOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"><Plus className="h-3.5 w-3.5" /> Registrar gasto</button>}
        </div>
      </div>

      {expenses.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-theme-border px-4 py-5 text-center text-xs text-theme-text-muted">No hay gastos de ruta registrados.</div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-theme-border">
          <table className="w-full min-w-[580px] text-left text-xs">
            <thead className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted"><tr><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Fecha</th><th className="px-3 py-2 text-right">Monto</th><th className="px-3 py-2">Comprobante</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2 text-right">Acción</th></tr></thead>
            <tbody className="divide-y divide-theme-border/70">
              {expenses.map(expense => <tr key={expense.id} className="hover:bg-theme-text/[0.025]">
                <td className="px-3 py-2.5 font-semibold text-theme-text">{expenseLabel(expense.expense_type)}</td>
                <td className="px-3 py-2.5 tabular-nums text-theme-text-muted">{formatCivilDate(expense.expense_date)}</td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text">{formatCurrency(Number(expense.amount) || 0)}</td>
                <td className="px-3 py-2.5">{expense.attachments?.length ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Paperclip className="h-3.5 w-3.5" /> Sí</span> : <span className="text-theme-text-muted">No</span>}</td>
                <td className="px-3 py-2.5"><span className={expense.status === 'VOIDED' ? 'rounded-full border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300' : 'rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300'}>{expense.status === 'VOIDED' ? 'Anulado' : 'Activo'}</span></td>
                <td className="px-3 py-2.5 text-right"><button type="button" onClick={() => setSelectedExpense(expense)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"><Eye className="h-3.5 w-3.5" /> Ver</button></td>
              </tr>)}
            </tbody>
          </table>
        </div>
      )}

      <ExpenseFormDialog key={editingExpense?.id ?? 'new-expense'} settlementId={settlementId} expense={editingExpense} open={formOpen} onOpenChange={open => { setFormOpen(open); if (!open) setEditingExpense(null) }} onSaved={async notice => { setFormOpen(false); setEditingExpense(null); if (notice) toast.warning(notice); await onChanged() }} />
      <ExpenseDetailDialog expense={selectedExpense} canModify={canModify} onOpenChange={open => !open && setSelectedExpense(null)} onEdit={() => { if (selectedExpense?.status === 'ACTIVE') { setEditingExpense(selectedExpense); setSelectedExpense(null); setFormOpen(true) } }} onVoid={() => { if (selectedExpense?.status === 'ACTIVE') { setVoidingExpense(selectedExpense); setSelectedExpense(null) } }} onChanged={onChanged} />
      <VoidExpenseDialog expense={voidingExpense} open={voidingExpense !== null} onOpenChange={open => !open && setVoidingExpense(null)} onVoided={async () => { setVoidingExpense(null); await onChanged() }} />
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block text-xs font-semibold text-theme-text"><span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</span>{children}</label> }
const inputClass = 'h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-accent'

function ExpenseFormDialog({ settlementId, expense, open, onOpenChange, onSaved }: { settlementId: string; expense: RouteSettlementDetailExpense | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: (notice?: string) => Promise<void> }) {
  const [type, setType] = useState<RouteSettlementExpenseType>(expense?.expense_type ?? 'PEAJES')
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '')
  const [date, setDate] = useState(expense?.expense_date ?? chileToday())
  const [notes, setNotes] = useState(expense?.notes ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    setError(null)
    if (!amount || Number(amount) <= 0 || !date) { setError('Completa tipo, monto y fecha.'); return }
    if (file && (file.size <= 0 || file.size > MAX_FILE_SIZE)) { setError('El comprobante debe pesar entre 1 byte y 10 MB.'); return }
    if (file && !(SETTLEMENT_ATTACHMENT_ALLOWED_MIMES as readonly string[]).includes(file.type)) { setError('Tipo de archivo no permitido. Usa PDF, PNG, JPEG o WEBP.'); return }
    setSaving(true)
    const result = await upsertRouteSettlementExpense({ settlementId, expenseId: expense?.id, expenseType: type, amount: normalizeAmount(amount), expenseDate: date, notes })
    if (result.error || !result.data) { setError(result.error ?? 'No se pudo guardar el gasto.'); setSaving(false); return }
    const expenseId = (result.data as { id?: string }).id ?? expense?.id
    if (!expenseId || !file) { setSaving(false); await onSaved(); return }

    const context = await getRouteSettlementExpenseUploadContext(settlementId)
    if (context.error || !context.data) { setSaving(false); await onSaved(`El gasto quedó registrado, pero el comprobante no pudo cargarse: ${context.error ?? 'no se pudo obtener la ruta.'}`); return }
    const safeName = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9.-]/g, '_')
    const filePath = `${context.data.companyId}/rendicion-rutas/${settlementId}/expenses/${expenseId}/${Date.now()}-${safeName}`
    const sb = createClient()
    const upload = await sb.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).upload(filePath, file, { cacheControl: '3600', upsert: false })
    if (upload.error) { setSaving(false); await onSaved(`El gasto quedó registrado, pero el comprobante no pudo cargarse: ${upload.error.message}`); return }
    const metadata = await saveRouteSettlementExpenseAttachment({ expenseId, settlementId, filePath, fileName: file.name, fileMimeType: file.type, fileSize: file.size })
    if (metadata.error) { await sb.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).remove([filePath]); setSaving(false); await onSaved(`El gasto quedó registrado, pero el comprobante no pudo cargarse: ${metadata.error}`); return }
    if (expense?.attachments?.length) {
      await Promise.all(expense.attachments.map(attachment => deleteRouteSettlementExpenseAttachment(attachment.id)))
    }
    setSaving(false)
    await onSaved()
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-lg border-theme-border bg-theme-surface text-theme-text"><DialogHeader><DialogTitle className="text-theme-text">{expense ? 'Editar gasto de ruta' : 'Registrar gasto de ruta'}</DialogTitle><DialogDescription className="text-theme-text-muted">El gasto quedará asociado a esta rendición.</DialogDescription></DialogHeader><div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><Field label="Tipo de gasto"><select value={type} onChange={event => setType(event.target.value as RouteSettlementExpenseType)} className={inputClass}>{EXPENSE_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field><Field label="Monto"><input inputMode="numeric" value={amount ? Number(amount).toLocaleString('es-CL') : ''} onChange={event => setAmount(normalizeAmount(event.target.value))} placeholder="$ 20.000" className={inputClass} /></Field></div><Field label="Fecha"><div className="relative"><CalendarDays className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-theme-text-muted" /><input type="date" value={date} onChange={event => setDate(event.target.value)} className={`${inputClass} pl-9`} /></div></Field><Field label="Observación"><textarea value={notes} onChange={event => setNotes(event.target.value)} rows={3} placeholder="Ej: QA peaje ruta" className="w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" /></Field><Field label="Comprobante"><input type="file" accept={attachmentAccept()} onChange={event => setFile(event.target.files?.[0] ?? null)} className="block w-full text-xs text-theme-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-theme-text/5 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-theme-text" /><span className="mt-1 block text-[11px] font-normal text-theme-text-muted">PDF, PNG, JPEG o WEBP. Máximo 10 MB.{expense?.attachments?.length ? ' Selecciona uno nuevo para reemplazar el actual.' : ''}</span></Field>{error && <p className="rounded-lg border border-red-300/40 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/20 dark:text-red-300">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={() => onOpenChange(false)} className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:text-theme-text">Cancelar</button><button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-theme-accent px-3 py-2 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50">{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{saving ? 'Guardando...' : 'Guardar gasto'}</button></div></div></DialogContent></Dialog>
}

function ExpenseDetailDialog({ expense, canModify, onOpenChange, onEdit, onVoid, onChanged }: { expense: RouteSettlementDetailExpense | null; canModify: boolean; onOpenChange: (open: boolean) => void; onEdit: () => void; onVoid: () => void; onChanged: () => Promise<void> }) {
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<RouteSettlementDetailExpense['attachments'][number] | null>(null)

  async function removeAttachment(id: string) {
    if (!window.confirm('¿Eliminar este comprobante?')) return
    setAttachmentBusy(true)
    const result = await deleteRouteSettlementExpenseAttachment(id)
    setAttachmentBusy(false)
    if (result.error) { toast.error(result.error); return }
    onOpenChange(false)
    await onChanged()
  }

  return <>
    <Dialog open={expense !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden border-theme-border bg-theme-surface text-theme-text">
        <DialogHeader>
          <DialogTitle className="text-theme-text">Detalle del gasto</DialogTitle>
          <DialogDescription className="text-theme-text-muted">Información registrada en la rendición.</DialogDescription>
        </DialogHeader>
        {expense && <div className="min-w-0 space-y-4 overflow-hidden text-sm">
          <div className="grid grid-cols-2 gap-4"><Detail label="Tipo" value={expenseLabel(expense.expense_type)} /><Detail label="Fecha" value={formatCivilDate(expense.expense_date)} /><Detail label="Monto" value={formatCurrency(Number(expense.amount) || 0)} /><Detail label="Estado" value={expense.status === 'VOIDED' ? 'Anulado' : 'Activo'} /></div>
          <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Observación</p><p className="mt-1 whitespace-pre-wrap break-words text-theme-text">{expense.notes || 'Sin observación'}</p></div>
          <div className="min-w-0"><p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Comprobante</p>{expense.attachments?.length ? expense.attachments.map(attachment => <div key={attachment.id} className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-theme-border px-3 py-2 text-xs">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-theme-text"><FileText className="h-4 w-4 shrink-0 text-theme-text-muted" /><span className="block min-w-0 flex-1 truncate" title={attachment.file_name}>{attachment.file_name}</span></div>
            <div className="flex shrink-0 items-center gap-1"><button type="button" disabled={attachmentBusy} onClick={() => setPreviewAttachment(attachment)} className="rounded-md px-2 py-1 font-semibold text-theme-accent hover:bg-theme-accent/10">Ver</button>{canModify && expense.status === 'ACTIVE' && <button type="button" disabled={attachmentBusy} onClick={() => removeAttachment(attachment.id)} className="rounded-md p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20" aria-label="Eliminar comprobante"><Trash2 className="h-3.5 w-3.5" /></button>}</div>
          </div>) : <p className="rounded-lg border border-dashed border-theme-border px-3 py-3 text-xs text-theme-text-muted">Sin comprobante. Puedes adjuntarlo editando el gasto.</p>}</div>
          {expense.status === 'VOIDED' && expense.void_reason && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">Motivo de anulación: {expense.void_reason}</div>}
          {canModify && expense.status === 'ACTIVE' && <div className="flex flex-wrap justify-end gap-2 border-t border-theme-border pt-4"><button type="button" onClick={onEdit} className="inline-flex items-center gap-1.5 rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5"><Pencil className="h-3.5 w-3.5" /> Editar</button><button type="button" onClick={onVoid} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/20"><X className="h-3.5 w-3.5" /> Anular gasto</button></div>}
        </div>}
      </DialogContent>
    </Dialog>
    <ExpenseAttachmentPreview key={previewAttachment?.id ?? 'closed'} attachment={previewAttachment} onOpenChange={open => !open && setPreviewAttachment(null)} />
  </>
}

function ExpenseAttachmentPreview({ attachment, onOpenChange }: { attachment: RouteSettlementDetailExpense['attachments'][number] | null; onOpenChange: (open: boolean) => void }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(attachment))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!attachment) return
    let active = true
    getRouteSettlementExpenseAttachmentSignedUrl(attachment.id).then(result => {
      if (!active) return
      if (result.error || !result.data) setError(result.error ?? 'No se pudo generar la URL del comprobante.')
      else setSignedUrl(result.data.signedUrl)
      setLoading(false)
    })
    return () => { active = false }
  }, [attachment])

  const mimeType = attachment?.file_mime_type ?? ''
  const isImage = mimeType.startsWith('image/')

  return <Dialog open={attachment !== null} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} className="flex h-[90vh] max-h-[90vh] w-[90vw] max-w-[90vw] flex-col gap-3 overflow-hidden border-theme-border bg-theme-surface p-4 text-theme-text sm:p-5">
      <div className="flex min-w-0 items-center gap-3 border-b border-theme-border pb-3 pr-10">
        <div className="min-w-0 flex-1"><DialogTitle className="text-theme-text">Vista previa del comprobante</DialogTitle><p className="mt-1 truncate text-xs text-theme-text-muted" title={attachment?.file_name}>{attachment?.file_name}</p></div>
        <button type="button" onClick={() => onOpenChange(false)} className="shrink-0 rounded-lg p-1.5 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text" aria-label="Cerrar vista previa"><X className="h-5 w-5" /></button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-theme-border bg-theme-text/[0.03] p-2 sm:p-4">
        {loading && <div className="flex items-center gap-2 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Cargando comprobante...</div>}
        {error && <p className="max-w-md text-center text-sm text-red-700 dark:text-red-300">{error}</p>}
        {signedUrl && isImage && <Image src={signedUrl} alt={attachment?.file_name ?? 'Comprobante'} width={1600} height={1200} unoptimized className="max-h-full max-w-full object-contain" />}
        {signedUrl && !isImage && <iframe src={signedUrl} title={attachment?.file_name ?? 'Comprobante PDF'} className="h-full min-h-0 w-full border-0" />}
      </div>
    </DialogContent>
  </Dialog>
}

function Detail({ label, value }: { label: string; value: string }) { return <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-1 font-semibold text-theme-text">{value}</p></div> }

function VoidExpenseDialog({ expense, open, onOpenChange, onVoided }: { expense: RouteSettlementDetailExpense | null; open: boolean; onOpenChange: (open: boolean) => void; onVoided: () => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  async function submit() { if (!reason.trim()) { setError('El motivo de anulación es obligatorio.'); return }; setSaving(true); const result = await voidRouteSettlementExpense(expense?.id ?? '', reason); setSaving(false); if (result.error) { setError(result.error); return }; setReason(''); setError(null); await onVoided() }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-md border-theme-border bg-theme-surface text-theme-text"><DialogHeader><DialogTitle className="text-theme-text">Anular gasto</DialogTitle><DialogDescription className="text-theme-text-muted">Este gasto dejará de considerarse en el total de gastos de la ruta, pero permanecerá en el historial.</DialogDescription></DialogHeader><div className="space-y-4"><Field label="Motivo obligatorio"><textarea autoFocus value={reason} onChange={event => setReason(event.target.value)} rows={3} className="w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" placeholder="Indica el motivo de anulación" /></Field>{error && <p className="text-xs text-red-600 dark:text-red-300">{error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={() => onOpenChange(false)} className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted">Cancelar</button><button type="button" onClick={submit} disabled={saving} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50">{saving ? 'Anulando...' : 'Anular gasto'}</button></div></div></DialogContent></Dialog>
}
