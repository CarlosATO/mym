'use client'
// tab-pareto.tsx — Pareto 80/20 (port de pareto.py)
import React, { useState, useMemo } from 'react'
import type { NormalizedSale, NormalizedStock } from '../utils/analytics'
import { buildSkuSummary, paretoAnalysis } from '../utils/analytics'
import { fmtMoney, fmtPct, fmtDate, PeriodSelector, DataTable } from './tab-shared'

interface Props { allSales: NormalizedSale[]; allStock: NormalizedStock[]; globalMaxDate: Date; globalMinDate: Date }

const PERIOD_OPTS = [
  { label: 'Últimas 4 semanas', days: 28 },
  { label: 'Últimas 8 semanas', days: 56 },
  { label: 'Últimos 3 meses', days: 90 },
  { label: 'Todo el período', days: 0 },
]

export function TabPareto({ allSales, allStock, globalMaxDate, globalMinDate }: Props) {
  const [periodIdx, setPeriodIdx] = useState(2)

  const { startDate, pareto } = useMemo(() => {
    const opt = PERIOD_OPTS[periodIdx]
    const startDate = opt.days === 0
      ? globalMinDate
      : new Date(Math.max(globalMaxDate.getTime() - opt.days * 86400000, globalMinDate.getTime()))
    const skus = buildSkuSummary(allSales, allStock, globalMaxDate, startDate, globalMaxDate)
    const pareto = paretoAnalysis(skus)
    return { startDate, pareto }
  }, [periodIdx, allSales, allStock, globalMaxDate, globalMinDate])

  const pareto80 = useMemo(() => pareto.filter(p => p.pct_acumulado <= 0.80), [pareto])
  const total = pareto.length
  const pctSku = total > 0 ? pareto80.length / total : 0

  const paretoWithRank = useMemo(() => pareto.map((p, i) => ({ ...p, ranking: i + 1 })), [pareto])

  return (
    <div className="space-y-4">
      <PeriodSelector options={PERIOD_OPTS} value={periodIdx} onChange={setPeriodIdx} />
      <p className="text-xs text-theme-text-muted">
        Ventas desde <strong>{fmtDate(startDate)}</strong> hasta <strong>{fmtDate(globalMaxDate)}</strong>
      </p>

      {/* Resumen Pareto */}
      <div className="border-l-4 border-theme-primary bg-theme-primary/10 rounded-r-xl p-4">
        <p className="text-sm font-bold text-theme-primary mb-1">Resumen Pareto 80/20</p>
        <p className="text-sm text-theme-text">
          <strong>{pareto80.length}</strong> de <strong>{total}</strong> productos explican el <strong>80%</strong> de la venta.{' '}
          Representan el <strong>{fmtPct(pctSku)}</strong> del total de SKUs vendidos.
        </p>
      </div>

      {/* Tabla completa */}
      <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
        <div className="p-3 border-b border-theme-border bg-theme-text/5 flex items-center justify-between">
          <span className="text-sm font-bold text-theme-text">Ranking completo — {total} productos</span>
          <div className="flex gap-3 text-xs">
            <span className="bg-theme-primary/20 text-theme-primary font-bold px-2 py-0.5 rounded-full">Clase A: {pareto80.length} SKUs (80%)</span>
            <span className="bg-theme-text/10 text-theme-text-muted font-bold px-2 py-0.5 rounded-full">Clase B/C: {total - pareto80.length} SKUs</span>
          </div>
        </div>
        <DataTable
          rows={paretoWithRank}
          columns={[
            { key: 'ranking', label: '#' },
            { key: 'SKU', label: 'SKU' },
            { key: 'producto', label: 'Producto' },
            { key: 'variante', label: 'Variante' },
            { key: 'venta_6m', label: 'Venta período', fmt: fmtMoney, right: true },
            { key: 'unidades_6m', label: 'Unidades', right: true },
            { key: 'pct_acumulado', label: '% Acumulado', fmt: fmtPct, right: true },
            {
              key: 'clasificacion_pareto', label: 'Clase',
              fmt: (v: string) => (
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${v === 'A: Core ventas' ? 'bg-theme-primary/20 text-theme-primary' : 'bg-theme-text/10 text-theme-text-muted'}`}>
                  {v === 'A: Core ventas' ? 'A' : 'B/C'}
                </span>
              )
            },
          ]}
          maxRows={200}
        />
      </div>
    </div>
  )
}
