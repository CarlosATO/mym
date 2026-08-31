import { Layers } from 'lucide-react'
import {
  getActiveCompanyAuditCandidates,
  getActiveCompanyAuditEligibleParticipants,
} from '@/app/actions/inventarios/audit-review'
import { getActiveCompanyCampaignDetail, getCampaignManagePermission } from '@/app/actions/inventarios/campaigns'
import { InventoryAuditReviewClient } from '@/modules/inventarios/components/inventory-audit-review-client'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function RevisionDiferenciasPage({ params }: PageProps) {
  const { id } = await params

  const [candidatesResult, participantsResult, campaignResult, managePermission] = await Promise.all([
    getActiveCompanyAuditCandidates(id, { page: 1, page_size: 50, sort_by: 'SKU', sort_direction: 'ASC' }),
    getActiveCompanyAuditEligibleParticipants(id),
    getActiveCompanyCampaignDetail(id),
    getCampaignManagePermission(),
  ])

  const companyId = candidatesResult.companyId ?? participantsResult.companyId

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

  if (candidatesResult.error && !candidatesResult.data) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description={candidatesResult.error} />
      </div>
    )
  }

  return (
    <InventoryAuditReviewClient
      campaignId={id}
      companyId={companyId}
      campaignName={campaignResult.data?.campaign?.name ?? ''}
      campaignStatus={candidatesResult.data?.campaign_status ?? null}
      initialCandidates={candidatesResult.data}
      initialParticipants={participantsResult.data?.participants ?? null}
      canManageCampaigns={managePermission.canManage}
    />
  )
}
