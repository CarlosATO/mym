'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CalendarClock, Check, Circle, Eye, FileText, Landmark, RefreshCw, Search, WalletCards } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getRouteSettlementCheckRegistry,
  type RouteSettlementCheckRegistryFilters,
  type RouteSettlementCheckRegistryRow,
  type RouteSettlementCheckStatus,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import { formatCurrency, formatDate } from '../utils/route-settlement-formatters'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

const labels: Record<RouteSettlementCheckStatus, string> = {
  CON_CUSTODIO: 'Con custodio',
  EN_TESORERIA: 'En Tesorería',
  DEPOSITADO: 'Depositado',
  ANULADO: 'Anulado',
}
const badgeStyles: Record<RouteSettlementCheckStatus, string> = {
  CON_CUSTODIO: 'bg-amber-500/10 text-amber-700 border-amber-500/20',
  EN_TESORERIA: 'bg-blue-500/10 text-blue-700 border-blue-500/20',
  DEPOSITADO: 'bg-green-500/10 text-green-700 border-green-500/20',
  ANULADO: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
}

type FilterState = Required<RouteSettlementCheckRegistryFilters> & { status: RouteSettlementCheckStatus | 'ALL' }
const initialFilters: FilterState = { customer: '', checkNumber: '', bank: '', guideNumber: '', settlementNumber: '', status: 'ALL', checkDateFrom: '', checkDateTo: '' }

export function RouteSettlementChecks() {
  const [filters, setFilters] = useState<FilterState>(initialFilters)
  const [rows, setRows] = useState<RouteSettlementCheckRegistryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<RouteSettlementCheckRegistryRow | null>(null)

  async function load(nextFilters = filters) {
    setLoading(true)
    // The V1 RPC filters names, but not RUT; keep both customer identifiers in
    // the loaded read-model so the visible search behaves consistently.
    const result = await getRouteSettlementCheckRegistry({ ...nextFilters, customer: undefined })
    setRows(result.data ?? [])
    setError(result.error)
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [])

  const visibleRows = useMemo(() => {
    const query = filters.customer.trim().toLocaleLowerCase()
    if (!query) return rows
    return rows.filter(row => `${row.customer_name} ${row.customer_rut ?? ''}`.toLocaleLowerCase().includes(query))
  }, [filters.customer, rows])

  function updateFilter<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    setFilters(current => ({ ...current, [key]: value }))
  }

  function clearFilters() {
    setFilters(initialFilters)
    void load(initialFilters)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-theme-surface">
      <div className="shrink-0 border-b border-theme-border p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div><h2 className="text-sm font-bold text-theme-text">Registro de cheques</h2><p className="text-[11px] text-theme-text-muted">Seguimiento operativo de cheques recibidos.</p></div>
          <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} /> Actualizar</Button><Button variant="ghost" size="sm" onClick={clearFilters}>Limpiar filtros</Button></div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
          <FilterInput label="Cliente / RUT" value={filters.customer} onChange={value => updateFilter('customer', value)} icon />
          <FilterInput label="Nº cheque" value={filters.checkNumber} onChange={value => updateFilter('checkNumber', value)} />
          <FilterInput label="Banco" value={filters.bank} onChange={value => updateFilter('bank', value)} />
          <FilterInput label="Guía" value={filters.guideNumber} onChange={value => updateFilter('guideNumber', value)} />
          <FilterInput label="Rendición" value={filters.settlementNumber} onChange={value => updateFilter('settlementNumber', value)} />
          <label className="text-[10px] font-semibold text-theme-text-muted">Situación<select value={filters.status} onChange={event => updateFilter('status', event.target.value as FilterState['status'])} className="mt-1 h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text"><option value="ALL">Todas</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <FilterInput label="Desde" type="date" value={filters.checkDateFrom} onChange={value => updateFilter('checkDateFrom', value)} />
          <FilterInput label="Hasta" type="date" value={filters.checkDateTo} onChange={value => updateFilter('checkDateTo', value)} />
        </div>
        <div className="mt-2 flex justify-end"><Button size="sm" onClick={() => void load()}><Search /> Aplicar filtros</Button></div>
      </div>
      {error && <div className="m-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">{error}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? <div className="flex h-40 items-center justify-center text-xs text-theme-text-muted">Cargando cheques...</div> : visibleRows.length === 0 ? <div className="flex h-48 items-center justify-center text-center text-xs text-theme-text-muted">No hay cheques que mostrar con los filtros actuales.</div> : <table className="w-full min-w-[980px] text-xs"><thead className="sticky top-0 z-10 bg-theme-surface text-left text-[10px] uppercase tracking-wide text-theme-text-muted"><tr>{['Cliente', 'Fecha cheque', 'Monto', 'Nº cheque', 'Banco', 'Guía de Ruta', 'Rendición', 'Situación', 'Acción'].map(label => <th key={label} className="border-b border-theme-border px-3 py-2 font-bold">{label}</th>)}</tr></thead><tbody>{visibleRows.map(row => <CheckRow key={row.payment_id} row={row} onView={() => setSelected(row)} />)}</tbody></table>}
      </div>
      <CheckDetail row={selected} open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(null) }} />
    </div>
  )
}

function FilterInput({ label, value, onChange, type = 'search', icon = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; icon?: boolean }) { return <label className="text-[10px] font-semibold text-theme-text-muted">{label}<span className="relative block mt-1">{icon && <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-theme-text-muted" />}<Input type={type} value={value} onChange={event => onChange(event.target.value)} className={icon ? 'pl-7' : ''} /></span></label> }

function CheckRow({ row, onView }: { row: RouteSettlementCheckRegistryRow; onView: () => void }) {
  const status = row.current_location
  const statusLabel = status === 'CON_CUSTODIO' && row.current_holder_name ? `Con ${row.current_holder_name}` : labels[status]
  return <tr className="border-b border-theme-border/60 hover:bg-theme-text/[0.025]"><td className="px-3 py-2 font-medium text-theme-text"><div>{row.customer_name}</div>{row.customer_rut && <div className="text-[10px] text-theme-text-muted">{row.customer_rut}</div>}</td><td className="px-3 py-2 text-theme-text-muted">{row.check_date ? formatDate(row.check_date) : '-'}</td><td className="px-3 py-2 text-right font-mono tabular-nums text-theme-text">{formatCurrency(row.amount)}</td><td className="px-3 py-2 text-theme-text">{row.check_number ?? '-'}</td><td className="px-3 py-2 text-theme-text-muted">{row.bank_name ?? '-'}</td><td className="px-3 py-2 text-theme-text">{row.guide_number ?? '-'}</td><td className="px-3 py-2 text-theme-text">{row.settlement_number ?? '-'}</td><td className="px-3 py-2"><span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-semibold ${badgeStyles[status]}`}>{statusLabel}</span></td><td className="px-3 py-2"><Button variant="ghost" size="xs" onClick={onView} title="Ver"><Eye /> Ver</Button></td></tr>
}

function CheckDetail({ row, open, onOpenChange }: { row: RouteSettlementCheckRegistryRow | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  if (!row) return null
  const status = row.current_location
  const statusLabel = status === 'CON_CUSTODIO' && row.current_holder_name ? `Con ${row.current_holder_name}` : labels[status]
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent className="border-theme-border bg-theme-surface text-theme-text sm:max-w-lg"><SheetHeader><SheetTitle>Detalle del cheque</SheetTitle><SheetDescription>{row.customer_name} · {statusLabel}</SheetDescription></SheetHeader><div className="space-y-5 overflow-y-auto px-4 pb-5 text-xs"><DetailSection icon={<WalletCards />} title="Cheque"><div className="grid grid-cols-2 gap-4"><Detail label="Cliente" value={row.customer_name} /><Detail label="RUT" value={row.customer_rut} /><Detail label="Monto" value={formatCurrency(row.amount)} /><Detail label="Banco" value={row.bank_name} /><Detail label="Nº cheque" value={row.check_number} /><Detail label="Fecha del cheque" value={row.check_date ? formatDate(row.check_date) : null} /><Detail label="Situación actual" value={statusLabel} /></div></DetailSection><DetailSection icon={<FileText />} title="Origen"><div className="grid grid-cols-2 gap-4"><Detail label="Guía de Ruta (GR)" value={row.guide_number} /><Detail label="Rendición (RR)" value={row.settlement_number} /><Detail label="Custodio original" value={row.original_custodian_name} /><Detail label="Recibido en Rendición" value={formatInstant(row.received_at)} /></div></DetailSection><DetailSection icon={<Landmark />} title="Cierre de Fondos">{row.fund_closure_id ? <div className="grid grid-cols-2 gap-4"><Detail label="Nº Cierre de Fondos" value={row.fund_closure_number} /><Detail label="Fecha/hora CFC" value={formatInstant(row.fund_closure_at)} /><Detail label="Estado CFC" value={row.fund_closure_status} /><p className="col-span-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-blue-800">Entregado a Tesorería mediante {row.fund_closure_number || 'CFC'}.</p></div> : <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-amber-800">Pendiente de entrega a Tesorería.</p>}</DetailSection><DetailSection icon={<CalendarClock />} title="Depósito">{row.deposit_id ? <div className="grid grid-cols-2 gap-4"><Detail label="Referencia" value={row.deposit_reference_number} /><Detail label="Fecha de depósito" value={formatInstant(row.deposited_at)} /><Detail label="Monto del depósito" value={row.deposit_amount !== null ? formatCurrency(row.deposit_amount) : null} /><Detail label="Estado del depósito" value={row.deposit_status} /><Detail label="CFC de origen" value={row.fund_closure_number} /></div> : <p className="rounded-lg border border-theme-border bg-theme-text/[0.025] px-3 py-2 text-theme-text-muted">Aún no depositado.</p>}</DetailSection><Timeline row={row} statusLabel={statusLabel} /></div></SheetContent></Sheet>
}

function DetailSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <section className="space-y-3"><div className="flex items-center gap-2 border-b border-theme-border pb-2 text-sm font-bold text-theme-text"><span className="text-theme-accent [&>svg]:h-4 [&>svg]:w-4">{icon}</span>{title}</div>{children}</section> }
function Detail({ label, value }: { label: string; value: string | null | undefined }) { return <div><div className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</div><div className="mt-1 break-words text-theme-text">{value || '-'}</div></div> }
function formatInstant(value: string | null) { return value ? new Intl.DateTimeFormat('es-CL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '-' }

function Timeline({ row, statusLabel }: { row: RouteSettlementCheckRegistryRow; statusLabel: string }) {
  const events = [
    { done: Boolean(row.received_at), label: row.settlement_number ? `Recibido en ${row.settlement_number}` : 'Recibido en Rendición', value: row.received_at ? formatInstant(row.received_at) : null },
    { done: Boolean(row.fund_closure_id), label: row.fund_closure_number ? `Entregado a Tesorería · ${row.fund_closure_number}` : 'Pendiente de entrega a Tesorería', value: row.fund_closure_at ? formatInstant(row.fund_closure_at) : null },
    { done: Boolean(row.deposit_id), label: row.deposit_id ? `Depositado · ${row.deposit_reference_number ?? 'sin referencia'}` : 'Pendiente de depósito', value: row.deposited_at ? formatInstant(row.deposited_at) : null },
  ]
  if (row.annulled_at) events.push({ done: true, label: 'Anulado', value: formatInstant(row.annulled_at) })
  return <DetailSection icon={<Circle />} title="Trazabilidad"><ol className="relative space-y-3 pl-1">{events.map((event, index) => <li key={`${event.label}-${index}`} className="flex items-start gap-3"><span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${event.done ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-theme-border text-theme-text-muted'}`}>{event.done ? <Check className="h-3 w-3" /> : <Circle className="h-2.5 w-2.5" />}</span><div><div className={`font-medium ${event.done ? 'text-theme-text' : 'text-theme-text-muted'}`}>{event.label}</div>{event.value && <div className="mt-0.5 text-[11px] text-theme-text-muted">{event.value}</div>}</div></li>)}</ol><div className="sr-only">Situación actual: {statusLabel}</div></DetailSection>
}
