import { notFound } from 'next/navigation'
import { InvoiceFlowPreview } from '@/modules/logistica/preparacion-pedidos/invoice-flow-preview'

export default function InvoiceFlowPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <InvoiceFlowPreview />
}
