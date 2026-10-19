'use client'

import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { Search, SlidersHorizontal, KanbanSquare, Loader2, RotateCcw, RefreshCw, ShieldCheck, Printer, ArrowUpDown, X } from 'lucide-react'
import { 
  getSalesOrderPreparationBoard, 
  getSalesOrderPreparationItems,
  getSalesOrderPreparationPrintData,
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
import {
  buildPreparationComunaOptions,
  buildPreparationSellerOptions,
  formatPreparationClp,
  getPreparationComuna,
  matchesPreparationComunaFilter,
  matchesPreparationSearch,
  matchesPreparationSellerFilter,
  prunePreparationFilterKeys,
  prunePreparationSelection,
  sortPreparationCards,
  summarizePreparationBoard,
  summarizePreparationSelection,
  type PreparationSort,
} from './preparation-board-utils'
import { generatePreparationOrdersPdf, openPreparationOrdersPdf } from '@/lib/pdf/generate-preparation-orders-pdf'
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

function closePrintWindow(target: Window | null) {
  try {
    if (target && !target.closed) target.close()
  } catch {
    // El navegador puede bloquear el cierre; no es un error operacional.
  }
}

function SummaryStat({ label, value, sub, title, accent = false }: {
  label: string
  value: string | number
  sub?: string
  title?: string
  accent?: boolean
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 border-l border-[#D1C7BD] pl-4 first:border-0 first:pl-0" title={title}>
      <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#6B625C]">{label}</span>
      <span className={`text-[15px] font-semibold tabular-nums ${accent ? 'text-[#72383D]' : 'text-[#322D29]'}`}>{value}</span>
      {sub && <span className="text-[10px] font-medium text-[#322D29]/45">{sub}</span>}
    </div>
  )
}

function DroppableColumn({
  col,
  colCards,
  pendingCardIds,
  onOpenCardDetails,
  canExclude,
  onExclude,
  selectedCardIds,
  onToggleSelection,
  sortBy,
}: {
  col: KanbanColumn
  colCards: SalesOrderPreparationCardInfo[]
  pendingCardIds: Set<string>
  onOpenCardDetails: (c: SalesOrderPreparationCardInfo) => void
  canExclude: boolean
  onExclude: (c: SalesOrderPreparationCardInfo) => void
  selectedCardIds: Set<string>
  onToggleSelection: (c: SalesOrderPreparationCardInfo) => void
  sortBy: PreparationSort
}) {
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
        {colCards.map((card, index) => {
          const comuna = getPreparationComuna(card)
          const previousComuna = index > 0 ? getPreparationComuna(colCards[index - 1]) : ''
          const showComunaDivider = sortBy === 'comuna' && comuna !== previousComuna

          return (
            <Fragment key={card.card_id}>
              {showComunaDivider && (
                <div className="flex items-center gap-2 pt-2 first:pt-0" title={`Comuna: ${comuna}`}>
                  <span className="rounded-sm bg-[#72383D]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-[#72383D]">{comuna}</span>
                  <span className="h-px flex-1 bg-[#D1C7BD]" />
                </div>
              )}
              <SalesOrderCard
                card={card}
                isPending={pendingCardIds.has(card.card_id)}
                onOpen={() => onOpenCardDetails(card)}
                onDoubleClick={() => onOpenCardDetails(card)}
                canExclude={canExclude}
                onExclude={onExclude}
                selectable={card.status === 'PENDING_ROUTE_PREP'}
                selected={selectedCardIds.has(card.card_id)}
                onToggleSelected={onToggleSelection}
              />
            </Fragment>
          )
        })}
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
  const [selectedComunas, setSelectedComunas] = useState<Set<string>>(new Set())
  const [filterSellerKey, setFilterSellerKey] = useState('')
  const [sortBy, setSortBy] = useState<PreparationSort>('default')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Selección operacional (identidad por card_id, nunca por índice visual)
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set())
  const [isBulkPrinting, setIsBulkPrinting] = useState(false)
  const [bulkPrintError, setBulkPrintError] = useState<string | null>(null)

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
  const itemsRequestSeqRef = useRef(0)
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
      setSelectedCardIds(current => prunePreparationSelection(current, rows))
      const validComunaKeys = buildPreparationComunaOptions(rows)
      const validSellerKeys = new Set(buildPreparationSellerOptions(rows).map(option => option.key))
      setSelectedComunas(current => prunePreparationFilterKeys(current, validComunaKeys))
      setFilterSellerKey(current => (current && !validSellerKeys.has(current) ? '' : current))
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
    const requestId = ++itemsRequestSeqRef.current
    setSelectedCard(card)
    setSelectedItems([])
    setLoadingItems(true)
    const res = await getSalesOrderPreparationItems(companyId, card.nv_bsale_id)
    if (requestId !== itemsRequestSeqRef.current) return
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
      setSelectedCardIds(current => {
        if (!current.has(card.card_id)) return current
        const next = new Set(current)
        next.delete(card.card_id)
        return next
      })
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

  const toggleSelection = (card: SalesOrderPreparationCardInfo) => {
    if (card.status !== 'PENDING_ROUTE_PREP') return
    setSelectedCardIds(current => {
      const next = new Set(current)
      if (next.has(card.card_id)) next.delete(card.card_id)
      else next.add(card.card_id)
      return next
    })
  }

  const clearSelection = () => {
    setSelectedCardIds(new Set())
    setBulkPrintError(null)
  }

  const moveCardsToPreparation = async (targets: SalesOrderPreparationCardInfo[]) => {
    const operational = targets.filter(card => card.status === 'PENDING_ROUTE_PREP')
    if (operational.length === 0) return { moved: [], failed: [] as Array<{ card: SalesOrderPreparationCardInfo; error: string }> }

    const targetIds = new Set(operational.map(card => card.card_id))
    setTransitionError(null)
    setIsMoving(true)
    setPendingCardIds(current => {
      const next = new Set(current)
      for (const id of targetIds) next.add(id)
      return next
    })
    for (const card of operational) {
      pendingStatusByCardRef.current.set(card.card_id, 'IN_PREPARATION')
    }
    boardRequestSeqRef.current += 1

    const optimisticCards = cardsRef.current.map(item => (
      targetIds.has(item.card_id) ? { ...item, status: 'IN_PREPARATION' } : item
    ))
    cardsRef.current = optimisticCards
    setCards(optimisticCards)
    setSelectedCard(current => (
      current && targetIds.has(current.card_id) ? { ...current, status: 'IN_PREPARATION' } : current
    ))

    const results = await Promise.all(operational.map(async card => {
      try {
        const res = await moveSalesOrderPreparationCard({ cardId: card.card_id, toStatus: 'IN_PREPARATION' })
        return { card, ok: res.ok, error: res.error ?? 'Desconocido' }
      } catch (err) {
        return {
          card,
          ok: false,
          error: err instanceof Error ? err.message : 'Error desconocido',
        }
      }
    }))

    for (const card of operational) {
      pendingStatusByCardRef.current.delete(card.card_id)
    }
    boardRequestSeqRef.current += 1

    const moved = results.filter(result => result.ok).map(result => result.card)
    const failed = results
      .filter(result => !result.ok)
      .map(result => ({ card: result.card, error: result.error }))

    if (failed.length > 0) {
      const failedIds = new Set(failed.map(failure => failure.card.card_id))
      const rolledBack = cardsRef.current.map(item => (
        failedIds.has(item.card_id) ? { ...item, status: 'PENDING_ROUTE_PREP' } : item
      ))
      cardsRef.current = rolledBack
      setCards(rolledBack)
      setSelectedCard(current => (
        current && failedIds.has(current.card_id) ? { ...current, status: 'PENDING_ROUTE_PREP' } : current
      ))
      const message = failed
        .map(failure => `NV #${failure.card.nv_folio}: ${failure.error}`)
        .join(' · ')
      setTransitionError(message)
      toast.error(`No se pudieron preparar todas las NV · ${message}`)
    } else {
      toast.success(
        operational.length === 1
          ? `NV #${operational[0].nv_folio} pasó a preparación`
          : `${operational.length} Notas de Venta pasaron a preparación`,
      )
    }

    setSelectedCardIds(current => {
      const next = new Set(current)
      for (const card of moved) next.delete(card.card_id)
      return next
    })
    setPendingCardIds(current => {
      const next = new Set(current)
      for (const id of targetIds) next.delete(id)
      return next
    })
    setIsMoving(false)

    return { moved, failed }
  }

  const handleBulkPrint = async (mode: 'prepare' | 'print') => {
    const targets = cardsRef.current.filter(card => (
      selectedCardIds.has(card.card_id) && card.status === 'PENDING_ROUTE_PREP'
    ))
    if (!companyId || targets.length === 0 || isBulkPrinting) return

    const printWindow = window.open('', '_blank')
    setIsBulkPrinting(true)
    setBulkPrintError(null)

    try {
      const printData = await getSalesOrderPreparationPrintData(
        companyId,
        targets.map(card => card.nv_bsale_id),
      )
      if (printData.error || !printData.data) {
        throw new Error(printData.error || 'No se pudieron cargar los datos de impresión.')
      }

      const entries = targets.map(card => ({
        card,
        items: printData.data?.itemsByNv[String(card.nv_bsale_id)] ?? [],
        clientData: printData.data?.clientByNv[String(card.nv_bsale_id)] ?? null,
      }))

      // Primero se construye el documento. Si falla, ninguna tarjeta se mueve.
      const blob = generatePreparationOrdersPdf(entries)

      const moveResult = mode === 'prepare'
        ? await moveCardsToPreparation(targets)
        : { moved: [], failed: [] as Array<{ card: SalesOrderPreparationCardInfo; error: string }> }

      openPreparationOrdersPdf(
        blob,
        printWindow,
        targets.length === 1
          ? `preparacion-nv-${targets[0].nv_folio}.pdf`
          : `preparacion-${targets.length}-notas-venta.pdf`,
      )

      if (moveResult.failed.length > 0) {
        const message = moveResult.failed
          .map(failure => `NV #${failure.card.nv_folio}: ${failure.error}`)
          .join(' · ')
        setBulkPrintError(message)
      } else if (mode === 'prepare') {
        toast.success(
          targets.length === 1
            ? `NV #${targets[0].nv_folio} impresa y en preparación`
            : `${targets.length} Notas de Venta impresas y en preparación`,
        )
      } else {
        toast.success(
          targets.length === 1
            ? `NV #${targets[0].nv_folio} impresa sin cambiar estado`
            : `${targets.length} Notas de Venta impresas sin cambiar estado`,
        )
      }
    } catch (err) {
      closePrintWindow(printWindow)
      const message = err instanceof Error ? err.message : 'No se pudo generar el documento de preparación.'
      setBulkPrintError(message)
      toast.error(message)
    } finally {
      setIsBulkPrinting(false)
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

  // Opciones dinámicas: siempre desde el board actual completo, antes de filtrar.
  const comunaOptions = useMemo(() => buildPreparationComunaOptions(cards), [cards])
  const sellerOptions = useMemo(() => buildPreparationSellerOptions(cards), [cards])

  const effectiveSelectedComunas = useMemo(() => {
    const validKeys = new Set(comunaOptions.map(option => option.key))
    return new Set([...selectedComunas].filter(key => validKeys.has(key)))
  }, [selectedComunas, comunaOptions])

  const effectiveSellerKey = useMemo(
    () => (sellerOptions.some(option => option.key === filterSellerKey) ? filterSellerKey : ''),
    [sellerOptions, filterSellerKey],
  )

  const searchFilteredCards = useMemo(() => cards.filter(card => {
    if (!matchesPreparationSearch(card, searchTerm)) return false
    if (!matchesPreparationComunaFilter(card, effectiveSelectedComunas)) return false
    if (!matchesPreparationSellerFilter(card, effectiveSellerKey)) return false
    return true
  }), [cards, searchTerm, effectiveSelectedComunas, effectiveSellerKey])

  const filteredCards = useMemo(
    () => sortPreparationCards(searchFilteredCards, sortBy),
    [searchFilteredCards, sortBy],
  )

  const selectedCards = useMemo(
    () => cards.filter(card => selectedCardIds.has(card.card_id) && card.status === 'PENDING_ROUTE_PREP'),
    [cards, selectedCardIds],
  )
  const selectionSummary = useMemo(() => summarizePreparationSelection(selectedCards), [selectedCards])
  const boardSummary = useMemo(() => summarizePreparationBoard(filteredCards), [filteredCards])

  const hasFilters = Boolean(searchTerm || effectiveSelectedComunas.size > 0 || effectiveSellerKey)
  const hasActiveFilterOrSort = hasFilters || sortBy !== 'default'

  const toggleComunaFilter = (key: string) => {
    setSelectedComunas(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAllComunas = () => {
    setSelectedComunas(new Set(comunaOptions.map(option => option.key)))
  }

  const clearComunas = () => setSelectedComunas(new Set())

  const clearFilters = () => {
    setSearchTerm('')
    setSelectedComunas(new Set())
    setFilterSellerKey('')
  }
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
        <div className="flex flex-wrap items-center gap-2">
          
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center gap-1.5 shrink-0">
              <KanbanSquare className="w-4 h-4 text-[#72383D] shrink-0" />
            <h1 className="text-sm font-semibold text-[#322D29]">Preparación de Pedidos</h1>
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

            <div className="relative w-60 ml-2">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#322D29]/40" />
              <input
                type="text"
                placeholder="Buscar NV, cliente, comuna, fecha..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-2 py-1.5 bg-white border border-[#D1C7BD] text-[#322D29] font-medium focus:outline-none focus:border-[#72383D] transition-colors placeholder:text-[#322D29]/40"
              />
            </div>

            <div className="relative">
              <ArrowUpDown className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#322D29]/45" />
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as PreparationSort)}
                title="Ordenar tarjetas"
                className="appearance-none py-1.5 pl-8 pr-6 bg-white border border-[#D1C7BD] text-[11px] font-medium text-[#322D29] focus:outline-none focus:border-[#72383D]"
              >
                <option value="default">Orden normal</option>
                <option value="comuna">Ordenar por comuna</option>
                <option value="nv">Ordenar por NV</option>
                <option value="date">Ordenar por fecha</option>
              </select>
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
          <div className="mt-3 grid gap-4 border-t border-[#D1C7BD] pt-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(260px,0.9fr)_auto]">
            <section className="min-w-0">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <h2 className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B625C]">Comunas</h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={selectAllComunas}
                    disabled={comunaOptions.length === 0}
                    className="text-[10px] font-semibold text-[#72383D] hover:underline disabled:opacity-40"
                  >
                    Seleccionar todas
                  </button>
                  <button
                    type="button"
                    onClick={clearComunas}
                    disabled={selectedComunas.size === 0}
                    className="text-[10px] font-semibold text-[#322D29]/55 hover:text-[#322D29] hover:underline disabled:opacity-40"
                  >
                    Limpiar
                  </button>
                </div>
              </div>

              <div className="max-h-44 overflow-y-auto border border-[#D1C7BD] bg-white">
                {comunaOptions.length === 0 ? (
                  <p className="px-3 py-4 text-center text-[10px] font-medium text-[#322D29]/50">Sin comunas en el board</p>
                ) : (
                  <ul className="divide-y divide-[#D1C7BD]/60">
                    {comunaOptions.map(option => {
                      const checked = effectiveSelectedComunas.has(option.key)
                      return (
                        <li key={option.key}>
                          <label className="flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-[11px] transition-colors hover:bg-[#F5F0EA]">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleComunaFilter(option.key)}
                              className="h-3.5 w-3.5 shrink-0 accent-[#72383D]"
                            />
                            <span className="min-w-0 flex-1 truncate font-medium text-[#322D29]">{option.label}</span>
                            <span className="shrink-0 text-[10px] font-semibold tabular-nums text-[#322D29]/45">{option.count}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              <p className="mt-1 text-[9px] font-medium text-[#322D29]/45">
                Sin selección se muestran todas las comunas.
              </p>
            </section>

            <section className="min-w-0">
              <h2 className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#6B625C]">Vendedor</h2>
              <select
                value={effectiveSellerKey}
                onChange={e => setFilterSellerKey(e.target.value)}
                className="w-full border border-[#D1C7BD] bg-white px-2 py-2 text-[11px] font-medium text-[#322D29] focus:border-[#72383D] focus:outline-none"
              >
                <option value="">Todos los vendedores</option>
                {sellerOptions.map(option => (
                  <option key={option.key} value={option.key}>{option.label} ({option.count})</option>
                ))}
              </select>
              <p className="mt-1 text-[9px] font-medium text-[#322D29]/45">
                Sólo vendedores presentes en las NV del board.
              </p>
            </section>

            <div className="flex items-start justify-end">
              {hasActiveFilterOrSort && (
                <button
                  onClick={() => { clearFilters(); setSortBy('default') }}
                  className="flex items-center gap-1 border border-[#D1C7BD] bg-white px-2.5 py-2 text-[10px] font-bold text-[#322D29]/55 transition-colors hover:bg-[#F5F0EA] hover:text-[#322D29]"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Limpiar filtros y orden
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Resumen operacional ── */}
      {!loading && !error && (
        <div className="flex-none border-b border-[#D1C7BD] bg-[#FCFBF9] px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <SummaryStat
              label="NV"
              value={boardSummary.nvCount}
              sub={hasFilters ? `de ${cards.length}` : undefined}
              title="Notas de venta visibles en el tablero"
            />
            <SummaryStat
              label="Monto total"
              value={formatPreparationClp(boardSummary.amount)}
              title="Monto total bruto de las Notas de Venta visibles"
              accent
            />
            <SummaryStat
              label="Unidades"
              value={boardSummary.units.toLocaleString('es-CL')}
              title="Unidades totales de las Notas de Venta visibles"
            />
            <SummaryStat
              label="Comunas"
              value={boardSummary.comunas.length}
              title={boardSummary.comunas.length > 0 ? boardSummary.comunas.join(' · ') : 'Sin comunas'}
            />
            {hasFilters && (
              <span className="ml-auto border border-[#72383D]/20 bg-[#F5EDE9] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-[#72383D]">
                Vista filtrada
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Barra de acciones de selección ── */}
      {selectionSummary.nvCount > 0 && (
        <div className="flex-none border-b border-[#72383D]/25 bg-[#F5EDE9] px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              <span className="font-bold uppercase tracking-[0.06em] text-[#72383D]">
                {selectionSummary.nvCount} NV seleccionada{selectionSummary.nvCount === 1 ? '' : 's'}
              </span>
              {selectionSummary.amount > 0 && (
                <span className="font-semibold text-[#322D29]/70">· {formatPreparationClp(selectionSummary.amount)}</span>
              )}
              <span className="text-[#322D29]/60">· {selectionSummary.units} unidades</span>
              {selectionSummary.comunas.length > 0 && (
                <span className="text-[#322D29]/60">· {selectionSummary.comunas.join(' / ')}</span>
              )}
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleBulkPrint('prepare')}
                disabled={isBulkPrinting || isMoving}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#72383D] hover:bg-[#612F34] text-white text-[11px] font-bold uppercase tracking-[0.04em] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isBulkPrinting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
                {isBulkPrinting ? 'Procesando…' : `Imprimir y preparar (${selectionSummary.nvCount})`}
              </button>
              <button
                type="button"
                onClick={() => void handleBulkPrint('print')}
                disabled={isBulkPrinting || isMoving}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-[#D1C7BD] bg-white hover:bg-[#F5F0EA] text-[#322D29]/75 text-[11px] font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Printer className="w-3.5 h-3.5" />
                Imprimir sin mover
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={isBulkPrinting || isMoving}
                className="flex items-center gap-1 px-2 py-1.5 text-[10px] font-bold text-[#322D29]/55 hover:text-[#322D29] disabled:opacity-50 transition-colors"
              >
                <X className="w-3.5 h-3.5" /> Limpiar selección
              </button>
            </div>
          </div>
          {bulkPrintError && (
            <p className="mt-2 border border-[#8A4B4B]/30 bg-white px-2 py-1 text-[10px] font-medium text-[#8A4B4B]">
              {bulkPrintError}
            </p>
          )}
        </div>
      )}

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
                     return (
                       <DroppableColumn
                         key={col.id}
                         col={col}
                         colCards={colCards}
                         pendingCardIds={pendingCardIds}
                         onOpenCardDetails={openCardDetails}
                         canExclude={canManageExclusions}
                         onExclude={setExcludeCard}
                         selectedCardIds={selectedCardIds}
                         onToggleSelection={toggleSelection}
                         sortBy={sortBy}
                       />
                     )
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
