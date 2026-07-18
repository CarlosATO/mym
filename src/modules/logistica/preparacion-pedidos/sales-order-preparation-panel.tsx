'use client'

import { useEffect, useState, useMemo } from 'react'
import { Search, SlidersHorizontal, KanbanSquare, Loader2, RotateCcw, Lock } from 'lucide-react'
import { 
  getSalesOrderPreparationBoard, 
  getSalesOrderPreparationItems,
  previewNextRouteCandidates,
  PreviewNextRouteResult,
  SalesOrderPreparationCardInfo,
  SalesOrderPreparationItem,
} from '@/app/actions/logistica/sales-order-preparation'
import { SalesOrderCard } from './sales-order-card'
import { SalesOrderDrawer } from './sales-order-drawer'
import { DndContext, DragEndEvent, DragStartEvent, DragOverlay, useDroppable, useSensor, useSensors, PointerSensor } from '@dnd-kit/core'
import { getMovementRule } from './movement-rules'
import { MovementObservationDialog } from './movement-observation-dialog'
import { moveSalesOrderPreparationCard } from '@/app/actions/logistica/sales-order-preparation'
import { toast } from 'sonner'

type KanbanColumn = {
  id: string
  title: string
  colorHeader: string
  colorBody: string
  badge: string
  dot: string
  locked?: boolean
}

const COLUMNS: KanbanColumn[] = [
  {
    id: 'PENDING_ROUTE_PREP',
    title: 'Pendiente / Próxima Ruta',
    colorHeader: 'bg-theme-base border-slate-300 dark:border-theme-border/80',
    colorBody: 'bg-theme-base/30',
    badge: 'bg-theme-panel border-slate-300 dark:border-theme-border/80 text-theme-text',
    dot: 'bg-orange-500',
  },
  {
    id: 'IN_PREPARATION',
    title: 'En Preparación',
    colorHeader: 'bg-theme-base border-slate-300 dark:border-theme-border/80',
    colorBody: 'bg-theme-base/30',
    badge: 'bg-theme-panel border-slate-300 dark:border-theme-border/80 text-theme-text',
    dot: 'bg-blue-500',
  },
  {
    id: 'IN_AUDIT',
    title: 'En Auditoría',
    colorHeader: 'bg-theme-base border-slate-300 dark:border-theme-border/80',
    colorBody: 'bg-theme-base/30',
    badge: 'bg-theme-panel border-slate-300 dark:border-theme-border/80 text-theme-text',
    dot: 'bg-purple-500',
  },
  {
    id: 'INVOICED_READY_FOR_ROUTE',
    title: 'Facturada / Lista',
    colorHeader: 'bg-theme-base border-slate-300 dark:border-theme-border/80',
    colorBody: 'bg-theme-base/30',
    badge: 'bg-theme-panel border-slate-300 dark:border-theme-border/80 text-theme-text',
    dot: 'bg-green-500',
    locked: true,
  },
  {
    id: 'CANCELLED',
    title: 'Canceladas',
    colorHeader: 'bg-theme-base border-slate-300 dark:border-theme-border/80',
    colorBody: 'bg-theme-base/30',
    badge: 'bg-theme-panel border-slate-300 dark:border-theme-border/80 text-theme-text',
    dot: 'bg-red-500',
  },
]

function DroppableColumn({ col, colCards, onOpenCardDetails }: { col: KanbanColumn, colCards: SalesOrderPreparationCardInfo[], onOpenCardDetails: (c: SalesOrderPreparationCardInfo) => void }) {
  const { setNodeRef, isOver } = useDroppable({
    id: col.id,
    disabled: col.locked
  })

  return (
    <div ref={setNodeRef} className={`flex flex-col rounded-lg border border-slate-300 dark:border-theme-border/80 bg-theme-panel shadow-sm overflow-hidden min-w-0 transition-all ${isOver ? 'ring-2 ring-theme-accent ring-inset' : ''}`}>
      {/* Column header */}
      <div className={`flex-none flex items-center justify-between px-3 py-2.5 border-b ${col.colorHeader}`}>
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full ${col.dot} shrink-0`} />
          {col.locked && <Lock className="w-3 h-3 text-theme-text-muted/60 shrink-0" />}
          <h3 className="text-xs font-bold text-theme-text leading-tight truncate">{col.title}</h3>
        </div>
        <span className={`ml-2 shrink-0 px-2 py-0.5 rounded text-[10px] font-bold border ${col.badge}`}>
          {colCards.length}
        </span>
      </div>

      {/* Column body */}
      <div className={`flex-1 overflow-y-auto p-2 space-y-2 ${col.colorBody}`}>
        {col.locked && colCards.length === 0 && (
          <div className="pt-4 px-2 text-center">
            <Lock className="w-4 h-4 text-theme-text-muted/40 mx-auto mb-1.5" />
            <p className="text-[10px] text-theme-text-muted/60 leading-snug">
              Movimiento automático al detectar factura en Bsale.
            </p>
          </div>
        )}
        {colCards.length === 0 && !col.locked && (
          <p className="pt-6 text-center text-[10px] font-medium text-theme-text-muted/60">Sin tarjetas</p>
        )}
        {colCards.map(card => (
          <SalesOrderCard
            key={card.card_id}
            card={card}
            onClick={() => onOpenCardDetails(card)}
          />
        ))}
      </div>
    </div>
  )
}

export function SalesOrderPreparationPanel() {
  const companyId = 'd1000000-0000-0000-0000-000000000001'

  const [cards, setCards] = useState<SalesOrderPreparationCardInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  const [previewInfo, setPreviewInfo] = useState<PreviewNextRouteResult | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Drawer state
  const [selectedCard, setSelectedCard] = useState<SalesOrderPreparationCardInfo | null>(null)
  const [selectedItems, setSelectedItems] = useState<SalesOrderPreparationItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)

  // Filters
  const [searchTerm, setSearchTerm] = useState('')
  const [filterCity, setFilterCity] = useState('')
  const [filterSeller, setFilterSeller] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Drag & Drop
  const [activeCard, setActiveCard] = useState<SalesOrderPreparationCardInfo | null>(null)
  const [pendingMovement, setPendingMovement] = useState<{ card: SalesOrderPreparationCardInfo, fromStatus: string, toStatus: string, label: string } | null>(null)
  const [isMoving, setIsMoving] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  )

  const loadBoard = async () => {
    setLoading(true)
    const res = await getSalesOrderPreparationBoard(companyId)
    if (res.error) {
      setError(res.error)
    } else {
      setCards(res.data || [])
      // If a card is selected, update its reference to the new one so the drawer updates
      setSelectedCard(prev => prev ? (res.data?.find(c => c.card_id === prev.card_id) || prev) : prev)
    }
    setLoading(false)
    
    setLoadingPreview(true)
    setPreviewError(null)
    try {
      const prevRes = await previewNextRouteCandidates()
      if (prevRes.error) {
        setPreviewError(prevRes.error)
      } else if (prevRes.data) {
        setPreviewInfo(prevRes.data)
      } else {
        setPreviewError('Respuesta nula del servidor')
      }
    } catch (err: any) {
      setPreviewError(err.message || 'Error desconocido')
    } finally {
      setLoadingPreview(false)
    }
  }

  useEffect(() => {
    loadBoard()
  }, [companyId])

  const openCardDetails = async (card: SalesOrderPreparationCardInfo) => {
    setSelectedCard(card)
    setLoadingItems(true)
    const res = await getSalesOrderPreparationItems(companyId, card.nv_bsale_id)
    if (!res.error && res.data) {
      setSelectedItems(res.data)
    } else {
      setSelectedItems([])
    }
    setLoadingItems(false)
  }

  const executeMove = async (card: SalesOrderPreparationCardInfo, toStatus: string, observation?: string) => {
    setIsMoving(true)
    const res = await moveSalesOrderPreparationCard({
      cardId: card.card_id,
      toStatus,
      observation
    })
    setIsMoving(false)

    if (!res.ok) {
      toast.error(`Error al mover: ${res.error ?? 'Desconocido'}`)
    } else {
      toast.success(`NV #${card.nv_folio} movida exitosamente`)
      setPendingMovement(null)
      loadBoard()
    }
  }

  const handleDragStart = (event: DragStartEvent) => {
    const card = event.active.data.current?.card as SalesOrderPreparationCardInfo
    if (card) {
      setActiveCard(card)
    }
  }

  const handleDragCancel = () => {
    setActiveCard(null)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveCard(null)
    const { active, over } = event
    if (!over) return

    const card = active.data.current?.card as SalesOrderPreparationCardInfo
    if (!card) return
    const fromStatus = card.status
    const toStatus = over.id as string

    if (fromStatus === toStatus) return

    const { rule, error } = getMovementRule(fromStatus, toStatus)
    if (error) {
      toast.error(error)
      return
    }

    if (rule?.backward) {
      setPendingMovement({ card, fromStatus, toStatus, label: rule.label })
    } else {
      await executeMove(card, toStatus)
    }
  }

  // Unique options for selects
  const cities = useMemo(() => [...new Set(cards.map(c => c.normalized_city || c.city_raw || '').filter(Boolean))].sort(), [cards])
  const sellers = useMemo(() => [...new Set(cards.map(c => c.seller_name || '').filter(Boolean))].sort(), [cards])

  const filteredCards = useMemo(() => cards.filter(card => {
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      const hit = (
        String(card.nv_folio).toLowerCase().includes(term) ||
        card.client_name.toLowerCase().includes(term) ||
        (card.normalized_city ?? '').toLowerCase().includes(term) ||
        (card.city_raw ?? '').toLowerCase().includes(term)
      )
      if (!hit) return false
    }
    if (filterCity && (card.normalized_city || card.city_raw) !== filterCity) return false
    if (filterSeller && card.seller_name !== filterSeller) return false
    return true
  }), [cards, searchTerm, filterCity, filterSeller])

  const hasFilters = searchTerm || filterCity || filterSeller
  const clearFilters = () => { setSearchTerm(''); setFilterCity(''); setFilterSeller('') }

  return (
    <div className="flex flex-col h-[calc(100vh-110px)] w-full overflow-hidden">
      {/* ── Header / Toolbar ── */}
      <div className="flex-none px-4 py-3 border-b border-theme-border bg-theme-panel shadow-sm z-10">
        <div className="flex items-center justify-between gap-4">
          
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="flex items-center gap-2 pr-3 border-r border-theme-border/50">
              <KanbanSquare className="w-4 h-4 text-theme-accent shrink-0" />
              <h1 className="text-sm font-bold text-theme-text truncate">Próxima ruta a preparar</h1>
              <span className="px-1.5 py-0.5 rounded bg-theme-base text-theme-text-muted text-[10px] font-bold border border-theme-border/50 shrink-0">
                {filteredCards.length}
              </span>
            </div>

            {loadingPreview ? (
              <div className="text-[11px] text-theme-text-muted flex gap-1.5 items-center font-medium">
                <Loader2 className="w-3 h-3 animate-spin" />
                Buscando...
              </div>
            ) : previewError ? (
              <div className="text-[11px] text-red-500 flex gap-1 items-center font-medium">
                <span>Error de ruta</span>
                <span className="opacity-80 truncate max-w-[150px]">({previewError})</span>
              </div>
            ) : previewInfo && previewInfo.has_route ? (
              <div className="flex items-center gap-3 text-[11px] text-theme-text overflow-x-auto no-scrollbar">
                <div className="flex items-center gap-1.5 bg-theme-base px-2 py-1 rounded border border-theme-border/50 whitespace-nowrap">
                  <span className="font-bold">
                    {previewInfo.route_date ? (() => { const [y,m,d] = previewInfo.route_date.split('-'); return `${d}-${m}-${y}`; })() : ''}
                  </span>
                  <span className="text-theme-text-muted">·</span>
                  <span className="truncate max-w-[150px] font-medium" title={previewInfo.cities?.join(', ')}>
                    {previewInfo.cities?.join(', ') || ''}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="text-theme-text-muted font-medium">Corte:</span>
                  <span className="font-bold">
                    {previewInfo.cutoff_at_chile ? (() => {
                      const [datePart, timePart] = previewInfo.cutoff_at_chile.split(' ')
                      const [y,m,d] = datePart.split('-')
                      return `${d}-${m}-${y} ${timePart.substring(0,5)}`
                    })() : previewInfo.cutoff_at ? new Date(previewInfo.cutoff_at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>

                <div className="flex items-center gap-4 pl-4 border-l border-theme-border/50 whitespace-nowrap">
                  {previewInfo.counts?.in_cutoff === 0 && (previewInfo.counts?.existing_cards ?? 0) > 0 ? (
                    <span className="flex items-center gap-1.5 text-theme-text-muted font-medium text-[11px]">
                      <span className="w-2 h-2 rounded-full bg-blue-500"></span>Materializados: {previewInfo.counts?.existing_cards}
                    </span>
                  ) : (
                    <>
                      <span className="flex items-center gap-1.5 text-theme-text font-bold text-[11px]">
                        <span className="w-2 h-2 rounded-full bg-green-500"></span>Nuevos: {previewInfo.counts?.in_cutoff ?? 0}
                      </span>
                      {(previewInfo.counts?.existing_cards ?? 0) > 0 && (
                        <span className="flex items-center gap-1.5 text-theme-text-muted font-medium text-[11px]">
                          <span className="w-2 h-2 rounded-full bg-blue-500"></span>Existentes: {previewInfo.counts?.existing_cards}
                        </span>
                      )}
                    </>
                  )}
                  <span className="flex items-center gap-1.5 text-theme-text font-bold text-[11px] cursor-pointer hover:underline">
                    <span className="w-2 h-2 rounded-full bg-red-500"></span>Fuera de corte: {previewInfo.counts?.out_cutoff ?? 0}
                  </span>
                  {(previewInfo.counts?.exceptions ?? 0) > 0 && (
                    <span className="flex items-center gap-1.5 text-theme-text font-bold text-[11px]">
                      <span className="w-2 h-2 rounded-full bg-orange-500"></span>Excepciones: {previewInfo.counts?.exceptions}
                    </span>
                  )}
                </div>
              </div>
            ) : previewInfo && !previewInfo.has_route ? (
              <div className="text-[11px] text-theme-text-muted font-medium">
                No hay rutas futuras configuradas.
              </div>
            ) : null}
          </div>
          
          {/* Controls */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="relative w-48">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-text-muted" />
              <input
                type="text"
                placeholder="Buscar folio, cliente..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-2 py-1.5 bg-theme-base border border-theme-border rounded text-[11px] text-theme-text font-medium focus:outline-none focus:border-theme-accent transition-colors placeholder:text-theme-text-muted/70"
              />
            </div>
            <button
              onClick={() => setShowAdvanced(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-[11px] font-bold transition-colors ${showAdvanced ? 'bg-theme-accent/10 border-theme-accent/30 text-theme-accent' : 'bg-theme-base border-theme-border text-theme-text-muted hover:bg-theme-border/40'}`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filtros
            </button>
          </div>
        </div>

        {/* Filters Expansion */}
        {showAdvanced && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-theme-border/50">
            <select
              value={filterCity}
              onChange={e => setFilterCity(e.target.value)}
              className="py-1.5 px-2 bg-theme-base border border-theme-border rounded text-[11px] font-medium text-theme-text focus:outline-none focus:border-theme-accent"
            >
              <option value="">Todas las comunas</option>
              {cities.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={filterSeller}
              onChange={e => setFilterSeller(e.target.value)}
              className="py-1.5 px-2 bg-theme-base border border-theme-border rounded text-[11px] font-medium text-theme-text focus:outline-none focus:border-theme-accent"
            >
              <option value="">Todos los vendedores</option>
              {sellers.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-bold text-theme-text-muted hover:text-theme-text transition-colors ml-auto bg-theme-base rounded border border-transparent hover:border-theme-border"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Limpiar filtros
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Kanban Board ── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden bg-slate-100/80 dark:bg-theme-base/40">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center text-theme-text-muted space-y-3">
            <Loader2 className="w-7 h-7 animate-spin text-theme-accent" />
            <p className="text-sm font-medium">Cargando tablero…</p>
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-red-500 text-sm font-medium">{error}</div>
        ) : (
          /* Grid de 5 columnas, todas en pantalla, sin scroll horizontal */
          <div className="grid grid-cols-5 gap-4 h-full p-4">
            <DndContext 
              sensors={sensors}
              onDragStart={handleDragStart} 
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              {COLUMNS.map(col => {
                const colCards = filteredCards.filter(c => c.status === col.id)
                return <DroppableColumn key={col.id} col={col} colCards={colCards} onOpenCardDetails={openCardDetails} />
              })}
              <DragOverlay zIndex={9999}>
                {activeCard ? (
                  <SalesOrderCard card={activeCard} isOverlay />
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>
        )}
      </div>

      <SalesOrderDrawer
        card={selectedCard}
        items={selectedItems}
        isLoadingItems={loadingItems}
        onClose={() => setSelectedCard(null)}
        onCardMoved={() => {
          loadBoard()
        }}
      />
      
      <MovementObservationDialog
        isOpen={!!pendingMovement}
        onClose={() => setPendingMovement(null)}
        onConfirm={(obs) => {
          if (pendingMovement) {
            executeMove(pendingMovement.card, pendingMovement.toStatus, obs)
          }
        }}
        label={pendingMovement?.label ?? ''}
        isMoving={isMoving}
      />
    </div>
  )
}
