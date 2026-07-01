'use client'
// tab-resumen.tsx — Resumen Ejecutivo (port de resumen.py)
import React, { useState, useMemo } from 'react'
import type { NormalizedSale, NormalizedStock } from '../utils/analytics'
import { buildSkuSummary, classifySkus, weeklyGrouping, monthlyGrouping } from '../utils/analytics'
import { fmtMoney, fmtNumber, fmtPct, fmtDate, PeriodSelector, KpiCard, DataTable } from './tab-shared'

interface Props {
  allSales: NormalizedSale[]
  allStock: NormalizedStock[]
  globalMaxDate: Date
  globalMinDate: Date
}

const PERIOD_OPTS = [
  { label: 'Últimas 4 semanas', days: 28 },
  { label: 'Últimas 8 semanas', days: 56 },
  { label: 'Últimas 12 semanas', days: 84 },
  { label: 'Todo el período', days: 0 },
]

export function TabResumen({ allSales, allStock, globalMaxDate, globalMinDate }: Props) {
  const [periodIdx, setPeriodIdx] = useState(0)
  const [selectedWeekIdx, setSelectedWeekIdx] = useState<number>(0)

  const { startDate, skus, salesInPeriod, weekly, monthly } = useMemo(() => {
    const opt = PERIOD_OPTS[periodIdx]
    const startDate = opt.days === 0
      ? globalMinDate
      : new Date(Math.max(globalMaxDate.getTime() - opt.days * 86400000, globalMinDate.getTime()))
    const salesInPeriod = allSales.filter(s => s.fecha >= startDate && s.fecha <= globalMaxDate)
    const raw = buildSkuSummary(allSales, allStock, globalMaxDate, startDate, globalMaxDate)
    const skus = classifySkus(raw)
    const weekly = weeklyGrouping(salesInPeriod)
    const monthly = monthlyGrouping(salesInPeriod)
    return { startDate, skus, salesInPeriod, weekly, monthly }
  }, [periodIdx, allSales, allStock, globalMaxDate, globalMinDate])

  // KPIs
  const totalVenta = useMemo(() => salesInPeriod.reduce((acc, s) => acc + s.venta_bruta, 0), [salesInPeriod])
  const totalMargen = useMemo(() => salesInPeriod.reduce((acc, s) => acc + s.margen, 0), [salesInPeriod])
  const skuActivos = useMemo(() => new Set(salesInPeriod.map(s => s.SKU)).size, [salesInPeriod])
  const skuConStock = useMemo(() => skus.filter(s => s.cantidad_disponible > 0).length, [skus])
  const stockVal = useMemo(() => skus.reduce((acc, s) => acc + s.valor_stock_disponible, 0), [skus])
  const deadN = useMemo(() => skus.filter(s => s.alerta === 'Producto muerto con stock').length, [skus])
  const sinStockN = useMemo(() => skus.filter(s => s.alerta === 'Demanda histórica sin stock').length, [skus])
  const qbN = useMemo(() => skus.filter(s => s.alerta === 'Quiebre crítico').length, [skus])

  // Detalle semanal seleccionado
  const selectedWeek = weekly[selectedWeekIdx]
  const weekSales = useMemo(() => {
    if (!selectedWeek) return []
    const ws = allSales.filter(s => s.semana === selectedWeek.semana && s.anio === selectedWeek.anio)
    const bysku = new Map<string, any>()
    for (const s of ws) {
      if (!bysku.has(s.SKU)) bysku.set(s.SKU, { SKU: s.SKU, producto: s.producto, venta: 0, unidades: 0, margen: 0 })
      const r = bysku.get(s.SKU)!
      r.venta += s.venta_bruta; r.unidades += s.cantidad; r.margen += s.margen
    }
    return [...bysku.values()].sort((a, b) => b.venta - a.venta)
  }, [selectedWeek, allSales])

  return (
    <div className="space-y-5">
      <PeriodSelector options={PERIOD_OPTS} value={periodIdx} onChange={setPeriodIdx} />
      <p className="text-xs text-theme-text-muted">
        Ventas desde <strong>{fmtDate(startDate)}</strong> hasta <strong>{fmtDate(globalMaxDate)}</strong>
      </p>

      {/* KPIs principales */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Venta del período" value={fmtMoney(totalVenta)} />
        <KpiCard label="Margen estimado" value={fmtMoney(totalMargen)} />
        <KpiCard label="SKUs vendidos" value={skuActivos} />
        <KpiCard label="SKUs con stock" value={skuConStock} />
        <KpiCard label="Stock valorizado" value={fmtMoney(stockVal)} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="Stock sin ventas" value={deadN} sub="Capital inmovilizado" />
        <KpiCard label="Demanda sin stock" value={sinStockN} sub="Venta potencial perdida" />
        <KpiCard label="Quiebre crítico" value={qbN} sub="< 7 días de cobertura" />
      </div>

      {/* Evolución semanal */}
      {weekly.length > 0 && (
        <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-theme-border bg-theme-text/5">
            <h3 className="text-sm font-bold text-theme-text">Evolución Semanal en el Período</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-theme-surface border-b border-theme-border">
                <tr>
                  <th className="p-2.5 text-left font-bold text-theme-text-muted">Semana</th>
                  <th className="p-2.5 text-right font-bold text-theme-text-muted">Venta</th>
                  <th className="p-2.5 text-right font-bold text-theme-text-muted">Unidades</th>
                  <th className="p-2.5 text-right font-bold text-theme-text-muted">Margen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border/40">
                {weekly.map((w, i) => (
                  <tr
                    key={i}
                    onClick={() => setSelectedWeekIdx(i)}
                    className={`cursor-pointer transition-colors ${selectedWeekIdx === i ? 'bg-theme-primary/10 border-l-2 border-theme-primary' : 'hover:bg-theme-text/5'}`}
                  >
                    <td className="p-2.5 text-theme-text font-semibold">{w.label}</td>
                    <td className="p-2.5 text-right text-theme-text">{fmtMoney(w.venta)}</td>
                    <td className="p-2.5 text-right text-theme-text">{fmtNumber(w.unidades)}</td>
                    <td className="p-2.5 text-right text-theme-text">{fmtMoney(w.margen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detalle semanal */}
      {selectedWeek && (
        <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-theme-border bg-theme-text/5 flex items-center justify-between">
            <h3 className="text-sm font-bold text-theme-primary">Detalle de ventas — {selectedWeek.label}</h3>
            <div className="flex gap-4 text-xs text-theme-text-muted">
              <span>Venta: <strong className="text-theme-text">{fmtMoney(weekSales.reduce((a, r) => a + r.venta, 0))}</strong></span>
              <span>Unidades: <strong className="text-theme-text">{fmtNumber(weekSales.reduce((a, r) => a + r.unidades, 0))}</strong></span>
              <span>SKUs: <strong className="text-theme-text">{weekSales.length}</strong></span>
            </div>
          </div>
          <DataTable rows={weekSales} columns={[
            { key: 'SKU', label: 'SKU' },
            { key: 'producto', label: 'Producto' },
            { key: 'venta', label: 'Venta', fmt: fmtMoney, right: true },
            { key: 'unidades', label: 'Unidades', right: true },
            { key: 'margen', label: 'Margen', fmt: fmtMoney, right: true },
          ]} maxRows={100} />
        </div>
      )}

      {/* Tendencia mensual */}
      {monthly.length > 0 && (
        <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-theme-border bg-theme-text/5">
            <h3 className="text-sm font-bold text-theme-text">Tendencia Mensual</h3>
          </div>
          <DataTable rows={monthly} columns={[
            { key: 'label', label: 'Mes' },
            { key: 'venta', label: 'Venta', fmt: fmtMoney, right: true },
            { key: 'unidades', label: 'Unidades', right: true },
            { key: 'margen', label: 'Margen', fmt: fmtMoney, right: true },
            { key: 'sku_activos', label: 'SKUs activos', right: true },
          ]} />
        </div>
      )}
    </div>
  )
}
