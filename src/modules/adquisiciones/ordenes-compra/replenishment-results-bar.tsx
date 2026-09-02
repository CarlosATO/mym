'use client'

import { Eraser, RotateCcw } from 'lucide-react'
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
  canClearQuantities: boolean
  /** Filas de la consulta actual que tienen check activo (filtered ∩ confirmedSet) */
  selectedCount: number
  onExportVisible: () => void
  onExportSelected: () => void
  onCreate: () => void
  onClearQuantities: () => void
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
  canClearQuantities,
  selectedCount,
  onExportVisible,
  onExportSelected,
  onCreate,
  onClearQuantities,
  onNewQuery,
}: ReplenishmentResultsBarProps) {
  const disabled = busy || creating

  return (
    <div className="shrink-0 border-b border-theme-border bg-theme-surface/60 px-5 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] font-semibold text-theme-text">
          {resultCount} {resultCount === 1 ? 'producto' : 'productos'}
        </span>

        <span className="inline-flex min-w-0 items-baseline gap-1.5 rounded-md border border-theme-accent/20 bg-theme-accent/5 px-2.5 py-1 text-[11px] leading-tight text-theme-text">
          <span className="font-semibold text-theme-accent">Pedido actual</span>
          <span className="text-theme-text-muted">· {effectiveSkus} {effectiveSkus === 1 ? 'producto' : 'productos'} · {fmtN(effectiveUnits)} unidades ·</span>
          <strong className="truncate text-sm font-bold text-theme-text">Neto {fmt(effectiveCost)}</strong>
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ReplenishmentExportMenu
            hasResults={resultCount > 0 && !disabled}
            visibleCount={resultCount}
            selectedCount={selectedCount}
            downloading={downloading}
            onExportVisible={onExportVisible}
            onExportSelected={onExportSelected}
          />

          <button
            id="clear-quantities-button"
            onClick={onClearQuantities}
            disabled={disabled || !canClearQuantities}
            title="Poner en 0 las cantidades de la consulta actual"
            className="flex h-7 items-center gap-1 rounded-md border border-theme-border px-2.5 text-[11px] font-semibold text-theme-text-muted transition hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Eraser className="h-3 w-3" />
            Limpiar cantidades
          </button>

          <button
            id="create-po-button"
            onClick={onCreate}
            disabled={disabled || effectiveSkus === 0}
             title={effectiveSkus === 0 ? 'Selecciona productos con cantidad mayor a 0 para preparar una OC' : 'Preparar OC con los productos seleccionados'}
            className="flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-3 text-[11px] font-bold text-white shadow-sm shadow-emerald-600/15 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
             Preparar Orden de Compra
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
