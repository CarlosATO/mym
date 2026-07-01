'use client'
// tab-quiebres.tsx — Quiebres de stock (port de quiebres.py)
import React, { useState, useMemo } from 'react'
import type { NormalizedSale, NormalizedStock } from '../utils/analytics'
import { buildSkuSummary, classifySkus } from '../utils/analytics'
import { fmtDate, PeriodSelector, DataTable } from './tab-shared'

interface Props { allSales: NormalizedSale[]; allStock: NormalizedStock[]; globalMaxDate: Date; globalMinDate: Date }

const PERIOD_OPTS = [
  { label: 'Últimas 2 semanas', days: 14 },
  { label: 'Últimas 4 semanas', days: 28 },
  { label: 'Últimas 8 semanas', days: 56 },
]

export function TabQuiebres({ allSales, allStock, globalMaxDate, globalMinDate }: Props) {
  const [periodIdx, setPeriodIdx] = useState(1)

  const { startDate, skus } = useMemo(() => {
    const opt = PERIOD_OPTS[periodIdx]
    const startDate = new Date(Math.max(globalMaxDate.getTime() - opt.days * 86400000, globalMinDate.getTime()))
    const skus = classifySkus(buildSkuSummary(allSales, allStock, globalMaxDate, startDate, globalMaxDate))
    return { startDate, skus }
  }, [periodIdx, allSales, allStock, globalMaxDate, globalMinDate])

  const criticos = useMemo(() =>
    skus.filter(s => s.alerta === 'Quiebre crítico').sort((a, b) => (a.dias_cobertura ?? 999) - (b.dias_cobertura ?? 999))
      .map((s, i) => ({ ...s, ranking: i + 1 })), [skus])
  const riesgo = useMemo(() =>
    skus.filter(s => s.alerta === 'Riesgo de quiebre').sort((a, b) => (a.dias_cobertura ?? 999) - (b.dias_cobertura ?? 999))
      .map((s, i) => ({ ...s, ranking: i + 1 })), [skus])

  const coverageColor = (dias: number | null) => {
    if (dias == null) return 'text-theme-text-muted'
    if (dias < 7) return 'text-red-500 font-bold'
    if (dias < 15) return 'text-amber-500 font-bold'
    return 'text-green-500'
  }

  const cols = [
    { key: 'ranking', label: '#' },
    { key: 'SKU', label: 'SKU' },
    { key: 'producto', label: 'Producto' },
    { key: 'variante', label: 'Variante' },
    {
      key: 'dias_cobertura', label: 'Días cobertura', right: true,
      fmt: (v: number | null) => <span className={coverageColor(v)}>{v != null ? v.toFixed(1) : '-'}</span>,
    },
    { key: 'cantidad_disponible', label: 'Stock actual', right: true },
    { key: 'por_recibir', label: 'Por recibir', right: true },
    { key: 'unidades_promedio_diaria', label: 'Dem. diaria', right: true, fmt: (v: number) => v?.toFixed(2) },
    { key: 'alerta', label: 'Estado', fmt: (v: string) => (
      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${v === 'Quiebre crítico' ? 'bg-red-500/20 text-red-500' : 'bg-amber-500/20 text-amber-600'}`}>{v}</span>
    )},
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-1">
        <PeriodSelector options={PERIOD_OPTS} value={periodIdx} onChange={setPeriodIdx} label="Período para calcular demanda diaria" />
        <p className="text-xs text-theme-text-muted">
          Días de cobertura = stock actual ÷ demanda diaria promedio. Menor cobertura = mayor riesgo.
        </p>
        <p className="text-xs text-theme-text-muted">
          Ventas desde <strong>{fmtDate(startDate)}</strong> hasta <strong>{fmtDate(globalMaxDate)}</strong>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="border border-red-500/30 bg-red-500/10 rounded-xl p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-red-500 mb-1">Quiebre Crítico (&lt; 7 días)</p>
          <p className="text-2xl font-bold text-theme-text">{criticos.length}</p>
        </div>
        <div className="border border-amber-500/30 bg-amber-500/10 rounded-xl p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-600 mb-1">Riesgo de Quiebre (&lt; 15 días)</p>
          <p className="text-2xl font-bold text-theme-text">{riesgo.length}</p>
        </div>
      </div>

      {criticos.length > 0 || riesgo.length > 0 ? (
        <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
          <div className="p-3 border-b border-theme-border bg-theme-text/5">
            <span className="text-sm font-bold text-theme-text">SKUs en Riesgo — {criticos.length + riesgo.length} productos</span>
          </div>
          <DataTable rows={[...criticos, ...riesgo]} columns={cols} maxRows={200} />
        </div>
      ) : (
        <div className="flex items-center justify-center h-32 border border-dashed border-theme-border rounded-xl text-theme-text-muted text-sm">
          No se detectaron SKUs en riesgo de quiebre con los filtros actuales.
        </div>
      )}
    </div>
  )
}
