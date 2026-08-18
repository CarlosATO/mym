import { Layers } from 'lucide-react'
import { getActiveCompanyBarcodeDetail } from '@/app/actions/inventarios/campaign-report'
import { InventoryBarcodeIncidentDetail } from '@/modules/inventarios/components/inventory-barcode-incident-detail'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { InventoryErrorState } from '@/modules/inventarios/components/inventory-error-state'

interface PageProps {
  params: Promise<{ id: string; bsaleVariantId: string }>
}

export default async function IncidenciaCodigoDetallePage({ params }: PageProps) {
  const { id, bsaleVariantId } = await params
  const variantId = Number(bsaleVariantId)
  if (!Number.isInteger(variantId)) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description="El producto solicitado no es válido." />
      </div>
    )
  }

  const result = await getActiveCompanyBarcodeDetail(id, variantId)

  if (!result.companyId) {
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

  if (result.error && !result.data) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description={result.error} />
      </div>
    )
  }

  if (!result.data) {
    return (
      <div className="space-y-5">
        <InventoryErrorState description="No se encontró el detalle del producto." />
      </div>
    )
  }

  return (
    <InventoryBarcodeIncidentDetail
      campaignId={id}
      companyId={result.companyId}
      initialDetail={result.data}
    />
  )
}
