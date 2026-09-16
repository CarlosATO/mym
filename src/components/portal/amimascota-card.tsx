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
        <p className="mt-0.5 text-[10px] text-theme-text-muted/70">
          Cliente interno<span className="mx-1.5 text-theme-text-muted/45">·</span><span className="text-[10px] text-theme-text-muted/60">Montos netos, sin IVA</span>
        </p>
      </div>
      {error ? (
        <div className="px-4 py-5 text-xs text-theme-text-muted/75 sm:px-5">No se pudo cargar la información.</div>
      ) : (
        <div className="space-y-1 px-4 py-1.5 sm:px-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-theme-text-muted/75">Deuda total actual</p>
            <p className="truncate text-lg font-bold tabular-nums tracking-tight text-theme-text">{currency(data?.total_debt ?? 0)}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-4 text-[10px]">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <p className="truncate font-medium text-theme-text-muted/75">No vencida</p>
              <p className="truncate font-semibold tabular-nums text-theme-text">{currency(data?.healthy_debt ?? 0)}</p>
            </div>
            <div className="flex min-w-0 items-baseline justify-between gap-2 rounded-md bg-amber-500/5 px-1.5 py-0.5">
              <p className="truncate font-medium text-amber-700/80 dark:text-amber-200/75">Vencida</p>
              <p className="truncate font-semibold tabular-nums text-amber-800 dark:text-amber-100">{currency(data?.overdue_debt ?? 0)}</p>
            </div>
          </div>
          <div className="border-t border-theme-border/60 pt-1.5">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-theme-text-muted/60">Actividad del mes</p>
            <div className="grid grid-cols-2 gap-x-4 text-[10px]">
              <p className="flex min-w-0 items-baseline justify-between gap-2"><span className="truncate font-medium text-theme-text-muted/75">Ventas netas</span><span className="truncate font-semibold tabular-nums text-theme-text">{currency(data?.sales_month ?? 0)}</span></p>
              <p className="flex min-w-0 items-baseline justify-between gap-2"><span className="truncate font-medium text-theme-text-muted/75">Cobrado neto</span><span className="truncate font-semibold tabular-nums text-theme-text">{currency(data?.collected_month ?? 0)}</span></p>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
