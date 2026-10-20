'use client'

import { Ban } from 'lucide-react'
import { useRef } from 'react'
import { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import { useDraggable } from '@dnd-kit/core'
import { formatPreparationClp, getPreparationCardAmount, getPreparationComuna, parseDateOnly } from './preparation-board-utils'
import { getPreparationLockLabel } from './preparation-lock-policy'

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
  const responsibilityLabel = isFinalized ? 'Auditada' : auditLabel ?? lockLabel
  const responsibilityTone = isFinalized
    ? 'text-emerald-700'
    : card.status === 'IN_AUDIT'
      ? 'text-[#5B4A78]'
      : 'text-[#806238]'
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)

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
  } else if (selected) {
    wrapperClasses += "cursor-pointer border-[#72383D] bg-[#FCF8F5] ring-1 ring-[#72383D]/40 shadow-xs "
  } else {
    wrapperClasses += `${isPending ? 'cursor-wait opacity-60 ' : 'cursor-pointer '}`
    wrapperClasses += isFinalized
      ? 'border-emerald-200 bg-[#F7FBF7] shadow-xs hover:border-emerald-300 hover:shadow-sm '
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

      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] font-medium text-[#322D29]/55" title={`${comuna} · ${primaryDate.title}`}>
          {comuna}
          <span className="px-0.5 text-[#322D29]/30">·</span>
          {primaryDate.value}
        </span>
        {amount != null && (
          <span className="shrink-0 text-[11px] font-bold tabular-nums leading-none text-[#322D29]" title="Monto total de la Nota de Venta">
            {formatPreparationClp(amount)}
          </span>
        )}
      </div>

      {(responsibilityLabel || isPending || (canExclude && !isOverlay && card.status === 'PENDING_ROUTE_PREP')) && (
        <div className="mt-1 flex min-h-[15px] items-center justify-between gap-2">
          <span className={`min-w-0 truncate text-[9.5px] font-semibold ${responsibilityTone}`} title={responsibilityLabel ?? undefined}>
            {isFinalized ? '✓ ' : ''}{responsibilityLabel}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {isPending && (
              <span className="text-[9px] font-semibold uppercase tracking-wider text-[#806238]">Guardando…</span>
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
