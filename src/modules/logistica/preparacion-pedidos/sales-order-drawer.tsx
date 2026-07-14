'use client'

import { X, MapPin, Package, User, FileText, FileCheck, CheckCircle2 } from 'lucide-react'
import { SalesOrderPreparationCardInfo, SalesOrderPreparationItem } from '@/app/actions/logistica/sales-order-preparation'

interface SalesOrderDrawerProps {
  card: SalesOrderPreparationCardInfo | null
  items: SalesOrderPreparationItem[]
  isLoadingItems: boolean
  onClose: () => void
}

export function SalesOrderDrawer({ card, items, isLoadingItems, onClose }: SalesOrderDrawerProps) {
  if (!card) return null

  const dateStr = new Date(card.nv_emission_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })


  return (
    <>
      <div 
        className="fixed inset-0 bg-theme-base/80 backdrop-blur-sm z-50 transition-opacity" 
        onClick={onClose} 
      />
      
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-theme-panel border-l border-theme-border shadow-2xl flex flex-col transition-transform transform">
        {/* Header */}
        <div className="flex-none px-6 py-4 border-b border-theme-border bg-theme-panel-hover/50 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text flex items-center gap-2">
              <FileText className="w-5 h-5 text-theme-accent" />
              NV #{card.nv_folio}
            </h2>
            <p className="text-sm text-theme-text-muted mt-0.5">
              Emitida: {dateStr}
            </p>
          </div>
          <button 
            onClick={onClose}
            className="p-2 text-theme-text-muted hover:text-theme-text hover:bg-theme-border/50 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Info Client & Route */}
          <div className="bg-theme-border/20 rounded-xl p-4 space-y-4">
            <div>
              <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1">Cliente</p>
              <p className="font-medium text-theme-text text-sm">{card.client_name}</p>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" /> Ciudad
                </p>
                <p className="font-medium text-theme-text text-sm">{card.normalized_city || card.city_raw || 'Sin ciudad'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
                  <User className="w-3.5 h-3.5" /> Vendedor
                </p>
                <p className="font-medium text-theme-text text-sm truncate" title={card.seller_name || ''}>{card.seller_name || 'Sin asignar'}</p>
              </div>
            </div>
          </div>

          {/* Estado Operativo */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-theme-text uppercase tracking-wider flex items-center gap-2">
              Estado Operativo
            </h3>
            <div className="bg-theme-border/20 rounded-xl p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-theme-text">
                  {card.status === 'PENDING_ROUTE_PREP' && 'Pendiente / Próxima ruta'}
                  {card.status === 'IN_PREPARATION' && 'En preparación'}
                  {card.status === 'IN_AUDIT' && 'En auditoría'}
                  {card.status === 'INVOICED_READY_FOR_ROUTE' && 'Lista para despacho'}
                  {card.status === 'CANCELLED' && 'Cancelada'}
                </p>
                {card.route_date && (
                  <p className="text-xs text-theme-text-muted mt-1">Ruta: {new Date(card.route_date).toLocaleDateString('es-CL')}</p>
                )}
              </div>
              <div className={`px-3 py-1 rounded-full text-xs font-semibold
                ${card.status === 'PENDING_ROUTE_PREP' ? 'bg-orange-500/10 text-orange-500' : ''}
                ${card.status === 'IN_PREPARATION' ? 'bg-blue-500/10 text-blue-500' : ''}
                ${card.status === 'IN_AUDIT' ? 'bg-purple-500/10 text-purple-500' : ''}
                ${card.status === 'INVOICED_READY_FOR_ROUTE' ? 'bg-green-500/10 text-green-500' : ''}
                ${card.status === 'CANCELLED' ? 'bg-red-500/10 text-red-500' : ''}
              `}>
                {card.status.replace(/_/g, ' ')}
              </div>
            </div>
          </div>

          {/* Facturación */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-theme-text uppercase tracking-wider flex items-center gap-2">
              Facturación Bsale
            </h3>
            <div className="border border-theme-border rounded-xl p-4">
              {card.is_invoiced ? (
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-theme-text">Factura detectada</p>
                    <p className="text-sm text-theme-text-muted">Folio: {card.invoice_folio}</p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <FileCheck className="w-5 h-5 text-theme-text-muted/60 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-theme-text">No facturada</p>
                    <p className="text-xs text-theme-text-muted mt-1">
                      Factura asociada aún no detectada desde Bsale. El movimiento a columna "Facturada" ocurrirá automáticamente.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Items */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-theme-text uppercase tracking-wider flex items-center gap-2">
                <Package className="w-4 h-4" /> Productos ({card.total_quantity})
              </h3>
              <span className="text-sm font-medium text-theme-text">
                Total: ${card.total_amount?.toLocaleString('es-CL')}
              </span>
            </div>
            
            <div className="border border-theme-border rounded-xl overflow-hidden">
              {isLoadingItems ? (
                <div className="p-8 text-center text-sm text-theme-text-muted">
                  Cargando productos...
                </div>
              ) : items.length === 0 ? (
                <div className="p-8 text-center text-sm text-theme-text-muted">
                  No se encontraron productos en esta nota de venta.
                </div>
              ) : (
                <div className="divide-y divide-theme-border max-h-[300px] overflow-y-auto">
                  {items.map((item) => (
                    <div key={item.detail_id} className="p-3 hover:bg-theme-border/10 flex items-start gap-3">
                      <div className="bg-theme-border/30 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold text-theme-text">
                        x{item.quantity}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-theme-text truncate">{item.product_name}</p>
                        {item.sku && <p className="text-xs text-theme-text-muted mt-0.5">SKU: {item.sku}</p>}
                      </div>
                      <div className="text-right shrink-0">
                        {item.total_amount != null && (
                          <p className="text-xs font-semibold text-theme-text">${item.total_amount.toLocaleString('es-CL')}</p>
                        )}
                        {item.unit_value != null && (
                          <p className="text-[10px] text-theme-text-muted">c/u ${item.unit_value.toLocaleString('es-CL')}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>
        
        {/* Footer */}
        <div className="flex-none p-4 border-t border-theme-border bg-theme-panel">
          <button 
            onClick={onClose}
            className="w-full py-2.5 px-4 bg-theme-border/50 hover:bg-theme-border/80 text-theme-text font-medium rounded-xl transition-colors"
          >
            Cerrar detalle
          </button>
        </div>
      </div>
    </>
  )
}
