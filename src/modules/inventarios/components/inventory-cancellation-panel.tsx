import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'

interface InventoryCancellationPanelProps {
  detail: InventorySessionDetail
}

export function InventoryCancellationPanel({ detail }: InventoryCancellationPanelProps) {
  const session = detail.session
  const cancelled = session.cancelled_at && session.cancelled_by

  if (!cancelled) {
    return (
      <div className="rounded-xl border border-dashed border-theme-border bg-theme-surface/60 p-8 text-center">
        <p className="text-sm text-theme-text-muted">Esta jornada no fue cancelada.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-theme-text">Cancelación</h3>
      <div className="space-y-2 text-sm">
        <p className="text-theme-text-muted">
          <span className="font-medium text-theme-text">Fecha:</span> {formatDateTimeChile(session.cancelled_at)}
        </p>
        <p className="text-theme-text-muted">
          <span className="font-medium text-theme-text">Responsable:</span> {session.cancelled_by_name ?? '—'}
        </p>
        <div>
          <span className="font-medium text-theme-text">Motivo:</span>
          <p className="mt-1 rounded-lg border border-theme-border bg-theme-surface p-3 text-sm text-theme-text">
            {session.cancellation_reason ?? '—'}
          </p>
        </div>
      </div>
      <p className="mt-4 text-xs text-theme-text-muted/70">
        La evidencia de la jornada (snapshot, conteos e incidencias) se conserva en modo consulta.
      </p>
    </div>
  )
}
