'use client'

import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Search, WalletCards } from 'lucide-react'
import { getPendingRouteFundDeposits } from '@/app/actions/adquisiciones/route-fund-closures'
import type { PendingRouteFundDeposit } from '../fund-closures-types'
import { formatCivilDate } from '@/lib/datetime'
import { RegisterFundClosureDepositDialog } from './register-fund-closure-deposit-dialog'

function money(value: number) {
  return `$${Number(value || 0).toLocaleString('es-CL')}`
}

function chequeLabel(count: number) {
  return `${count} cheque${count === 1 ? '' : 's'}`
}

export function PendingFundDepositsWorkspace() {
  const [rows, setRows] = useState<PendingRouteFundDeposit[]>([])
  const [closureNumber, setClosureNumber] = useState('')
  const [custodyUserId, setCustodyUserId] = useState('')
  const [situation, setSituation] = useState<'' | 'PENDING' | 'PARTIAL'>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedRow, setSelectedRow] = useState<PendingRouteFundDeposit | null>(null)

  async function load() {
    setLoading(true)
    const response = await getPendingRouteFundDeposits({ closureNumber, custodyUserId, situation: situation || undefined, dateFrom, dateTo })
    if (response.error) setError(response.error)
    else { setRows(response.data ?? []); setError(null) }
    setLoading(false)
  }

  useEffect(() => {
    let active = true
    getPendingRouteFundDeposits().then(response => {
      if (!active) return
      if (response.error) setError(response.error)
      else setRows(response.data ?? [])
    }).finally(() => active && setLoading(false))
    return () => { active = false }
  }, [])

  const clearFilters = () => {
    setClosureNumber('')
    setCustodyUserId('')
    setSituation('')
    setDateFrom('')
    setDateTo('')
  }

  const totals = rows.reduce((result, row) => ({
    cash: result.cash + row.cash_pending,
    checks: result.checks + row.checks_pending_amount,
    total: result.total + row.total_pending,
  }), { cash: 0, checks: 0, total: 0 })

  return <div className="flex h-full min-h-0 flex-col gap-3 p-4">
    <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div><h2 className="flex items-center gap-2 text-lg font-bold text-theme-text"><WalletCards className="h-5 w-5 text-theme-accent" />Depósitos</h2><p className="mt-0.5 text-xs text-theme-text-muted">Fondos recibidos por Tesorería pendientes de depósito bancario.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1.5 self-start rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
    </header>

    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="CFC pendientes" value={String(rows.length)} /><Metric label="Efectivo pendiente" value={money(totals.cash)} /><Metric label="Cheques pendientes" value={money(totals.checks)} /><Metric label="Total pendiente" value={money(totals.total)} emphasized /></div>

    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-theme-border bg-theme-text/[0.02] p-3">
      <label className="min-w-40 flex-1 text-[11px] font-semibold text-theme-text">Nº CFC<div className="mt-1 flex items-center gap-1.5 rounded-md border border-theme-border bg-theme-surface px-2"><Search className="h-3.5 w-3.5 text-theme-text-muted" /><input value={closureNumber} onChange={event => setClosureNumber(event.target.value)} onKeyDown={event => event.key === 'Enter' && void load()} className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none" placeholder="CFC-2026..." /></div></label>
      <label className="min-w-40 flex-1 text-[11px] font-semibold text-theme-text">Custodio<div className="mt-1"><input value={custodyUserId} onChange={event => setCustodyUserId(event.target.value)} onKeyDown={event => event.key === 'Enter' && void load()} className="h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs outline-none" placeholder="ID custodio" /></div></label>
      <label className="min-w-32 flex-1 text-[11px] font-semibold text-theme-text">Situación<div className="mt-1"><select value={situation} onChange={event => setSituation(event.target.value as typeof situation)} className="h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs outline-none"><option value="">Todas</option><option value="PENDING">Pendiente</option><option value="PARTIAL">Depósito parcial</option></select></div></label>
      <label className="text-[11px] font-semibold text-theme-text">Desde<div className="mt-1"><input type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} className="h-8 rounded-md border border-theme-border bg-theme-surface px-2 text-xs outline-none" /></div></label>
      <label className="text-[11px] font-semibold text-theme-text">Hasta<div className="mt-1"><input type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} className="h-8 rounded-md border border-theme-border bg-theme-surface px-2 text-xs outline-none" /></div></label>
      <button type="button" onClick={clearFilters} className="h-8 rounded-md border border-theme-border px-2.5 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text">Limpiar filtros</button>
      <button type="button" onClick={() => void load()} className="h-8 rounded-md bg-theme-accent px-3 text-xs font-bold text-white">Buscar</button>
    </div>

    {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
    <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-theme-border bg-theme-surface">
      {loading && rows.length === 0 ? <div className="flex h-full items-center justify-center gap-2 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Cargando depósitos pendientes...</div> : rows.length === 0 ? <div className="flex h-full min-h-48 items-center justify-center text-sm text-theme-text-muted">No hay fondos pendientes de depósito.</div> : <table className="w-full min-w-[900px] text-left text-xs"><thead className="sticky top-0 border-b border-theme-border bg-theme-text/[0.04] text-[10px] font-bold uppercase tracking-wide text-theme-text-muted"><tr><th className="px-3 py-2.5">Cierre de Fondos</th><th className="px-3 py-2.5">Fecha</th><th className="px-3 py-2.5">Custodio</th><th className="px-3 py-2.5 text-right">Efectivo pendiente</th><th className="px-3 py-2.5 text-right">Cheques pendientes</th><th className="px-3 py-2.5 text-right">Total pendiente</th><th className="px-3 py-2.5">Situación</th><th className="px-3 py-2.5 text-right">Acción</th></tr></thead><tbody className="divide-y divide-theme-border">{rows.map(row => <tr key={row.fund_closure_id} className="hover:bg-theme-text/[0.025]"><td className="px-3 py-3 font-bold text-theme-text">{row.fund_closure_number}</td><td className="whitespace-nowrap px-3 py-3 text-theme-text-muted">{formatCivilDate(row.created_at)}</td><td className="px-3 py-3 text-theme-text">{row.custodian_name ?? row.custodian_id}</td><td className="px-3 py-3 text-right font-mono font-semibold">{money(row.cash_pending)}</td><td className="px-3 py-3 text-right"><span className="block font-semibold text-theme-text">{row.checks_pending_count > 0 ? chequeLabel(row.checks_pending_count) : '—'}</span>{row.checks_pending_count > 0 && <span className="mt-0.5 block font-mono text-theme-text-muted">{money(row.checks_pending_amount)}</span>}</td><td className="px-3 py-3 text-right font-mono font-bold text-theme-text">{money(row.total_pending)}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${row.situation === 'PARTIAL' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-blue-500/10 text-blue-700 dark:text-blue-300'}`}>{row.situation === 'PARTIAL' ? 'Depósito parcial' : 'Pendiente'}</span></td><td className="px-3 py-3 text-right"><button type="button" onClick={() => setSelectedRow(row)} className="rounded-lg bg-theme-accent px-3 py-1.5 text-[11px] font-bold text-white hover:bg-theme-accent-hover">Crear depósito</button></td></tr>)}</tbody></table>}
    </div>
    {selectedRow && <RegisterFundClosureDepositDialog closureId={selectedRow.fund_closure_id} maxAmount={selectedRow.total_pending} cashAvailable={selectedRow.cash_pending} availableChecks={selectedRow.available_checks} onClose={() => setSelectedRow(null)} onSaved={async () => { setSelectedRow(null); await load() }} />}
  </div>
}

function Metric({ label, value, emphasized = false }: { label: string; value: string; emphasized?: boolean }) {
  return <div className={`rounded-lg border px-3 py-2.5 ${emphasized ? 'border-theme-accent/40 bg-theme-accent/[0.06]' : 'border-theme-border'}`}><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className={`mt-0.5 font-mono text-sm font-bold tabular-nums ${emphasized ? 'text-theme-accent' : 'text-theme-text'}`}>{value}</p></div>
}
