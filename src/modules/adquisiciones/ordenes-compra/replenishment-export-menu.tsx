'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, Loader2 } from 'lucide-react'

interface ReplenishmentExportMenuProps {
  /** Hay resultados de una consulta válida */
  hasResults: boolean
  /** Total de filas en la consulta actual (filtered.length) */
  visibleCount: number
  /** Filas de la consulta actual que tienen check (filtered ∩ confirmedSet) */
  selectedCount: number
  downloading: boolean
  onExportVisible: () => void
  onExportSelected: () => void
}

export function ReplenishmentExportMenu({
  hasResults,
  visibleCount,
  selectedCount,
  downloading,
  onExportVisible,
  onExportSelected,
}: ReplenishmentExportMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Cerrar al hacer clic fuera
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Cerrar con Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  const triggerDisabled = !hasResults || downloading

  return (
    <div ref={rootRef} className="relative">
      {/* Botón principal */}
      <button
        id="excel-export-trigger"
        disabled={triggerDisabled}
        onClick={() => setOpen(prev => !prev)}
        title={!hasResults ? 'Sin resultados para exportar' : 'Opciones de exportación Excel'}
        className={[
          'flex h-7 items-center gap-1 rounded-md border px-2.5 text-[11px] font-semibold transition',
          'border-theme-border bg-theme-surface text-theme-text-muted',
          'hover:bg-theme-text/5 hover:text-theme-text',
          'disabled:cursor-not-allowed disabled:opacity-50',
        ].join(' ')}
      >
        {downloading
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <Download className="h-3 w-3" />
        }
        <span>Excel</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Menú desplegable */}
      {open && (
        <div
          className={[
            'absolute right-0 top-full z-[300] mt-1',
            'w-60 rounded-lg border border-theme-border bg-theme-surface shadow-xl',
            'overflow-hidden',
            'animate-in fade-in slide-in-from-top-1 duration-150',
          ].join(' ')}
          role="menu"
        >
          {/* Opción: Resultados visibles */}
          <button
            id="excel-export-visible"
            role="menuitem"
            disabled={!hasResults}
            onClick={() => { setOpen(false); onExportVisible() }}
            className={[
              'flex w-full flex-col gap-0.5 px-3.5 py-3 text-left transition',
              'hover:bg-theme-text/5',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'border-b border-theme-border/60',
            ].join(' ')}
          >
            <span className="flex items-center justify-between">
              <span className="text-xs font-semibold text-theme-text">
                Resultados visibles
              </span>
              {visibleCount > 0 && (
                <span className="rounded-full bg-theme-text/10 px-1.5 py-0.5 text-[10px] font-semibold text-theme-text-muted tabular-nums">
                  {visibleCount}
                </span>
              )}
            </span>
            <span className="text-[10px] text-theme-text-muted">
              Exporta el informe actual de la tabla
            </span>
          </button>

          {/* Opción: Solo seleccionados */}
          <button
            id="excel-export-selected"
            role="menuitem"
            disabled={selectedCount === 0}
            onClick={() => { setOpen(false); onExportSelected() }}
            title={selectedCount === 0 ? 'Sin productos seleccionados en la consulta actual' : undefined}
            className={[
              'flex w-full flex-col gap-0.5 px-3.5 py-3 text-left transition',
              'hover:bg-theme-text/5',
              'disabled:cursor-not-allowed disabled:opacity-50',
            ].join(' ')}
          >
            <span className="flex items-center justify-between">
              <span className={`text-xs font-semibold ${selectedCount === 0 ? 'text-theme-text-muted' : 'text-theme-text'}`}>
                Solo seleccionados
              </span>
              <span className={[
                'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                selectedCount === 0
                  ? 'bg-theme-text/5 text-theme-text-muted/50'
                  : 'bg-theme-accent/15 text-theme-accent',
              ].join(' ')}>
                {selectedCount}
              </span>
            </span>
            <span className="text-[10px] text-theme-text-muted">
              {selectedCount === 0
                ? 'Sin productos con check en esta consulta'
                : 'Exporta los productos marcados con check'}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
