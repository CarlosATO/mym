'use client'
// tab-stock-sin-ventas.tsx — Stock sin ventas (port de stock_sin_ventas.py)
import React, { useState, useMemo } from 'react'
import type { NormalizedSale, NormalizedStock } from '../utils/analytics'
import { buildSkuSummary, classifySkus } from '../utils/analytics'
import { fmtMoney, fmtDate, PeriodSelector, DataTable } from './tab-shared'

interface Props { allSales: NormalizedSale[]; allStock: NormalizedStock[]; globalMaxDate: Date; globalMinDate: Date }

const PERIOD_OPTS = [
  { label: 'Últimos 45 días', days: 45 },
  { label: 'Últimos 90 días', days: 90 },
  { label: 'Historial completo', days: 0 },
]

export function TabStockSinVentas({ allSales, allStock, globalMaxDate, globalMinDate }: Props) {
  const [periodIdx, setPeriodIdx] = useState(0)

  const { startDate, dead } = useMemo(() => {
    const opt = PERIOD_OPTS[periodIdx]
    const startDate = opt.days === 0
      ? globalMinDate
      : new Date(Math.max(globalMaxDate.getTime() - opt.days * 86400000, globalMinDate.getTime()))
    const skus = classifySkus(buildSkuSummary(allSales, allStock, globalMaxDate, startDate, globalMaxDate))
    const dead = skus
      .filter(s => s.alerta === 'Producto muerto con stock')
      .sort((a, b) => b.valor_stock_disponible - a.valor_stock_disponible)
      .map((s, i) => ({
        ...s,
        ranking: i + 1,
        subestado: s.tuvo_demanda_historica ? 'Tuvo demanda, hoy inmovilizado' : 'Sin demanda histórica relevante',
      }))
    return { startDate, dead }
  }, [periodIdx, allSales, allStock, globalMaxDate, globalMinDate])

  const totalVal = dead.reduce((acc, s) => acc + s.valor_stock_disponible, 0)

  return (
    <div className="space-y-4">
      <PeriodSelector options={PERIOD_OPTS} value={periodIdx} onChange={setPeriodIdx} label="Período de referencia" />
      <p className="text-xs text-theme-text-muted">
        Ventas desde <strong>{fmtDate(startDate)}</strong> hasta <strong>{fmtDate(globalMaxDate)}</strong>
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="border border-red-500/30 bg-red-500/10 rounded-xl p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-red-500 mb-1">SKUs Inmovilizados</p>
          <p className="text-2xl font-bold text-theme-text">{dead.length}</p>
        </div>
        <div className="border border-red-500/30 bg-red-500/10 rounded-xl p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-red-500 mb-1">Valor Stock Inmovilizado</p>
          <p className="text-xl font-bold text-theme-text">{fmtMoney(totalVal)}</p>
        </div>
      </div>

      {dead.length > 0 ? (
        <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
          <div className="p-3 border-b border-theme-border bg-theme-text/5">
            <span className="text-sm font-bold text-theme-text">Productos con stock sin ventas — {dead.length} SKUs</span>
          </div>
          <DataTable rows={dead} columns={[
            { key: 'ranking', label: '#' },
            { key: 'SKU', label: 'SKU' },
            { key: 'producto', label: 'Producto' },
            { key: 'variante', label: 'Variante' },
            { key: 'subestado', label: 'Estado' },
            { key: 'cantidad_disponible', label: 'Stock', right: true },
            { key: 'valor_stock_disponible', label: 'Valor Stock', fmt: fmtMoney, right: true },
            { key: 'fecha_ultima_venta', label: 'Última Venta', fmt: v => v ? fmtDate(new Date(v)) : 'Sin ventas' },
            { key: 'dias_desde_ultima_venta', label: 'Días sin venta', right: true },
          ]} maxRows={200} />
        </div>
      ) : (
        <div className="flex items-center justify-center h-32 border border-dashed border-theme-border rounded-xl text-theme-text-muted text-sm">
          No se encontraron productos con stock sin ventas en esta selección.
        </div>
      )}
    </div>
  )
}
