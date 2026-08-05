import { Layers } from 'lucide-react'
import { getCampaignManagePermission } from '@/app/actions/inventarios/campaigns'
import { getActiveCompanySites } from '@/app/actions/inventarios/sites'
import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryCampaignCreateForm } from '@/modules/inventarios/components/inventory-campaign-create-form'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

export default async function InventariosNuevaCampanaPage() {
  const [permission, sitesResult] = await Promise.all([
    getCampaignManagePermission(),
    getActiveCompanySites(),
  ])

  if (!permission.companyId || !sitesResult.companyId) {
    return (
      <div className="space-y-5">
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<Layers className="h-5 w-5" />}
        />
      </div>
    )
  }

  if (permission.error) {
    return <InventoryErrorState description={permission.error} />
  }

  if (sitesResult.error) {
    return <InventoryErrorState description={sitesResult.error} />
  }

  if (!permission.canManage) {
    return <InventoryErrorState description="No tienes permisos para crear campañas de inventario." />
  }

  const eligibleSites = (sitesResult.data ?? []).filter(
    site => site.site_type === 'INTERNAL_WAREHOUSE' && site.is_active && site.inventory_enabled
  )

  if (eligibleSites.length === 0) {
    return (
      <InventoryEmptyState
        title="Sin bodegas elegibles"
        description="No hay bodegas internas habilitadas para crear una campaña general."
        icon={<Layers className="h-5 w-5" />}
      />
    )
  }

  return (
    <div className="space-y-5">
      <InventoryPageHeader
        title="Nueva campaña"
        description="Crea una campaña general con todas las bodegas internas habilitadas y todos los productos."
        breadcrumb={['Inventarios', 'Campañas', 'Nueva campaña']}
      />

      <InventoryCampaignCreateForm eligibleSites={eligibleSites} />
    </div>
  )
}
