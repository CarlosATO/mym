'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'

interface InventoryCampaignReportPrefetchProps {
  campaignId: string
  active: boolean
}

export function InventoryCampaignReportPrefetch({ campaignId, active }: InventoryCampaignReportPrefetchProps) {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!active) return
    const href = `/dashboard/inventarios/campanas/${campaignId}?tab=informe`
    router.prefetch(href)
  }, [active, campaignId, router, pathname])

  return null
}
