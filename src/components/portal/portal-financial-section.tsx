'use client'

import { useState } from 'react'
import { PortalFinancialCard } from '@/components/portal/portal-financial-cards'
import { PortalPeriodSelector } from '@/components/portal/portal-period-selector'
import type { PortalCollectionsByMode } from '@/app/actions/portal/collections'
import type { PortalSales } from '@/app/actions/portal/sales'
import { getPortalPeriod, type PortalPeriodMode } from '@/app/actions/portal/periods'

type PortalFinancialSectionProps = {
  sales: Record<PortalPeriodMode, PortalSales | null>
  collections: PortalCollectionsByMode
  salesError: boolean
  collectionsError: boolean
}

export function PortalFinancialSection({ sales, collections, salesError, collectionsError }: PortalFinancialSectionProps) {
  const [mode, setMode] = useState<PortalPeriodMode>('CALENDAR_MONTH')
  const period = getPortalPeriod(mode)

  return (
    <>
      <div className="col-span-full">
        <PortalPeriodSelector mode={mode} onChange={setMode} />
      </div>
      <div className="min-w-0">
        <PortalFinancialCard kind="sales" data={sales[mode]} error={salesError ? 'sales' : null} mode={mode} period={period} />
      </div>
      <div className="min-w-0">
        <PortalFinancialCard kind="collections" data={collections[mode]} error={collectionsError ? 'collections' : null} mode={mode} period={period} />
      </div>
    </>
  )
}
