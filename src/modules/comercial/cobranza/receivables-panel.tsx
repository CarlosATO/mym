"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getCommercialReceivablesDashboard,
  type CommercialCustomerReceivablesMonthly,
  type CommercialReceivablesDashboard,
  type CommercialReceivablesDashboardRow,
} from '@/app/actions/comercial/customers'
import { cn } from '@/lib/utils'
import { BarChart2 } from 'lucide-react'

type ScopeFilter = 'external' | 'internal' | 'all'

function fmtMoney(value: number | null | undefined) {
  const n = Number(value || 0)
  if (n === 0) return '$0'
  return '$' + n.toLocaleString('es-CL', { maximumFractionDigits: 0 })
}

function fmtSignedMoney(value: number | null | undefined) {
  const n = Number(value || 0)
  if (n < 0) return '-$' + Math.abs(n).toLocaleString('es-CL', { maximumFractionDigits: 0 })
  return fmtMoney(n)
}

function fmtDate(value: string | null | undefined) {
  if (!value) return 'Sin dato'
  return new Date(value).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function scopeLabel(scope: ScopeFilter) {
  if (scope === 'internal') return 'Tiendas propias'
  if (scope === 'all') return 'Todos'
  return 'Clientes externos'
}

function accountRows(rows: CommercialReceivablesDashboardRow[], scope: ScopeFilter) {
  if (scope === 'internal') return rows.filter(r => r.is_internal_account || r.exclude_from_external_reports)
  if (scope === 'all') return rows
  return rows.filter(r => !r.exclude_from_external_reports)
}

function periodTotals(monthly: CommercialCustomerReceivablesMonthly[], rows: CommercialReceivablesDashboardRow[]) {
  return {
    invoiced: monthly.reduce((s, m) => s + m.invoiced_amount, 0),
    paid: monthly.reduce((s, m) => s + m.paid_amount, 0),
    pending: rows.reduce((s, r) => s + r.total_pending, 0),
  }
}

// â”€â”€â”€ GrÃ¡fico compacto â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CompactChart({ monthly }: { monthly: CommercialCustomerReceivablesMonthly[] }) {
  const [active, setActive] = useState<string | null>(null)

  const maxValue = Math.max(...monthly.flatMap(m => [m.invoiced_amount, m.paid_amount]), 0)
  const selected = monthly.find(m => m.month === active) ?? monthly[monthly.length - 1]
  const selectedIndex = selected ? monthly.findIndex(m => m.month === selected.month) : -1
  const selectedX =
    selectedIndex >= 0 ? (monthly.length === 1 ? 50 : (selectedIndex / (monthly.length - 1)) * 100) : 50

  const pts = (key: 'invoiced_amount' | 'paid_amount') =>
    monthly
      .map((m, i) => {
        const x = monthly.length === 1 ? 50 : (i / (monthly.length - 1)) * 100
        const y = maxValue > 0 ? 34 - (m[key] / maxValue) * 26 : 34
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')

  if (monthly.length === 0) {
    return (
      <div className="flex h-28 items-center justify-center text-[11px] text-theme-text-muted/50">
        Sin datos en el rango.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
      {/* Leyenda */}
      <div className="flex items-center gap-3 text-[9px] text-theme-text-muted/65">
        <span className="flex items-center gap-1">
          <span className="inline-block h-[3px] w-3 rounded-full bg-theme-accent opacity-80" />
          Vta/Fact
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-[3px] w-3 rounded-full bg-emerald-500 opacity-80" />
          Pagado
        </span>
      </div>

      {/* SVG compacto */}
      <div className="relative">
        <svg
          viewBox="0 0 100 38"
          className="h-28 w-full overflow-visible"
          onMouseLeave={() => setActive(null)}
        >
          {[8, 16, 24, 32].map(y => (
            <line key={y} x1="0" y1={y} x2="100" y2={y}
              stroke="currentColor" className="text-theme-border/20" strokeWidth="0.15" />
          ))}
          <polyline points={pts('invoiced_amount')} fill="none"
            stroke="var(--theme-accent)" strokeWidth="1.1"
            strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
          <polyline points={pts('paid_amount')} fill="none"
            stroke="rgb(16 185 129)" strokeWidth="1.1"
            strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />

          {monthly.map((m, i) => {
            const x = monthly.length === 1 ? 50 : (i / (monthly.length - 1)) * 100
            const iy = maxValue > 0 ? 34 - (m.invoiced_amount / maxValue) * 26 : 34
            const py = maxValue > 0 ? 34 - (m.paid_amount / maxValue) * 26 : 34
            const isAct = selected?.month === m.month
            return (
              <g key={m.month} onMouseEnter={() => setActive(m.month)} className="cursor-crosshair">
                <rect x={x - 4} y={0} width={8} height={38} fill="transparent" />
                {isAct && (
                  <line x1={x} y1="5" x2={x} y2="34"
                    stroke="currentColor" className="text-theme-text-muted/20"
                    strokeWidth="0.3" strokeDasharray="1 0.8" />
                )}
                <circle cx={x} cy={iy} r={isAct ? '1.3' : '0.8'}
                  fill="var(--theme-accent)" stroke="var(--theme-surface)" strokeWidth="0.35" />
                <circle cx={x} cy={py} r={isAct ? '1.3' : '0.8'}
                  fill="rgb(16 185 129)" stroke="var(--theme-surface)" strokeWidth="0.35" />
              </g>
            )
          })}
        </svg>

        {/* Tooltip */}
        {active && selected && (
          <div
            className="pointer-events-none absolute top-1 z-20 min-w-[170px] rounded-xl border border-theme-border bg-theme-surface px-3 py-2 text-[11px] text-theme-text shadow-xl"
            style={{
              left: `${selectedX}%`,
              transform:
                selectedX > 72 ? 'translateX(-100%)' :
                selectedX < 18 ? 'translateX(0)' :
                'translateX(-50%)',
            }}
          >
            <div className="font-bold capitalize mb-1.5">{selected.monthLabel}</div>
            <div className="space-y-0.5">
              <div className="flex justify-between gap-3">
                <span className="text-theme-text-muted">Vta/Fact</span>
                <b>{fmtMoney(selected.invoiced_amount)}</b>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-theme-text-muted">Pagado</span>
                <b className="text-emerald-500">{fmtMoney(selected.paid_amount)}</b>
              </div>
              <div className="flex justify-between gap-3 border-t border-theme-border/40 pt-1 mt-0.5">
                <span className="text-theme-text-muted">Dif.</span>
                <b>{fmtSignedMoney(selected.net_cash_gap)}</b>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Eje X */}
      <div
        className="grid text-center text-[8px] text-theme-text-muted/40"
        style={{ gridTemplateColumns: `repeat(${monthly.length}, 1fr)` }}
      >
        {monthly.map(m => (
          <div key={m.month} className="truncate capitalize">
            {m.monthLabel.split(' ')[0]}
          </div>
        ))}
      </div>
    </div>
  )
}

// â”€â”€â”€ Panel compacto: cabecera (filtros) + cuerpo (KPIs + grÃ¡fico) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CompactPanel({
  totals, scope, setScope,
  fromMonth, setFromMonth,
  toMonth, setToMonth,
  latestDate, monthly, loading,
}: {
  totals: ReturnType<typeof periodTotals>
  scope: ScopeFilter
  setScope: (s: ScopeFilter) => void
  fromMonth: string
  setFromMonth: (v: string) => void
  toMonth: string
  setToMonth: (v: string) => void
  latestDate: string | null
  monthly: CommercialCustomerReceivablesMonthly[]
  loading: boolean
}) {
  const scopeOpts: { value: ScopeFilter; label: string }[] = [
    { value: 'external', label: 'Externos' },
    { value: 'internal', label: 'Propias' },
    { value: 'all', label: 'Todos' },
  ]

  const kpis = [
    { label: 'Venta / Facturado', value: fmtMoney(totals.invoiced), tone: 'text-theme-accent' },
    { label: 'Pagado',            value: fmtMoney(totals.paid),     tone: 'text-emerald-500' },
    { label: 'Pendiente',         value: fmtMoney(totals.pending),
      tone: totals.pending > 0 ? 'text-amber-500' : 'text-theme-text-muted' },
  ]

  return (
    <div className="w-full max-w-[640px] ml-auto rounded-2xl border border-theme-border/60 bg-theme-bg/50 shadow-sm overflow-hidden">

      {/* â”€â”€ Cabecera: filtros en una fila â”€â”€ */}
      <div className="flex items-center justify-between gap-3 px-3.5 py-2 border-b border-theme-border/40 bg-theme-text/[0.018]">
        {/* Rango */}
        <div className="flex items-center gap-1.5">
          <input
            type="month" value={fromMonth} onChange={e => setFromMonth(e.target.value)}
            aria-label="Desde"
            className="h-7 w-[118px] rounded-lg border border-theme-border bg-theme-surface px-2 text-[11px] text-theme-text outline-none focus:border-theme-accent focus:ring-1 focus:ring-theme-accent/20 transition-all"
          />
          <span className="text-theme-text-muted/40 text-xs">â€“</span>
          <input
            type="month" value={toMonth} onChange={e => setToMonth(e.target.value)}
            aria-label="Hasta"
            className="h-7 w-[118px] rounded-lg border border-theme-border bg-theme-surface px-2 text-[11px] text-theme-text outline-none focus:border-theme-accent focus:ring-1 focus:ring-theme-accent/20 transition-all"
          />
        </div>

        {/* Segmented control */}
        <div className="inline-flex rounded-lg border border-theme-border bg-theme-surface/80 p-0.5 shrink-0">
          {scopeOpts.map(opt => (
            <button
              key={opt.value}
              onClick={() => setScope(opt.value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[11px] font-semibold transition-all whitespace-nowrap',
                scope === opt.value
                  ? 'bg-theme-accent-muted text-theme-text ring-1 ring-theme-border-accent'
                  : 'text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5'
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* â”€â”€ Cuerpo: KPIs izq | grÃ¡fico der â”€â”€ */}
      <div className="flex min-h-0">
        {/* KPIs */}
        <div className="flex flex-col justify-center gap-3.5 px-4 py-3.5 w-[172px] shrink-0 border-r border-theme-border/30">
          <div className="text-[9px] font-bold uppercase tracking-wider text-theme-text-muted/45 leading-none">
            {scopeLabel(scope)}&nbsp;Â·&nbsp;{fmtDate(latestDate)}
          </div>
          {loading
            ? <div className="text-[11px] text-theme-text-muted/40 animate-pulse">Cargandoâ€¦</div>
            : kpis.map(k => (
              <div key={k.label}>
                <div className="text-[9px] font-semibold uppercase tracking-wide text-theme-text-muted/50 leading-none">
                  {k.label}
                </div>
                <div className={cn('mt-0.5 text-[15px] font-black leading-tight', k.tone)}>
                  {k.value}
                </div>
              </div>
            ))
          }
        </div>

        {/* GrÃ¡fico */}
        <div className="flex-1 min-w-0 px-3.5 py-3.5">
          {loading
            ? <div className="h-28 rounded-xl border border-dashed border-theme-border/40 animate-pulse bg-theme-text/[0.02]" />
            : <CompactChart monthly={monthly} />
          }
        </div>
      </div>
    </div>
  )
}

// â”€â”€â”€ Ãrea limpia inferior â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function CleanSlate() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2.5 text-center select-none">
      <BarChart2 className="w-7 h-7 text-theme-text-muted/12" strokeWidth={1.2} />
      <p className="text-[12px] text-theme-text-muted/30 max-w-xs leading-relaxed">
        Selecciona una consulta o filtro para profundizar el anÃ¡lisis de clientes.
      </p>
    </div>
  )
}

// â”€â”€â”€ Panel principal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function ReceivablesPanel() {
  const [dashboard, setDashboard] = useState<CommercialReceivablesDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fromMonth, setFromMonth] = useState('')
  const [toMonth, setToMonth] = useState('')
  const [scope, setScope] = useState<ScopeFilter>('external')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await getCommercialReceivablesDashboard()
    if ('error' in result) setError(result.error)
    else setDashboard(result)
    setLoading(false)
  }, [])

  useEffect(() => {
    const handle = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(handle)
  }, [load])

  const rows = useMemo(() => accountRows(dashboard?.rows ?? [], scope), [dashboard?.rows, scope])

  const monthlySource =
    scope === 'internal' ? dashboard?.monthly.internal ?? [] :
    scope === 'all'      ? dashboard?.monthly.all ?? [] :
                           dashboard?.monthly.external ?? []

  const monthly = monthlySource.filter(
    m => (!fromMonth || m.month >= fromMonth + '-01') && (!toMonth || m.month <= toMonth + '-01')
  )

  const totals = periodTotals(monthly, rows)
  const latestDataDate =
    rows.map(r => r.last_payment_date || r.last_invoice_date).filter(Boolean).sort().at(-1) ?? null

  return (
    <div className="flex h-full flex-col overflow-hidden bg-theme-surface">

      {/* â”€â”€ Franja superior: panel compacto alineado a la derecha â”€â”€ */}
      <div className="shrink-0 px-5 pt-4 pb-3 border-b border-theme-border/40">
        {error ? (
          <div className="rounded-xl border border-red-500/25 bg-red-500/8 px-4 py-3 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        ) : (
          <CompactPanel
            totals={totals} scope={scope} setScope={setScope}
            fromMonth={fromMonth} setFromMonth={setFromMonth}
            toMonth={toMonth} setToMonth={setToMonth}
            latestDate={latestDataDate} monthly={monthly} loading={loading}
          />
        )}
      </div>

      {/* â”€â”€ Ãrea principal limpia â”€â”€ */}
      <CleanSlate />

    </div>
  )
}
