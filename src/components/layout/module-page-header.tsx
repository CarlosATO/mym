'use client'

import { cn } from '@/lib/utils'

export interface ModulePageHeaderProps {
  title: string
  breadcrumb: string[]
  description?: string
  actions?: React.ReactNode
  compact?: boolean
}

export function ModulePageHeader({ title, breadcrumb, description, actions, compact = false }: ModulePageHeaderProps) {
  return (
    <section className={cn(
      'shrink-0 border-b border-theme-border/70 bg-theme-surface/88 backdrop-blur-sm',
      compact ? 'px-4 py-2' : 'px-5 py-3'
    )}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70 mb-0.5">
            {breadcrumb.map((item, index) => (
              <span key={`${item}-${index}`} className="inline-flex items-center gap-1.5 min-w-0">
                {index > 0 && <span className="text-theme-accent/70">/</span>}
                <span className={cn(index === breadcrumb.length - 1 && 'text-theme-accent')}>{item}</span>
              </span>
            ))}
          </div>
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-base font-bold text-theme-text truncate">{title}</h1>
            {description && (
              <p className="hidden lg:block text-xs text-theme-text-muted/70 truncate">{description}</p>
            )}
          </div>
        </div>
        {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
      </div>
    </section>
  )
}
