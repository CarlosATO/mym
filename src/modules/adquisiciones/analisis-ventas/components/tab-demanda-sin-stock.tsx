'use client'
// tab-demanda-sin-stock.tsx — Demanda sin stock (port de demanda_sin_stock.py)
import React, { useState, useMemo } from 'react'
import type { NormalizedSale, NormalizedStock } from '../utils/analytics'
import { buildSkuSummary, classifySkus } from '../utils/analytics'
import { fmtMoney, fmtDate, PeriodSelector, DataTable } from './tab-shared'

interface Props { allSales: NormalizedSale[]; allStock: NormalizedStock[]; globalMaxDate: Date; globalMinDate: Date }

const PERIOD_OPTS = [
  { label: 'Últimas 4 semanas', days: 28 },
  { label: 'Últimas 8 semanas', days: 56 },
  { label: 'Todo el período', days: 0 },
]

export function TabDemandaSinStock({ allSales, allStock, globalMaxDate, globalMinDate }: Props) {
  const [periodIdx, setPeriodIdx] = useState(0)

  const { startDate, sinStock } = useMemo(() => {
    const opt = PERIOD_OPTS[periodIdx]
    const startDate = opt.days === 0
      ? globalMinDate
      : new Date(Math.max(globalMaxDate.getTime() - opt.days * 86400000, globalMinDate.getTime()))
    const skus = classifySkus(buildSkuSummary(allSales, allStock, globalMaxDate, startDate, globalMaxDate))
    const sinStock = skus
      .filter(s => s.alerta === 'Demanda histórica sin stock')
      .sort((a, b) => b.venta_historica_total - a.venta_historica_total)
      .map((s, i) => ({
        ...s,
        ranking: i + 1,
        venta_potencial: s.venta_promedio_mientras_vendia * s.dias_desde_ultima_venta,
      }))
    return { startDate, sinStock }
  }, [periodIdx, allSales, allStock, globalMaxDate, globalMinDate])

  const totalPotencial = sinStock.reduce((acc, s) => acc + s.venta_potencial, 0)

  return (
    <div className="space-y-4">
      <PeriodSelector options={PERIOD_OPTS} value={periodIdx} onChange={setPeriodIdx} />
      <p className="text-xs text-theme-text-muted">
        Ventas desde <strong>{fmtDate(startDate)}</strong> hasta <strong>{fmtDate(globalMaxDate)}</strong>
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="border border-amber-500/30 bg-amber-500/10 rounded-xl p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">SKUs con Demanda sin Stock</p>
          <p className="text-2xl font-bold text-theme-text">{sinStock.length}</p>
        </div>
        <div className="border border-amber-500/30 bg-amber-500/10 rounded-xl p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">Venta Potencial No Capturada</p>
          <p className="text-xl font-bold text-theme-text">{fmtMoney(totalPotencial)}</p>
        </div>
      </div>

      {sinStock.length > 0 ? (
        <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
          <div className="p-3 border-b border-theme-border bg-theme-text/5">
            <span className="text-sm font-bold text-theme-text">Demanda histórica sin stock — {sinStock.length} SKUs</span>
          </div>
          <DataTable rows={sinStock} columns={[
            { key: 'ranking', label: '#' },
            { key: 'SKU', label: 'SKU' },
            { key: 'producto', label: 'Producto' },
            { key: 'variante', label: 'Variante' },
            { key: 'venta_historica_total', label: 'Venta Histórica', fmt: fmtMoney, right: true },
            { key: 'fecha_ultima_venta', label: 'Última Venta', fmt: v => v ? fmtDate(new Date(v)) : '-' },
            { key: 'dias_desde_ultima_venta', label: 'Días sin venta', right: true },
            { key: 'venta_potencial', label: 'Venta Potencial Perdida', fmt: fmtMoney, right: true },
          ]} maxRows={200} />
        </div>
      ) : (
        <div className="flex items-center justify-center h-32 border border-dashed border-theme-border rounded-xl text-theme-text-muted text-sm">
          No se detectaron productos con demanda histórica y sin stock.
        </div>
      )}
    </div>
  )
}
