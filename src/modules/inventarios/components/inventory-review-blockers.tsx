import { CheckCircle2, XCircle } from 'lucide-react'
import type { InventorySessionReview } from '@/app/actions/inventarios/sessions'

interface InventoryReviewBlockersProps {
  review: InventorySessionReview
}

export function InventoryReviewBlockers({ review }: InventoryReviewBlockersProps) {
  const i = review.indicators
  const blockers: Array<{ label: string; met: boolean }> = [
    { label: 'Todas las tareas validadas', met: i.pending_validation_count === 0 },
    { label: 'Sin incidencias bloqueantes', met: i.blocking_incident_count === 0 },
    { label: 'Sin recuentos pendientes', met: i.pending_recount_count === 0 },
    { label: 'Sin recuentos sin decidir', met: i.undecided_recount_count === 0 },
    { label: 'Con contribuciones efectivas', met: i.effective_contribution_count > 0 },
  ]

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <h3 className="mb-2 flex items-center justify-between text-sm font-semibold text-theme-text">
        Motivos que impiden aprobar
        {i.ready_to_approve ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" /> Lista para aprobar
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            <XCircle className="h-3 w-3" /> Aún no lista
          </span>
        )}
      </h3>
      <ul className="space-y-1.5">
        {blockers.map(b => (
          <li key={b.label} className={`flex items-center gap-2 text-sm ${b.met ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-400'}`}>
            {b.met ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
            {b.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
