'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Download, Eye, FileText, Loader2, Plus, Trash2, X } from 'lucide-react'
import {
  deleteRouteFundClosureDepositAttachment,
  getRouteFundClosureDepositAttachmentSignedUrl,
  getRouteFundClosureDepositSummary,
  registerRouteFundClosureDeposit,
  saveRouteFundClosureDepositAttachment,
  voidRouteFundClosureDeposit,
} from '@/app/actions/adquisiciones/route-fund-closures'
import type { RouteFundClosureDeposit, RouteFundClosureDepositSummary } from '../fund-closures-types'
import { formatCivilDate, todayInSantiago } from '@/lib/datetime'
import { toast } from 'sonner'

function money(value: number) {
  return `$${Number(value || 0).toLocaleString('es-CL')}`
}

function depositMethodLabel(method: RouteFundClosureDeposit['deposit_method']) {
  return method === 'DEPOSIT' ? 'Depósito bancario' : method === 'CASH_DELIVERY' ? 'Entrega de efectivo' : method === 'TRANSFER' ? 'Transferencia' : 'Otro'
}

interface FundClosureDepositsProps {
  closureId: string
}

export function FundClosureDeposits({ closureId }: FundClosureDepositsProps) {
  const [summary, setSummary] = useState<RouteFundClosureDepositSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedDeposit, setSelectedDeposit] = useState<RouteFundClosureDeposit | null>(null)
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const response = await getRouteFundClosureDepositSummary(closureId)
    if (response.error) setError(response.error)
    else { setSummary(response.data); setError(null) }
    setLoading(false)
  }

  useEffect(() => {
    let active = true
    getRouteFundClosureDepositSummary(closureId)
      .then(response => {
        if (!active) return
        if (response.error) setError(response.error)
        else { setSummary(response.data); setError(null) }
      })
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [closureId])

  async function openAttachment(attachmentId: string) {
    const response = await getRouteFundClosureDepositAttachmentSignedUrl(attachmentId)
    if (response.error || !response.data) { toast.error(response.error ?? 'No se pudo abrir el comprobante.'); return }
    setPreview({ url: response.data.signedUrl, name: response.data.fileName, mime: response.data.mimeType })
  }

  async function deleteAttachment(attachmentId: string) {
    if (!window.confirm('¿Eliminar este comprobante?')) return
    const response = await deleteRouteFundClosureDepositAttachment(attachmentId)
    if (response.error) toast.error(response.error)
    else { toast.success('Comprobante eliminado.'); await load() }
  }

  if (loading && !summary) return <section className="rounded-xl border border-theme-border bg-theme-surface p-4"><div className="flex items-center gap-2 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Cargando depósitos...</div></section>
  if (!summary) return <section className="rounded-xl border border-theme-border bg-theme-surface p-4 text-sm text-red-600">{error ?? 'No se pudo cargar Depósitos.'}</section>

  return (
    <>
      <section className="flex flex-col gap-3 rounded-xl border border-theme-border bg-theme-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><h3 className="font-bold text-theme-text">Depósitos</h3><p className="mt-0.5 text-xs text-theme-text-muted">Etapa posterior a la entrega física del Cierre de Fondos.</p></div>
          <button type="button" onClick={() => setModalOpen(true)} disabled={summary.saldo_por_depositar <= 0} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-theme-accent px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-45"><Plus className="h-3.5 w-3.5" />Registrar depósito</button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <DepositTotal label="Total físico recibido" value={summary.total_fisico_recibido} />
          <DepositTotal label="Total depositado" value={summary.total_depositado} />
          <DepositTotal label="Saldo por depositar" value={summary.saldo_por_depositar} emphasized={summary.saldo_por_depositar > 0} />
        </div>
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="overflow-x-auto rounded-lg border border-theme-border">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="border-b border-theme-border bg-theme-text/[0.04] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted"><tr><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Método</th><th className="px-3 py-2">Referencia</th><th className="px-3 py-2 text-right">Monto</th><th className="px-3 py-2">Comprobante</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2 text-right">Acción</th></tr></thead>
            <tbody className="divide-y divide-theme-border">
              {summary.deposits.map(deposit => {
                const attachments = deposit.attachments ?? []
                return <tr key={deposit.id} className="hover:bg-theme-text/[0.02]"><td className="px-3 py-2 text-theme-text-muted">{formatCivilDate(deposit.deposit_date)}</td><td className="px-3 py-2 font-semibold text-theme-text">{depositMethodLabel(deposit.deposit_method)}</td><td className="px-3 py-2 text-theme-text-muted">{deposit.reference_number ?? '-'}</td><td className="px-3 py-2 text-right font-mono font-bold text-theme-text">{money(deposit.amount)}</td><td className="px-3 py-2"><div className="flex flex-wrap items-center gap-1.5">{attachments.length === 0 ? <span className="text-theme-text-muted">-</span> : attachments.map(attachment => <span key={attachment.id} className="inline-flex items-center gap-1"><button type="button" onClick={() => void openAttachment(attachment.id)} className="inline-flex max-w-[12rem] items-center gap-1 truncate rounded px-1.5 py-1 font-semibold text-theme-accent hover:bg-theme-accent/10" title={attachment.file_name}><Eye className="h-3 w-3 shrink-0" />{attachment.file_name}</button><button type="button" onClick={() => void deleteAttachment(attachment.id)} className="rounded p-1 text-theme-text-muted hover:bg-red-50 hover:text-red-600" aria-label={`Eliminar ${attachment.file_name}`}><Trash2 className="h-3 w-3" /></button></span>)}</div></td><td className="px-3 py-2"><span className={`rounded px-1.5 py-1 text-[10px] font-bold ${deposit.status === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-theme-text/10 text-theme-text-muted'}`}>{deposit.status === 'ACTIVE' ? 'Activo' : 'Anulado'}</span></td><td className="px-3 py-2 text-right"><button type="button" onClick={() => setSelectedDeposit(deposit)} className="rounded px-2 py-1 font-semibold text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text">Ver</button>{deposit.status === 'ACTIVE' && <button type="button" onClick={() => setSelectedDeposit(deposit)} className="ml-1 rounded px-2 py-1 font-semibold text-red-600 hover:bg-red-50">Anular</button>}</td></tr>
              })}
              {summary.deposits.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-theme-text-muted">No hay depósitos registrados.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {modalOpen && <DepositForm summary={summary} closureId={closureId} onClose={() => setModalOpen(false)} onSaved={async () => { setModalOpen(false); await load() }} />}
       {selectedDeposit && <DepositDetail deposit={selectedDeposit} onClose={() => setSelectedDeposit(null)} onChanged={async () => { setSelectedDeposit(null); await load() }} onOpenAttachment={openAttachment} />}
      {preview && <PreviewModal preview={preview} onClose={() => setPreview(null)} />}
    </>
  )
}

function DepositTotal({ label, value, emphasized = false }: { label: string; value: number; emphasized?: boolean }) {
  return <div className={`rounded-lg border px-3 py-2.5 ${emphasized ? 'border-theme-accent/40 bg-theme-accent/[0.06]' : 'border-theme-border'}`}><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className={`mt-0.5 font-mono text-lg font-bold tabular-nums ${emphasized ? 'text-theme-accent' : 'text-theme-text'}`}>{money(value)}</p></div>
}

function DepositForm({ summary, closureId, onClose, onSaved }: { summary: RouteFundClosureDepositSummary; closureId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayInSantiago())
  const [method, setMethod] = useState<'DEPOSIT' | 'CASH_DELIVERY' | 'TRANSFER' | 'OTHER'>('DEPOSIT')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const maxAmount = summary.saldo_por_depositar

  async function submit(event: FormEvent) {
    event.preventDefault()
    const numericAmount = Number(amount)
    if (!Number.isInteger(numericAmount) || numericAmount <= 0 || numericAmount > maxAmount) { setError(`Ingresa un monto entre $1 y ${money(maxAmount)}.`); return }
    setSaving(true); setError(null)
    const response = await registerRouteFundClosureDeposit({ fundClosureId: closureId, amount: numericAmount, depositDate: date, depositMethod: method, referenceNumber: reference, notes })
    if (response.error || !response.data) { setError(response.error ?? 'No se pudo registrar el depósito.'); setSaving(false); return }
    if (file) {
      const formData = new FormData(); formData.set('file', file)
      const attachment = await saveRouteFundClosureDepositAttachment(response.data.deposit_id, closureId, formData)
      if (attachment.error) { toast.error(`Depósito registrado, pero no se pudo guardar el comprobante: ${attachment.error}`) }
    }
    toast.success('Depósito registrado.')
    await onSaved()
    setSaving(false)
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><form onSubmit={submit} className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl"><div className="flex items-start justify-between border-b border-theme-border px-5 py-4"><div><h3 className="font-bold text-theme-text">Registrar depósito</h3><p className="mt-0.5 text-xs text-theme-text-muted">Saldo disponible: <strong className="text-theme-text">{money(maxAmount)}</strong></p></div><button type="button" onClick={onClose} className="rounded p-1 text-theme-text-muted hover:bg-theme-text/10" aria-label="Cerrar"><X className="h-4 w-4" /></button></div><div className="grid gap-3 overflow-y-auto p-5 text-xs"><label className="font-semibold text-theme-text">Monto<input type="number" min="1" max={maxAmount} step="1" required value={amount} onChange={event => setAmount(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 font-mono outline-none focus:border-theme-accent" /></label><div className="grid gap-3 sm:grid-cols-2"><label className="font-semibold text-theme-text">Fecha del depósito<input type="date" required value={date} onChange={event => setDate(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 outline-none focus:border-theme-accent" /></label><label className="font-semibold text-theme-text">Método<select value={method} onChange={event => setMethod(event.target.value as typeof method)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 outline-none focus:border-theme-accent"><option value="DEPOSIT">Depósito bancario</option><option value="CASH_DELIVERY">Entrega de efectivo</option><option value="TRANSFER">Transferencia</option><option value="OTHER">Otro</option></select></label></div><label className="font-semibold text-theme-text">N.º comprobante / referencia<input value={reference} onChange={event => setReference(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 outline-none focus:border-theme-accent" /></label><label className="font-semibold text-theme-text">Comprobante<span className="mt-1 block"><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={event => setFile(event.target.files?.[0] ?? null)} className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs file:mr-3 file:rounded file:border-0 file:bg-theme-text/10 file:px-2 file:py-1 file:text-xs" /></span><span className="mt-1 block font-normal text-[10px] text-theme-text-muted">PDF, PNG, JPEG o WEBP · máximo 10 MB.</span></label><label className="font-semibold text-theme-text">Observación<textarea rows={2} value={notes} onChange={event => setNotes(event.target.value)} className="mt-1 w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 font-normal outline-none focus:border-theme-accent" /></label>{error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}</div><div className="flex justify-end gap-2 border-t border-theme-border px-5 py-3"><button type="button" onClick={onClose} disabled={saving} className="rounded-lg border border-theme-border px-4 py-2 text-xs font-bold text-theme-text">Cancelar</button><button type="submit" disabled={saving} className="rounded-lg bg-theme-accent px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{saving ? 'Guardando...' : 'Guardar depósito'}</button></div></form></div>
}

function DepositDetail({ deposit, onClose, onChanged, onOpenAttachment }: { deposit: RouteFundClosureDeposit; onClose: () => void; onChanged: () => Promise<void>; onOpenAttachment: (id: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [confirmingVoid, setConfirmingVoid] = useState(false)
  const [saving, setSaving] = useState(false)
  async function voidDeposit() {
    if (!reason.trim()) return
    setSaving(true)
    const response = await voidRouteFundClosureDeposit(deposit.id, reason)
    if (response.error) toast.error(response.error)
    else { toast.success('Depósito anulado.'); await onChanged() }
    setSaving(false)
  }
  return <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-4"><div className="w-full max-w-lg rounded-xl border border-theme-border bg-theme-surface shadow-2xl"><div className="flex items-start justify-between border-b border-theme-border px-5 py-4"><div><h3 className="font-bold text-theme-text">Detalle del depósito</h3><p className="mt-0.5 text-xs text-theme-text-muted">{depositMethodLabel(deposit.deposit_method)} · {formatCivilDate(deposit.deposit_date)}</p></div><button type="button" onClick={onClose} className="rounded p-1 text-theme-text-muted hover:bg-theme-text/10" aria-label="Cerrar"><X className="h-4 w-4" /></button></div><div className="grid grid-cols-2 gap-3 p-5 text-xs"><Info label="Monto" value={money(deposit.amount)} /><Info label="Referencia" value={deposit.reference_number ?? '-'} /><Info label="Estado" value={deposit.status === 'ACTIVE' ? 'Activo' : 'Anulado'} /><Info label="Fecha" value={formatCivilDate(deposit.deposit_date)} /><div className="col-span-2"><Info label="Observación" value={deposit.notes ?? '-'} /></div><div className="col-span-2"><p className="mb-1 font-bold text-theme-text-muted">Comprobantes</p>{deposit.attachments.length === 0 ? <p className="text-theme-text-muted">Sin comprobantes.</p> : deposit.attachments.map(attachment => <div key={attachment.id} className="flex items-center justify-between gap-2 py-1"><span className="flex min-w-0 items-center gap-1 truncate"><FileText className="h-3.5 w-3.5 shrink-0" />{attachment.file_name}</span><button type="button" onClick={() => void onOpenAttachment(attachment.id)} className="font-semibold text-theme-accent">Ver</button></div>)}</div></div>{confirmingVoid && deposit.status === 'ACTIVE' && <div className="border-t border-red-200 bg-red-50/50 px-5 py-3"><label className="text-xs font-semibold text-theme-text">Motivo obligatorio<textarea value={reason} onChange={event => setReason(event.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 font-normal outline-none focus:border-theme-accent" /></label></div>}<div className="flex justify-end gap-2 border-t border-theme-border px-5 py-3">{deposit.status === 'ACTIVE' && !confirmingVoid && <button type="button" onClick={() => setConfirmingVoid(true)} className="mr-auto rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-600">Anular</button>}{confirmingVoid && <><button type="button" onClick={() => setConfirmingVoid(false)} disabled={saving} className="rounded-lg border border-theme-border px-3 py-2 text-xs font-bold text-theme-text">Cancelar</button><button type="button" onClick={() => void voidDeposit()} disabled={saving || !reason.trim()} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{saving ? 'Anulando...' : 'Confirmar anulación'}</button></>} {!confirmingVoid && <button type="button" onClick={onClose} className="rounded-lg border border-theme-border px-3 py-2 text-xs font-bold text-theme-text">Cerrar</button>}</div></div></div>
}

function PreviewModal({ preview, onClose }: { preview: { url: string; name: string; mime: string | null }; onClose: () => void }) {
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4"><div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface"><div className="flex items-center justify-between border-b border-theme-border px-4 py-3"><p className="truncate text-sm font-bold text-theme-text">{preview.name}</p><div className="flex items-center gap-1"><a href={preview.url} download={preview.name} className="rounded p-2 text-theme-text-muted hover:bg-theme-text/10" title="Descargar"><Download className="h-4 w-4" /></a><button type="button" onClick={onClose} className="rounded p-2 text-theme-text-muted hover:bg-theme-text/10" aria-label="Cerrar"><X className="h-4 w-4" /></button></div></div><div className="flex min-h-0 flex-1 items-center justify-center bg-theme-text/[0.04] p-4">{preview.mime === 'application/pdf' ? <iframe src={preview.url} title={preview.name} className="h-full w-full rounded border border-theme-border bg-white" /> : preview.mime?.startsWith('image/') ? <img src={preview.url} alt={preview.name} className="max-h-full max-w-full object-contain" /> : <div className="text-center text-sm text-theme-text-muted">Vista previa no disponible. Descarga el archivo para abrirlo.</div>}</div></div></div>
}

function Info({ label, value }: { label: string; value: string }) { return <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-0.5 font-semibold text-theme-text">{value}</p></div> }
