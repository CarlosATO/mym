import Link from 'next/link'
import { PlayCircle, Plus } from 'lucide-react'
import { listActiveCompanyInventorySessions } from '@/app/actions/inventarios/sessions'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventorySessionTable } from '@/modules/inventarios/components/inventory-session-table'
import { InventorySessionMobileList } from '@/modules/inventarios/components/inventory-session-mobile-list'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

export default async function InventariosOperacionPage() {
  const { data, error, companyId } = await listActiveCompanyInventorySessions({
    page_size: 100,
  })

  const operational = (data?.sessions ?? []).filter(s => s.status === 'PREPARED' || s.status === 'COUNTING')

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Operación"
        description="Abre jornadas preparadas y monitorea el avance del conteo."
        breadcrumb={['Inventarios', 'Operación']}
        action={
          <Link
            href="/dashboard/inventarios/jornadas/nueva"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-theme-accent-hover"
          >
            <Plus className="h-4 w-4" />
            Nueva jornada
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
              icon={<PlayCircle className="h-5 w-5" />}
            />
          </div>
        ) : operational.length === 0 ? (
          <div className="p-4">
            <InventoryEmptyState
              title="Sin jornadas en operación"
              description="Las jornadas preparadas o en conteo aparecerán aquí."
              icon={<PlayCircle className="h-5 w-5" />}
            />
          </div>
        ) : (
          <>
            <div className="hidden lg:block">
              <InventorySessionTable sessions={operational} />
            </div>
            <div className="lg:hidden">
              <InventorySessionMobileList sessions={operational} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
