'use client'

import { MapPin, Package, User, Ban } from 'lucide-react'
import { useRef } from 'react'
import { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import { useDraggable } from '@dnd-kit/core'
import { formatPreparationClp, getPreparationCardAmount, getPreparationComuna } from './preparation-board-utils'

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
}

function formatShortDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date
    .toLocaleDateString('es-CL', { day: '2-digit', month: 'short' })
    .replace('.', '')
    .toUpperCase()
}

function formatFullDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
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
}: SalesOrderCardProps) {
  const routeDate = formatShortDate(card.route_date)
  const routeFullDate = formatFullDate(card.route_date)
  const emissionDate = formatShortDate(card.nv_emission_date)
  const emissionFullDate = formatFullDate(card.nv_emission_date)
  const primaryDate = routeDate
    ? { label: 'Ruta', value: routeDate, title: `Fecha de ruta: ${routeFullDate ?? '—'}` }
    : { label: 'Emisión', value: emissionDate ?? '—', title: `Fecha de emisión: ${emissionFullDate ?? '—'}` }
  const comuna = getPreparationComuna(card)
  const amount = getPreparationCardAmount(card)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.card_id,
    data: { card },
    disabled: isOverlay || isPending
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

  let wrapperClasses = "w-full rounded-lg border bg-white p-3.5 text-left transition-all duration-150 group relative "
  if (isOverlay) {
    wrapperClasses += "pointer-events-none shadow-xl ring-2 ring-[#72383D] rotate-1 scale-[1.02] "
  } else if (isDragging) {
    wrapperClasses += "cursor-grabbing opacity-40 shadow-sm border-[#D1C7BD] "
  } else if (selected) {
    wrapperClasses += "cursor-pointer border-[#72383D] bg-[#FCF8F5] ring-1 ring-[#72383D]/40 shadow-xs "
  } else {
    wrapperClasses += `${isPending ? 'cursor-wait opacity-60 ' : 'cursor-pointer '}border-[#D8CFC5] shadow-xs hover:border-[#72383D]/70 hover:shadow-sm `
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
      <div className="flex items-start gap-2.5">
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
            className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border transition-colors ${
              selected
                ? 'border-[#72383D] bg-[#72383D] text-white'
                : 'border-[#B8ABA0] bg-white text-transparent hover:border-[#72383D] hover:bg-[#F5F0EA]'
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="truncate text-sm font-bold tracking-tight text-[#322D29]">NV #{card.nv_folio}</span>
            <div className="shrink-0 text-right leading-none" title={primaryDate.title}>
              <p className="text-[10px] font-bold uppercase tracking-wider text-[#806238]">{primaryDate.label}</p>
              <p className="mt-1 text-[13px] font-bold tabular-nums text-[#322D29]">{primaryDate.value}</p>
            </div>
          </div>

          <p className="mt-1 line-clamp-2 text-[13px] font-semibold leading-snug text-[#322D29] transition-colors group-hover:text-[#72383D]">
            {card.client_name}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-[#72383D]/25 bg-[#F8F2EE] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[#72383D]" title={comuna}>
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{comuna}</span>
            </span>
            {routeDate && (
              <span className="text-[11px] font-normal text-[#322D29]/60" title={`Fecha de emisión: ${emissionFullDate ?? '—'}`}>
                Emisión {emissionDate ?? '—'}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-2 border-t border-[#E8DFD5] pt-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-[11px] font-medium text-[#322D29]/60" title={card.seller_name || 'Sin vendedor'}>
            <User className="h-3 w-3 shrink-0 opacity-70" />
            <span className="truncate">{card.seller_name || 'Sin vendedor'}</span>
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-[#322D29]/80">
            <Package className="h-3 w-3 shrink-0 opacity-70" />
            {card.total_quantity} {card.total_quantity === 1 ? 'unidad' : 'unidades'}
          </p>
        </div>
        {amount != null && (
          <p className="shrink-0 text-[15px] font-bold tabular-nums leading-none text-[#322D29]" title="Monto total de la Nota de Venta">
            {formatPreparationClp(amount)}
          </p>
        )}
      </div>

      <div className="mt-1.5 flex min-h-[14px] items-center justify-between gap-2">
        {isPending ? (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#806238]">Guardando…</span>
        ) : <span />}
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
            className="inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#8A4B4B] hover:bg-[#8A4B4B]/10 hover:text-[#72383D] transition-colors"
          >
            <Ban className="h-3 w-3" />
            Excluir
          </button>
        )}
      </div>
    </div>
  )
}
