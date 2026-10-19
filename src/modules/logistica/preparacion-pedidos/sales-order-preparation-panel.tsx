'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, SlidersHorizontal, KanbanSquare, Loader2, RotateCcw, RefreshCw, ShieldCheck } from 'lucide-react'
import { 
  getSalesOrderPreparationBoard, 
  getSalesOrderPreparationItems,
  syncOperationalBsaleSalesOrders,
  syncOperationalBsaleSalesOrdersIfStale,
  excludeSalesOrderPreparationNv,
  SalesOrderPreparationCardInfo,
  SalesOrderPreparationItem,
} from '@/app/actions/logistica/sales-order-preparation'
import { getWarehousePreparationSyncHealth, type WarehousePreparationSyncHealth } from '@/app/actions/integraciones/sync'
import {
  PREPARATION_SYNC_CHECK_INTERVAL_MS,
  PREPARATION_SYNC_STALE_AFTER_MINUTES,
  mergePreparationBoardRows,
  removeCardOptimistically,
  restoreCardOptimistically,
  shouldRefreshBoardAfterSync,
  type PreparationCardSnapshot,
} from './preparation-sync-policy'
import {
  markPreparationBoardFetch,
  recordPreparationDuration,
} from './preparation-performance'
import { SalesOrderCard } from './sales-order-card'
import { SalesOrderDrawer } from './sales-order-drawer'
import { PreparationExclusionDialog, type ExclusionConfirmInput, type ExclusionConfirmResult } from './preparation-exclusion-dialog'
import { PreparationExclusionsDrawer } from './preparation-exclusions-drawer'
import { DndContext, DragEndEvent, DragStartEvent, DragOverlay, useDroppable, useSensor, useSensors, PointerSensor } from '@dnd-kit/core'
import { getMovementRule } from './movement-rules'
import { MovementObservationDialog } from './movement-observation-dialog'
import { moveSalesOrderPreparationCard } from '@/app/actions/logistica/sales-order-preparation'
import { toast } from 'sonner'
import { getActiveCompanyId } from '@/app/actions/companies'

type KanbanColumn = {
  id: string
  title: string
  colorHeader: string
  colorBody: string
  badge: string
  dot: string
}

const COLUMNS: KanbanColumn[] = [
  {
    id: 'PENDING_ROUTE_PREP',
    title: 'Pendiente',
    colorHeader: 'bg-theme-base border-slate-300 dark:border-theme-border/80',
    colorBody: 'bg-theme-base/30',
    badge: 'bg-theme-panel border-slate-300 dark:border-theme-border/80 text-theme-text',
    dot: 'bg-orange-500',
  },
  {
    id: 'IN_PREPARATION',
    title: 'En preparación',
    colorHeader: 'bg-theme-base border-slate-300 dark:border-theme-border/80',
    colorBody: 'bg-theme-base/30',
    badge: 'bg-theme-panel border-slate-300 dark:border-theme-border/80 text-theme-text',
    dot: 'bg-blue-500',
  },
  {
    id: 'IN_AUDIT',
    title: 'En auditoría',
    colorHeader: 'bg-theme-base border-slate-300 dark:border-theme-border/80',
    colorBody: 'bg-theme-base/30',
    badge: 'bg-theme-panel border-slate-300 dark:border-theme-border/80 text-theme-text',
    dot: 'bg-purple-500',
  },
]

function DroppableColumn({ col, colCards, pendingCardIds, onOpenCardDetails, canExclude, onExclude }: { col: KanbanColumn, colCards: SalesOrderPreparationCardInfo[], pendingCardIds: Set<string>, onOpenCardDetails: (c: SalesOrderPreparationCardInfo) => void, canExclude: boolean, onExclude: (c: SalesOrderPreparationCardInfo) => void }) {
  const { setNodeRef, isOver } = useDroppable({
    id: col.id,
  })

  return (
    <section ref={setNodeRef} className={`min-w-[240px] border bg-[#F5F0EA] transition-colors ${isOver ? 'border-[#72383D] bg-[#F1E4DD]' : 'border-[#D1C7BD]'}`}>
      {/* Column header */}
      <div className="border-b border-[#D1C7BD] px-3 py-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#72383D]">{col.title}</h3>
          <span className="text-[10px] text-[#322D29]/50">{colCards.length}</span>
        </div>
      </div>

      {/* Column body */}
      <div className="space-y-2 p-2">
          {colCards.length === 0 && (
          <p className="pt-6 text-center text-[10px] font-medium text-theme-text-muted/60">Sin tarjetas</p>
        )}
        {colCards.map(card => (
          <SalesOrderCard
            key={card.card_id}
            card={card}
            isPending={pendingCardIds.has(card.card_id)}
            onDoubleClick={() => onOpenCardDetails(card)}
            canExclude={canExclude}
            onExclude={onExclude}
          />
        ))}
      </div>
    </section>
  )
}

export function SalesOrderPreparationPanel({ roleName = '' }: { roleName?: string }) {
  const canManageExclusions = roleName === 'SUPER_USUARIO' || roleName === 'GERENCIA'

  const [companyId, setCompanyId] = useState<string | null>(null)
  const [cards, setCards] = useState<SalesOrderPreparationCardInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  const [syncHealth, setSyncHealth] = useState<WarehousePreparationSyncHealth | null>(null)

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
  const [pendingCardIds, setPendingCardIds] = useState<Set<string>>(new Set())
  const [transitionError, setTransitionError] = useState<string | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)

  // Exclusiones administrativas
  const [excludeCard, setExcludeCard] = useState<SalesOrderPreparationCardInfo | null>(null)
  const [exclusionsOpen, setExclusionsOpen] = useState(false)
  const [exclusionsVersion, setExclusionsVersion] = useState(0)

  const [syncError, setSyncError] = useState<string | null>(null)

  const cardsRef = useRef<SalesOrderPreparationCardInfo[]>([])
  const boardRequestSeqRef = useRef(0)
  const pendingStatusByCardRef = useRef<Map<string, string>>(new Map())
  const pendingExclusionNvIdsRef = useRef<Set<number>>(new Set())
  const exclusionSnapshotsRef = useRef<Map<number, PreparationCardSnapshot<SalesOrderPreparationCardInfo>>>(new Map())
  const syncInFlightRef = useRef(false)
  const lastAutoAttemptAtRef = useRef(0)
  const lastSuccessfulRunIdRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  const persistExclusion = async (
    card: SalesOrderPreparationCardInfo,
    reason: string,
    observation: string,
  ) => {
    const startedAt = performance.now()
    try {
      const res = await excludeSalesOrderPreparationNv({
        bsaleNvId: card.nv_bsale_id,
        reason,
        observation,
      })
      if (!res.ok && res.status !== 'already_exists') {
        throw new Error(res.error || 'No se pudo excluir la Nota de Venta.')
      }

      pendingExclusionNvIdsRef.current.delete(card.nv_bsale_id)
      exclusionSnapshotsRef.current.delete(card.nv_bsale_id)
      boardRequestSeqRef.current += 1
      setExclusionsVersion(current => current + 1)

      if (res.status === 'already_exists') {
        toast.info(`La NV #${card.nv_folio} ya estaba excluida de preparación.`)
      } else {
        toast.success(`NV #${card.nv_folio} excluida de preparación`)
      }
    } catch (err: unknown) {
      pendingExclusionNvIdsRef.current.delete(card.nv_bsale_id)
      const snapshot = exclusionSnapshotsRef.current.get(card.nv_bsale_id) ?? null
      exclusionSnapshotsRef.current.delete(card.nv_bsale_id)
      boardRequestSeqRef.current += 1

      if (snapshot) {
        const restored = restoreCardOptimistically(cardsRef.current, snapshot)
        cardsRef.current = restored
        setCards(restored)
      }

      toast.error(err instanceof Error ? err.message : 'No se pudo excluir la Nota de Venta.')
    } finally {
      recordPreparationDuration('exclusionPersist', performance.now() - startedAt)
    }
  }

  const handleExclusionConfirm = async ({ reason, observation }: ExclusionConfirmInput): Promise<ExclusionConfirmResult> => {
    const card = excludeCard
    if (!card) return { ok: false, error: 'No hay Nota de Venta seleccionada.' }
    if (pendingExclusionNvIdsRef.current.has(card.nv_bsale_id)) return { ok: true }

    pendingExclusionNvIdsRef.current.add(card.nv_bsale_id)
    boardRequestSeqRef.current += 1

    const optimistic = removeCardOptimistically(cardsRef.current, card.card_id)
    if (optimistic.snapshot) {
      exclusionSnapshotsRef.current.set(card.nv_bsale_id, optimistic.snapshot)
    }
    cardsRef.current = optimistic.cards
    setCards(optimistic.cards)
    setExcludeCard(null)
    setSelectedCard(current => current?.card_id === card.card_id ? null : current)

    void persistExclusion(card, reason, observation)
    return { ok: true }
  }

  const loadBoard = useCallback(async ({ showSpinner = false }: { showSpinner?: boolean } = {}) => {
    const seq = ++boardRequestSeqRef.current
    const startedAt = performance.now()
    markPreparationBoardFetch()
    if (showSpinner) setLoading(true)

    try {
      const activeCompanyId = await getActiveCompanyId()
      if (seq !== boardRequestSeqRef.current) return
      if (!activeCompanyId) {
        setError('No se pudo determinar la empresa activa.')
        return
      }

      setCompanyId(activeCompanyId)
      const res = await getSalesOrderPreparationBoard(activeCompanyId)
      if (seq !== boardRequestSeqRef.current) return

      if (res.error) {
        setError(res.error)
        return
      }

      const rows = mergePreparationBoardRows(res.data || [], {
        pendingStatuses: pendingStatusByCardRef.current,
        pendingExclusionNvIds: pendingExclusionNvIdsRef.current,
      })

      cardsRef.current = rows
      setCards(rows)
      setError(null)
      setSelectedCard(current => {
        if (!current) return current
        const next = rows.find(candidate => candidate.card_id === current.card_id)
        return next ?? (pendingExclusionNvIdsRef.current.has(current.nv_bsale_id) ? null : current)
      })
    } catch (err: unknown) {
      if (seq === boardRequestSeqRef.current) {
        setError(err instanceof Error ? err.message : 'Error al cargar el tablero.')
      }
    } finally {
      if (seq === boardRequestSeqRef.current) setLoading(false)
      recordPreparationDuration('boardLoad', performance.now() - startedAt)
    }
  }, [])

  const loadSyncHealth = useCallback(async () => {
    try {
      const health = await getWarehousePreparationSyncHealth()
      if (!mountedRef.current) return null
      setSyncHealth(health)
      if (health.latestSuccessfulRun?.id) {
        lastSuccessfulRunIdRef.current = health.latestSuccessfulRun.id
      }
      return health
    } catch (err: unknown) {
      if (mountedRef.current) {
        setSyncError(err instanceof Error ? err.message : 'Error leyendo estado de sincronización.')
      }
      return null
    }
  }, [])

  const runSync = useCallback(async (source: 'manual' | 'auto') => {
    if (syncInFlightRef.current) return

    syncInFlightRef.current = true
    setIsSyncing(true)
    const startedAt = performance.now()
    const previousRunId = lastSuccessfulRunIdRef.current

    try {
      const res = source === 'manual'
        ? await syncOperationalBsaleSalesOrders()
        : await syncOperationalBsaleSalesOrdersIfStale()

      if (!mountedRef.current) return

      if (res.health) {
        setSyncHealth(res.health)
        if (res.health.latestSuccessfulRun?.id) {
          lastSuccessfulRunIdRef.current = res.health.latestSuccessfulRun.id
        }
      } else if (source === 'manual' && res.ok) {
        void loadSyncHealth()
      }

      const didRun = res.ok && !res.skipped
      const nextRunId = res.health?.latestSuccessfulRun?.id ?? null
      const refresh = shouldRefreshBoardAfterSync({ didRun, previousRunId, nextRunId })

      if (res.ok) {
        setSyncError(null)
        if (refresh && mountedRef.current) await loadBoard()

        if (source === 'manual') {
          const {
            discovery = 0,
            new_cards = 0,
            refresh: refreshed = 0,
            closed_invoiced = 0,
            detail_errors = 0,
          } = res.data || {}
          const suffix = detail_errors > 0 ? ` · ${detail_errors} con error de detalles` : ''
          toast.success(`Notas de Venta actualizadas · ${discovery} descubiertas · ${new_cards} nuevas · ${refreshed} revisadas · ${closed_invoiced} cerradas${suffix}`)
        }
      } else if (res.status === 'SKIPPED_LOCKED') {
        setSyncError(null)
        if (source === 'manual') toast.info('Ya existe una sincronización de Notas de Venta en curso.')
      } else {
        const message = res.error || 'Error al sincronizar Notas de Venta'
        setSyncError(message)
        if (source === 'manual') toast.error(message)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al sincronizar Notas de Venta'
      if (mountedRef.current) {
        setSyncError(message)
        if (source === 'manual') toast.error(message)
      }
    } finally {
      recordPreparationDuration('sync', performance.now() - startedAt)
      syncInFlightRef.current = false
      if (mountedRef.current) setIsSyncing(false)
    }
  }, [loadBoard, loadSyncHealth])

  const maybeAutoSync = useCallback(async (reason: 'mount' | 'interval' | 'visibility') => {
    if (!mountedRef.current || syncInFlightRef.current) return

    const now = Date.now()
    if (reason !== 'mount' && now - lastAutoAttemptAtRef.current < 30_000) return
    lastAutoAttemptAtRef.current = now

    await runSync('auto')
  }, [runSync])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  )

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    void (async () => {
      await loadBoard({ showSpinner: true })
      if (cancelled) return
      await loadSyncHealth()
      if (cancelled) return
      void maybeAutoSync('mount')
    })()

    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [loadBoard, loadSyncHealth, maybeAutoSync])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void maybeAutoSync('interval')
    }, PREPARATION_SYNC_CHECK_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [maybeAutoSync])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void maybeAutoSync('visibility')
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [maybeAutoSync])

  const openCardDetails = async (card: SalesOrderPreparationCardInfo) => {
    if (!companyId) return
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

  const transitionCard = async (card: SalesOrderPreparationCardInfo, toStatus: string, observation?: string) => {
    if (pendingCardIds.has(card.card_id) || card.status === toStatus) return false
    const fromStatus = card.status
    setTransitionError(null)
    setPendingCardIds(current => new Set(current).add(card.card_id))
    pendingStatusByCardRef.current.set(card.card_id, toStatus)
    boardRequestSeqRef.current += 1

    const optimisticCards = cardsRef.current.map(item => item.card_id === card.card_id ? { ...item, status: toStatus } : item)
    cardsRef.current = optimisticCards
    setCards(optimisticCards)
    setSelectedCard(current => current?.card_id === card.card_id ? { ...current, status: toStatus } : current)
    setIsMoving(true)
    try {
      const res = await moveSalesOrderPreparationCard({ cardId: card.card_id, toStatus, observation })
      if (!res.ok) {
        pendingStatusByCardRef.current.delete(card.card_id)
        boardRequestSeqRef.current += 1
        const rolledBack = cardsRef.current.map(item => item.card_id === card.card_id ? { ...item, status: fromStatus } : item)
        cardsRef.current = rolledBack
        setCards(rolledBack)
        setSelectedCard(current => current?.card_id === card.card_id ? { ...current, status: fromStatus } : current)
        setTransitionError(res.error ?? 'No se pudo guardar el cambio.')
        toast.error(`Error al mover: ${res.error ?? 'Desconocido'}`)
        return false
      }
      pendingStatusByCardRef.current.delete(card.card_id)
      boardRequestSeqRef.current += 1
      toast.success(`NV #${card.nv_folio} movida exitosamente`)
      setPendingMovement(null)
      return true
    } catch (cause) {
      pendingStatusByCardRef.current.delete(card.card_id)
      boardRequestSeqRef.current += 1
      const rolledBack = cardsRef.current.map(item => item.card_id === card.card_id ? { ...item, status: fromStatus } : item)
      cardsRef.current = rolledBack
      setCards(rolledBack)
      setSelectedCard(current => current?.card_id === card.card_id ? { ...current, status: fromStatus } : current)
      const message = cause instanceof Error ? cause.message : 'No se pudo guardar el cambio.'
      setTransitionError(message)
      toast.error(`Error al mover: ${message}`)
      return false
    } finally {
      setPendingCardIds(current => {
        const next = new Set(current)
        next.delete(card.card_id)
        return next
      })
      setIsMoving(false)
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
      await transitionCard(card, toStatus)
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
  const syncRun = syncHealth?.latestSuccessfulRun
  const latestRun = syncHealth?.latestRun
  const syncTrigger = syncRun?.trigger === 'SCHEDULED' ? 'SCHED' : syncRun?.trigger === 'MANUAL' ? 'MANUAL' : syncRun?.trigger || 'INIT'
  const syncTime = syncRun?.completed_at || syncRun?.started_at
  const syncAge = syncHealth?.lastSuccessAgeMinutes ?? null
  const isSyncRunning = isSyncing || latestRun?.status === 'STARTED'
  const syncIsError = Boolean(syncError) || latestRun?.status === 'FAILED' || latestRun?.status === 'PARTIAL'
  const syncIsFresh = syncAge !== null && syncAge < PREPARATION_SYNC_STALE_AFTER_MINUTES
  const syncStatusLabel = isSyncRunning
    ? 'Sincronizando…'
    : syncIsError
      ? 'ERROR'
      : syncIsFresh
        ? 'Actualizado'
        : syncHealth
          ? 'Desactualizado'
          : 'Sin evidencia'

  return (
    <div className="flex flex-col h-[calc(100vh-110px)] w-full overflow-hidden bg-[#EFE9E1] text-[#322D29]">
      {/* ── Header / Toolbar ── */}
      <div className="flex-none px-4 py-2 border-b border-[#D1C7BD] bg-[#FCFBF9] shadow-sm z-10">
        <div className="flex items-center gap-2 whitespace-nowrap">
          
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center gap-1.5 shrink-0">
              <KanbanSquare className="w-4 h-4 text-[#72383D] shrink-0" />
            <h1 className="text-sm font-semibold text-[#322D29]">Preparación de Pedidos</h1>
              <span className="px-1.5 py-0.5 bg-[#F5F0EA] text-[#322D29]/55 text-[10px] font-bold border border-[#D1C7BD] shrink-0">
                {filteredCards.length}
              </span>
            </div>

            <div
              className={`text-[11px] font-medium ${
                syncIsError
                  ? 'text-[#8A4B4B]'
                  : isSyncRunning
                    ? 'text-[#806238]'
                    : syncIsFresh
                      ? 'text-emerald-700'
                      : 'text-[#322D29]/55'
              }`}
              title={syncError || undefined}
            >
              {isSyncRunning ? 'Sincronizando…' : `Último sync: ${syncStatusLabel}`}
              {syncRun ? ` · ${syncTrigger} ${syncTime ? new Date(syncTime).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : ''}` : ''}
            </div>
          </div>
          
          {/* Controls */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void runSync('manual')}
              disabled={isSyncing}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-bold border transition-colors ${
                isSyncing
                   ? 'bg-[#F5F0EA] border-[#D1C7BD] text-[#322D29]/50 opacity-80 cursor-not-allowed'
                   : 'bg-[#72383D] text-white hover:bg-[#612F34] border-transparent shadow-sm'
              }`}
            >
              {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {isSyncing ? 'SINCRONIZANDO...' : 'ACTUALIZAR NOTAS DE VENTA'}
            </button>

            <button
              onClick={() => setExclusionsOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-bold border bg-white border-[#D1C7BD] text-[#322D29]/70 hover:bg-[#F5F0EA] transition-colors"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              EXCLUSIONES
            </button>

            <div className="relative w-40 ml-2">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#322D29]/40" />
              <input
                type="text"
                placeholder="Buscar folio, cliente..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-2 py-1.5 bg-white border border-[#D1C7BD] text-[#322D29] font-medium focus:outline-none focus:border-[#72383D] transition-colors placeholder:text-[#322D29]/40"
              />
            </div>
            <button
              onClick={() => setShowAdvanced(v => !v)}
               className={`flex items-center gap-1 px-2.5 py-1.5 border text-[11px] font-bold transition-colors ${showAdvanced ? 'bg-[#F5EDE9] border-[#72383D]/30 text-[#72383D]' : 'bg-white border-[#D1C7BD] text-[#322D29]/55 hover:bg-[#F5F0EA]'}`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filtros
            </button>
          </div>
        </div>

        {/* Filters Expansion */}
        {showAdvanced && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#D1C7BD]">
            <select
              value={filterCity}
              onChange={e => setFilterCity(e.target.value)}
              className="py-1.5 px-2 bg-white border border-[#D1C7BD] text-[11px] font-medium text-[#322D29] focus:outline-none focus:border-[#72383D]"
            >
              <option value="">Todas las comunas</option>
              {cities.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={filterSeller}
              onChange={e => setFilterSeller(e.target.value)}
              className="py-1.5 px-2 bg-white border border-[#D1C7BD] text-[11px] font-medium text-[#322D29] focus:outline-none focus:border-[#72383D]"
            >
              <option value="">Todos los vendedores</option>
              {sellers.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-bold text-[#322D29]/55 hover:text-[#322D29] transition-colors ml-auto bg-white border border-transparent hover:border-[#D1C7BD]"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Limpiar filtros
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Kanban Board ── */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden bg-[#EFE9E1]">
        {loading ? (
            <div className="h-full flex flex-col items-center justify-center text-[#322D29]/55 space-y-3">
             <Loader2 className="w-7 h-7 animate-spin text-[#72383D]" />
            <p className="text-sm font-medium">Cargando tablero…</p>
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-[#8A4B4B] text-sm font-medium">{error}</div>
        ) : (
          <DndContext
              sensors={sensors}
              onDragStart={handleDragStart} 
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <div className="h-full overflow-x-auto p-4">
                <div className="grid h-full min-w-[1000px] grid-cols-[repeat(3,minmax(320px,1fr))] gap-4">
                  {COLUMNS.map(col => {
                    const colCards = filteredCards.filter(c => c.status === col.id)
                     return <DroppableColumn key={col.id} col={col} colCards={colCards} pendingCardIds={pendingCardIds} onOpenCardDetails={openCardDetails} canExclude={canManageExclusions} onExclude={setExcludeCard} />
                  })}
                </div>
              </div>
              <DragOverlay zIndex={9999}>
                {activeCard ? (
                   <SalesOrderCard card={activeCard} isOverlay isPending={pendingCardIds.has(activeCard.card_id)} />
                ) : null}
              </DragOverlay>
            </DndContext>
        )}
      </div>

      <SalesOrderDrawer
        card={selectedCard}
        items={selectedItems}
        isLoadingItems={loadingItems}
        onClose={() => setSelectedCard(null)}
        onTransition={transitionCard}
      />
      
      <MovementObservationDialog
        isOpen={!!pendingMovement}
        onClose={() => setPendingMovement(null)}
        onConfirm={(obs) => {
          if (pendingMovement) {
             void transitionCard(pendingMovement.card, pendingMovement.toStatus, obs)
          }
        }}
        label={pendingMovement?.label ?? ''}
        isMoving={isMoving}
        error={transitionError}
      />

      <PreparationExclusionDialog
        card={excludeCard}
        open={!!excludeCard}
        onOpenChange={(next) => { if (!next) setExcludeCard(null) }}
        onConfirm={handleExclusionConfirm}
      />

      <PreparationExclusionsDrawer
        open={exclusionsOpen}
        onOpenChange={setExclusionsOpen}
        canRevoke={canManageExclusions}
        refreshToken={exclusionsVersion}
        onChanged={loadBoard}
      />

    </div>
  )
}
