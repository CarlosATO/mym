import { ClipboardList } from 'lucide-react'
import { getInventorySessionCatalogs } from '@/app/actions/inventarios/sessions'
import { getCampaignSessionCreatePermission } from '@/app/actions/inventarios/campaigns'
import { getActiveCompanyId } from '@/app/actions/companies'
import { AccessDenied } from '@/components/access-denied'
import { InventorySessionWizard } from '@/modules/inventarios/components/inventory-session-wizard'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'
import type { WizardCatalogs } from '@/modules/inventarios/lib/wizard'

export default async function InventariosNuevaJornadaPage() {
  const permission = await getCampaignSessionCreatePermission()
  const companyId = await getActiveCompanyId()

  if (companyId && !permission.canCreate) {
    return <AccessDenied />
  }

  if (!companyId) {
    return (
      <div className="space-y-5">
        <InventoryEmptyState
          title="Selecciona una empresa"
          description="No tienes una empresa activa seleccionada."
          icon={<ClipboardList className="h-5 w-5" />}
        />
      </div>
    )
  }

  const { data: catalogs, error } = await getInventorySessionCatalogs(companyId)

  if (error || !catalogs) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description={error ?? 'No se pudieron cargar los catálogos.'} />
      </div>
    )
  }

  const wizardCatalogs: WizardCatalogs = {
    warehouses: catalogs.warehouses ?? [],
    offices: catalogs.offices ?? [],
    users: catalogs.users ?? [],
  }

  return <InventorySessionWizard companyId={companyId} catalogs={wizardCatalogs} />
}
