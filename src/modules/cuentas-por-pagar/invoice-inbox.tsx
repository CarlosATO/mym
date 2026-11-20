'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Search } from 'lucide-react'
import { incorporateReceiptInvoices } from '@/app/actions/cuentas-por-pagar'
import type { ReceiptInvoiceCandidate } from './types'

const money = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 })

export function InvoiceInbox({ initialCandidates }: { initialCandidates: ReceiptInvoiceCandidate[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('ALL')
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()
  const rows = useMemo(() => initialCandidates.filter(row => {
    const state = !row.invoice_id ? 'NEW' : row.invoice_status === 'PENDING' ? 'PENDING' : 'OTHER'
    return (status === 'ALL' || status === state) && [row.supplier_name, row.issuer_rut, row.folio, ...row.purchase_orders].join(' ').toLocaleLowerCase('es-CL').includes(search.toLocaleLowerCase('es-CL').trim())
  }), [initialCandidates, search, status])

  function submit() {
    setMessage('')
    startTransition(async () => {
      try {
        const result = await incorporateReceiptInvoices(selected)
        setSelected([])
        setMessage(`${result.count} factura(s) incorporada(s) o ya incorporada(s).`)
        router.refresh()
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'No fue posible incorporar las facturas.')
      }
    })
  }

  return <section className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-xl font-semibold text-theme-text">Cuentas por Pagar</h1><p className="mt-1 text-sm text-theme-text-muted">Facturas detectadas en recepciones de Caylo</p></div>
      <button type="button" onClick={submit} disabled={pending || selected.length === 0} className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{pending ? 'Incorporando…' : `Incorporar seleccionadas (${selected.length})`}</button>
    </header>
    <p className="text-xs text-theme-text-muted">El monto de recepción es una referencia calculada; no es deuda confirmada ni importe real de factura.</p>
    <div className="flex flex-wrap gap-3 rounded-xl border border-theme-border bg-theme-surface p-4">
      <label className="relative min-w-[220px] flex-1"><span className="sr-only">Buscar proveedor, RUT, folio u OC</span><Search className="absolute left-3 top-2.5 h-4 w-4 text-theme-text-muted" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar proveedor, RUT, folio u OC" className="w-full rounded-lg border border-theme-border bg-transparent py-2 pl-9 pr-3 text-sm text-theme-text" /></label>
      <label><span className="sr-only">Filtrar por estado</span><select value={status} onChange={e => setStatus(e.target.value)} className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text"><option value="ALL">Todos los estados</option><option value="NEW">Por incorporar</option><option value="PENDING">Pendiente de validación</option></select></label>
    </div>
    {message && <p role="status" className="rounded-lg border border-theme-border bg-theme-surface p-3 text-sm text-theme-text">{message}</p>}
    <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface">
      <table className="w-full min-w-[800px] text-left text-sm"><thead className="border-b border-theme-border text-xs uppercase text-theme-text-muted"><tr><th className="p-3"><span className="sr-only">Seleccionar</span></th><th className="p-3">Proveedor</th><th className="p-3">Factura</th><th className="p-3">Fecha</th><th className="p-3">OC</th><th className="p-3 text-right">Referencia recepción</th><th className="p-3">Documento</th><th className="p-3">Estado</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.candidate_id} className="border-b border-theme-border last:border-0">
          <td className="p-3"><input type="checkbox" aria-label={`Seleccionar factura ${row.folio ?? 'sin folio'} de ${row.supplier_name}`} checked={selected.includes(row.candidate_id)} disabled={pending || !!row.blocked_reason} onChange={e => setSelected(current => e.target.checked ? [...current, row.candidate_id] : current.filter(id => id !== row.candidate_id))} /></td>
          <td className="p-3"><div className="font-medium text-theme-text">{row.supplier_name}</div><div className="text-xs text-theme-text-muted">{row.issuer_rut || 'Sin RUT'}</div></td>
          <td className="p-3 text-theme-text">FA {row.folio ?? '—'}</td><td className="p-3 text-theme-text">{row.issue_date ?? '—'}</td><td className="p-3 text-theme-text">{row.purchase_orders.join(', ')}</td>
          <td className="p-3 text-right text-theme-text">{row.reference_amount == null ? '—' : money.format(Number(row.reference_amount))}</td>
          <td className="p-3 text-theme-text-muted"><span className="inline-flex items-center gap-1"><FileText className="h-4 w-4" />{row.has_document ? 'Disponible' : 'Sin adjunto'}</span></td>
          <td className="p-3"><span className="text-theme-text">{row.invoice_id ? row.invoice_status === 'PENDING' ? 'Pendiente de validación' : row.invoice_status : 'Por incorporar'}</span>{row.blocked_reason && <p className="mt-1 text-xs text-theme-text-muted">{row.blocked_reason}</p>}{row.receipt_ids.length > 1 && <p className="mt-1 text-xs text-theme-text-muted">{row.receipt_ids.length} recepciones</p>}</td>
        </tr>)}</tbody></table>
      {rows.length === 0 && <p className="p-6 text-center text-sm text-theme-text-muted">No hay facturas para los filtros seleccionados.</p>}
    </div>
  </section>
}
