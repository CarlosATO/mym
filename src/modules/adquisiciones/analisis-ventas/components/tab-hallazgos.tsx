'use client'
// tabs/tab-hallazgos.tsx — Hallazgos Ejecutivos (port de hallazgos.py)
import React, { useState, useMemo } from 'react'
import { AlertTriangle, TrendingDown, Package, ShoppingCart, Activity } from 'lucide-react'
import type { SkuSummary, NormalizedSale, NormalizedStock } from '../utils/analytics'
import { buildSkuSummary, classifySkus, paretoAnalysis } from '../utils/analytics'
import { fmtMoney, fmtPct, fmtDate, PeriodSelector, AlertCard } from './tab-shared'

interface Props {
  allSales: NormalizedSale[]
  allStock: NormalizedStock[]
  globalMaxDate: Date
  globalMinDate: Date
  minSalesFilter: number
}

const PERIOD_OPTS = [
  { label: 'Últimas 4 semanas', days: 28 },
  { label: 'Últimas 8 semanas', days: 56 },
  { label: 'Últimas 12 semanas', days: 84 },
  { label: 'Todo el período', days: 0 },
]

export function TabHallazgos({ allSales, allStock, globalMaxDate, globalMinDate, minSalesFilter }: Props) {
  const [periodIdx, setPeriodIdx] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)

  const { startDate, skus } = useMemo(() => {
    const opt = PERIOD_OPTS[periodIdx]
    const startDate = opt.days === 0
      ? globalMinDate
      : new Date(Math.max(globalMaxDate.getTime() - opt.days * 86400000, globalMinDate.getTime()))
    const raw = buildSkuSummary(allSales, allStock, globalMaxDate, startDate, globalMaxDate)
    const skus = classifySkus(raw)
    return { startDate, skus }
  }, [periodIdx, allSales, allStock, globalMaxDate, globalMinDate])

  const muertos = useMemo(() => skus.filter(s => s.alerta === 'Producto muerto con stock').sort((a, b) => b.valor_stock_disponible - a.valor_stock_disponible), [skus])
  const sinStock = useMemo(() => skus.filter(s => s.alerta === 'Demanda histórica sin stock').sort((a, b) => b.venta_historica_total - a.venta_historica_total), [skus])
  const quiebres = useMemo(() => skus.filter(s => s.alerta === 'Quiebre crítico').sort((a, b) => (a.dias_cobertura ?? 999) - (b.dias_cobertura ?? 999)), [skus])
  const pareto = useMemo(() => paretoAnalysis(skus), [skus])
  const pareto80 = useMemo(() => pareto.filter(p => p.pct_acumulado <= 0.80), [pareto])
  const caidas = useMemo(() =>
    skus.filter(s => s.venta_prev_60d >= minSalesFilter && s.venta_prev_60d > 0 && s.diferencia_venta_periodo < 0)
      .sort((a, b) => a.diferencia_venta_periodo - b.diferencia_venta_periodo), [skus, minSalesFilter])
  const crecimientos = useMemo(() =>
    skus.filter(s => s.venta_prev_60d >= minSalesFilter && s.venta_prev_60d > 0 && s.diferencia_venta_periodo > 0)
      .sort((a, b) => b.diferencia_venta_periodo - a.diferencia_venta_periodo), [skus, minSalesFilter])

  const valMuertos = muertos.reduce((acc, s) => acc + s.valor_stock_disponible, 0)
  const valPotSinStock = sinStock.reduce((acc, s) => acc + s.venta_promedio_mientras_vendia * s.dias_desde_ultima_venta, 0)

  const toggle = (key: string) => setExpanded(prev => prev === key ? null : key)

  const TableBase = ({ rows, cols }: { rows: any[], cols: { key: string, label: string, fmt?: (v: any) => string }[] }) => (
    <div className="overflow-x-auto mt-3 rounded-lg border border-theme-border">
      <table className="w-full text-xs">
        <thead className="bg-theme-text/5 border-b border-theme-border">
          <tr>{cols.map(c => <th key={c.key} className="p-2 text-left font-bold text-theme-text-muted uppercase tracking-wider whitespace-nowrap">{c.label}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-theme-border/40">
          {rows.slice(0, 50).map((row, i) => (
            <tr key={i} className="hover:bg-theme-text/5">
              {cols.map(c => <td key={c.key} className="p-2 text-theme-text whitespace-nowrap">{c.fmt ? c.fmt(row[c.key]) : (row[c.key] ?? '-')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="space-y-4">
      <PeriodSelector options={PERIOD_OPTS} value={periodIdx} onChange={setPeriodIdx} />
      <p className="text-xs text-theme-text-muted">
        Ventas desde <strong>{fmtDate(startDate)}</strong> hasta <strong>{fmtDate(globalMaxDate)}</strong>
      </p>

      {/* H1: Muertos con stock */}
      <AlertCard
        title="Productos con stock sin ventas"
        body={`${muertos.length} productos tienen stock disponible pero no registran ventas en el período. Capital inmovilizado estimado: ${fmtMoney(valMuertos)}.`}
        priority="Alta" action="Revisar liquidación, promoción o descuento."
        expanded={expanded === 'h1'} onToggle={() => toggle('h1')}
        expandLabel="Ver productos — Stock sin ventas"
      >
        <TableBase rows={muertos} cols={[
          { key: 'SKU', label: 'SKU' },
          { key: 'producto', label: 'Producto' },
          { key: 'variante', label: 'Variante' },
          { key: 'cantidad_disponible', label: 'Stock' },
          { key: 'valor_stock_disponible', label: 'Valor Stock', fmt: fmtMoney },
          { key: 'fecha_ultima_venta', label: 'Última Venta', fmt: v => v ? fmtDate(new Date(v)) : 'Sin ventas' },
          { key: 'dias_desde_ultima_venta', label: 'Días sin venta' },
        ]} />
      </AlertCard>

      {/* H2: Demanda sin stock */}
      <AlertCard
        title="Productos con demanda histórica pero sin stock"
        body={`${sinStock.length} productos tenían demanda pero hoy no tienen stock disponible. Venta potencial no capturada estimada: ${fmtMoney(valPotSinStock)}.`}
        priority="Alta" action="Revisar compra o confirmar si el producto fue descontinuado."
        expanded={expanded === 'h2'} onToggle={() => toggle('h2')}
        expandLabel="Ver productos — Demanda histórica sin stock"
      >
        <TableBase rows={sinStock} cols={[
          { key: 'SKU', label: 'SKU' },
          { key: 'producto', label: 'Producto' },
          { key: 'variante', label: 'Variante' },
          { key: 'venta_historica_total', label: 'Venta Histórica', fmt: fmtMoney },
          { key: 'fecha_ultima_venta', label: 'Última Venta', fmt: v => v ? fmtDate(new Date(v)) : '-' },
          { key: 'dias_desde_ultima_venta', label: 'Días sin venta' },
        ]} />
      </AlertCard>

      {/* H3: Quiebres */}
      <AlertCard
        title="Riesgo crítico de quiebre de stock"
        body={`${quiebres.length} productos tienen stock que cubre menos de 7 días según su rotación reciente.`}
        priority="Alta" action="Realizar pedido de reposición urgente."
        expanded={expanded === 'h3'} onToggle={() => toggle('h3')}
        expandLabel="Ver productos — Quiebre crítico"
      >
        <TableBase rows={quiebres} cols={[
          { key: 'SKU', label: 'SKU' },
          { key: 'producto', label: 'Producto' },
          { key: 'variante', label: 'Variante' },
          { key: 'dias_cobertura', label: 'Días Cobertura', fmt: v => v != null ? v.toFixed(1) : '-' },
          { key: 'cantidad_disponible', label: 'Stock' },
          { key: 'unidades_promedio_diaria', label: 'Dem. Diaria', fmt: v => v?.toFixed(2) },
        ]} />
      </AlertCard>

      {/* H4: Pareto */}
      <AlertCard
        title="Concentración de ventas (Pareto)"
        body={`${pareto80.length} de ${pareto.length} productos explican el 80% de la venta. Representan el ${fmtPct(pareto.length > 0 ? pareto80.length / pareto.length : 0)} del total de SKUs vendidos.`}
        priority="Media" action="Proteger stock y disponibilidad de los productos A."
        expanded={expanded === 'h4'} onToggle={() => toggle('h4')}
        expandLabel="Ver ranking Pareto"
      >
        <TableBase rows={pareto80.slice(0, 30)} cols={[
          { key: 'SKU', label: 'SKU' },
          { key: 'producto', label: 'Producto' },
          { key: 'variante', label: 'Variante' },
          { key: 'venta_6m', label: 'Venta Período', fmt: fmtMoney },
          { key: 'pct_acumulado', label: '% Acumulado', fmt: v => fmtPct(v) },
          { key: 'clasificacion_pareto', label: 'Clasificación' },
        ]} />
      </AlertCard>

      {/* H5: Caídas */}
      <AlertCard
        title={`Productos con caída de ventas (${caidas.length})`}
        body={`${caidas.length} productos redujeron sus ventas en la segunda mitad del período vs la primera (con venta mínima de ${fmtMoney(minSalesFilter)}).`}
        priority="Media" action="Revisar causa: competencia, precio, quiebre temporal o estacionalidad."
        expanded={expanded === 'h5'} onToggle={() => toggle('h5')}
        expandLabel="Ver productos en caída"
      >
        <TableBase rows={caidas.slice(0, 30)} cols={[
          { key: 'SKU', label: 'SKU' },
          { key: 'producto', label: 'Producto' },
          { key: 'venta_60d', label: 'Venta Actual', fmt: fmtMoney },
          { key: 'venta_prev_60d', label: 'Venta Anterior', fmt: fmtMoney },
          { key: 'diferencia_venta_periodo', label: 'Diferencia', fmt: fmtMoney },
          { key: 'variacion_60d_pct', label: 'Variación %', fmt: v => v != null ? fmtPct(v) : '-' },
        ]} />
      </AlertCard>

      {/* H6: Crecimientos */}
      <AlertCard
        title={`Productos en crecimiento (${crecimientos.length})`}
        body={`${crecimientos.length} productos aumentaron sus ventas en la segunda mitad del período vs la primera.`}
        priority="Baja" action="Reforzar stock y visibilidad comercial."
        expanded={expanded === 'h6'} onToggle={() => toggle('h6')}
        expandLabel="Ver productos en crecimiento"
      >
        <TableBase rows={crecimientos.slice(0, 30)} cols={[
          { key: 'SKU', label: 'SKU' },
          { key: 'producto', label: 'Producto' },
          { key: 'venta_60d', label: 'Venta Actual', fmt: fmtMoney },
          { key: 'venta_prev_60d', label: 'Venta Anterior', fmt: fmtMoney },
          { key: 'diferencia_venta_periodo', label: 'Diferencia', fmt: fmtMoney },
          { key: 'variacion_60d_pct', label: 'Variación %', fmt: v => v != null ? fmtPct(v) : '-' },
        ]} />
      </AlertCard>
    </div>
  )
}
