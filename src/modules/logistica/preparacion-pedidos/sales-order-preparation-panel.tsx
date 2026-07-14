'use client'

import { useEffect, useState } from 'react'
import { Search, MapPin, Calendar, Users, SlidersHorizontal, Info, KanbanSquare, Loader2 } from 'lucide-react'
import { 
  getSalesOrderPreparationBoard, 
  getSalesOrderPreparationItems,
  previewSalesOrderPreparationCandidates,
  SalesOrderPreparationCardInfo,
  SalesOrderPreparationItem,
  PreviewCandidatesResult
} from '@/app/actions/logistica/sales-order-preparation'
import { SalesOrderCard } from './sales-order-card'
import { SalesOrderDrawer } from './sales-order-drawer'


type KanbanColumn = {
  id: string
  title: string
  color: string
}

const COLUMNS: KanbanColumn[] = [
  { id: 'PENDING_ROUTE_PREP', title: 'Pendiente / Próxima Ruta', color: 'border-orange-500/30 bg-orange-500/5' },
  { id: 'IN_PREPARATION', title: 'En Preparación', color: 'border-blue-500/30 bg-blue-500/5' },
  { id: 'IN_AUDIT', title: 'En Auditoría', color: 'border-purple-500/30 bg-purple-500/5' },
  { id: 'INVOICED_READY_FOR_ROUTE', title: 'Facturada / Lista', color: 'border-green-500/30 bg-green-500/5 opacity-80' },
  { id: 'CANCELLED', title: 'Canceladas', color: 'border-red-500/30 bg-red-500/5' }
]

export function SalesOrderPreparationPanel() {
  const companyId = 'd1000000-0000-0000-0000-000000000001'

  const [cards, setCards] = useState<SalesOrderPreparationCardInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  // Drawer state
  const [selectedCard, setSelectedCard] = useState<SalesOrderPreparationCardInfo | null>(null)
  const [selectedItems, setSelectedItems] = useState<SalesOrderPreparationItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)

  // Filters state (front-end only for now)
  const [searchTerm, setSearchTerm] = useState('')

  // Preview state
  const [previewFrom, setPreviewFrom] = useState('')
  const [previewTo, setPreviewTo] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewResult, setPreviewResult] = useState<PreviewCandidatesResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const handlePreview = async () => {
    if (!previewFrom || !previewTo) return
    setPreviewLoading(true)
    setPreviewError(null)
    const res = await previewSalesOrderPreparationCandidates(companyId, previewFrom, previewTo)
    if (res.error) {
      setPreviewError(res.error)
    } else {
      setPreviewResult(res.data)
    }
    setPreviewLoading(false)
  }

  useEffect(() => {
    async function loadBoard() {
      setLoading(true)
      const res = await getSalesOrderPreparationBoard(companyId)
      if (res.error) {
        setError(res.error)
      } else {
        setCards(res.data || [])
      }
      setLoading(false)
    }
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

  const filteredCards = cards.filter(card => {
    if (!searchTerm) return true
    const term = searchTerm.toLowerCase()
    return (
      card.nv_folio.toLowerCase().includes(term) ||
      card.client_name.toLowerCase().includes(term) ||
      (card.normalized_city && card.normalized_city.toLowerCase().includes(term))
    )
  })

  return (
    <div className="h-[calc(100vh-160px)] flex flex-col bg-theme-base rounded-2xl border border-theme-border shadow-sm overflow-hidden relative">
      {/* Header & Toolbars */}
      <div className="flex-none p-6 border-b border-theme-border bg-theme-panel">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-bold text-theme-text flex items-center gap-2">
              <KanbanSquare className="w-6 h-6 text-theme-accent" />
              Preparación de Pedidos
            </h1>
            <p className="text-sm text-theme-text-muted mt-1">
              Notas de Venta de Bsale organizadas para preparación en bodega.
            </p>
          </div>
          
          <div className="flex items-center gap-4 text-sm font-medium">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-theme-border/20 rounded-lg text-theme-text">
              <span className="text-theme-accent">{cards.length}</span> Totales
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[250px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted" />
            <input 
              type="text" 
              placeholder="Buscar por folio, cliente o ciudad..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-theme-base border border-theme-border rounded-xl text-sm text-theme-text focus:outline-none focus:border-theme-accent transition-colors"
            />
          </div>
          <button className="flex items-center gap-2 px-4 py-2 bg-theme-border/20 hover:bg-theme-border/40 text-theme-text text-sm font-medium rounded-xl transition-colors">
            <SlidersHorizontal className="w-4 h-4" /> Filtros
          </button>
        </div>
      </div>

      {/* Kanban Board Area */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden bg-theme-base/50 p-6">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center text-theme-text-muted space-y-4">
            <Loader2 className="w-8 h-8 animate-spin text-theme-accent" />
            <p className="font-medium">Cargando tablero...</p>
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-red-500 font-medium">
            Error al cargar: {error}
          </div>
        ) : cards.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto">
            <div className="w-16 h-16 bg-theme-accent/10 text-theme-accent rounded-full flex items-center justify-center mb-6">
              <KanbanSquare className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-semibold text-theme-text mb-2">No hay tarjetas de preparación creadas todavía.</h3>
            <p className="text-sm text-theme-text-muted mb-6">
              Las Notas de Venta ya están disponibles desde Bsale. La creación de tarjetas se realizará de forma controlada por rango de fechas en sincronizaciones futuras.
            </p>
            <div className="px-4 py-3 bg-blue-500/10 border border-blue-500/20 rounded-xl text-blue-500 text-sm flex items-start gap-3 text-left mb-6">
              <Info className="w-5 h-5 shrink-0 mt-0.5" />
              <p>Módulo en fase de despliegue inicial (Solo Lectura). Próximamente se habilitará la importación de tarjetas.</p>
            </div>

            {/* Preview Box */}
            <div className="w-full max-w-md bg-theme-panel border border-theme-border rounded-xl p-5 shadow-sm text-left">
              <h4 className="font-semibold text-theme-text flex items-center gap-2 mb-4">
                <Search className="w-4 h-4 text-theme-text-muted" />
                Previsualizar Notas de Venta disponibles
              </h4>
              
              <div className="flex gap-3 mb-4">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-theme-text-muted mb-1">Desde</label>
                  <input 
                    type="date" 
                    value={previewFrom}
                    onChange={(e) => setPreviewFrom(e.target.value)}
                    className="w-full bg-theme-base border border-theme-border rounded-lg px-3 py-2 text-sm text-theme-text focus:border-theme-accent focus:ring-1 focus:ring-theme-accent outline-none transition-all"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-theme-text-muted mb-1">Hasta</label>
                  <input 
                    type="date" 
                    value={previewTo}
                    onChange={(e) => setPreviewTo(e.target.value)}
                    className="w-full bg-theme-base border border-theme-border rounded-lg px-3 py-2 text-sm text-theme-text focus:border-theme-accent focus:ring-1 focus:ring-theme-accent outline-none transition-all"
                  />
                </div>
              </div>

              <button
                onClick={handlePreview}
                disabled={!previewFrom || !previewTo || previewLoading}
                className="w-full py-2 bg-theme-accent hover:bg-theme-accent-hover text-white rounded-lg font-medium text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {previewLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                Previsualizar
              </button>

              {previewError && (
                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 text-red-500 text-sm rounded-lg">
                  {previewError}
                </div>
              )}

              {previewResult && !previewLoading && (
                <div className="mt-4 space-y-2 border-t border-theme-border pt-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-theme-text-muted">Total candidatas:</span>
                    <span className="font-semibold text-theme-text">{previewResult.total_candidates}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-theme-text-muted">Ya creadas:</span>
                    <span className="font-semibold text-theme-text">{previewResult.already_materialized}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-theme-text-muted">Pendientes de crear:</span>
                    <span className="font-semibold text-theme-accent">{previewResult.pending_to_create}</span>
                  </div>
                  <p className="text-[11px] text-orange-500 mt-3 flex items-start gap-1.5 bg-orange-500/10 p-2 rounded-lg border border-orange-500/20">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    Esta acción solo consulta datos. No crea tarjetas.
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex gap-6 h-full min-w-max pb-4">
            {COLUMNS.map(col => {
              const colCards = filteredCards.filter(c => c.status === col.id)
              
              return (
                <div key={col.id} className={`flex flex-col w-[320px] rounded-xl border ${col.color} overflow-hidden`}>
                  {/* Column Header */}
                  <div className="px-4 py-3 border-b border-theme-border/50 flex items-center justify-between bg-theme-panel/50 backdrop-blur-sm">
                    <h3 className="font-semibold text-sm text-theme-text">{col.title}</h3>
                    <span className="px-2 py-0.5 bg-theme-base rounded-full text-xs font-bold text-theme-text-muted">
                      {colCards.length}
                    </span>
                  </div>

                  {/* Column Body */}
                  <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
                    {col.id === 'INVOICED_READY_FOR_ROUTE' && colCards.length === 0 && (
                      <div className="p-4 border border-dashed border-theme-border rounded-xl text-center">
                        <Info className="w-5 h-5 text-theme-text-muted mx-auto mb-2" />
                        <p className="text-xs text-theme-text-muted leading-relaxed">
                          Movimiento automático pendiente de integración factura Bsale.
                        </p>
                      </div>
                    )}
                    {colCards.map(card => (
                      <SalesOrderCard 
                        key={card.card_id} 
                        card={card} 
                        onClick={() => openCardDetails(card)} 
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Drawer */}
      <SalesOrderDrawer 
        card={selectedCard}
        items={selectedItems}
        isLoadingItems={loadingItems}
        onClose={() => setSelectedCard(null)}
      />
    </div>
  )
}
