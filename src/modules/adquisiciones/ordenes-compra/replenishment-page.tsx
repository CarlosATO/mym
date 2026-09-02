'use client'

import { useRouter } from 'next/navigation'
import { ReplenishmentAnalysisPanel } from './replenishment-analysis-panel'

export function ReplenishmentPage() {
  const router = useRouter()

  return (
    <ReplenishmentAnalysisPanel
      onNavigateToPo={() => router.push('/dashboard/adquisiciones/ordenes-compra?prepare=replenishment')}
    />
  )
}
