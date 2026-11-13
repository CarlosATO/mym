'use client'

import { Ban, FileText, RefreshCw, ShieldAlert } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { verifyCardClientCommercialStatus, type VerifyCardClientCommercialResult } from '@/app/actions/logistica/sales-order-client-commercial-verification'
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
  commercialMirror?: boolean
  canVerifyClientCommercial?: boolean
  onClientCommercialStatusChange?: (cardId: string, result: {
    status: 'BLOCKED' | 'UNBLOCKED' | 'UNKNOWN'
    commerciallyBlocked: boolean | null
    verifiedAt: string
  }) => void
  onVerifyClientCommercial?: (cardId: string) => Promise<VerifyCardClientCommercialResult>
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
  commercialMirror = false,
  canVerifyClientCommercial = false,
  onClientCommercialStatusChange,
  onVerifyClientCommercial,
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
  const responsibilityLabel = commercialMirror ? 'Tarea comercial pendiente' : isFinalized ? readinessLabel : auditLabel ?? lockLabel
  const responsibilityTone = isFinalized && routeReadiness === 'BLOCKED'
    ? 'text-[#8A4B4B]'
    : isFinalized && routeReadiness === 'READY_TO_INVOICE'
      ? 'text-emerald-700'
      : isFinalized
        ? 'text-[#806238]'
    : card.status === 'IN_AUDIT'
      ? 'text-[#5B4A78]'
      : 'text-[#806238]'
  const linesCount = card.lines_count ?? null
  const isHighLineCount = linesCount != null && linesCount >= 17
  const linesLabel = linesCount == null ? '— líneas' : `${linesCount} ${linesCount === 1 ? 'línea' : 'líneas'}`
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const hasCommercialChange = commercialAlert?.status === 'CHANGED'

  const [isVerifyingCommercial, setIsVerifyingCommercial] = useState(false)
  const isClientBlocked = card.client_commercially_blocked === true || card.client_commercial_status === 'BLOCKED'
  const isClientUnknown = !card.client_commercial_status || card.client_commercial_status === 'UNKNOWN'

  const handleVerifyClientCommercial = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.preventDefault()
    if (isVerifyingCommercial) return
    setIsVerifyingCommercial(true)
    try {
      const result = onVerifyClientCommercial
        ? await onVerifyClientCommercial(card.card_id)
        : await verifyCardClientCommercialStatus(card.card_id)
      if (result.data?.applied === false) {
        toast.warning(result.error ?? 'La verificación fue descartada: existe un estado más reciente en la base de datos.')
        if (result.data.status && result.data.status !== 'UNKNOWN') {
          onClientCommercialStatusChange?.(card.card_id, {
            status: result.data.status,
            commerciallyBlocked: result.data.commerciallyBlocked,
            verifiedAt: result.data.verifiedAt,
          })
        }
      } else if (result.data?.status === 'UNBLOCKED') {
        toast.success(`Cliente desbloqueado en Bsale para NV #${card.nv_folio}`)
        onClientCommercialStatusChange?.(card.card_id, {
          status: 'UNBLOCKED',
          commerciallyBlocked: false,
          verifiedAt: result.data.verifiedAt,
        })
      } else if (result.data?.status === 'BLOCKED') {
        toast.warning(`Cliente continúa bloqueado en Bsale para NV #${card.nv_folio}`)
        onClientCommercialStatusChange?.(card.card_id, {
          status: 'BLOCKED',
          commerciallyBlocked: true,
          verifiedAt: result.data.verifiedAt,
        })
      } else {
        toast.error(result.error ?? 'No fue posible verificar el cliente en Bsale.')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al verificar en Bsale'
      toast.error(message)
    } finally {
      setIsVerifyingCommercial(false)
    }
  }

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: commercialMirror ? `commercial-incident-${card.card_id}` : card.card_id,
    data: { card },
    disabled: isOverlay || isPending || dragDisabled || commercialMirror
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
  } else if (commercialMirror) {
    wrapperClasses += 'cursor-pointer border-[#C97A70] bg-[#FFF7F5] shadow-xs hover:border-[#A94D43] hover:shadow-sm '
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
      ref={!isOverlay && !commercialMirror ? setNodeRef : undefined}
      style={style}
      {...(!isOverlay && !commercialMirror ? listeners : {})}
      {...(!isOverlay && !commercialMirror ? attributes : {})}
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
      aria-label={!isOverlay ? (commercialMirror ? `Abrir tareas comerciales de NV ${card.nv_folio}` : `Abrir detalle de NV ${card.nv_folio}`) : undefined}
      className={wrapperClasses}
    >
      <div className="flex items-center gap-1.5">
        {selectable && !isOverlay && !commercialMirror && (
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
        {commercialMirror && <span className="shrink-0 rounded bg-[#F5D8D2] px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[#8A4B4B]">Bsale</span>}
        <span
          className={`shrink-0 text-[10px] tabular-nums ${
            isHighLineCount
              ? 'font-bold text-red-600'
              : 'font-semibold text-[#322D29]/55'
          }`}
          title={linesLabel}
        >
          {linesLabel}
        </span>
      </div>

      <p
        className={`mt-0.5 truncate text-[11.5px] leading-snug transition-colors ${
          isClientBlocked
            ? 'font-bold text-red-700 group-hover:text-red-800'
            : 'font-semibold text-[#322D29] group-hover:text-[#72383D]'
        }`}
        title={isClientBlocked ? `${card.client_name} (Cliente bloqueado)` : card.client_name}
      >
        {card.client_name}
      </p>

      {isClientBlocked && (
        <div className="mt-0.5 flex items-center justify-between gap-1.5" data-testid={`card-client-blocked-${card.card_id}`}>
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700">
            <ShieldAlert className="h-3 w-3 shrink-0 text-red-600" />
            Cliente bloqueado
          </span>
          {canVerifyClientCommercial && !isOverlay && !commercialMirror && (
            <button
              type="button"
              data-card-action
              disabled={isVerifyingCommercial}
              onPointerDown={event => event.stopPropagation()}
              onClick={handleVerifyClientCommercial}
              className="inline-flex items-center gap-1 rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-800 hover:bg-red-100 disabled:opacity-60 transition-colors"
              title="Consultar bloqueo de cliente en Bsale"
            >
              <RefreshCw className={`h-2.5 w-2.5 ${isVerifyingCommercial ? 'animate-spin' : ''}`} />
              {isVerifyingCommercial ? 'Verificando…' : 'Verificar en Bsale'}
            </button>
          )}
        </div>
      )}

      {!isClientBlocked && isClientUnknown && canVerifyClientCommercial && !isOverlay && !commercialMirror && (
        <div className="mt-0.5 flex items-center justify-between gap-1.5 text-[9px] text-[#322D29]/60">
          <span className="italic">Estado no verificado</span>
          <button
            type="button"
            data-card-action
            disabled={isVerifyingCommercial}
            onPointerDown={event => event.stopPropagation()}
            onClick={handleVerifyClientCommercial}
            className="inline-flex items-center gap-0.5 rounded border border-[#B8ABA0]/40 bg-[#F5EDE9]/60 px-1 py-0.5 font-semibold text-[#72383D] hover:bg-[#F5EDE9] disabled:opacity-60 transition-colors"
            title="Verificar estado de cliente en Bsale"
          >
            <RefreshCw className={`h-2 w-2 ${isVerifyingCommercial ? 'animate-spin' : ''}`} />
            {isVerifyingCommercial ? 'Verificando…' : 'Verificar en Bsale'}
          </button>
        </div>
      )}

      {!isOverlay && !commercialMirror && <div className="mt-1.5"><PreparationCommercialChangeAlert alert={commercialAlert} compact /></div>}

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
            {(isFinalized || commercialMirror) && openCommercialIncidentCount > 0 && onOpenCommercialIncidents && (
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
                {commercialMirror ? `Ver tareas (${openCommercialIncidentCount})` : `${openCommercialIncidentCount} ${openCommercialIncidentCount === 1 ? 'tarea pendiente' : 'tareas pendientes'}`}
              </button>
            )}
            {isPending && (
              <span className="text-[9px] font-semibold uppercase tracking-wider text-[#806238]">Guardando…</span>
            )}
            {isReadyToInvoice && !isOverlay && !commercialMirror && onInvoice && (
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
            {isInvoiced && !isOverlay && !commercialMirror && onViewInvoice && (
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
            {canExclude && !isOverlay && !commercialMirror && card.status === 'PENDING_ROUTE_PREP' && (
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
