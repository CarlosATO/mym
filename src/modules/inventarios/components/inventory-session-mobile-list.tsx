import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import type { InventorySessionSummary } from '@/app/actions/inventarios/sessions'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { computeProgress, formatDateChile } from '@/modules/inventarios/lib/format'

interface InventorySessionMobileListProps {
  sessions: InventorySessionSummary[]
}

export function InventorySessionMobileList({ sessions }: InventorySessionMobileListProps) {
  return (
    <div className="divide-y divide-theme-border/40 lg:hidden">
      {sessions.map(session => {
        const progress = computeProgress(session.task_count, session.task_completed_count)
        return (
          <Link
            key={session.id}
            href={`/dashboard/inventarios/jornadas/${session.id}`}
            className="flex items-center gap-3 px-1 py-2 transition-colors hover:bg-theme-text/2"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-theme-text">#{session.session_number}</span>
                <InventoryStatusBadge status={session.status} />
              </div>
              <p className="truncate text-sm font-medium text-theme-text">{session.name}</p>
              <div className="flex items-center gap-3 text-xs text-theme-text-muted">
                <span className="truncate">{session.warehouse_name ?? '—'}</span>
                <span>{formatDateChile(session.created_at)}</span>
              </div>
              {progress !== null && (
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-theme-text/8">
                    <div className="h-full rounded-full bg-theme-accent" style={{ width: `${progress}%` }} />
                  </div>
                  <span className="text-xs text-theme-text-muted">{progress}%</span>
                </div>
              )}
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-theme-text-muted/40" />
          </Link>
        )
      })}
    </div>
  )
}
