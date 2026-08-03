import { CheckCircle2, AlertTriangle, Clock } from 'lucide-react'
import type { InventorySessionReview } from '@/app/actions/inventarios/sessions'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'

interface InventoryReviewPanelProps {
  review: InventorySessionReview
}

function BlockingBadge({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" /> Sin bloqueos
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
      <AlertTriangle className="h-3 w-3" /> {count} bloqueante(s)
    </span>
  )
}

export function InventoryReviewPanel({ review }: InventoryReviewPanelProps) {
  const { tasks, incidents, recounts, indicators } = review

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-theme-text">Indicadores de revisión</h3>
          {indicators.ready_to_approve ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-3 w-3" /> Lista para aprobar
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              <Clock className="h-3 w-3" /> Aún no lista para aprobar
            </span>
          )}
          <BlockingBadge count={indicators.blocking_incident_count} />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Por validar</p>
            <p className="text-lg font-bold text-theme-text">{indicators.pending_validation_count}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Contribuciones</p>
            <p className="text-lg font-bold text-theme-text">{indicators.effective_contribution_count}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Recuentos pendientes</p>
            <p className="text-lg font-bold text-theme-text">{indicators.pending_recount_count}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Recuentos sin decidir</p>
            <p className="text-lg font-bold text-theme-text">{indicators.undecided_recount_count}</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h4 className="mb-2 text-sm font-semibold text-theme-text">
          Tareas por validar ({tasks.filter(t => t.pending_validation).length})
        </h4>
        {tasks.filter(t => t.pending_validation).length === 0 ? (
          <p className="text-sm text-theme-text-muted">Todas las tareas están validadas.</p>
        ) : (
          <ul className="space-y-1">
            {tasks.filter(t => t.pending_validation).map(task => (
              <li key={task.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-theme-text">{task.id.slice(0, 8)}</span>
                <span className="text-xs text-theme-text-muted">Ciclo {task.validation_cycle}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h4 className="mb-2 text-sm font-semibold text-theme-text">Incidencias ({incidents.length})</h4>
        {incidents.length === 0 ? (
          <p className="text-sm text-theme-text-muted">Sin incidencias registradas.</p>
        ) : (
          <ul className="space-y-1.5">
            {incidents.map(incident => (
              <li key={incident.id} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate text-theme-text">{incident.description}</p>
                  <p className="text-xs text-theme-text-muted">
                    {incident.category_code} · {incident.reported_by_name ?? '—'}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-theme-text-muted">{incident.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h4 className="mb-2 text-sm font-semibold text-theme-text">Recuentos ({recounts.length})</h4>
        {recounts.length === 0 ? (
          <p className="text-sm text-theme-text-muted">Sin recuentos solicitados.</p>
        ) : (
          <ul className="space-y-1.5">
            {recounts.map(recount => (
              <li key={recount.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-theme-text">
                  Recuento #{recount.ordinal}
                  {recount.assigned_user_name ? ` · ${recount.assigned_user_name}` : ''}
                </span>
                <span className="shrink-0 text-xs text-theme-text-muted">
                  {recount.status}
                  {recount.completed_at ? ` · ${formatDateTimeChile(recount.completed_at)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
