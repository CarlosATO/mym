'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { getReplenishmentDatasetFromBsale } from '@/app/actions/integraciones/bsale-dataset'
import { getReplenishmentAvailabilityDaily, getReplenishmentKardexHistory } from '@/app/actions/integraciones/bsale-dataset'
import type { ReplenishmentAvailabilityDaily, ReplenishmentDataset, ReplenishmentKardexEvent, ReplenishmentKardexHistoryPayload } from '@/app/actions/integraciones/bsale-dataset'
import type { SkuForecastResult } from './replenishment-forecast'
import { getReplenishmentFilterCatalog, type ReplenishmentFilterCatalog, type ReplenishmentFilterPair } from '@/app/actions/adquisiciones/replenishment-filter-catalog'
import { prepareReplenishmentPurchaseOrder, type PrepareReplenishmentPurchaseOrderResult } from '@/app/actions/adquisiciones/purchase-orders'
import { downloadReplenishmentExcelV2, type ReplenishmentExcelRow } from '@/modules/adquisiciones/ordenes-compra/replenishment-excel'
import { fmt, fmtN } from './replenishment-format'
import { NO_SUPPLIER, PRODUCT_FALLBACK, getProductName, getPseudoSupplierName, getRealSupplierName } from './replenishment-names'
import { buildBreakSummaryIndex, deriveRows, getBreakSummary, type BreakSummaryIndex, type SkuRow } from './replenishment-derive'
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
import { ReplenishmentAnalyticsSheet } from './replenishment-analytics-sheet'

const COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'
const DEFAULT_PERIOD_IDX = 3
const INITIAL_DATASET_DAYS = 60
const REPLENISHMENT_PO_PREPARATION_KEY = 'mym:adquisiciones:replenishment-po-preparation'
const FORECAST_DATE_FROM = '2026-01-01'
const FORECAST_DATE_TO = '2026-09-21'
const DETAIL_OFFICE_ID = 1
let filterCatalogPromise: ReturnType<typeof getReplenishmentFilterCatalog> | null = null

function chileTodayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date())
}

function availabilityCacheKey(variantId: number) {
  return `${COMPANY_ID}|${DETAIL_OFFICE_ID}|${variantId}|${chileTodayKey()}`
}

function kardexCacheKey(variantId: number) {
  return `${COMPANY_ID}|${DETAIL_OFFICE_ID}|${variantId}|${FORECAST_DATE_FROM}|${FORECAST_DATE_TO}`
}

function getFilterCatalogOnce() {
  filterCatalogPromise ??= getReplenishmentFilterCatalog()
  return filterCatalogPromise
}

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
  { label: '12 semanas', value: 12 },
  { label: '16 semanas', value: 16 },
]

interface Props {
  onBack?: () => void
  onNavigateToPo?: () => void
}

export function ReplenishmentAnalysisPanel({ onBack, onNavigateToPo }: Props) {
  // ─── Dataset / filas ─────────────────────────────────────────────
  const [rows, setRows] = useState<SkuRow[]>([])
  const [activeDataset, setActiveDataset] = useState<ReplenishmentDataset | null>(null)
  const [filterCatalog, setFilterCatalog] = useState<ReplenishmentFilterCatalog>({ suppliers: [], pairs: [] })
  const [catalogError, setCatalogError] = useState('')
  const datasetCache = useRef(new Map<number, ReplenishmentDataset>())
  const availabilityCache = useRef(new Map<string, ReplenishmentAvailabilityDaily[] | null>())
  const availabilityPromises = useRef(new Map<string, Promise<ReplenishmentAvailabilityDaily[] | null>>())
  const kardexCache = useRef(new Map<string, ReplenishmentKardexEvent[] | null>())
  const forecastCache = useRef(new Map<string, SkuForecastResult>())
  const kardexPromises = useRef(new Map<string, Promise<ReplenishmentKardexHistoryPayload | null>>())
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
  // Las cantidades editadas dejan de seguir el sugerido al cambiar parámetros.
  const manualQuantitySkus = useRef(new Set<string>())
  const [activeSku, setActiveSku] = useState<string | null>(null)
  const [detailSku, setDetailSku] = useState<string | null>(null)
  const [dailyAvailability, setDailyAvailability] = useState<ReplenishmentAvailabilityDaily[] | null>(null)
  const [dailyAvailabilityLoading, setDailyAvailabilityLoading] = useState(false)
  const [kardex, setKardex] = useState<ReplenishmentKardexEvent[] | null>(null)
  const [kardexLoading, setKardexLoading] = useState(false)
  const [forecast, setForecast] = useState<SkuForecastResult | null>(null)
  const [forecastError, setForecastError] = useState<string | null>(null)
  const [detailDataVariantId, setDetailDataVariantId] = useState<number | null>(null)
  const [hoveredRowSku, setHoveredRowSku] = useState<string | null>(null)
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null)
  const [error, setError] = useState('')
  const [validationMessage, setValidationMessage] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [creating, setCreating] = useState(false)
  const [downloadingExcel, setDownloadingExcel] = useState(false)
  const [prepareResult, setPrepareResult] = useState<PrepareReplenishmentPurchaseOrderResult | null>(null)

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

  const findSuitableDataset = useCallback((requiredDays: number): ReplenishmentDataset | undefined => {
    let suitable: ReplenishmentDataset | undefined
    let suitableDays = Infinity
    for (const [days, data] of datasetCache.current.entries()) {
      if (days >= requiredDays && days < suitableDays) {
        suitable = data
        suitableDays = days
      }
    }
    return suitable
  }, [])

  const breakSummaryByVariantId: BreakSummaryIndex = useMemo(
    () => activeDataset ? buildBreakSummaryIndex(activeDataset) : new Map(),
    [activeDataset],
  )

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
      const suitable = findSuitableDataset(periodDays)
      if (suitable) return Promise.resolve(suitable)
    }

    // 2. Revisar promesas en vuelo
    if (!force) {
      let suitablePromise: Promise<ReplenishmentDataset> | undefined
      let suitableDays = Infinity
      for (const [days, promise] of promisesCache.current.entries()) {
        if (days >= periodDays && days < suitableDays) {
          suitablePromise = promise
          suitableDays = days
        }
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
  }, [findSuitableDataset])

  // Carga la capacidad histórica mínima y el catálogo de filtros
  useEffect(() => {
    let cancelled = false
    const period = PERIOD_OPTIONS[DEFAULT_PERIOD_IDX].value

    // 1. Cargar catálogo de filtros (independiente del dataset)
    getFilterCatalogOnce()
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

    // 2. Cargar capacidad histórica mínima y derivar el análisis de 28 días
    fetchDataset(INITIAL_DATASET_DAYS)
      .then(dataset => {
        if (cancelled) return
        setActiveDataset(dataset)
        const { rows: newRows, dayAfterEnd } = deriveRows(dataset, period, COVERAGE_OPTIONS[coverageIdxRef.current].value)
        setRows(newRows)
        setEffectiveEndDate(dayAfterEnd)
        setInitialLoading(false)
      })
      .catch(() => {
        if (!cancelled) setInitialLoading(false)
      })
    return () => { cancelled = true }
  }, [fetchDataset])

  // ─── Aplicación automática de período / cobertura ────────────────
  const applyDerive = useCallback((dataset: ReplenishmentDataset, periodDaysN: number, coverageWeeksN: number) => {
    const { rows: newRows, dayAfterEnd } = deriveRows(dataset, periodDaysN, coverageWeeksN)
    setRows(previousRows => {
      const previousBySku = new Map(previousRows.map(row => [row.sku.SKU, row]))
      return newRows.map(row => {
        if (!manualQuantitySkus.current.has(row.sku.SKU)) return row
        const previous = previousBySku.get(row.sku.SKU)
        return previous
          ? { ...row, confirmedQty: previous.confirmedQty, confirmedCost: previous.confirmedCost }
          : row
      })
    })
    setEffectiveEndDate(dayAfterEnd)
  }, [])

  const periodRequestRef = useRef(0)

  const handlePeriodChange = useCallback((i: number) => {
    const targetPeriod = PERIOD_OPTIONS[i].value

    // Buscar dataset en caché que cubra el período solicitado (deriveRows recorta localmente)
    const suitableDataset = findSuitableDataset(targetPeriod)

    if (suitableDataset) {
      periodRequestRef.current += 1
      setActiveDataset(suitableDataset)
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
        setActiveDataset(dataset)
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
  }, [fetchDataset, findSuitableDataset, applyDerive])

  const handleCoverageChange = useCallback((i: number) => {
    const period = PERIOD_OPTIONS[periodIdxRef.current].value
    const dataset = findSuitableDataset(period)
    if (dataset) {
      periodRequestRef.current += 1
      setActiveDataset(dataset)
      applyDerive(dataset, period, COVERAGE_OPTIONS[i].value)
    }
    setCoverageIdx(i)
  }, [findSuitableDataset, applyDerive])

  const handleRefresh = useCallback(async () => {
    if (loading) return
    const appliedPeriod = PERIOD_OPTIONS[periodIdxRef.current].value
    const requiredDatasetDays = Math.max(INITIAL_DATASET_DAYS, appliedPeriod)
    const cov = COVERAGE_OPTIONS[coverageIdxRef.current].value
    const reqId = ++periodRequestRef.current
    setLoading(true)
    setError('')
    try {
      const dataset = await fetchDataset(requiredDatasetDays, true)
      if (reqId !== periodRequestRef.current) return
      setActiveDataset(dataset)
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

  async function handlePreparePurchaseOrder() {
    setCreating(true)
    setError('')
    setPrepareResult(null)
    try {
      const itemsToPrepare = effectiveRows.map(r => ({
        sku: r.sku.SKU,
        product_name: getProductName(r.sku),
        quantity: r.confirmedQty,
        reference_unit_cost: r.sku.costo_unitario,
      }))
      const res = await prepareReplenishmentPurchaseOrder({ items: itemsToPrepare })
      if (!res.success) {
        setPrepareResult(res)
        return
      }
      sessionStorage.setItem(REPLENISHMENT_PO_PREPARATION_KEY, JSON.stringify({
        source: 'REPLENISHMENT',
        supplier: res.supplier,
        items: res.items,
      }))
      setShowCreateModal(false)
      onNavigateToPo?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado al preparar la OC')
      setPrepareResult(null)
    } finally {
      setCreating(false)
    }
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

  // El detalle V2 se carga una sola vez por variante durante la sesión del panel.
  useEffect(() => {
    if (!detailSku || !activeDataset) return
    const selectedSku = detailSku.trim().toUpperCase()
    const row = rows.find(candidate => candidate.sku.SKU.trim().toUpperCase() === selectedSku)
    const variantId = row?.variantId
    if (detailSku.trim().toUpperCase() === '2008DG') console.info('[replenishment-identity]', { stage: 'analysis-panel', sku: detailSku, rowVariantId: row?.variantId ?? null, variantId: variantId ?? null })
    let cancelled = false
    setDetailDataVariantId(null)
    setDailyAvailability(null)
    setKardex(null)
    setForecast(null)
    setForecastError(null)
    if (variantId === null || variantId === undefined) {
      setDailyAvailabilityLoading(false)
      setKardexLoading(false)
      setForecastError('Variante no disponible para este SKU')
      return
    }

    const availabilityKey = availabilityCacheKey(variantId)
    const cached = availabilityCache.current.get(availabilityKey)
    if (availabilityCache.current.has(availabilityKey)) {
      setDailyAvailability(cached ?? null)
      setDailyAvailabilityLoading(false)
    } else {
      setDailyAvailabilityLoading(true)
      const inFlight = availabilityPromises.current.get(availabilityKey) || getReplenishmentAvailabilityDaily(COMPANY_ID, variantId)
        .then(result => result.success ? result.data : null)
        .catch(() => null)
        .then(result => {
          availabilityCache.current.set(availabilityKey, result)
          availabilityPromises.current.delete(availabilityKey)
          return result
        })
      availabilityPromises.current.set(availabilityKey, inFlight)
      inFlight.then(result => {
        if (cancelled) return
        setDailyAvailability(result)
        setDailyAvailabilityLoading(false)
      })
    }

    const kardexKey = kardexCacheKey(variantId)
    const kardexCached = kardexCache.current.get(kardexKey)
    if (kardexCache.current.has(kardexKey)) {
      setKardex(kardexCached ?? null)
      setKardexLoading(false)
      const cachedForecast = forecastCache.current.get(kardexKey) ?? null
      setForecast(cachedForecast)
      setForecastError(cachedForecast ? null : 'Forecast no disponible para esta variante')
      setDetailDataVariantId(variantId)
    } else {
      setKardexLoading(true)
      const kardexInFlight = kardexPromises.current.get(kardexKey) || getReplenishmentKardexHistory(COMPANY_ID, variantId, FORECAST_DATE_FROM, FORECAST_DATE_TO)
        .then(result => result.success ? result.data : null)
        .catch(() => null)
        .then(result => {
          kardexCache.current.set(kardexKey, result?.events ?? null)
          if (result?.forecast) forecastCache.current.set(kardexKey, result.forecast)
          kardexPromises.current.delete(kardexKey)
          return result
        })
      kardexPromises.current.set(kardexKey, kardexInFlight)
      kardexInFlight.then(result => {
        if (cancelled) return
        setKardex(result?.events ?? null)
        setForecast(result?.forecast ?? null)
        setForecastError(result?.forecast ? null : 'No se pudo cargar el forecast para esta variante')
        setDetailDataVariantId(variantId)
        setKardexLoading(false)
      })
    }
    return () => { cancelled = true }
  }, [activeDataset, detailSku, rows])

  // ─── Actualizar cantidad confirmada ──────────────────────────────
  function updateConfirmedQty(sku: string, qty: number) {
    const normalizedQty = Number.isFinite(qty) ? Math.max(0, qty) : 0
    manualQuantitySkus.current.add(sku)
    setRows(prev => {
      const rowIndex = prev.findIndex(row => row.sku.SKU === sku)
      if (rowIndex === -1) return prev
      const next = [...prev]
      const r = { ...next[rowIndex] }
      r.confirmedQty = normalizedQty
      r.confirmedCost = r.confirmedQty * r.sku.costo_unitario
      next[rowIndex] = r
      return next
    })
    if (normalizedQty === 0) {
      setConfirmedSet(prev => {
        const next = new Set(prev)
        next.delete(sku)
        return next
      })
    } else {
      setValidationMessage('')
    }
  }

  function toggleConfirmed(sku: string) {
    const row = rows.find(candidate => candidate.sku.SKU === sku)
    setConfirmedSet(prev => {
      const next = new Set(prev)
      if (next.has(sku)) {
        next.delete(sku)
      } else if (!row || row.confirmedQty <= 0) {
        setValidationMessage('Ingresa una cantidad mayor a 0 para incluir este producto en la compra.')
      } else {
        next.add(sku)
      }
      return next
    })
  }

  function handleClearVisibleQuantities() {
    const visibleSkus = new Set(filtered.map(row => row.sku.SKU))
    const hasQuantitiesToClear = filtered.some(row => row.confirmedQty > 0 || confirmedSet.has(row.sku.SKU))
    if (!hasQuantitiesToClear) return
    if (!window.confirm('Se pondrán en 0 las cantidades de la consulta actual.\nLas cantidades sugeridas por el sistema se mantendrán.')) return

    setRows(prev => prev.map(row => visibleSkus.has(row.sku.SKU)
      ? { ...row, confirmedQty: 0, confirmedCost: 0 }
      : row
    ))
    setConfirmedSet(prev => {
      const next = new Set(prev)
      visibleSkus.forEach(sku => next.delete(sku))
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
  const canClearVisibleQuantities = filtered.some(row => row.confirmedQty > 0 || confirmedSet.has(row.sku.SKU))

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
          canClearQuantities={canClearVisibleQuantities}
          selectedCount={selectedVisibleRows.length}
          onExportVisible={handleExportVisible}
          onExportSelected={handleExportSelected}
          onCreate={() => setShowCreateModal(true)}
          onClearQuantities={handleClearVisibleQuantities}
        />
      )}

      {validationMessage && (
        <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/10 px-5 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span>{validationMessage}</span>
          <button type="button" onClick={() => setValidationMessage('')} className="rounded p-1 text-current transition hover:bg-amber-500/15" aria-label="Cerrar aviso">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
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

      {/* Ficha analítica amplia. Reutiliza el dataset ya cargado, sin fetch adicional. */}
      {detailSku && (() => {
        const selectedSku = detailSku.trim().toUpperCase()
        const row = rows.find(candidate => candidate.sku.SKU.trim().toUpperCase() === selectedSku)
        if (!row || !activeDataset) return null
        return <ReplenishmentAnalyticsSheet
          row={row}
          dataset={activeDataset}
          breakSummary={getBreakSummary(breakSummaryByVariantId, row.variantId)}
            dailyAvailability={detailDataVariantId === row.variantId ? dailyAvailability : null}
            dailyAvailabilityLoading={detailDataVariantId !== row.variantId || dailyAvailabilityLoading}
            kardex={detailDataVariantId === row.variantId ? kardex : null}
            kardexLoading={detailDataVariantId !== row.variantId || kardexLoading}
            forecast={detailDataVariantId === row.variantId ? forecast : null}
            forecastError={detailDataVariantId === row.variantId ? forecastError : null}
          confirmed={confirmedSet.has(row.sku.SKU)}
          onClose={() => setDetailSku(null)}
          onUpdateQty={updateConfirmedQty}
          onConfirm={sku => { toggleConfirmed(sku); setDetailSku(null) }}
        />
      })()}

      {/* Modal de preparación de OC */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-theme-surface border border-theme-border rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-full">
            <div className="px-5 py-4 border-b border-theme-border flex items-center justify-between bg-theme-bg/30">
              <h3 className="text-lg font-bold text-theme-text">Preparar Orden de Compra</h3>
              {!creating && !prepareResult && (
                <button onClick={() => setShowCreateModal(false)} className="text-theme-text-muted hover:text-theme-text transition">
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            <div className="p-5 overflow-y-auto">
              <div className="space-y-5">
                {prepareResult?.success === false ? (
                  <div className="space-y-4">
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                      <div className="flex items-center gap-2 text-red-500">
                        <AlertTriangle className="h-5 w-5" />
                        <h4 className="font-bold">No se puede preparar la Orden de Compra</h4>
                      </div>
                      <p className="mt-2 text-sm text-theme-text">
                        {prepareResult.code === 'MULTIPLE_SUPPLIERS'
                          ? 'Una Orden de Compra solo puede contener productos de un mismo proveedor.'
                          : 'Estos productos deben tener un proveedor válido antes de preparar la OC.'}
                      </p>
                    </div>
                    {prepareResult.code === 'MULTIPLE_SUPPLIERS' ? prepareResult.suppliers.map(supplier => (
                      <div key={supplier.supplier_id} className="rounded-lg border border-theme-border bg-theme-bg/50 p-3">
                        <h4 className="text-sm font-bold text-theme-text">{supplier.supplier_name}</h4>
                        <ul className="mt-2 space-y-1 text-xs text-theme-text-muted">
                          {supplier.items.map(item => <li key={item.sku}>• {item.sku} — {item.product_name}</li>)}
                        </ul>
                      </div>
                    )) : (
                      <ul className="rounded-lg border border-theme-border bg-theme-bg/50 p-3 text-xs text-theme-text-muted">
                        {prepareResult.items.map(item => <li key={item.sku}>• {item.sku} — {item.product_name}</li>)}
                      </ul>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-theme-text">Se validará el proveedor real de los productos seleccionados y se abrirá el formulario editable de Nueva orden de compra. No se creará ninguna OC en este paso.</p>
                )}
                {error && <p className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-center text-sm font-medium text-red-500">{error}</p>}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-theme-border bg-theme-bg/30 flex justify-end gap-3">
              <button onClick={() => { setShowCreateModal(false); setPrepareResult(null); setError('') }} disabled={creating} className="px-4 py-2 rounded-lg bg-theme-bg border border-theme-border text-sm font-medium hover:bg-theme-surface transition disabled:opacity-50">
                {prepareResult ? 'Volver al análisis' : 'Cancelar'}
              </button>
              {!prepareResult && <button onClick={handlePreparePurchaseOrder} disabled={creating || effectiveSkus === 0}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold shadow-sm hover:bg-emerald-700 transition disabled:opacity-50">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                <span>Preparar Orden de Compra</span>
              </button>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
