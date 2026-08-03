import type { InventorySessionDetail, InventorySessionTask } from '@/app/actions/inventarios/sessions'
import { inventoryRoleLabel } from '@/modules/inventarios/lib/states'

interface InventoryTasksPanelProps {
  detail: InventorySessionDetail
}

const TASK_STATUS_ORDER = ['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED']
const TASK_STATUS_LABELS: Record<string, string> = {
  ASSIGNED: 'Asignadas',
  IN_PROGRESS: 'En progreso',
  PAUSED: 'Pausadas',
  COMPLETED: 'Completadas',
}

function TaskRow({ task }: { task: InventorySessionTask }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-theme-border/40 py-2 text-sm last:border-0">
      <div className="min-w-0">
        <p className="truncate font-medium text-theme-text">
          {task.task_kind === 'RECOUNT' ? 'Recuento' : 'Tarea'}
          {task.assignment?.user_name ? ` · ${task.assignment.user_name}` : ''}
        </p>
        <p className="text-xs text-theme-text-muted">
          {task.assignment?.functional_role ? inventoryRoleLabel(task.assignment.functional_role) : 'Sin asignación'}
        </p>
      </div>
      <span className="shrink-0 text-xs font-medium text-theme-text-muted">
        {task.status}
      </span>
    </div>
  )
}

export function InventoryTasksPanel({ detail }: InventoryTasksPanelProps) {
  const tasks = detail.tasks.filter(t => !t.cancelled_at)

  if (!tasks || tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-theme-border bg-theme-surface/60 p-8 text-center">
        <p className="text-sm text-theme-text-muted">Sin tareas registradas.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {TASK_STATUS_ORDER.map(status => {
        const group = tasks.filter(t => t.status === status)
        if (group.length === 0) return null
        return (
          <div key={status} className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
            <h4 className="mb-2 text-sm font-semibold text-theme-text">
              {TASK_STATUS_LABELS[status] ?? status}
              <span className="ml-2 text-xs font-normal text-theme-text-muted">({group.length})</span>
            </h4>
            {group.map(task => <TaskRow key={task.id} task={task} />)}
          </div>
        )
      })}
    </div>
  )
}
