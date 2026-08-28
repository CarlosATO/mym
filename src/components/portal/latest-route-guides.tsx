import Link from 'next/link'
import { AlertTriangle, ArrowUpRight, MapPinned } from 'lucide-react'
import { formatCivilDate } from '@/lib/datetime'
import type { PortalRouteGuide } from '@/app/actions/logistica/guias-ruta'

function currency(value: number) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(value)
}

export function LatestRouteGuides({ guides }: { guides: PortalRouteGuide[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-theme-border/80 bg-theme-surface/80 shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-theme-border/70 px-4 py-3 sm:px-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-300">
            <MapPinned className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-theme-text">Últimas Guías de Ruta</h2>
            <p className="mt-0.5 text-[11px] text-theme-text-muted/70">Monto total con IVA · Utilidad neta sin IVA</p>
          </div>
        </div>
        <Link href="/dashboard/logistica/guias-ruta" className="inline-flex shrink-0 items-center gap-1 text-[10px] font-bold text-theme-text-accent transition-colors hover:text-theme-accent-hover">
          Ver todas
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      {guides.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-theme-text-muted/70">No hay guías despachadas para mostrar.</div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[472px] px-2 py-2 sm:px-3">
            <div className="grid grid-cols-[minmax(64px,0.85fr)_minmax(66px,0.8fr)_minmax(75px,1.35fr)_34px_minmax(92px,1fr)_minmax(92px,1fr)] gap-1.5 border-b border-theme-border/60 px-1 pb-2 text-[9px] font-bold uppercase tracking-[0.06em] text-theme-text-muted/60">
              <span>Guía</span>
              <span>Fecha</span>
              <span>Ruta</span>
              <span className="text-right">Fact.</span>
              <span className="text-right">Monto total</span>
              <span className="text-right">Utilidad</span>
            </div>
            <div className="divide-y divide-theme-border/60">
              {guides.map(guide => {
                const partial = guide.cost_status !== 'COMPLETE' || (guide.cost_coverage_pct !== null && guide.cost_coverage_pct < 100)
                return (
                    <div key={guide.id} className="grid grid-cols-[minmax(64px,0.85fr)_minmax(66px,0.8fr)_minmax(75px,1.35fr)_34px_minmax(92px,1fr)_minmax(92px,1fr)] items-center gap-1.5 px-1 py-2.5 text-[10px] text-theme-text">
                    <Link href="/dashboard/logistica/guias-ruta" className="truncate font-bold text-theme-text-accent hover:text-theme-accent-hover hover:underline" title={`Abrir Guías de Ruta · ${guide.guide_number}`}>
                      {guide.guide_number}
                    </Link>
                    <span className="whitespace-nowrap text-theme-text-muted">{formatCivilDate(guide.guide_date, 'short')}</span>
                    <span className="truncate text-theme-text-muted" title={guide.route_name_snapshot ?? undefined}>{guide.route_name_snapshot || 'Sin ruta'}</span>
                    <span className="text-right tabular-nums text-theme-text-muted">{guide.total_invoices}</span>
                    <span className="text-right tabular-nums text-theme-text-muted">{currency(guide.total_amount)}</span>
                    <span className="flex items-center justify-end gap-1 whitespace-nowrap font-semibold tabular-nums text-theme-text">
                      {currency(guide.utility)}
                      {partial && (
                        <span title={`Cobertura de costos: ${guide.cost_coverage_pct ?? 0}%`} aria-label="Rentabilidad con cobertura parcial" className="text-amber-600 dark:text-amber-300">
                          <AlertTriangle className="h-3 w-3" />
                        </span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
