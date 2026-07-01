'use client'
// tab-caidas.tsx — Caídas y crecimiento (port de caidas.py)
import React, { useState, useMemo } from 'react'
import type { NormalizedSale, NormalizedStock } from '../utils/analytics'
import { buildSkuSummary, classifySkus } from '../utils/analytics'
import { fmtMoney, fmtPct, fmtDate, PeriodSelector, DataTable } from './tab-shared'

interface Props { allSales: NormalizedSale[]; allStock: NormalizedStock[]; globalMaxDate: Date; globalMinDate: Date; minSalesFilter: number }

const PERIOD_OPTS = [
  { label: '4 sem vs 4 sem anteriores', days: 56 },
  { label: '8 sem vs 8 sem anteriores', days: 112 },
  { label: '3 meses vs 3 meses anteriores', days: 180 },
]

export function TabCaidas({ allSales, allStock, globalMaxDate, globalMinDate, minSalesFilter }: Props) {
  const [periodIdx, setPeriodIdx] = useState(1)

  const { startDate, caidas, crecimientos } = useMemo(() => {
    const opt = PERIOD_OPTS[periodIdx]
    const startDate = new Date(Math.max(globalMaxDate.getTime() - opt.days * 86400000, globalMinDate.getTime()))
    const skus = classifySkus(buildSkuSummary(allSales, allStock, globalMaxDate, startDate, globalMaxDate))
    const caidas = skus
      .filter(s => s.venta_prev_60d > 0 && s.venta_prev_60d >= minSalesFilter && s.diferencia_venta_periodo < 0)
      .sort((a, b) => a.diferencia_venta_periodo - b.diferencia_venta_periodo)
      .map((s, i) => ({ ...s, ranking: i + 1 }))
    const crecimientos = skus
      .filter(s => s.venta_prev_60d > 0 && s.venta_6m >= minSalesFilter && s.diferencia_venta_periodo > 0)
      .sort((a, b) => b.diferencia_venta_periodo - a.diferencia_venta_periodo)
      .map((s, i) => ({ ...s, ranking: i + 1 }))
    return { startDate, caidas, crecimientos }
  }, [periodIdx, allSales, allStock, globalMaxDate, globalMinDate, minSalesFilter])

  const cols = [
    { key: 'ranking', label: '#' },
    { key: 'SKU', label: 'SKU' },
    { key: 'producto', label: 'Producto' },
    { key: 'variante', label: 'Variante' },
    { key: 'venta_60d', label: 'Período actual', fmt: fmtMoney, right: true },
    { key: 'venta_prev_60d', label: 'Período anterior', fmt: fmtMoney, right: true },
    { key: 'diferencia_venta_periodo', label: 'Diferencia', fmt: fmtMoney, right: true },
    { key: 'variacion_60d_pct', label: 'Variación %', fmt: (v: number | null) => v != null ? fmtPct(v) : '-', right: true },
    { key: 'cantidad_disponible', label: 'Stock', right: true },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <PeriodSelector options={PERIOD_OPTS} value={periodIdx} onChange={setPeriodIdx} label="Comparativa de períodos" />
        <p className="text-xs text-theme-text-muted">
          Se compara la primera mitad del período vs la segunda. Período: <strong>{fmtDate(startDate)}</strong> → <strong>{fmtDate(globalMaxDate)}</strong>
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Caídas */}
        <div className="space-y-3">
          <div className="border-l-4 border-red-500 bg-red-500/10 rounded-r-xl p-3">
            <p className="text-sm font-bold text-red-500">Productos que más redujeron ventas</p>
            <p className="text-xs text-theme-text-muted">{caidas.length} productos con caída en el período</p>
          </div>
          {caidas.length > 0 ? (
            <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
              <DataTable rows={caidas.slice(0, 50)} columns={cols} maxRows={50} />
            </div>
          ) : (
            <div className="flex items-center justify-center h-24 border border-dashed border-theme-border rounded-xl text-theme-text-muted text-sm">
              Sin caídas detectadas con los filtros actuales.
            </div>
          )}
        </div>

        {/* Crecimientos */}
        <div className="space-y-3">
          <div className="border-l-4 border-green-500 bg-green-500/10 rounded-r-xl p-3">
            <p className="text-sm font-bold text-green-500">Productos que más aumentaron ventas</p>
            <p className="text-xs text-theme-text-muted">{crecimientos.length} productos con crecimiento en el período</p>
          </div>
          {crecimientos.length > 0 ? (
            <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
              <DataTable rows={crecimientos.slice(0, 50)} columns={cols} maxRows={50} />
            </div>
          ) : (
            <div className="flex items-center justify-center h-24 border border-dashed border-theme-border rounded-xl text-theme-text-muted text-sm">
              Sin crecimientos detectados con los filtros actuales.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
