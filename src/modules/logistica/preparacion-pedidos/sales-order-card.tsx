'use client'

import { Ban, FileText } from 'lucide-react'
import { useRef } from 'react'
import { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import type { InvoiceDocumentPreview } from './invoice-flow-ui'
import { useDraggable } from '@dnd-kit/core'
import { formatPreparationClp, getPreparationCardAmount, getPreparationComuna, parseDateOnly } from './preparation-board-utils'
import { getPreparationLockLabel } from './preparation-lock-policy'
import { getPreparationReadinessLabel, type PreparationReadinessLoadState, type PreparationRouteReadiness } from './preparation-route-readiness'
import { PreparationCommercialChangeAlert } from './preparation-commercial-change-alert'
import type { PreparationCommercialAlert } from '@/app/actions/logistica/sales-order-preparation-commercial'

export type SalesOrderCardAuditLock = {
  locked_by_user_id: string | null
  locked_by_user_name: string | null
  assigned_auditor_user_name: string | null
}

interface SalesOrderCardProps {
  card: SalesOrderPreparationCardInfo
  onDoubleClick?: () => void
  onOpen?: () => void
  isOverlay?: boolean
  isPending?: boolean
  canExclude?: boolean
  onExclude?: (card: SalesOrderPreparationCardInfo) => void
  selectable?: boolean
  selected?: boolean
  onToggleSelected?: (card: SalesOrderPreparationCardInfo) => void
  currentUserId?: string | null
  dragDisabled?: boolean
  auditLock?: SalesOrderCardAuditLock | null
  routeReadiness?: PreparationRouteReadiness | null
  readinessState?: PreparationReadinessLoadState
  openCommercialIncidentCount?: number
  onOpenCommercialIncidents?: () => void
  onInvoice?: () => void
  invoiceDocuments?: InvoiceDocumentPreview[]
  onViewInvoice?: () => void
  commercialAlert?: PreparationCommercialAlert | null
}

function formatShortDate(value: string | null): string | null {
  if (!value) return null
  const date = parseDateOnly(value)
  if (!date) return null
  return date
    .toLocaleDateString('es-CL', { day: '2-digit', month: 'short' })
    .replace('.', '')
}

function formatFullDate(value: string | null): string | null {
  if (!value) return null
  const date = parseDateOnly(value)
  if (!date) return null
  return date.toLocaleDateString('es-CL', { day: '2-digit', month: 'long', year: 'numeric' })
}

export function SalesOrderCard({
  card,
  onDoubleClick,
  onOpen,
  isOverlay,
  isPending = false,
  canExclude = false,
  onExclude,
  selectable = false,
  selected = false,
  onToggleSelected,
  currentUserId = null,
  dragDisabled = false,
  auditLock = null,
  routeReadiness = null,
  readinessState = 'loading',
  openCommercialIncidentCount = 0,
  onOpenCommercialIncidents,
  onInvoice,
  invoiceDocuments = [],
  onViewInvoice,
  commercialAlert = null,
}: SalesOrderCardProps) {
  const routeDate = formatShortDate(card.route_date)
  const routeFullDate = formatFullDate(card.route_date)
  const emissionDate = formatShortDate(card.nv_emission_date)
  const emissionFullDate = formatFullDate(card.nv_emission_date)
  const primaryDate = routeDate
    ? { value: routeDate, title: `Fecha de ruta: ${routeFullDate ?? '—'}` }
    : { value: emissionDate ?? '—', title: `Fecha de emisión: ${emissionFullDate ?? '—'}` }
  const comuna = getPreparationComuna(card)
  const amount = getPreparationCardAmount(card)
  const isInvoiced = card.status === 'INVOICED_READY_FOR_ROUTE'
  const invoicedAmount = invoiceDocuments.reduce((sum, document) => sum + (document.total_amount ?? 0), 0)
  const invoiceDisplayAmount = invoiceDocuments.length > 1
    ? invoicedAmount
    : invoiceDocuments[0]?.total_amount ?? (isInvoiced ? card.total_amount : amount)
  const invoiceSummary = invoiceDocuments.length > 1
    ? `${invoiceDocuments.length} facturas · ${formatPreparationClp(invoicedAmount)} facturado`
    : invoiceDocuments[0]
      ? `Factura #${invoiceDocuments[0].invoice_folio}${invoiceDocuments[0].payment_method_name ? ` · ${invoiceDocuments[0].payment_method_name}` : ''}`
      : 'Factura disponible'
  const amountTitle = isInvoiced
    ? 'Importe total de la factura confirmada'
    : 'Monto total de la Nota de Venta'
  const lockLabel = getPreparationLockLabel({
    status: card.status,
    currentUserId,
    lockedByUserId: card.locked_by_user_id,
    lockedByName: card.locked_by_user_name,
  })
  const auditLabel = card.status === 'IN_AUDIT' && auditLock
    ? auditLock.locked_by_user_id === currentUserId
      ? 'Tu auditoría'
      : auditLock.locked_by_user_name || auditLock.assigned_auditor_user_name
        ? `Audita: ${auditLock.locked_by_user_name || auditLock.assigned_auditor_user_name}`
        : 'Sin auditor'
    : null
  const isFinalized = card.status === 'AUDITED'
  const isReadyToInvoice = isFinalized && routeReadiness === 'READY_TO_INVOICE'
  const readinessLabel = isFinalized ? getPreparationReadinessLabel(routeReadiness, readinessState) : null
  const responsibilityLabel = isFinalized ? readinessLabel : auditLabel ?? lockLabel
  const responsibilityTone = isFinalized && routeReadiness === 'BLOCKED'
    ? 'text-[#8A4B4B]'
    : isFinalized && routeReadiness === 'READY_TO_INVOICE'
      ? 'text-emerald-700'
      : isFinalized
        ? 'text-[#806238]'
    : card.status === 'IN_AUDIT'
      ? 'text-[#5B4A78]'
      : 'text-[#806238]'
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const hasCommercialChange = commercialAlert?.status === 'CHANGED'

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.card_id,
    data: { card },
    disabled: isOverlay || isPending || dragDisabled
  })

  const style = transform && !isOverlay ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined

  const handleOpen = () => {
    if (isOverlay || isPending || isDragging) return
    onOpen?.()
  }

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-card-action]')) return
    const start = pointerStartRef.current
    if (start) {
      const moved = Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y)
      if (moved > 6) return
    }
    handleOpen()
  }

  let wrapperClasses = "group relative w-full rounded-md border bg-white px-2.5 py-2 text-left transition-all duration-150 "
  if (isOverlay) {
    wrapperClasses += "pointer-events-none shadow-xl ring-2 ring-[#72383D] rotate-1 scale-[1.02] "
  } else if (isDragging) {
    wrapperClasses += "cursor-grabbing opacity-40 shadow-sm border-[#D1C7BD] "
  } else if (selected && !hasCommercialChange) {
    wrapperClasses += "cursor-pointer border-[#72383D] bg-[#FCF8F5] ring-1 ring-[#72383D]/40 shadow-xs "
  } else {
    wrapperClasses += `${isPending ? 'cursor-wait opacity-60 ' : 'cursor-pointer '}`
    wrapperClasses += isFinalized
      ? 'border-emerald-200 bg-[#F7FBF7] shadow-xs hover:border-emerald-300 hover:shadow-sm '
      : hasCommercialChange
        ? 'border-red-500 bg-red-50/90 shadow-sm ring-2 ring-red-400/60 hover:border-red-600 animate-pulse motion-reduce:animate-none '
      : 'border-[#D8CFC5] shadow-xs hover:border-[#72383D]/70 hover:shadow-sm '
  }

  return (
    <div
      ref={!isOverlay ? setNodeRef : undefined}
      style={style}
      {...(!isOverlay ? listeners : {})}
      {...(!isOverlay ? attributes : {})}
      onPointerDownCapture={!isOverlay ? event => {
        pointerStartRef.current = { x: event.clientX, y: event.clientY }
      } : undefined}
      onClick={!isOverlay ? handleClick : undefined}
      onDoubleClick={!isOverlay ? onDoubleClick : undefined}
      onKeyDown={!isOverlay ? event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen?.()
        }
      } : undefined}
      role={!isOverlay ? 'button' : undefined}
      tabIndex={!isOverlay ? 0 : undefined}
      aria-label={!isOverlay ? `Abrir detalle de NV ${card.nv_folio}` : undefined}
      className={wrapperClasses}
    >
      <div className="flex items-center gap-1.5">
        {selectable && !isOverlay && (
          <button
            type="button"
            data-card-action
            role="checkbox"
            aria-checked={selected}
            aria-label={`${selected ? 'Quitar' : 'Agregar'} NV ${card.nv_folio} de la selección`}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation()
              onToggleSelected?.(card)
            }}
            onDoubleClick={event => event.stopPropagation()}
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
              selected
                ? 'border-[#72383D] bg-[#72383D] text-white'
                : 'border-[#B8ABA0] bg-white text-transparent hover:border-[#72383D] hover:bg-[#F5F0EA]'
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        <span className="min-w-0 flex-1 truncate text-[12px] font-bold tracking-tight text-[#322D29]" title={`NV #${card.nv_folio}`}>
          NV #{card.nv_folio}
        </span>
        <span
          className="shrink-0 text-[10px] font-semibold tabular-nums text-[#322D29]/55"
          title={`${card.total_quantity} ${card.total_quantity === 1 ? 'unidad' : 'unidades'}`}
        >
          {card.total_quantity} un.
        </span>
      </div>

      <p
        className="mt-0.5 truncate text-[11.5px] font-semibold leading-snug text-[#322D29] transition-colors group-hover:text-[#72383D]"
        title={card.client_name}
      >
        {card.client_name}
      </p>

      {!isOverlay && <div className="mt-1.5"><PreparationCommercialChangeAlert alert={commercialAlert} compact /></div>}

      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] font-medium text-[#322D29]/55" title={`${comuna} · ${primaryDate.title}`}>
          {comuna}
          <span className="px-0.5 text-[#322D29]/30">·</span>
          {primaryDate.value}
        </span>
        {invoiceDisplayAmount != null && (
          <span className="shrink-0 text-[11px] font-bold tabular-nums leading-none text-[#322D29]" title={amountTitle}>
            {formatPreparationClp(invoiceDisplayAmount)}
          </span>
        )}
      </div>

      {(responsibilityLabel || isInvoiced || isPending || onInvoice || (canExclude && !isOverlay && card.status === 'PENDING_ROUTE_PREP')) && (
        <div className="mt-1 flex min-h-[15px] items-center justify-between gap-2">
          <span className={`min-w-0 truncate text-[9.5px] font-semibold ${isInvoiced ? 'text-emerald-700' : responsibilityTone}`} title={isInvoiced ? invoiceSummary : responsibilityLabel ?? undefined}>
            {isInvoiced ? <><span className="mr-1 rounded bg-emerald-50 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider text-emerald-800">Facturada</span>{invoiceSummary}</> : <>{isFinalized && routeReadiness === 'READY_TO_INVOICE' ? '✓ ' : ''}{responsibilityLabel}</>}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {isFinalized && openCommercialIncidentCount > 0 && onOpenCommercialIncidents && (
              <button
                type="button"
                data-card-action
                onPointerDown={event => event.stopPropagation()}
                onClick={event => {
                  event.stopPropagation()
                  onOpenCommercialIncidents()
                }}
                onDoubleClick={event => event.stopPropagation()}
                className="rounded px-1 py-0.5 text-[9px] font-semibold text-[#72383D] hover:bg-[#F5EDE9] hover:underline"
              >
                {openCommercialIncidentCount} {openCommercialIncidentCount === 1 ? 'tarea pendiente' : 'tareas pendientes'}
              </button>
            )}
            {isPending && (
              <span className="text-[9px] font-semibold uppercase tracking-wider text-[#806238]">Guardando…</span>
            )}
            {isReadyToInvoice && !isOverlay && onInvoice && (
              <button
                type="button"
                data-card-action
                onPointerDown={event => event.stopPropagation()}
                onClick={event => {
                  event.stopPropagation()
                  onInvoice()
                }}
                onDoubleClick={event => event.stopPropagation()}
                className="inline-flex items-center gap-0.5 rounded bg-[#72383D] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-[#612F34]"
              >
                <FileText className="h-2.5 w-2.5" /> Facturar
              </button>
            )}
            {isInvoiced && !isOverlay && onViewInvoice && (
              <button
                type="button"
                data-card-action
                onPointerDown={event => event.stopPropagation()}
                onClick={event => {
                  event.stopPropagation()
                  onViewInvoice()
                }}
                onDoubleClick={event => event.stopPropagation()}
                className="inline-flex items-center gap-0.5 rounded border border-[#72383D]/35 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#72383D] hover:bg-[#F5EDE9]"
              >
                <FileText className="h-2.5 w-2.5" /> Ver factura
              </button>
            )}
            {canExclude && !isOverlay && card.status === 'PENDING_ROUTE_PREP' && (
              <button
                type="button"
                data-card-action
                title="Excluir de preparación"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onExclude?.(card)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                className="inline-flex w-fit items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#8A4B4B] transition-colors hover:bg-[#8A4B4B]/10 hover:text-[#72383D]"
              >
                <Ban className="h-2.5 w-2.5" />
                Excluir
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
