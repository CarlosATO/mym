import { cn } from '@/lib/utils'
import { inventoryStatusLabel, inventoryStatusTone, type InventoryStatusTone } from '@/modules/inventarios/lib/states'

const TONE_CLASSES: Record<InventoryStatusTone, string> = {
  neutral: 'bg-slate-500/10 text-slate-700 border-slate-500/20 dark:text-slate-300 dark:bg-slate-400/10',
  info: 'bg-sky-500/10 text-sky-700 border-sky-500/20 dark:text-sky-300 dark:bg-sky-400/10',
  warning: 'bg-amber-500/10 text-amber-700 border-amber-500/25 dark:text-amber-300 dark:bg-amber-400/10',
  purple: 'bg-violet-500/10 text-violet-700 border-violet-500/20 dark:text-violet-300 dark:bg-violet-400/10',
  success: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:text-emerald-300 dark:bg-emerald-400/10',
  danger: 'bg-red-500/10 text-red-700 border-red-500/25 dark:text-red-300 dark:bg-red-400/10',
}

interface InventoryStatusBadgeProps {
  status: string | null | undefined
  className?: string
}

export function InventoryStatusBadge({ status, className }: InventoryStatusBadgeProps) {
  const tone = inventoryStatusTone(status)
  return (
    <span
      title={inventoryStatusLabel(status)}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className
      )}
    >
      {inventoryStatusLabel(status)}
    </span>
  )
}
