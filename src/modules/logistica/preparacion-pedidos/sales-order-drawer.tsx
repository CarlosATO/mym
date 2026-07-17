'use client'

import { X, MapPin, Package, User, FileText, FileCheck, CheckCircle2, Printer } from 'lucide-react'
import { SalesOrderPreparationCardInfo, SalesOrderPreparationItem, getSalesOrderClientData, SalesOrderClientData, moveSalesOrderPreparationCard, getSalesOrderPreparationMovements, SalesOrderPreparationMovement } from '@/app/actions/logistica/sales-order-preparation'
import { SalesOrderPrintDocument } from './components/sales-order-print-document'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'

interface SalesOrderDrawerProps {
  card: SalesOrderPreparationCardInfo | null
  items: SalesOrderPreparationItem[]
  isLoadingItems: boolean
  onClose: () => void
  onCardMoved?: () => void
}

export function SalesOrderDrawer({ card, items, isLoadingItems, onClose, onCardMoved }: SalesOrderDrawerProps) {
  const [clientData, setClientData] = useState<SalesOrderClientData | null>(null)
  
  const [movements, setMovements] = useState<SalesOrderPreparationMovement[]>([])
  const [loadingMovements, setLoadingMovements] = useState(false)
  
  const [pendingMoveAction, setPendingMoveAction] = useState<{ toStatus: string; requireObs: boolean; label: string } | null>(null)
  const [observation, setObservation] = useState('')
  const [isMoving, setIsMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)

  useEffect(() => {
    if (card?.company_id && card?.nv_bsale_id) {
      getSalesOrderClientData(card.company_id, card.nv_bsale_id).then((res) => {
        if (res.data) setClientData(res.data)
      })
    }
  }, [card?.company_id, card?.nv_bsale_id])

  const loadMovements = async () => {
    if (!card?.card_id) return
    setLoadingMovements(true)
    const res = await getSalesOrderPreparationMovements(card.card_id)
    setMovements(res.data || [])
    setLoadingMovements(false)
  }

  useEffect(() => {
    if (card?.card_id) {
      loadMovements()
    } else {
      setMovements([])
    }
    setPendingMoveAction(null)
    setObservation('')
    setMoveError(null)
  }, [card?.card_id])

  if (!card) return null

  const handleMove = async (toStatus: string, requireObs: boolean, label: string) => {
    if (requireObs) {
      setPendingMoveAction({ toStatus, requireObs, label })
      setObservation('')
      setMoveError(null)
      return
    }
    executeMove(toStatus)
  }

  const executeMove = async (toStatus: string, obs?: string) => {
    setIsMoving(true)
    setMoveError(null)
    const res = await moveSalesOrderPreparationCard({
      cardId: card.card_id,
      toStatus,
      observation: obs
    })
    setIsMoving(false)
    if (!res.ok) {
      setMoveError(res.error ?? 'Error desconocido')
      toast.error(`Error al mover: ${res.error ?? 'Desconocido'}`)
      return
    }
    toast.success(`NV #${card.nv_folio} movida exitosamente`)
    setPendingMoveAction(null)
    await loadMovements()
    if (onCardMoved) onCardMoved()
  }

  const dateStr = new Date(card.nv_emission_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
  const firstPrepMovement = movements.find(m => m.to_status === 'IN_PREPARATION')


  return (
    <>
      <div className="hidden print:block print:absolute print:inset-0 print:bg-white print:z-[9999]">
        <style>{`
          @media print {
            body * { visibility: hidden !important; }
            .sales-order-print-container, .sales-order-print-container * { visibility: visible !important; }
            .sales-order-print-container { 
              position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; margin: 0; padding: 0;
            }
            .drawer-no-print { display: none !important; }
          }
        `}</style>
        <div className="sales-order-print-container">
          <SalesOrderPrintDocument card={card} items={items} clientData={clientData} />
        </div>
      </div>

      <div 
        className="fixed inset-0 bg-theme-base/80 backdrop-blur-sm z-50 transition-opacity drawer-no-print" 
        onClick={onClose} 
      />
      
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-xl bg-theme-panel border-l border-theme-border shadow-2xl flex flex-col transition-transform transform drawer-no-print">
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
                <p className="text-xs font-medium text-theme-accent mt-1">
                  Preparación: {firstPrepMovement ? new Date(firstPrepMovement.created_at).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Sin iniciar'}
                </p>
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
                Neto: ${card.net_amount?.toLocaleString('es-CL')}
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
                        {item.line_net_amount != null ? (
                          <p className="text-xs font-semibold text-theme-text">${item.line_net_amount.toLocaleString('es-CL')}</p>
                        ) : (
                          <p className="text-xs font-semibold text-red-500">Sin dato neto</p>
                        )}
                        {item.unit_net_value != null && (
                          <p className="text-[10px] text-theme-text-muted">c/u ${item.unit_net_value.toLocaleString('es-CL')}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Historial de Movimientos */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-theme-text uppercase tracking-wider flex items-center gap-2">
              Historial de Movimientos ({movements.length})
            </h3>
            <div className="bg-theme-border/10 rounded-xl p-4 max-h-[200px] overflow-y-auto text-xs text-theme-text space-y-2">
              {loadingMovements ? (
                <div className="text-center text-theme-text-muted">Cargando historial...</div>
              ) : movements.length === 0 ? (
                <div className="text-center text-theme-text-muted">Sin movimientos registrados.</div>
              ) : (
                movements.map(m => (
                  <div key={m.id} className="pb-2 border-b border-theme-border/50 last:border-0 last:pb-0">
                    <p className="font-medium">{m.metadata?.moved_by_name || 'Sistema'}</p>
                    <p className="text-theme-text-muted">
                      {new Date(m.created_at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <p className="mt-1">
                      <span className="text-theme-text-muted/60">{m.from_status ? m.from_status.replace(/_/g, ' ') : 'N/A'}</span>
                      <span className="mx-1">→</span>
                      <span className="font-semibold text-theme-accent">{m.to_status.replace(/_/g, ' ')}</span>
                    </p>
                    {m.observation && <p className="mt-1 italic opacity-80 text-orange-400">Obs: {m.observation}</p>}
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
        
        {/* Movimientos UI */}
        {pendingMoveAction && (
          <div className="p-4 bg-theme-panel-hover border-t border-theme-border">
            <p className="text-sm font-medium mb-2 text-theme-text">Observación requerida para: <span className="font-bold">{pendingMoveAction.label}</span></p>
            <textarea
              className="w-full bg-theme-base border border-theme-border rounded-lg p-2 text-sm text-theme-text mb-2 focus:border-theme-accent outline-none"
              placeholder="Indica el motivo de este cambio..."
              rows={3}
              value={observation}
              onChange={e => setObservation(e.target.value)}
            />
            {moveError && <p className="text-xs text-red-500 mb-2">{moveError}</p>}
            <div className="flex gap-2">
              <button 
                disabled={isMoving || observation.trim() === ''}
                onClick={() => executeMove(pendingMoveAction.toStatus, observation)}
                className="flex-1 py-2 bg-theme-accent text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {isMoving ? 'Guardando...' : 'Confirmar'}
              </button>
              <button 
                onClick={() => setPendingMoveAction(null)}
                className="flex-1 py-2 bg-theme-border/50 text-theme-text rounded-lg text-sm font-medium"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex-none p-4 border-t border-theme-border bg-theme-panel">
          {moveError && !pendingMoveAction && <p className="text-xs text-red-500 mb-3 text-center">{moveError}</p>}
          
          {!pendingMoveAction && card.status === 'PENDING_ROUTE_PREP' && (
            <div className="flex gap-2 mb-3">
              <button onClick={() => handleMove('IN_PREPARATION', false, 'Iniciar preparación')} disabled={isMoving} className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                Iniciar preparación
              </button>
            </div>
          )}

          {!pendingMoveAction && card.status === 'IN_PREPARATION' && (
            <div className="flex gap-2 mb-3">
              <button onClick={() => handleMove('IN_AUDIT', false, 'Enviar a auditoría')} disabled={isMoving} className="flex-1 py-2 bg-purple-600 hover:bg-purple-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                Enviar a auditoría
              </button>
              <button onClick={() => handleMove('PENDING_ROUTE_PREP', true, 'Volver a pendiente')} disabled={isMoving} className="flex-1 py-2 bg-orange-600 hover:bg-orange-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                Volver a pendiente
              </button>
            </div>
          )}

          {!pendingMoveAction && card.status === 'IN_AUDIT' && (
            <div className="flex gap-2 mb-3">
              <button onClick={() => handleMove('IN_PREPARATION', true, 'Devolver a preparación')} disabled={isMoving} className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                Devolver a preparación
              </button>
              <button onClick={() => handleMove('PENDING_ROUTE_PREP', true, 'Rechazar / volver a pendiente')} disabled={isMoving} className="flex-1 py-2 bg-orange-600 hover:bg-orange-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                Rechazar (Pendiente)
              </button>
            </div>
          )}

          {!pendingMoveAction && card.status === 'INVOICED_READY_FOR_ROUTE' && (
            <div className="mb-3 text-center text-xs text-theme-text-muted bg-theme-border/20 p-2 rounded-lg">
              Movimiento automático al detectar factura en Bsale. Sin acciones manuales.
            </div>
          )}

          <div className="flex gap-3">
            <button 
              onClick={() => window.print()}
              className="flex-1 py-2.5 px-4 bg-theme-border/20 hover:bg-theme-border/40 text-theme-text font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              <Printer className="w-4 h-4" /> Imprimir
            </button>
            <button 
              onClick={onClose}
              className="flex-1 py-2.5 px-4 bg-theme-border/50 hover:bg-theme-border/80 text-theme-text font-medium rounded-xl transition-colors"
            >
              Cerrar detalle
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
