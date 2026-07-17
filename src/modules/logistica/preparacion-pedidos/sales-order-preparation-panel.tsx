'use client'

import { useEffect, useState, useMemo } from 'react'
import { Search, SlidersHorizontal, KanbanSquare, Loader2, RotateCcw, Lock } from 'lucide-react'
import { 
  getSalesOrderPreparationBoard, 
  getSalesOrderPreparationItems,
  SalesOrderPreparationCardInfo,
  SalesOrderPreparationItem,
} from '@/app/actions/logistica/sales-order-preparation'
import { SalesOrderCard } from './sales-order-card'
import { SalesOrderDrawer } from './sales-order-drawer'

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

export function SalesOrderPreparationPanel() {
  const companyId = 'd1000000-0000-0000-0000-000000000001'

  const [cards, setCards] = useState<SalesOrderPreparationCardInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Drawer state
  const [selectedCard, setSelectedCard] = useState<SalesOrderPreparationCardInfo | null>(null)
  const [selectedItems, setSelectedItems] = useState<SalesOrderPreparationItem[]>([])
  const [loadingItems, setLoadingItems] = useState(false)

  // Filters
  const [searchTerm, setSearchTerm] = useState('')
  const [filterCity, setFilterCity] = useState('')
  const [filterSeller, setFilterSeller] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

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
                <h1 className="text-base font-bold text-theme-text">Ruta o rutas a preparar</h1>
                <span className="px-2 py-0.5 rounded-full bg-theme-accent/10 text-theme-accent text-xs font-bold">
                  {filteredCards.length} {filteredCards.length === 1 ? 'pedido' : 'pedidos'}
                </span>
              </div>
              {filteredCards.length > 0 && (() => {
                const uniqueDates = [...new Set(filteredCards.map(c => c.route_date).filter(Boolean))].sort()
                const dateStrs = uniqueDates.map(d => {
                  const [y, m, day] = d!.split('-')
                  return `${day}-${m}-${y}`
                })
                const dateText = dateStrs.length === 1 ? `Salida de ruta: ${dateStrs[0]}` : dateStrs.length > 1 ? `Salidas de ruta: ${dateStrs.join(', ')}` : 'Salida de ruta: Sin fecha asignada'
                const uniqueCities = [...new Set(filteredCards.map(c => c.normalized_city || c.city_raw).filter(Boolean))]
                return (
                  <div className="text-xs text-theme-text-muted flex gap-2 items-center border-l border-theme-border pl-3">
                    <span>{dateText}</span>
                    <span>·</span>
                    <span>{uniqueCities.length} {uniqueCities.length === 1 ? 'comuna' : 'comunas'}</span>
                    <span>·</span>
                    <span className="font-medium truncate max-w-[300px]">{uniqueCities.join(', ')}</span>
                  </div>
                )
              })()}
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
            {COLUMNS.map(col => {
              const colCards = filteredCards.filter(c => c.status === col.id)
              return (
                <div key={col.id} className={`flex flex-col rounded-xl border ${col.colorHeader} overflow-hidden min-w-0`}>
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
