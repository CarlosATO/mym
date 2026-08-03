'use client'

import { useEffect, useState } from 'react'
import { Eye } from 'lucide-react'
import type { InventorySessionReview } from '@/app/actions/inventarios/sessions'
import { getActiveCompanyReviewFor } from '@/app/actions/inventarios/review'
import { InventoryReviewBlockers } from '@/modules/inventarios/components/inventory-review-blockers'
import { InventoryTaskReviewCard } from '@/modules/inventarios/components/inventory-task-review-card'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'

interface InventoryReviewDashboardProps {
  companyId: string
  sessionId: string
  initialReview?: InventorySessionReview | null
}

export function InventoryReviewDashboard({ companyId, sessionId, initialReview }: InventoryReviewDashboardProps) {
  const [review, setReview] = useState<InventorySessionReview | null>(initialReview ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!initialReview)

  const load = async () => {
    const result = await getActiveCompanyReviewFor(sessionId)
    if (result.error || !result.data) {
      setError(result.error ?? 'No se pudo cargar la revisión.')
      setLoading(false)
      return
    }
    setReview(result.data)
    setError(null)
    setLoading(false)
  }

  useEffect(() => {
    if (!initialReview) {
      getActiveCompanyReviewFor(sessionId).then(result => {
        if (result.data) {
          setReview(result.data)
          setError(null)
        } else if (result.error) {
          setError(result.error)
        }
        setLoading(false)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  if (loading && !review) {
    return <InventoryLoadingState label="Cargando revisión de la jornada…" />
  }
  if (error && !review) {
    return <InventoryErrorState description={error} onRetry={load} />
  }
  if (!review) {
    return (
      <InventoryEmptyState
        title="Revisión no disponible"
        description="No se pudo cargar la revisión de esta jornada."
        icon={<Eye className="h-5 w-5" />}
      />
    )
  }

  const tasks = review.tasks
  const pending = tasks.filter(t => !t.cancelled_at && !t.validated_at && !t.validated_by)

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Por validar</p>
          <p className="text-xl font-bold text-theme-text">{review.indicators.pending_validation_count}</p>
        </div>
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Contribuciones</p>
          <p className="text-xl font-bold text-theme-text">{review.indicators.effective_contribution_count}</p>
        </div>
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Incidencias bloqueantes</p>
          <p className={`text-xl font-bold ${review.indicators.blocking_incident_count > 0 ? 'text-red-600 dark:text-red-400' : 'text-theme-text'}`}>
            {review.indicators.blocking_incident_count}
          </p>
        </div>
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Recuentos</p>
          <p className="text-xl font-bold text-theme-text">{review.recounts.length}</p>
        </div>
      </div>

      <InventoryReviewBlockers review={review} />

      {/* Tareas */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-theme-text">
          Tareas ({tasks.length}){pending.length > 0 && ` · ${pending.length} pendiente(s) de validar`}
        </h3>
        {tasks.length === 0 ? (
          <p className="text-sm text-theme-text-muted">Sin tareas para revisar.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {tasks.map(task => (
              <InventoryTaskReviewCard key={task.id} companyId={companyId} task={task} review={review} onChanged={load} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
