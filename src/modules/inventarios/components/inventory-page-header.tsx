import { cn } from '@/lib/utils'

interface InventoryPageHeaderProps {
  title: string
  description?: string
  breadcrumb?: string[]
  showBreadcrumb?: boolean
  action?: React.ReactNode
  className?: string
}

export function InventoryPageHeader({ title, description, breadcrumb, showBreadcrumb = false, action, className }: InventoryPageHeaderProps) {
  return (
    <div className={cn('mb-5', className)}>
      {showBreadcrumb && breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1.5 flex items-center gap-1.5 text-[11px] text-theme-text-muted/70">
          {breadcrumb.map((crumb, index) => (
            <span key={crumb} className="flex items-center gap-1.5">
              {index > 0 && <span aria-hidden>/</span>}
              <span>{crumb}</span>
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-bold text-theme-text sm:text-2xl">{title}</h1>
          {description && <p className="max-w-2xl text-sm text-theme-text-muted/80">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  )
}
