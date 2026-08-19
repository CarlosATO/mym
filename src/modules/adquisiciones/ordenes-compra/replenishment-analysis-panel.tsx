'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Eye, Loader2, X } from 'lucide-react'
import { getReplenishmentDatasetFromBsale } from '@/app/actions/integraciones/bsale-dataset'
import type { ReplenishmentDataset } from '@/app/actions/integraciones/bsale-dataset'
import { getReplenishmentFilterCatalog, type ReplenishmentFilterCatalog, type ReplenishmentFilterPair } from '@/app/actions/adquisiciones/replenishment-filter-catalog'
import { generateReplenishmentPurchaseOrders } from '@/app/actions/adquisiciones/purchase-orders'
import { downloadReplenishmentExcelV2, type ReplenishmentExcelRow } from '@/modules/adquisiciones/ordenes-compra/replenishment-excel'
import { fmt, fmtN } from './replenishment-format'
import { NO_SUPPLIER, PRODUCT_FALLBACK, getProductName, getPseudoSupplierName, getRealSupplierName } from './replenishment-names'
import { deriveRows, type SkuRow } from './replenishment-derive'
import {
  ALL_COLUMNS,
  FIXED_COLUMNS,
  VIEWS,
  getBucketSortIdx,
  getHistorialOptions,
  hiddenForView,
  loadViewPrefs,
  saveViewPrefs,
  visibleBucketIndicesFor,
  type ColumnId,
  type HistorialVisible,
  type SortConfig,
  type SortKey,
  type ViewId,
  type WidthKey,
} from './replenishment-columns'
import { ReplenishmentHeader } from './replenishment-header'
import { ReplenishmentFilters } from './replenishment-filters'
import { ReplenishmentEmptyState } from './replenishment-empty-state'
import { ReplenishmentResultsBar } from './replenishment-results-bar'
import { ReplenishmentConfigPanel } from './replenishment-config-panel'
import { ReplenishmentTable } from './replenishment-table'

const COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'
const DEFAULT_PERIOD_IDX = 3

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

interface Props {
  onBack?: () => void
  onNavigateToPo?: (poId?: string) => void
}

export function ReplenishmentAnalysisPanel({ onBack, onNavigateToPo }: Props) {
  // ─── Dataset / filas ─────────────────────────────────────────────
  const [rows, setRows] = useState<SkuRow[]>([])
  const [filterCatalog, setFilterCatalog] = useState<ReplenishmentFilterCatalog>({ suppliers: [], pairs: [] })
  const [catalogError, setCatalogError] = useState('')
  const datasetCache = useRef(new Map<number, ReplenishmentDataset>())
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [effectiveEndDate, setEffectiveEndDate] = useState<Date>(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d })

  // ─── Parámetros (aplicados automáticamente) ──────────────────────
  const [periodIdx, setPeriodIdx] = useState(DEFAULT_PERIOD_IDX)
  const [coverageIdx, setCoverageIdx] = useState(1)

  // ─── Filtros (se aplican automáticamente al cambiar) ─────────────
  const [search, setSearch] = useState('')
  const [supplier, setSupplier] = useState('')
  const [line, setLine] = useState('')
  const [status, setStatus] = useState('TODOS')
  const [showAll, setShowAll] = useState(false)

  // ─── Vista / columnas / historial ────────────────────────────────
  const [view, setView] = useState<ViewId>('compra')
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set(hiddenForView('compra')))
  const [historialVisible, setHistorialVisible] = useState<HistorialVisible>('Oculto')
  const [configOpen, setConfigOpen] = useState(false)

  // ─── Interacción / resultados ────────────────────────────────────
  const [confirmedSet, setConfirmedSet] = useState<Set<string>>(new Set())
  const [activeSku, setActiveSku] = useState<string | null>(null)
  const [detailSku, setDetailSku] = useState<string | null>(null)
  const [hoveredRowSku, setHoveredRowSku] = useState<string | null>(null)
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null)
  const [error, setError] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [downloadingExcel, setDownloadingExcel] = useState(false)
  const [createResult, setCreateResult] = useState<any>(null)

  const [colWidths, setColWidths] = useState<Record<WidthKey, number>>({
    sku: 80,
    product: 304,
    variant: 130,
    realSupplier: 240,
    pseudoSupplier: 170,
    disponible: 72,
    sugerido: 78,
    cantidad: 90,
    monto: 108,
    confirmar: 72,
    totalVendido: 82,
    promedio: 88,
    costo: 96,
    estado: 90,
  })

  // Ancho de columnas semanales (todas comparten el mismo ancho inicial)
  const [bucketColWidth, setBucketColWidth] = useState(90)

  useEffect(() => {
    const saved = localStorage.getItem('replenishment_bucket_col_width')
    if (saved) {
      const n = Number(saved)
      if (!isNaN(n) && n > 0) setBucketColWidth(n)
    }
  }, [])

  const updateBucketColWidth = useCallback((newWidth: number) => {
    const clamped = Math.max(60, newWidth)
    setBucketColWidth(clamped)
    localStorage.setItem('replenishment_bucket_col_width', String(clamped))
  }, [])

  // ─── Parámetros aplicados derivados ──────────────────────────────
  const periodDays = PERIOD_OPTIONS[periodIdx].value
  const numBuckets = periodDays / 7
  const coverageWeeks = COVERAGE_OPTIONS[coverageIdx].value

  // Refs para leer valores actuales en handlers async/sync (evita closures viejas)
  const periodIdxRef = useRef(periodIdx)
  const coverageIdxRef = useRef(coverageIdx)
  const promisesCache = useRef(new Map<number, Promise<ReplenishmentDataset>>())
  useEffect(() => { periodIdxRef.current = periodIdx }, [periodIdx])
  useEffect(() => { coverageIdxRef.current = coverageIdx }, [coverageIdx])

  // ─── Consulta presente: ausencia de filtros ≠ mostrar todos ──────
  const hasQuery = useMemo(() => {
    if (showAll) return true
    return search.trim() !== '' || supplier.trim() !== '' || line.trim() !== '' || status !== 'TODOS'
  }, [showAll, search, supplier, line, status])

  // ─── Persistencia de anchos (existente) ──────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem('replenishment_col_widths')
    if (saved) {
      try { setColWidths(prev => ({ ...prev, ...JSON.parse(saved) })) } catch (e) { /* ignore */ }
    }
  }, [])

  const updateColWidth = useCallback((key: WidthKey, newWidth: number) => {
    setColWidths(prev => {
      const next = { ...prev, [key]: newWidth }
      localStorage.setItem('replenishment_col_widths', JSON.stringify(next))
      return next
    })
  }, [])

  // ─── Persistencia de vista/columnas/historial (V2) ───────────────
  /* eslint-disable react-hooks/set-state-in-effect -- lectura de localStorage tras montaje (mismo patrón que anchos) */
  useEffect(() => {
    const prefs = loadViewPrefs()
    if (prefs) {
      setView(prefs.view)
      setHiddenColumns(new Set(prefs.hidden))
      setHistorialVisible(prefs.historial)
    }
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    saveViewPrefs({ view, hidden: Array.from(hiddenColumns) as ColumnId[], historial: historialVisible })
  }, [view, hiddenColumns, historialVisible])

  // ─── Fetch con caché en memoria por período (y promesas en vuelo) ──────
  const fetchDataset = useCallback((periodDays: number, force = false): Promise<ReplenishmentDataset> => {
    // 1. Revisar caché existente
    if (!force) {
      let suitable: ReplenishmentDataset | undefined
      for (const [days, data] of datasetCache.current.entries()) {
        if (days >= periodDays) { suitable = data; break }
      }
      if (suitable) return Promise.resolve(suitable)
    }

    // 2. Revisar promesas en vuelo
    if (!force) {
      let suitablePromise: Promise<ReplenishmentDataset> | undefined
      for (const [days, promise] of promisesCache.current.entries()) {
        if (days >= periodDays) { suitablePromise = promise; break }
      }
      if (suitablePromise) return suitablePromise
    }

    // 3. Iniciar nuevo fetch
    const t0 = performance.now()
    const promise = getReplenishmentDatasetFromBsale(COMPANY_ID, { periodDays })
      .then(res => {
        if (!res.success || !res.data) throw new Error(res.error || 'Error al cargar datos')
        datasetCache.current.set(periodDays, res.data)
        console.log(`[WARMUP METRICS] periodDays: ${periodDays}, fetch_ms: ${(performance.now() - t0).toFixed(2)}, salesRows: ${res.data.sales.length}, stockRows: ${res.data.stock.length}, aproxPayload: ~${Math.round(JSON.stringify(res.data).length / 1024)}KB`)
        return res.data
      })
      .finally(() => {
        promisesCache.current.delete(periodDays)
      })

    promisesCache.current.set(periodDays, promise)
    return promise
  }, [])

  // Calienta el período por defecto y el catálogo de filtros
  useEffect(() => {
    let cancelled = false
    const period = PERIOD_OPTIONS[DEFAULT_PERIOD_IDX].value

    // 1. Cargar catálogo de filtros (independiente del dataset)
    getReplenishmentFilterCatalog()
      .then(res => {
        if (cancelled) return
        if (res.success && res.data) {
          setFilterCatalog(res.data)
        } else {
          setCatalogError(res.error || 'Error al cargar catálogo')
        }
      })
      .catch(e => {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : 'Error')
      })

    // 2. Cargar análisis 28 días
    fetchDataset(period)
      .then(dataset => {
        if (cancelled) return
        const { rows: newRows, dayAfterEnd } = deriveRows(dataset, period, COVERAGE_OPTIONS[coverageIdxRef.current].value)
        setRows(newRows)
        setEffectiveEndDate(dayAfterEnd)
        setInitialLoading(false)

        // BACKGROUND WARMUP SILENCIOSO (solo afecta caché y dataset, NO catálogo)
        const maxPeriod = PERIOD_OPTIONS[PERIOD_OPTIONS.length - 1].value
        if (period < maxPeriod) {
          setTimeout(() => {
            if (!cancelled) {
              fetchDataset(maxPeriod).catch(() => { /* falla silenciosa */ })
            }
          }, 500)
        }
      })
      .catch(() => {
        if (!cancelled) setInitialLoading(false)
      })
    return () => { cancelled = true }
  }, [fetchDataset])

  // ─── Aplicación automática de período / cobertura ────────────────
  const applyDerive = useCallback((dataset: ReplenishmentDataset, periodDaysN: number, coverageWeeksN: number) => {
    const { rows: newRows, dayAfterEnd } = deriveRows(dataset, periodDaysN, coverageWeeksN)
    setRows(newRows)
    setEffectiveEndDate(dayAfterEnd)
  }, [])

  const periodRequestRef = useRef(0)

  const handlePeriodChange = useCallback((i: number) => {
    const targetPeriod = PERIOD_OPTIONS[i].value

    // Buscar dataset en caché que cubra el período solicitado (deriveRows recorta localmente)
    let suitableDataset: ReplenishmentDataset | undefined
    for (const [days, data] of datasetCache.current.entries()) {
      if (days >= targetPeriod) {
        suitableDataset = data
        break
      }
    }

    if (suitableDataset) {
      periodRequestRef.current += 1
      applyDerive(suitableDataset, targetPeriod, COVERAGE_OPTIONS[coverageIdxRef.current].value)
      setPeriodIdx(i)
      return
    }
    const reqId = ++periodRequestRef.current
    setLoading(true)
    setError('')
    fetchDataset(targetPeriod)
      .then(dataset => {
        if (reqId !== periodRequestRef.current) return
        applyDerive(dataset, targetPeriod, COVERAGE_OPTIONS[coverageIdxRef.current].value)
        setPeriodIdx(i)
      })
      .catch(e => {
        if (reqId !== periodRequestRef.current) return
        setError(e instanceof Error ? e.message : 'Error inesperado')
      })
      .finally(() => {
        if (reqId === periodRequestRef.current) setLoading(false)
      })
  }, [fetchDataset, applyDerive])

  const handleCoverageChange = useCallback((i: number) => {
    const period = PERIOD_OPTIONS[periodIdxRef.current].value
    const dataset = datasetCache.current.get(period)
    if (dataset) {
      periodRequestRef.current += 1
      const { rows: newRows, dayAfterEnd } = deriveRows(dataset, period, COVERAGE_OPTIONS[i].value)
      setRows(newRows)
      setEffectiveEndDate(dayAfterEnd)
    }
    setCoverageIdx(i)
  }, [])

  const handleRefresh = useCallback(async () => {
    if (loading) return
    const appliedPeriod = PERIOD_OPTIONS[periodIdxRef.current].value
    const cov = COVERAGE_OPTIONS[coverageIdxRef.current].value
    const reqId = ++periodRequestRef.current
    setLoading(true)
    setError('')
    try {
      const dataset = await fetchDataset(appliedPeriod, true)
      if (reqId !== periodRequestRef.current) return
      applyDerive(dataset, appliedPeriod, cov)
    } catch (e) {
      if (reqId !== periodRequestRef.current) return
      setError(e instanceof Error ? e.message : 'Error inesperado')
    } finally {
      if (reqId === periodRequestRef.current) setLoading(false)
    }
  }, [loading, fetchDataset, applyDerive])

  const handleNewQuery = useCallback(() => {
    setSearch('')
    setSupplier('')
    setLine('')
    setStatus('TODOS')
    setShowAll(false)
  }, [])

  // ─── Vista / columnas / historial ────────────────────────────────
  const selectView = useCallback((v: ViewId) => {
    const def = VIEWS.find(x => x.id === v)!
    setView(v)
    setHiddenColumns(new Set(ALL_COLUMNS.filter(c => !def.visible.includes(c))))
    setHistorialVisible(def.historial)
  }, [])

  const toggleColumn = useCallback((id: ColumnId) => {
    if (id === 'semanas') {
      setHistorialVisible(prev => (prev === 'Oculto' ? '4' : 'Oculto'))
    } else {
      setHiddenColumns(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }
  }, [])

  const restoreDefault = useCallback(() => {
    const def = VIEWS.find(x => x.id === 'compra')!
    setView('compra')
    setHiddenColumns(new Set(ALL_COLUMNS.filter(c => !def.visible.includes(c))))
    setHistorialVisible('Oculto')
  }, [])

  // ─── Relación Proveedor ↔ Línea ──────────────────────────────────
  const pairSet = useMemo(() => {
    const map = new Map<string, Set<string>>()
    const add = (r: string, p: string) => {
      const rr = r.trim() || NO_SUPPLIER
      const pp = p.trim() || PRODUCT_FALLBACK
      if (!map.has(rr)) map.set(rr, new Set())
      map.get(rr)!.add(pp)
    }
    for (const pair of filterCatalog.pairs) {
      add(pair.real_supplier_name, pair.pseudo_supplier_name)
    }
    return map
  }, [filterCatalog.pairs])

  const allSuppliers = filterCatalog.suppliers

  const allLines = useMemo(() => {
    const set = new Set<string>()
    for (const lines of pairSet.values()) for (const l of lines) set.add(l)
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'))
  }, [pairSet])

  // Opciones dependientes bidireccionales (solo afectan los listados,
  // los resultados de la tabla se actualizan automáticamente).
  const supplierOptions = useMemo(() => {
    if (!line) return allSuppliers
    // Intersection: only suppliers that have this line in pairs
    return allSuppliers.filter(s => pairSet.get(s)?.has(line))
  }, [allSuppliers, line, pairSet])

  const lineOptions = useMemo(() => {
    if (!supplier) return allLines
    return allLines.filter(l => pairSet.get(supplier)?.has(l))
  }, [allLines, supplier, pairSet])

  // Handlers explícitos de selección: si la nueva selección es
  // incompatible con la contraparte, se limpia SOLO la contraparte.
  // No se usan efectos, evitando ciclos de reset Proveedor↔Línea.
  const handleSupplierChange = useCallback((value: string) => {
    setSupplier(value)
    if (line && !pairSet.get(value)?.has(line)) setLine('')
  }, [line, pairSet])

  const handleLineChange = useCallback((value: string) => {
    setLine(value)
    if (supplier && !pairSet.get(supplier)?.has(value)) setSupplier('')
  }, [supplier, pairSet])

  const handleClearSupplier = useCallback(() => { setSupplier('') }, [])
  const handleClearLine = useCallback(() => { setLine('') }, [])
  const handleClearSearch = useCallback(() => { setSearch('') }, [])
  const handleSearchChange = useCallback((v: string) => { setSearch(v) }, [])
  const handleStatusChange = useCallback((v: string) => { setStatus(v) }, [])
  const handleShowAllChange = useCallback((v: boolean) => { setShowAll(v) }, [])

  // ─── Filtrado (se aplica automáticamente) ────────────────────────
  const filteredBase = useMemo(() => {
    let result = rows
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(r => r.sku.SKU.toLowerCase().includes(q) || getProductName(r.sku).toLowerCase().includes(q))
    }
    if (supplier) {
      const q = supplier.toLowerCase()
      result = result.filter(r => getRealSupplierName(r.sku).toLowerCase().includes(q))
    }
    if (line) {
      const q = line.toLowerCase()
      result = result.filter(r => getPseudoSupplierName(r.sku).toLowerCase().includes(q))
    }
    if (status === 'REPONER') {
      result = result.filter(r => r.suggestedQty > 0)
    } else if (status === 'CRITICO') {
      result = result.filter(r => r.sku.alerta === 'Quiebre crítico' || r.sku.alerta === 'Demanda histórica sin stock')
    } else if (status === 'SIN_COSTO') {
      result = result.filter(r => r.sku.costo_unitario === 0 && r.suggestedQty > 0)
    }
    return result
  }, [rows, search, supplier, line, status])

  const handleSort = useCallback((key: SortKey) => {
    setSortConfig(prev => {
      if (prev?.key === key) {
        if (prev.direction === 'asc') return { key, direction: 'desc' }
        return null
      }
      return { key, direction: 'asc' }
    })
  }, [])

  const filtered = useMemo(() => {
    const data = [...filteredBase]
    if (!sortConfig) return data
    return data.sort((a, b) => {
      let valA: any
      let valB: any
      switch (sortConfig.key) {
        case 'sku': valA = a.sku.SKU.toLowerCase(); valB = b.sku.SKU.toLowerCase(); break
        case 'producto': valA = getProductName(a.sku).toLowerCase(); valB = getProductName(b.sku).toLowerCase(); break
        case 'variante': valA = (a.sku.variante || a.sku.tipo_producto || '').toLowerCase(); valB = (b.sku.variante || b.sku.tipo_producto || '').toLowerCase(); break
        case 'proveedor_real': valA = getRealSupplierName(a.sku).toLowerCase(); valB = getRealSupplierName(b.sku).toLowerCase(); break
        case 'pseudoproveedor': valA = getPseudoSupplierName(a.sku).toLowerCase(); valB = getPseudoSupplierName(b.sku).toLowerCase(); break
        case 'disponible': valA = a.sku.cantidad_disponible || 0; valB = b.sku.cantidad_disponible || 0; break
        case 'sugerido': valA = a.suggestedQty || 0; valB = b.suggestedQty || 0; break
        case 'cantidad': valA = a.confirmedQty || 0; valB = b.confirmedQty || 0; break
        case 'monto': valA = a.confirmedCost || 0; valB = b.confirmedCost || 0; break
        case 'total_vendido': valA = a.totalUnits || 0; valB = b.totalUnits || 0; break
        case 'promedio': valA = a.avgPer7 || 0; valB = b.avgPer7 || 0; break
        case 'costo': valA = a.sku.costo_unitario || 0; valB = b.sku.costo_unitario || 0; break
        case 'estado': {
          const rank = (al: string) => {
            if (al === 'Quiebre crítico' || al === 'Demanda histórica sin stock') return 1
            if (al === 'Riesgo de quiebre') return 2
            if (al === 'Producto muerto con stock') return 4
            return 3
          }
          valA = rank(a.sku.alerta || ''); valB = rank(b.sku.alerta || ''); break
        }
        default: {
          const bi = getBucketSortIdx(sortConfig.key)
          if (bi !== null) {
            valA = a.buckets[bi] ?? 0; valB = b.buckets[bi] ?? 0
          } else {
            valA = 0; valB = 0
          }
        }
      }
      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
  }, [filteredBase, sortConfig])

  // ─── Selección efectiva (sin cambios) ────────────────────────────
  const confirmedRows = useMemo(() => rows.filter(r => confirmedSet.has(r.sku.SKU)), [rows, confirmedSet])
  const effectiveRows = useMemo(() => confirmedRows.filter(r => r.confirmedQty > 0), [confirmedRows])
  const effectiveSkus = effectiveRows.length
  const effectiveUnits = useMemo(() => effectiveRows.reduce((a, r) => a + r.confirmedQty, 0), [effectiveRows])
  const effectiveCost = useMemo(() => effectiveRows.reduce((a, r) => a + r.confirmedCost, 0), [effectiveRows])

  const modalGroups = useMemo(() => {
    if (!showCreateModal) return []
    const groups = new Map<string, { count: number, units: number, cost: number, hasZeroCost: boolean, hasNoRealSupplier: boolean, unresolved: boolean }>()
    for (const r of effectiveRows) {
      const sup = getRealSupplierName(r.sku)
      const productName = getProductName(r.sku)
      const unresolved = productName === PRODUCT_FALLBACK
      const isZeroCost = r.sku.costo_unitario === 0
      const noRealSupplier = sup === NO_SUPPLIER
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
  }, [showCreateModal, effectiveRows])

  async function handleCreateOrders() {
    setCreating(true)
    setError('')
    try {
      const itemsToOrder = effectiveRows.map(r => ({
        sku: r.sku.SKU,
        product_name: getProductName(r.sku),
        suggested_qty: r.suggestedQty,
        confirmed_qty: r.confirmedQty,
        unit_cost: r.sku.costo_unitario,
        stock_available: r.sku.cantidad_disponible,
        avg_per_7: r.avgPer7,
      }))
      const res = await generateReplenishmentPurchaseOrders({
        period_days: periodDays,
        coverage_weeks: coverageWeeks,
        items: itemsToOrder,
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

  // ─── Labels de semanas ───────────────────────────────────────────
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
      labels.push(`${s}–${e}`)
    }
    return labels
  }, [numBuckets, effectiveEndDate])

  // ─── ESC cierra drawer ───────────────────────────────────────────
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

  // ─── Actualizar cantidad confirmada ──────────────────────────────
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

  // ─── Visibilidad de columnas / historial ─────────────────────────
  const visibleFixed = useMemo(() => FIXED_COLUMNS.filter(id => !hiddenColumns.has(id)), [hiddenColumns])
  const effectiveHistorial = useMemo<HistorialVisible>(() => {
    const opts = getHistorialOptions(numBuckets)
    return opts.some(o => o.id === historialVisible) ? historialVisible : 'Oculto'
  }, [numBuckets, historialVisible])
  const weeksVisible = effectiveHistorial !== 'Oculto'
  const visibleBucketIndices = useMemo(
    () => visibleBucketIndicesFor(effectiveHistorial, numBuckets),
    [effectiveHistorial, numBuckets]
  )

  const viewLabel = useMemo(() => {
    const visibleSet = new Set<string>(visibleFixed)
    if (weeksVisible) visibleSet.add('semanas')
    const match = VIEWS.find(v => {
      const vSet = new Set<string>(v.visible)
      if (vSet.size !== visibleSet.size) return false
      for (const c of vSet) if (!visibleSet.has(c)) return false
      return true
    })
    return match ? match.label : 'Personalizada'
  }, [visibleFixed, weeksVisible])

  // ─── Proveedor contextual ─────────────────────────────────────────
  // Usa `supplier` que es la misma variable que filtra `filteredBase`.
  // NO modifica hiddenColumns ni preferencias guardadas.
  const singleSupplierActive = supplier.trim() !== ''

  // Visibilidad efectiva de columnas para la tabla y el Excel.
  // Si hay un proveedor único filtrado, la columna Proveedor se oculta
  // contextualmente sin alterar la preferencia configurada.
  const effectiveVisibleFixed = useMemo(
    () => visibleFixed.filter(id => !(id === 'supplier' && singleSupplierActive)),
    [visibleFixed, singleSupplierActive]
  )

  // ─── Filas seleccionadas visibles (filtered ∩ confirmedSet) ──────
  // NUNCA uses confirmedSet directamente como exportación: puede contener
  // selecciones de consultas anteriores que ya no están en pantalla.
  const selectedVisibleRows = useMemo(
    () => filtered.filter(r => confirmedSet.has(r.sku.SKU)),
    [filtered, confirmedSet]
  )

  // ─── Handlers de exportación Excel (despues de todas las derivaciones) ─
  function buildExcelRow(r: SkuRow): ReplenishmentExcelRow {
    const critical = r.sku.alerta === 'Quiebre crítico' || r.sku.alerta === 'Demanda histórica sin stock'
    const noCost = r.sku.costo_unitario === 0
    return {
      sku: r.sku.SKU,
      product: getProductName(r.sku),
      variant: r.sku.variante || r.sku.tipo_producto || '',
      realSupplier: getRealSupplierName(r.sku),
      pseudoSupplier: getPseudoSupplierName(r.sku),
      stockAvailable: r.sku.cantidad_disponible,
      buckets: r.buckets,
      totalSold: r.totalUnits,
      avgPer7: r.avgPer7,
      suggestedQty: r.suggestedQty,
      confirmedQty: r.confirmedQty,
      unitCost: r.sku.costo_unitario,
      subtotal: r.confirmedQty * r.sku.costo_unitario,
      critical,
      noCost,
      trend: r.estadoTendencia,
    }
  }

  function handleExportVisible() {
    if (filtered.length === 0) return
    setDownloadingExcel(true)
    setError('')
    try {
      const historialOpts = getHistorialOptions(numBuckets)
      const historialLabel = historialOpts.find(o => o.id === effectiveHistorial)?.label ?? 'Oculto'
      const statusLabel = status === 'TODOS' ? 'Todos' : status === 'REPONER' ? 'A reponer' : status === 'CRITICO' ? 'Críticos' : 'Sin costo'
      downloadReplenishmentExcelV2({
        visibleFixedCols: effectiveVisibleFixed,
        weeksVisible,
        visibleBucketIndices,
        bucketLabels,
        supplierFilter: supplier,
        lineFilter: line,
        statusFilter: statusLabel,
        periodLabel: `${PERIOD_OPTIONS[periodIdx].label} (${periodDays} días)`,
        coverageLabel: COVERAGE_OPTIONS[coverageIdx].label,
        historialLabel,
        rows: filtered.map(buildExcelRow),
        exportMode: 'Resultados visibles',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al generar el Excel')
    }
    setDownloadingExcel(false)
  }

  function handleExportSelected() {
    // filtered ∩ confirmedSet = solo checks presentes en la consulta actual
    const rows = filtered.filter(r => confirmedSet.has(r.sku.SKU))
    if (rows.length === 0) return
    setDownloadingExcel(true)
    setError('')
    try {
      const historialOpts = getHistorialOptions(numBuckets)
      const historialLabel = historialOpts.find(o => o.id === effectiveHistorial)?.label ?? 'Oculto'
      const statusLabel = status === 'TODOS' ? 'Todos' : status === 'REPONER' ? 'A reponer' : status === 'CRITICO' ? 'Críticos' : 'Sin costo'
      downloadReplenishmentExcelV2({
        visibleFixedCols: effectiveVisibleFixed,
        weeksVisible,
        visibleBucketIndices,
        bucketLabels,
        supplierFilter: supplier,
        lineFilter: line,
        statusFilter: statusLabel,
        periodLabel: `${PERIOD_OPTIONS[periodIdx].label} (${periodDays} días)`,
        coverageLabel: COVERAGE_OPTIONS[coverageIdx].label,
        historialLabel,
        rows: rows.map(buildExcelRow),
        exportMode: 'Solo seleccionados',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al generar el Excel')
    }
    setDownloadingExcel(false)
  }

  const hasResults = hasQuery && !error && !loading && filtered.length > 0

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[18px] border border-theme-border bg-theme-surface text-theme-text shadow-sm animate-in fade-in duration-200">
      <ReplenishmentHeader
        busy={loading}
        disabled={loading || initialLoading}
        onBack={onBack}
        onRefresh={handleRefresh}
      />

      <ReplenishmentFilters
        periodOptions={PERIOD_OPTIONS}
        coverageOptions={COVERAGE_OPTIONS}
        draftPeriodIdx={periodIdx}
        draftCoverageIdx={coverageIdx}
        onDraftPeriodChange={handlePeriodChange}
        onDraftCoverageChange={handleCoverageChange}
        supplierOptions={supplierOptions}
        lineOptions={lineOptions}
        draftSupplier={supplier}
        draftLine={line}
        onDraftSupplierChange={handleSupplierChange}
        onDraftLineChange={handleLineChange}
        onClearSupplier={handleClearSupplier}
        onClearLine={handleClearLine}
        draftSearch={search}
        onDraftSearchChange={handleSearchChange}
        onClearSearch={handleClearSearch}
        draftStatus={status}
        onDraftStatusChange={handleStatusChange}
        draftShowAll={showAll}
        onDraftShowAllChange={handleShowAllChange}
        busy={loading}
        initialLoading={initialLoading}
        viewLabel={viewLabel}
        onSelectView={selectView}
        historialOptions={getHistorialOptions(numBuckets)}
        historialVisible={effectiveHistorial}
        onSelectHistorial={setHistorialVisible}
        onOpenConfig={() => setConfigOpen(true)}
      />

      {hasResults && (
        <ReplenishmentResultsBar
          resultCount={filtered.length}
          onNewQuery={handleNewQuery}
          effectiveSkus={effectiveSkus}
          effectiveUnits={effectiveUnits}
          effectiveCost={effectiveCost}
          busy={loading}
          downloading={downloadingExcel}
          creating={creating}
          selectedCount={selectedVisibleRows.length}
          onExportVisible={handleExportVisible}
          onExportSelected={handleExportSelected}
          onCreate={() => setShowCreateModal(true)}
        />
      )}

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {error ? (
          <div className="flex h-full items-center justify-center p-8">
            <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-6 text-center max-w-md">
              <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
              <p className="text-sm text-red-500 font-medium">{error}</p>
            </div>
          </div>
        ) : initialLoading || loading ? (
          <ReplenishmentEmptyState
            variant="loading"
            title={initialLoading ? 'Preparando datos de reposición' : 'Consultando productos...'}
            subtitle={initialLoading ? 'Estamos cargando proveedores, líneas y productos.' : 'Un momento, estamos preparando los resultados.'}
          />
        ) : hasQuery ? (
          filtered.length > 0 ? (
            <ReplenishmentTable
              rows={filtered}
              visibleFixed={effectiveVisibleFixed}
              weeksVisible={weeksVisible}
              visibleBucketIndices={visibleBucketIndices}
              bucketLabels={bucketLabels}
              colWidths={colWidths}
              onResizeCommit={updateColWidth}
              bucketColWidth={bucketColWidth}
              onResizeBucketCommit={updateBucketColWidth}
              sortConfig={sortConfig}
              onSort={handleSort}
              confirmedSet={confirmedSet}
              onToggleConfirmed={toggleConfirmed}
              onUpdateQty={updateConfirmedQty}
              activeSku={activeSku}
              onRowClick={setActiveSku}
              onRowDoubleClick={setDetailSku}
              hoveredRowSku={hoveredRowSku}
              onRowHover={setHoveredRowSku}
            />

          ) : (
            <ReplenishmentEmptyState variant="no-results" onClear={handleNewQuery} />
          )
        ) : (
          <ReplenishmentEmptyState variant="initial" />
        )}
      </div>

      {/* Panel lateral de configuración — absolute dentro del workspace */}
      <ReplenishmentConfigPanel
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        hiddenColumns={hiddenColumns}
        semanasVisible={weeksVisible}
        supplierFiltered={singleSupplierActive}
        onToggleColumn={toggleColumn}
        onRestoreDefault={restoreDefault}
      />

      {/* Drawer / Ficha lateral */}
      {detailSku && (() => {
        const row = rows.find(r => r.sku.SKU === detailSku)
        if (!row) return null
        const s = row.sku
        const productName = getProductName(s)
        const realSupplierName = getRealSupplierName(s)
        const isConfirmed = confirmedSet.has(s.SKU)
        const sAccion = s.alerta || 'Normal'

        return (
          <div className="fixed inset-0 z-[1100] flex justify-end bg-black/30 backdrop-blur-sm" onClick={() => setDetailSku(null)}>
            <aside className="h-full w-full max-w-[720px] overflow-y-auto border-l border-theme-border bg-theme-surface shadow-2xl" onClick={e => e.stopPropagation()}>
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
                        {createResult.generatedPOs.map((po: any, idx: number) => (
                          <li key={idx} className="flex justify-between items-center p-3 rounded-lg border border-theme-border bg-theme-bg/50">
                            <div>
                              <span className="font-medium text-theme-text block">{po.correlative}</span>
                              <span className="text-xs text-theme-text-muted">{po.po_id}</span>
                            </div>
                            {onNavigateToPo && (
                              <button
                                onClick={() => { setShowCreateModal(false); setCreateResult(null); onNavigateToPo(po.po_id) }}
                                className="px-3 py-1.5 rounded-lg bg-theme-surface border border-theme-border text-xs font-semibold text-theme-accent hover:bg-theme-bg transition"
                              >
                                Abrir
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {createResult.blockedNoSupplier?.length > 0 && (
                    <div className="mt-4 bg-amber-500/10 border border-amber-500/30 p-3 rounded-lg">
                      <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1">SKUs ignorados por falta de Proveedor:</p>
                      <p className="text-[11px] text-amber-600 dark:text-amber-400">{createResult.blockedNoSupplier.join(', ')}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-5">
                  <p className="text-sm text-theme-text">Se generará <strong>una Orden de Compra por cada Proveedor</strong> con los productos seleccionados.</p>

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
                            <span>Bloqueado: Estos ítems no se incluirán porque carecen de proveedor o no existen en el catálogo.</span>
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
