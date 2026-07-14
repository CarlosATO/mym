'use client'

import { MapPin, Package, User, Calendar } from 'lucide-react'
import { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'

interface SalesOrderCardProps {
  card: SalesOrderPreparationCardInfo
  onClick: () => void
}

export function SalesOrderCard({ card, onClick }: SalesOrderCardProps) {
  const emitDate = new Date(card.nv_emission_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
  const routeDate = card.route_date
    ? new Date(card.route_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })
    : null

  return (
    <div
      onClick={onClick}
      className="bg-theme-panel border border-theme-border rounded-lg p-2.5 shadow-sm hover:border-theme-accent/40 hover:shadow-md transition-all cursor-pointer group"
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="inline-block px-1.5 py-0.5 bg-theme-accent/10 text-theme-accent text-[10px] font-bold rounded">
          NV #{card.nv_folio}
        </span>
        <span className="text-[10px] text-theme-text-muted">{emitDate}</span>
      </div>

      {/* Client */}
      <p className="font-semibold text-xs text-theme-text line-clamp-2 mb-2 group-hover:text-theme-accent transition-colors leading-snug">
        {card.client_name}
      </p>

      {/* Meta */}
      <div className="space-y-1">
        <div className="flex items-center text-[10px] text-theme-text-muted gap-1">
          <MapPin className="w-3 h-3 shrink-0 opacity-70" />
          <span className="truncate">{card.normalized_city || card.city_raw || 'Sin ciudad'}</span>
        </div>
        <div className="flex items-center text-[10px] text-theme-text-muted gap-1">
          <User className="w-3 h-3 shrink-0 opacity-70" />
          <span className="truncate">{card.seller_name || 'Sin vendedor'}</span>
        </div>
        {routeDate && (
          <div className="flex items-center text-[10px] text-blue-400 gap-1">
            <Calendar className="w-3 h-3 shrink-0" />
            <span>Ruta: {routeDate}</span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[10px] pt-2 mt-2 border-t border-theme-border/40">
        <div className="flex items-center gap-1 font-medium text-theme-text">
          <Package className="w-3 h-3 shrink-0 text-theme-accent opacity-80" />
          {card.total_quantity} {card.total_quantity === 1 ? 'ítem' : 'ítems'}
        </div>
        {card.total_amount != null && (
          <span className="font-semibold text-theme-text">
            ${card.total_amount.toLocaleString('es-CL')}
          </span>
        )}
      </div>
    </div>
  )
}
