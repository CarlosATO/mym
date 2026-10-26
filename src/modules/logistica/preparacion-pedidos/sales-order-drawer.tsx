'use client'

import { X, MapPin, Package, User, FileText, Printer, Building2, Hash, AlertTriangle, LockKeyhole } from 'lucide-react'
import { SalesOrderPreparationCardInfo, SalesOrderPreparationItem, SalesOrderPreparationLine, confirmSalesOrderPreparationLine, getSalesOrderClientData, SalesOrderClientData, getSalesOrderPreparationLines, getSalesOrderPreparationMovements, SalesOrderPreparationMovement } from '@/app/actions/logistica/sales-order-preparation'
import { generatePreparationOrdersPdf, openPreparationOrdersPdf } from '@/lib/pdf/generate-preparation-orders-pdf'
import { Fragment, useState, useEffect } from 'react'
import { MOVEMENT_RULES } from './movement-rules'
import { parseDateOnly } from './preparation-board-utils'
import { PREPARATION_INCIDENT_REASONS } from './preparation-incidents'
import { getPreparationLineValidation } from './preparation-line-validation'
import { canClaimPreparation as canClaimPreparationView, canTakeoverPreparation as canTakeoverPreparationView, isPreparationLockError, isPreparationReadOnly } from './preparation-lock-policy'

interface SalesOrderDrawerProps {
  card: SalesOrderPreparationCardInfo | null
  items: SalesOrderPreparationItem[]
  preparationLines: SalesOrderPreparationLine[]
  onPreparationLinesChange: (lines: SalesOrderPreparationLine[]) => void
  onPreparationLineChange: (line: SalesOrderPreparationLine) => void
  isLoadingPreparationLines: boolean
  preparationLinesError?: string | null
  clientData?: SalesOrderClientData | null
  isLoadingItems: boolean
  currentUserId: string
  canClaimPreparation: boolean
  canTakeoverPreparation: boolean
  onTakePreparation: (card: SalesOrderPreparationCardInfo) => void | Promise<void>
  onOwnershipConflict: () => void | Promise<void>
  onClose: () => void
  onTransition: (card: SalesOrderPreparationCardInfo, toStatus: string, observation?: string) => Promise<{ ok: boolean; error?: string }>
}

const statusLabel = (status: string) => status === 'PENDING_ROUTE_PREP' ? 'Pendiente' : status === 'IN_PREPARATION' ? 'En preparación' : status === 'IN_AUDIT' ? 'En auditoría' : status === 'AUDITED' ? 'Auditada' : 'Estado operativo'

function statusBadgeClasses(status: string): string {
  if (status === 'PENDING_ROUTE_PREP') return 'border-[#AC9C8D]/40 bg-[#F5F0EA] text-[#6B625C]'
  if (status === 'IN_PREPARATION') return 'border-[#B38A55]/40 bg-[#F6EFE2] text-[#806238]'
  if (status === 'IN_AUDIT') return 'border-[#72383D]/30 bg-[#F5EDE9] text-[#72383D]'
  if (status === 'AUDITED') return 'border-emerald-300/70 bg-emerald-50 text-emerald-800'
  return 'border-[#D1C7BD] bg-white text-[#6B625C]'
}

function HeaderStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-bold uppercase tracking-wider text-[#6B625C]">{label}</p>
      <p className={`truncate text-[11px] font-bold ${accent ? 'text-[#72383D]' : 'text-theme-text'}`} title={value}>{value}</p>
    </div>
  )
}

function SideStat({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-bold uppercase tracking-wider text-[#6B625C]">{label}</p>
      <p className={`truncate text-[11px] font-bold tabular-nums ${accent ? 'text-[#72383D]' : 'text-theme-text'}`} title={String(value)}>{value}</p>
    </div>
  )
}

function lineStateLabel(line: SalesOrderPreparationLine): string {
  if (line.excluded_from_dispatch) return 'Excluida'
  if (line.line_status === 'PENDING') return 'Pendiente'
  if (line.line_status === 'INCIDENT') return 'Con incidencia'
  return 'Confirmada'
}

function lineStateClasses(line: SalesOrderPreparationLine): string {
  if (line.excluded_from_dispatch) return 'border-[#D1C7BD] bg-[#F4F0EC] text-[#6B625C]'
  if (line.line_status === 'PENDING') return 'border-[#D1C7BD] bg-[#F8F5F1] text-[#6B625C]'
  if (line.line_status === 'INCIDENT') return 'border-amber-300/70 bg-amber-50 text-amber-800'
  return 'border-emerald-300/70 bg-emerald-50 text-emerald-800'
}

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
  preparationLines,
  onPreparationLinesChange,
  onPreparationLineChange,
  isLoadingPreparationLines,
  preparationLinesError = null,
  clientData: clientDataProp,
  isLoadingItems,
  currentUserId,
  canClaimPreparation,
  canTakeoverPreparation,
  onTakePreparation,
  onOwnershipConflict,
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
  const [lineDrafts, setLineDrafts] = useState<Record<string, string>>({})
  const [incidentLine, setIncidentLine] = useState<{ line: SalesOrderPreparationLine; quantity: number; excluded: boolean } | null>(null)
  const [incidentReason, setIncidentReason] = useState('')
  const [incidentObservation, setIncidentObservation] = useState('')
  const [lineError, setLineError] = useState<string | null>(null)
  const [savingLineId, setSavingLineId] = useState<string | null>(null)
  const [isTakingPreparation, setIsTakingPreparation] = useState(false)
  const [auditSummaryOpen, setAuditSummaryOpen] = useState(false)

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
    setLineDrafts({})
    setIncidentLine(null)
    setIsTakingPreparation(false)
    setAuditSummaryOpen(false)
  }, [card?.card_id])
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const handleMovementsToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const isOpen = e.currentTarget.open
    if (isOpen && !movementsLoaded && !loadingMovements && card?.card_id) {
      void loadMovements()
    }
  }

  if (!card) return null

  const lockView = {
    status: card.status,
    currentUserId,
    lockedByUserId: card.locked_by_user_id,
    lockedByName: card.locked_by_user_name,
    canManage: canClaimPreparation,
    canTakeover: canTakeoverPreparation,
  }
  const isReadOnly = isPreparationReadOnly(lockView)
  const showClaimPreparation = canClaimPreparationView(lockView)
  const showTakeoverPreparation = canTakeoverPreparationView(lockView)
  const lockOwnerName = card.locked_by_user_name || 'otro usuario'

  const reportLockConflict = (message: string | null | undefined) => {
    if (isPreparationLockError(message)) void onOwnershipConflict()
  }

  const handleTakePreparation = async () => {
    if (isTakingPreparation) return
    setIsTakingPreparation(true)
    try {
      await onTakePreparation(card)
    } finally {
      setIsTakingPreparation(false)
    }
  }

  const handleMove = async (toStatus: string, requireObs: boolean, label: string) => {
    if (isReadOnly) {
      setMoveError('Esta preparación está asignada a otro usuario.')
      return
    }
    if (toStatus === 'IN_AUDIT' && card?.status === 'IN_PREPARATION') {
      if (pendingLines.length > 0) {
        setMoveError(`Faltan ${pendingLines.length} producto${pendingLines.length === 1 ? '' : 's'} por confirmar.`)
        return
      }
      if (incidentLines.length > 0) {
        setAuditSummaryOpen(true)
        return
      }
    }
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
    const result = await onTransition(card, toStatus, obs)
    setIsMoving(false)
    if (!result.ok) {
      setMoveError(result.error || 'No se pudo guardar el cambio. La tarjeta volvió a su estado anterior.')
      reportLockConflict(result.error)
      return
    }
    setPendingMoveAction(null)
    if (toStatus === 'IN_PREPARATION') {
      const lines = await getSalesOrderPreparationLines(card.company_id, card.card_id)
      onPreparationLinesChange(lines.data)
    }
    if (movementsLoaded) {
      await loadMovements()
    }
  }

  const operationalLines = card?.status === 'IN_PREPARATION' ? preparationLines : []
  const { pendingLines, incidentLines } = getPreparationLineValidation(operationalLines)
  const reasonLabel = (reason: string) => ({
    SIN_STOCK: 'Sin stock', STOCK_INSUFICIENTE: 'Stock insuficiente', PRODUCTO_DANADO: 'Producto dañado',
    PRODUCTO_VENCIDO_NO_APTO: 'Producto vencido / no apto', ERROR_PEDIDO: 'Error de pedido',
    SOLICITUD_CLIENTE: 'Solicitud del cliente', OTRO: 'Otro',
  } as Record<string, string>)[reason] || reason

  const savePreparationLine = async (line: SalesOrderPreparationLine, quantity: number, reasonCode?: string, observationText?: string, excluded = false) => {
    if (!card?.company_id || savingLineId) return
    if (isReadOnly) {
      setLineError('Esta preparación está asignada a otro usuario.')
      return
    }
    setSavingLineId(line.id)
    setLineError(null)
    const result = await confirmSalesOrderPreparationLine({
      companyId: card.company_id,
      lineId: line.id,
      preparedQuantity: quantity,
      reasonCode,
      observation: observationText,
      excluded,
    })
    setSavingLineId(null)
    if (result.error || !result.data) {
      setLineError(result.error || 'No se pudo confirmar la línea.')
      reportLockConflict(result.error)
      return
    }
    onPreparationLineChange(result.data)
    setLineDrafts(current => {
      const next = { ...current }
      delete next[line.id]
      return next
    })
    setIncidentLine(null)
    setIncidentReason('')
    setIncidentObservation('')
  }

  const confirmLineInput = (line: SalesOrderPreparationLine, excluded = false) => {
    if (isReadOnly) {
      setLineError('Esta preparación está asignada a otro usuario.')
      return
    }
    const raw = excluded
      ? '0'
      : (lineDrafts[line.id] ?? (line.prepared_quantity == null ? '' : String(line.prepared_quantity)))
    if (raw.trim() === '') {
      setLineError('Ingresa una cantidad antes de confirmar.')
      return
    }
    const quantity = Number(raw)
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > line.requested_quantity) {
      setLineError('La cantidad debe estar entre 0 y la cantidad solicitada.')
      return
    }
    // Cero y "Excluir" son la misma realidad operacional: la línea no se despacha.
    const effectiveExcluded = excluded || quantity === 0
    if (quantity === line.requested_quantity && !effectiveExcluded) {
      void savePreparationLine(line, quantity)
      return
    }
    setIncidentLine({ line, quantity, excluded: effectiveExcluded })
    setIncidentReason('')
    setIncidentObservation('')
    setLineError(null)
  }

  const emissionDateObj = parseDateOnly(card.nv_emission_date)
  const dateStr = emissionDateObj
    ? emissionDateObj.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—'
  const canPrint = !isLoadingItems
  const comuna = card.normalized_city || card.municipality_raw || card.city_raw || 'Sin comuna'
  const isPreparation = card.status === 'IN_PREPARATION'
  const preparerName = card.locked_by_user_name || card.assigned_user_name || '—'
  const netLabel = card.net_amount != null ? `$ ${card.net_amount.toLocaleString('es-CL')}` : '—'
  const billingLabel = card.is_invoiced ? `Factura ${card.invoice_folio ?? '—'}` : 'No facturada'
  const confirmedLines = operationalLines.filter(line => line.line_status === 'CONFIRMED').length
  const requestedUnits = operationalLines.reduce((sum, line) => sum + line.requested_quantity, 0)
  const preparedUnits = operationalLines.reduce((sum, line) => sum + (line.prepared_quantity ?? 0), 0)
  const productCount = isPreparation ? preparationLines.length : items.length

  const handlePrintOnly = () => {
    if (!canPrint || isPrinting) return

    const printWindow = openBlankPdfWindow()
    setIsPrinting(true)
    setPrintError(null)

    try {
      const blob = generatePreparationOrdersPdf([{ card, items, preparationLines, clientData }])
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
      const moveResult = await onTransition(card, 'IN_PREPARATION')

      if (!moveResult.ok) {
        closePdfWindow(printWindow)
        setPrintError(moveResult.error || 'No se movió la NV: el servidor rechazó el cambio de estado. No se abrió el documento.')
        reportLockConflict(moveResult.error)
        return
      }

      openPreparationOrdersPdf(blob, printWindow, `preparacion-nv-${card.nv_folio}.pdf`)
      const lines = await getSalesOrderPreparationLines(card.company_id, card.card_id)
      onPreparationLinesChange(lines.data)
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
      {incidentLine && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#322D29]/40 p-4" role="dialog" aria-modal="true" aria-labelledby="preparation-incident-title">
          <div className="w-full max-w-sm rounded-lg border border-[#D1C7BD] bg-white p-4 shadow-2xl">
            <h3 id="preparation-incident-title" className="flex items-center gap-2 text-sm font-bold text-theme-text"><AlertTriangle className="h-4 w-4 text-[#8A4B4B]" /> Incidencia de preparación</h3>
            <div className="mt-3 space-y-1 text-xs text-theme-text-muted">
              <p className="font-semibold text-theme-text">NV #{card.nv_folio} · {incidentLine.line.sku || 'Sin SKU'}</p>
              <p>{incidentLine.line.product_name}</p>
              <p>Solicitado: <strong>{incidentLine.line.requested_quantity}</strong> · A despachar: <strong>{incidentLine.quantity}</strong> · Diferencia: <strong>{incidentLine.quantity - incidentLine.line.requested_quantity}</strong></p>
            </div>
            <label className="mt-4 block text-xs font-semibold text-theme-text">Motivo *</label>
            <select value={incidentReason} onChange={event => setIncidentReason(event.target.value)} className="mt-1 w-full rounded border border-[#D1C7BD] bg-white px-2 py-2 text-xs text-theme-text">
              <option value="">Seleccionar motivo</option>
              {PREPARATION_INCIDENT_REASONS.map(reason => <option key={reason} value={reason}>{reasonLabel(reason)}</option>)}
            </select>
            <label className="mt-3 block text-xs font-semibold text-theme-text">Observación {incidentReason === 'OTRO' ? '*' : '(opcional)'}</label>
            <textarea value={incidentObservation} onChange={event => setIncidentObservation(event.target.value)} rows={3} className="mt-1 w-full resize-none rounded border border-[#D1C7BD] bg-white px-2 py-2 text-xs text-theme-text" />
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setIncidentLine(null)} disabled={savingLineId !== null} className="flex-1 rounded border border-[#D1C7BD] px-3 py-2 text-xs font-semibold text-theme-text">Cancelar</button>
              <button type="button" onClick={() => void savePreparationLine(incidentLine.line, incidentLine.quantity, incidentReason, incidentObservation, incidentLine.excluded)} disabled={!incidentReason || (incidentReason === 'OTRO' && !incidentObservation.trim()) || savingLineId !== null} className="flex-1 rounded bg-[#72383D] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{savingLineId ? 'Guardando...' : 'Confirmar incidencia'}</button>
            </div>
          </div>
        </div>
      )}
      {auditSummaryOpen && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-[#322D29]/35 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-[#D1C7BD] bg-white p-5 shadow-2xl">
            <h3 className="text-sm font-bold text-theme-text">Confirmar envío a Auditoría</h3>
            <p className="mt-2 text-xs leading-relaxed text-theme-text-muted">Esta preparación contiene diferencias. Las incidencias quedarán pendientes de gestión administrativa. La Nota de Venta será enviada a Auditoría con las cantidades preparadas.</p>
            <div className="mt-3 rounded border border-[#DDD4CA] bg-[#FCFBF9] p-3 text-xs text-theme-text">
              <p>Líneas completas: <strong>{operationalLines.filter(line => line.line_status === 'CONFIRMED').length}</strong></p>
              <p>Líneas con diferencia: <strong>{incidentLines.length}</strong></p>
              <p>Unidades solicitadas: <strong>{operationalLines.reduce((sum, line) => sum + line.requested_quantity, 0)}</strong></p>
              <p>Unidades preparadas: <strong>{operationalLines.reduce((sum, line) => sum + (line.prepared_quantity ?? 0), 0)}</strong></p>
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setAuditSummaryOpen(false)} className="flex-1 rounded border border-[#D1C7BD] px-3 py-2 text-xs font-semibold text-theme-text">Cancelar</button>
              <button type="button" onClick={() => { setAuditSummaryOpen(false); void executeMove('IN_AUDIT') }} disabled={isMoving} className="flex-1 rounded bg-purple-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Enviar a Auditoría</button>
            </div>
          </div>
        </div>
      )}
      <div 
        className="fixed inset-0 bg-[#322D29]/35 backdrop-blur-sm z-50 transition-opacity"
        onClick={onClose} 
      />
      
      <div className="fixed inset-y-0 right-0 z-50 flex w-[96vw] max-w-[1550px] flex-col border-l border-[#D1C7BD] bg-[#EFE9E1] shadow-2xl lg:w-[86vw] xl:w-[80vw]">
        {/* Header compacto */}
        <header className="flex-none border-b border-[#D1C7BD] bg-white">
          <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="flex items-center gap-2 text-base font-bold tracking-tight text-theme-text sm:text-lg">
                  <FileText className="h-5 w-5 text-[#72383D]" />
                  NV #{card.nv_folio}
                </h2>
                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusBadgeClasses(card.status)}`}>
                  {statusLabel(card.status)}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-theme-text-muted">
                <span className="max-w-[420px] truncate font-semibold text-theme-text" title={card.client_name}>{card.client_name}</span>
                <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {comuna}</span>
                <span>{dateStr}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-theme-text-muted transition-colors hover:bg-theme-border/50 hover:text-theme-text"
              aria-label="Cerrar detalle"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-[#E8DFD5] bg-[#FCFBF9] px-4 py-2 sm:grid-cols-3 sm:px-5 xl:grid-cols-5">
            <HeaderStat label="Preparó" value={preparerName} />
            <HeaderStat label="Vendedor" value={card.seller_name || '—'} />
            <HeaderStat label="Estado" value={statusLabel(card.status)} />
            <HeaderStat label="Unidades" value={`${card.total_quantity} un.`} accent />
            <HeaderStat label="Neto" value={netLabel} accent />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 lg:p-5">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-theme-text">
                  <Package className="h-4 w-4 text-[#72383D]" /> Productos
                  <span className="font-extrabold text-[#72383D]">({productCount})</span>
                </h3>
                <span className="text-[11px] font-semibold text-theme-text-muted">Neto: <strong className="text-theme-text">{netLabel}</strong></span>
              </div>

              <div className="overflow-x-auto rounded-lg border border-[#DDD4CA] bg-white shadow-xs">
                <table className={`w-full border-collapse text-left ${isPreparation ? 'min-w-[860px]' : 'min-w-[620px]'}`}>
                  <thead>
                    <tr className="sticky top-0 z-10 border-b border-[#DDD4CA] bg-[#F8F5F1] text-[9px] font-bold uppercase tracking-wider text-[#6B625C]">
                      <th className="w-[95px] px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Producto / presentación</th>
                      {isPreparation ? (
                        <>
                          <th className="w-[72px] px-2 py-2 text-center">Solicitado</th>
                          <th className="w-[96px] px-2 py-2 text-center">A despachar</th>
                          <th className="w-[120px] px-2 py-2">Resultado</th>
                          <th className="w-[124px] px-3 py-2 text-center">Acciones</th>
                        </>
                      ) : (
                        <>
                          <th className="w-[64px] px-2 py-2 text-center">Cant.</th>
                          <th className="w-[100px] px-3 py-2 text-right">C/U</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {isLoadingItems ? (
                      <tr><td colSpan={isPreparation ? 6 : 4} className="px-4 py-10 text-center text-xs text-theme-text-muted">Cargando productos…</td></tr>
                    ) : isPreparation && isLoadingPreparationLines && preparationLines.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-10 text-center text-xs text-theme-text-muted">Inicializando fotografía de preparación...</td></tr>
                    ) : isPreparation && preparationLinesError && preparationLines.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-10 text-center text-xs text-[#8A4B4B]">{preparationLinesError}</td></tr>
                    ) : isPreparation && preparationLines.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-10 text-center text-xs text-theme-text-muted">Esta Nota de Venta no tiene líneas de preparación registradas.</td></tr>
                    ) : !isPreparation && items.length === 0 ? (
                      <tr><td colSpan={4} className="px-4 py-10 text-center text-xs text-theme-text-muted">No se encontraron productos en esta Nota de Venta.</td></tr>
                    ) : isPreparation ? (
                      preparationLines.map(line => {
                        const quantity = lineDrafts[line.id] ?? (line.prepared_quantity == null ? '' : String(line.prepared_quantity))
                        return (
                          <Fragment key={line.id}>
                            <tr className={`border-b border-[#E8DFD5] align-middle transition-colors ${line.excluded_from_dispatch ? 'bg-[#F4F0EC] opacity-70' : 'hover:bg-[#FCFBF9]'}`}>
                              <td className="px-3 py-2"><p className="break-all font-mono text-[11px] font-semibold text-theme-text">{line.sku || '—'}</p></td>
                              <td className="px-3 py-2"><p className="max-w-[520px] truncate text-xs font-semibold text-theme-text" title={line.product_name}>{line.product_name}</p></td>
                              <td className="px-2 py-2 text-center text-xs font-bold tabular-nums text-theme-text">{line.requested_quantity}</td>
                              <td className="px-2 py-2 text-center">
                                <input
                                  type="number"
                                  min={0}
                                  max={line.requested_quantity}
                                  step="any"
                                  aria-label={`Cantidad a despachar de ${line.product_name}`}
                                  placeholder={line.prepared_quantity == null ? '—' : undefined}
                                  value={quantity}
                                  disabled={savingLineId === line.id || line.excluded_from_dispatch || isReadOnly}
                                  onFocus={() => setLineDrafts(current => ({ ...current, [line.id]: '' }))}
                                  onBlur={() => setLineDrafts(current => {
                                    if (current[line.id]?.trim() !== '') return current
                                    const next = { ...current }
                                    delete next[line.id]
                                    return next
                                  })}
                                  onChange={event => setLineDrafts(current => ({ ...current, [line.id]: event.target.value }))}
                                  onKeyDown={event => { if (event.key === 'Enter') confirmLineInput(line) }}
                                  className="w-20 rounded border border-[#D1C7BD] bg-white px-1.5 py-1 text-center text-xs font-bold tabular-nums text-theme-text placeholder:text-theme-text-muted focus:border-[#72383D] focus:outline-none focus:ring-1 focus:ring-[#72383D]/20 disabled:bg-[#F0ECE8] disabled:opacity-60"
                                />
                              </td>
                              <td className="px-2 py-2">
                                <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${lineStateClasses(line)}`}>
                                  {lineStateLabel(line)}
                                </span>
                                {line.excluded_from_dispatch && <p className="mt-0.5 text-[9px] text-theme-text-muted">No se despacha</p>}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center justify-center gap-2">
                                  <button type="button" disabled={savingLineId === line.id || line.excluded_from_dispatch || isReadOnly} onClick={() => confirmLineInput(line)} className="rounded bg-[#72383D] px-2 py-1 text-[10px] font-bold text-white hover:bg-[#612F34] disabled:opacity-40">
                                    {savingLineId === line.id ? 'Guardando…' : 'Confirmar'}
                                  </button>
                                  <button type="button" disabled={savingLineId === line.id || line.excluded_from_dispatch || isReadOnly} onClick={() => confirmLineInput(line, true)} className="rounded border border-[#8A4B4B]/30 bg-[#8A4B4B]/5 px-2 py-1 text-[10px] font-semibold text-[#8A4B4B] hover:bg-[#8A4B4B]/10 disabled:opacity-40">
                                    Excluir
                                  </button>
                                </div>
                              </td>
                            </tr>
                            {line.line_status === 'INCIDENT' && !line.excluded_from_dispatch && (
                              <tr className="border-b border-[#E8DFD5] bg-amber-50/40">
                                <td colSpan={6} className="px-3 py-1.5 text-[10px] text-theme-text">
                                  <span className="inline-flex items-center gap-1 font-semibold text-amber-800"><AlertTriangle className="h-3 w-3" /> Incidencia</span>
                                  <span className="ml-3 text-theme-text-muted">Solicitado {line.requested_quantity} · A despachar {line.prepared_quantity ?? '—'} · Diferencia {(line.prepared_quantity ?? 0) - line.requested_quantity}</span>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })
                    ) : (
                      items.map(item => (
                        <tr key={item.detail_id} className="border-b border-[#E8DFD5] align-middle hover:bg-[#FCFBF9]">
                          <td className="px-3 py-2"><p className="break-all font-mono text-[11px] font-semibold text-theme-text">{item.sku || '—'}</p></td>
                          <td className="px-3 py-2"><p className="max-w-[620px] truncate text-xs font-semibold text-theme-text" title={item.product_name}>{item.product_name}</p></td>
                          <td className="px-2 py-2 text-center text-xs font-bold tabular-nums text-theme-text">{item.quantity}</td>
                          <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums text-theme-text">
                            {item.unit_net_value != null ? `$ ${item.unit_net_value.toLocaleString('es-CL')}` : '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {lineError && isPreparation && <p className="rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-3 py-2 text-xs text-[#8A4B4B]">{lineError}</p>}

              <details className="group rounded-lg border border-[#DDD4CA] bg-white shadow-xs">
                <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-2 text-[10px] font-bold uppercase tracking-wider text-[#6B625C] transition-colors hover:bg-[#F8F5F1]">
                  <span className="flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-[#72383D]" /> Datos de despacho y cliente</span>
                  <span className="text-[10px] font-normal text-theme-text-muted transition-transform group-open:rotate-180">▼</span>
                </summary>
                <div className="space-y-3 border-t border-[#DDD4CA]/60 bg-[#FCFBF9] p-3.5">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                    <div><p className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted"><Hash className="h-3 w-3" /> RUT</p><p className="font-medium text-theme-text">{clientData?.rut || 'No disponible'}</p></div>
                    <div><p className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted"><Building2 className="h-3 w-3" /> Comuna</p><p className="font-medium text-theme-text">{comuna}</p></div>
                    <div className="col-span-2"><p className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted"><MapPin className="h-3 w-3" /> Dirección</p><p className="font-medium text-theme-text">{card.address_raw || 'Sin dirección registrada'}</p></div>
                    <div><p className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted">Ciudad</p><p className="font-medium text-theme-text">{card.city_raw || 'Sin ciudad'}</p></div>
                    <div><p className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted"><User className="h-3 w-3" /> Vendedor</p><p className="truncate font-medium text-theme-text" title={card.seller_name || ''}>{card.seller_name || 'Sin asignar'}</p></div>
                    <div><p className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted">Fecha emisión</p><p className="font-medium text-theme-text">{dateStr}</p></div>
                    <div><p className="mb-0.5 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted">Cantidad total</p><p className="font-medium text-theme-text">{card.total_quantity} unidades</p></div>
                  </div>
                </div>
              </details>

              <details className="group rounded-lg border border-[#DDD4CA] bg-white shadow-xs" onToggle={handleMovementsToggle}>
                <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-2 text-[10px] font-bold uppercase tracking-wider text-[#6B625C] transition-colors hover:bg-[#F8F5F1]">
                  <span>Historial de Movimientos ({movementsLoaded ? movements.length : '—'})</span>
                  <span className="text-[10px] font-normal text-theme-text-muted transition-transform group-open:rotate-180">▼</span>
                </summary>
                <div className="max-h-[180px] space-y-2 overflow-y-auto border-t border-[#DDD4CA]/60 bg-[#FCFBF9] p-3 text-xs">
                  {loadingMovements ? (
                    <div className="text-center text-xs text-theme-text-muted">Cargando historial…</div>
                  ) : movements.length === 0 ? (
                    <div className="text-center text-xs text-theme-text-muted">Sin movimientos registrados.</div>
                  ) : (
                    movements.map(m => (
                      <div key={m.id} className="border-b border-[#DDD4CA]/40 pb-2 last:border-0 last:pb-0">
                        <p className="text-xs font-semibold">{m.metadata?.moved_by_name || 'Sistema'}</p>
                        <p className="text-[10px] text-theme-text-muted">{new Date(m.created_at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                        <p className="mt-0.5 text-xs"><span className="text-theme-text-muted/70">{m.from_status ? statusLabel(m.from_status) : 'Inicio'}</span><span className="mx-1">→</span><span className="font-bold text-theme-accent">{statusLabel(m.to_status)}</span></p>
                        {m.observation && <p className="mt-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] italic text-amber-700">Obs: {m.observation}</p>}
                      </div>
                    ))
                  )}
                </div>
              </details>
            </section>

            <aside className="self-start xl:sticky xl:top-4">
              <div className="space-y-3 rounded-lg border border-[#DDD4CA] bg-white p-3 shadow-xs">
                <div className="flex items-center gap-1.5">
                  <Package className="h-4 w-4 text-[#72383D]" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-theme-text">Operación</h3>
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <SideStat label="Estado" value={statusLabel(card.status)} />
                  <SideStat label="Preparador" value={preparerName} />
                  <SideStat label="Facturación" value={billingLabel} />
                  <SideStat label="Unidades" value={`${card.total_quantity} un.`} />
                  <SideStat label="Neto" value={netLabel} accent />
                </div>

                {isPreparation && (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-[#E8DFD5] pt-3">
                    <SideStat label="Líneas" value={operationalLines.length} />
                    <SideStat label="Confirmadas" value={confirmedLines} />
                    <SideStat label="Pendientes" value={pendingLines.length} />
                    <SideStat label="Incidencias" value={incidentLines.length} />
                    <SideStat label="Solicitadas" value={requestedUnits} />
                    <SideStat label="Preparadas" value={preparedUnits} />
                  </div>
                )}

                {isPreparation && (isReadOnly || showClaimPreparation || showTakeoverPreparation) && (
                  <div className="rounded-md border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">
                    <p className="flex items-center gap-1 font-bold"><LockKeyhole className="h-3.5 w-3.5 shrink-0" /> {card.locked_by_user_id ? `En preparación por ${lockOwnerName}` : 'Sin responsable asignado'}</p>
                    <p className="mt-0.5 text-[10px] text-amber-900/75">{isReadOnly ? 'Modo sólo lectura.' : 'Tienes el control exclusivo.'}</p>
                    {(showClaimPreparation || showTakeoverPreparation) && (
                      <button type="button" onClick={() => void handleTakePreparation()} disabled={isTakingPreparation} className="mt-1.5 w-full rounded bg-[#72383D] px-2 py-1.5 text-[10px] font-bold text-white hover:bg-[#612F34] disabled:opacity-50">
                        {isTakingPreparation ? 'Tomando…' : 'Tomar preparación'}
                      </button>
                    )}
                  </div>
                )}

                {printError && <p className="rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-2 py-1.5 text-[10px] text-[#8A4B4B]">{printError}</p>}
                {moveError && !pendingMoveAction && <p className="rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-2 py-1.5 text-[10px] text-[#8A4B4B]">{moveError}</p>}

                <div className="border-t border-[#E8DFD5] pt-3">
                  {pendingMoveAction ? (
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text">Observación requerida: <span className="text-[#72383D]">{pendingMoveAction.label}</span></p>
                      <textarea
                        className="w-full resize-none rounded border border-[#DDD4CA] bg-white p-2 text-xs text-theme-text focus:border-[#72383D] focus:outline-none focus:ring-1 focus:ring-[#72383D]/20"
                        placeholder="Indica el motivo de este cambio…"
                        rows={3}
                        value={observation}
                        onChange={e => setObservation(e.target.value)}
                      />
                      {moveError && <p className="text-[10px] text-red-500">{moveError}</p>}
                      <div className="flex gap-2">
                        <button disabled={isMoving || observation.trim() === ''} onClick={() => executeMove(pendingMoveAction.toStatus, observation)} className="flex-1 rounded bg-[#72383D] px-2 py-1.5 text-[10px] font-bold text-white hover:bg-[#612F34] disabled:opacity-50">{isMoving ? 'Guardando…' : 'Confirmar'}</button>
                        <button onClick={() => setPendingMoveAction(null)} className="flex-1 rounded border border-[#DDD4CA] bg-white px-2 py-1.5 text-[10px] font-semibold text-[#322D29]/75 hover:bg-[#F5F0EA]">Cancelar</button>
                      </div>
                    </div>
                  ) : card.status === 'PENDING_ROUTE_PREP' ? (
                    <div className="space-y-2">
                      <button onClick={() => void handlePrintAndPrepare()} disabled={!canPrint || isPrinting || isMoving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#72383D] px-3 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-xs transition-colors hover:bg-[#612F34] disabled:opacity-50">
                        <Printer className="h-4 w-4" /> {isPrinting ? 'Generando documento…' : 'Imprimir y preparar'}
                      </button>
                      <button onClick={() => handleMove('IN_PREPARATION', MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.backward, MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.label)} disabled={isMoving} className="w-full rounded-lg border border-[#D1C7BD] bg-white px-3 py-2 text-xs font-semibold text-[#322D29]/80 shadow-xs transition-colors hover:bg-[#F5F0EA] disabled:opacity-50">
                        {MOVEMENT_RULES.PENDING_ROUTE_PREP.IN_PREPARATION.label}
                      </button>
                      <button onClick={handlePrintOnly} disabled={!canPrint || isPrinting} className="flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-[#322D29]/65 transition-colors hover:bg-black/5 hover:text-[#322D29] disabled:opacity-50">
                        <Printer className="h-3.5 w-3.5" /> Imprimir sin cambiar estado
                      </button>
                    </div>
                  ) : card.status === 'IN_PREPARATION' ? (
                    <div className="space-y-2">
                      <button onClick={() => handleMove('IN_AUDIT', MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.backward, MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.label)} disabled={isMoving || isReadOnly} className="w-full rounded-lg bg-purple-600 px-3 py-2 text-xs font-bold text-white shadow-xs transition-colors hover:bg-purple-700 disabled:opacity-50">
                        {MOVEMENT_RULES.IN_PREPARATION.IN_AUDIT.label}
                      </button>
                      <button onClick={() => handleMove('PENDING_ROUTE_PREP', MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.backward, MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.label)} disabled={isMoving || isReadOnly} className="w-full rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 shadow-xs transition-colors hover:bg-amber-100 disabled:opacity-50">
                        {MOVEMENT_RULES.IN_PREPARATION.PENDING_ROUTE_PREP.label}
                      </button>
                      <button onClick={handlePrintOnly} disabled={!canPrint || isPrinting} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#D1C7BD] bg-white px-3 py-2 text-xs font-semibold text-[#322D29]/80 shadow-xs transition-colors hover:bg-[#F5F0EA] disabled:opacity-50">
                        <Printer className="h-3.5 w-3.5" /> Imprimir
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </aside>
          </div>
        </div>

        <div className="flex flex-none justify-end border-t border-[#D1C7BD] bg-white px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-[#DDD4CA] bg-white px-4 py-2 text-xs font-semibold text-[#322D29]/80 hover:bg-[#F5F0EA]">
            Cerrar detalle
          </button>
        </div>

      </div>
    </>
  )
}
