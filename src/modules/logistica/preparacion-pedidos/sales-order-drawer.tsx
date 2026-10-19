'use client'

import { X, MapPin, Package, User, FileText, FileCheck, CheckCircle2, Printer, Building2, Hash } from 'lucide-react'
import { SalesOrderPreparationCardInfo, SalesOrderPreparationItem, getSalesOrderClientData, SalesOrderClientData, getSalesOrderPreparationMovements, SalesOrderPreparationMovement } from '@/app/actions/logistica/sales-order-preparation'
import { generatePreparationOrdersPdf, openPreparationOrdersPdf } from '@/lib/pdf/generate-preparation-orders-pdf'
import { useState, useEffect } from 'react'
import { MOVEMENT_RULES } from './movement-rules'

interface SalesOrderDrawerProps {
  card: SalesOrderPreparationCardInfo | null
  items: SalesOrderPreparationItem[]
  clientData?: SalesOrderClientData | null
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

export function SalesOrderDrawer({
  card,
  items,
  clientData: clientDataProp,
  isLoadingItems,
  onClose,
  onTransition,
}: SalesOrderDrawerProps) {
  const [fallbackClientData, setFallbackClientData] = useState<SalesOrderClientData | null>(null)
  const clientData = clientDataProp !== undefined ? clientDataProp : fallbackClientData
  
  const [movements, setMovements] = useState<SalesOrderPreparationMovement[]>([])
  const [loadingMovements, setLoadingMovements] = useState(false)
  const [movementsLoaded, setMovementsLoaded] = useState(false)
  
  const [pendingMoveAction, setPendingMoveAction] = useState<{ toStatus: string; requireObs: boolean; label: string } | null>(null)
  const [observation, setObservation] = useState('')
  const [isMoving, setIsMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [isPrinting, setIsPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)

  // Solo consulta cliente si el padre no lo entregó ya precargado.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    let cancelled = false
    if (clientDataProp !== undefined) return

    setFallbackClientData(null)
    if (card?.company_id && card?.nv_bsale_id) {
      getSalesOrderClientData(card.company_id, card.nv_bsale_id).then((res) => {
        if (!cancelled && res.data) setFallbackClientData(res.data)
      })
    }

    return () => {
      cancelled = true
    }
  }, [card?.company_id, card?.nv_bsale_id, clientDataProp])

  const loadMovements = async () => {
    if (!card?.card_id) return
    setLoadingMovements(true)
    const res = await getSalesOrderPreparationMovements(card.card_id)
    setMovements(res.data || [])
    setMovementsLoaded(true)
    setLoadingMovements(false)
  }

  // Resetea el historial sin consultar al servidor al abrir una tarjeta.
  useEffect(() => {
    setMovements([])
    setMovementsLoaded(false)
    setPendingMoveAction(null)
    setObservation('')
    setMoveError(null)
    setPrintError(null)
  }, [card?.card_id])
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const handleMovementsToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const isOpen = e.currentTarget.open
    if (isOpen && !movementsLoaded && !loadingMovements && card?.card_id) {
      void loadMovements()
    }
  }

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
    if (movementsLoaded) {
      await loadMovements()
    }
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
      if (movementsLoaded) {
        await loadMovements()
      }
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
         <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          
          {/* Encabezado Operativo Compacto */}
          <div className="rounded-lg border border-[#DDD4CA] bg-white p-3.5 shadow-xs space-y-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-theme-text-muted uppercase tracking-wider">Cliente</p>
                <h3 className="font-bold text-theme-text text-base leading-snug truncate" title={card.client_name}>
                  {card.client_name}
                </h3>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                <span className="inline-flex items-center gap-1 rounded-md border border-[#72383D]/25 bg-[#F8F2EE] px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-[#72383D]" title={comuna}>
                  <MapPin className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate max-w-[140px]">{comuna}</span>
                </span>
                <span className={`px-2 py-0.5 rounded-md border text-xs font-semibold uppercase tracking-wider
                  ${card.status === 'PENDING_ROUTE_PREP' ? 'border-[#AC9C8D]/40 bg-[#F5F0EA] text-[#6B625C]' : ''}
                  ${card.status === 'IN_PREPARATION' ? 'border-[#B38A55]/40 bg-[#F6EFE2] text-[#806238]' : ''}
                  ${card.status === 'IN_AUDIT' ? 'border-[#72383D]/30 bg-[#F5EDE9] text-[#72383D]' : ''}
                `}>
                  {statusLabel(card.status)}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 border-t border-[#DDD4CA]/60 text-xs text-[#322D29]/75">
              <div className="flex items-center gap-1">
                <span className="font-semibold text-theme-text-muted">Emisión:</span>
                <span className="font-medium text-theme-text">{dateStr}</span>
              </div>
              {card.route_date && (
                <div className="flex items-center gap-1">
                  <span className="font-semibold text-theme-text-muted">Ruta:</span>
                  <span className="font-medium text-[#806238]">{new Date(card.route_date).toLocaleDateString('es-CL')}</span>
                </div>
              )}
              <div className="flex items-center gap-1">
                <User className="w-3.5 h-3.5 text-[#322D29]/50" />
                <span className="font-semibold text-theme-text-muted">Vendedor:</span>
                <span className="font-medium text-theme-text truncate max-w-[130px]">{card.seller_name || 'Sin asignar'}</span>
              </div>
              <div className="flex items-center gap-1 ml-auto">
                <Package className="w-3.5 h-3.5 text-[#72383D]" />
                <span className="font-bold text-theme-text">{card.total_quantity} unidades</span>
                {card.net_amount != null && (
                  <span className="text-[#322D29]/60">(${card.net_amount.toLocaleString('es-CL')} neto)</span>
                )}
              </div>
            </div>
          </div>

          {/* ── SECCIÓN PROTAGONISTA: PRODUCTOS A PREPARAR ── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider flex items-center gap-1.5">
                <Package className="w-4 h-4 text-[#72383D]" />
                <span>Productos a preparar</span>
                <span className="text-[#72383D] font-extrabold">({card.total_quantity} unid.)</span>
              </h3>
              <span className="text-xs font-semibold text-theme-text">
                Neto: ${card.net_amount?.toLocaleString('es-CL')}
              </span>
            </div>
            
            <div className="rounded-lg border border-[#DDD4CA] bg-white shadow-xs overflow-hidden">
              {isLoadingItems ? (
                <div className="p-8 text-center text-xs text-theme-text-muted">
                  Cargando productos...
                </div>
              ) : items.length === 0 ? (
                <div className="p-8 text-center text-xs text-theme-text-muted">
                  No se encontraron productos en esta nota de venta.
                </div>
              ) : (
                <div className="max-h-[420px] overflow-y-auto">
                  <div className="grid grid-cols-[90px_1fr_60px] gap-2 border-b border-[#DDD4CA] bg-[#F8F5F1] px-3.5 py-2.5 text-[10px] font-bold uppercase tracking-wider text-[#6B625C] sticky top-0 z-10">
                    <span>SKU</span>
                    <span>Descripción / presentación</span>
                    <span className="text-center">Cant.</span>
                  </div>
                  <div className="divide-y divide-[#DDD4CA]/60">
                    {items.map((item) => (
                      <div key={item.detail_id} className="grid grid-cols-[90px_1fr_60px] items-center gap-2 px-3.5 py-2.5 hover:bg-[#F8F5F1]/60 transition-colors">
                        <p className="font-mono text-xs font-semibold text-theme-text break-words">{item.sku || '—'}</p>
                        <div className="min-w-0 pr-1">
                          <p className="text-xs font-medium leading-snug text-theme-text">{item.product_name}</p>
                          {item.unit_net_value != null && (
                            <p className="text-[11px] text-theme-text-muted mt-0.5">c/u ${item.unit_net_value.toLocaleString('es-CL')}</p>
                          )}
                        </div>
                        <div className="flex justify-center">
                          <span className="inline-flex min-w-[28px] h-6 items-center justify-center rounded bg-[#72383D]/10 text-xs font-bold text-[#72383D] px-1.5 tabular-nums">
                            {item.quantity}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── SECCIÓN SECUNDARIA: DETALLES DE DESPACHO Y CLIENTE ── */}
          <details className="rounded-lg border border-[#DDD4CA] bg-white shadow-xs group">
            <summary className="cursor-pointer px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-[#6B625C] hover:bg-[#F8F5F1] transition-colors flex items-center justify-between list-none">
              <span className="flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-[#72383D]" />
                Datos de despacho y cliente
              </span>
              <span className="text-[10px] text-theme-text-muted font-normal group-open:rotate-180 transition-transform">▼</span>
            </summary>
            <div className="p-4 border-t border-[#DDD4CA]/60 space-y-3 bg-[#FCFBF9]">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
                <div>
                  <p className="font-bold text-theme-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-1">
                    <Hash className="w-3 h-3" /> RUT
                  </p>
                  <p className="font-medium text-theme-text">{clientData?.rut || 'No disponible'}</p>
                </div>
                <div>
                  <p className="font-bold text-theme-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-1">
                    <Building2 className="w-3 h-3" /> Comuna
                  </p>
                  <p className="font-medium text-theme-text">{comuna}</p>
                </div>
                <div className="col-span-2">
                  <p className="font-bold text-theme-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-1">
                    <MapPin className="w-3 h-3" /> Dirección
                  </p>
                  <p className="font-medium text-theme-text">{card.address_raw || 'Sin dirección registrada'}</p>
                </div>
                <div>
                  <p className="font-bold text-theme-text-muted uppercase tracking-wider mb-0.5">Ciudad</p>
                  <p className="font-medium text-theme-text">{card.city_raw || 'Sin ciudad'}</p>
                </div>
                <div>
                  <p className="font-bold text-theme-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-1">
                    <User className="w-3 h-3" /> Vendedor
                  </p>
                  <p className="font-medium text-theme-text truncate" title={card.seller_name || ''}>{card.seller_name || 'Sin asignar'}</p>
                </div>
                <div>
                  <p className="font-bold text-theme-text-muted uppercase tracking-wider mb-0.5">Fecha emisión</p>
                  <p className="font-medium text-theme-text">{dateStr}</p>
                </div>
                <div>
                  <p className="font-bold text-theme-text-muted uppercase tracking-wider mb-0.5">Cantidad total</p>
                  <p className="font-medium text-theme-text">{card.total_quantity} unidades</p>
                </div>
              </div>
            </div>
          </details>

          {/* ── SECCIÓN SECUNDARIA: ESTADO OPERATIVO Y FACTURACIÓN ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Estado Operativo */}
            <div className="rounded-lg border border-[#DDD4CA] bg-white p-3 shadow-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <h4 className="text-[11px] font-bold text-theme-text uppercase tracking-wider">Estado Operativo</h4>
                <div className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider
                  ${card.status === 'PENDING_ROUTE_PREP' ? 'bg-[#F5F0EA] text-[#6B625C]' : ''}
                  ${card.status === 'IN_PREPARATION' ? 'bg-[#F6EFE2] text-[#806238]' : ''}
                  ${card.status === 'IN_AUDIT' ? 'bg-[#F5EDE9] text-[#72383D]' : ''}
                `}>
                  {statusLabel(card.status)}
                </div>
              </div>
              {card.route_date && (
                <p className="text-[11px] text-theme-text-muted">Ruta: {new Date(card.route_date).toLocaleDateString('es-CL')}</p>
              )}
              <p className="text-[11px] font-medium text-theme-accent">
                Prep: {firstPrepMovement ? new Date(firstPrepMovement.created_at).toLocaleString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : (movementsLoaded ? 'Sin iniciar' : '—')}
              </p>
            </div>

            {/* Facturación Bsale */}
            <div className="rounded-lg border border-[#DDD4CA] bg-white p-3 shadow-xs space-y-1.5">
              <h4 className="text-[11px] font-bold text-theme-text uppercase tracking-wider">Facturación Bsale</h4>
              {card.is_invoiced ? (
                <div className="flex items-center gap-2 text-xs">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="font-semibold text-theme-text">Factura: {card.invoice_folio}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-theme-text-muted">
                  <FileCheck className="w-4 h-4 text-theme-text-muted/60 shrink-0" />
                  <span>No facturada</span>
                </div>
              )}
            </div>
          </div>

          {/* Historial de Movimientos */}
          <details
            className="rounded-lg border border-[#DDD4CA] bg-white shadow-xs group"
            onToggle={handleMovementsToggle}
          >
            <summary className="cursor-pointer px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-[#6B625C] hover:bg-[#F8F5F1] transition-colors flex items-center justify-between list-none">
              <span>Historial de Movimientos ({movementsLoaded ? movements.length : '—'})</span>
              <span className="text-[10px] text-theme-text-muted font-normal group-open:rotate-180 transition-transform">▼</span>
            </summary>
            <div className="p-3 border-t border-[#DDD4CA]/60 max-h-[180px] overflow-y-auto text-xs space-y-2 bg-[#FCFBF9]">
              {loadingMovements ? (
                <div className="text-center text-xs text-theme-text-muted">Cargando historial...</div>
              ) : movements.length === 0 ? (
                <div className="text-center text-xs text-theme-text-muted">Sin movimientos registrados.</div>
              ) : (
                movements.map(m => (
                  <div key={m.id} className="pb-2 border-b border-[#DDD4CA]/40 last:border-0 last:pb-0">
                    <p className="font-semibold text-xs">{m.metadata?.moved_by_name || 'Sistema'}</p>
                    <p className="text-[11px] text-theme-text-muted">
                      {new Date(m.created_at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <p className="mt-0.5 text-xs">
                       <span className="text-theme-text-muted/70">{m.from_status ? statusLabel(m.from_status) : 'Inicio'}</span>
                      <span className="mx-1">→</span>
                       <span className="font-bold text-theme-accent">{statusLabel(m.to_status)}</span>
                    </p>
                    {m.observation && <p className="mt-1 italic opacity-85 text-amber-700 bg-amber-50 rounded px-1.5 py-0.5 text-[11px]">Obs: {m.observation}</p>}
                  </div>
                ))
              )}
            </div>
          </details>

        </div>
        
        {/* Movimientos UI */}
        {pendingMoveAction && (
          <div className="p-4 bg-[#F8F5F1] border-t border-[#DDD4CA]">
            <p className="text-xs font-bold mb-2 text-theme-text uppercase tracking-wider">Observación requerida para: <span className="text-[#72383D]">{pendingMoveAction.label}</span></p>
            <textarea
              className="w-full bg-white border border-[#DDD4CA] rounded-lg p-2.5 text-xs text-theme-text mb-2 focus:ring-2 focus:ring-[#72383D]/20 focus:border-[#72383D] outline-none shadow-xs"
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
                className="flex-1 py-2 bg-[#72383D] hover:bg-[#612F34] text-white rounded-lg text-xs font-semibold disabled:opacity-50 shadow-xs transition-colors"
              >
                {isMoving ? 'Guardando...' : 'Confirmar'}
              </button>
              <button 
                onClick={() => setPendingMoveAction(null)}
                className="flex-1 py-2 border border-[#DDD4CA] bg-white text-[#322D29]/75 hover:bg-[#F5F0EA] rounded-lg text-xs font-semibold shadow-xs transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        <div className="flex-none p-4 border-t border-[#DDD4CA] bg-white">
          {moveError && !pendingMoveAction && <p className="text-xs text-red-500 mb-3 text-center">{moveError}</p>}
          {printError && <p className="text-xs text-red-500 mb-3 text-center">{printError}</p>}

          {!pendingMoveAction && card.status === 'PENDING_ROUTE_PREP' && (
            <div className="flex flex-col gap-2 mb-3">
              <button
                onClick={() => void handlePrintAndPrepare()}
                disabled={!canPrint || isPrinting || isMoving}
                className="w-full py-2.5 bg-[#72383D] hover:bg-[#612F34] text-white font-bold rounded-lg text-xs disabled:opacity-50 shadow-xs transition-colors flex items-center justify-center gap-2 uppercase tracking-wider"
              >
                <Printer className="w-4 h-4" />
                {isPrinting ? 'Generando documento…' : 'Imprimir y preparar'}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={handlePrintOnly}
                  disabled={!canPrint || isPrinting}
                  className="flex-1 py-2 px-3 bg-white border border-[#DDD4CA] hover:bg-[#F5F0EA] text-[#322D29]/80 font-semibold rounded-lg text-xs disabled:opacity-50 shadow-xs transition-colors flex items-center justify-center gap-1.5"
                >
                  <Printer className="w-3.5 h-3.5" /> Imprimir sin cambiar estado
                </button>
                <button onClick={() => handleMove('IN_PREPARATION', MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.backward, MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.label)} disabled={isMoving} className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg text-xs disabled:opacity-50 shadow-xs transition-colors">
                  {MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.label}
                </button>
              </div>
            </div>
          )}

          {!pendingMoveAction && card.status === 'IN_PREPARATION' && (
            <div className="flex gap-2 mb-3">
              <button onClick={() => handleMove('IN_AUDIT', MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.backward, MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.label)} disabled={isMoving} className="flex-1 py-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg text-xs disabled:opacity-50 shadow-xs transition-colors">
                {MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.label}
              </button>
              <button onClick={() => handleMove('PENDING_ROUTE_PREP', MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.backward, MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.label)} disabled={isMoving} className="flex-1 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg text-xs disabled:opacity-50 shadow-xs transition-colors">
                {MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.label}
              </button>
            </div>
          )}

          {!pendingMoveAction && card.status === 'IN_AUDIT' && (
            <div className="flex gap-2 mb-3">
              <button onClick={() => handleMove('IN_PREPARATION', MOVEMENT_RULES.IN_AUDIT.IN_PREPARATION.backward, MOVEMENT_RULES.IN_AUDIT.IN_PREPARATION.label)} disabled={isMoving} className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg text-xs disabled:opacity-50 shadow-xs transition-colors">
                {MOVEMENT_RULES.IN_AUDIT.IN_PREPARATION.label}
              </button>
              <button onClick={() => handleMove('PENDING_ROUTE_PREP', MOVEMENT_RULES.IN_AUDIT.PENDING_ROUTE_PREP.backward, MOVEMENT_RULES.IN_AUDIT.PENDING_ROUTE_PREP.label)} disabled={isMoving} className="flex-1 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg text-xs disabled:opacity-50 shadow-xs transition-colors">
                {MOVEMENT_RULES.IN_AUDIT.PENDING_ROUTE_PREP.label}
              </button>
            </div>
          )}

          <div className="flex gap-3">
            {card.status !== 'PENDING_ROUTE_PREP' && (
              <button
                onClick={handlePrintOnly}
                disabled={!canPrint || isPrinting}
                className="flex-1 py-2 px-4 border border-[#DDD4CA] hover:bg-[#F5F0EA] text-[#322D29]/80 font-semibold rounded-lg text-xs transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 shadow-xs"
              >
                <Printer className="w-3.5 h-3.5" /> Imprimir
              </button>
            )}
            <button 
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-[#DDD4CA] bg-white hover:bg-[#F5F0EA] text-[#322D29]/80 font-semibold rounded-lg text-xs transition-colors shadow-xs"
            >
              Cerrar detalle
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
