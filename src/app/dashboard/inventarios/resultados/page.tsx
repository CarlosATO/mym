import Link from 'next/link'
import { FileCheck2, Search, X } from 'lucide-react'
import { getActiveCompanyResultSessions } from '@/app/actions/inventarios/results'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { InventoryPagination } from '@/modules/inventarios/components/inventory-pagination'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import { formatDateChile } from '@/modules/inventarios/lib/format'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const PAGE_SIZE = 100

export default async function InventariosResultadosPage({ searchParams }: PageProps) {
  const params = await searchParams

  const get = (key: string): string => {
    const value = params[key]
    return typeof value === 'string' ? value : ''
  }

  const search = get('q')
  const page = Math.max(1, Number.parseInt(get('page') || '1', 10) || 1)

  const { data, error, companyId } = await getActiveCompanyResultSessions({
    search: search || undefined,
    page,
    page_size: PAGE_SIZE,
  })

  const buildHref = (targetPage: number) => {
    const sp = new URLSearchParams()
    if (search) sp.set('q', search)
    sp.set('page', String(targetPage))
    const qs = sp.toString()
    return qs ? `/dashboard/inventarios/resultados?${qs}` : '/dashboard/inventarios/resultados'
  }

  const sessions = data?.sessions ?? []

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Resultados"
        description="Jornadas con resultado oficial: aprobadas, exportadas, conciliadas o canceladas."
        breadcrumb={['Inventarios', 'Resultados']}
      />

      <div className="flex items-center gap-2 rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
        <form action="/dashboard/inventarios/resultados" className="flex flex-1 items-center gap-2">
          <Search className="h-4 w-4 shrink-0 text-theme-text-muted/60" />
          <input
            name="q"
            defaultValue={search}
            placeholder="Buscar por número o nombre de jornada"
            className="h-8 w-full min-w-0 rounded-lg border border-theme-border bg-theme-bg px-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
            aria-label="Buscar jornada"
          />
          <button
            type="submit"
            className="inline-flex h-8 items-center rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
          >
            Buscar
          </button>
        </form>
        {search && (
          <Link
            href="/dashboard/inventarios/resultados"
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5"
            aria-label="Limpiar búsqueda"
          >
            <X className="h-3 w-3" />
            Limpiar
          </Link>
        )}
      </div>

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
              icon={<FileCheck2 className="h-5 w-5" />}
            />
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-4">
            <InventoryEmptyState
              title="Sin resultados"
              description={
                search
                  ? 'Ninguna jornada coincide con la búsqueda.'
                  : 'Las jornadas aprobadas, exportadas, conciliadas o canceladas aparecerán aquí.'
              }
              icon={<FileCheck2 className="h-5 w-5" />}
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                    <th className="px-3 py-2.5">Jornada</th>
                    <th className="px-3 py-2.5">Bodega</th>
                    <th className="px-3 py-2.5">Estado</th>
                    <th className="px-3 py-2.5">Responsable</th>
                    <th className="px-3 py-2.5">Fecha</th>
                    <th className="px-3 py-2.5 text-right">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(session => (
                    <tr key={session.id} className="border-b border-theme-border/40 last:border-0 hover:bg-theme-text/2">
                      <td className="max-w-[220px] truncate px-3 py-2.5">
                        <span className="font-semibold text-theme-text">#{session.session_number}</span>
                        <span className="ml-2 text-theme-text">{session.name}</span>
                      </td>
                      <td className="max-w-[140px] truncate px-3 py-2.5 text-theme-text-muted">
                        {session.warehouse_name ?? '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <InventoryStatusBadge status={session.status} />
                      </td>
                      <td className="max-w-[140px] truncate px-3 py-2.5 text-theme-text-muted">
                        {session.responsible_name ?? '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-theme-text-muted">
                        {session.status === 'CANCELLED'
                          ? formatDateChile(session.cancelled_at)
                          : formatDateChile(session.approved_at ?? session.created_at)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {session.status === 'CANCELLED' ? (
                          <Link
                            href={`/dashboard/inventarios/jornadas/${session.id}?tab=resultados`}
                            className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                          >
                            <FileCheck2 className="h-3 w-3" />
                            Ver cancelación
                          </Link>
                        ) : (
                          <Link
                            href={`/dashboard/inventarios/jornadas/${session.id}?tab=resultados`}
                            className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                          >
                            <FileCheck2 className="h-3 w-3" />
                            Ver resultados
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3">
              <InventoryPagination
                page={data?.page ?? 1}
                pageSize={data?.page_size ?? PAGE_SIZE}
                total={data?.total ?? 0}
                buildHref={buildHref}
                label="jornadas"
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
