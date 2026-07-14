'use client'

import { MapPin, Package, User } from 'lucide-react'
import { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'

interface SalesOrderCardProps {
  card: SalesOrderPreparationCardInfo
  onClick: () => void
}

export function SalesOrderCard({ card, onClick }: SalesOrderCardProps) {
  const dateStr = new Date(card.nv_emission_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' })

  return (
    <div 
      onClick={onClick}
      className="bg-theme-panel border border-theme-border rounded-xl p-4 shadow-sm hover:border-theme-accent/50 hover:shadow-md transition-all cursor-pointer group"
    >
      <div className="flex justify-between items-start mb-3">
        <div>
          <span className="inline-block px-2 py-1 bg-theme-accent/10 text-theme-accent text-xs font-bold rounded-md">
            NV #{card.nv_folio}
          </span>
        </div>
        <span className="text-[10px] font-medium text-theme-text-muted uppercase tracking-wider">
          {dateStr}
        </span>
      </div>

      <h3 className="font-semibold text-sm text-theme-text line-clamp-1 mb-3 group-hover:text-theme-accent transition-colors">
        {card.client_name}
      </h3>

      <div className="space-y-2">
        <div className="flex items-center text-xs text-theme-text-muted">
          <MapPin className="w-3.5 h-3.5 mr-1.5 shrink-0 opacity-70" />
          <span className="truncate">{card.normalized_city || card.city_raw || 'Sin ciudad'}</span>
        </div>
        <div className="flex items-center text-xs text-theme-text-muted">
          <User className="w-3.5 h-3.5 mr-1.5 shrink-0 opacity-70" />
          <span className="truncate">{card.seller_name || 'Sin vendedor asignado'}</span>
        </div>
        <div className="flex items-center justify-between text-xs pt-2 mt-2 border-t border-theme-border/50">
          <div className="flex items-center font-medium text-theme-text">
            <Package className="w-3.5 h-3.5 mr-1.5 shrink-0 text-theme-accent opacity-80" />
            {card.total_quantity} {card.total_quantity === 1 ? 'ítem' : 'ítems'}
          </div>
          {card.total_amount && (
            <span className="font-semibold text-theme-text">
              ${card.total_amount.toLocaleString('es-CL')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
