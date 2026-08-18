'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Barcode, ClipboardCheck, FileSpreadsheet, Loader2, RefreshCw, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { notifyInventoryNavigation } from '@/modules/inventarios/components/inventory-navigation-feedback'
import {
  getActiveCompanyBarcodeSummary,
  getActiveCompanyCampaignApprovedBarcodes,
  getActiveCompanyCampaignReadiness,
  getActiveCompanyCampaignSummary,
  getCampaignAllProducts,
  getAllCampaignVariances,
  getCampaignExport,
  getCampaignVariances,
  type BarcodeIncidentSummaryResult,
  type CampaignCloseReadiness,
  type CampaignReviewSummary,
  type CampaignSortBy,
  type CampaignSortDirection,
  type CampaignVariancesResult,
} from '@/app/actions/inventarios/campaign-report'
import { downloadCampaignReportExcel, type CampaignReportExcelContribRow } from '@/modules/inventarios/lib/campaign-report-excel'
import { InventoryCampaignReportTable } from '@/modules/inventarios/components/inventory-campaign-report-table'
import { InventoryCampaignReportDetail } from '@/modules/inventarios/components/inventory-campaign-report-detail'
import { InventoryCampaignCloseDialog } from '@/modules/inventarios/components/inventory-campaign-close-dialog'
import { InventoryKpiDetailDialog } from '@/modules/inventarios/components/inventory-kpi-detail-dialog'
import { formatCLP, formatDateTimeChile, formatQuantity } from '@/modules/inventarios/lib/format'

// TTL del cache de consultas del Informe (ms). El Inventario sigue en captura y
// sus datos pueden cambiar, por lo que el cache es de muy corta vida (12s).
const CACHE_TTL_MS = 12_000
// Refresco periódico silencioso mientras la pestaña está visible (ms).
const PERIODIC_REFRESH_MS = 30_000

interface CacheEntry<T> {
  data: T
  fetchedAt: number
}

function isCacheFresh(entry: CacheEntry<unknown> | undefined): boolean {
  if (!entry) return false
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS
}

const VARIANCE_OPTIONS = [
  { value: '', label: 'Todos los resultados' },
  { value: 'FALTANTE', label: 'Faltantes' },
  { value: 'SOBRANTE', label: 'Sobrantes' },
  { value: 'SIN_DIFERENCIA', label: 'Sin diferencia' },
]

const COVERAGE_OPTIONS = [
  { value: '', label: 'Toda situación' },
  { value: 'COUNTED', label: 'Contados' },
  { value: 'NOT_COUNTED', label: 'No contados' },
  { value: 'OUT_OF_SNAPSHOT', label: 'No incluidos para conteo' },
]

interface QueryKey {
  search: string
  variance: string
  coverage: string
  page: number
  sort_by: CampaignSortBy | ''
  sort_direction: CampaignSortDirection | ''
}

function queryKeyString(k: QueryKey): string {
  return [k.search, k.variance, k.coverage, k.page, k.sort_by, k.sort_direction].join('|')
}

interface InventoryCampaignReportClientProps {
  campaignId: string
  campaignName: string
  companyId: string
  initialSummary: CampaignReviewSummary | null
  initialReadiness: CampaignCloseReadiness | null
}

export function InventoryCampaignReportClient({
  campaignId,
  campaignName,
  companyId,
  initialSummary,
  initialReadiness,
}: InventoryCampaignReportClientProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [variance, setVariance] = useState('')
  const [coverage, setCoverage] = useState('')
  const [page, setPage] = useState(1)
  const [sortBy, setSortBy] = useState<CampaignSortBy | ''>('')
  const [sortDir, setSortDir] = useState<CampaignSortDirection | ''>('')
  const [showAll, setShowAll] = useState(false)

  const [summary, setSummary] = useState<CampaignReviewSummary | null>(initialSummary)
  const [readiness, setReadiness] = useState<CampaignCloseReadiness | null>(initialReadiness)
  const [variances, setVariances] = useState<CampaignVariancesResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [debouncedSearch, setDebouncedSearch] = useState('')

  const [selectedVariant, setSelectedVariant] = useState<number | null>(null)
  const [kpiDialog, setKpiDialog] = useState<'stock' | 'operation' | null>(null)
  const [closeOpen, setCloseOpen] = useState(false)
  const [barcodeSummary, setBarcodeSummary] = useState<BarcodeIncidentSummaryResult | null>(null)
  const [exporting, setExporting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // Se incrementa para forzar revalidación (ignorando cache): focus, refresh
  // periódico, botón Actualizar y reintento manual.
  const [revision, setRevision] = useState(0)
  const cacheRef = useRef<Map<string, CacheEntry<CampaignVariancesResult>>>(new Map())
  // Marca si hay un request de variances en vuelo para evitar solapamientos.
  const variancesInFlight = useRef(false)

  // Debounce de búsqueda (≈300ms)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // ¿Existe un criterio explícito que dispare la consulta?
  const hasCriterion = Boolean(debouncedSearch || variance || coverage || showAll)

  // Revalidación de summary + readiness (silenciosa, sin cache).
  const revalidateMeta = useCallback(async () => {
    if (!companyId) return
    const [summaryResult, readinessResult, barcodeResult] = await Promise.all([
      getActiveCompanyCampaignSummary(campaignId),
      getActiveCompanyCampaignReadiness(campaignId),
      getActiveCompanyBarcodeSummary(campaignId),
    ])
    if (summaryResult.data) setSummary(summaryResult.data)
    if (readinessResult.data) setReadiness(readinessResult.data)
    if (barcodeResult.data) setBarcodeSummary(barcodeResult.data)
  }, [companyId, campaignId])

  // Fetch de variances con cache TTL. `force` ignora el cache vigente.
  const fetchVariances = useCallback(
    (opts: { force?: boolean } = {}) => {
      if (!companyId || !hasCriterion) return
      if (variancesInFlight.current) return
      const key: QueryKey = { search: debouncedSearch, variance, coverage, page, sort_by: sortBy, sort_direction: sortDir }
      const cacheKey = queryKeyString(key)
      const cached = cacheRef.current.get(cacheKey)
      if (!opts.force && cached && isCacheFresh(cached)) {
        setVariances(cached.data)
        setError(null)
        return
      }
      variancesInFlight.current = true
      startTransition(async () => {
        try {
          const result = await getCampaignVariances(companyId, campaignId, {
            search: debouncedSearch,
            variance_status: variance,
            coverage_status: coverage,
            page,
            page_size: 50,
            sort_by: sortBy || undefined,
            sort_direction: sortDir || undefined,
          })
          if (result.error || !result.data) {
            setError(result.error ?? 'No fue posible actualizar el informe.')
            return
          }
          cacheRef.current.set(cacheKey, { data: result.data, fetchedAt: Date.now() })
          setVariances(result.data)
          setError(null)
        } finally {
          variancesInFlight.current = false
        }
      })
    },
    [companyId, campaignId, hasCriterion, debouncedSearch, variance, coverage, page, sortBy, sortDir]
  )

  // Consulta inicial / cambios de filtro / revisiones.
  useEffect(() => {
    fetchVariances({ force: revision > 0 })
  }, [fetchVariances, revision])

  // Resumen de incidencias al montar (silencioso, sin cache).
  useEffect(() => {
    if (!companyId) return
    getActiveCompanyBarcodeSummary(campaignId).then(result => {
      if (result.data) setBarcodeSummary(result.data)
    })
  }, [companyId, campaignId])

  // Revalidación al recuperar foco / visibilidad (ignora cache stale).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setRevision(r => r + 1)
      void revalidateMeta()
    }
    const onFocus = () => {
      setRevision(r => r + 1)
      void revalidateMeta()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [revalidateMeta])

  // Refresco periódico silencioso mientras hay criterio y la pestaña está visible.
  useEffect(() => {
    const onTick = () => {
      if (document.visibilityState !== 'visible') return
      if (!hasCriterion) {
        void revalidateMeta()
        return
      }
      setRevision(r => r + 1)
      void revalidateMeta()
    }
    const timer = setInterval(onTick, PERIODIC_REFRESH_MS)
    return () => clearInterval(timer)
  }, [hasCriterion, revalidateMeta])

  const isFinal = Boolean(variances?.is_final ?? summary?.is_final)
  const isCampaignApproved = readiness?.campaign_status === 'APPROVED'
  const stock = summary?.stock
  const op = summary?.operation
  const readinessWarnings = readiness?.warnings
  const readinessHasPending =
    readinessWarnings &&
    (readinessWarnings.sessions_draft > 0 ||
      readinessWarnings.sessions_prepared > 0 ||
      readinessWarnings.sessions_counting > 0 ||
      readinessWarnings.sessions_under_review > 0 ||
      readinessWarnings.locations_open > 0 ||
      readinessWarnings.locations_never_visited > 0 ||
      readinessWarnings.zones_not_started > 0 ||
      readinessWarnings.zones_incomplete > 0 ||
      readinessWarnings.blocking_incident_count > 0 ||
      readinessWarnings.pending_recount_count > 0)

  // Resumen agregado de incidencias de códigos (card).
  const barcodeIncidentCounts = {
    products: barcodeSummary?.total ?? 0,
    barcodes: (barcodeSummary?.items ?? []).reduce((a, i) => a + i.pending_barcode_count, 0),
    locations: (barcodeSummary?.items ?? []).reduce((a, i) => a + i.location_count, 0),
  }
  const hasBarcodeIncidents = barcodeIncidentCounts.products > 0

  const handleSort = useCallback(
    (key: CampaignSortBy) => {
      if (sortBy === key) {
        if (sortDir === 'ASC') {
          setSortDir('DESC')
        } else {
          setSortBy('')
          setSortDir('')
        }
      } else {
        setSortBy(key)
        setSortDir('ASC')
      }
      setPage(1)
    },
    [sortBy, sortDir]
  )

  const handleClear = useCallback(() => {
    setSearch('')
    setVariance('')
    setCoverage('')
    setSortBy('')
    setSortDir('')
    setShowAll(false)
    setPage(1)
    setVariances(null)
    setError(null)
  }, [])

  const handleShowAll = useCallback(() => {
    setSearch('')
    setVariance('')
    setCoverage('')
    setShowAll(true)
    setPage(1)
    setError(null)
  }, [])

  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    cacheRef.current.clear()
    setRevision(r => r + 1)
    void revalidateMeta().finally(() => setRefreshing(false))
  }, [revalidateMeta])

  const handleRetry = useCallback(() => {
    cacheRef.current.clear()
    setError(null)
    setRevision(r => r + 1)
    void revalidateMeta()
  }, [revalidateMeta])

  const handleClosed = useCallback(() => {
    setCloseOpen(false)
    cacheRef.current.clear()
    setRevision(r => r + 1)
    void revalidateMeta()
  }, [revalidateMeta])

  const handlePage = useCallback((target: number) => {
    setPage(target)
  }, [])

  const handleExport = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    try {
      const [exportResult, variancesResult, allProductsResult, catalogResult] = await Promise.all([
        getCampaignExport(companyId, campaignId),
        getAllCampaignVariances(companyId, campaignId),
        getCampaignAllProducts(companyId, campaignId),
        getActiveCompanyCampaignApprovedBarcodes(campaignId),
      ])
      if (exportResult.error || variancesResult.error || allProductsResult.error || catalogResult.error) {
        setError(
          exportResult.error ??
            variancesResult.error ??
            allProductsResult.error ??
            catalogResult.error ??
            'No fue posible generar el Excel.'
        )
        return
      }
      if (!exportResult.data) {
        setError('No fue posible generar el Excel.')
        return
      }
      const contributions: CampaignReportExcelContribRow[] = exportResult.data.contributions.map(c => ({
        sku: c.sku,
        name: c.name,
        session_name: c.session_name,
        zone_code: c.zone_code,
        location_code: c.location_code,
        counted_by_name: c.counted_by_name,
        physical_quantity: c.physical_quantity,
        identification_method: c.identification_method,
        scanned_code: c.scanned_code,
        captured_at: c.captured_at,
      }))
      const operationalRows: string[][] = exportResult.data.operational_rows.map(r => [
        r.tipo ?? '',
        r.seccion ?? '',
        r.zona ?? '',
        r.ubicacion ?? '',
        r.estado ?? '',
        r.detalle ?? '',
      ])
      downloadCampaignReportExcel({
        campaignName,
        campaignDate: null,
        isFinal,
        generatedAt: formatDateTimeChile(new Date().toISOString()),
        summary,
        allVariances: variancesResult.items,
        allProducts: allProductsResult.items,
        contributions,
        operationalRows,
        approvedBarcodes: catalogResult.data?.items ?? [],
      })
    } catch (err) {
      console.error('export excel exception:', err)
      setError('No fue posible generar el Excel.')
    } finally {
      setExporting(false)
    }
  }, [exporting, companyId, campaignId, campaignName, isFinal, summary])

  const totalPages = Math.max(1, Math.ceil((variances?.total ?? 0) / (variances?.page_size ?? 50)))
  const hasActiveFilters = Boolean(search.trim() || variance || coverage || sortBy || showAll)
  const showEmptyState = !hasCriterion

  return (
    <div className="space-y-3">
      {/* Cabecera + Resultado provisorio */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-theme-border bg-theme-surface px-4 py-2.5 shadow-sm">
        <div>
          <h2 className="text-base font-bold text-theme-text">Informe del Inventario</h2>
          <p className="text-[11px] text-theme-text-muted">{campaignName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isFinal ? (
            <span
              title="Los resultados continuarán variando mientras existan secciones de conteo pendientes."
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
              Resultado provisorio
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Resultado final
            </span>
           )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {refreshing ? 'Actualizando…' : 'Actualizar'}
          </button>
        </div>
      </div>
      {!isFinal && (
        <p className="text-[11px] text-theme-text-muted/70">
          Los resultados continuarán variando mientras existan secciones pendientes.
        </p>
      )}

      {/* Preparación para cierre (arriba) */}
      {readiness && readinessWarnings && (
        <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-2.5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-bold text-theme-text">
              <ShieldAlert className="h-3.5 w-3.5 text-theme-text-muted/60" />
              {isCampaignApproved ? 'Cierre realizado con pendientes' : 'Preparación para cierre'}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {!isCampaignApproved && readinessHasPending ? (
                <span className="inline-flex items-center rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                  Requiere revisión
                </span>
              ) : !isCampaignApproved ? (
                <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  Listo para revisión final
                 </span>
               ) : null}
              {readiness?.can_close_authorized && readiness?.campaign_status !== 'APPROVED' && (
                <button
                  type="button"
                  onClick={() => setCloseOpen(true)}
                  disabled={(readiness?.blocker_count ?? 0) > 0}
                  title={(readiness?.blocker_count ?? 0) > 0 ? 'Existen bloqueadores que impiden el cierre' : 'Cerrar inventario'}
                  className="inline-flex h-7 items-center gap-1 rounded-lg bg-red-600 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Cerrar inventario
                </button>
              )}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-theme-text-muted">
            {readinessWarnings.sessions_draft > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.sessions_draft}</strong> secciones pendientes
              </span>
            )}
            {readinessWarnings.sessions_counting > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.sessions_counting}</strong> en conteo
              </span>
            )}
            {readinessWarnings.sessions_under_review > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.sessions_under_review}</strong> en revisión
              </span>
            )}
            {readinessWarnings.locations_open > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.locations_open}</strong> ubicaciones abiertas
              </span>
            )}
            {readinessWarnings.locations_never_visited > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.locations_never_visited}</strong> nunca visitadas
              </span>
            )}
            {readinessWarnings.locations_visited_without_counts > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.locations_visited_without_counts}</strong> sin registros
              </span>
            )}
            {readinessWarnings.zones_incomplete > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.zones_incomplete}</strong> zonas en curso
              </span>
            )}
            {readinessWarnings.zones_not_started > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.zones_not_started}</strong> zonas no iniciadas
              </span>
            )}
            {readinessWarnings.tasks_assigned > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.tasks_assigned}</strong> tareas sin iniciar
              </span>
            )}
            {readinessWarnings.tasks_in_progress > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.tasks_in_progress}</strong> tareas en curso
              </span>
            )}
            {readinessWarnings.blocking_incident_count > 0 && (
              <span>
                <strong className="text-red-600 dark:text-red-400">{readinessWarnings.blocking_incident_count}</strong> incidentes
                bloqueantes
              </span>
            )}
            {readinessWarnings.pending_recount_count > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.pending_recount_count}</strong> recuentos pendientes
              </span>
            )}
            {readinessWarnings.pending_barcode_proposals > 0 && (
              <span>
                <strong className="text-theme-text">{readinessWarnings.pending_barcode_proposals}</strong> códigos pendientes
              </span>
            )}
            {readinessWarnings.products_out_of_snapshot > 0 && (
              <span>
                <strong className="text-sky-600 dark:text-sky-400">{readinessWarnings.products_out_of_snapshot}</strong> no
                incluidos para conteo
              </span>
            )}
          </div>
        </section>
      )}

      {/* Auditoría de diferencias */}
      <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-bold text-theme-text">
            <ClipboardCheck className="h-3.5 w-3.5 text-theme-text-muted/60" />
            Auditoría de diferencias
          </h3>
          {stock && (stock.faltantes > 0 || stock.sobrantes > 0) ? (
            <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              Requiere revisión
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              Sin diferencias
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-theme-text-muted">
          <span>
            Faltantes <strong className="text-red-600 dark:text-red-400">{formatQuantity(stock?.faltantes ?? 0)}</strong>
          </span>
          <span>
            Sobrantes{' '}
            <strong className="text-emerald-600 dark:text-emerald-400">{formatQuantity(stock?.sobrantes ?? 0)}</strong>
          </span>
          <span>
            Con diferencia <strong className="text-theme-text">{formatQuantity((stock?.faltantes ?? 0) + (stock?.sobrantes ?? 0))}</strong>
          </span>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => { notifyInventoryNavigation(); router.push(`/dashboard/inventarios/campanas/${campaignId}/revision-diferencias`) }}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-theme-accent px-2.5 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            Revisar diferencias
          </button>
        </div>
      </section>

      {/* Incidencias de códigos */}
      <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-bold text-theme-text">
            <Barcode className="h-3.5 w-3.5 text-theme-text-muted/60" />
            Incidencias de códigos
          </h3>
          {hasBarcodeIncidents ? (
            <span className="inline-flex items-center rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
              Requiere revisión
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              Sin códigos pendientes
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-theme-text-muted">
          <span>
            Productos con incidencias <strong className="text-theme-text">{barcodeIncidentCounts.products}</strong>
          </span>
          <span>
            Códigos pendientes <strong className="text-theme-text">{barcodeIncidentCounts.barcodes}</strong>
          </span>
          <span>
            Ubicaciones involucradas <strong className="text-theme-text">{barcodeIncidentCounts.locations}</strong>
          </span>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => { notifyInventoryNavigation(); router.push(`/dashboard/inventarios/campanas/${campaignId}/incidencias-codigos`) }}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-theme-accent px-2.5 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
          >
            <Barcode className="h-3.5 w-3.5" />
            Revisar incidencias
          </button>
        </div>
      </section>

      {/* Resumen compacto: KPIs + valorización + operación en un contenedor */}
      {summary && stock && (
        <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-2.5 shadow-sm">
          <div
            className="grid cursor-pointer grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8"
            onDoubleClick={() => setKpiDialog('stock')}
            title="Doble clic para ver el detalle"
          >
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] text-theme-text-muted/60 uppercase tracking-wider">Productos teóricos</p>
              <p className="text-base font-bold text-theme-text">{formatQuantity(stock.products_theoretical)}</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] text-theme-text-muted/60 uppercase tracking-wider">Contados</p>
              <p className="text-base font-bold text-theme-text">{formatQuantity(stock.products_counted)}</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] text-theme-text-muted/60 uppercase tracking-wider">Faltantes</p>
              <p className="text-base font-bold text-red-600 dark:text-red-400">{formatQuantity(stock.faltantes)}</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] text-theme-text-muted/60 uppercase tracking-wider">Sobrantes</p>
              <p className="text-base font-bold text-emerald-600 dark:text-emerald-400">{formatQuantity(stock.sobrantes)}</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] text-theme-text-muted/60 uppercase tracking-wider">Sin diferencia</p>
              <p className="text-base font-bold text-theme-text">{formatQuantity(stock.sin_diferencia)}</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] text-theme-text-muted/60 uppercase tracking-wider">Unid. faltantes</p>
              <p className="text-base font-bold text-red-600 dark:text-red-400">{formatQuantity(stock.units_faltante)}</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] text-theme-text-muted/60 uppercase tracking-wider">Unid. sobrantes</p>
              <p className="text-base font-bold text-emerald-600 dark:text-emerald-400">{formatQuantity(stock.units_sobrante)}</p>
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-[10px] text-theme-text-muted/60 uppercase tracking-wider">Valorización neta</p>
              <p className="text-base font-bold text-theme-text">{formatCLP(stock.net_valuation)}</p>
            </div>
          </div>
          <div
            className="mt-2 flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border-t border-theme-border/40 pt-2 text-xs text-theme-text-muted"
            onDoubleClick={() => setKpiDialog('operation')}
            title="Doble clic para ver el detalle"
          >
            <span>
              Secciones <strong className="text-theme-text">{op?.total_sessions ?? 0}</strong>
            </span>
            <span>
              Terminadas <strong className="text-theme-text">{op?.sessions_by_status.APPROVED ?? 0}</strong>
            </span>
            <span>
              En curso{' '}
              <strong className="text-sky-600 dark:text-sky-400">
                {(op?.sessions_by_status.COUNTING ?? 0) + (op?.sessions_by_status.UNDER_REVIEW ?? 0)}
              </strong>
            </span>
            <span>
              Pendientes{' '}
              <strong className="text-sky-600 dark:text-sky-400">
                {(op?.sessions_by_status.DRAFT ?? 0) + (op?.sessions_by_status.PREPARED ?? 0)}
              </strong>
            </span>
            <span>
              Ubicaciones <strong className="text-theme-text">{op?.locations_total ?? 0}</strong>
            </span>
            <span>
              Visitadas <strong className="text-theme-text">{op?.locations_visited ?? 0}</strong>
            </span>
            <span>
              Abiertas <strong className="text-sky-600 dark:text-sky-400">{op?.locations_open ?? 0}</strong>
            </span>
            <span>
              No visitadas <strong className="text-sky-600 dark:text-sky-400">{op?.locations_never_visited ?? 0}</strong>
            </span>
            <span>
              No incluidos <strong className="text-sky-600 dark:text-sky-400">{stock.out_of_snapshot}</strong>
            </span>
            <span>
              Valorización absoluta <strong className="text-theme-text">{formatCLP(stock.absolute_valuation)}</strong>
            </span>
          </div>
        </section>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-[160px] flex-1">
          <input
            value={search}
            onChange={e => {
              setSearch(e.target.value)
              setShowAll(false)
              setPage(1)
            }}
            placeholder="Buscar por SKU o producto"
            aria-label="Buscar producto"
            className="h-7 w-full rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs text-theme-text shadow-sm outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
          />
        </div>
        <select
          value={variance}
          onChange={e => {
            setVariance(e.target.value)
            setShowAll(false)
            setPage(1)
          }}
          aria-label="Filtrar por resultado"
          className="h-7 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text shadow-sm outline-none focus:border-theme-border-accent"
        >
          {VARIANCE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={coverage}
          onChange={e => {
            setCoverage(e.target.value)
            setShowAll(false)
            setPage(1)
          }}
          aria-label="Filtrar por situación del conteo"
          className="h-7 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text shadow-sm outline-none focus:border-theme-border-accent"
        >
          {COVERAGE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleShowAll}
          className="inline-flex h-7 items-center rounded-lg bg-theme-accent px-2.5 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
        >
          Mostrar todos
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
          {exporting ? 'Generando Excel…' : 'Exportar Excel'}
        </button>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-3.5 w-3.5" />
            Limpiar
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <span>{error}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-md border border-theme-border bg-theme-surface px-2 py-0.5 text-[11px] font-medium text-theme-text hover:bg-theme-text/5"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Tabla + paginación */}
      <section className="relative">
        {pending && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-8">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-theme-border bg-theme-surface/90 px-3 py-1 text-[11px] font-medium text-theme-text-muted shadow-sm">
              <Loader2 className="h-3 w-3 animate-spin" />
              Actualizando…
            </span>
          </div>
        )}
        <div className={pending ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {showEmptyState ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 text-center">
              <p className="text-sm font-semibold text-theme-text">Consulta el resultado del inventario</p>
              <p className="max-w-sm text-xs text-theme-text-muted/70">
                Busca un SKU o producto, selecciona un filtro o elige Mostrar todos.
              </p>
            </div>
          ) : (
            variances && (
              <InventoryCampaignReportTable
                items={variances.items}
                campaignId={campaignId}
                onSelect={setSelectedVariant}
                sortBy={sortBy}
                sortDirection={sortDir}
                onSort={handleSort}
              />
            )
          )}
        </div>
        {variances && !showEmptyState && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-theme-text-muted/70">
              Mostrando {variances.total === 0 ? 0 : (variances.page - 1) * variances.page_size + 1}–
              {Math.min(variances.page * variances.page_size, variances.total)} de {variances.total} productos
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={variances.page <= 1}
                onClick={() => handlePage(variances.page - 1)}
                className="flex h-7 items-center rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                Anterior
              </button>
              <span className="px-1 text-xs font-medium text-theme-text-muted">
                {variances.page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={!variances.has_more}
                onClick={() => handlePage(variances.page + 1)}
                className="flex h-7 items-center rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </section>

      {selectedVariant !== null && (
        <InventoryCampaignReportDetail campaignId={campaignId} bsaleVariantId={selectedVariant} onClose={() => setSelectedVariant(null)} />
      )}

      {closeOpen && readiness && (
        <InventoryCampaignCloseDialog
          campaignId={campaignId}
          campaignName={campaignName}
          readiness={readiness}
          onClose={() => setCloseOpen(false)}
          onClosed={handleClosed}
        />
      )}

      {kpiDialog && summary && (
        <InventoryKpiDetailDialog group={kpiDialog} summary={summary} onClose={() => setKpiDialog(null)} />
      )}
    </div>
  )
}
