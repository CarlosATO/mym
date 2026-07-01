'use client'
// tab-reposicion.tsx — Reposición Inteligente / Compra Sugerida
import React, { useState, useMemo } from 'react'
import type { NormalizedSale, NormalizedStock } from '../utils/analytics'
import { buildSkuSummary, classifySkus } from '../utils/analytics'
import { fmtMoney, fmtDate, DataTable } from './tab-shared'

interface Props {
  allSales: NormalizedSale[]
  allStock: NormalizedStock[]
  globalMaxDate: Date
  globalMinDate: Date
}

const PERIOD_DAYS = [7, 14, 28, 56, 84, 0]
const PERIOD_LABELS = ['7 días', '14 días', '28 días', '56 días', '84 días', 'Todo el período']
const COVERAGE_WEEKS = [1, 2, 3, 4, 6, 8]
const COVERAGE_LABELS = ['1 semana', '2 semanas', '3 semanas', '4 semanas (1 mes)', '6 semanas', '8 semanas (2 meses)']

export function TabReposicion({ allSales, allStock, globalMaxDate, globalMinDate }: Props) {
  const [periodIdx, setPeriodIdx] = useState(2) // 28 días default
  const [coverageIdx, setCoverageIdx] = useState(3) // 4 semanas default
  const [includeNoStock, setIncludeNoStock] = useState(false)
  const [searchProduct, setSearchProduct] = useState('')
  const [searchSupplier, setSearchSupplier] = useState('')
  const [confirmed, setConfirmed] = useState<Record<string, number>>({})

  const days = PERIOD_DAYS[periodIdx]
  const targetWeeks = COVERAGE_WEEKS[coverageIdx]

  const { startDate, skus } = useMemo(() => {
    const startDate = days === 0
      ? globalMinDate
      : new Date(Math.max(globalMaxDate.getTime() - days * 86400000, globalMinDate.getTime()))
    const raw = buildSkuSummary(allSales, allStock, globalMaxDate, startDate, globalMaxDate, targetWeeks)
    const skus = classifySkus(raw)
    return { startDate, skus }
  }, [periodIdx, targetWeeks, allSales, allStock, globalMaxDate, globalMinDate, days])

  const filtered = useMemo(() => {
    return skus
      .filter(s => {
        if (!includeNoStock && s.cantidad_disponible <= 0 && s.venta_6m <= 0) return false
        const matchProd = !searchProduct || s.SKU.toLowerCase().includes(searchProduct.toLowerCase()) || s.producto.toLowerCase().includes(searchProduct.toLowerCase())
        const matchSup = !searchSupplier // supplier field not in stock data currently
        return matchProd && matchSup
      })
      .sort((a, b) => b.suggested_quantity - a.suggested_quantity)
  }, [skus, includeNoStock, searchProduct, searchSupplier])

  // KPIs del reporte
  const evaluados = filtered.length
  const criticos = filtered.filter(s => s.alerta === 'Quiebre crítico').length
  const reponer = filtered.filter(s => s.suggested_quantity > 0).length
  const totalUnidades = filtered.filter(s => s.suggested_quantity > 0).reduce((acc, s) => acc + s.suggested_quantity, 0)
  const totalMonto = filtered.filter(s => s.suggested_quantity > 0).reduce((acc, s) => acc + s.suggested_quantity * s.costo_unitario, 0)

  const confirmedCount = Object.keys(confirmed).filter(k => (confirmed[k] || 0) > 0).length
  const confirmedUnits = Object.values(confirmed).reduce((a, b) => a + b, 0)
  const confirmedMonto = filtered.reduce((acc, s) => {
    const qty = confirmed[s.SKU] ?? 0
    return acc + qty * s.costo_unitario
  }, 0)

  return (
    <div className="space-y-4">
      {/* Controles */}
      <div className="flex flex-wrap items-center gap-3 border border-theme-border bg-theme-surface/70 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-theme-text-muted">Período:</span>
          <select
            className="h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-primary"
            value={periodIdx} onChange={e => setPeriodIdx(Number(e.target.value))}
          >
            {PERIOD_LABELS.map((l, i) => <option key={i} value={i}>{l}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-theme-text-muted">Cobertura:</span>
          <select
            className="h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-primary"
            value={coverageIdx} onChange={e => setCoverageIdx(Number(e.target.value))}
          >
            {COVERAGE_LABELS.map((l, i) => <option key={i} value={i}>{l}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox" checked={includeNoStock} onChange={e => setIncludeNoStock(e.target.checked)}
            className="rounded border-theme-border"
          />
          <span className="text-xs text-theme-text-muted">Incluir sin stock/venta</span>
        </label>
        <div className="ml-auto text-xs text-theme-text-muted">
          {fmtDate(startDate)} → {fmtDate(globalMaxDate)}
        </div>
      </div>

      {/* KPIs de la sugerencia */}
      <div className="flex flex-wrap gap-3 border border-theme-border bg-theme-surface/70 rounded-xl px-4 py-3 text-sm">
        <span>Evaluados: <strong className="text-theme-text">{evaluados}</strong></span>
        <span>Críticos: <strong className="text-red-500">{criticos}</strong></span>
        <span>Reponer: <strong className="text-amber-500">{reponer}</strong></span>
        <span>Unidades sugeridas: <strong className="text-theme-primary">{totalUnidades}</strong></span>
        <span>Monto estimado: <strong className="text-theme-primary">{fmtMoney(totalMonto)}</strong></span>
        <div className="ml-auto flex gap-3 text-xs font-semibold border-l border-theme-border pl-3">
          <span className="text-theme-text-muted">Confirmado:</span>
          <span>SKU {confirmedCount} • Unidades {confirmedUnits} • {fmtMoney(confirmedMonto)}</span>
        </div>
      </div>

      {/* Búsqueda */}
      <div className="flex gap-3">
        <input
          placeholder="Buscar producto o código..."
          value={searchProduct} onChange={e => setSearchProduct(e.target.value)}
          className="flex-1 h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text placeholder:text-theme-text-muted focus:outline-none focus:ring-2 focus:ring-theme-primary"
        />
      </div>
      <p className="text-xs text-theme-text-muted">Mostrando {filtered.length} de {skus.length} productos</p>

      {/* Tabla de detalle */}
      <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-theme-surface sticky top-0 border-b border-theme-border z-10">
              <tr>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted">SKU</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted">Producto</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted">Variante</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted text-right">Stock</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted text-right">Venta período</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted text-right">Dem. semanal</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted text-right">Días cob.</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-primary text-right">Compra Sugerida</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted text-right">Confirmar</th>
                <th className="p-2.5 font-bold uppercase tracking-wider text-theme-text-muted">Alerta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/40">
              {filtered.slice(0, 300).map((s, i) => (
                <tr key={s.SKU} className="hover:bg-theme-text/5 transition-colors">
                  <td className="p-2.5 font-mono text-theme-text">{s.SKU}</td>
                  <td className="p-2.5 text-theme-text font-medium max-w-[200px] truncate">{s.producto}</td>
                  <td className="p-2.5 text-theme-text-muted">{s.variante || '-'}</td>
                  <td className="p-2.5 text-right text-theme-text">{s.cantidad_disponible}</td>
                  <td className="p-2.5 text-right text-theme-text">{fmtMoney(s.venta_6m)}</td>
                  <td className="p-2.5 text-right text-theme-text">{(s.unidades_promedio_diaria * 7).toFixed(1)}</td>
                  <td className={`p-2.5 text-right font-semibold ${s.dias_cobertura != null && s.dias_cobertura < 7 ? 'text-red-500' : s.dias_cobertura != null && s.dias_cobertura < 15 ? 'text-amber-500' : 'text-theme-text'}`}>
                    {s.dias_cobertura != null ? s.dias_cobertura.toFixed(1) : '-'}
                  </td>
                  <td className="p-2.5 text-right text-theme-primary font-bold text-sm">{s.suggested_quantity}</td>
                  <td className="p-2.5 text-right">
                    <input
                      type="number"
                      min={0}
                      value={confirmed[s.SKU] ?? s.suggested_quantity}
                      onChange={e => setConfirmed(prev => ({ ...prev, [s.SKU]: Number(e.target.value) }))}
                      className="w-16 h-7 rounded border border-theme-border bg-theme-surface px-1.5 text-xs text-right text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-primary"
                    />
                  </td>
                  <td className="p-2.5">
                    {s.alerta !== 'Normal' && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                        s.alerta === 'Quiebre crítico' ? 'bg-red-500/20 text-red-500' :
                        s.alerta === 'Producto muerto con stock' ? 'bg-red-400/20 text-red-400' :
                        s.alerta === 'Riesgo de quiebre' ? 'bg-amber-500/20 text-amber-500' :
                        'bg-theme-text/10 text-theme-text-muted'
                      }`}>{s.alerta.split(' ').slice(0,2).join(' ')}</span>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="p-6 text-center text-theme-text-muted">No hay productos que coincidan con los filtros.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > 300 && (
          <p className="text-center text-xs text-theme-text-muted p-2 border-t border-theme-border">
            Mostrando 300 de {filtered.length} productos
          </p>
        )}
      </div>
    </div>
  )
}
