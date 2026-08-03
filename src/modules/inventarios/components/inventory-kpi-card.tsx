'use client'

import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'

interface InventoryKpiCardProps {
  label: string
  value?: string | number | null
  hint?: string
  href?: string
  icon?: React.ReactNode
  loading?: boolean
}

export function InventoryKpiCard({ label, value, hint, href, icon, loading }: InventoryKpiCardProps) {
  const content = (
    <div className="group relative flex flex-col gap-2 rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm transition-all duration-200 hover:border-theme-border-accent hover:shadow-md">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-theme-text-muted">{label}</span>
        {icon && <span className="text-theme-text-muted/60">{icon}</span>}
      </div>
      {loading ? (
        <div className="py-1">
          <InventoryLoadingState compact />
        </div>
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-bold text-theme-text">
            {value === null || value === undefined ? '—' : value}
          </span>
          {href && <ArrowUpRight className="h-4 w-4 text-theme-text-muted/40 group-hover:text-theme-accent" />}
        </div>
      )}
      {hint && !loading && <span className="text-[11px] leading-snug text-theme-text-muted/70">{hint}</span>}
    </div>
  )

  if (href) {
    return (
      <Link href={href} className="block" aria-label={label}>
        {content}
      </Link>
    )
  }
  return content
}
