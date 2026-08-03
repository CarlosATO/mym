'use client'

import { cn } from '@/lib/utils'
import { AlertTriangle } from 'lucide-react'

interface InventoryErrorStateProps {
  title?: string
  description?: string
  onRetry?: () => void
  className?: string
}

export function InventoryErrorState({
  title = 'No se pudo cargar la información',
  description,
  onRetry,
  className,
}: InventoryErrorStateProps) {
  return (
    <div className={cn('flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-6 py-10 text-center', className)}>
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-theme-text">{title}</p>
        {description && <p className="mx-auto max-w-sm text-xs text-theme-text-muted/70">{description}</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-lg border border-theme-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-text/5"
        >
          Reintentar
        </button>
      )}
    </div>
  )
}
