'use client'

import { Fragment, useEffect, useRef, useState, useTransition } from 'react'
import { AlertCircle, ChevronRight } from 'lucide-react'
import { loadSalesNetDetail } from '@/app/actions/control-financiero/sales-net-detail'
import { loadSalesDocumentLines } from '@/app/actions/control-financiero/sales-document-lines'
import { buildSalesFamilyRows, type SalesFamilyRow, type StatementRow } from '@/lib/control-financiero/statement'
import type { FinanceSalesDocumentLinesResponse, FinanceSalesNetDetailResponse, FinanceSalesNetDetailItem, SalesFamilyGroup } from '@/lib/control-financiero/finance-api'
import { SalesNetDetailCache, type SalesNetDetailCacheKey } from '@/lib/control-financiero/sales-net-detail-cache'
import { SalesDocumentLinesCache, type SalesDocumentLinesCacheKey } from '@/lib/control-financiero/sales-document-lines-cache'

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
const MONTHS_FULL = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const DETAIL_PAGE_SIZE = 100

type Selection = {
  row: 'sales' | 'family'
  familyKey: string | null
  providerKey: string | null
  familyName: string | null
  month: number | null
  scope: 'MONTH' | 'YTD'
}

function formatClp(value: string | null | undefined) {
  if (value === null || value === undefined) return '—'
  return `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Number(value))}`
}

function formatQuantity(value: string | null) {
  if (value === null) return '—'
  const quantity = Number(value)
  return Number.isFinite(quantity)
    ? new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(quantity)
    : value
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const [year, month, day] = value.split('-')
  return `${day}-${MONTHS[Number(month) - 1].toLowerCase()}-${year}`
}

function valueTone(value: string | null | undefined) {
  return value?.startsWith('-') ? 'text-[#A23E48]' : 'text-[#322D29]'
}

function formatPercentage(value: number | null) {
  return value === null ? '—' : `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(value)}%`
}

function detailTitle(selection: Selection | null, year: number) {
  if (!selection) return `Ventas Netas · ${year}`
  const period = selection.month === null ? `YTD ${year}` : `${MONTHS_FULL[selection.month - 1]} ${year}`
  return selection.familyName ? `${selection.familyName} · ${period}` : `Ventas Netas · ${period}`
}

function detailAmount(item: FinanceSalesNetDetailResponse['items'][number]) {
  return item.signed_net_amount ?? item.contribution ?? item.net_amount ?? null
}

function CoverageIndicator({ count }: { count: number | null }) {
  if (!count) return null
  return (
    <span
      className="ml-1 inline-flex items-center gap-0.5 align-middle text-[9px] font-semibold text-[#72383D]"
      title={`Cobertura incompleta: ${count} documento${count === 1 ? '' : 's'} sin costo observado`}
      aria-label={`Cobertura incompleta: ${count} documento${count === 1 ? '' : 's'} sin costo observado`}
    >
      <AlertCircle className="h-3 w-3" aria-hidden="true" />
      {count}
    </span>
  )
}

export function FinancialMatrix({
  rows,
  groups,
  companyId,
  year,
  horizonMonth,
  familyUnavailable = false,
}: {
  rows: StatementRow[]
  groups: SalesFamilyGroup[]
  companyId: string
  year: number
  horizonMonth: number
  familyUnavailable?: boolean
}) {
  const visibleMonths = MONTHS.slice(0, horizonMonth)
  const salesRow = rows.find(row => row.label === 'Ventas Netas')
  const groupRows = groups.map(group => ({
    ...group,
    percentageYtd: salesRow?.ytd && Number(salesRow.ytd) !== 0
      ? (Number(group.ytd) / Number(salesRow.ytd)) * 100
      : null,
    children: buildSalesFamilyRows(group.children, salesRow?.ytd ?? null),
  }))
  const [expanded, setExpanded] = useState(true)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({})
  const groupSignature = `${companyId}:${year}:${groups.map(group => group.group_key).join('|')}`
  const [expandedGroupState, setExpandedGroupState] = useState<{
    signature: string
    values: Record<string, boolean>
  }>({ signature: '', values: {} })
  const expandedGroups = expandedGroupState.signature === groupSignature ? expandedGroupState.values : {}
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<FinanceSalesNetDetailResponse | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [detailPage, setDetailPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [documentLineStates, setDocumentLineStates] = useState<Record<string, { open: boolean; loading: boolean; error: string | null; data: FinanceSalesDocumentLinesResponse | null }>>({})
  const requestId = useRef(0)
  const detailCache = useRef(new SalesNetDetailCache())
  const documentLinesCache = useRef(new SalesDocumentLinesCache())
  const [, startTransition] = useTransition()

  useEffect(() => {
    detailCache.current.clear()
    documentLinesCache.current.clear()
    requestId.current += 1
  }, [companyId, year])

  function detailCacheKey(nextSelection: Selection, page: number): SalesNetDetailCacheKey {
    return {
      companyId,
      year,
      providerKey: nextSelection.providerKey,
      familyKey: nextSelection.familyKey,
      scope: nextSelection.scope,
      month: nextSelection.month,
      page,
      pageSize: DETAIL_PAGE_SIZE,
    }
  }

  function requestDetail(nextSelection: Selection, page = 1, append = false) {
    const currentRequest = ++requestId.current
    const cacheKey = detailCacheKey(nextSelection, page)
    const cached = detailCache.current.get(cacheKey)
    setOpen(true)
    setSelection(nextSelection)
    setError(null)
    setDetailPage(page)
    if (!append) setDocumentLineStates({})
    if (!append) setDetail(null)

    if (cached) {
      setDetail(current => append && current
        ? { ...cached, items: [...current.items, ...cached.items] }
        : cached)
      setHasMore(nextSelection.familyKey !== null && cached.items.length === DETAIL_PAGE_SIZE)
      setLoading(false)
      return
    }

    setLoading(true)

    startTransition(() => {
      detailCache.current.load(cacheKey, () => loadSalesNetDetail(
        year,
        nextSelection.month === null ? undefined : nextSelection.month,
        nextSelection.familyKey ?? undefined,
        page,
        DETAIL_PAGE_SIZE,
      ))
        .then(result => {
          if (requestId.current !== currentRequest) return
          setDetail(current => append && current
            ? { ...result, items: [...current.items, ...result.items] }
            : result)
          setHasMore(nextSelection.familyKey !== null && result.items.length === DETAIL_PAGE_SIZE)
        })
        .catch(caughtError => {
          if (requestId.current !== currentRequest) return
          setError(caughtError instanceof Error ? caughtError.message : 'No se pudo cargar el detalle de ventas netas.')
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false)
        })
    })
  }

  function documentLineKey(documentId: number) {
    return [
      companyId,
      year,
      documentId,
      selection?.providerKey ?? '-',
      selection?.familyKey ?? '-',
    ].join('|')
  }

  function toggleDocumentLines(item: FinanceSalesNetDetailItem) {
    if (!selection) return
    const stateKey = documentLineKey(item.document_id)
    const current = documentLineStates[stateKey]
    if (current?.open) {
      setDocumentLineStates(states => ({ ...states, [stateKey]: { ...current, open: false } }))
      return
    }

    const cacheKey: SalesDocumentLinesCacheKey = {
      companyId,
      year,
      documentId: item.document_id,
      providerKey: selection.providerKey,
      familyKey: selection.familyKey,
    }
    const cached = documentLinesCache.current.get(cacheKey)
    setDocumentLineStates(states => ({
      ...states,
      [stateKey]: { open: true, loading: !cached, error: null, data: cached ?? null },
    }))
    if (cached) return

    documentLinesCache.current.load(cacheKey, () => loadSalesDocumentLines(
      year,
      item.document_id,
      selection.providerKey ?? undefined,
      selection.familyKey ?? undefined,
    )).then(data => {
      setDocumentLineStates(states => ({
        ...states,
        [stateKey]: { open: true, loading: false, error: null, data },
      }))
    }).catch(caughtError => {
      setDocumentLineStates(states => ({
        ...states,
        [stateKey]: {
          open: true,
          loading: false,
          error: caughtError instanceof Error ? caughtError.message : 'No se pudieron cargar las líneas del documento.',
          data: null,
        },
      }))
    })
  }

  function selectSalesCell(columnIndex: number, value: string | null) {
    if (value === null || (columnIndex > 11 && columnIndex !== 12)) return
    requestDetail({
      row: 'sales',
      familyKey: null,
      providerKey: null,
      familyName: null,
      month: columnIndex === 12 ? null : columnIndex + 1,
      scope: columnIndex === 12 ? 'YTD' : 'MONTH',
    })
  }

  function selectFamilyCell(family: SalesFamilyRow, month: number | null, value: string | null) {
    if (value === null) return
    requestDetail({
      row: 'family',
      familyKey: family.family_key,
      providerKey: family.provider_key ?? null,
      familyName: family.family_name,
      month,
      scope: month === null ? 'YTD' : 'MONTH',
    })
  }

  function closeInspector() {
    requestId.current += 1
    setOpen(false)
    setSelection(null)
    setDetail(null)
    setError(null)
    setHasMore(false)
  }

  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeInspector()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open])

  const inspectorWidth = 'clamp(340px, 38vw, 660px)'
  const activeMonth = selection?.month ?? null
  const activeFamilyKey = selection?.familyKey ?? null
  const activeYtd = selection?.scope === 'YTD'

  const displayLabel = (label: string) => {
    if (label === 'RESULTADO OPERACIONAL') return 'Resultado del negocio'
    if (label === 'RESULTADO GERENCIAL') return 'Resultado final del período'
    return label
  }

  const rowClass = (row: StatementRow) => {
    if (open && selection?.row === 'sales') return 'bg-[#EAF2F7]'
    if (row.label === 'RESULTADO GERENCIAL') return 'border-y-2 border-[#72383D] bg-[#F1E4DE] font-bold'
    if (row.label === 'RESULTADO OPERACIONAL') return 'border-y border-[#72383D]/60 bg-[#F6EEE9] font-bold'
    if (row.result) return 'border-y border-[#AC9C8D] bg-[#F6EEE9] font-semibold'
    if (row.label === 'Ventas Netas' || row.label === 'Margen Bruto') return 'bg-[#F1E8E1] font-bold'
    if (row.label === 'Costo de Ventas') return 'bg-[#F8F5F1] font-semibold'
    return row.emphasis ? 'bg-[#E5D8D1] font-semibold' : 'bg-white'
  }
  const cellClass = (row: StatementRow) => rowClass(row)

  function renderSalesValue(value: string | null, columnIndex: number) {
    const active = selection?.row === 'sales'
      && (columnIndex === 12 ? activeYtd : activeMonth === columnIndex + 1)
    return (
      <button
        type="button"
        title="Abrir trazabilidad"
        aria-label={`Ventas Netas ${columnIndex === 12 ? 'YTD' : MONTHS_FULL[columnIndex]}. Abrir trazabilidad`}
        onClick={() => selectSalesCell(columnIndex, value)}
        disabled={value === null}
        className={`w-full rounded px-1 text-right tabular-nums outline-none transition-colors hover:text-[#72383D] hover:underline focus-visible:ring-2 focus-visible:ring-[#72383D]/45 disabled:cursor-default ${active ? 'bg-[#CFE4F1] font-semibold text-[#355C7D]' : ''} ${valueTone(value)}`}
      >
        {formatClp(value)}
      </button>
    )
  }

  function renderFamilyValue(family: SalesFamilyRow, value: string | null, month: number | null) {
    const active = activeFamilyKey === family.family_key
      && (month === null ? activeYtd : activeMonth === month)
    return (
      <button
        type="button"
        title="Abrir trazabilidad"
        aria-label={`${family.family_name} ${month === null ? 'YTD' : MONTHS_FULL[month - 1]}. Abrir trazabilidad`}
        onClick={() => selectFamilyCell(family, month, value)}
        disabled={value === null}
        className={`w-full rounded px-1 text-right tabular-nums outline-none transition-colors hover:text-[#72383D] hover:underline focus-visible:ring-2 focus-visible:ring-[#72383D]/45 disabled:cursor-default ${active ? 'bg-[#CFE4F1] font-semibold text-[#355C7D]' : ''} ${valueTone(value)}`}
      >
        {formatClp(value)}
      </button>
    )
  }

  function renderStatementRow(row: StatementRow) {
    const className = rowClass(row)
    return (
      <tr key={row.label} className={className}>
        <th className={`sticky left-0 z-10 px-4 py-2 text-left text-[#322D29] ${cellClass(row)}`}>{displayLabel(row.label)}</th>
        {row.values.slice(0, horizonMonth).map((value, index) => (
          <td key={`${row.label}-${index}`} className={`px-2.5 py-2 text-right align-middle tabular-nums ${className} ${open && selection?.row === 'sales' && activeMonth === index + 1 ? 'bg-[#CFE4F1]' : ''}`}>
            {row.label === 'Ventas Netas' ? renderSalesValue(value, index) : formatClp(value)}
            <CoverageIndicator count={row.missing[index]} />
          </td>
        ))}
        <td title={row.ytdTooltip} className={`sticky right-[95px] z-10 w-[135px] border-l border-[#D1C7BD] px-2.5 py-2 text-right font-semibold tabular-nums ${className} ${activeYtd && selection?.row === 'sales' ? 'bg-[#CFE4F1]' : ''}`}>
          {row.label === 'Ventas Netas' ? renderSalesValue(row.ytd, 12) : formatClp(row.ytd)}
          <CoverageIndicator count={row.ytdMissing} />
        </td>
        <td className={`sticky right-0 z-10 w-[95px] border-l border-[#D1C7BD] px-2.5 py-2 text-right tabular-nums text-[#72383D] ${className}`}>
          {formatPercentage(row.percentageYtd)}
        </td>
      </tr>
    )
  }

  function renderPersonnelRow(row: StatementRow) {
    const sectionKey = row.sectionKey ?? row.label
    const isExpanded = expandedSections[sectionKey] ?? false
    const groupTone = row.label === 'GASTOS FINANCIEROS / NO OPERACIONALES'
      ? 'bg-[#F5F0EA]'
      : 'bg-[#F1E8E1]'
    const sectionStart = row.label === 'GASTOS DE PERSONAL'
    return (
      <Fragment key={row.label}>
        {sectionStart && (
          <tr aria-hidden="true">
            <td colSpan={horizonMonth + 3} className="h-2 bg-white p-0" />
          </tr>
        )}
        <tr className={`border-y border-[#D1C7BD] ${groupTone}`}>
          <th className={`sticky left-0 z-10 px-4 py-2 text-left font-semibold uppercase tracking-[0.08em] text-[#72383D] ${groupTone}`}>
            <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setExpandedSections(current => ({ ...current, [sectionKey]: !isExpanded }))} aria-expanded={isExpanded}>
              <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#AC9C8D]/75 transition-transform ${isExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
              {row.label}
            </button>
          </th>
           {row.values.slice(0, horizonMonth).map((value, index) => <td key={`${row.label}-${index}`} className={`px-2.5 py-2 text-right align-middle tabular-nums ${groupTone} ${valueTone(value)}`}>{formatClp(value)}<CoverageIndicator count={row.missing[index]} /></td>)}
           <td title={row.ytdTooltip} className={`sticky right-[95px] z-10 w-[135px] border-l border-[#D1C7BD] px-2.5 py-2 text-right font-semibold tabular-nums ${groupTone} ${valueTone(row.ytd)}`}>{formatClp(row.ytd)}<CoverageIndicator count={row.ytdMissing} /></td>
          <td className={`sticky right-0 z-10 w-[95px] border-l border-[#D1C7BD] px-2.5 py-2 text-right tabular-nums text-[#72383D] ${groupTone}`}>{formatPercentage(row.percentageYtd)}</td>
        </tr>
        {isExpanded && row.children?.map(child => (
          <tr key={child.label} className="bg-white">
            <th className="sticky left-0 z-10 bg-white px-4 py-2 pl-10 text-left font-normal text-[#322D29]">{child.label}</th>
             {child.values.slice(0, horizonMonth).map((value, index) => <td key={`${child.label}-${index}`} className="px-2.5 py-2 text-right align-middle tabular-nums">{formatClp(value)}<CoverageIndicator count={child.missing[index]} /></td>)}
             <td title={child.ytdTooltip} className="sticky right-[95px] z-10 w-[135px] border-l border-[#D1C7BD] bg-white px-2.5 py-2 text-right font-semibold tabular-nums">{formatClp(child.ytd)}<CoverageIndicator count={child.ytdMissing} /></td>
             <td className="sticky right-0 z-10 w-[95px] border-l border-[#D1C7BD] bg-white px-2.5 py-2 text-right tabular-nums text-[#72383D]">{formatPercentage(child.percentageYtd)}</td>
          </tr>
        ))}
      </Fragment>
    )
  }

  function renderFamilyRow(family: SalesFamilyRow, label = family.family_name) {
    return (
      <tr key={family.family_key} className="bg-white">
        <th className={`sticky left-0 z-10 bg-white px-4 py-1.5 pl-10 text-left font-normal text-[#322D29] ${activeFamilyKey === family.family_key ? 'bg-[#EAF2F7] font-semibold' : ''}`}>
          {label}
        </th>
         {visibleMonths.map((_, index) => {
          const value = family.months[String(index + 1)] ?? null
           return <td key={`${family.family_key}-${index}`} className="bg-white px-2.5 py-1.5 text-right align-middle tabular-nums">{renderFamilyValue(family, value, index + 1)}</td>
        })}
         <td className={`sticky right-[95px] z-10 w-[135px] border-l border-[#D1C7BD] bg-white px-2.5 py-1.5 text-right font-semibold tabular-nums ${activeFamilyKey === family.family_key && activeYtd ? 'bg-[#CFE4F1]' : ''}`}>
          {renderFamilyValue(family, family.ytd, null)}
        </td>
         <td className="sticky right-0 z-10 w-[95px] border-l border-[#D1C7BD] bg-white px-2.5 py-1.5 text-right tabular-nums text-[#72383D]">
          {formatPercentage(family.percentageYtd)}
        </td>
      </tr>
    )
  }

  function renderGroupRow(group: typeof groupRows[number]) {
    const isExpanded = expandedGroups[group.group_key] ?? false
    return (
      <tr key={group.group_key} className="bg-[#FAF7F3] font-semibold">
        <th className="sticky left-0 z-10 bg-[#FAF7F3] px-4 py-1.5 pl-7 text-left text-[#322D29]">
          <button
             type="button"
             className="flex w-full items-center gap-2 text-left"
             onClick={() => setExpandedGroupState(current => ({
               signature: groupSignature,
               values: {
                 ...(current.signature === groupSignature ? current.values : {}),
                 [group.group_key]: !isExpanded,
               },
             }))}
            aria-expanded={isExpanded}
          >
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#AC9C8D]/75 transition-transform ${isExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
            {group.group_name}
          </button>
        </th>
          {visibleMonths.map((_, index) => <td key={`${group.group_key}-${index}`} className={`bg-[#FAF7F3] px-2.5 py-1.5 text-right tabular-nums ${valueTone(group.months[String(index + 1)])}`}>{formatClp(group.months[String(index + 1)])}</td>)}
        <td className={`sticky right-[95px] z-10 w-[135px] border-l border-[#D1C7BD] bg-[#FAF7F3] px-2.5 py-1.5 text-right tabular-nums ${valueTone(group.ytd)}`}>{formatClp(group.ytd)}</td>
        <td className="sticky right-0 z-10 w-[95px] border-l border-[#D1C7BD] bg-[#FAF7F3] px-2.5 py-1.5 text-right tabular-nums text-[#72383D]">{formatPercentage(group.percentageYtd)}</td>
      </tr>
    )
  }

  return (
    <div className="relative" style={{ paddingRight: open ? inspectorWidth : undefined }}>
      <div className="overflow-x-auto border border-[#D1C7BD] bg-white shadow-[0_2px_8px_rgba(50,45,41,0.03)]">
        <table className="isolate table-fixed border-collapse text-[12px]" style={{ width: `${260 + horizonMonth * 110 + 135 + 95}px`, minWidth: `${260 + horizonMonth * 110 + 135 + 95}px` }}>
          <colgroup>
            <col className="w-[260px]" />
            {visibleMonths.map(month => <col className="w-[110px]" key={month} />)}
            <col className="w-[135px]" />
            <col className="w-[95px]" />
          </colgroup>
          <thead className="sticky top-0 z-20 bg-[#322D29] text-left text-[10px] uppercase tracking-[0.1em] text-[#EFE9E1]">
            <tr>
              <th className="sticky left-0 z-30 w-[260px] bg-[#322D29] px-4 py-2 font-semibold">Concepto</th>
              {visibleMonths.map((month, index) => <th key={month} className={`w-[110px] px-2.5 py-2 text-right font-semibold ${activeMonth === index + 1 ? 'bg-[#355C7D]' : ''}`}>{month}</th>)}
              <th className="sticky right-[95px] z-30 w-[135px] border-l border-white/20 bg-[#322D29] px-2.5 py-2 text-right font-semibold">YTD</th>
              <th className="sticky right-0 z-30 w-[95px] border-l border-white/20 bg-[#322D29] px-2.5 py-2 text-right font-semibold">% Ventas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#D1C7BD]/70">
            <tr className="border-y border-[#D1C7BD] bg-[#E5D8D1]">
              <th className="sticky left-0 z-10 bg-[#E5D8D1] px-4 py-2 text-left font-semibold uppercase tracking-[0.08em] text-[#72383D]">
                <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setExpanded(current => !current)} aria-expanded={expanded}>
                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-[#AC9C8D]/75 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
                  INGRESOS Y VENTAS
                </button>
              </th>
            <td colSpan={horizonMonth + 2} className="bg-[#E5D8D1]" />
            </tr>
            {expanded && familyUnavailable && (
              <tr>
                <td colSpan={horizonMonth + 3} className="px-4 py-2 text-[10px] text-[#322D29]/60">Detalle de ventas temporalmente no disponible.</td>
              </tr>
            )}
            {expanded && groupRows.flatMap(group => [
              renderGroupRow(group),
              ...(expandedGroups[group.group_key] ?? false
                ? group.children.map(child => renderFamilyRow(
                  child,
                  group.group_key === 'synthetic:unassigned'
                    ? child.family_name
                    : child.detail_name ?? child.family_name,
                ))
                : []),
            ])}
            {rows.map(row => row.group ? renderPersonnelRow(row) : renderStatementRow(row))}
          </tbody>
        </table>
      </div>

      {open && (
        <aside
          style={{ width: inspectorWidth }}
          className="fixed inset-y-0 right-0 z-[60] flex h-screen flex-col overflow-hidden border-l border-[#D1C7BD] bg-[#EFE9E1] text-[#322D29] shadow-2xl"
          aria-label="Trazabilidad del estado de resultados"
        >
          <header className="sticky top-0 z-10 flex shrink-0 items-start justify-between border-b border-[#D1C7BD] bg-white px-5 py-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#AC9C8D]">Trazabilidad P&amp;L · Ventas Netas</p>
              <h2 className="mt-1 text-lg font-semibold">{detailTitle(selection, year)}</h2>
              <p className="mt-1 text-xs text-[#322D29]/60">
                {selection?.month === null ? 'Enero hasta el último día disponible del año' : selection?.month ? `Período de ${MONTHS_FULL[selection.month - 1]}` : 'Detalle de ventas netas'}
                {detail?.data_through ? ` · Datos hasta ${formatDate(detail.data_through)}` : ''}
              </p>
            </div>
            <button type="button" className="ml-3 h-8 w-8 shrink-0 rounded border border-[#D1C7BD] text-lg text-[#322D29]/55 hover:border-[#72383D] hover:text-[#72383D]" onClick={closeInspector} aria-label="Cerrar trazabilidad">×</button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && <div className="border-b border-[#D1C7BD] px-5 py-3 text-xs text-[#322D29]/60">Cargando trazabilidad...</div>}
            {error && <div className="m-5 border border-[#72383D]/25 bg-white/45 px-4 py-4 text-sm text-[#72383D]">{error}</div>}
            {!error && detail && (
              <>
                <div className="grid grid-cols-3 gap-px border-b border-[#D1C7BD] bg-[#D1C7BD]">
                  <div className="bg-[#EFE9E1] px-4 py-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#AC9C8D]">Total</p><p className={`mt-1 text-base font-semibold tabular-nums ${valueTone(detail.total ?? detail.total_net)}`}>{formatClp(detail.total ?? detail.total_net)}</p></div>
                  <div className="bg-[#EFE9E1] px-4 py-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#AC9C8D]">Registros</p><p className="mt-1 text-base font-semibold tabular-nums">{(detail.document_count ?? detail.documents_count).toLocaleString('es-CL')}</p></div>
                  <div className="bg-[#EFE9E1] px-4 py-3"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#AC9C8D]">Fuente</p><p className="mt-1 text-base font-semibold">{detail.source ?? 'BSale'}</p></div>
                </div>
                <p className="border-b border-[#D1C7BD] px-5 py-3 text-xs text-[#322D29]/75">{detail.source ?? 'BSale'}: {formatClp(detail.total ?? detail.total_net)} · {(detail.document_count ?? detail.documents_count).toLocaleString('es-CL')} registros</p>
                {detail.items.length === 0 ? (
                  <div className="m-5 border border-dashed border-[#AC9C8D]/70 bg-white/35 px-5 py-12 text-center text-sm text-[#322D29]/60">No hay documentos para este período.</div>
                ) : (
                  <div className="divide-y divide-[#D1C7BD]/70">
                    {detail.items.map(item => {
                      const amount = detailAmount(item)
                      const isCreditNote = item.sign_for_sales === -1 || amount?.startsWith('-') || item.document_type.toLowerCase().includes('crédito')
                      const lineState = documentLineStates[documentLineKey(item.document_id)]
                      const lines = lineState?.data?.lines ?? []
                      return (
                        <article key={item.document_id} className="px-5 py-3 hover:bg-white/60">
                          <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.08em] text-[#322D29]/60">
                            <span>{formatDate(item.emission_date ?? item.date)}</span>
                            <span className={isCreditNote ? 'font-semibold text-[#A23E48]' : ''}>{isCreditNote ? 'Nota de Crédito' : detail.source ?? 'BSale'}</span>
                            <strong className={`text-xs normal-case tracking-normal ${valueTone(amount)}`}>{formatClp(amount)}</strong>
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-3">
                            <p className={`text-sm font-semibold ${isCreditNote ? 'text-[#A23E48]' : ''}`}>{item.document_type ?? item.document_type_name ?? 'Documento'} · {item.folio.toLocaleString('es-CL')}</p>
                            <button
                              type="button"
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#72383D]/70 hover:bg-[#F5F0EA] hover:text-[#72383D]"
                              onClick={() => toggleDocumentLines(item)}
                              aria-expanded={Boolean(lineState?.open)}
                              aria-label={`${lineState?.open ? 'Contraer' : 'Expandir'} líneas del documento ${item.folio}`}
                            >
                              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${lineState?.open ? 'rotate-90' : ''}`} aria-hidden="true" />
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-[#322D29]/65">{item.net_amount ? `Monto neto: ${formatClp(item.net_amount)} · ` : ''}{item.office_name ? `Sucursal: ${item.office_name} · ` : ''}{item.line_count !== undefined ? `Líneas: ${item.line_count}` : isCreditNote ? 'Signo: −' : 'Signo: +'}</p>
                          {lineState?.open && (
                            <div className="mt-3 border-t border-[#D1C7BD]/70 pt-3">
                              {lineState.loading && <p className="text-xs text-[#322D29]/60">Cargando líneas...</p>}
                              {lineState.error && <p className="text-xs text-[#A23E48]">{lineState.error}</p>}
                              {lineState.data && (
                                <>
                                  {(lineState.data.document.client_name || lineState.data.document.office_name) && (
                                    <p className="mb-2 text-[10px] text-[#322D29]/60">
                                      {lineState.data.document.client_name ? `Cliente: ${lineState.data.document.client_name}` : ''}
                                      {lineState.data.document.client_name && lineState.data.document.office_name ? ' · ' : ''}
                                      {lineState.data.document.office_name ? `Sucursal: ${lineState.data.document.office_name}` : ''}
                                    </p>
                                  )}
                                  <div className="space-y-2">
                                    {lines.map(line => (
                                      <div key={line.detail_id ?? `${item.document_id}-${line.line_number}`} className={`rounded-sm border-l-4 px-2 py-1.5 ${line.matches_selection ? 'border-[#2F638C] bg-[#E1EDF5]' : 'border-[#D1C7BD]'}`}>
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0">
                                            <p className={`truncate text-xs font-semibold ${line.matches_selection ? 'text-[#24577E]' : ''}`}>{line.product_name || line.sku || 'Producto sin nombre'}</p>
                                            <p className="mt-0.5 text-[10px] text-[#322D29]/65">
                                              {line.sku ? `SKU: ${line.sku}` : ''}
                                              {line.variant_name && line.variant_name !== line.product_name ? `${line.sku ? ' · ' : ''}${line.variant_name}` : ''}
                                              {line.family_name ? ` · ${line.family_name}` : ''}
                                            </p>
                                          </div>
                                          <span className={`shrink-0 text-xs font-semibold tabular-nums ${line.matches_selection ? 'text-[#24577E]' : valueTone(line.signed_net_amount)}`}>{formatClp(line.signed_net_amount)}</span>
                                        </div>
                                        <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[#322D29]/75">
                                          {line.quantity !== null && <span><strong className="font-semibold text-[#322D29]/90">Cantidad</strong> {formatQuantity(line.quantity)}</span>}
                                          {line.unit_price !== '0.00' && <span><strong className="font-semibold text-[#322D29]/90">Unit.</strong> {formatClp(line.unit_price)}</span>}
                                          {line.discount !== '0.00' && <span><strong className="font-semibold text-[#322D29]/90">Desc.</strong> {formatClp(line.discount)}</span>}
                                          {line.barcode && <span><strong className="font-semibold text-[#322D29]/90">Código</strong> {line.barcode}</span>}
                                        </p>
                                        {line.matches_selection && <p className="mt-1 inline-flex rounded bg-[#2F638C] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-white">Concepto seleccionado</p>}
                                      </div>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                )}
                {hasMore && selection?.familyKey && (
                  <div className="border-t border-[#D1C7BD] px-4 py-3">
                    <button type="button" disabled={loading} className="w-full border border-[#D1C7BD] bg-white px-3 py-2 text-xs font-semibold text-[#72383D] hover:border-[#72383D] disabled:opacity-50" onClick={() => requestDetail(selection, detailPage + 1, true)}>
                      {loading ? 'Cargando...' : 'Cargar siguientes registros'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
