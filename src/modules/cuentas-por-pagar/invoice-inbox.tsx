'use client'

import { useCallback, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  FileText,
  FilterX,
  PackageCheck,
  RotateCcw,
  Search,
} from 'lucide-react'
import {
  OperationalTableResizeHandle,
  OperationalTableSortIndicator,
  useOperationalTableWidths,
  type OperationalTableColumn,
} from '@/components/ui/operational-table'
import { formatCivilDate } from '@/lib/datetime'
import { erpInputClass, erpSelectClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import type {
  BsaleBodegaReconciliationReport,
  ReconciledInvoiceEntry,
} from './bsale-bodega-reconciliation'
import type {
  BsaleFinancialSummaryCounts,
  InvoiceFinancialStatusOverlay,
} from './bsale-financial-balance-resolver'
import { BsaleReconciliationDetailPanel } from './bsale-reconciliation-detail-panel'
import {
  buildBsaleSupplierFilterOptions,
  extractBodegaIncidentsFromReport,
  extractSiiInvoicesFromReport,
  filterAndPaginateBsaleInvoices,
  formatSignedClpDifference,
  resolveFinancialAccreditationBadge,
  resolveFinancialInboxGroup,
  resolveMonetaryReconciliationBadge,
  resolvePhysicalReceptionBadge,
  summarizeFinancialInboxGroups,
  type BsaleBadgeTone,
  type BsaleInvoiceSortColumn,
  type BsaleReconciliationFilterValue,
  type FinancialPrimaryFilterValue,
} from './bsale-reconciliation-view-model'
import { formatClp, formatRut } from './validation-rules'

const TABLE_PREFS_KEY = 'mym:cxp-bsale-reconciliation:table-v3'

const CXP_BSALE_COLUMNS: OperationalTableColumn[] = [
  {
    id: 'emissionDate',
    defaultWidth: 100,
    minWidth: 88,
    maxWidth: 140,
    sortable: true,
    sortKey: 'emissionDate',
    sortType: 'date',
  },
  {
    id: 'supplier',
    defaultWidth: 255,
    minWidth: 180,
    maxWidth: 460,
    sortable: true,
    sortKey: 'supplier',
    sortType: 'text',
  },
  {
    id: 'folio',
    defaultWidth: 112,
    minWidth: 96,
    maxWidth: 170,
    sortable: true,
    sortKey: 'folio',
    sortType: 'number',
  },
  {
    id: 'financialStatus',
    defaultWidth: 196,
    minWidth: 156,
    maxWidth: 270,
    sortable: true,
    sortKey: 'financialStatus',
    sortType: 'text',
  },
  {
    id: 'dueDate',
    defaultWidth: 132,
    minWidth: 106,
    maxWidth: 180,
    sortable: true,
    sortKey: 'dueDate',
    sortType: 'date',
  },
  {
    id: 'siiAmount',
    defaultWidth: 116,
    minWidth: 100,
    maxWidth: 175,
    sortable: true,
    sortKey: 'siiAmount',
    sortType: 'number',
  },
  {
    id: 'receivedAmount',
    defaultWidth: 126,
    minWidth: 108,
    maxWidth: 185,
    sortable: true,
    sortKey: 'receivedAmount',
    sortType: 'number',
  },
  {
    id: 'difference',
    defaultWidth: 112,
    minWidth: 96,
    maxWidth: 175,
    sortable: true,
    sortKey: 'difference',
    sortType: 'number',
  },
  {
    id: 'monetaryStatus',
    defaultWidth: 150,
    minWidth: 130,
    maxWidth: 230,
    sortable: true,
    sortKey: 'monetaryStatus',
    sortType: 'text',
  },
  {
    id: 'receptionStatus',
    defaultWidth: 162,
    minWidth: 136,
    maxWidth: 240,
    sortable: true,
    sortKey: 'receptionStatus',
    sortType: 'text',
  },
]

const COLUMN_BY_ID = Object.fromEntries(
  CXP_BSALE_COLUMNS.map(col => [col.id, col]),
) as Record<string, OperationalTableColumn>

function badgeToneClasses(tone: BsaleBadgeTone): string {
  switch (tone) {
    case 'emerald':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'amber':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'sky':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    case 'red':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
    default:
      return 'border-theme-border bg-theme-bg text-theme-text-muted'
  }
}

export function InvoiceInbox({
  report,
  financialByKey,
  financialCounts,
}: {
  report: BsaleBodegaReconciliationReport
  financialByKey?: Record<string, InvoiceFinancialStatusOverlay>
  financialCounts?: BsaleFinancialSummaryCounts
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [supplierRut, setSupplierRut] = useState('ALL')
  const [folioQuery, setFolioQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [financialPrimaryFilter, setFinancialPrimaryFilter] =
    useState<FinancialPrimaryFilterValue>('TO_PAY')
  const [reconciliationFilter, setReconciliationFilter] =
    useState<BsaleReconciliationFilterValue>('ALL')
  const [sortColumn, setSortColumn] =
    useState<BsaleInvoiceSortColumn>('emissionDate')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [showIncidentsSection, setShowIncidentsSection] = useState(true)
  const [activeDetailKey, setActiveDetailKey] = useState<string | null>(null)

  const {
    widths,
    setColumnWidth,
    persist: persistWidths,
    reset: resetWidths,
  } = useOperationalTableWidths(TABLE_PREFS_KEY, CXP_BSALE_COLUMNS)

  // Las 777 facturas SII (33 y 34) precalculadas por el motor, ordenadas desde la más reciente
  const siiInvoices = useMemo(
    () => extractSiiInvoicesFromReport(report),
    [report],
  )

  // Las 3 incidencias de Bodega (2 recepciones FA sin SII + 1 GD 147), separadas de las 777 facturas
  const bodegaIncidents = useMemo(
    () => extractBodegaIncidentsFromReport(report),
    [report],
  )

  const supplierOptions = useMemo(
    () => buildBsaleSupplierFilterOptions(siiInvoices),
    [siiInvoices],
  )

  const financialSummary = useMemo(
    () => summarizeFinancialInboxGroups(siiInvoices, financialByKey),
    [siiInvoices, financialByKey],
  )

  const paginated = useMemo(
    () =>
      filterAndPaginateBsaleInvoices(siiInvoices, {
        searchQuery,
        supplierRut,
        folioQuery,
        dateFrom,
        dateTo,
        financialPrimaryFilter,
        reconciliationFilter,
        sortColumn,
        sortDirection,
        page,
        pageSize,
        financialByKey,
      }),
    [
      siiInvoices,
      searchQuery,
      supplierRut,
      folioQuery,
      dateFrom,
      dateTo,
      financialPrimaryFilter,
      reconciliationFilter,
      sortColumn,
      sortDirection,
      page,
      pageSize,
      financialByKey,
    ],
  )

  const activeEntry = useMemo<ReconciledInvoiceEntry | null>(() => {
    if (!activeDetailKey) return null
    return (
      report.entries.find(e => e.reconciliationKey === activeDetailKey) ?? null
    )
  }, [activeDetailKey, report.entries])

  const totalTableWidth = useMemo(
    () =>
      CXP_BSALE_COLUMNS.reduce(
        (acc, col) => acc + (widths[col.id] ?? col.defaultWidth),
        0,
      ),
    [widths],
  )

  const hasActiveFilters =
    searchQuery.trim() !== '' ||
    supplierRut !== 'ALL' ||
    folioQuery.trim() !== '' ||
    dateFrom !== '' ||
    dateTo !== '' ||
    financialPrimaryFilter !== 'TO_PAY' ||
    reconciliationFilter !== 'ALL'

  const resetFilters = useCallback(() => {
    setSearchQuery('')
    setSupplierRut('ALL')
    setFolioQuery('')
    setDateFrom('')
    setDateTo('')
    setFinancialPrimaryFilter('TO_PAY')
    setReconciliationFilter('ALL')
    setPage(1)
  }, [])

  const handleSortColumn = useCallback(
    (colId: BsaleInvoiceSortColumn) => {
      if (sortColumn === colId) {
        setSortDirection(prev => (prev === 'desc' ? 'asc' : 'desc'))
      } else {
        setSortColumn(colId)
        setSortDirection(colId === 'supplier' ? 'asc' : 'desc')
      }
      setPage(1)
    },
    [sortColumn],
  )

  function renderSortableHeader(
    colId: BsaleInvoiceSortColumn,
    label: string,
    options?: { align?: 'left' | 'right' | 'center' },
  ) {
    const column = COLUMN_BY_ID[colId]
    const align = options?.align ?? 'left'
    const active = sortColumn === colId
    return (
      <th
        style={{ width: `${widths[colId] ?? column.defaultWidth}px` }}
        className={cn(
          'relative select-none px-2.5 py-2 whitespace-nowrap',
          align === 'right' && 'text-right',
          align === 'center' && 'text-center',
        )}
      >
        <button
          type="button"
          onClick={() => handleSortColumn(colId)}
          className={cn(
            'group inline-flex max-w-full items-center gap-1 font-semibold uppercase tracking-wide transition-colors hover:text-theme-text',
            align === 'right' && 'ml-auto justify-end',
            active && 'text-theme-accent',
          )}
          title={`Ordenar por ${label}`}
        >
          <span className="truncate">{label}</span>
          <OperationalTableSortIndicator
            active={active}
            direction={active ? sortDirection : undefined}
          />
        </button>
        <OperationalTableResizeHandle
          column={column}
          width={widths[colId] ?? column.defaultWidth}
          onResize={nextWidth => setColumnWidth(column, nextWidth)}
          onResizeEnd={persistWidths}
        />
      </th>
    )
  }

  const { counts } = report

  return (
    <div className="flex w-full flex-col gap-2.5 md:h-[calc(100vh-7.5rem)]">
      {/* Cabecera compacta enfocada en obligaciones financieras */}
      <header className="shrink-0 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <h1 className="text-[16px] font-bold tracking-tight text-theme-text">
            Cuentas por Pagar
          </h1>
          <span className="inline-flex items-center rounded-md border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-700 dark:text-sky-300">
            Caylo · Obligaciones y Conciliación
          </span>
          <span className="text-[11px] text-theme-text-muted">
            {financialSummary.totalInvoices} facturas SII 33/34 ({counts.deferredBsaleNotesTotal} notas 61/56 fuera de deuda)
          </span>
        </div>
      </header>

      {/* TRES INDICADORES PRINCIPALES: POR PAGAR SEGÚN EXCEL | PAGADAS SEGÚN EXCEL | SIN CLASIFICAR */}
      <div className="shrink-0 grid grid-cols-1 gap-2 md:grid-cols-3">
        <button
          type="button"
          onClick={() => {
            setFinancialPrimaryFilter('TO_PAY')
            setPage(1)
          }}
          className={cn(
            'flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2 text-left transition-colors',
            financialPrimaryFilter === 'TO_PAY'
              ? 'border-amber-500 bg-amber-500/15'
              : 'border-theme-border bg-theme-surface hover:bg-theme-surface-hover',
          )}
          title="Saldo pendiente de las 70 facturas según columna K del Excel (descontando notas de crédito). No equivale automáticamente a deuda validada en el ERP."
        >
          <div className="min-w-0">
            <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
              <Clock className="h-3 w-3 shrink-0" />
              <span>Por pagar según Excel</span>
            </p>
            <p className="mt-0.5 truncate text-[11px] text-theme-text-muted">
              {financialSummary.historicalExcelPendingCount} facturas ·{' '}
              {financialSummary.confirmedDebtCount > 0
                ? `${financialSummary.confirmedDebtCount} validada(s) ERP (${formatClp(financialSummary.confirmedDebtTotalClp)})`
                : 'Saldo col. K (sin validar ERP)'}
            </p>
          </div>
          <span className="shrink-0 text-lg font-bold tabular-nums text-amber-700 dark:text-amber-300">
            {formatClp(
              financialSummary.historicalExcelPendingTotalClp +
                financialSummary.confirmedDebtTotalClp,
            )}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setFinancialPrimaryFilter('PAID')
            setPage(1)
          }}
          className={cn(
            'flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2 text-left transition-colors',
            financialPrimaryFilter === 'PAID'
              ? 'border-emerald-500 bg-emerald-500/15'
              : 'border-theme-border bg-theme-surface hover:bg-theme-surface-hover',
          )}
          title="700 facturas pagadas según Excel (saldo $0; declaración histórica, no necesariamente egreso bancario comprobado)."
        >
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
              Pagadas según Excel
            </p>
            <p className="mt-0.5 truncate text-[11px] text-theme-text-muted">
              Saldo $0 · {financialCounts?.historicalExcelInformedDateCount ?? 0} inf. ·{' '}
              {financialCounts?.historicalExcelAssumedDateCount ?? 0} asum.
            </p>
          </div>
          <span className="shrink-0 text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
            {financialSummary.paidCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setFinancialPrimaryFilter('UNCLASSIFIED')
            setPage(1)
          }}
          className={cn(
            'flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2 text-left transition-colors',
            financialPrimaryFilter === 'UNCLASSIFIED'
              ? 'border-slate-500 bg-slate-500/15'
              : 'border-theme-border bg-theme-surface hover:bg-theme-surface-hover',
          )}
          title="Documentos Bsale sin clasificación equivalente en Excel. No deben presumirse impagos ni mostrarse como deuda confirmada."
        >
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
              Sin clasificar
            </p>
            <p className="mt-0.5 truncate text-[11px] text-theme-text-muted">
              Sin clasificación en Excel · No presuntos impagos
            </p>
          </div>
          <span className="shrink-0 text-lg font-bold tabular-nums text-theme-text">
            {financialSummary.unclassifiedCount}
          </span>
        </button>
      </div>

      {/* SECCIÓN SECUNDARIA COMPACTA: INDICADORES TÉCNICOS DE CONCILIACIÓN BSALE ↔ BODEGA */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-theme-border bg-slate-50/70 px-3 py-1.5 text-[11px] dark:bg-slate-900/40">
        <span className="font-bold uppercase tracking-wider text-[10px] text-theme-text-muted">
          Conciliación Bsale ↔ Bodega:
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setReconciliationFilter(prev =>
                prev === 'MONETARY_EXACT' ? 'ALL' : 'MONETARY_EXACT',
              )
              setPage(1)
            }}
            className={cn(
              'rounded border px-2 py-0.5 font-semibold transition-colors',
              reconciliationFilter === 'MONETARY_EXACT'
                ? 'border-emerald-500 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
                : 'border-theme-border bg-theme-surface text-theme-text-muted hover:text-theme-text',
            )}
          >
            Exactas $0 ({counts.monetaryExactMatchCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setReconciliationFilter(prev =>
                prev === 'MONETARY_DIFFERENCE' ? 'ALL' : 'MONETARY_DIFFERENCE',
              )
              setPage(1)
            }}
            className={cn(
              'rounded border px-2 py-0.5 font-semibold transition-colors',
              reconciliationFilter === 'MONETARY_DIFFERENCE'
                ? 'border-amber-500 bg-amber-500/15 text-amber-800 dark:text-amber-200'
                : 'border-theme-border bg-theme-surface text-theme-text-muted hover:text-theme-text',
            )}
          >
            Con diferencia ({counts.monetaryAmountDifferenceCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setReconciliationFilter(prev =>
                prev === 'RECEPTION_PARTIAL' ? 'ALL' : 'RECEPTION_PARTIAL',
              )
              setPage(1)
            }}
            className={cn(
              'rounded border px-2 py-0.5 font-semibold transition-colors',
              reconciliationFilter === 'RECEPTION_PARTIAL'
                ? 'border-amber-500 bg-amber-500/15 text-amber-800 dark:text-amber-200'
                : 'border-theme-border bg-theme-surface text-theme-text-muted hover:text-theme-text',
            )}
          >
            Recep. parcial ({counts.receptionPartialCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setReconciliationFilter(prev =>
                prev === 'NO_RECEIPT_OPERATIONAL'
                  ? 'ALL'
                  : 'NO_RECEIPT_OPERATIONAL',
              )
              setPage(1)
            }}
            className={cn(
              'rounded border px-2 py-0.5 font-semibold transition-colors',
              reconciliationFilter === 'NO_RECEIPT_OPERATIONAL'
                ? 'border-sky-500 bg-sky-500/15 text-sky-800 dark:text-sky-200'
                : 'border-theme-border bg-theme-surface text-theme-text-muted hover:text-theme-text',
            )}
          >
            Sin recep. op. ({counts.bsaleInvoicesWithoutReceiptOperationalCount})
          </button>
          <button
            type="button"
            onClick={() => {
              setReconciliationFilter(prev =>
                prev === 'NO_RECEIPT_HISTORICAL'
                  ? 'ALL'
                  : 'NO_RECEIPT_HISTORICAL',
              )
              setPage(1)
            }}
            className={cn(
              'rounded border px-2 py-0.5 font-semibold transition-colors',
              reconciliationFilter === 'NO_RECEIPT_HISTORICAL'
                ? 'border-slate-500 bg-slate-500/15 text-theme-text'
                : 'border-theme-border bg-theme-surface text-theme-text-muted hover:text-theme-text',
            )}
          >
            Históricas pre-Bodega ({counts.bsaleInvoicesWithoutReceiptHistoricalCount})
          </button>
        </div>
      </div>

      {/* SECCIÓN SEPARADA DE INCIDENCIAS DE BODEGA (2 FA sin SII + 1 GD 147) */}
      {bodegaIncidents.length > 0 && (
        <section
          aria-label="Incidencias de recepciones de Bodega sin documento SII vinculado"
          className="shrink-0 rounded-xl border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 shadow-2xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-amber-900 dark:text-amber-200">
                Incidencias de Bodega sin factura SII vinculada (
                {bodegaIncidents.length})
              </h2>
              <span className="text-[11px] text-amber-800/85 dark:text-amber-300/85">
                {counts.receiptsWithoutBsaleInvoiceCount} recepciones FA sin documento en Bsale y{' '}
                {counts.gdReceiptsWithoutLinkedInvoiceCount} recepción con Guía de Despacho (GD 147)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowIncidentsSection(prev => !prev)}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-theme-surface px-2 py-0.5 text-[10.5px] font-semibold text-theme-text hover:bg-theme-surface-hover"
            >
              <span>{showIncidentsSection ? 'Ocultar' : 'Mostrar'}</span>
              {showIncidentsSection ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          </div>

          {showIncidentsSection && (
            <div className="mt-2 grid grid-cols-1 gap-1.5 md:grid-cols-3">
              {bodegaIncidents.map(incident => {
                const isGd =
                  incident.category === 'GD_RECEIPT_WITHOUT_LINKED_INVOICE'
                const docLabel = `${incident.bodegaDocumentType ?? 'DOC'} ${incident.documentFolio ?? 'S/F'}`
                const docDate = incident.dates.receiptDocumentDates[0] ?? null
                return (
                  <div
                    key={incident.reconciliationKey}
                    onDoubleClick={() =>
                      setActiveDetailKey(incident.reconciliationKey)
                    }
                    onClick={() =>
                      setActiveDetailKey(incident.reconciliationKey)
                    }
                    className="group flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-theme-surface px-2.5 py-1.5 text-xs transition-colors hover:border-amber-500/50 hover:bg-theme-surface-hover"
                    title="Doble clic o clic para abrir detalle de la incidencia de Bodega"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-bold text-theme-text">
                          {docLabel}
                        </span>
                        <span
                          className={cn(
                            'inline-flex items-center rounded border px-1.5 py-0.2 text-[9.5px] font-bold uppercase tracking-wider',
                            isGd
                              ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                              : 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
                          )}
                        >
                          {isGd
                            ? 'Guía sin factura SII'
                            : 'FA Bodega sin par SII'}
                        </span>
                        <span className="font-mono text-[10.5px] text-theme-text-muted">
                          {incident.purchaseOrderCorrelatives.join(', ')}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] font-semibold text-theme-text">
                        {incident.bodegaSupplierName ?? 'Proveedor Bodega'}
                        {incident.issuerRutNormalized && (
                          <span className="ml-1.5 font-mono text-[10.5px] font-normal text-theme-text-muted">
                            {formatRut(incident.issuerRutNormalized)}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-bold tabular-nums text-theme-text">
                        {formatClp(incident.monetary.receivedGrossAmountClp)}
                      </p>
                      <p className="text-[10px] tabular-nums text-theme-text-muted">
                        {formatCivilDate(docDate)}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* TABLA PRINCIPAL: 777 FACTURAS SII 33/34 */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-xs">
        {/* Barra de filtros financieros principales + búsqueda, proveedor, folio y fechas */}
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-theme-border px-3.5 py-2">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <div
              role="group"
              aria-label="Filtro financiero principal"
              className="inline-flex items-center rounded-lg border border-theme-border bg-theme-bg p-0.5"
            >
              <button
                type="button"
                onClick={() => {
                  setFinancialPrimaryFilter('TO_PAY')
                  setPage(1)
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors',
                  financialPrimaryFilter === 'TO_PAY'
                    ? 'bg-amber-500 text-white shadow-2xs'
                    : 'text-theme-text-muted hover:text-theme-text',
                )}
              >
                Por pagar (
                {financialSummary.historicalExcelPendingCount +
                  financialSummary.confirmedDebtCount}
                )
              </button>
              <button
                type="button"
                onClick={() => {
                  setFinancialPrimaryFilter('PAID')
                  setPage(1)
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors',
                  financialPrimaryFilter === 'PAID'
                    ? 'bg-emerald-600 text-white shadow-2xs'
                    : 'text-theme-text-muted hover:text-theme-text',
                )}
              >
                Pagadas ({financialSummary.paidCount})
              </button>
              <button
                type="button"
                onClick={() => {
                  setFinancialPrimaryFilter('UNCLASSIFIED')
                  setPage(1)
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors',
                  financialPrimaryFilter === 'UNCLASSIFIED'
                    ? 'bg-slate-600 text-white shadow-2xs'
                    : 'text-theme-text-muted hover:text-theme-text',
                )}
              >
                Sin clasificar ({financialSummary.unclassifiedCount})
              </button>
              <button
                type="button"
                onClick={() => {
                  setFinancialPrimaryFilter('ALL')
                  setPage(1)
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors',
                  financialPrimaryFilter === 'ALL'
                    ? 'bg-slate-900 text-white shadow-2xs dark:bg-sky-600'
                    : 'text-theme-text-muted hover:text-theme-text',
                )}
              >
                Todas ({financialSummary.totalInvoices})
              </button>
            </div>
            <span className="inline-flex items-center rounded-md bg-theme-bg px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-theme-text-muted">
              {paginated.totalItems} visibles
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 w-full xl:w-auto">
            {/* Búsqueda general */}
            <label className="relative flex-1 sm:flex-none sm:w-52">
              <span className="sr-only">
                Buscar proveedor, RUT, folio u OC
              </span>
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-theme-text-muted" />
              <input
                value={searchQuery}
                onChange={e => {
                  setSearchQuery(e.target.value)
                  setPage(1)
                }}
                placeholder="Buscar proveedor, RUT u OC…"
                className={cn(erpInputClass, 'h-7 w-full pl-8 pr-2 text-xs')}
              />
            </label>

            {/* Filtro por Proveedor */}
            <label className="sm:w-52">
              <span className="sr-only">Filtrar por proveedor</span>
              <select
                value={supplierRut}
                onChange={e => {
                  setSupplierRut(e.target.value)
                  setPage(1)
                }}
                className={cn(erpSelectClass, 'h-7 w-full px-2 text-xs')}
                aria-label="Filtrar por proveedor"
              >
                <option value="ALL">
                  Todos los proveedores ({supplierOptions.length})
                </option>
                {supplierOptions.map(sup => (
                  <option key={sup.rutNormalized} value={sup.rutNormalized}>
                    {sup.supplierName} ({sup.invoiceCount})
                  </option>
                ))}
              </select>
            </label>

            {/* Filtro específico por Folio */}
            <label className="w-28">
              <span className="sr-only">Filtrar por folio</span>
              <input
                value={folioQuery}
                onChange={e => {
                  setFolioQuery(e.target.value)
                  setPage(1)
                }}
                placeholder="Folio (ej. 163496)"
                aria-label="Filtrar por folio"
                className={cn(erpInputClass, 'h-7 w-full px-2 font-mono text-xs')}
              />
            </label>

            {/* Filtro de fecha desde / hasta */}
            <label className="inline-flex items-center gap-1">
              <span className="text-[10.5px] font-medium text-theme-text-muted">
                Desde
              </span>
              <input
                type="date"
                value={dateFrom}
                onChange={e => {
                  setDateFrom(e.target.value)
                  setPage(1)
                }}
                aria-label="Fecha de emisión desde"
                className={cn(erpInputClass, 'h-7 w-[124px] px-1.5 text-xs')}
              />
            </label>

            <label className="inline-flex items-center gap-1">
              <span className="text-[10.5px] font-medium text-theme-text-muted">
                Hasta
              </span>
              <input
                type="date"
                value={dateTo}
                onChange={e => {
                  setDateTo(e.target.value)
                  setPage(1)
                }}
                aria-label="Fecha de emisión hasta"
                className={cn(erpInputClass, 'h-7 w-[124px] px-1.5 text-xs')}
              />
            </label>

            {/* Filtro por Estado de Conciliación */}
            <label>
              <span className="sr-only">Filtrar por estado de conciliación</span>
              <select
                value={reconciliationFilter}
                onChange={e => {
                  setReconciliationFilter(
                    e.target.value as BsaleReconciliationFilterValue,
                  )
                  setPage(1)
                }}
                aria-label="Filtrar por estado de conciliación"
                className={cn(erpSelectClass, 'h-7 px-2 text-xs')}
              >
                <option value="ALL">
                  Todos los estados ({counts.totalBsaleInvoices})
                </option>
                <option value="MATCHED_ALL">
                  Conciliadas con Bodega ({counts.matchedInvoicesCount})
                </option>
                <option value="MONETARY_EXACT">
                  ↳ Coincidencia exacta $0 ({counts.monetaryExactMatchCount})
                </option>
                <option value="MONETARY_DIFFERENCE">
                  ↳ Con diferencia de monto ({counts.monetaryAmountDifferenceCount})
                </option>
                <option value="RECEPTION_COMPLETE">
                  ↳ Recepción completa ({counts.byCategory.MATCHED_COMPLETE_EXACT + counts.byCategory.MATCHED_COMPLETE_DIFFERENCE})
                </option>
                <option value="RECEPTION_PARTIAL">
                  ↳ Recepción parcial ({counts.receptionPartialCount})
                </option>
                <option value="NO_RECEIPT_OPERATIONAL">
                  Sin recepción · Período operativo ({counts.bsaleInvoicesWithoutReceiptOperationalCount})
                </option>
                <option value="NO_RECEIPT_HISTORICAL">
                  Sin recepción · Históricas pre-Bodega ({counts.bsaleInvoicesWithoutReceiptHistoricalCount})
                </option>
                {financialCounts && financialCounts.historicalExcelPaidCount > 0 && (
                  <option value="HISTORICAL_EXCEL_PAID">
                    Pagada históricamente · Excel ({financialCounts.historicalExcelPaidCount})
                  </option>
                )}
              </select>
            </label>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                title="Limpiar filtros aplicados"
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-[11px] font-semibold text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text"
              >
                <FilterX className="h-3.5 w-3.5" />
                <span>Limpiar</span>
              </button>
            )}

            <button
              type="button"
              onClick={resetWidths}
              title="Restablecer anchos de columnas"
              aria-label="Restablecer anchos de columnas"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-surface-hover hover:text-theme-text"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Cuerpo de tabla con desplazamiento interno */}
        <div className="max-h-[68vh] flex-1 min-h-0 overflow-auto md:max-h-none">
          <table
            style={{ width: `${totalTableWidth}px`, minWidth: '100%' }}
            className="table-fixed border-separate border-spacing-0 text-left"
          >
            <colgroup>
              {CXP_BSALE_COLUMNS.map(col => (
                <col
                  key={col.id}
                  style={{ width: `${widths[col.id] ?? col.defaultWidth}px` }}
                />
              ))}
            </colgroup>
            <thead className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-theme-text-muted [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:border-b [&_th]:border-theme-border [&_th]:bg-slate-50 dark:[&_th]:bg-theme-surface">
              <tr>
                {renderSortableHeader('emissionDate', 'Emisión')}
                {renderSortableHeader('supplier', 'Proveedor')}
                {renderSortableHeader('folio', 'Folio')}
                {renderSortableHeader('financialStatus', 'Estado financiero / Saldo')}
                {renderSortableHeader('dueDate', 'Vencimiento')}
                {renderSortableHeader('siiAmount', 'Monto SII', {
                  align: 'right',
                })}
                {renderSortableHeader(
                  'receivedAmount',
                  'Monto Recibido Bodega',
                  { align: 'right' },
                )}
                {renderSortableHeader('difference', 'Diferencia', {
                  align: 'right',
                })}
                {renderSortableHeader(
                  'monetaryStatus',
                  'Estado Conciliación',
                )}
                {renderSortableHeader('receptionStatus', 'Estado Recepción')}
              </tr>
            </thead>
            <tbody className="text-xs [&_td]:border-b [&_td]:border-theme-border [&_tr:last-child_td]:border-b-0">
              {paginated.items.length === 0 ? (
                <tr>
                  <td
                    colSpan={CXP_BSALE_COLUMNS.length}
                    className="px-4 py-8 text-center text-sm text-theme-text-muted"
                  >
                    No se encontraron facturas SII con los filtros seleccionados.
                  </td>
                </tr>
              ) : (
                paginated.items.map(entry => {
                  const financialOverlay =
                    financialByKey?.[entry.reconciliationKey]
                  const financialGroup =
                    resolveFinancialInboxGroup(financialOverlay)
                  const monetaryBadge = resolveMonetaryReconciliationBadge(entry)
                  const receptionBadge = resolvePhysicalReceptionBadge(entry)
                  const financialBadge =
                    resolveFinancialAccreditationBadge(financialOverlay)
                  const dueDateInfo = financialOverlay?.dueDateInfo
                  const supplierName =
                    entry.bodegaSupplierName ||
                    entry.bsaleSupplierName ||
                    'Proveedor sin nombre'
                  const isActiveRow =
                    activeDetailKey === entry.reconciliationKey

                  return (
                    <tr
                      key={entry.reconciliationKey}
                      onDoubleClick={event => {
                        const target = event.target as HTMLElement
                        if (target.closest('button, a, input')) return
                        setActiveDetailKey(entry.reconciliationKey)
                      }}
                      className={cn(
                        'h-11 cursor-pointer transition-colors hover:bg-theme-surface-hover/80',
                        entry.isHistoricalPreErpReceipts && 'opacity-85',
                        isActiveRow && 'bg-sky-500/[0.08]',
                      )}
                      title="Doble clic para abrir el panel lateral de conciliación y respaldos"
                    >
                      {/* 1. Fecha de emisión */}
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        <div className="flex items-center gap-1 font-medium tabular-nums text-theme-text">
                          <CalendarDays className="h-3 w-3 shrink-0 text-theme-text-muted" />
                          <span>
                            {formatCivilDate(entry.dates.siiEmissionDate)}
                          </span>
                        </div>
                        {entry.dates.hasDocumentDateMismatch &&
                          entry.receiptCount > 0 && (
                            <span
                              className="mt-0.5 block truncate text-[10px] font-medium text-amber-600 dark:text-amber-400"
                              title={`Fecha documento digitada en Bodega: ${entry.dates.receiptDocumentDates.join(', ')}`}
                            >
                              Doc. Bodega:{' '}
                              {formatCivilDate(
                                entry.dates.receiptDocumentDates[0],
                              )}
                            </span>
                          )}
                      </td>

                      {/* 2. Proveedor (tamaño destacado) */}
                      <td className="px-2.5 py-1.5">
                        <p
                          className="truncate text-[13.5px] font-bold leading-snug text-theme-text"
                          title={supplierName}
                        >
                          {supplierName}
                        </p>
                        <div className="flex items-center gap-1.5 text-[11px] text-theme-text-muted">
                          <span className="font-mono">
                            {formatRut(entry.issuerRutNormalized)}
                          </span>
                          {(entry.hasBsalePdf || entry.hasBodegaAttachment) && (
                            <span
                              className="inline-flex items-center gap-0.5 rounded bg-theme-bg px-1 py-0.2 text-[9.5px] font-semibold text-theme-text-muted"
                              title={
                                entry.hasBsalePdf && entry.hasBodegaAttachment
                                  ? 'PDF disponible en Bsale y Bodega'
                                  : entry.hasBsalePdf
                                    ? 'PDF disponible en Bsale'
                                    : 'PDF disponible en Bodega'
                              }
                            >
                              <FileText className="h-2.5 w-2.5 text-theme-accent" />
                              {entry.hasBsalePdf && entry.hasBodegaAttachment
                                ? 'Bsale+Bodega'
                                : entry.hasBsalePdf
                                  ? 'PDF Bsale'
                                  : 'PDF Bodega'}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 3. Folio (tamaño destacado + tipo SII 33/34) */}
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[13.5px] font-bold tabular-nums text-theme-text">
                            FA {entry.documentFolio}
                          </span>
                          <span
                            className={cn(
                              'inline-flex items-center rounded border px-1 py-0.2 text-[9.5px] font-bold uppercase',
                              entry.codeSii === '34'
                                ? 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300'
                                : 'border-theme-border bg-theme-bg text-theme-text-muted',
                            )}
                            title={
                              entry.codeSii === '34'
                                ? 'Factura Exenta Electrónica (SII 34)'
                                : 'Factura Electrónica Afecta (SII 33)'
                            }
                          >
                            {entry.codeSii}
                          </span>
                        </div>
                        {entry.hasCrossSupplierFolioCollision && (
                          <span
                            className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                            title="Folio repetido en otro proveedor; desambiguado por RUT"
                          >
                            <AlertTriangle className="h-2.5 w-2.5" />
                            Folio compartido
                          </span>
                        )}
                      </td>

                      {/* 4. Estado financiero / Saldo pendiente confirmado (priorizado) */}
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-md border px-2 py-0.5 text-[10.5px] font-bold',
                            badgeToneClasses(financialBadge.tone),
                          )}
                        >
                          {financialBadge.label}
                        </span>
                        {financialBadge.detail && (
                          <span
                            className="mt-0.5 block truncate text-[10px] text-theme-text-muted"
                            title={financialBadge.detail}
                          >
                            {financialBadge.detail}
                          </span>
                        )}
                      </td>

                      {/* 5. Vencimiento: solo como obligación pendiente cuando existe deuda validada */}
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        {financialGroup === 'CONFIRMED_DEBT' &&
                        dueDateInfo?.dueDate ? (
                          <div>
                            <span className="font-bold tabular-nums text-sky-700 dark:text-sky-300">
                              {formatCivilDate(dueDateInfo.dueDate)}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                              Obligación confirmada
                            </span>
                          </div>
                        ) : financialGroup === 'PAID' ? (
                          <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                            Sin obligación ($0)
                          </span>
                        ) : financialGroup === 'TO_PAY_EXCEL' ? (
                          <span
                            className="text-[11px] font-medium text-theme-text-muted"
                            title="El Excel no informa vencimiento para estas facturas (columna G vacía; no se usa columna H)."
                          >
                            Por confirmar
                          </span>
                        ) : (
                          <div>
                            <span className="text-[11px] font-medium text-theme-text-muted">
                              Sin acreditar
                            </span>
                            {dueDateInfo?.dueDate && (
                              <span
                                className="mt-0.5 block truncate text-[9.5px] text-theme-text-muted/80"
                                title={`Estimación referencial (${dueDateInfo.sourceLabel}): no constituye cuenta por pagar confirmada`}
                              >
                                Ref. {formatCivilDate(dueDateInfo.dueDate)}
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      {/* 4. Monto SII */}
                      <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
                        <span className="font-bold tabular-nums text-theme-text">
                          {formatClp(entry.monetary.siiTotalAmountClp)}
                        </span>
                        {entry.monetary.siiSpecificTaxAmount !== null &&
                          entry.monetary.siiSpecificTaxAmount > 0 && (
                            <span
                              className="block text-[10px] tabular-nums text-theme-text-muted"
                              title={`Incluye impuesto específico por ${formatClp(entry.monetary.siiSpecificTaxAmount)}`}
                            >
                              +Imp. esp.{' '}
                              {formatClp(entry.monetary.siiSpecificTaxAmount)}
                            </span>
                          )}
                      </td>

                      {/* 5. Monto recibido de Bodega */}
                      <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
                        {entry.monetary.receivedGrossAmountClp !== null ? (
                          <div>
                            <span className="font-bold tabular-nums text-theme-text">
                              {formatClp(entry.monetary.receivedGrossAmountClp)}
                            </span>
                            {entry.receiptCount > 1 && (
                              <span className="block text-[10px] font-medium text-sky-700 dark:text-sky-300">
                                {entry.receiptCount} recep. ·{' '}
                                {entry.purchaseOrderCount} OC
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-theme-text-muted">—</span>
                        )}
                      </td>

                      {/* 6. Diferencia */}
                      <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
                        {entry.monetary.differenceClp !== null ? (
                          <div>
                            <span
                              className={cn(
                                'font-bold tabular-nums',
                                entry.monetary.differenceClp === 0
                                  ? 'text-emerald-700 dark:text-emerald-300'
                                  : 'text-amber-700 dark:text-amber-300',
                              )}
                            >
                              {formatSignedClpDifference(
                                entry.monetary.differenceClp,
                              )}
                            </span>
                            {entry.monetary.hasSubPesoRoundingOnly && (
                              <span className="block text-[9.5px] text-theme-text-muted">
                                Redondeo CLP
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-theme-text-muted">—</span>
                        )}
                      </td>

                      {/* 7. Estado de conciliación (Monetario / Documental) */}
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-md border px-2 py-0.5 text-[10.5px] font-bold',
                            badgeToneClasses(monetaryBadge.tone),
                          )}
                        >
                          {monetaryBadge.label}
                        </span>
                        {monetaryBadge.detail && (
                          <span className="mt-0.5 block truncate text-[10px] text-theme-text-muted">
                            {monetaryBadge.detail}
                          </span>
                        )}
                      </td>

                      {/* 10. Estado de recepción (Físico en Bodega) */}
                      <td className="px-2.5 py-1.5 whitespace-nowrap">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10.5px] font-bold',
                            badgeToneClasses(receptionBadge.tone),
                          )}
                        >
                          {entry.receptionStatus === 'COMPLETE' && (
                            <PackageCheck className="h-3 w-3 shrink-0" />
                          )}
                          <span>{receptionBadge.label}</span>
                        </span>
                        {receptionBadge.detail && (
                          <span
                            className="mt-0.5 block truncate font-mono text-[10px] text-theme-text-muted"
                            title={receptionBadge.detail}
                          >
                            {receptionBadge.detail}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pie de tabla con paginación y recordatorio de doble clic */}
        <footer className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-t border-theme-border bg-slate-50/70 px-3.5 py-2 text-xs text-theme-text-muted dark:bg-slate-900/40">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              Mostrando{' '}
              <strong className="font-semibold tabular-nums text-theme-text">
                {paginated.startIndex}–{paginated.endIndex}
              </strong>{' '}
              de{' '}
              <strong className="font-semibold tabular-nums text-theme-text">
                {paginated.totalItems}
              </strong>{' '}
              facturas SII
            </span>
            <span className="hidden md:inline text-theme-border">|</span>
            <span className="hidden md:inline text-[11px]">
              Doble clic en cualquier fila para abrir el panel lateral de conciliación y PDF.
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="inline-flex items-center gap-1 text-[11px]">
              <span>Filas:</span>
              <select
                value={pageSize}
                onChange={e => {
                  setPageSize(Number(e.target.value))
                  setPage(1)
                }}
                aria-label="Cantidad de filas por página"
                className={cn(erpSelectClass, 'h-6 px-1.5 text-[11px]')}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>

            <button
              type="button"
              disabled={paginated.currentPage <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="inline-flex h-6 items-center gap-0.5 rounded border border-theme-border bg-theme-surface px-2 text-[11px] font-semibold text-theme-text transition-colors hover:bg-theme-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Anterior</span>
            </button>

            <span className="px-1.5 text-[11px] font-semibold tabular-nums text-theme-text">
              Pág. {paginated.currentPage} / {paginated.totalPages}
            </span>

            <button
              type="button"
              disabled={paginated.currentPage >= paginated.totalPages}
              onClick={() =>
                setPage(p => Math.min(paginated.totalPages, p + 1))
              }
              className="inline-flex h-6 items-center gap-0.5 rounded border border-theme-border bg-theme-surface px-2 text-[11px] font-semibold text-theme-text transition-colors hover:bg-theme-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              <span>Siguiente</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </footer>
      </section>

      <BsaleReconciliationDetailPanel
        entry={activeEntry}
        financial={
          activeEntry ? (financialByKey?.[activeEntry.reconciliationKey] ?? null) : null
        }
        onClose={() => setActiveDetailKey(null)}
      />
    </div>
  )
}
