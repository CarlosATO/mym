'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { ArrowLeft, Search, Filter, Loader2, AlertTriangle, ShoppingCart, ChevronDown, ChevronUp } from 'lucide-react'
import { getReplenishmentDatasetFromBsale } from '@/app/actions/integraciones/bsale-dataset'
import { buildSkuSummary, classifySkus } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'
import type { NormalizedSale, NormalizedStock, SkuSummary } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'

const PERIOD_OPTIONS = [
  { label: '7 días (1 bloque)', value: 7 },
  { label: '14 días (2 bloques)', value: 14 },
  { label: '21 días (3 bloques)', value: 21 },
  { label: '28 días (4 bloques)', value: 28 },
  { label: '56 días (8 bloques)', value: 56 },
  { label: '84 días (12 bloques)', value: 84 },
  { label: '182 días (26 bloques)', value: 182 },
]

const COVERAGE_OPTIONS = [
  { label: '1 semana', value: 1 },
  { label: '2 semanas', value: 2 },
  { label: '3 semanas', value: 3 },
  { label: '4 semanas', value: 4 },
  { label: '6 semanas', value: 6 },
  { label: '8 semanas', value: 8 },
]

function fmt(n: number): string {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
}

function fmtN(n: number): string {
  return n.toLocaleString('es-CL', { maximumFractionDigits: 0 })
}

interface Props {
  onBack: () => void
}

interface SkuRow {
  sku: SkuSummary
  buckets: number[]
  totalUnits: number
  avgPer7: number
  suggestedQty: number
  confirmedQty: number
  confirmedCost: number
}

export function ReplenishmentAnalysisPanel({ onBack }: Props) {
  const [loading, setLoading] = useState(false)
  const [periodIdx, setPeriodIdx] = useState(3)
  const [coverageIdx, setCoverageIdx] = useState(3)
  const [includeAll, setIncludeAll] = useState(false)
  const [rows, setRows] = useState<SkuRow[]>([])
  const [salesRaw, setSalesRaw] = useState<NormalizedSale[]>([])
  const [effectiveEndDate, setEffectiveEndDate] = useState<Date>(new Date())
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('TODOS')
  const [diagnostics, setDiagnostics] = useState<Record<string, any>>({})
  const [error, setError] = useState('')
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())

  const periodDays = PERIOD_OPTIONS[periodIdx].value
  const numBuckets = periodDays / 7
  const coverageWeeks = COVERAGE_OPTIONS[coverageIdx].value

  // ─── Build rows from dataset ──────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const dataset = await getReplenishmentDatasetFromBsale('d1000000-0000-0000-0000-000000000001', {
        periodDays,
      })
      if (!dataset.success || !dataset.data) {
        setError(dataset.error || 'Error al cargar datos')
        setLoading(false)
        return
      }

      const { sales, stock, dateFrom, dateTo, diagnostics: diag } = dataset.data
      const maxDate = new Date(dateTo + 'T23:59:59')
      const minDate = new Date(dateFrom + 'T00:00:00')
      const startDate = new Date(Math.max(maxDate.getTime() - periodDays * 86400000, minDate.getTime()))

      // Generar SkuSummary usando el motor existente
      const raw = buildSkuSummary(sales, stock, maxDate, startDate, maxDate, coverageWeeks)
      const classified = classifySkus(raw)

      // Calcular 7-day buckets para cada SKU
      const bucketEnd = maxDate.getTime()
      const bucketSize = 7 * 86400000

      const salesBySku = new Map<string, NormalizedSale[]>()
      for (const s of sales) {
        if (s.fecha >= startDate && s.fecha <= maxDate) {
          if (!salesBySku.has(s.SKU)) salesBySku.set(s.SKU, [])
          salesBySku.get(s.SKU)!.push(s)
        }
      }

      const result: SkuRow[] = classified.map(sku => {
        const skuSales = salesBySku.get(sku.SKU) || []
        const buckets: number[] = []

        for (let b = 0; b < numBuckets; b++) {
          const bEnd = new Date(bucketEnd - b * bucketSize)
          const bStart = new Date(bEnd.getTime() - bucketSize)
          const units = skuSales
            .filter(s => s.fecha >= bStart && s.fecha < bEnd)
            .reduce((sum, s) => sum + s.cantidad, 0)
          buckets.unshift(units) // oldest first
        }

        const totalUnits = sku.unidades_6m
        const avgPer7 = numBuckets > 0 ? totalUnits / numBuckets : 0

        // suggested = max(0, avg_per_7days * coverage_weeks - current_stock)
        const suggestedQty = Math.max(0, Math.round(avgPer7 * coverageWeeks - sku.cantidad_disponible))

        return {
          sku,
          buckets,
          totalUnits,
          avgPer7,
          suggestedQty,
          confirmedQty: suggestedQty,
          confirmedCost: suggestedQty * sku.costo_unitario,
        }
      })

      setRows(result)
      setSalesRaw(sales)
      setEffectiveEndDate(maxDate)
      setDiagnostics(diag)
    } catch (e: any) {
      setError(e.message || 'Error inesperado')
    }
    setLoading(false)
  }, [periodDays, coverageWeeks, numBuckets])

  useEffect(() => { loadData() }, [loadData])

  // ─── Filters ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let result = rows
    if (!includeAll) {
      result = result.filter(r => r.sku.cantidad_disponible > 0 || r.sku.venta_6m > 0)
    }
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(r => r.sku.SKU.toLowerCase().includes(q) || r.sku.producto.toLowerCase().includes(q))
    }
    if (filterStatus === 'REPONER') {
      result = result.filter(r => r.suggestedQty > 0)
    } else if (filterStatus === 'CRITICO') {
      result = result.filter(r => r.sku.alerta === 'Quiebre crítico' || r.sku.alerta === 'Demanda histórica sin stock')
    } else if (filterStatus === 'SIN_COSTO') {
      result = result.filter(r => r.sku.costo_unitario === 0 && r.suggestedQty > 0)
    }
    return result
  }, [rows, includeAll, search, filterStatus])

  // ─── Totals ──────────────────────────────────────────────────────
  const repoUnits = rows.reduce((a, r) => a + r.confirmedQty, 0)
  const repoCost = rows.reduce((a, r) => a + r.confirmedCost, 0)
  const repoCount = rows.filter(r => r.confirmedQty > 0).length
  const criticos = rows.filter(r => r.sku.alerta === 'Quiebre crítico' || r.sku.alerta === 'Demanda histórica sin stock').length
  const sinCosto = rows.filter(r => r.sku.costo_unitario === 0 && r.suggestedQty > 0).length

  // ─── Bucket labels (usa effectiveEndDate, no Date.now()) ──────────
  const bucketLabels = useMemo(() => {
    const ref = effectiveEndDate.getTime()
    const bucketSize = 7 * 86400000
    const labels: string[] = []
    for (let b = numBuckets - 1; b >= 0; b--) {
      const bEnd = new Date(ref - b * bucketSize)
      const bStart = new Date(bEnd.getTime() - bucketSize)
      const s = `${bStart.getDate()}/${bStart.getMonth() + 1}`
      const e = `${bEnd.getDate()}/${bEnd.getMonth() + 1}`
      labels.push(`${s}-${e}`)
    }
    return labels
  }, [numBuckets, effectiveEndDate])

  // ─── Update confirmed quantity ───────────────────────────────────
  function updateConfirmedQty(rowIndex: number, qty: number) {
    setRows(prev => {
      const next = [...prev]
      const r = { ...next[rowIndex] }
      r.confirmedQty = Math.max(0, qty)
      r.confirmedCost = r.confirmedQty * r.sku.costo_unitario
      next[rowIndex] = r
      return next
    })
  }

  function toggleExpand(rowIndex: number) {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(rowIndex)) next.delete(rowIndex)
      else next.add(rowIndex)
      return next
    })
  }

  const totalBucketsCols = bucketLabels.length

  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface animate-in fade-in duration-200">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-theme-border bg-theme-text/[0.02] flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 rounded-xl hover:bg-theme-text/10 text-theme-text-muted transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-lg font-bold text-theme-text">Reposición Inteligente</h2>
            <p className="text-xs text-theme-text-muted">Bloques de 7 días · {numBuckets} bloques en {periodDays} días · datos hasta {effectiveEndDate.toLocaleDateString('es-CL')}</p>
          </div>
        </div>
        <button onClick={loadData} disabled={loading}
          className="h-9 px-4 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-lg shadow-theme-accent/20 flex items-center gap-1.5 disabled:opacity-50">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>Actualizar</span>}
        </button>
      </div>

      {/* Controls */}
      <div className="shrink-0 px-6 py-3 border-b border-theme-border bg-theme-surface flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-theme-text-muted">Periodo:</span>
          <select value={periodIdx} onChange={e => setPeriodIdx(Number(e.target.value))}
            className="h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
            {PERIOD_OPTIONS.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-theme-text-muted">Cobertura:</span>
          <select value={coverageIdx} onChange={e => setCoverageIdx(Number(e.target.value))}
            className="h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
            {COVERAGE_OPTIONS.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-theme-text-muted cursor-pointer ml-2">
          <input type="checkbox" checked={includeAll} onChange={e => setIncludeAll(e.target.checked)} className="rounded" />
          Incluir todo
        </label>
        <div className="flex items-center gap-2 ml-auto">
          <Search className="w-3.5 h-3.5 text-theme-text-muted/50" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar SKU o producto..."
            className="h-8 w-48 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text placeholder:text-theme-text-muted/40 focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
          <option value="TODOS">Todos</option>
          <option value="REPONER">A reponer</option>
          <option value="CRITICO">Críticos</option>
          <option value="SIN_COSTO">Sin costo</option>
        </select>
      </div>

      {/* KPIs */}
      <div className="shrink-0 px-6 py-3 border-b border-theme-border bg-theme-surface/50 grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-theme-text/[0.02] rounded-xl px-4 py-2.5 border border-theme-border/60">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider">SKU evaluados</p>
          <p className="text-lg font-black text-theme-text">{rows.length}</p>
        </div>
        <div className="bg-theme-text/[0.02] rounded-xl px-4 py-2.5 border border-theme-border/60">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider">A reponer</p>
          <p className="text-lg font-black text-emerald-600 dark:text-emerald-400">{repoCount}</p>
        </div>
        <div className="bg-theme-text/[0.02] rounded-xl px-4 py-2.5 border border-theme-border/60">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider">Críticos</p>
          <p className="text-lg font-black text-red-500">{criticos}</p>
        </div>
        <div className="bg-theme-text/[0.02] rounded-xl px-4 py-2.5 border border-theme-border/60">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider">Unidades a ordenar</p>
          <p className="text-lg font-black text-theme-accent">{fmtN(repoUnits)}</p>
        </div>
        <div className="bg-theme-text/[0.02] rounded-xl px-4 py-2.5 border border-theme-border/60">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider">Costo total estimado</p>
          <p className="text-lg font-black text-theme-accent">{fmt(repoCost)}</p>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-theme-accent" />
            <p className="text-sm text-theme-text-muted">Cargando datos y generando análisis...</p>
          </div>
        </div>
      )}
      {error && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-6 text-center max-w-md">
            <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
            <p className="text-sm text-red-500 font-medium">{error}</p>
          </div>
        </div>
      )}

      {/* Table */}
      {!loading && !error && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-theme-surface shadow-sm">
              <tr className="border-b border-theme-border text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                <th className="text-left px-3 py-3 w-8"></th>
                <th className="text-left px-3 py-3 w-[80px]">SKU</th>
                <th className="text-left px-3 py-3 min-w-[140px]">Producto</th>
                <th className="text-center px-3 py-3 w-[45px]" title="Stock disponible">Stk</th>
                {/* 7-day buckets */}
                {bucketLabels.map((label, bi) => (
                  <th key={bi} className="text-right px-2 py-3 w-[55px] font-mono text-[9px]" title={label}>{label}</th>
                ))}
                <th className="text-right px-3 py-3 w-[55px]">Total</th>
                <th className="text-right px-3 py-3 w-[50px]" title="Promedio unidades por bloque de 7 días">Prom/7</th>
                <th className="text-right px-3 py-3 w-[55px]" title="stock_objetivo = prom_7d * cobertura - stock_actual">Sugerido</th>
                <th className="text-center px-3 py-3 w-[60px]">Confirmar</th>
                <th className="text-right px-3 py-3 w-[55px]">Costo U.</th>
                <th className="text-right px-3 py-3 w-[70px]">Monto Conf.</th>
                <th className="text-center px-3 py-3 w-[90px]">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/50">
              {filtered.map((row, idx) => {
                const s = row.sku
                const costBadge = s.costo_unitario === 0 && row.suggestedQty > 0
                const badCls = s.alerta === 'Quiebre crítico' || s.alerta === 'Demanda histórica sin stock'
                  ? 'bg-red-500/10 text-red-500 border-red-500/20'
                  : s.alerta === 'Riesgo de quiebre'
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                  : s.alerta === 'Producto muerto con stock'
                  ? 'bg-orange-500/10 text-orange-500 border-orange-500/20'
                  : row.suggestedQty > 0
                  ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                  : 'bg-theme-text/5 text-theme-text-muted border-theme-border/50'

                return (
                  <tr key={s.SKU + idx} className="hover:bg-theme-text/[0.02] transition-colors">
                    <td className="px-3 py-2 text-theme-text-muted/40 text-[9px] font-mono">{idx + 1}</td>
                    <td className="px-3 py-2 font-mono font-bold text-theme-accent">{s.SKU}</td>
                    <td className="px-3 py-2 text-theme-text truncate max-w-[180px]" title={s.producto}>{s.producto}</td>
                    <td className="px-3 py-2 text-center font-semibold">{s.cantidad_disponible || '—'}</td>
                    {/* Buckets */}
                    {row.buckets.map((val, bi) => (
                      <td key={bi} className="px-2 py-2 text-right text-theme-text-muted">{val > 0 ? val : ''}</td>
                    ))}
                    <td className="px-3 py-2 text-right font-semibold">{row.totalUnits || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold">{row.avgPer7 > 0 ? row.avgPer7.toFixed(1) : '—'}</td>
                    <td className="px-3 py-2 text-right font-bold text-theme-text">{row.suggestedQty > 0 ? row.suggestedQty : '—'}</td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="number"
                        min="0"
                        value={row.confirmedQty}
                        onChange={e => updateConfirmedQty(idx, Number(e.target.value))}
                        className="w-16 h-7 text-center rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {costBadge
                        ? <span className="text-red-400">s/costo</span>
                        : fmtN(s.costo_unitario)
                      }
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{row.confirmedCost > 0 ? fmtN(row.confirmedCost) : '—'}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[9px] font-bold border ${badCls}`}>
                        {s.alerta.length > 18 ? s.alerta.slice(0, 16) + '..' : s.alerta}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={7 + totalBucketsCols} className="text-center py-12 text-sm text-theme-text-muted">
                  No se encontraron SKU con los filtros actuales.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      <div className="shrink-0 px-6 py-3 border-t border-theme-border bg-theme-text/[0.02] flex items-center justify-between text-xs text-theme-text-muted">
        <div className="flex items-center gap-4 flex-wrap">
          <span>Mostrando <strong className="text-theme-text">{filtered.length}</strong> de <strong>{rows.length}</strong> SKU</span>
          <span>Críticos: <strong className="text-red-500">{criticos}</strong></span>
          <span>Sin costo: <strong className="text-amber-500">{sinCosto}</strong></span>
          <span>Unidades a ordenar: <strong className="text-theme-accent">{fmtN(repoUnits)}</strong></span>
          <span>Costo estimado: <strong className="text-theme-accent">{fmt(repoCost)}</strong></span>
        </div>
        <button disabled
          className="h-8 px-4 rounded-lg bg-theme-text/10 text-theme-text-muted/50 text-xs font-semibold cursor-not-allowed"
          title="Disponible cuando existan productos/proveedores vinculados">
          <ShoppingCart className="w-3.5 h-3.5 inline mr-1.5" />
          Generar OC
        </button>
      </div>
    </div>
  )
}
