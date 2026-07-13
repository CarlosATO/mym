'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { ArrowLeft, Search, Loader2, AlertTriangle, X, Check, Eye } from 'lucide-react'
import { getReplenishmentDatasetFromBsale } from '@/app/actions/integraciones/bsale-dataset'
import { generateReplenishmentPurchaseOrders } from '@/app/actions/adquisiciones/purchase-orders'
import { buildSkuSummary, classifySkus } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'
import type { NormalizedSale, SkuSummary } from '@/modules/adquisiciones/analisis-ventas/utils/analytics'

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
  onBack?: () => void
  onNavigateToPo?: (poId?: string) => void
}

interface SkuRow {
  sku: SkuSummary
  buckets: number[]
  totalUnits: number
  avgPer7: number
  suggestedQty: number
  confirmedQty: number
  confirmedCost: number
  tendenciaPct: number | null
  estadoTendencia: string
}

export function ReplenishmentAnalysisPanel({ onBack, onNavigateToPo }: Props) {
  const [loading, setLoading] = useState(false)
  const [periodIdx, setPeriodIdx] = useState(3)
  const [coverageIdx, setCoverageIdx] = useState(1)
  const [rows, setRows] = useState<SkuRow[]>([])
  const [effectiveEndDate, setEffectiveEndDate] = useState<Date>(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0,0,0,0); return d })
  const [search, setSearch] = useState('')
  const [realSupplierSearch, setRealSupplierSearch] = useState('')
  const [pseudoSupplierSearch, setPseudoSupplierSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('TODOS')
  const [confirmedSet, setConfirmedSet] = useState<Set<string>>(new Set())
  const [activeSku, setActiveSku] = useState<string | null>(null)
  const [detailSku, setDetailSku] = useState<string | null>(null)
  const [error, setError] = useState('')
  
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<any>(null)

  const periodDays = PERIOD_OPTIONS[periodIdx].value
  const numBuckets = periodDays / 7
  const coverageWeeks = COVERAGE_OPTIONS[coverageIdx].value

  function getProductName(sku: SkuSummary) {
    return sku.producto && sku.producto.trim() ? sku.producto : 'Producto no encontrado en catálogo'
  }

  function getRealSupplierName(sku: SkuSummary) {
    return sku.real_supplier_name || 'Sin proveedor'
  }

  function getPseudoSupplierName(sku: SkuSummary) {
    return sku.pseudo_supplier_name || 'Sin pseudoproveedor'
  }

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
      // FIX: Use 'Z' suffix so dates from server (UTC) parse as UTC midnight on the client.
      // Without 'Z', new Date('2026-07-04T00:00:00') in a Chile browser = 2026-07-04T04:00:00Z,
      // which is 4h later than server-generated sale dates (2026-07-04T00:00:00Z),
      // causing all sales on the first day of each bucket to be excluded.
      const periodStart = new Date(dateFrom + 'T00:00:00Z')
      const periodEnd = new Date(dateTo + 'T00:00:00Z')
      const dayAfterEnd = new Date(periodEnd.getTime() + 86400000)
      const startDate = new Date(Math.max(dayAfterEnd.getTime() - periodDays * 86400000, periodStart.getTime()))

      // Generar SkuSummary usando el motor existente
      const raw = buildSkuSummary(sales, stock, dayAfterEnd, startDate, dayAfterEnd, coverageWeeks)
      const classified = classifySkus(raw)

      // Calcular 7-day buckets para cada SKU
      const bucketEnd = dayAfterEnd.getTime()
      const bucketSize = 7 * 86400000

      const salesBySku = new Map<string, NormalizedSale[]>()
      for (const s of sales) {
        if (s.fecha >= startDate && s.fecha < dayAfterEnd) {
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
        const suggestedQty = Math.max(0, Math.ceil(avgPer7 * coverageWeeks) - sku.cantidad_disponible)

        // Tendencia: comparar primera mitad vs segunda mitad de bloques
        const TREND_THRESHOLD = 0.15
        let tendenciaPct: number | null = null
        let estadoTendencia = 'Sin comparación'
        if (buckets.length >= 2) {
          const mitad = Math.floor(buckets.length / 2)
          const anteriores = buckets.slice(0, mitad).reduce((acc, v) => acc + v, 0)
          const recientes = buckets.slice(mitad).reduce((acc, v) => acc + v, 0)
          if (anteriores > 0) {
            tendenciaPct = (recientes - anteriores) / anteriores
            if (tendenciaPct > TREND_THRESHOLD) estadoTendencia = 'Creciendo'
            else if (tendenciaPct < -TREND_THRESHOLD) estadoTendencia = 'Cayendo'
            else estadoTendencia = 'Estable'
          }
        }

        return {
          sku,
          buckets,
          totalUnits,
          avgPer7,
          suggestedQty,
          confirmedQty: suggestedQty,
          confirmedCost: suggestedQty * sku.costo_unitario,
          tendenciaPct,
          estadoTendencia,
        }
      })

      setRows(result)
      setEffectiveEndDate(dayAfterEnd)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado')
    }
    setLoading(false)
  }, [periodDays, coverageWeeks, numBuckets])

  useEffect(() => { loadData() }, [loadData])

  // ─── Filters ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let result = rows
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(r => r.sku.SKU.toLowerCase().includes(q) || getProductName(r.sku).toLowerCase().includes(q))
    }
    if (realSupplierSearch) {
      const q = realSupplierSearch.toLowerCase()
      result = result.filter(r => getRealSupplierName(r.sku).toLowerCase().includes(q))
    }
    if (pseudoSupplierSearch) {
      const q = pseudoSupplierSearch.toLowerCase()
      result = result.filter(r => getPseudoSupplierName(r.sku).toLowerCase().includes(q))
    }
    if (filterStatus === 'REPONER') {
      result = result.filter(r => r.suggestedQty > 0)
    } else if (filterStatus === 'CRITICO') {
      result = result.filter(r => r.sku.alerta === 'Quiebre crítico' || r.sku.alerta === 'Demanda histórica sin stock')
    } else if (filterStatus === 'SIN_COSTO') {
      result = result.filter(r => r.sku.costo_unitario === 0 && r.suggestedQty > 0)
    }
    return result
  }, [rows, search, realSupplierSearch, pseudoSupplierSearch, filterStatus])

  // ─── Totals ──────────────────────────────────────────────────────
  const repoUnits = rows.reduce((a, r) => a + r.confirmedQty, 0)
  const repoCost = rows.reduce((a, r) => a + r.confirmedCost, 0)
  const repoCount = rows.filter(r => r.confirmedQty > 0).length
  const criticos = rows.filter(r => r.sku.alerta === 'Quiebre crítico' || r.sku.alerta === 'Demanda histórica sin stock').length
  const sinCosto = rows.filter(r => r.sku.costo_unitario === 0 && r.suggestedQty > 0).length
  const confirmedRows = useMemo(() => rows.filter(r => confirmedSet.has(r.sku.SKU)), [rows, confirmedSet])
  const confirmedSkus = confirmedRows.length
  const confirmedUnits = confirmedRows.reduce((a, r) => a + r.confirmedQty, 0)
  const confirmedMonto = confirmedRows.reduce((a, r) => a + r.confirmedCost, 0)

  const modalGroups = useMemo(() => {
    if (!showCreateModal) return []
    const groups = new Map<string, { count: number, units: number, cost: number, hasZeroCost: boolean, hasNoRealSupplier: boolean, unresolved: boolean }>()
    
    for (const r of confirmedRows) {
      const sup = getRealSupplierName(r.sku)
      const productName = getProductName(r.sku)
      const unresolved = productName === 'Producto no encontrado en catálogo'
      const isZeroCost = r.sku.costo_unitario === 0
      const noRealSupplier = sup === 'Sin proveedor'

      if (!groups.has(sup)) {
        groups.set(sup, { count: 0, units: 0, cost: 0, hasZeroCost: false, hasNoRealSupplier: false, unresolved: false })
      }
      const g = groups.get(sup)!
      g.count += 1
      g.units += r.confirmedQty
      g.cost += r.confirmedCost
      if (isZeroCost) g.hasZeroCost = true
      if (noRealSupplier) g.hasNoRealSupplier = true
      if (unresolved) g.unresolved = true
    }
    return Array.from(groups.entries()).map(([sup, data]) => ({ name: sup, ...data }))
  }, [showCreateModal, confirmedRows])

  async function handleCreateOrders() {
    setCreating(true)
    setError('')
    try {
      const itemsToOrder = confirmedRows.map(r => ({
        sku: r.sku.SKU,
        product_name: getProductName(r.sku),
        suggested_qty: r.suggestedQty,
        confirmed_qty: r.confirmedQty,
        unit_cost: r.sku.costo_unitario,
        stock_available: r.sku.cantidad_disponible,
        avg_per_7: r.avgPer7
      }))

      const res = await generateReplenishmentPurchaseOrders({
        period_days: periodDays,
        coverage_weeks: coverageWeeks,
        items: itemsToOrder
      })

      if (res.error) {
        setError(res.error)
      } else {
        setCreateResult(res)
        setConfirmedSet(new Set())
      }
    } catch (e: any) {
      setError(e.message || 'Error inesperado al crear OC')
    }
    setCreating(false)
  }

  // ─── Bucket labels (usa effectiveEndDate, no Date.now()) ──────────
  const bucketLabels = useMemo(() => {
    const ref = effectiveEndDate.getTime()
    const bucketSize = 7 * 86400000
    const labels: string[] = []
    for (let b = numBuckets - 1; b >= 0; b--) {
      const bEnd = new Date(ref - b * bucketSize)
      const bStart = new Date(bEnd.getTime() - bucketSize)
      const labelEnd = new Date(bEnd.getTime() - 86400000)
      const s = `${bStart.getUTCDate()}/${bStart.getUTCMonth() + 1}`
      const e = `${labelEnd.getUTCDate()}/${labelEnd.getUTCMonth() + 1}`
      labels.push(`${s} al ${e}`)
    }
    return labels
  }, [numBuckets, effectiveEndDate])

  // ─── ESC key closes drawer ─────────────────────────────────────
  useEffect(() => {
    if (!detailSku && !showCreateModal) return
    const handler = (e: KeyboardEvent) => { 
      if (e.key === 'Escape') {
        setDetailSku(null)
        if (!creating) setShowCreateModal(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [detailSku, showCreateModal, creating])

  // ─── Update confirmed quantity ───────────────────────────────────
  function updateConfirmedQty(sku: string, qty: number) {
    setRows(prev => {
      const rowIndex = prev.findIndex(row => row.sku.SKU === sku)
      if (rowIndex === -1) return prev
      const next = [...prev]
      const r = { ...next[rowIndex] }
      r.confirmedQty = Math.max(0, qty)
      r.confirmedCost = r.confirmedQty * r.sku.costo_unitario
      next[rowIndex] = r
      return next
    })
  }

  function toggleConfirmed(sku: string) {
    setConfirmedSet(prev => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }

  const totalBucketsCols = bucketLabels.length
  const inputClass = 'h-7 rounded-md border border-theme-border bg-theme-bg/40 px-2 text-xs text-theme-text outline-none transition placeholder:text-theme-text-muted/45 focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/15'
  const labelClass = 'text-[9px] font-semibold uppercase tracking-wide text-theme-text-muted whitespace-nowrap'
  const kpiClass = 'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-theme-border bg-theme-bg/45 px-2 text-[10px] font-medium text-theme-text-muted whitespace-nowrap'
  const thGroupClass = 'border-b border-r border-theme-border bg-theme-text/[0.1] px-2 py-[2px] text-center text-[8px] font-semibold uppercase tracking-[0.06em] text-theme-text leading-tight'
  const thClass = 'border-b border-r border-theme-border bg-theme-bg/50 px-2 py-[3px] text-left text-[9px] font-semibold uppercase tracking-wide text-theme-text-muted leading-tight'
  const stickyHeaderClass = 'sticky z-[80] border-b border-r-2 border-r-theme-border bg-theme-surface px-2 py-[3px] text-left text-[9px] font-semibold uppercase tracking-wide text-theme-text leading-tight'
  const stickyCellBase = 'sticky z-[40] bg-theme-surface'
  const stickyLastClass = 'sticky z-[40] bg-theme-surface border-r-2 border-r-theme-border shadow-[2px_0_4px_-4px_rgba(0,0,0,0.2)]'

  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-bg text-theme-text animate-in fade-in duration-200">
      {/* Header */}
      <div className="shrink-0 border-b border-theme-border bg-theme-surface px-5 py-1.5">
        <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          {onBack && (
            <button onClick={onBack} className="rounded-lg border border-theme-border p-2 text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text">
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-lg font-bold text-theme-text">Análisis de reposición</h2>
              {!loading && !error && sinCosto > 0 && (
                <span className="inline-flex items-center rounded-md border border-amber-400 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 dark:border-amber-600/50 dark:bg-amber-950/70 dark:text-amber-200">
                  Sin costo disponible: el monto estimado puede estar incompleto.
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-theme-text-muted">
              <span>Bloques de 7 días · {numBuckets} bloques en {periodDays} días · datos hasta {(() => { const d = new Date(effectiveEndDate.getTime() - 86400000); return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`; })()}</span>
              <span className="text-theme-text/30">|</span>
              <span>Mostrando <strong className="font-semibold text-theme-text">{filtered.length}</strong>/<strong className="font-semibold text-theme-text">{rows.length}</strong> SKU</span>
              <span className="text-red-600 dark:text-red-300">Críticos <strong className="font-semibold">{criticos}</strong></span>
              <span className="text-amber-600 dark:text-amber-300">Sin costo <strong className="font-semibold">{sinCosto}</strong></span>
              <span>Unidades <strong className="font-semibold text-theme-text">{fmtN(repoUnits)}</strong></span>
              <span>Costo estimado <strong className="font-semibold text-theme-text">{fmt(repoCost)}</strong></span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!loading && !error && confirmedSkus > 0 && (
            <div className="flex items-center gap-2.5 rounded-lg border border-theme-border bg-theme-bg/30 px-3 py-1.5 text-[11px] leading-tight">
              <span className="font-medium text-theme-text-muted">Confirmado:</span>
              <span>SKU <strong className="font-semibold text-theme-text">{confirmedSkus}</strong></span>
              <span>Unidades <strong className="font-semibold text-theme-text">{fmtN(confirmedUnits)}</strong></span>
              <span>Monto <strong className="font-semibold text-theme-text">{fmt(confirmedMonto)}</strong></span>
            </div>
          )}
          {!loading && !error && (
            <button 
              onClick={() => setShowCreateModal(true)} 
              disabled={loading || creating || confirmedSkus === 0}
              title={confirmedSkus === 0 ? "Selecciona productos para crear una OC" : "Crear OC con los productos seleccionados"}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-xs font-bold text-white shadow-sm shadow-emerald-600/15 transition hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed">
              Crear borrador de OC
            </button>
          )}
          <button onClick={loadData} disabled={loading}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-xs font-bold text-white shadow-sm shadow-theme-accent/15 transition hover:bg-theme-accent-hover disabled:opacity-50">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>Actualizar</span>}
          </button>
        </div>
        </div>
      </div>

      {/* Controls */}
      <div className="shrink-0 border-b border-theme-border bg-theme-surface px-5 py-1 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex w-[140px] flex-col gap-0.5">
          <span className={labelClass}>Período</span>
          <select value={periodIdx} onChange={e => setPeriodIdx(Number(e.target.value))}
            className={inputClass}>
            {PERIOD_OPTIONS.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex w-[85px] flex-col gap-0.5">
          <span className={labelClass}>Cobertura</span>
          <select value={coverageIdx} onChange={e => setCoverageIdx(Number(e.target.value))}
            className={inputClass}>
            {COVERAGE_OPTIONS.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex w-[85px] flex-col gap-0.5">
          <span className={labelClass}>Estado</span>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className={inputClass}>
          <option value="TODOS">Todos</option>
          <option value="REPONER">A reponer</option>
          <option value="CRITICO">Críticos</option>
          <option value="SIN_COSTO">Sin costo</option>
        </select>
        </div>
        <div className="flex w-[180px] flex-col gap-0.5">
          <span className={labelClass}>SKU / producto</span>
          <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-3 w-3 text-theme-text-muted/60" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Buscar SKU o producto..."
            className={`${inputClass} w-full pl-7`} />
          </div>
        </div>
          <div className="flex w-[170px] flex-col gap-0.5">
          <span className={labelClass}>Proveedor real</span>
          <input type="text" value={realSupplierSearch} onChange={e => setRealSupplierSearch(e.target.value)}
            placeholder="Buscar proveedor real..."
            className={`${inputClass} w-full`} />
          </div>
          <div className="flex w-[170px] flex-col gap-0.5">
          <span className={labelClass}>Pseudoproveedor</span>
          <input type="text" value={pseudoSupplierSearch} onChange={e => setPseudoSupplierSearch(e.target.value)}
            placeholder="Buscar pseudoproveedor..."
            className={`${inputClass} w-full`} />
          </div>
          <div className="flex items-center gap-1 text-[10px]">
            <span className={kpiClass}>SKU <strong className="text-theme-text">{rows.length}</strong></span>
            <span className={kpiClass}>Reponer <strong className="text-emerald-700 dark:text-emerald-300">{repoCount}</strong></span>
            <span className={kpiClass}>Críticos <strong className="text-red-600 dark:text-red-300">{criticos}</strong></span>
            <span className={kpiClass}>s/costo <strong className="text-amber-600 dark:text-amber-300">{sinCosto}</strong></span>
            <span className={kpiClass}>Unid. <strong className="text-theme-text">{fmtN(repoUnits)}</strong></span>
            <span className={kpiClass}>Costo <strong className="text-theme-text">{fmt(repoCost)}</strong></span>
        </div>
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
        <div className="flex-1 overflow-hidden px-2 pb-2 pt-1.5">
          <div className="h-full overflow-auto rounded-lg border border-theme-border bg-theme-surface shadow-sm">
          <table className="min-w-[1948px] w-full border-separate border-spacing-0 text-[11px]">
            <thead className="z-20 bg-theme-surface">
              <tr className="sticky top-0 z-[70] bg-theme-surface shadow-[0_2px_4px_-4px_rgba(0,0,0,0.15)]">
                <th colSpan={6} className={`${thGroupClass} text-left`}>Producto</th>
                <th colSpan={1} className={thGroupClass}>Stock</th>
                <th colSpan={bucketLabels.length} className={thGroupClass}>Unidades vendidas cada 7 días</th>
                <th colSpan={4} className={thGroupClass}>Confirmación de compra</th>
                <th colSpan={4} className={`${thGroupClass} border-r-0`}>Cálculo sugerido</th>
              </tr>
              <tr className="sticky top-[24px] z-[60] bg-theme-surface shadow-[0_2px_2px_-3px_rgba(0,0,0,0.12)]">
                <th className={`${stickyHeaderClass} left-0 w-[36px] min-w-[36px] max-w-[36px]`}>#</th>
                <th className={`${stickyHeaderClass} left-[36px] w-[80px] min-w-[80px] max-w-[80px]`}>SKU</th>
                <th className={`${stickyLastClass} left-[116px] w-[304px] min-w-[304px] max-w-[304px]`}>Producto / descripción</th>
                <th className={`${thClass} min-w-[130px]`}>Variante / tipo</th>
                <th className={`${thClass} min-w-[180px]`}>Proveedor real</th>
                <th className={`${thClass} min-w-[170px]`}>Pseudoproveedor</th>
                <th className={`${thClass} w-[72px] text-center`} title="Stock disponible">Disponible</th>
                {bucketLabels.map((label, bi) => (
                  <th key={bi} className={`${thClass} w-[68px] text-right font-mono text-[10px]`} title={label}>{label}</th>
                ))}
                <th className={`${thClass} w-[78px] text-right`} title="stock_objetivo = prom_7d * cobertura - stock_actual">Sugerido</th>
                <th className={`${thClass} w-[90px] text-center`}>Cantidad</th>
                <th className={`${thClass} w-[108px] text-right`}>Monto confirmado</th>
                <th className={`${thClass} w-[72px] text-center`}>Confirmar</th>
                <th className={`${thClass} w-[82px] text-right`}>Total vendido</th>
                <th className={`${thClass} w-[88px] text-right`} title="Promedio unidades por bloque de 7 días">Prom. semanal</th>
                <th className={`${thClass} w-[96px] text-right`}>Costo unitario</th>
                <th className={`${thClass} w-[90px] border-r-0 text-center`}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => {
                const s = row.sku
                const productName = getProductName(s)
                const realSupplierName = getRealSupplierName(s)
                const pseudoSupplierName = getPseudoSupplierName(s)
                const unresolved = productName === 'Producto no encontrado en catálogo'
                const costBadge = s.costo_unitario === 0 && row.suggestedQty > 0
                const isActive = activeSku === s.SKU
                const isConfirmed = confirmedSet.has(s.SKU)
                const activeCls = isActive
                  ? 'border-l-2 border-l-theme-accent bg-theme-accent/10'
                  : isConfirmed
                  ? 'border-l-2 border-l-emerald-500/40'
                  : ''
                const rowBg = idx % 2 === 0 ? 'bg-theme-surface' : 'bg-theme-bg'
                const statusCls = costBadge
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25'
                  : s.alerta === 'Quiebre crítico' || s.alerta === 'Demanda histórica sin stock'
                  ? 'bg-red-500/10 text-red-600 dark:text-red-300 border-red-500/25'
                  : s.alerta === 'Riesgo de quiebre'
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-200 border-amber-500/25'
                  : s.alerta === 'Producto muerto con stock'
                  ? 'bg-orange-500/10 text-orange-600 dark:text-orange-200 border-orange-500/25'
                  : row.suggestedQty > 0
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/25'
                  : 'bg-theme-bg/50 text-theme-text-muted border-theme-border'
                const statusLabel = costBadge ? 'Sin costo' : s.alerta

                return (
                  <tr key={s.SKU + idx} onClick={() => setActiveSku(s.SKU)} onDoubleClick={() => setDetailSku(s.SKU)} className={`group cursor-pointer ${activeCls}`}>
                    <td className={`${stickyCellBase} ${rowBg} left-0 w-[36px] min-w-[36px] max-w-[36px] px-2 py-1.5 text-[10px] font-mono text-theme-text-muted group-hover:bg-theme-bg`}>{idx + 1}</td>
                    <td className={`${stickyCellBase} ${rowBg} left-[36px] w-[80px] min-w-[80px] max-w-[80px] px-2 py-1.5 font-mono font-medium text-theme-accent group-hover:bg-theme-bg`}>{s.SKU}</td>
                    <td className={`${stickyLastClass} ${rowBg} left-[116px] w-[304px] min-w-[304px] max-w-[304px] px-2 py-1.5 group-hover:bg-theme-bg ${unresolved ? 'text-amber-600 dark:text-amber-300' : 'text-theme-text'}`} title={productName}>
                      <div className="truncate">{productName}</div>
                    </td>
                    <td className={`${rowBg} border-b border-r border-theme-border px-2 py-1.5 text-theme-text-muted max-w-[140px] truncate`} title={s.variante || s.tipo_producto || ''}>{s.variante || s.tipo_producto || '-'}</td>
                    <td className={`${rowBg} border-b border-r border-theme-border px-2 py-1.5 text-theme-text max-w-[180px] truncate`} title={realSupplierName}>{realSupplierName}</td>
                    <td className={`${rowBg} border-b border-r border-theme-border px-2 py-1.5 text-theme-text-muted max-w-[170px] truncate`} title={pseudoSupplierName}>{pseudoSupplierName}</td>
                    <td className={`${rowBg} border-b border-r border-theme-border px-2 py-1.5 text-center font-semibold text-theme-text`}>{s.cantidad_disponible || '—'}</td>
                    {row.buckets.map((val, bi) => (
                      <td key={bi} className="border-b border-r border-theme-border px-2 py-1.5 text-right font-mono text-theme-text">{val > 0 ? val : '—'}</td>
                    ))}
                    <td className="border-b border-r border-theme-border px-2 py-1.5 text-right font-semibold text-theme-text">{row.suggestedQty > 0 ? row.suggestedQty : '—'}</td>
                    <td className="border-b border-r border-theme-border px-2 py-1 text-center">
                      <input
                        type="number"
                        min="0"
                        value={row.confirmedQty}
                        onChange={e => updateConfirmedQty(s.SKU, Number(e.target.value))}
                        className="h-6 w-14 rounded-md border border-theme-border bg-theme-bg/50 px-1 text-right text-[11px] font-medium text-theme-text outline-none focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/15"
                      />
                    </td>
                    <td className="border-b border-r border-theme-border px-2 py-1.5 text-right font-medium text-theme-text">{row.confirmedCost > 0 ? fmtN(row.confirmedCost) : '—'}</td>
                    <td className="border-b border-r border-theme-border px-2 py-1.5 text-center">
                      <input type="checkbox" checked={confirmedSet.has(s.SKU)} onChange={() => toggleConfirmed(s.SKU)} className="h-3.5 w-3.5 rounded border-theme-border text-theme-accent" />
                    </td>
                    <td className="border-b border-r border-theme-border px-2 py-1.5 text-right font-medium text-theme-text">{row.totalUnits || '—'}</td>
                    <td className="border-b border-r border-theme-border px-2 py-1.5 text-right text-theme-text">{row.avgPer7 > 0 ? row.avgPer7.toFixed(1) : '—'}</td>
                    <td className={`${rowBg} border-b border-r border-theme-border px-2 py-1.5 text-right text-theme-text-muted`}>
                      {costBadge
                        ? <span className="font-medium text-amber-600 dark:text-amber-300">s/costo</span>
                        : fmtN(s.costo_unitario)
                      }
                    </td>
                    <td className={`${rowBg} border-b border-theme-border px-2 py-1.5 text-center`}>
                      <span className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-medium whitespace-nowrap border ${statusCls}`}>
                        {statusLabel.length > 18 ? statusLabel.slice(0, 16) + '..' : statusLabel}
                      </span>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={15 + totalBucketsCols} className="bg-theme-surface py-12 text-center text-sm text-theme-text-muted">
                  No se encontraron SKU con los filtros actuales.
                </td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Drawer / Ficha lateral */}
      {detailSku && (() => {
        const row = rows.find(r => r.sku.SKU === detailSku)
        if (!row) return null
        const s = row.sku
        const productName = getProductName(s)
        const realSupplierName = getRealSupplierName(s)
        const pseudoSupplierName = getPseudoSupplierName(s)
        const isConfirmed = confirmedSet.has(s.SKU)
        const sAccion = s.alerta || 'Normal'

        return (
          <div className="fixed inset-0 z-[1100] flex justify-end bg-black/30 backdrop-blur-sm" onClick={() => setDetailSku(null)}>
            <aside className="h-full w-full max-w-[720px] overflow-y-auto border-l border-theme-border bg-theme-surface shadow-2xl" onClick={e => e.stopPropagation()}>
              {/* Drawer header */}
              <div className="sticky top-0 z-10 border-b border-theme-border bg-theme-surface px-5 py-3.5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-theme-text-muted">Ficha de reposición</p>
                    <h2 className="mt-0.5 truncate text-base font-bold text-theme-text">{productName}</h2>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <span className="rounded-full border border-theme-border bg-theme-bg/40 px-2 py-0.5 text-[10px] font-medium text-theme-text-muted">SKU {s.SKU}</span>
                      <span className="rounded-full border border-theme-border bg-theme-bg/40 px-2 py-0.5 text-[10px] font-medium text-theme-text-muted">{realSupplierName}</span>
                      <span className="rounded-full border border-theme-border bg-theme-bg/40 px-2 py-0.5 text-[10px] font-medium text-theme-text-muted">{sAccion}</span>
                    </div>
                  </div>
                  <button onClick={() => setDetailSku(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-theme-border text-theme-text-muted hover:bg-theme-bg/50 hover:text-theme-text">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="space-y-4 p-5">
                {/* Indicadores del sugerido */}
                <section className="rounded-lg border border-theme-border bg-theme-bg/30 p-4">
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Indicadores del sugerido</h3>
                  <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 text-sm">
                    {[
                      ['Stock disponible', fmtN(s.cantidad_disponible)],
                      ['Ventas del período', fmtN(row.totalUnits)],
                      ['Promedio semanal', row.avgPer7.toFixed(2)],
                      ['Stock objetivo', fmtN(Math.ceil(row.avgPer7 * coverageWeeks))],
                      ['Cobertura actual', s.dias_cobertura != null ? `${(s.dias_cobertura / 7).toFixed(1)} sem.` : '—'],
                      ['Variación reciente', row.tendenciaPct !== null ? `${(row.tendenciaPct * 100).toFixed(1)}%` : '—'],
                      ['Estado tendencia', row.estadoTendencia],
                      ['Compra sugerida', fmtN(row.suggestedQty)],
                    ].map(([label, value]) => (
                      <div key={label} className="flex items-center justify-between border-b border-theme-border/50 pb-1.5 last:border-0">
                        <span className="text-[11px] text-theme-text-muted">{label}</span>
                        <strong className={`text-[11px] font-semibold ${
                          label === 'Estado tendencia' && value === 'Creciendo' ? 'text-emerald-500' :
                          label === 'Estado tendencia' && value === 'Cayendo' ? 'text-red-500' :
                          label === 'Variación reciente' && row.tendenciaPct !== null && row.tendenciaPct > 0 ? 'text-emerald-500' :
                          label === 'Variación reciente' && row.tendenciaPct !== null && row.tendenciaPct < 0 ? 'text-red-500' :
                          'text-theme-text'
                        }`}>{value}</strong>
                      </div>
                    ))}
                  </div>
                </section>

                {/* Unidades vendidas cada 7 días */}
                <section className="rounded-lg border border-theme-border bg-theme-bg/30 p-4">
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">UNIDADES VENDIDAS CADA 7 DÍAS</h3>
                  <div className="overflow-hidden rounded-md border border-theme-border">
                    <table className="w-full text-[11px]">
                      <tbody>
                        {bucketLabels.map((label, bi) => (
                          <tr key={bi} className="border-b border-theme-border last:border-0">
                            <td className="px-3 py-2 text-theme-text-muted">{label}</td>
                            <td className="px-3 py-2 text-right font-semibold text-theme-text">{row.buckets[bi] > 0 ? row.buckets[bi] : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* Confirmación de compra */}
                <section className="rounded-lg border border-theme-border bg-theme-bg/30 p-4">
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Confirmación de compra</h3>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="flex flex-col justify-between rounded-lg border border-theme-border bg-theme-surface p-3.5">
                      <label className="text-[10px] font-semibold text-theme-text-muted">Cantidad confirmada</label>
                      <input type="number" min={0} value={row.confirmedQty} onChange={e => updateConfirmedQty(s.SKU, Number(e.target.value))}
                        className="mt-2 h-9 w-full rounded-md border border-theme-border bg-theme-bg/40 px-3 text-right text-sm font-semibold text-theme-text outline-none focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/15" />
                    </div>
                    <div className="flex flex-col justify-between rounded-lg border border-theme-border bg-theme-surface p-3.5">
                      <label className="text-[10px] font-semibold text-theme-text-muted">Monto confirmado</label>
                      <div className="mt-2 text-right text-sm font-bold text-theme-text">{fmt(row.confirmedCost)}</div>
                    </div>
                    <button onClick={() => { toggleConfirmed(s.SKU); setDetailSku(null) }}
                      className="flex items-center justify-center gap-2 rounded-lg bg-theme-accent px-4 text-sm font-bold text-white shadow-sm shadow-theme-accent/15 transition hover:bg-theme-accent-hover">
                      <Check className="h-4 w-4" />
                      Confirmar compra
                    </button>
                  </div>
                  <p className="mt-3 text-[10px] font-medium text-theme-text-muted">
                    {isConfirmed ? '✓ Fila confirmada.' : 'Revise los indicadores antes de confirmar.'}
                  </p>
                </section>

              </div>
            </aside>
          </div>
        )
      })()}

      {/* Modal de Creación de OC */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-theme-surface border border-theme-border rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-full">
            <div className="px-5 py-4 border-b border-theme-border flex items-center justify-between bg-theme-bg/30">
              <h3 className="text-lg font-bold text-theme-text">Confirmar creación de Órdenes de Compra</h3>
              {!creating && !createResult && (
                <button onClick={() => setShowCreateModal(false)} className="text-theme-text-muted hover:text-theme-text transition">
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            <div className="p-5 overflow-y-auto">
              {createResult ? (
                <div className="space-y-4">
                  <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 text-center">
                    <Check className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
                    <h4 className="text-emerald-700 dark:text-emerald-300 font-bold text-lg mb-1">
                      {createResult.generatedPOs?.length === 1 ? '¡Borrador Creado Exitosamente!' : '¡Borradores Creados Exitosamente!'}
                    </h4>
                    <p className="text-sm text-theme-text">
                      {createResult.generatedPOs?.length === 1 
                        ? 'Se ha generado 1 borrador de orden de compra.' 
                        : `Se han generado ${createResult.generatedPOs?.length} borradores de órdenes de compra.`}
                    </p>
                  </div>
                  
                  {createResult.generatedPOs?.length > 0 && (
                    <div className="mt-4">
                      <p className="text-sm font-semibold mb-2 text-theme-text-muted uppercase tracking-wide">Órdenes generadas</p>
                      <ul className="space-y-2">
                        {createResult.generatedPOs.map((po: any, idx: number) => {
                          return (
                            <li key={idx} className="flex justify-between items-center p-3 rounded-lg border border-theme-border bg-theme-bg/50">
                              <div>
                                <span className="font-medium text-theme-text block">{po.correlative}</span>
                                <span className="text-xs text-theme-text-muted">{po.po_id}</span>
                              </div>
                              {onNavigateToPo && (
                                <button 
                                  onClick={() => { setShowCreateModal(false); setCreateResult(null); onNavigateToPo(po.po_id); }}
                                  className="px-3 py-1.5 rounded-lg bg-theme-surface border border-theme-border text-xs font-semibold text-theme-accent hover:bg-theme-bg transition">
                                  Abrir
                                </button>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                  {createResult.blockedNoSupplier?.length > 0 && (
                    <div className="mt-4 bg-amber-500/10 border border-amber-500/30 p-3 rounded-lg">
                      <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1">SKUs ignorados por falta de Proveedor Real:</p>
                      <p className="text-[11px] text-amber-600 dark:text-amber-400">{createResult.blockedNoSupplier.join(', ')}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-5">
                  <p className="text-sm text-theme-text">Se generará <strong>una Orden de Compra por cada Proveedor Real</strong> con los productos seleccionados.</p>
                  
                  <div className="space-y-3">
                    {modalGroups.map((group, idx) => (
                      <div key={idx} className={`p-3 rounded-lg border ${group.hasNoRealSupplier || group.unresolved ? 'bg-red-500/10 border-red-500/30' : 'bg-theme-bg/50 border-theme-border'}`}>
                        <div className="flex justify-between items-start mb-1">
                          <h4 className="font-bold text-sm text-theme-text">{group.name}</h4>
                          <span className="text-xs font-semibold text-theme-text-muted">{group.count} productos</span>
                        </div>
                        <div className="flex gap-4 text-xs text-theme-text-muted mb-2">
                          <span>Unidades: <strong className="text-theme-text">{fmtN(group.units)}</strong></span>
                          <span>Total Neto: <strong className="text-theme-text">{fmt(group.cost)}</strong></span>
                        </div>
                        
                        {(group.hasNoRealSupplier || group.unresolved) && (
                          <div className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400 font-medium">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>Bloqueado: Estos ítems no se incluirán porque carecen de proveedor real o no existen en el catálogo.</span>
                          </div>
                        )}
                        {group.hasZeroCost && (
                          <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 font-medium mt-1">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>Advertencia: Hay productos con costo $0. Podrás corregirlos en la OC en estado Borrador.</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {modalGroups.length > 1 && (
                    <div className="bg-theme-accent/10 border border-theme-accent/20 rounded-lg p-3">
                      <p className="text-xs font-medium text-theme-accent">Seleccionaste productos de distintos proveedores. Se crearán {modalGroups.filter(g => !g.hasNoRealSupplier && !g.unresolved).length} órdenes de compra independientes.</p>
                    </div>
                  )}

                  {error && (
                    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                      <p className="text-sm text-red-500 font-medium text-center">{error}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-theme-border bg-theme-bg/30 flex justify-end gap-3">
              {createResult ? (
                <>
                  <button onClick={() => { setShowCreateModal(false); setCreateResult(null) }} className="px-4 py-2 rounded-lg bg-theme-bg border border-theme-border text-sm font-medium hover:bg-theme-surface transition">
                    Cerrar
                  </button>
                  {onNavigateToPo && createResult.generatedPOs?.length === 1 && (
                    <button onClick={() => { setShowCreateModal(false); setCreateResult(null); onNavigateToPo(createResult.generatedPOs[0].po_id) }} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold shadow-sm hover:bg-emerald-700 transition">
                      <Eye className="w-4 h-4" />
                      <span>Abrir y Revisar OC</span>
                    </button>
                  )}
                  {onNavigateToPo && createResult.generatedPOs?.length > 1 && (
                    <button onClick={() => { setShowCreateModal(false); setCreateResult(null); onNavigateToPo() }} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold shadow-sm hover:bg-emerald-700 transition">
                      <Eye className="w-4 h-4" />
                      <span>Ir a Órdenes de Compra</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button onClick={() => setShowCreateModal(false)} disabled={creating} className="px-4 py-2 rounded-lg bg-theme-bg border border-theme-border text-sm font-medium hover:bg-theme-surface transition disabled:opacity-50">
                    Cancelar
                  </button>
                  <button onClick={handleCreateOrders} disabled={creating || modalGroups.filter(g => !g.hasNoRealSupplier && !g.unresolved).length === 0} 
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold shadow-sm hover:bg-emerald-700 transition disabled:opacity-50">
                    {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    <span>Confirmar Creación</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
