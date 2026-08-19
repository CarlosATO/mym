'use client'

import { useRouter } from 'next/navigation'
import { ReplenishmentAnalysisPanel } from './replenishment-analysis-panel'

export function ReplenishmentPage() {
  const router = useRouter()

  return (
    <ReplenishmentAnalysisPanel
      onNavigateToPo={poId => {
        if (poId) router.push(`/dashboard/adquisiciones/ordenes-compra?poId=${encodeURIComponent(poId)}`)
      }}
    />
  )
}
