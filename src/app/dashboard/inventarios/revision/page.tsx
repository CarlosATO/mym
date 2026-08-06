import Link from 'next/link'
import { Eye } from 'lucide-react'
import { listActiveCompanySessionsAll } from '@/app/actions/inventarios/sessions'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { formatDateChile } from '@/modules/inventarios/lib/format'

export default async function InventariosRevisionPage() {
  const { data, error, companyId } = await listActiveCompanySessionsAll({
    status: 'UNDER_REVIEW',
  })

  const sessions = data ?? []

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Revisión"
        description="Secciones de conteo en revisión: valida tareas y prepara la aprobación."
        breadcrumb={['Inventarios', 'Revisión']}
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
              icon={<Eye className="h-5 w-5" />}
            />
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-4">
            <InventoryEmptyState
              title="Sin secciones de conteo en revisión"
              description="Las secciones cerradas que esperan validación aparecerán aquí."
              icon={<Eye className="h-5 w-5" />}
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
                  <th className="px-3 py-2">Responsable</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-1.5 text-right">Acción</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(session => (
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
                    <td className="max-w-[140px] truncate px-3 py-1.5 text-theme-text-muted">
                      {session.responsible_name ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-theme-text-muted">
                      {formatDateChile(session.created_at)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Link
                        href={`/dashboard/inventarios/jornadas/${session.id}?tab=revision`}
                        className="inline-flex h-6 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                      >
                        <Eye className="h-3 w-3" />
                        Revisar
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
