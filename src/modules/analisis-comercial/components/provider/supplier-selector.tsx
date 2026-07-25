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
}: {
  suppliers: AnalysisSupplierOption[]
  selectedId: string
  onSelectedId: (value: string) => void
  dateFrom: string
  onDateFrom: (value: string) => void
  dateTo: string
  onDateTo: (value: string) => void
}) {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(280px,1.4fr)_180px_180px]">
        <label className="space-y-1 text-xs font-semibold text-theme-text-muted/70 uppercase tracking-wider">
          Proveedor real
          <select
            value={selectedId}
            onChange={(e) => onSelectedId(e.target.value)}
            className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text"
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
          />
        </label>
        <label className="space-y-1 text-xs font-semibold text-theme-text-muted/70 uppercase tracking-wider">
          Hasta
          <input
            type="date"
            value={dateTo}
            onChange={(e) => onDateTo(e.target.value)}
            className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text"
          />
        </label>
      </div>
    </div>
  )
}
