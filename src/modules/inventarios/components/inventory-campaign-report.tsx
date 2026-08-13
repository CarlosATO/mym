import {
  getActiveCompanyCampaignSummary,
  getActiveCompanyCampaignReadiness,
} from '@/app/actions/inventarios/campaign-report'
import { InventoryCampaignReportClient } from '@/modules/inventarios/components/inventory-campaign-report-client'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

interface InventoryCampaignReportProps {
  campaignId: string
  campaignName: string
}

export async function InventoryCampaignReport({ campaignId, campaignName }: InventoryCampaignReportProps) {
  // La tabla inicia vacía: NO se consulta list_inventory_campaign_variances al
  // entrar. Solo summary + readiness para que cabecera, KPIs y preparación para
  // cierre estén disponibles de inmediato.
  const [summaryResult, readinessResult] = await Promise.all([
    getActiveCompanyCampaignSummary(campaignId),
    getActiveCompanyCampaignReadiness(campaignId),
  ])

  const companyId = summaryResult.companyId ?? readinessResult.companyId

  if (!companyId) {
    return <InventoryErrorState description={summaryResult.error ?? 'No tienes una empresa activa seleccionada.'} />
  }

  return (
    <InventoryCampaignReportClient
      campaignId={campaignId}
      campaignName={campaignName}
      companyId={companyId}
      initialSummary={summaryResult.data}
      initialReadiness={readinessResult.data}
    />
  )
}
