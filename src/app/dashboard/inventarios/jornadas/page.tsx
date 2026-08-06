import Link from 'next/link'
import { ClipboardList, Plus } from 'lucide-react'
import { listActiveCompanyInventorySessions, getActiveCompanyWarehouses } from '@/app/actions/inventarios/sessions'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventorySessionFilters } from '@/modules/inventarios/components/inventory-session-filters'
import { InventorySessionTable } from '@/modules/inventarios/components/inventory-session-table'
import { InventorySessionMobileList } from '@/modules/inventarios/components/inventory-session-mobile-list'
import { InventoryPagination } from '@/modules/inventarios/components/inventory-pagination'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function InventariosJornadasPage({ searchParams }: PageProps) {
  const params = await searchParams

  const get = (key: string): string => {
    const value = params[key]
    return typeof value === 'string' ? value : ''
  }

  const search = get('q')
  const status = get('status')
  const warehouse = get('warehouse')
  const dateFrom = get('from')
  const dateTo = get('to')
  const page = Math.max(1, Number.parseInt(get('page') || '1', 10) || 1)
  const pageSize = 25

  const { data: warehouses } = await getActiveCompanyWarehouses()

  const { data, error, companyId } = await listActiveCompanyInventorySessions({
    status: status || undefined,
    warehouse_id: warehouse || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    search: search || undefined,
    page,
    page_size: pageSize,
  })

  const buildHref = (targetPage: number) => {
    const sp = new URLSearchParams()
    if (search) sp.set('q', search)
    if (status) sp.set('status', status)
    if (warehouse) sp.set('warehouse', warehouse)
    if (dateFrom) sp.set('from', dateFrom)
    if (dateTo) sp.set('to', dateTo)
    sp.set('page', String(targetPage))
    const qs = sp.toString()
    return qs ? `/dashboard/inventarios/jornadas?${qs}` : '/dashboard/inventarios/jornadas'
  }

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Secciones de conteo"
        description="Consulta y gestiona las secciones de conteo de la empresa."
        breadcrumb={['Inventarios', 'Secciones de conteo']}
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

      <InventorySessionFilters warehouses={warehouses ?? []} />

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
              icon={<ClipboardList className="h-5 w-5" />}
            />
          </div>
        ) : !data || data.sessions.length === 0 ? (
          <div className="p-4">
            <InventoryEmptyState
              title="No se encontraron secciones de conteo"
              description={
                search || status || warehouse || dateFrom || dateTo
                  ? 'Ninguna sección coincide con los filtros aplicados.'
                  : 'Aún no hay secciones de conteo para esta empresa.'
              }
              icon={<ClipboardList className="h-5 w-5" />}
            />
          </div>
        ) : (
          <>
            <div className="hidden lg:block">
              <InventorySessionTable sessions={data.sessions} />
            </div>
            <div className="lg:hidden">
              <InventorySessionMobileList sessions={data.sessions} />
            </div>
            <div className="px-2 py-2">
              <InventoryPagination
                page={data.page}
                pageSize={data.page_size}
                total={data.total}
                buildHref={buildHref}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
