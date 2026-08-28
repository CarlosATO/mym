import type { PortalAmimascotaKpis } from '@/app/actions/portal/amimascota'

function currency(value: number) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(value)
}

export function AmimascotaCard({ data, error }: { data: PortalAmimascotaKpis | null; error: boolean }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-theme-border/80 bg-theme-surface/80 shadow-sm">
      <div className="border-b border-theme-border/70 px-4 py-3 sm:px-4">
        <h2 className="text-base font-semibold tracking-tight text-theme-text">Amimascota</h2>
        <p className="mt-0.5 text-[11px] text-theme-text-muted/70">
          Cliente interno<span className="mx-1.5 text-theme-text-muted/45">·</span><span className="text-[10px] text-theme-text-muted/60">Montos netos, sin IVA</span>
        </p>
      </div>
      {error ? (
        <div className="px-4 py-5 text-xs text-theme-text-muted/75 sm:px-5">No se pudo cargar la información.</div>
      ) : (
        <div className="grid grid-cols-1 divide-y divide-theme-border/70 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="min-w-0 px-4 py-2.5 sm:px-3">
            <p className="text-[10px] font-medium text-theme-text-muted/75">Ventas del mes</p>
            <p className="mt-1 truncate text-sm font-semibold tabular-nums tracking-tight text-theme-text">{currency(data?.sales_month ?? 0)}</p>
          </div>
            <div className="min-w-0 px-4 py-2.5 sm:px-3">
            <p className="text-[10px] font-medium text-theme-text-muted/75">Cobrado del mes</p>
            <p className="mt-1 truncate text-sm font-semibold tabular-nums tracking-tight text-theme-text">{currency(data?.collected_month ?? 0)}</p>
          </div>
            <div className="min-w-0 px-4 py-2.5 sm:px-3">
            <p className="text-[10px] font-medium text-theme-text-muted/75">Deuda sana</p>
            <p className="mt-1 truncate text-sm font-semibold tabular-nums tracking-tight text-theme-text">{currency(data?.healthy_debt ?? 0)}</p>
          </div>
            <div className="min-w-0 bg-amber-500/5 px-4 py-2.5 sm:px-3">
            <p className="text-[10px] font-medium text-amber-700/80 dark:text-amber-200/75">Deuda vencida</p>
            <p className="mt-1 truncate text-sm font-semibold tabular-nums tracking-tight text-amber-800 dark:text-amber-100">{currency(data?.overdue_debt ?? 0)}</p>
          </div>
        </div>
      )}
    </section>
  )
}
