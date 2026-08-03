import type { InventorySessionTask } from '@/app/actions/inventarios/sessions'

interface InventoryTaskProgressProps {
  tasks: InventorySessionTask[]
}

const STATUS_LABELS: Record<string, string> = {
  ASSIGNED: 'Asignadas',
  IN_PROGRESS: 'En progreso',
  PAUSED: 'Pausadas',
  COMPLETED: 'Completadas',
}

const STATUS_COLORS: Record<string, string> = {
  ASSIGNED: 'bg-slate-400',
  IN_PROGRESS: 'bg-sky-500',
  PAUSED: 'bg-amber-500',
  COMPLETED: 'bg-emerald-500',
}

export function InventoryTaskProgress({ tasks }: InventoryTaskProgressProps) {
  const active = tasks.filter(t => !t.cancelled_at)
  const completed = active.filter(t => t.status === 'COMPLETED').length
  const progress = active.length > 0 ? Math.round((completed / active.length) * 100) : 0
  const byStatus = ['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED'].map(status => ({
    status,
    count: active.filter(t => t.status === status).length,
  }))

  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme-text">Progreso de tareas</h3>
        <span className="text-sm font-bold text-theme-text">{completed}/{active.length}</span>
      </div>
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-theme-text/8">
        <div className="h-full rounded-full bg-theme-accent transition-all" style={{ width: `${progress}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {byStatus.map(({ status, count }) => (
          <div key={status} className="flex items-center gap-1.5 text-xs">
            <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[status]}`} />
            <span className="truncate text-theme-text-muted">{STATUS_LABELS[status]}</span>
            <span className="ml-auto font-semibold text-theme-text">{count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
