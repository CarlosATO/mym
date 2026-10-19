'use client'

import { X, MapPin, Package, User, FileText, FileCheck, CheckCircle2, Printer, Building2, Hash } from 'lucide-react'
import { SalesOrderPreparationCardInfo, SalesOrderPreparationItem, getSalesOrderClientData, SalesOrderClientData, getSalesOrderPreparationMovements, SalesOrderPreparationMovement } from '@/app/actions/logistica/sales-order-preparation'
import { generatePreparationOrdersPdf, openPreparationOrdersPdf } from '@/lib/pdf/generate-preparation-orders-pdf'
import { useState, useEffect } from 'react'
import { MOVEMENT_RULES } from './movement-rules'

interface SalesOrderDrawerProps {
  card: SalesOrderPreparationCardInfo | null
  items: SalesOrderPreparationItem[]
  isLoadingItems: boolean
  onClose: () => void
  onTransition: (card: SalesOrderPreparationCardInfo, toStatus: string, observation?: string) => Promise<boolean>
}

const statusLabel = (status: string) => status === 'PENDING_ROUTE_PREP' ? 'Pendiente' : status === 'IN_PREPARATION' ? 'En preparación' : status === 'IN_AUDIT' ? 'En auditoría' : 'Estado operativo'

function openBlankPdfWindow(): Window | null {
  try {
    return window.open('', '_blank')
  } catch {
    return null
  }
}

function closePdfWindow(target: Window | null) {
  try {
    if (target && !target.closed) target.close()
  } catch {
    // El navegador puede bloquear el cierre; no es un error operacional.
  }
}

export function SalesOrderDrawer({ card, items, isLoadingItems, onClose, onTransition }: SalesOrderDrawerProps) {
  const [clientData, setClientData] = useState<SalesOrderClientData | null>(null)
  
  const [movements, setMovements] = useState<SalesOrderPreparationMovement[]>([])
  const [loadingMovements, setLoadingMovements] = useState(false)
  
  const [pendingMoveAction, setPendingMoveAction] = useState<{ toStatus: string; requireObs: boolean; label: string } | null>(null)
  const [observation, setObservation] = useState('')
  const [isMoving, setIsMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [isPrinting, setIsPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)

  // This loader synchronizes the drawer history when the selected card changes.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    let cancelled = false
    setClientData(null)

    if (card?.company_id && card?.nv_bsale_id) {
      getSalesOrderClientData(card.company_id, card.nv_bsale_id).then((res) => {
        if (!cancelled && res.data) setClientData(res.data)
      })
    }

    return () => {
      cancelled = true
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
    setPrintError(null)
  }, [card?.card_id])
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  if (!card) return null

  const handleMove = async (toStatus: string, requireObs: boolean, label: string) => {
    if (requireObs) {
      setPendingMoveAction({ toStatus, requireObs, label })
      setObservation('')
      setMoveError(null)
      return
    }
    void executeMove(toStatus)
  }

  const executeMove = async (toStatus: string, obs?: string) => {
    setIsMoving(true)
    setMoveError(null)
    const ok = await onTransition(card, toStatus, obs)
    setIsMoving(false)
    if (!ok) {
      setMoveError('No se pudo guardar el cambio. La tarjeta volvió a su estado anterior.')
      return
    }
    setPendingMoveAction(null)
    await loadMovements()
  }

  const dateStr = new Date(card.nv_emission_date).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
  const firstPrepMovement = movements.find(m => m.to_status === 'IN_PREPARATION')
  const canPrint = !isLoadingItems
  const comuna = card.normalized_city || card.municipality_raw || card.city_raw || 'Sin comuna'

  const handlePrintOnly = () => {
    if (!canPrint || isPrinting) return

    const printWindow = openBlankPdfWindow()
    setIsPrinting(true)
    setPrintError(null)

    try {
      const blob = generatePreparationOrdersPdf([{ card, items, clientData }])
      openPreparationOrdersPdf(blob, printWindow, `preparacion-nv-${card.nv_folio}.pdf`)
    } catch (err) {
      closePdfWindow(printWindow)
      setPrintError(err instanceof Error ? err.message : 'No se pudo generar el PDF de preparación.')
    } finally {
      setIsPrinting(false)
    }
  }

  const handlePrintAndPrepare = async () => {
    if (!canPrint || isPrinting || isMoving || card.status !== 'PENDING_ROUTE_PREP') return

    const printWindow = openBlankPdfWindow()
    setIsPrinting(true)
    setPrintError(null)

    try {
      // El documento se construye antes de mover la tarjeta: si falla, no cambia el estado.
      const blob = generatePreparationOrdersPdf([{ card, items, clientData }])
      const ok = await onTransition(card, 'IN_PREPARATION')

      if (!ok) {
        closePdfWindow(printWindow)
        setPrintError('No se movió la NV: el servidor rechazó el cambio de estado. No se abrió el documento.')
        return
      }

      openPreparationOrdersPdf(blob, printWindow, `preparacion-nv-${card.nv_folio}.pdf`)
      await loadMovements()
    } catch (err) {
      closePdfWindow(printWindow)
      setPrintError(err instanceof Error ? err.message : 'No se pudo generar el PDF de preparación.')
    } finally {
      setIsPrinting(false)
    }
  }

  return (
    <>
      <div 
        className="fixed inset-0 bg-[#322D29]/35 backdrop-blur-sm z-50 transition-opacity"
        onClick={onClose} 
      />
      
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl bg-[#EFE9E1] border-l border-[#D1C7BD] shadow-2xl flex flex-col transition-transform transform">
        {/* Header */}
        <div className="flex-none px-5 py-4 border-b border-[#D1C7BD] bg-white flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-theme-text flex items-center gap-2">
               <FileText className="w-5 h-5 text-[#72383D]" />
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
         <div className="flex-1 overflow-y-auto p-5 space-y-5">
          
          {/* Comuna / Ruta — señal operacional */}
          <div className="flex flex-wrap items-center gap-3 border border-[#72383D]/30 bg-[#F5EDE9] px-4 py-3">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[#72383D]" />
              <span className="text-base font-bold uppercase tracking-[0.08em] text-[#72383D]">{comuna}</span>
            </div>
            {card.route_date && (
              <span className="border border-[#B38A55]/40 bg-[#F6EFE2] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[#806238]">
                Ruta {new Date(card.route_date).toLocaleDateString('es-CL')}
              </span>
            )}
            <span className={`ml-auto px-2 py-0.5 border text-[9px] font-semibold uppercase tracking-[0.08em]
              ${card.status === 'PENDING_ROUTE_PREP' ? 'border-[#AC9C8D]/30 bg-white text-[#6B625C]' : ''}
              ${card.status === 'IN_PREPARATION' ? 'border-[#B38A55]/40 bg-[#F6EFE2] text-[#806238]' : ''}
              ${card.status === 'IN_AUDIT' ? 'border-[#72383D]/30 bg-white text-[#72383D]' : ''}
            `}>
              {statusLabel(card.status)}
            </span>
          </div>

          {/* Info Client & Route */}
          <div className="border border-[#D1C7BD] bg-white p-4 space-y-4">
            <div>
              <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1">Cliente</p>
              <p className="font-medium text-theme-text text-sm">{card.client_name}</p>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Hash className="w-3.5 h-3.5" /> RUT
                </p>
                <p className="font-medium text-theme-text text-sm">{clientData?.rut || 'No disponible'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
                  <Building2 className="w-3.5 h-3.5" /> Comuna
                </p>
                <p className="font-medium text-theme-text text-sm">{comuna}</p>
              </div>
              <div className="col-span-2">
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" /> Dirección
                </p>
                <p className="font-medium text-theme-text text-sm">{card.address_raw || 'Sin dirección registrada'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1">Ciudad</p>
                <p className="font-medium text-theme-text text-sm">{card.city_raw || 'Sin ciudad'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
                  <User className="w-3.5 h-3.5" /> Vendedor
                </p>
                <p className="font-medium text-theme-text text-sm truncate" title={card.seller_name || ''}>{card.seller_name || 'Sin asignar'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1">Fecha emisión</p>
                <p className="font-medium text-theme-text text-sm">{dateStr}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-theme-text-muted uppercase tracking-wider mb-1">Cantidad total</p>
                <p className="font-medium text-theme-text text-sm">{card.total_quantity} unidades</p>
              </div>
            </div>
          </div>

          {/* Estado Operativo */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-theme-text uppercase tracking-wider flex items-center gap-2">
              Estado Operativo
            </h3>
             <div className="border border-[#D1C7BD] bg-white p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-theme-text">
                  {statusLabel(card.status)}
                </p>
                {card.route_date && (
                  <p className="text-xs text-theme-text-muted mt-1">Ruta: {new Date(card.route_date).toLocaleDateString('es-CL')}</p>
                )}
                <p className="text-xs font-medium text-theme-accent mt-1">
                  Preparación: {firstPrepMovement ? new Date(firstPrepMovement.created_at).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Sin iniciar'}
                </p>
              </div>
               <div className={`px-2 py-0.5 border text-[9px] font-semibold uppercase tracking-[0.08em]
                 ${card.status === 'PENDING_ROUTE_PREP' ? 'border-[#AC9C8D]/30 bg-[#F5F0EA] text-[#6B625C]' : ''}
                 ${card.status === 'IN_PREPARATION' ? 'border-[#B38A55]/40 bg-[#F6EFE2] text-[#806238]' : ''}
                 ${card.status === 'IN_AUDIT' ? 'border-[#72383D]/30 bg-[#F5EDE9] text-[#72383D]' : ''}
              `}>
                {statusLabel(card.status)}
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
                       Factura asociada aún no detectada desde Bsale. El estado operativo se actualizará automáticamente cuando corresponda.
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
                <div className="max-h-[360px] overflow-y-auto">
                  <div className="grid grid-cols-[90px_1fr_56px] gap-2 border-b border-theme-border bg-[#F5F0EA] px-3 py-2 text-[9px] font-bold uppercase tracking-[0.08em] text-[#6B625C]">
                    <span>SKU</span>
                    <span>Descripción / presentación</span>
                    <span className="text-center">Cant.</span>
                  </div>
                  <div className="divide-y divide-theme-border">
                    {items.map((item) => (
                      <div key={item.detail_id} className="grid grid-cols-[90px_1fr_56px] items-start gap-2 px-3 py-2.5 hover:bg-theme-border/10">
                        <p className="font-mono text-[10px] leading-relaxed text-theme-text-muted break-words">{item.sku || '—'}</p>
                        <div className="min-w-0">
                          <p className="text-sm font-medium leading-snug text-theme-text">{item.product_name}</p>
                          {item.unit_net_value != null && (
                            <p className="text-[10px] text-theme-text-muted mt-0.5">c/u ${item.unit_net_value.toLocaleString('es-CL')}</p>
                          )}
                        </div>
                        <p className="text-center text-sm font-bold text-theme-text">{item.quantity}</p>
                      </div>
                    ))}
                  </div>
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
                       <span className="text-theme-text-muted/60">{m.from_status ? statusLabel(m.from_status) : 'Inicio'}</span>
                      <span className="mx-1">→</span>
                       <span className="font-semibold text-theme-accent">{statusLabel(m.to_status)}</span>
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

        <div className="flex-none p-4 border-t border-theme-border bg-theme-panel">
          {moveError && !pendingMoveAction && <p className="text-xs text-red-500 mb-3 text-center">{moveError}</p>}
          {printError && <p className="text-xs text-red-500 mb-3 text-center">{printError}</p>}

          {!pendingMoveAction && card.status === 'PENDING_ROUTE_PREP' && (
            <div className="flex flex-col gap-2 mb-3">
              <button
                onClick={() => void handlePrintAndPrepare()}
                disabled={!canPrint || isPrinting || isMoving}
                className="w-full py-3 bg-[#72383D] hover:bg-[#612F34] text-white font-bold rounded-xl text-sm disabled:opacity-50 transition-colors flex items-center justify-center gap-2 uppercase tracking-[0.04em]"
              >
                <Printer className="w-4 h-4" />
                {isPrinting ? 'Generando documento…' : 'Imprimir y preparar'}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={handlePrintOnly}
                  disabled={!canPrint || isPrinting}
                  className="flex-1 py-2 px-3 bg-white border border-[#D1C7BD] hover:bg-[#F5F0EA] text-[#322D29]/70 font-medium rounded-xl text-xs disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  <Printer className="w-3.5 h-3.5" /> Imprimir sin cambiar estado
                </button>
                <button onClick={() => handleMove('IN_PREPARATION', MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.backward, MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.label)} disabled={isMoving} className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-xl text-xs disabled:opacity-50 transition-colors">
                  {MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.label}
                </button>
              </div>
            </div>
          )}

          {!pendingMoveAction && card.status === 'IN_PREPARATION' && (
            <div className="flex gap-2 mb-3">
              <button onClick={() => handleMove('IN_AUDIT', MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.backward, MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.label)} disabled={isMoving} className="flex-1 py-2 bg-purple-600 hover:bg-purple-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                {MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.label}
              </button>
              <button onClick={() => handleMove('PENDING_ROUTE_PREP', MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.backward, MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.label)} disabled={isMoving} className="flex-1 py-2 bg-orange-600 hover:bg-orange-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                {MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.label}
              </button>
            </div>
          )}

          {!pendingMoveAction && card.status === 'IN_AUDIT' && (
            <div className="flex gap-2 mb-3">
              <button onClick={() => handleMove('IN_PREPARATION', MOVEMENT_RULES.IN_AUDIT.IN_PREPARATION.backward, MOVEMENT_RULES.IN_AUDIT.IN_PREPARATION.label)} disabled={isMoving} className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                {MOVEMENT_RULES.IN_AUDIT.IN_PREPARATION.label}
              </button>
              <button onClick={() => handleMove('PENDING_ROUTE_PREP', MOVEMENT_RULES.IN_AUDIT.PENDING_ROUTE_PREP.backward, MOVEMENT_RULES.IN_AUDIT.PENDING_ROUTE_PREP.label)} disabled={isMoving} className="flex-1 py-2 bg-orange-600 hover:bg-orange-500 text-white font-medium rounded-xl text-sm disabled:opacity-50 transition-colors">
                {MOVEMENT_RULES.IN_AUDIT.PENDING_ROUTE_PREP.label}
              </button>
            </div>
          )}

          <div className="flex gap-3">
            {card.status !== 'PENDING_ROUTE_PREP' && (
              <button
                onClick={handlePrintOnly}
                disabled={!canPrint || isPrinting}
                className="flex-1 py-2.5 px-4 bg-theme-border/20 hover:bg-theme-border/40 text-theme-text font-medium rounded-xl transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Printer className="w-4 h-4" /> Imprimir
              </button>
            )}
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
