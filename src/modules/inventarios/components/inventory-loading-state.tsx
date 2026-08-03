import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'

interface InventoryLoadingStateProps {
  compact?: boolean
  label?: string
  className?: string
}

export function InventoryLoadingState({ compact, label = 'Cargando…', className }: InventoryLoadingStateProps) {
  if (compact) {
    return (
      <div className={cn('flex items-center gap-2 text-xs text-theme-text-muted/60', className)}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{label}</span>
      </div>
    )
  }
  return (
    <div className={cn('flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-theme-border bg-theme-surface/60', className)}>
      <Loader2 className="h-6 w-6 animate-spin text-theme-accent" />
      <p className="text-sm text-theme-text-muted">{label}</p>
    </div>
  )
}
