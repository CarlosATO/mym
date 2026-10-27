import { notFound } from 'next/navigation'
import { PreparationCommercialPreview } from '@/modules/logistica/preparacion-pedidos/preparation-commercial-preview'

export default function PreparationCommercialPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <PreparationCommercialPreview />
}
