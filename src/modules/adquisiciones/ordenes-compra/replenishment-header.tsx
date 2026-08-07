'use client'

import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'

interface ReplenishmentHeaderProps {
  busy: boolean
  disabled: boolean
  onBack?: () => void
  onRefresh: () => void
}

export function ReplenishmentHeader({ busy, disabled, onBack, onRefresh }: ReplenishmentHeaderProps) {
  return (
    <div className="shrink-0 border-b border-theme-border bg-theme-surface px-5 py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="rounded-lg border border-theme-border p-1.5 text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0">
            <h2 className="text-base font-bold text-theme-text">Análisis de reposición</h2>
            <p className="text-xs text-theme-text-muted">Consulta productos para preparar una reposición.</p>
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={disabled}
          title={disabled && !busy ? 'Aplica una consulta antes de actualizar' : undefined}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted transition hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Actualizar
        </button>
      </div>
    </div>
  )
}
