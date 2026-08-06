import Link from 'next/link'
import { Monitor, Play, Plus } from 'lucide-react'
import { listActiveCompanySessionsAll } from '@/app/actions/inventarios/sessions'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { computeProgress, formatDateChile } from '@/modules/inventarios/lib/format'

export default async function InventariosOperacionPage() {
  const [prepared, counting] = await Promise.all([
    listActiveCompanySessionsAll({ status: 'PREPARED' }),
    listActiveCompanySessionsAll({ status: 'COUNTING' }),
  ])

  const companyId = prepared.companyId ?? counting.companyId
  const error = prepared.error ?? counting.error
  const byId = new Map<string, import('@/app/actions/inventarios/sessions').InventorySessionSummary>()
  for (const s of prepared.data ?? []) byId.set(s.id, s)
  for (const s of counting.data ?? []) byId.set(s.id, s)
  const operational = Array.from(byId.values()).sort((a, b) => b.created_at.localeCompare(a.created_at))

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Operación"
        description="Abre secciones de conteo preparadas y monitorea el avance del conteo."
        breadcrumb={['Inventarios', 'Operación']}
        action={
          <Link
            href="/dashboard/inventarios/jornadas/nueva"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover"
          >
            <Plus className="h-4 w-4" />
            Nueva sección de conteo
          </Link>
        }
      />

      <div className="rounded-xl border border-theme-border bg-theme-surface shadow-sm">
        {error ? (
          <div className="p-4">
            <InventoryErrorState description={error} />
          </div>
        ) : !companyId ? (
          <div className="p-4">
            <InventoryEmptyState
              title="Selecciona una empresa"
              description="No tienes una empresa activa seleccionada."
              icon={<Play className="h-5 w-5" />}
            />
          </div>
        ) : operational.length === 0 ? (
          <div className="p-4">
            <InventoryEmptyState
              title="Sin secciones de conteo en operación"
              description="Las secciones preparadas o en conteo aparecerán aquí."
              icon={<Play className="h-5 w-5" />}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                  <th className="px-3 py-2">Sección de conteo</th>
                  <th className="px-3 py-2">Bodega</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Avance</th>
                  <th className="px-3 py-2">Responsable</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-1.5 text-right">Acción</th>
                </tr>
              </thead>
              <tbody>
                {operational.map(session => {
                  const progress = computeProgress(session.task_count, session.task_completed_count)
                  const isPrepared = session.status === 'PREPARED'
                  return (
                    <tr key={session.id} className="border-b border-theme-border/40 last:border-0 hover:bg-theme-text/2">
                      <td className="max-w-[220px] truncate px-3 py-1.5">
                        <span className="font-semibold text-theme-text">#{session.session_number}</span>
                        <span className="ml-2 text-theme-text">{session.name}</span>
                      </td>
                      <td className="max-w-[140px] truncate px-3 py-1.5 text-theme-text-muted">
                        {session.warehouse_name ?? '—'}
                      </td>
                      <td className="px-3 py-1.5">
                        <InventoryStatusBadge status={session.status} />
                      </td>
                      <td className="px-3 py-1.5">
                        {progress === null ? (
                          <span className="text-xs text-theme-text-muted/50">—</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-theme-text/8">
                              <div className="h-full rounded-full bg-theme-accent" style={{ width: `${progress}%` }} />
                            </div>
                            <span className="text-xs text-theme-text-muted">{progress}%</span>
                          </div>
                        )}
                      </td>
                      <td className="max-w-[140px] truncate px-3 py-1.5 text-theme-text-muted">
                        {session.responsible_name ?? '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-theme-text-muted">
                        {formatDateChile(session.created_at)}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Link
                          href={`/dashboard/inventarios/jornadas/${session.id}?tab=operacion`}
                          className="inline-flex h-6 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                        >
                          {isPrepared ? <Play className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
                          {isPrepared ? 'Abrir' : 'Monitorear'}
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
