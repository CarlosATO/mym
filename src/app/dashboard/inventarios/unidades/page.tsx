import { Boxes } from 'lucide-react'
import { getActiveCompanySites } from '@/app/actions/inventarios/sites'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventorySitesPanel } from '@/modules/inventarios/components/inventory-sites-panel'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

export default async function InventariosUnidadesPage() {
  const { data, error, companyId } = await getActiveCompanySites()
  const sites = data ?? []

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Unidades inventariables"
        description="Configura qué bodegas o locales participan en inventarios y cuáles se incluyen automáticamente en campañas generales."
        breadcrumb={['Inventarios', 'Unidades']}
      />

      {error ? (
        <InventoryErrorState description={error} />
      ) : !companyId ? (
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<Boxes className="h-5 w-5" />}
        />
      ) : sites.length === 0 ? (
        <InventoryEmptyState
          title="Sin unidades inventariables"
          description="Las bodegas y locales que participan en inventarios aparecerán aquí."
          icon={<Boxes className="h-5 w-5" />}
        />
      ) : (
        <InventorySitesPanel sites={sites} />
      )}
    </div>
  )
}
