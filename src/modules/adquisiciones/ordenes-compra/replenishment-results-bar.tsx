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
  onImportFile: () => void
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
  onImportFile,
  onCreate,
  onClearQuantities,
  onNewQuery,
}: ReplenishmentResultsBarProps) {
  const disabled = busy || creating

  return (
    <div className="shrink-0 border-b border-[#D1C7BD] bg-[#EFE9E1] px-5 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-[11px] font-semibold text-[#322D29]">
          {resultCount} {resultCount === 1 ? 'producto' : 'productos'}
        </span>

        <span className="inline-flex min-w-0 items-baseline gap-2 border-l-2 border-[#72383D] px-3 py-1 text-[11px] leading-tight text-[#322D29]">
          <span className="font-bold text-[#72383D]">Pedido actual</span>
          <span className="text-[#AC9C8D]">{effectiveSkus} {effectiveSkus === 1 ? 'producto' : 'productos'} · {fmtN(effectiveUnits)} unidades</span>
          <strong className="truncate text-sm font-bold text-[#322D29]">Neto {fmt(effectiveCost)}</strong>
        </span>

        <div className="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
          <ReplenishmentExportMenu
            hasResults={resultCount > 0 && !disabled}
            visibleCount={resultCount}
            selectedCount={selectedCount}
            downloading={downloading}
            onExportVisible={onExportVisible}
            onExportSelected={onExportSelected}
          />

          <button
            type="button"
            id="create-po-from-file-button"
            onClick={onImportFile}
            className="flex h-7 items-center gap-1 rounded-md border border-[#72383D]/40 px-2.5 text-[11px] font-semibold text-[#72383D] transition hover:bg-[#72383D]/10"
          >
            Crear OC desde archivo
          </button>

          <button
            id="clear-quantities-button"
            onClick={onClearQuantities}
            disabled={disabled || !canClearQuantities}
            title="Poner en 0 las cantidades de la consulta actual"
            className="flex h-7 items-center gap-1 rounded-md border border-[#D1C7BD] px-2.5 text-[11px] font-semibold text-[#AC9C8D] transition hover:bg-[#D1C7BD]/40 hover:text-[#322D29] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Eraser className="h-3 w-3" />
            Limpiar cantidades
          </button>

          <button
            id="create-po-button"
            onClick={onCreate}
            disabled={disabled || effectiveSkus === 0}
            title={effectiveSkus === 0 ? 'Selecciona productos con cantidad mayor a 0 para preparar una OC' : 'Preparar OC con los productos seleccionados'}
            className="flex h-7 items-center gap-1 rounded-md bg-[#72383D] px-3 text-[11px] font-bold text-white transition hover:bg-[#5E2E33] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Preparar Orden de Compra
          </button>

          <span className="mx-0.5 h-4 w-px bg-[#D1C7BD]" />

          <button
            id="new-query-button"
            onClick={onNewQuery}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent px-2 text-[11px] font-semibold text-[#AC9C8D] transition hover:bg-[#D1C7BD]/35 hover:text-[#322D29]"
          >
            <RotateCcw className="h-3 w-3" />
            Nueva consulta
          </button>
        </div>
      </div>
    </div>
  )
}
