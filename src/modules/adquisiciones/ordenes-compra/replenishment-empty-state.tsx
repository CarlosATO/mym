'use client'

import { Filter, Loader2, RotateCcw, Search } from 'lucide-react'

interface ReplenishmentEmptyStateProps {
  variant: 'initial' | 'no-results' | 'loading'
  onClear?: () => void
  title?: string
  subtitle?: string
}

export function ReplenishmentEmptyState({ variant, onClear, title, subtitle }: ReplenishmentEmptyStateProps) {
  if (variant === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="flex max-w-md flex-col items-center text-center">
          <Loader2 className="mb-4 h-6 w-6 animate-spin text-theme-accent" />
          <h3 className="text-sm font-semibold text-theme-text">{title || 'Preparando datos'}</h3>
          {subtitle && <p className="mt-1.5 text-xs leading-relaxed text-theme-text-muted">{subtitle}</p>}
        </div>
      </div>
    )
  }

  const isInitial = variant === 'initial'

  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-theme-border bg-theme-text/5 text-theme-text-muted">
          {isInitial ? <Search className="h-5 w-5" /> : <Filter className="h-5 w-5" />}
        </div>
        <h3 className="text-sm font-semibold text-theme-text">
          {isInitial ? 'Selecciona qué deseas analizar' : 'No encontramos productos con los filtros seleccionados.'}
        </h3>
        <p className="mt-1.5 text-xs leading-relaxed text-theme-text-muted">
          {isInitial
            ? 'Define los criterios de búsqueda y los resultados se mostrarán automáticamente.'
            : 'Ajusta los filtros o vuelve a intentar con otros criterios.'}
        </p>
        {!isInitial && onClear && (
          <button
            onClick={onClear}
            className="mt-4 flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3.5 text-xs font-semibold text-theme-text-muted transition hover:bg-theme-text/5 hover:text-theme-text"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Nueva consulta
          </button>
        )}
      </div>
    </div>
  )
}
