'use client'

import type { AnalysisSupplierOption } from '@/app/actions/comercial/analysis/types'

export function SupplierSelector({
  suppliers,
  selectedId,
  onSelectedId,
  dateFrom,
  onDateFrom,
  dateTo,
  onDateTo,
  hasPendingChanges,
  onLoad,
  loading,
}: {
  suppliers: AnalysisSupplierOption[]
  selectedId: string
  onSelectedId: (value: string) => void
  dateFrom: string
  onDateFrom: (value: string) => void
  dateTo: string
  onDateTo: (value: string) => void
  hasPendingChanges?: boolean
  onLoad?: () => void
  loading?: boolean
}) {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-3 lg:grid-cols-[minmax(280px,1.4fr)_180px_180px]">
          <label className="space-y-1 text-xs font-semibold text-theme-text-muted/70 uppercase tracking-wider">
            Proveedor real
            <select
              value={selectedId}
              onChange={(e) => onSelectedId(e.target.value)}
              className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text"
              disabled={loading}
            >
              <option value="">Seleccionar proveedor</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.business_name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs font-semibold text-theme-text-muted/70 uppercase tracking-wider">
            Desde
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => onDateFrom(e.target.value)}
              className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text"
              disabled={loading}
            />
          </label>
          <label className="space-y-1 text-xs font-semibold text-theme-text-muted/70 uppercase tracking-wider">
            Hasta
            <input
              type="date"
              value={dateTo}
              onChange={(e) => onDateTo(e.target.value)}
              className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text"
              disabled={loading}
            />
          </label>
        </div>

        {onLoad && (
          <button
            onClick={onLoad}
            disabled={!hasPendingChanges || loading || !selectedId}
            className={`shrink-0 rounded-lg px-6 py-2 text-sm font-semibold transition-all ${
              hasPendingChanges && !loading && selectedId
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-md shadow-blue-500/20'
                : 'bg-theme-border/50 text-theme-text-muted cursor-not-allowed'
            }`}
          >
            {loading ? 'Cargando...' : 'Cargar'}
          </button>
        )}
      </div>
    </div>
  )
}
