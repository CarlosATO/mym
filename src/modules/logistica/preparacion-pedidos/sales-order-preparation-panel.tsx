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
  locked?: boolean
}

const COLUMNS: KanbanColumn[] = [
  {
    id: 'PENDING_ROUTE_PREP',
    title: 'Pendiente / Próxima Ruta',
    colorHeader: 'border-orange-500/40 bg-orange-500/8',
    colorBody: 'bg-orange-500/3',
    badge: 'bg-orange-500/15 text-orange-400',
  },
  {
    id: 'IN_PREPARATION',
    title: 'En Preparación',
    colorHeader: 'border-blue-500/40 bg-blue-500/8',
    colorBody: 'bg-blue-500/3',
    badge: 'bg-blue-500/15 text-blue-400',
  },
  {
    id: 'IN_AUDIT',
    title: 'En Auditoría',
    colorHeader: 'border-purple-500/40 bg-purple-500/8',
    colorBody: 'bg-purple-500/3',
    badge: 'bg-purple-500/15 text-purple-400',
  },
  {
    id: 'INVOICED_READY_FOR_ROUTE',
    title: 'Facturada / Lista',
    colorHeader: 'border-green-500/40 bg-green-500/8',
    colorBody: 'bg-green-500/3',
    badge: 'bg-green-500/15 text-green-400',
    locked: true,
  },
  {
    id: 'CANCELLED',
    title: 'Canceladas',
    colorHeader: 'border-red-500/30 bg-red-500/5',
    colorBody: 'bg-red-500/3',
    badge: 'bg-red-500/15 text-red-400',
  },
]

function DroppableColumn({ col, colCards, onOpenCardDetails }: { col: KanbanColumn, colCards: SalesOrderPreparationCardInfo[], onOpenCardDetails: (c: SalesOrderPreparationCardInfo) => void }) {
  const { setNodeRef, isOver } = useDroppable({
    id: col.id,
    disabled: col.locked
  })

  return (
    <div ref={setNodeRef} className={`flex flex-col rounded-xl border ${col.colorHeader} overflow-hidden min-w-0 ${isOver ? 'ring-2 ring-theme-accent ring-inset' : ''}`}>
      {/* Column header */}
      <div className="flex-none flex items-center justify-between px-3 py-2 border-b border-theme-border/30">
        <div className="flex items-center gap-1.5 min-w-0">
          {col.locked && <Lock className="w-3 h-3 text-theme-text-muted/60 shrink-0" />}
          <h3 className="text-xs font-semibold text-theme-text leading-tight truncate">{col.title}</h3>
        </div>
        <span className={`ml-1.5 shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${col.badge}`}>
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
          <p className="pt-6 text-center text-[10px] text-theme-text-muted/40">Sin tarjetas</p>
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
      <div className="flex-none px-4 pt-4 pb-3 border-b border-theme-border bg-theme-panel">
        <div className="flex items-center justify-between mb-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <KanbanSquare className="w-5 h-5 text-theme-accent" />
                <h1 className="text-base font-bold text-theme-text">Próxima ruta a preparar</h1>
                <span className="px-2 py-0.5 rounded-full bg-theme-accent/10 text-theme-accent text-xs font-bold">
                  {filteredCards.length} {filteredCards.length === 1 ? 'pedido en tablero' : 'pedidos en tablero'}
                </span>
              </div>
              {loadingPreview ? (
                <div className="text-xs text-theme-text-muted flex gap-2 items-center border-l border-theme-border pl-3">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Buscando próxima ruta...
                </div>
              ) : previewError ? (
                <div className="text-xs text-red-500 border-l border-theme-border pl-3 flex gap-1 items-center">
                  <span>Error: No se pudo cargar la próxima ruta.</span>
                  <span className="hidden group-hover:inline-block">({previewError})</span>
                </div>
              ) : previewInfo && previewInfo.has_route ? (
                <div className="text-xs text-theme-text-muted flex gap-2 items-center border-l border-theme-border pl-3">
                  <span className="font-semibold text-theme-text">Salida: {previewInfo.route_date ? (() => { const [y,m,d] = previewInfo.route_date.split('-'); return `${d}-${m}-${y}`; })() : ''}</span>
                  <span>·</span>
                  <span className="truncate max-w-[200px]" title={previewInfo.cities?.join(', ')}>
                    {previewInfo.cities?.length} {previewInfo.cities?.length === 1 ? 'comuna' : 'comunas'}
                  </span>
                  <span>·</span>
                  <span>Corte automático: {previewInfo.cutoff_at_chile ? previewInfo.cutoff_at_chile : previewInfo.cutoff_at ? new Date(previewInfo.cutoff_at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                  <div className="flex gap-2 ml-2 pl-2 border-l border-theme-border">
                    {previewInfo.counts?.in_cutoff === 0 && (previewInfo.counts?.existing_cards ?? 0) > 0 ? (
                      <span className="text-blue-500 font-medium">Ya materializados: {previewInfo.counts?.existing_cards}</span>
                    ) : (
                      <>
                        <span className="text-green-600 font-medium">Nuevos Incluidos: {previewInfo.counts?.in_cutoff ?? 0}</span>
                        {(previewInfo.counts?.existing_cards ?? 0) > 0 && (
                          <span className="text-blue-500 font-medium">Existentes: {previewInfo.counts?.existing_cards}</span>
                        )}
                      </>
                    )}
                    <span className="text-red-500 font-medium cursor-pointer hover:underline" onClick={() => {/* TODO */}}>Fuera de corte: {previewInfo.counts?.out_cutoff ?? 0}</span>
                    {(previewInfo.counts?.exceptions ?? 0) > 0 && <span className="text-orange-500 font-medium">Excepciones: {previewInfo.counts?.exceptions}</span>}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-theme-text-muted border-l border-theme-border pl-3">
                  No hay próxima ruta configurada o sin pedidos pendientes.
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowAdvanced(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${showAdvanced ? 'bg-theme-accent/15 text-theme-accent' : 'bg-theme-border/30 text-theme-text-muted hover:bg-theme-border/50'}`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Filtros{showAdvanced ? ' ▲' : ' ▼'}
          </button>
        </div>

        {/* Search row */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-text-muted" />
            <input
              type="text"
              placeholder="Folio, cliente o ciudad…"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-theme-base border border-theme-border rounded-lg text-xs text-theme-text focus:outline-none focus:border-theme-accent transition-colors"
            />
          </div>

          {showAdvanced && (
            <>
              <select
                value={filterCity}
                onChange={e => setFilterCity(e.target.value)}
                className="py-1.5 px-3 bg-theme-base border border-theme-border rounded-lg text-xs text-theme-text focus:outline-none focus:border-theme-accent"
              >
                <option value="">Todas las comunas</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select
                value={filterSeller}
                onChange={e => setFilterSeller(e.target.value)}
                className="py-1.5 px-3 bg-theme-base border border-theme-border rounded-lg text-xs text-theme-text focus:outline-none focus:border-theme-accent"
              >
                <option value="">Todos los vendedores</option>
                {sellers.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </>
          )}

          {hasFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
            >
              <RotateCcw className="w-3 h-3" /> Limpiar
            </button>
          )}
        </div>
      </div>

      {/* ── Kanban Board ── */}
      <div className="flex-1 overflow-hidden p-3">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center text-theme-text-muted space-y-3">
            <Loader2 className="w-7 h-7 animate-spin text-theme-accent" />
            <p className="text-sm font-medium">Cargando tablero…</p>
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-red-500 text-sm font-medium">{error}</div>
        ) : (
          /* Grid de 5 columnas, todas en pantalla, sin scroll horizontal */
          <div className="grid grid-cols-5 gap-3 h-full">
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
