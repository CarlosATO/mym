import type { PortalDailyCollection, PortalCollections } from '@/app/actions/portal/collections'
import type { PortalDailySales, PortalSales } from '@/app/actions/portal/sales'
import { todayInSantiago } from '@/lib/datetime'

type FinancialCardProps = {
  error: string | null
  kind: 'sales' | 'collections'
  data: PortalSales | PortalCollections | null
}

function currency(value: number) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(value)
}

function abbreviatedCurrency(value: number) {
  const sign = value < 0 ? '-' : ''
  const absolute = Math.abs(value)
  if (absolute === 0) return '$0'

  if (absolute >= 1_000_000) {
    const millions = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(absolute / 1_000_000)
    return `${sign}$${millions}M`
  }
  if (absolute >= 1_000) {
    const thousands = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(absolute / 1_000)
    return `${sign}$${thousands}K`
  }
  return `${sign}$${Math.round(absolute).toLocaleString('es-CL')}`
}

function relevantDays(values: (PortalDailySales | PortalDailyCollection)[]) {
  const today = todayInSantiago()
  const [year, month, day] = today.split('-').map(Number)
  const amounts = new Map(values.map(value => [value.date.slice(0, 10), value.amount]))

  return Array.from({ length: day }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, index + 1)).toISOString().slice(0, 10)
    const amount = amounts.get(date) ?? 0
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    return { date, amount, isWeekend: weekday === 0 || weekday === 6 }
  }).filter(value => !value.isWeekend || value.amount !== 0)
}

function DailyBars({ values, title }: { values: (PortalDailySales | PortalDailyCollection)[]; title: string }) {
  const allRelevantDays = relevantDays(values)
  const useFallback = allRelevantDays.length > 14
  const days = useFallback ? allRelevantDays.slice(-14) : allRelevantDays
  const max = Math.max(...days.map(value => Math.abs(value.amount)), 1)
  const chartTitle = `${title} · ${useFallback ? 'últimos 14 días' : 'mes actual'}`

  return (
    <div className="space-y-1.5">
      <h3 className="text-[10px] font-semibold text-theme-text-muted/80">{chartTitle}</h3>
      <div className="h-[108px] rounded-lg bg-theme-bg/60 px-1.5 py-1.5" aria-label={chartTitle}>
        <div className="grid h-full gap-px" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map(value => {
            const height = value.amount === 0 ? 0 : Math.max(8, (Math.abs(value.amount) / max) * 100)
            return (
              <div key={value.date} className="flex min-w-0 flex-col">
                <span className="h-4 truncate text-center text-[8px] font-semibold tabular-nums text-theme-text-muted">{abbreviatedCurrency(value.amount)}</span>
                <div className="flex min-h-0 flex-1 items-end justify-center">
                  <div className="w-full rounded-t-sm bg-theme-text-accent/70" style={{ height: `${height}%` }} />
                </div>
                <span className="h-3 text-center text-[9px] font-medium tabular-nums text-theme-text-muted/80">{value.date.slice(8, 10)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, format = 'currency' }: { label: string; value: number; format?: 'currency' | 'number' }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] font-medium text-theme-text-muted/75">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold tabular-nums tracking-tight text-theme-text">{format === 'currency' ? currency(value) : value.toLocaleString('es-CL')}</p>
    </div>
  )
}

export function PortalFinancialCard({ error, kind, data }: FinancialCardProps) {
  const sales = kind === 'sales' ? data as PortalSales | null : null
  const collections = kind === 'collections' ? data as PortalCollections | null : null
  const title = kind === 'sales' ? 'Ventas' : 'Cobranzas'
  const subtitle = kind === 'sales' ? 'Resumen del mes en curso' : 'Resumen del mes en curso'
  const dailyValues = sales?.daily_sales ?? collections?.daily_collections ?? []

  return (
    <section className="flex h-full min-h-[270px] flex-col overflow-hidden rounded-2xl border border-theme-border/80 bg-theme-surface/80 shadow-sm">
      <div className="border-b border-theme-border/70 px-4 py-3.5 sm:px-5">
        <h2 className="text-base font-semibold tracking-tight text-theme-text">{title}</h2>
        <p className="mt-0.5 text-[11px] text-theme-text-muted/70">
          {subtitle}<span className="mx-1.5 text-theme-text-muted/45">·</span><span className="text-[10px] text-theme-text-muted/60">Montos netos, sin IVA</span>
        </p>
      </div>

      {error ? (
        <div className="flex flex-1 items-center justify-center px-5 py-8 text-center text-xs text-theme-text-muted/75">No se pudo cargar {title.toLowerCase()}.</div>
      ) : (
        <div className="flex flex-1 flex-col gap-4 p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-3">
            {kind === 'sales' ? (
              <>
                <Metric label="Ventas del mes" value={sales?.sales_month ?? 0} />
                <Metric label="Facturas" value={sales?.invoices_count ?? 0} format="number" />
                <Metric label="Ticket promedio" value={sales?.average_ticket ?? 0} />
              </>
            ) : (
              <>
                <Metric label="Cobrado del mes" value={collections?.collected_month ?? 0} />
                <Metric label="Pendiente por cobrar" value={collections?.pending_receivables ?? 0} />
                <Metric label="Cartera vencida" value={collections?.overdue_receivables ?? 0} />
              </>
            )}
          </div>
          <DailyBars
            values={dailyValues}
            title={kind === 'sales' ? 'Ventas diarias · últimos 14 días operativos' : 'Cobros diarios · últimos 14 días operativos'}
          />
        </div>
      )}
    </section>
  )
}
