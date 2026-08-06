import type { ReactNode } from 'react'
import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { inventoryTypeLabel } from '@/modules/inventarios/lib/states'
import { computeProgress, formatDateChile } from '@/modules/inventarios/lib/format'

interface InventorySessionOverviewProps {
  detail: InventorySessionDetail
}

function CompactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-theme-border/40 py-1 text-xs last:border-0">
      <span className="text-theme-text-muted/70">{label}</span>
      <span className="text-right font-medium text-theme-text">{value}</span>
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[11px] font-semibold text-theme-text-muted/60 uppercase tracking-wider">
      {children}
    </h3>
  )
}

export function InventorySessionOverview({ detail }: InventorySessionOverviewProps) {
  const { session, snapshot, counts } = detail
  const progress = computeProgress(
    detail.tasks.filter(t => !t.cancelled_at).length,
    detail.tasks.filter(t => t.status === 'COMPLETED' && !t.cancelled_at).length
  )

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface shadow-sm">
      <div className="grid grid-cols-1 divide-y divide-theme-border/40 md:grid-cols-3 md:divide-x md:divide-y-0">
        <section className="p-3">
          <SectionTitle>Datos generales</SectionTitle>
          <CompactRow label="Tipo" value={inventoryTypeLabel(session.inventory_type)} />
          <CompactRow
            label="Alcance"
            value={session.scope_mode === 'PARTIAL' ? 'Parcial' : 'General'}
          />
          <CompactRow label="Bodega" value={session.warehouse_name ?? '—'} />
          <CompactRow label="Responsable" value={session.responsible_name ?? '—'} />
          <CompactRow
            label="Estado"
            value={<InventoryStatusBadge status={session.status} />}
          />
          <CompactRow label="Creada" value={formatDateChile(session.created_at)} />
        </section>

        <section className="p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <SectionTitle>Snapshot</SectionTitle>
            {snapshot && (
              <InventoryStatusBadge
                status={snapshot.completion_status === 'COMPLETED' ? 'APPROVED' : 'DRAFT'}
              />
            )}
          </div>
          {snapshot ? (
            <>
              <CompactRow label="Versión" value={String(snapshot.snapshot_version)} />
              <CompactRow label="Capturado" value={formatDateChile(snapshot.captured_at)} />
              {snapshot.captured_by_name && (
                <CompactRow label="Capturado por" value={snapshot.captured_by_name} />
              )}
              {snapshot.content_hash && (
                <p className="mt-1.5 truncate font-mono text-[10px] text-theme-text-muted/60">
                  Hash: {snapshot.content_hash.slice(0, 16)}…
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-theme-text-muted">Sin snapshot.</p>
          )}
        </section>

        <section className="p-3">
          <SectionTitle>Conteo</SectionTitle>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { label: 'Registrados', value: counts.count_entry_count },
              { label: 'Contribuciones', value: counts.effective_contribution_count },
              { label: 'Bloqueantes', value: counts.blocking_incident_count },
              { label: 'Recuentos pend.', value: counts.pending_recount_count },
            ].map(item => (
              <div
                key={item.label}
                className="rounded-md border border-theme-border/60 bg-theme-text/[0.02] px-2 py-1"
              >
                <p className="text-base font-bold leading-tight text-theme-text">{item.value}</p>
                <p className="text-[10px] font-medium leading-tight text-theme-text-muted/70">
                  {item.label}
                </p>
              </div>
            ))}
          </div>
          {progress !== null && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-theme-text/10">
                <div
                  className="h-full rounded-full bg-theme-accent"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-[11px] font-semibold text-theme-text-muted">{progress}%</span>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
