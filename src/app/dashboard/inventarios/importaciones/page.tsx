import { Upload } from 'lucide-react'
import { getCompanyImportPermissions, getImportSites, listStockImports } from '@/app/actions/inventarios/imports'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryImportsPanel } from '@/modules/inventarios/components/inventory-imports-panel'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

export default async function InventariosImportacionesPage() {
  const [permissions, sites, list] = await Promise.all([
    getCompanyImportPermissions(),
    getImportSites(),
    listStockImports({ page: 1, pageSize: 50 }),
  ])

  const companyId = permissions.companyId ?? sites.companyId

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Importaciones"
        description="Carga stock teórico y costos desde una plantilla Excel. Una importación con advertencias puede utilizarse, pero los productos sin costo dejarán la valorización incompleta."
        breadcrumb={['Inventarios', 'Importaciones']}
      />

      {permissions.error || sites.error || list.error ? (
        <InventoryErrorState description={permissions.error ?? sites.error ?? list.error ?? 'Error'} />
      ) : !companyId ? (
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<Upload className="h-5 w-5" />}
        />
      ) : (
        <InventoryImportsPanel
          canRead={permissions.canRead}
          canManage={permissions.canManage}
          sites={sites.data ?? []}
          initialImports={list.data?.imports ?? []}
          initialTotal={list.data?.total ?? 0}
        />      )}
    </div>
  )
}
