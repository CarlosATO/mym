import { Layers } from 'lucide-react'
import {
  getActiveCompanyBarcodeSummary,
  getActiveCompanyCampaignReadiness,
} from '@/app/actions/inventarios/campaign-report'
import { InventoryBarcodeIncidentsList } from '@/modules/inventarios/components/inventory-barcode-incidents-list'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function IncidenciasCodigosPage({ params }: PageProps) {
  const { id } = await params

  const [summaryResult, readinessResult] = await Promise.all([
    getActiveCompanyBarcodeSummary(id),
    getActiveCompanyCampaignReadiness(id),
  ])

  const companyId = summaryResult.companyId ?? readinessResult.companyId

  if (!companyId) {
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

  if (summaryResult.error && !summaryResult.data) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description={summaryResult.error} />
      </div>
    )
  }

  return (
    <InventoryBarcodeIncidentsList
      campaignId={id}
      companyId={companyId}
      initialSummary={summaryResult.data}
      campaignStatus={readinessResult.data?.campaign_status ?? null}
    />
  )
}
