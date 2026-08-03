import { cn } from '@/lib/utils'

interface InventoryEmptyStateProps {
  title: string
  description?: string
  icon?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

export function InventoryEmptyState({ title, description, icon, action, className }: InventoryEmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 py-12 text-center', className)}>
      {icon && <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-theme-text/5 text-theme-text-muted/60">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-theme-text">{title}</p>
        {description && <p className="mx-auto max-w-sm text-xs text-theme-text-muted/70">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
