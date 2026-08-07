'use client'

import { useEffect, useRef } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { COLUMN_CONFIG_GROUPS, COLUMN_DEFS, type ColumnId } from './replenishment-columns'

interface ReplenishmentConfigPanelProps {
  open: boolean
  onClose: () => void
  hiddenColumns: Set<string>
  semanasVisible: boolean
  supplierFiltered: boolean
  onToggleColumn: (id: ColumnId) => void
  onRestoreDefault: () => void
}

export function ReplenishmentConfigPanel({
  open,
  onClose,
  hiddenColumns,
  semanasVisible,
  supplierFiltered,
  onToggleColumn,
  onRestoreDefault,
}: ReplenishmentConfigPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  useEffect(() => {
    if (open && panelRef.current) panelRef.current.focus()
  }, [open])

  const isColumnVisible = (id: ColumnId): boolean => {
    if (id === 'semanas') return semanasVisible
    return !hiddenColumns.has(id)
  }

  const supplierConfiguredVisible = !hiddenColumns.has('supplier')

  if (!open) return null

  return (
    <>
      {/* Panel */}
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Configuración de visualización"
        className={[
          'absolute inset-y-0 right-0 z-[210]',
          'w-[90%] sm:w-[320px] md:w-[25%] xl:w-[20%]',
          'flex flex-col',
          'bg-theme-surface border-l border-theme-border/60',
          'shadow-[−4px_0_24px_rgba(0,0,0,0.08)]',
          'outline-none',
          'animate-in slide-in-from-right duration-200',
        ].join(' ')}
      >
        {/* ── Header ── */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-b border-theme-border/50">
          <div className="min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-theme-text-muted/50 mb-0.5">
              Análisis de reposición
            </p>
            <h2 className="text-sm font-semibold text-theme-text leading-tight">
              Configuración de visualización
            </h2>
          </div>
          <button
            id="config-panel-close"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-theme-text-muted transition hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* ── Contenido ── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {COLUMN_CONFIG_GROUPS.map(group => (
            <div key={group.id}>
              {/* Etiqueta de grupo */}
              <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-theme-text-muted/50 mb-2">
                {group.label}
              </p>

              {/* Grid 2 columnas de checkboxes */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-0">
                {group.columns.map(id => {
                  const isSupplier = id === 'supplier'
                  const isDisabled = isSupplier && supplierFiltered
                  const checked = isColumnVisible(id)

                  return (
                    <div key={id}>
                      <label
                        className={[
                          'flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer select-none',
                          'text-[11px] font-medium transition-colors',
                          isDisabled
                            ? 'cursor-not-allowed opacity-40 text-theme-text-muted'
                            : checked
                              ? 'text-theme-text'
                              : 'text-theme-text-muted',
                          !isDisabled && 'hover:bg-theme-text/[0.04]',
                        ].filter(Boolean).join(' ')}
                      >
                        <input
                          type="checkbox"
                          id={`col-toggle-${id}`}
                          checked={checked}
                          disabled={isDisabled}
                          onChange={() => !isDisabled && onToggleColumn(id)}
                          className="h-3.5 w-3.5 rounded-sm border-theme-border/60 text-theme-accent accent-current disabled:cursor-not-allowed shrink-0"
                        />
                        <span className="truncate leading-none">{COLUMN_DEFS[id].label}</span>
                      </label>

                      {/* Nota contextual */}
                      {isSupplier && supplierFiltered && (
                        <p className="ml-9 mb-0.5 text-[9px] leading-tight text-theme-text-muted/50">
                          {supplierConfiguredVisible
                            ? 'Oculto por filtro activo'
                            : 'Ya oculto por configuración'}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Separador entre grupos */}
              <div className="mt-4 border-b border-theme-border/30" />
            </div>
          ))}
        </div>

        {/* ── Footer ── */}
        <div className="shrink-0 px-5 py-3 border-t border-theme-border/40">
          <button
            id="config-panel-restore"
            onClick={onRestoreDefault}
            className="flex items-center gap-1.5 text-[11px] font-medium text-theme-text-muted transition hover:text-theme-text"
          >
            <RotateCcw className="h-3 w-3" />
            Restaurar configuración predeterminada
          </button>
        </div>
      </aside>
    </>
  )
}
