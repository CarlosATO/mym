import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { computeProgress, formatDateChile } from '@/modules/inventarios/lib/format'

interface InventorySessionOverviewProps {
  detail: InventorySessionDetail
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-theme-border/40 py-2 text-sm last:border-0">
      <span className="text-theme-text-muted">{label}</span>
      <span className="text-right font-medium text-theme-text">{value}</span>
    </div>
  )
}

export function InventorySessionOverview({ detail }: InventorySessionOverviewProps) {
  const { session, snapshot, counts } = detail
  const progress = computeProgress(
    detail.tasks.filter(t => !t.cancelled_at).length,
    detail.tasks.filter(t => t.status === 'COMPLETED' && !t.cancelled_at).length
  )

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-theme-text">Datos generales</h3>
        <InfoRow label="Tipo" value={session.inventory_type} />
        <InfoRow label="Alcance" value={session.scope_mode === 'PARTIAL' ? 'Parcial' : 'General'} />
        <InfoRow label="Bodega" value={session.warehouse_name ?? '—'} />
        <InfoRow label="Responsable" value={session.responsible_name ?? '—'} />
        <InfoRow label="Estado" value={session.status} />
        <InfoRow label="Creada" value={formatDateChile(session.created_at)} />
      </div>

      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-theme-text">Snapshot</h3>
        {snapshot ? (
          <>
            <div className="mb-3">
              <InventoryStatusBadge status={snapshot.completion_status === 'COMPLETED' ? 'APPROVED' : 'DRAFT'} />
            </div>
            <InfoRow label="Versión" value={String(snapshot.snapshot_version)} />
            <InfoRow label="Capturado" value={formatDateChile(snapshot.captured_at)} />
            {snapshot.captured_by_name && (
              <InfoRow label="Capturado por" value={snapshot.captured_by_name} />
            )}
            {snapshot.content_hash && (
              <p className="mt-3 break-all font-mono text-[10px] text-theme-text-muted/50">
                Hash: {snapshot.content_hash.slice(0, 16)}…
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-theme-text-muted">Sin snapshot.</p>
        )}
      </div>

      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-theme-text">Conteo</h3>
        <InfoRow label="Conteos registrados" value={String(counts.count_entry_count)} />
        <InfoRow label="Contribuciones efectivas" value={String(counts.effective_contribution_count)} />
        <InfoRow label="Incidencias bloqueantes" value={String(counts.blocking_incident_count)} />
        <InfoRow label="Recuentos pendientes" value={String(counts.pending_recount_count)} />
        {progress !== null && (
          <div className="mt-3 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-theme-text/8">
              <div className="h-full rounded-full bg-theme-accent" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs font-medium text-theme-text-muted">{progress}%</span>
          </div>
        )}
      </div>
    </div>
  )
}
