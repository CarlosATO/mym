'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CalendarDays, CheckCircle2, FileText, RotateCcw, Search, ShieldCheck } from 'lucide-react'
import { getCxpInboxDocuments, getCxpInboxDocumentSignedUrl, incorporateReceiptInvoices, setInvoiceDueDate } from '@/app/actions/cuentas-por-pagar'
import { PurchaseOrderInvoiceViewerModal } from '@/modules/adquisiciones/ordenes-compra/purchase-order-invoice-viewer-modal'
import {
  OperationalTableResizeHandle,
  OperationalTableSortIndicator,
  sortOperationalRows,
  useOperationalTableSort,
  useOperationalTableWidths,
  type OperationalTableColumn,
} from '@/components/ui/operational-table'
import { formatCivilDate } from '@/lib/datetime'
import { erpInputClass, erpSelectClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'
import { InvoiceValidationDrawer } from './invoice-validation-drawer'
import { InvoiceDueDateEditor } from './invoice-due-date-editor'
import { resolveInboxDueDate, saveOptimisticDueDate, type InboxDueOverride, type ReceiptDueDate } from './inbox-due-date'
import type {
  InvoiceInboxSummary,
  InboxDocument,
  ReceiptInvoiceCandidate,
  SaveInvoiceValidationResult,
} from './types'
import { formatClp, formatRut } from './validation-rules'
import { purchaseTypeLabel, receptionStatusLabel } from './classification'

const TABLE_PREFS_KEY = 'mym:cxp-invoice-inbox:table-v2'

const CXP_COLUMNS: OperationalTableColumn[] = [
  { id: 'select', defaultWidth: 42, minWidth: 38, maxWidth: 64, resizable: false, sortable: true, sortKey: 'selected', sortType: 'number' },
  { id: 'supplier', defaultWidth: 195, minWidth: 130, maxWidth: 400, sortable: true, sortKey: 'supplier', sortType: 'text' },
  { id: 'purchaseType', defaultWidth: 86, minWidth: 74, maxWidth: 130, sortable: true, sortKey: 'purchaseType', sortType: 'text' },
  { id: 'folio', defaultWidth: 88, minWidth: 72, maxWidth: 145, sortable: true, sortKey: 'folio', sortType: 'number' },
  { id: 'issueDate', defaultWidth: 88, minWidth: 80, maxWidth: 130, sortable: true, sortKey: 'issueDate', sortType: 'date' },
  { id: 'dueDate', defaultWidth: 120, minWidth: 105, maxWidth: 160, sortable: true, sortKey: 'dueDate', sortType: 'date' },
  { id: 'po', defaultWidth: 120, minWidth: 92, maxWidth: 230, sortable: true, sortKey: 'po', sortType: 'text' },
  { id: 'receptionStatus', defaultWidth: 92, minWidth: 78, maxWidth: 140, sortable: true, sortKey: 'receptionStatus', sortType: 'text' },
  { id: 'referenceAmount', defaultWidth: 106, minWidth: 90, maxWidth: 170, sortable: true, sortKey: 'referenceAmount', sortType: 'number' },
  { id: 'realAmount', defaultWidth: 108, minWidth: 90, maxWidth: 180, sortable: true, sortKey: 'realAmount', sortType: 'number' },
  { id: 'document', defaultWidth: 88, minWidth: 72, maxWidth: 145, sortable: true, sortKey: 'document', sortType: 'number' },
  { id: 'status', defaultWidth: 112, minWidth: 92, maxWidth: 200, sortable: true, sortKey: 'status', sortType: 'text' },
  { id: 'action', defaultWidth: 86, minWidth: 76, maxWidth: 125, resizable: false, sortable: false },
]

const COLUMN_BY_ID = Object.fromEntries(CXP_COLUMNS.map(col => [col.id, col])) as Record<
  string,
  OperationalTableColumn
>

type OptimisticEntry = {
  summary: InvoiceInboxSummary
  serverKey: string
}

function serverSummaryKey(summary: InvoiceInboxSummary | undefined): string {
  if (!summary) return 'NONE'
  return [
    summary.validation_status,
    summary.issue_date,
    summary.due_date ?? '',
    summary.total_amount ?? '',
    summary.prior_payment_status,
    summary.historical_initial_balance ?? '',
    summary.discrepancy_status,
    summary.validated_at ?? '',
  ].join('|')
}

function toSummaryFromResult(result: SaveInvoiceValidationResult): InvoiceInboxSummary {
  return {
    id: result.id,
    validation_status: result.validation_status,
    issue_date: result.issue_date,
    due_date: result.due_date,
    net_amount: result.net_amount,
    tax_amount: result.tax_amount,
    total_amount: result.total_amount,
    prior_payment_status: result.prior_payment_status,
    historical_initial_balance: result.historical_initial_balance,
    historical_balance_cutoff_date: result.historical_balance_cutoff_date,
    discrepancy_status: result.discrepancy_status,
    validated_at: result.validated_at,
  }
}

function statusSortLabel(state: string, effectiveStatus: string | null): string {
  if (state === 'NEW') return '1_Por incorporar'
  if (state === 'PENDING') return '2_Pendiente'
  if (state === 'VALIDATED') return '3_Validada'
  return `4_${effectiveStatus ?? ''}`
}

export function InvoiceInbox({
  initialCandidates,
  initialSummaries = [],
  documents,
  dueDates,
}: {
  initialCandidates: ReceiptInvoiceCandidate[]
  initialSummaries?: InvoiceInboxSummary[]
  documents: Record<string, boolean> | null
  dueDates: ReceiptDueDate[] | null
}) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('ALL')
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [activeInvoiceId, setActiveInvoiceId] = useState<string | null>(null)
  const [editingDueRow, setEditingDueRow] = useState<{ row: ReceiptInvoiceCandidate; date: string | null; baseKey: string; readOnlyReason: string | null } | null>(null)
  const [dueOverrides, setDueOverrides] = useState<Record<string, InboxDueOverride>>({})
  const [pendingDueDates, setPendingDueDates] = useState<Record<string, InboxDueOverride>>({})
  const dueDateLocks = useRef(new Set<string>())
  const [viewer, setViewer] = useState<{ row: ReceiptInvoiceCandidate; documents: InboxDocument[] } | null>(null)
  const [loadingDocument, setLoadingDocument] = useState(false)
  const loadInboxDocument = useCallback((documentId: string) => {
    if (!viewer) return Promise.resolve({ error: 'Seleccione una factura.' })
    return getCxpInboxDocumentSignedUrl(viewer.row.candidate_id, documentId)
  }, [viewer])

  async function openDocuments(row: ReceiptInvoiceCandidate) {
    setLoadingDocument(true)
    try {
      const result = await getCxpInboxDocuments(row.candidate_id)
      if ('error' in result) setMessage(result.error)
      else if (!result.documents.some(doc => doc.has_file)) setMessage('El respaldo ya no está disponible. Actualice la bandeja.')
      else setViewer({ row, documents: result.documents })
    } catch {
      setMessage('No se pudieron consultar los respaldos de la factura.')
    } finally {
      setLoadingDocument(false)
    }
  }
  const [optimisticById, setOptimisticById] = useState<Record<string, OptimisticEntry>>({})
  const [pending, startTransition] = useTransition()

  const { widths, setColumnWidth, persist: persistWidths, reset: resetWidths } = useOperationalTableWidths(
    TABLE_PREFS_KEY,
    CXP_COLUMNS,
  )
  const { sort, cycleSort } = useOperationalTableSort(TABLE_PREFS_KEY, CXP_COLUMNS)

  const serverSummaryById = useMemo(() => {
    const map = new Map<string, InvoiceInboxSummary>()
    for (const summary of initialSummaries) {
      map.set(summary.id, summary)
    }
    return map
  }, [initialSummaries])

  const summaryById = useMemo(() => {
    const map = new Map<string, InvoiceInboxSummary>(serverSummaryById)
    for (const [id, entry] of Object.entries(optimisticById)) {
      const server = serverSummaryById.get(id)
      if (serverSummaryKey(server) === entry.serverKey) {
        map.set(id, entry.summary)
      }
    }
    return map
  }, [serverSummaryById, optimisticById])

  const receiptDueById = useMemo(() => new Map((dueDates ?? []).map(item => [item.candidate_id, item])), [dueDates])

  // Mantener la confirmación local hasta observar el mismo resultado en las propiedades del servidor.
  useEffect(() => {
    const timer = window.setTimeout(() => setDueOverrides(current => {
      let next = current
      for (const row of initialCandidates) {
        const override = current[row.candidate_id]
        if (!override?.confirmed) continue
        const summary = row.invoice_id ? serverSummaryById.get(row.invoice_id) : undefined
        const receiptDue = row.purchase_type === 'SERVICES' ? undefined : receiptDueById.get(row.candidate_id)
        const server = resolveInboxDueDate(row, summary, receiptDue, undefined)
        if (server.date === override.date && server.source === override.source) {
          if (next === current) next = { ...current }
          delete next[row.candidate_id]
        }
      }
      return next
    }), 0)
    return () => window.clearTimeout(timer)
  }, [initialCandidates, serverSummaryById, receiptDueById, dueOverrides])

  const enrichedRows = useMemo(() => {
    return initialCandidates.map(row => {
      const summary = row.invoice_id ? summaryById.get(row.invoice_id) : undefined
      const serverSummary = row.invoice_id ? serverSummaryById.get(row.invoice_id) : undefined
      const receiptDue = row.purchase_type === 'SERVICES' ? undefined : receiptDueById.get(row.candidate_id)
      const effectiveDue = resolveInboxDueDate(row, serverSummary, receiptDue, pendingDueDates[row.candidate_id] ?? dueOverrides[row.candidate_id])
      const effectiveStatus = summary?.validation_status ?? row.invoice_status ?? null
      const state = !row.invoice_id
        ? 'NEW'
        : effectiveStatus === 'PENDING'
          ? 'PENDING'
          : effectiveStatus === 'VALIDATED'
            ? 'VALIDATED'
            : 'OTHER'

      return {
        row,
        summary,
        effectiveStatus,
        state,
        effectiveIssueDate: summary?.issue_date ?? row.issue_date,
        effectiveDueDate: effectiveDue.date,
        dueSource: effectiveDue.source,
        dueBaseKey: effectiveDue.baseKey,
      }
    })
  }, [initialCandidates, summaryById, serverSummaryById, receiptDueById, dueOverrides, pendingDueDates])

  const counts = useMemo(() => {
    let pendingValidation = 0
    let validated = 0
    let toIncorporate = 0
    for (const item of enrichedRows) {
      if (item.state === 'NEW') toIncorporate += 1
      else if (item.state === 'PENDING') pendingValidation += 1
      else if (item.state === 'VALIDATED') validated += 1
    }
    return {
      total: enrichedRows.length,
      toIncorporate,
      pendingValidation,
      validated,
    }
  }, [enrichedRows])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  const filteredRows = useMemo(() => {
    const q = search.toLocaleLowerCase('es-CL').trim()
    return enrichedRows.filter(item => {
      if (status !== 'ALL' && item.state !== status) return false
      if (!q) return true
      const { row } = item
      return [
        row.supplier_name,
        row.issuer_rut,
        row.folio,
        ...row.purchase_orders,
        row.service_description ?? '',
        purchaseTypeLabel(row.purchase_type),
        receptionStatusLabel(row.reception_status, row.purchase_type),
      ]
        .join(' ')
        .toLocaleLowerCase('es-CL')
        .includes(q)
    })
  }, [enrichedRows, search, status])

  const rows = useMemo(() => {
    return sortOperationalRows(filteredRows, sort, CXP_COLUMNS, (item, sortKey) => {
      switch (sortKey) {
        case 'selected':
          return selectedSet.has(item.row.candidate_id) ? 1 : 0
        case 'supplier':
          return item.row.supplier_name
        case 'purchaseType':
          return purchaseTypeLabel(item.row.purchase_type)
        case 'folio':
          return item.row.folio != null && /^\d+$/.test(item.row.folio) ? Number(item.row.folio) : null
        case 'issueDate':
          return item.effectiveIssueDate
        case 'dueDate':
          return item.effectiveDueDate
        case 'po':
          return item.row.purchase_orders.join(', ')
        case 'receptionStatus':
          return receptionStatusLabel(item.row.reception_status, item.row.purchase_type)
        case 'referenceAmount':
          return item.row.reference_amount != null ? Number(item.row.reference_amount) : null
        case 'realAmount':
          return item.summary?.total_amount != null ? Number(item.summary.total_amount) : null
        case 'document':
          return documents?.[item.row.candidate_id] ? 2 : documents && item.row.candidate_id in documents ? 1 : 0
        case 'status':
          return statusSortLabel(item.state, item.effectiveStatus)
        default:
          return null
      }
    })
  }, [filteredRows, sort, selectedSet, documents])

  const selectableVisibleIds = useMemo(
    () =>
      rows
        .filter(
          item =>
            item.row.purchase_type !== 'SERVICES' &&
            !item.row.blocked_reason &&
            item.effectiveStatus !== 'VALIDATED',
        )
        .map(item => item.row.candidate_id),
    [rows],
  )

  const allVisibleSelected =
    selectableVisibleIds.length > 0 && selectableVisibleIds.every(id => selectedSet.has(id))

  const totalTableWidth = useMemo(
    () => CXP_COLUMNS.reduce((acc, col) => acc + (widths[col.id] ?? col.defaultWidth), 0),
    [widths],
  )

  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      setSelected(current => current.filter(id => !selectableVisibleIds.includes(id)))
    } else {
      setSelected(current => Array.from(new Set([...current, ...selectableVisibleIds])))
    }
  }

  function submit() {
    setMessage('')
    startTransition(async () => {
      try {
        const result = await incorporateReceiptInvoices(selected)
        setSelected([])
        setMessage(`${result.count} factura(s) incorporada(s) o ya incorporada(s).`)
        router.refresh()
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'No fue posible incorporar las facturas.')
      }
    })
  }

  function handleValidationUpdated(result: SaveInvoiceValidationResult) {
    const currentRow = enrichedRows.find(item => item.row.invoice_id === result.id)
    if (currentRow) {
      setDueOverrides(prev => ({ ...prev, [currentRow.row.candidate_id]: { date: result.due_date, baseKey: currentRow.dueBaseKey } }))
    }
    const currentServer = serverSummaryById.get(result.id)
    setOptimisticById(prev => ({
      ...prev,
      [result.id]: {
        summary: toSummaryFromResult(result),
        serverKey: serverSummaryKey(currentServer),
      },
    }))
    router.refresh()
  }

  function saveDueDate(editing: NonNullable<typeof editingDueRow>, date: string | null) {
    const { row, baseKey } = editing
    const keys = [`candidate:${row.candidate_id}`, ...(row.invoice_id ? [`invoice:${row.invoice_id}`] : [])]
    void saveOptimisticDueDate({
      locks: dueDateLocks.current,
      keys,
      start: () => {
        setMessage('')
        setPendingDueDates(current => ({ ...current, [row.candidate_id]: { date, baseKey, confirmed: true, source: 'MANUAL' } }))
        setEditingDueRow(null)
      },
      request: async () => {
        const target = row.invoice_id ? { invoiceId: row.invoice_id } : { candidateId: row.candidate_id }
        const result = await setInvoiceDueDate({ ...target, dueDate: date })
        if (!result.ok) throw new Error(result.error)
        return result.data
      },
      success: result => {
        const source = row.purchase_type === 'SERVICES'
          ? (result.due_date ? 'SAVED' : null)
          : (result.invoice_id && result.due_date ? 'SAVED' : 'MANUAL')
        setDueOverrides(current => ({ ...current, [row.candidate_id]: { date: result.due_date, baseKey, confirmed: true, source } }))
      },
      failure: error => setMessage(error instanceof Error ? error.message : 'No se pudo guardar el vencimiento. Intente nuevamente.'),
      finish: () => setPendingDueDates(current => {
        const next = { ...current }
        delete next[row.candidate_id]
        return next
      }),
    })
  }

  function renderSortableHeader(
    colId: string,
    label: string,
    options?: { align?: 'left' | 'right' | 'center' },
  ) {
    const column = COLUMN_BY_ID[colId]
    const align = options?.align ?? 'left'
    const active = sort?.column === column.id
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
          onClick={() => cycleSort(column)}
          className={cn(
            'group inline-flex max-w-full items-center gap-1 font-semibold uppercase tracking-wide transition-colors hover:text-theme-text',
            align === 'right' && 'ml-auto justify-end',
            active && 'text-theme-accent',
          )}
          title={`Ordenar por ${label}`}
        >
          <span className="truncate">{label}</span>
          <OperationalTableSortIndicator active={active} direction={sort?.direction} />
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

  return (
    <div className="flex w-full flex-col gap-2.5 md:h-[calc(100vh-7.75rem)]">
      {/* Compact module title strip */}
      <header className="shrink-0 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <h1 className="text-[16px] font-bold tracking-tight text-theme-text">
            Cuentas por Pagar
          </h1>
          <span className="inline-flex items-center rounded-md border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-700 dark:text-sky-300">
            Facturas Proveedores · Caylo
          </span>
        </div>
        <p className="hidden sm:block text-[11px] text-theme-text-muted">
          Recepciones FA, incorporación documental y validación de obligaciones
        </p>
      </header>

      {/* Compact executive summary bar + horizontal KPI cards */}
      <div className="shrink-0 grid grid-cols-1 gap-2 lg:grid-cols-12">
        <div className="lg:col-span-6 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-900 px-3.5 py-2 text-white shadow-xs dark:border dark:border-theme-border dark:bg-slate-900/90">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
              Facturas Caylo
            </span>
            <span className="hidden sm:inline text-slate-600">|</span>
            <span className="text-slate-200">
              Validadas:{' '}
              <strong className="text-sm font-bold tabular-nums text-white">{counts.validated}</strong>{' '}
              de <span className="tabular-nums">{counts.total}</span>
              <span className="mx-1.5 text-slate-500">·</span>
              Pendientes:{' '}
              <strong className="font-semibold tabular-nums text-amber-300">{counts.pendingValidation}</strong>
            </span>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={pending || selected.length === 0}
            className="inline-flex h-7 items-center rounded-lg bg-theme-accent px-2.5 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            {pending ? 'Incorporando…' : `Incorporar (${selected.length})`}
          </button>
        </div>

        <div className="lg:col-span-6 grid grid-cols-3 gap-2">
          <div className="flex items-center justify-between gap-2 rounded-xl border border-theme-border bg-theme-surface px-3 py-2 shadow-2xs">
            <div className="min-w-0">
              <p className="truncate text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                Por incorporar
              </p>
              <p className="hidden sm:block truncate text-[10.5px] text-theme-text-muted/80">Recepciones FA</p>
            </div>
            <span className="text-lg font-bold tabular-nums text-theme-text">{counts.toIncorporate}</span>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-xl border border-theme-border bg-theme-surface px-3 py-2 shadow-2xs">
            <div className="min-w-0">
              <p className="truncate text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                Pendientes
              </p>
              <p className="hidden sm:block truncate text-[10.5px] text-theme-text-muted/80">Por validar</p>
            </div>
            <span className="text-lg font-bold tabular-nums text-amber-600 dark:text-amber-400">
              {counts.pendingValidation}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-xl border border-theme-border bg-theme-surface px-3 py-2 shadow-2xs">
            <div className="min-w-0">
              <p className="truncate text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
                Validadas
              </p>
              <p className="hidden sm:block truncate text-[10.5px] text-theme-text-muted/80">Confirmadas</p>
            </div>
            <span className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {counts.validated}
            </span>
          </div>
        </div>
      </div>

      {message && (
        <div
          role="status"
          className="shrink-0 flex items-center justify-between gap-3 rounded-lg border border-theme-border bg-theme-surface px-3 py-1.5 text-xs text-theme-text shadow-2xs"
        >
          <span>{message}</span>
          <button
            type="button"
            onClick={() => setMessage('')}
            className="text-theme-text-muted hover:text-theme-text"
            aria-label="Ocultar aviso"
          >
            ×
          </button>
        </div>
      )}

      {/* Unified operational table card with integrated search/filter toolbar */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-xs">
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-theme-border px-3.5 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-theme-text">
              Bandeja de facturas
            </h2>
            <span className="inline-flex items-center rounded-md bg-theme-bg px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-theme-text-muted">
              {rows.length} / {counts.total}
            </span>
            {selected.length > 0 && (
              <span className="inline-flex items-center rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-sky-700 dark:text-sky-300">
                {selected.length} sel.
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 w-full sm:w-auto">
            <label className="relative flex-1 sm:flex-none sm:w-60">
              <span className="sr-only">Buscar proveedor, RUT, folio u OC</span>
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-theme-text-muted" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar proveedor, RUT, folio u OC…"
                className={cn(erpInputClass, 'h-7 w-full pl-8 pr-2 text-xs')}
              />
            </label>

            <label>
              <span className="sr-only">Filtrar por estado</span>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className={cn(erpSelectClass, 'h-7 px-2 text-xs')}
              >
                <option value="ALL">Todos</option>
                <option value="NEW">Por incorporar</option>
                <option value="PENDING">Pendiente</option>
                <option value="VALIDATED">Validada</option>
              </select>
            </label>

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

        <div className="max-h-[70vh] flex-1 min-h-0 overflow-auto md:max-h-none">
          <table
            style={{ width: `${totalTableWidth}px`, minWidth: '100%' }}
            className="table-fixed border-separate border-spacing-0 text-left"
          >
            <colgroup>
              {CXP_COLUMNS.map(col => (
                <col key={col.id} style={{ width: `${widths[col.id] ?? col.defaultWidth}px` }} />
              ))}
            </colgroup>
            <thead className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-theme-text-muted [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:border-b [&_th]:border-theme-border [&_th]:bg-slate-50 dark:[&_th]:bg-theme-surface">
              <tr>
                <th
                  style={{ width: `${widths.select ?? COLUMN_BY_ID.select.defaultWidth}px` }}
                  className="px-2 py-2 text-center"
                >
                  <div className="inline-flex items-center justify-center gap-0.5">
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todas las facturas incorporables visibles"
                      checked={allVisibleSelected}
                      disabled={pending || selectableVisibleIds.length === 0}
                      onChange={toggleSelectAllVisible}
                      className="h-3.5 w-3.5 rounded border-theme-border align-middle"
                    />
                    <button
                      type="button"
                      onClick={() => cycleSort(COLUMN_BY_ID.select)}
                      title="Ordenar por seleccionadas"
                      aria-label="Ordenar por seleccionadas"
                      className="group inline-flex items-center text-theme-text-muted hover:text-theme-text"
                    >
                      <OperationalTableSortIndicator
                        active={sort?.column === 'select'}
                        direction={sort?.direction}
                      />
                    </button>
                  </div>
                </th>
                {renderSortableHeader('supplier', 'Proveedor')}
                {renderSortableHeader('purchaseType', 'Tipo')}
                {renderSortableHeader('folio', 'Factura')}
                {renderSortableHeader('issueDate', 'Emisión')}
                {renderSortableHeader('dueDate', 'Vencim.')}
                {renderSortableHeader('po', 'OC')}
                {renderSortableHeader('receptionStatus', 'Recepción')}
                {renderSortableHeader('referenceAmount', 'Ref. recep.', { align: 'right' })}
                {renderSortableHeader('realAmount', 'Monto real', { align: 'right' })}
                {renderSortableHeader('document', 'Respaldo')}
                {renderSortableHeader('status', 'Estado')}
                <th
                  style={{ width: `${widths.action ?? COLUMN_BY_ID.action.defaultWidth}px` }}
                  className="px-2.5 py-2 text-right whitespace-nowrap"
                >
                  Acción
                </th>
              </tr>
            </thead>
            <tbody className="text-xs [&_td]:border-b [&_td]:border-theme-border [&_tr:last-child_td]:border-b-0">
              {rows.map(({ row, summary, effectiveStatus, state, effectiveIssueDate, effectiveDueDate, dueSource, dueBaseKey }) => {
                const isValidated = effectiveStatus === 'VALIDATED'
                const isPending = effectiveStatus === 'PENDING'
                const hasUnresolvedDiscrepancy = isPending && summary?.discrepancy_status === 'UNRESOLVED'
                const isSelected = selectedSet.has(row.candidate_id)

                return (
                  <tr
                    key={row.candidate_id}
                    className={cn(
                      'h-10 transition-colors hover:bg-theme-surface-hover/80',
                      row.invoice_id && 'cursor-pointer',
                      isSelected && 'bg-sky-500/[0.05]',
                    )}
                    onClick={event => {
                      const target = event.target as HTMLElement
                      if (target.closest('input, button, a')) return
                      if (row.invoice_id) setActiveInvoiceId(row.invoice_id)
                    }}
                  >
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Seleccionar factura ${row.folio ?? 'sin folio'} de ${row.supplier_name}`}
                        checked={isSelected}
                        disabled={pending || row.purchase_type === 'SERVICES' || !!row.blocked_reason || isValidated}
                        onChange={e =>
                          setSelected(current =>
                            e.target.checked
                              ? [...current, row.candidate_id]
                              : current.filter(id => id !== row.candidate_id),
                          )
                        }
                        className="h-3.5 w-3.5 rounded border-theme-border align-middle"
                      />
                    </td>

                    <td className="overflow-hidden px-2.5 py-1">
                      <div
                        className="truncate font-semibold leading-tight text-theme-text"
                        title={row.supplier_name}
                      >
                        {row.supplier_name}
                      </div>
                      <div className="truncate font-mono text-[10.5px] leading-tight text-theme-text-muted">
                        {row.issuer_rut ? formatRut(row.issuer_rut) : 'Sin RUT'}
                      </div>
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 whitespace-nowrap">
                      <span
                        className={cn(
                          'inline-flex truncate rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium',
                          row.purchase_type === 'SERVICES'
                            ? 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                            : 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
                        )}
                      >
                        {purchaseTypeLabel(row.purchase_type)}
                      </span>
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 whitespace-nowrap font-semibold tabular-nums text-theme-text">
                      <span className="block truncate" title={`FA ${row.folio ?? '—'}`}>
                        FA {row.folio ?? '—'}
                      </span>
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 whitespace-nowrap tabular-nums text-theme-text-muted">
                      {formatCivilDate(effectiveIssueDate) || '—'}
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 tabular-nums">
                      <button
                        type="button"
                        disabled={Boolean(pendingDueDates[row.candidate_id])}
                        onClick={() => setEditingDueRow({
                          row, date: effectiveDueDate, baseKey: dueBaseKey,
                          readOnlyReason: dueDates === null ? 'Edición de vencimientos no disponible en este entorno.' : !row.invoice_id && row.blocked_reason ? row.blocked_reason : null,
                        })}
                        title={dueDates === null ? 'Consultar vencimiento en modo lectura' : !row.invoice_id && row.blocked_reason ? row.blocked_reason : 'Editar vencimiento'}
                        aria-label={`Vencimiento de factura ${row.folio ?? 'sin folio'} de ${row.supplier_name}: ${effectiveDueDate ? formatCivilDate(effectiveDueDate) : 'por confirmar'}`}
                        className="group flex max-w-full items-start gap-1 rounded-md text-left text-[11px] leading-tight text-theme-text hover:text-theme-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/40 disabled:cursor-default disabled:text-theme-text-muted"
                      >
                        <CalendarDays className="mt-0.5 h-3 w-3 shrink-0 text-theme-text-muted group-hover:text-theme-accent" />
                        <span className="min-w-0">
                          <span className="block whitespace-nowrap">{effectiveDueDate ? formatCivilDate(effectiveDueDate) : 'Por confirmar'}</span>
                          {pendingDueDates[row.candidate_id] ? <span role="status" className="block text-[10px] text-theme-text-muted">Guardando…</span> : <>
                            {(dueSource === 'PURCHASE_ORDER' || dueSource === 'SUPPLIER') && <span className="block text-[10px] font-semibold text-sky-700 dark:text-sky-400">Sugerido</span>}
                            {dueSource === 'MANUAL' && <span className="block text-[10px] text-theme-text-muted">Corregido</span>}
                            {dueSource === 'SAVED' && <span className="block text-[10px] text-theme-text-muted">Registrado</span>}
                          </>}
                        </span>
                      </button>
                    </td>

                    <td className="overflow-hidden px-2.5 py-1">
                      {row.purchase_type === 'SERVICES' ? (
                        <span
                          className="block truncate text-[11px] text-theme-text-muted"
                          title={row.service_description || 'Sin OC (Servicio)'}
                        >
                          {row.service_description || 'Sin OC'}
                        </span>
                      ) : (
                        <span
                          className="block truncate font-mono text-[11px] text-theme-text"
                          title={row.purchase_orders.join(', ')}
                        >
                          {row.purchase_orders.join(', ') || '—'}
                        </span>
                      )}
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 whitespace-nowrap">
                      <span
                        className={cn(
                          'inline-flex truncate rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold',
                          row.reception_status === 'RECEIVED'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                            : row.reception_status === 'PARTIAL' ||
                                (row.purchase_type === 'SERVICES' && row.reception_status === 'PENDING')
                              ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                              : 'border-theme-border bg-theme-bg/70 text-theme-text-muted',
                        )}
                      >
                        {receptionStatusLabel(row.reception_status, row.purchase_type)}
                      </span>
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 text-right whitespace-nowrap font-medium tabular-nums text-theme-text">
                      <span className="block truncate" title={formatClp(row.reference_amount)}>
                        {formatClp(row.reference_amount)}
                      </span>
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 text-right whitespace-nowrap tabular-nums">
                      {summary?.total_amount != null ? (
                        <div className="leading-tight">
                          <span className="block truncate font-semibold text-theme-text">
                            {formatClp(summary.total_amount, { allowDecimals: true })}
                          </span>
                          {summary.prior_payment_status === 'PARTIAL_PRIOR_PAYMENTS' &&
                            summary.historical_initial_balance != null && (
                              <div className="truncate text-[10px] text-theme-text-muted">
                                Saldo: {formatClp(summary.historical_initial_balance, { allowDecimals: true })}
                              </div>
                            )}
                          {summary.prior_payment_status === 'FULLY_PAID_PRIOR' && (
                            <div className="truncate text-[10px] text-theme-text-muted">Pagada ($0)</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-theme-text-muted/75">Por confirmar</span>
                      )}
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 whitespace-nowrap">
                      {documents === null ? (
                        <span className="text-[11px] text-theme-text-muted" title="No se pudieron consultar los respaldos">No disponible</span>
                      ) : documents[row.candidate_id] ? (
                        <button
                          type="button"
                          disabled={loadingDocument}
                          onClick={() => void openDocuments(row)}
                          className="inline-flex max-w-full items-center gap-1 rounded-md text-[11px] font-semibold text-sky-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/40 dark:text-sky-400"
                          aria-label={`Ver respaldo de factura ${row.folio ?? 'sin folio'} de ${row.supplier_name}`}
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">Ver PDF</span>
                        </button>
                      ) : row.candidate_id in documents ? (
                        <span className="block whitespace-normal text-[10px] leading-tight text-theme-text-muted" title="Documento registrado sin archivo accesible">Adjunto no disponible</span>
                      ) : (
                        <span className="text-[11px] text-theme-text-muted">Sin adjunto</span>
                      )}
                    </td>

                    <td className="overflow-hidden px-2.5 py-1 whitespace-nowrap">
                      <div className="flex items-center gap-1 overflow-hidden">
                        {state === 'NEW' && (
                          <span className="inline-flex truncate rounded-md border border-theme-border bg-theme-bg/70 px-1.5 py-0.5 text-[10.5px] font-medium text-theme-text-muted">
                            Por incorporar
                          </span>
                        )}
                        {isPending && (
                          <span className="inline-flex truncate rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
                            Pendiente
                          </span>
                        )}
                        {isValidated && (
                          <span className="inline-flex items-center gap-1 truncate rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="h-3 w-3 shrink-0" /> Validada
                          </span>
                        )}
                        {!isPending && !isValidated && state === 'OTHER' && (
                          <span className="truncate text-[11px] text-theme-text">{effectiveStatus}</span>
                        )}
                        {hasUnresolvedDiscrepancy && (
                          <span
                            title="Existen diferencias sin resolver respecto a las recepciones"
                            className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-amber-500/35 bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                          >
                            <AlertTriangle className="h-2.5 w-2.5" />
                          </span>
                        )}
                      </div>
                      {row.blocked_reason && !isValidated && (
                        <p
                          className="mt-0.5 truncate text-[10px] text-red-600/90 dark:text-red-400"
                          title={row.blocked_reason}
                        >
                          {row.blocked_reason}
                        </p>
                      )}
                    </td>

                    <td className="px-2.5 py-1 text-right whitespace-nowrap">
                      {row.invoice_id ? (
                        <button
                          type="button"
                          onClick={() => setActiveInvoiceId(row.invoice_id)}
                          className={cn(
                            'inline-flex h-6.5 items-center gap-1 rounded-md px-2 text-[11px] font-semibold transition-colors',
                            isValidated
                              ? 'border border-theme-border bg-theme-surface text-theme-text hover:bg-theme-surface-hover'
                              : 'border border-sky-600/30 bg-sky-600/10 text-sky-700 hover:bg-sky-600/20 dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-300',
                          )}
                        >
                          {isValidated ? (
                            'Detalle'
                          ) : (
                            <>
                              <ShieldCheck className="h-3 w-3" /> Validar
                            </>
                          )}
                        </button>
                      ) : (
                        <span className="text-xs text-theme-text-muted/60">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {rows.length === 0 && (
            <p className="p-6 text-center text-xs text-theme-text-muted">
              No hay facturas para los filtros seleccionados.
            </p>
          )}
        </div>
      </section>

      <p className="shrink-0 text-[11px] text-theme-text-muted">
        El monto de recepción es una referencia calculada; valide cada factura incorporada para confirmar su importe real, vencimiento y saldo inicial.
      </p>

      <InvoiceValidationDrawer
        invoiceId={activeInvoiceId}
        suggestedDueDate={(() => {
          const item = enrichedRows.find(entry => entry.row.invoice_id === activeInvoiceId)
          return item?.dueSource === 'PURCHASE_ORDER' || item?.dueSource === 'SUPPLIER' ? item.effectiveDueDate : null
        })()}
        onClose={() => setActiveInvoiceId(null)}
        onUpdated={handleValidationUpdated}
      />
      {editingDueRow && (
        <InvoiceDueDateEditor
          key={editingDueRow.row.candidate_id}
          row={editingDueRow.row}
          dueDate={editingDueRow.date}
          readOnlyReason={editingDueRow.readOnlyReason}
          onClose={() => setEditingDueRow(null)}
          onSave={date => saveDueDate(editingDueRow, date)}
        />
      )}
      {viewer ? (
        <PurchaseOrderInvoiceViewerModal
          key={viewer.row.candidate_id}
          correlative={`FA ${viewer.row.folio ?? '—'}`}
          supplierName={viewer.row.supplier_name}
          documents={viewer.documents}
          initialDocumentId={viewer.documents.find(doc => doc.has_file)?.id}
          loadSignedUrl={loadInboxDocument}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </div>
  )
}
