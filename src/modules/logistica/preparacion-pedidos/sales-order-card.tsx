'use client'

import { MapPin, Package, User, Ban } from 'lucide-react'
import { useRef } from 'react'
import { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import { useDraggable } from '@dnd-kit/core'
import { getPreparationComuna } from './preparation-board-utils'

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
  const emitDate = new Date(card.nv_emission_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
  const routeDate = card.route_date
    ? new Date(card.route_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
    : null
  const comuna = getPreparationComuna(card)
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

  let wrapperClasses = "w-full border bg-white p-2.5 text-left transition-shadow group relative "
  if (isOverlay) {
    wrapperClasses += "pointer-events-none shadow-xl ring-2 ring-[#72383D] "
  } else if (isDragging) {
    wrapperClasses += "cursor-grabbing opacity-45 shadow-lg border-[#D1C7BD] "
  } else if (selected) {
    wrapperClasses += "cursor-pointer border-[#72383D] bg-[#FBF7F3] ring-1 ring-[#72383D]/40 shadow-sm "
  } else {
    wrapperClasses += `${isPending ? 'cursor-wait opacity-60 ' : 'cursor-pointer '}border-[#D1C7BD] hover:border-[#72383D] hover:shadow-sm `
  }

  const statusLabel = card.status === 'PENDING_ROUTE_PREP' ? 'Pendiente' : card.status === 'IN_PREPARATION' ? 'En preparación' : 'En auditoría'

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
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <div className="flex items-center gap-2 min-w-0">
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
              className={`flex h-4 w-4 shrink-0 items-center justify-center border transition-colors ${
                selected
                  ? 'border-[#72383D] bg-[#72383D] text-white'
                  : 'border-[#AC9C8D] bg-white text-transparent hover:border-[#72383D]'
              }`}
            >
              <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <span className="text-xs font-semibold text-[#322D29] truncate">NV #{card.nv_folio}</span>
        </div>
        <span className="text-[10px] text-[#322D29]/55 shrink-0" title="Fecha de emisión de la Nota de Venta">Emisión: {emitDate}</span>
      </div>

      {/* Comuna — señal operacional principal */}
      <div className="mb-2 flex items-center gap-1.5 border border-[#72383D]/25 bg-[#F5EDE9] px-2 py-1.5">
        <MapPin className="w-3.5 h-3.5 shrink-0 text-[#72383D]" />
        <span className="truncate text-[11px] font-bold uppercase tracking-[0.08em] text-[#72383D]" title={comuna}>
          {comuna}
        </span>
        {routeDate && (
          <span className="ml-auto shrink-0 text-[9px] font-semibold uppercase tracking-[0.06em] text-[#806238]" title="Fecha de ruta">
            Ruta {routeDate}
          </span>
        )}
      </div>

      {/* Client */}
      <p className="font-semibold text-xs text-[#322D29] line-clamp-2 leading-snug group-hover:text-[#72383D] transition-colors">
        {card.client_name}
      </p>

      {/* Meta */}
      <div className="space-y-1 mb-2 flex-1">
        <div className="flex items-center text-[10px] text-[#322D29]/55 font-medium gap-1.5">
          <User className="w-3.5 h-3.5 shrink-0 opacity-80" />
          <span className="truncate">{card.seller_name || 'Sin vendedor'}</span>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[10px] pt-2 border-t border-[#D1C7BD]/70 mt-auto">
        <div className="flex items-center gap-1 font-semibold text-[#322D29]/55">
          <Package className="w-3.5 h-3.5 shrink-0" />
          {card.total_quantity} {card.total_quantity === 1 ? 'unidad' : 'unidades'}
        </div>
        {card.net_amount != null && (
          <span className="font-semibold text-[#322D29]">
            ${card.net_amount.toLocaleString('es-CL')}
          </span>
        )}
      </div>
      <span className="mt-2 inline-flex w-fit border border-[#AC9C8D]/30 bg-[#F5F0EA] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#6B625C]">{isPending ? 'Guardando…' : statusLabel}</span>
      {canExclude && !isOverlay && card.status === 'PENDING_ROUTE_PREP' && (
        <button
          type="button"
          data-card-action
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onExclude?.(card)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          className="mt-1.5 inline-flex w-fit items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#8A4B4B] underline-offset-2 hover:text-[#72383D] hover:underline"
        >
          <Ban className="w-3 h-3" />
          Excluir de preparación
        </button>
      )}
    </div>
  )
}
