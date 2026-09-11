import { MermasPanel } from '@/modules/logistica/mermas/mermas-panel'

export default async function MermaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <MermasPanel mode="detail" requestId={id} />
}
