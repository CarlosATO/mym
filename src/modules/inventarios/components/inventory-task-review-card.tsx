import { UserRound } from 'lucide-react'
import type { InventorySessionReview, InventorySessionTask } from '@/app/actions/inventarios/sessions'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryReviewActions } from '@/modules/inventarios/components/inventory-review-actions'

interface InventoryTaskReviewCardProps {
  companyId: string
  task: InventorySessionTask
  review: InventorySessionReview
  onChanged: () => void
}

function contributionSummaryFor(review: InventorySessionReview, taskId: string): string {
  const rows = (review.contributions ?? []).filter(c => c.task_id === taskId)
  if (rows.length === 0) return 'Sin contribuciones efectivas'
  return `${rows.length} contribucion(es) efectiva(s)`
}

export function InventoryTaskReviewCard({ companyId, task, review, onChanged }: InventoryTaskReviewCardProps) {
  const pending = !task.validated_at && !task.validated_by
  const statusLabel = task.cancelled_at
    ? 'Cancelada'
    : pending
      ? 'Pendiente de validar'
      : task.validated_at && task.validated_by
        ? 'Validada'
        : task.status

  return (
    <div className="rounded-lg border border-theme-border/60 bg-theme-text/2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-theme-text">
            Tarea {task.id.slice(0, 8)}
            {task.assignment?.user_name && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-theme-text-muted">
                <UserRound className="h-3 w-3" />
                {task.assignment.user_name}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-theme-text-muted">
            Ciclo {task.validation_cycle} · {statusLabel}
            {task.validated_by_name && <span> · validada por {task.validated_by_name}</span>}
          </p>
        </div>
        <InventoryStatusBadge status={task.cancelled_at ? 'CANCELLED' : pending ? 'UNDER_REVIEW' : 'APPROVED'} />
      </div>

      <p className="mt-2 text-xs text-theme-text-muted/80">
        {contributionSummaryFor(review, task.id)}
      </p>

      {!task.cancelled_at && (
        <div className="mt-2">
          <InventoryReviewActions
            companyId={companyId}
            task={task}
            contributionSummary={contributionSummaryFor(review, task.id)}
            onChanged={onChanged}
          />
        </div>
      )}
    </div>
  )
}
