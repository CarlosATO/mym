import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import type { InventorySessionSummary } from '@/app/actions/inventarios/sessions'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { computeProgress, formatDateChile } from '@/modules/inventarios/lib/format'

interface InventorySessionTableProps {
  sessions: InventorySessionSummary[]
  warehouseNames: Record<string, string>
}

function shortId(id: string | null | undefined): string {
  if (!id) return '—'
  return id.slice(0, 8)
}

export function InventorySessionTable({ sessions, warehouseNames }: InventorySessionTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
            <th className="px-3 py-2.5">Número</th>
            <th className="px-3 py-2.5">Jornada</th>
            <th className="px-3 py-2.5">Bodega</th>
            <th className="px-3 py-2.5">Estado</th>
            <th className="px-3 py-2.5">Avance</th>
            <th className="px-3 py-2.5">Responsable</th>
            <th className="px-3 py-2.5">Fecha</th>
            <th className="px-3 py-2.5 text-right">Acción</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map(session => {
            const progress = computeProgress(session.task_count, session.task_completed_count)
            return (
              <tr key={session.id} className="border-b border-theme-border/40 transition-colors hover:bg-theme-text/2">
                <td className="px-3 py-2.5 font-semibold text-theme-text">#{session.session_number}</td>
                <td className="max-w-[180px] truncate px-3 py-2.5 text-theme-text">{session.name}</td>
                <td className="max-w-[140px] truncate px-3 py-2.5 text-theme-text-muted">
                  {warehouseNames[session.warehouse_id ?? ''] ?? '—'}
                </td>
                <td className="px-3 py-2.5">
                  <InventoryStatusBadge status={session.status} />
                </td>
                <td className="px-3 py-2.5">
                  {progress === null ? (
                    <span className="text-xs text-theme-text-muted/50">—</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-theme-text/8">
                        <div
                          className="h-full rounded-full bg-theme-accent"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="text-xs text-theme-text-muted">{progress}%</span>
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-theme-text-muted">
                  {shortId(session.responsible_user_id)}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-theme-text-muted">
                  {formatDateChile(session.created_at)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Link
                    href={`/dashboard/inventarios/jornadas/${session.id}`}
                    aria-label={`Ver jornada ${session.name}`}
                    className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                  >
                    Ver
                    <ChevronRight className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
