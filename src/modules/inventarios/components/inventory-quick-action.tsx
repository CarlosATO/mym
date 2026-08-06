'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'

interface InventoryQuickActionProps {
  label: string
  description?: string
  href: string
  icon: React.ReactNode
}

export function InventoryQuickAction({ label, description, href, icon }: InventoryQuickActionProps) {
  return (
    <Link
      href={href}
      className={cn(
        'group flex items-center gap-3 rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm transition-all duration-200',
        'hover:border-theme-border-accent hover:shadow-md'
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-text/5 text-theme-text-muted transition-colors group-hover:bg-theme-accent/10 group-hover:text-theme-accent">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-theme-text">{label}</span>
        {description && (
          <span className="block truncate text-xs text-theme-text-muted/70">{description}</span>
        )}
      </span>
    </Link>
  )
}
