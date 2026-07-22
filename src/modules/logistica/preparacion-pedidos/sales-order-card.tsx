'use client'

import { MapPin, Package, User, Calendar } from 'lucide-react'
import { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import { useDraggable } from '@dnd-kit/core'

interface SalesOrderCardProps {
  card: SalesOrderPreparationCardInfo
  onClick?: () => void
  isOverlay?: boolean
}

export function SalesOrderCard({ card, onClick, isOverlay }: SalesOrderCardProps) {
  const emitDate = new Date(card.nv_emission_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
  const routeDate = card.route_date
    ? new Date(card.route_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
    : null

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.card_id,
    data: { card },
    disabled: isOverlay
  })

  const style = transform && !isOverlay ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined

  let wrapperClasses = "rounded flex flex-col p-2.5 transition-all group relative "
  if (isOverlay) {
    wrapperClasses += "z-[9999] shadow-xl ring-2 ring-theme-accent pointer-events-none cursor-grabbing opacity-100 "
  } else if (isDragging) {
    wrapperClasses += "opacity-50 cursor-grabbing bg-theme-base/60 border border-theme-border/80 "
  } else {
    wrapperClasses += "shadow-sm hover:shadow cursor-grab border "
  }

  if (!isDragging) {
    switch (card.status) {
      case 'PENDING_ROUTE_PREP':
        wrapperClasses += "bg-orange-50/50 dark:bg-orange-500/5 border-orange-200 dark:border-orange-500/20 hover:border-orange-300 dark:hover:border-orange-500/40"
        break
      case 'IN_PREPARATION':
        wrapperClasses += "bg-blue-50/50 dark:bg-blue-500/5 border-blue-200 dark:border-blue-500/20 hover:border-blue-300 dark:hover:border-blue-500/40"
        break
      case 'IN_AUDIT':
        wrapperClasses += "bg-purple-50/50 dark:bg-purple-500/5 border-purple-200 dark:border-purple-500/20 hover:border-purple-300 dark:hover:border-purple-500/40"
        break
      case 'INVOICED_READY_FOR_ROUTE':
        wrapperClasses += "bg-green-50/50 dark:bg-green-500/5 border-green-200 dark:border-green-500/20 hover:border-green-300 dark:hover:border-green-500/40"
        break
      case 'CANCELLED':
        wrapperClasses += "bg-red-50/50 dark:bg-red-500/5 border-red-200 dark:border-red-500/20 hover:border-red-300 dark:hover:border-red-500/40"
        break
      default:
        wrapperClasses += "bg-theme-panel border-theme-border/80 hover:border-theme-accent/60"
    }
  }

  return (
    <div
      ref={!isOverlay ? setNodeRef : undefined}
      style={style}
      {...(!isOverlay ? listeners : {})}
      {...(!isOverlay ? attributes : {})}
      onClick={!isOverlay ? onClick : undefined}
      className={wrapperClasses}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="inline-block px-1.5 py-0.5 bg-theme-base border border-theme-border/80 text-theme-text text-[10px] font-bold rounded">
          NV #{card.nv_folio}
        </span>
        <span className="text-[10px] text-theme-text-muted font-medium" title="Fecha de emisión de la Nota de Venta">Emisión: {emitDate}</span>
      </div>

      {/* Client */}
      <p className="font-bold text-[11px] text-theme-text line-clamp-2 mb-2 leading-snug group-hover:text-theme-accent transition-colors">
        {card.client_name}
      </p>

      {/* Meta */}
      <div className="space-y-1 mb-2 flex-1">
        <div className="flex items-center text-[10px] text-theme-text-muted font-medium gap-1.5">
          <MapPin className="w-3.5 h-3.5 shrink-0 opacity-80" />
          <span className="truncate">{card.normalized_city || card.city_raw || 'Sin ciudad'}</span>
        </div>
        <div className="flex items-center text-[10px] text-theme-text-muted font-medium gap-1.5">
          <User className="w-3.5 h-3.5 shrink-0 opacity-80" />
          <span className="truncate">{card.seller_name || 'Sin vendedor'}</span>
        </div>
        {routeDate && (
          <div className="flex items-center text-[10px] text-blue-500 font-bold gap-1.5">
            <Calendar className="w-3.5 h-3.5 shrink-0" />
            <span>Ruta: {routeDate}</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[10px] pt-2 border-t border-theme-border/50 mt-auto">
        <div className="flex items-center gap-1 font-bold text-theme-text-muted">
          <Package className="w-3.5 h-3.5 shrink-0" />
          {card.total_quantity} {card.total_quantity === 1 ? 'ítem' : 'ítems'}
        </div>
        {card.net_amount != null && (
          <span className="font-extrabold text-theme-text">
            ${card.net_amount.toLocaleString('es-CL')}
          </span>
        )}
      </div>
    </div>
  )
}
