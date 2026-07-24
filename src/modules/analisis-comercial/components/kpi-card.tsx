'use client'

import { cn } from '@/lib/utils'
import * as LucideIcons from 'lucide-react'

interface KpiCardProps {
  title: string
  value: string
  subtitle?: string
  icon?: string
  trend?: 'up' | 'down' | 'neutral'
  accent?: boolean
  loading?: boolean
}

function KpiIcon({ iconName, accent }: { iconName: string; accent?: boolean }) {
  const Icon = (LucideIcons as unknown as Record<string, LucideIcons.LucideIcon>)[iconName]
  if (!Icon) return null
  return (
    <div className={cn(
      'flex items-center justify-center w-9 h-9 rounded-lg shrink-0',
      accent
        ? 'bg-theme-accent/15 text-theme-accent'
        : 'bg-theme-text/5 text-theme-text-muted'
    )}>
      <Icon className="h-4 w-4" />
    </div>
  )
}

export function KpiCard({ title, value, subtitle, icon, accent, loading }: KpiCardProps) {
  return (
    <div className={cn(
      'rounded-xl border p-4 transition-all duration-200',
      accent
        ? 'border-theme-border-accent bg-theme-accent/8 shadow-sm'
        : 'border-theme-border bg-theme-surface/60 shadow-sm'
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="text-[11px] font-semibold text-theme-text-muted/70 uppercase tracking-wider truncate">
            {title}
          </p>
          {loading ? (
            <div className="h-7 w-24 rounded bg-theme-text/5 animate-pulse" />
          ) : (
            <p className={cn(
              'text-xl font-bold tracking-tight truncate',
              accent ? 'text-theme-text-accent' : 'text-theme-text'
            )}>
              {value}
            </p>
          )}
          {subtitle && (
            <p className="text-[10px] text-theme-text-muted/60 truncate">
              {subtitle}
            </p>
          )}
        </div>
        {icon && <KpiIcon iconName={icon} accent={accent} />}
      </div>
    </div>
  )
}
