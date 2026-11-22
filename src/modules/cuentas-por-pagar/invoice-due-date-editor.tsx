'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, X } from 'lucide-react'
import { erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import type { ReceiptInvoiceCandidate } from './types'

export function InvoiceDueDateEditor({ row, dueDate, readOnlyReason, onSave, onClose }: {
  row: ReceiptInvoiceCandidate
  dueDate: string | null
  readOnlyReason: string | null
  onSave: (dueDate: string | null) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(dueDate ?? '')

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function save(event: React.FormEvent) {
    event.preventDefault()
    if (readOnlyReason) return
    onSave(draft || null)
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section role="dialog" aria-modal="true" aria-labelledby="cxp-due-date-title" className="w-full max-w-xs rounded-xl border border-theme-border bg-theme-surface p-4 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="cxp-due-date-title" className="flex items-center gap-1.5 text-sm font-bold text-theme-text"><CalendarDays className="h-4 w-4 text-theme-accent" /> Vencimiento</h2>
            <p className="mt-1 truncate text-xs text-theme-text-muted" title={row.supplier_name}>FA {row.folio ?? '—'} · {row.supplier_name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-md p-1 text-theme-text-muted hover:bg-theme-surface-hover hover:text-theme-text"><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={save} className="mt-4 space-y-3">
          <label htmlFor="cxp-due-date-input" className="block text-xs font-semibold text-theme-text">Fecha de vencimiento</label>
          <input id="cxp-due-date-input" type="date" autoFocus={!readOnlyReason} value={draft} disabled={Boolean(readOnlyReason)} onChange={event => setDraft(event.target.value)} className={cn(erpInputClass, 'h-9 w-full px-2.5 text-xs')} />
          {readOnlyReason ? <p className="text-xs text-theme-text-muted">{readOnlyReason}</p> : <button type="button" onClick={() => setDraft('')} className="text-xs font-semibold text-theme-accent hover:underline">Dejar sin fecha</button>}
          <div className="flex justify-end gap-2 border-t border-theme-border pt-3">
            <button type="button" onClick={onClose} className="h-8 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text hover:bg-theme-surface-hover">Cancelar</button>
            <button type="submit" disabled={Boolean(readOnlyReason)} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50">Guardar</button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  )
}
