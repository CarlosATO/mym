'use client'

import { MapPin, Package, User, Calendar } from 'lucide-react'
import { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import { useDraggable } from '@dnd-kit/core'

interface SalesOrderCardProps {
  card: SalesOrderPreparationCardInfo
  onDoubleClick?: () => void
  isOverlay?: boolean
  isPending?: boolean
}

export function SalesOrderCard({ card, onDoubleClick, isOverlay, isPending = false }: SalesOrderCardProps) {
  const emitDate = new Date(card.nv_emission_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
  const routeDate = card.route_date
    ? new Date(card.route_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
    : null

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.card_id,
    data: { card },
    disabled: isOverlay || isPending
  })

  const style = transform && !isOverlay ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined

  let wrapperClasses = "w-full border bg-white p-2.5 text-left transition-shadow group relative "
  if (isOverlay) {
    wrapperClasses += "pointer-events-none shadow-xl ring-2 ring-[#72383D] "
  } else if (isDragging) {
    wrapperClasses += "cursor-grabbing opacity-45 shadow-lg border-[#D1C7BD] "
  } else {
    wrapperClasses += `${isPending ? 'cursor-wait opacity-60 ' : 'cursor-grab '}border-[#D1C7BD] hover:border-[#72383D] hover:shadow-sm `
  }

  const statusLabel = card.status === 'PENDING_ROUTE_PREP' ? 'Pendiente' : card.status === 'IN_PREPARATION' ? 'En preparación' : 'En auditoría'

  return (
    <div
      ref={!isOverlay ? setNodeRef : undefined}
      style={style}
      {...(!isOverlay ? listeners : {})}
      {...(!isOverlay ? attributes : {})}
       onDoubleClick={!isOverlay ? onDoubleClick : undefined}
       onKeyDown={!isOverlay ? event => {
         if (event.key === 'Enter' || event.key === ' ') {
           event.preventDefault()
           onDoubleClick?.()
         }
       } : undefined}
       role={!isOverlay ? 'button' : undefined}
       tabIndex={!isOverlay ? 0 : undefined}
       aria-label={!isOverlay ? `Abrir detalle de NV ${card.nv_folio}` : undefined}
      className={wrapperClasses}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
         <span className="text-xs font-semibold text-[#322D29]">NV #{card.nv_folio}</span>
         <span className="text-[10px] text-[#322D29]/55" title="Fecha de emisión de la Nota de Venta">Emisión: {emitDate}</span>
      </div>

      {/* Client */}
       <p className="font-semibold text-xs text-[#322D29] line-clamp-2 leading-snug group-hover:text-[#72383D] transition-colors">
        {card.client_name}
      </p>

      {/* Meta */}
      <div className="space-y-1 mb-2 flex-1">
         <div className="flex items-center text-[10px] text-[#322D29]/55 font-medium gap-1.5">
           <MapPin className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{card.normalized_city || card.city_raw || 'Sin ciudad'}</span>
        </div>
         <div className="flex items-center text-[10px] text-[#322D29]/55 font-medium gap-1.5">
          <User className="w-3.5 h-3.5 shrink-0 opacity-80" />
          <span className="truncate">{card.seller_name || 'Sin vendedor'}</span>
        </div>
        {routeDate && (
             <div className="flex items-center text-[10px] text-[#806238] font-semibold gap-1.5">
            <Calendar className="w-3.5 h-3.5 shrink-0" />
            <span>Ruta: {routeDate}</span>
          </div>
        )}
      </div>

      {/* Footer */}
       <div className="flex items-center justify-between text-[10px] pt-2 border-t border-[#D1C7BD]/70 mt-auto">
         <div className="flex items-center gap-1 font-semibold text-[#322D29]/55">
          <Package className="w-3.5 h-3.5 shrink-0" />
          {card.total_quantity} {card.total_quantity === 1 ? 'ítem' : 'ítems'}
        </div>
        {card.net_amount != null && (
             <span className="font-semibold text-[#322D29]">
            ${card.net_amount.toLocaleString('es-CL')}
          </span>
        )}
      </div>
      <span className="mt-2 inline-flex w-fit border border-[#AC9C8D]/30 bg-[#F5F0EA] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#6B625C]">{isPending ? 'Guardando…' : statusLabel}</span>
    </div>
  )
}
