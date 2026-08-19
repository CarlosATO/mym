import { PurchaseOrdersPanel } from '@/modules/adquisiciones/ordenes-compra/purchase-orders-panel'

interface PageProps {
  searchParams: Promise<{ poId?: string | string[] | undefined }>
}

export default async function OrdenesCompraPage({ searchParams }: PageProps) {
  const params = await searchParams
  const poId = typeof params.poId === 'string' ? params.poId : undefined

  return <PurchaseOrdersPanel initialOpenPoId={poId} />
}
