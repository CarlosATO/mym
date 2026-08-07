'use client'

import { RotateCcw } from 'lucide-react'
import { fmt, fmtN } from './replenishment-format'
import { ReplenishmentExportMenu } from './replenishment-export-menu'

interface ReplenishmentResultsBarProps {
  resultCount: number
  effectiveSkus: number
  effectiveUnits: number
  effectiveCost: number
  busy: boolean
  downloading: boolean
  creating: boolean
  /** Filas de la consulta actual que tienen check activo (filtered ∩ confirmedSet) */
  selectedCount: number
  onExportVisible: () => void
  onExportSelected: () => void
  onCreate: () => void
  onNewQuery: () => void
}

export function ReplenishmentResultsBar({
  resultCount,
  effectiveSkus,
  effectiveUnits,
  effectiveCost,
  busy,
  downloading,
  creating,
  selectedCount,
  onExportVisible,
  onExportSelected,
  onCreate,
  onNewQuery,
}: ReplenishmentResultsBarProps) {
  const disabled = busy || creating

  return (
    <div className="shrink-0 border-b border-theme-border bg-theme-surface/60 px-5 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] font-semibold text-theme-text">
          {resultCount} {resultCount === 1 ? 'producto' : 'productos'}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {effectiveSkus > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-theme-border bg-theme-bg/40 px-2.5 py-1 text-[11px] leading-tight">
              <span className="font-medium text-theme-text-muted">Confirmado:</span>
              <span>SKU <strong className="font-semibold text-theme-text">{effectiveSkus}</strong></span>
              <span>Unid. <strong className="font-semibold text-theme-text">{fmtN(effectiveUnits)}</strong></span>
              <span>Monto <strong className="font-semibold text-theme-text">{fmt(effectiveCost)}</strong></span>
            </span>
          )}

          <ReplenishmentExportMenu
            hasResults={resultCount > 0 && !disabled}
            visibleCount={resultCount}
            selectedCount={selectedCount}
            downloading={downloading}
            onExportVisible={onExportVisible}
            onExportSelected={onExportSelected}
          />

          <button
            id="create-po-button"
            onClick={onCreate}
            disabled={disabled || effectiveSkus === 0}
            title={effectiveSkus === 0 ? 'Selecciona productos con cantidad mayor a 0 para crear una OC' : 'Crear OC con los productos seleccionados'}
            className="flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-3 text-[11px] font-bold text-white shadow-sm shadow-emerald-600/15 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Crear borrador de OC
          </button>

          <span className="mx-0.5 h-4 w-px bg-theme-border/60" />

          <button
            id="new-query-button"
            onClick={onNewQuery}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent px-2 text-[11px] font-semibold text-theme-text-muted transition hover:bg-theme-text/5 hover:text-theme-text"
          >
            <RotateCcw className="h-3 w-3" />
            Nueva consulta
          </button>
        </div>
      </div>
    </div>
  )
}
