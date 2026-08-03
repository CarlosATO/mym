import { InventoryPageHeader } from '@/modules/inventarios/components/inventory-page-header'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'

interface InventorySectionPageProps {
  title: string
  description: string
  breadcrumb: string[]
  emptyTitle: string
  emptyDescription: string
  icon?: React.ReactNode
  action?: React.ReactNode
}

export function InventorySectionPage({
  title,
  description,
  breadcrumb,
  emptyTitle,
  emptyDescription,
  icon,
  action,
}: InventorySectionPageProps) {
  return (
    <div className="space-y-6">
      <InventoryPageHeader title={title} description={description} breadcrumb={breadcrumb} action={action} />
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <InventoryEmptyState title={emptyTitle} description={emptyDescription} icon={icon} />
      </div>
    </div>
  )
}
