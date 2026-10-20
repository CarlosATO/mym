'use client'

import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { Search, SlidersHorizontal, KanbanSquare, Loader2, RotateCcw, RefreshCw, ShieldCheck, Printer, ArrowUpDown, X } from 'lucide-react'
import { 
  getSalesOrderPreparationBoard, 
  getSalesOrderPreparationItems,
  getSalesOrderPreparationLines,
  getSalesOrderPreparationPrintData,
  syncOperationalBsaleSalesOrders,
  syncOperationalBsaleSalesOrdersIfStale,
  excludeSalesOrderPreparationNv,
  takeSalesOrderPreparationCard,
  SalesOrderPreparationCardInfo,
  SalesOrderPreparationItem,
  SalesOrderPreparationLine,
  type SalesOrderClientData,
  type SalesOrderPreparationLock,
} from '@/app/actions/logistica/sales-order-preparation'
import {
  type PreparationDetailEntry,
  getUncachedNvIds,
  patchPreparationLine,
  prunePreparationDetailCache,
  prunePreparationLinesCache,
  putPreparationDetailsBatch,
  putPreparationLines,
} from './preparation-detail-cache'
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
  tracePreparationOpenPhase,
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
import { PreparationLockDialog } from './preparation-lock-dialog'
import { isPreparationLockError, isPreparationReadOnly } from './preparation-lock-policy'
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
    dot: 'bg-amber-500',
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

type PreparationLockPatch = Partial<Pick<
  SalesOrderPreparationCardInfo,
  'assigned_user_id' | 'assigned_user_name' | 'locked_by_user_id' | 'locked_by_user_name' | 'locked_at'
>>

function readPreparationLockPatch(value: unknown): PreparationLockPatch | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const patch: PreparationLockPatch = {}
  if ('assigned_user_id' in source) patch.assigned_user_id = (source.assigned_user_id as string | null) ?? null
  if ('assigned_user_name' in source) patch.assigned_user_name = (source.assigned_user_name as string | null) ?? null
  if ('locked_by_user_id' in source) patch.locked_by_user_id = (source.locked_by_user_id as string | null) ?? null
  if ('locked_by_user_name' in source) patch.locked_by_user_name = (source.locked_by_user_name as string | null) ?? null
  if ('locked_at' in source) patch.locked_at = (source.locked_at as string | null) ?? null
  return Object.keys(patch).length > 0 ? patch : null
}

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
    <div className="flex min-w-0 items-baseline gap-1.5 border-l border-[#DDD4CA] pl-4 first:border-0 first:pl-0" title={title}>
      <span className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${accent ? 'text-[#72383D]' : 'text-[#322D29]'}`}>{value}</span>
      {sub && <span className="text-xs font-medium text-[#322D29]/50">{sub}</span>}
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
  currentUserId,
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
  currentUserId: string | null
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: col.id,
  })

  return (
    <section
      ref={setNodeRef}
      className={`flex flex-col min-w-[280px] rounded-xl border bg-[#F8F5F1] transition-all duration-150 ${
        isOver
          ? 'border-[#72383D] bg-[#F3ECE5] ring-2 ring-[#72383D]/20 shadow-md'
          : 'border-[#DDD4CA] shadow-xs'
      }`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between border-b border-[#DDD4CA] px-3.5 py-2.5 bg-white/70 backdrop-blur-xs rounded-t-xl">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${col.dot} shadow-xs shrink-0`} />
          <h3 className="text-xs font-bold uppercase tracking-wider text-[#322D29]">{col.title}</h3>
        </div>
        <span className="flex items-center justify-center min-w-[22px] h-5 px-1.5 rounded-full bg-[#EAE3DA] text-[11px] font-bold text-[#6B625C]">{colCards.length}</span>
      </div>

      {/* Column body */}
      <div className="flex-1 space-y-2.5 p-2.5 overflow-y-auto">
        {colCards.length === 0 && (
          <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-[#DDD4CA] bg-white/40">
            <p className="text-xs font-medium text-[#322D29]/40">Sin tarjetas</p>
          </div>
        )}
        {colCards.map((card, index) => {
          const comuna = getPreparationComuna(card)
          const previousComuna = index > 0 ? getPreparationComuna(colCards[index - 1]) : ''
          const showComunaDivider = sortBy === 'comuna' && comuna !== previousComuna

          return (
            <Fragment key={card.card_id}>
              {showComunaDivider && (
                <div className="flex items-center gap-2 pt-2 first:pt-0" title={`Comuna: ${comuna}`}>
                  <span className="rounded-md border border-[#72383D]/20 bg-[#F5EDE9] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#72383D]">
                    {comuna}
                  </span>
                  <span className="h-px flex-1 bg-[#DDD4CA]" />
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
                currentUserId={currentUserId}
                dragDisabled={isPreparationReadOnly({
                  status: card.status,
                  currentUserId,
                  lockedByUserId: card.locked_by_user_id,
                })}
              />
            </Fragment>
          )
        })}
      </div>
    </section>
  )
}

export function SalesOrderPreparationPanel({
  roleName = '',
  currentUserId,
  currentUserName,
  permissions = [],
}: {
  roleName?: string
  currentUserId: string
  currentUserName: string
  permissions?: string[]
}) {
  const canManageExclusions = roleName === 'SUPER_USUARIO' || roleName === 'GERENCIA'
  const isSystemAdmin = permissions.includes('system.admin')
  const canManagePreparation = isSystemAdmin || permissions.includes('logistica.preparation.manage')
  const canTakeoverPreparation = isSystemAdmin || permissions.includes('logistica.preparation.authorize_exception')

  const [companyId, setCompanyId] = useState<string | null>(null)
  const [cards, setCards] = useState<SalesOrderPreparationCardInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  const [syncHealth, setSyncHealth] = useState<WarehousePreparationSyncHealth | null>(null)

  // Drawer state
  const [selectedCard, setSelectedCard] = useState<SalesOrderPreparationCardInfo | null>(null)
  const [selectedItems, setSelectedItems] = useState<SalesOrderPreparationItem[]>([])
  const [selectedPreparationLines, setSelectedPreparationLines] = useState<SalesOrderPreparationLine[]>([])
  const [loadingPreparationLines, setLoadingPreparationLines] = useState(false)
  const [preparationLinesError, setPreparationLinesError] = useState<string | null>(null)
  const [selectedClientData, setSelectedClientData] = useState<SalesOrderClientData | null>(null)
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

  // Toma / takeover de preparación
  const [lockTakeoverCard, setLockTakeoverCard] = useState<SalesOrderPreparationCardInfo | null>(null)
  const [claimingCardId, setClaimingCardId] = useState<string | null>(null)

  const [syncError, setSyncError] = useState<string | null>(null)

  const cardsRef = useRef<SalesOrderPreparationCardInfo[]>([])
  const boardRequestSeqRef = useRef(0)
  const itemsRequestSeqRef = useRef(0)
  const prefetchSeqRef = useRef(0)
  const detailCacheRef = useRef<Map<number, PreparationDetailEntry>>(new Map())
  const preparationLinesCacheRef = useRef<Map<string, SalesOrderPreparationLine[]>>(new Map())
  const prefetchInFlightRef = useRef<Set<number>>(new Set())
  const selectedCardRef = useRef<SalesOrderPreparationCardInfo | null>(null)
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

  useEffect(() => {
    selectedCardRef.current = selectedCard
  }, [selectedCard])

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

  const prefetchPreparationDetails = useCallback(async (activeCompanyId: string, candidateNvIds: number[]) => {
    const uncachedIds = getUncachedNvIds(
      detailCacheRef.current,
      candidateNvIds,
      prefetchInFlightRef.current,
    )
    if (uncachedIds.length === 0) return

    for (const id of uncachedIds) {
      prefetchInFlightRef.current.add(id)
    }

    const prefetchSeq = ++prefetchSeqRef.current
    const startedAt = performance.now()

    try {
      const res = await getSalesOrderPreparationPrintData(activeCompanyId, uncachedIds)
      if (prefetchSeq !== prefetchSeqRef.current || !mountedRef.current) return

      if (res.data) {
        putPreparationDetailsBatch(detailCacheRef.current, res.data, uncachedIds)

        const currentCard = selectedCardRef.current
        if (currentCard && uncachedIds.includes(currentCard.nv_bsale_id)) {
          const cached = detailCacheRef.current.get(currentCard.nv_bsale_id)
          if (cached) {
            setSelectedItems(cached.items)
            setSelectedClientData(cached.clientData)
            setLoadingItems(false)
          }
        }
      }
    } catch (err: unknown) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[preparacion-prefetch] Error precargando detalles en batch:', err)
      }
    } finally {
      for (const id of uncachedIds) {
        prefetchInFlightRef.current.delete(id)
      }
      recordPreparationDuration('prefetchBatch', performance.now() - startedAt)
    }
  }, [])

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

      // Poda de cache: remover NVs/tarjetas que ya no pertenecen al board
      prunePreparationDetailCache(detailCacheRef.current, rows.map(r => r.nv_bsale_id))
      prunePreparationLinesCache(preparationLinesCacheRef.current, rows.map(r => r.card_id))

      // Precarga batch de detalles en segundo plano sin bloquear el renderizado del board
      void prefetchPreparationDetails(activeCompanyId, rows.map(r => r.nv_bsale_id))
    } catch (err: unknown) {
      if (seq === boardRequestSeqRef.current) {
        setError(err instanceof Error ? err.message : 'Error al cargar el tablero.')
      }
    } finally {
      if (seq === boardRequestSeqRef.current) setLoading(false)
      recordPreparationDuration('boardLoad', performance.now() - startedAt)
    }
  }, [prefetchPreparationDetails])

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
        if (refresh && mountedRef.current) {
          detailCacheRef.current.clear()
          preparationLinesCacheRef.current.clear()
          await loadBoard()
        }

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

        // Resiliencia: si la fase incremental creó tarjetas válidamente,
        // recargar el board para que la nueva NV sea visible de inmediato sin esperar otro intento.
        const createdCount = res.data?.new_cards ?? 0
        if (createdCount > 0 && mountedRef.current) {
          detailCacheRef.current.clear()
          preparationLinesCacheRef.current.clear()
          await loadBoard()
          if (source === 'manual') {
            toast.error(`NV actualizadas (${createdCount} nueva${createdCount > 1 ? 's' : ''}), pero la conciliación posterior arrojó un error: ${message}`)
          }
        } else if (source === 'manual') {
          toast.error(message)
        }
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
    const clickStart = performance.now()
    setSelectedCard(card)
    setPreparationLinesError(null)

    // La fotografía persistida se mantiene visible: sólo se vacía si no hay cache válida.
    const cachedLines = card.status === 'IN_PREPARATION'
      ? preparationLinesCacheRef.current.get(card.card_id) ?? null
      : null
    if (cachedLines) {
      setSelectedPreparationLines(cachedLines)
      setLoadingPreparationLines(false)
    } else {
      setSelectedPreparationLines([])
      setLoadingPreparationLines(card.status === 'IN_PREPARATION')
    }

    tracePreparationOpenPhase('A.drawerState', performance.now() - clickStart, {
      status: card.status,
      linesCacheHit: cachedLines !== null,
    })

    // A. Cache HIT: Apertura instantánea sin round-trips
    const cached = detailCacheRef.current.get(card.nv_bsale_id)
    if (cached) {
      setSelectedItems(cached.items)
      setSelectedClientData(cached.clientData)
      setLoadingItems(false)
      tracePreparationOpenPhase('B.detailCache', performance.now() - clickStart, { hit: true })

      if (card.status === 'IN_PREPARATION' && cachedLines === null) {
        const linesStartedAt = performance.now()
        const lines = await getSalesOrderPreparationLines(companyId, card.card_id)
        tracePreparationOpenPhase('D.preparationLines', performance.now() - linesStartedAt, {
          source: 'rpc',
          error: Boolean(lines.error),
        })
        if (requestId === itemsRequestSeqRef.current && mountedRef.current) {
          if (!lines.error) putPreparationLines(preparationLinesCacheRef.current, card.card_id, lines.data)
          setSelectedPreparationLines(lines.data)
          setPreparationLinesError(lines.error)
          setLoadingPreparationLines(false)
        }
      }

      tracePreparationOpenPhase('H.operationalRender', performance.now() - clickStart)
      recordPreparationDuration('cardOpen', performance.now() - clickStart)
      return
    }

    // B. Cache MISS: Fallback individual seguro
    setSelectedItems([])
    setSelectedClientData(null)
    setLoadingItems(true)

    try {
      const linesPromise = card.status === 'IN_PREPARATION' && cachedLines === null
        ? (async () => {
          const linesStartedAt = performance.now()
          const result = await getSalesOrderPreparationLines(companyId, card.card_id)
          tracePreparationOpenPhase('D.preparationLines', performance.now() - linesStartedAt, {
            source: 'rpc',
            error: Boolean(result.error),
          })
          return result
        })()
        : Promise.resolve({ data: cachedLines ?? [], error: null })

      const printStartedAt = performance.now()
      const res = await getSalesOrderPreparationPrintData(companyId, [card.nv_bsale_id])
      tracePreparationOpenPhase('C.printData', performance.now() - printStartedAt, {
        hit: false,
        error: Boolean(res.error),
      })
      const lines = await linesPromise
      if (requestId !== itemsRequestSeqRef.current || !mountedRef.current) return

      if (res.data) {
        const items = res.data.itemsByNv[String(card.nv_bsale_id)] || []
        const clientData = res.data.clientByNv[String(card.nv_bsale_id)] || null
        detailCacheRef.current.set(card.nv_bsale_id, {
          items,
          clientData,
          loadedAt: Date.now(),
        })
        setSelectedItems(items)
        setSelectedClientData(clientData)
      } else {
        setSelectedItems([])
        setSelectedClientData(null)
      }
      if (card.status === 'IN_PREPARATION') {
        if (!lines.error && cachedLines === null) {
          putPreparationLines(preparationLinesCacheRef.current, card.card_id, lines.data)
        }
        setSelectedPreparationLines(lines.data)
        setPreparationLinesError(lines.error)
      }
      setLoadingPreparationLines(false)
    } catch (err: unknown) {
      if (requestId === itemsRequestSeqRef.current && mountedRef.current) {
        setSelectedItems([])
        setSelectedClientData(null)
        setPreparationLinesError(err instanceof Error ? err.message : 'No se pudieron cargar las líneas de preparación.')
        setLoadingPreparationLines(false)
      }
    } finally {
      if (requestId === itemsRequestSeqRef.current && mountedRef.current) {
        setLoadingItems(false)
        tracePreparationOpenPhase('H.operationalRender', performance.now() - clickStart)
        recordPreparationDuration('cardOpen', performance.now() - clickStart)
      }
    }
  }

  const applyPreparationLockPatchToState = (cardId: string, patch: PreparationLockPatch) => {
    const nextCards = cardsRef.current.map(card => card.card_id === cardId ? { ...card, ...patch } : card)
    cardsRef.current = nextCards
    setCards(nextCards)
    setSelectedCard(current => current?.card_id === cardId ? { ...current, ...patch } : current)
  }

  const claimPreparation = async (card: SalesOrderPreparationCardInfo, reason?: string) => {
    if ((!canManagePreparation && !canTakeoverPreparation) || claimingCardId) {
      return { ok: false, error: 'No tienes permiso para tomar esta preparación.' }
    }
    setClaimingCardId(card.card_id)
    try {
      const result = await takeSalesOrderPreparationCard({ cardId: card.card_id, reason })
      if (result.error || !result.data) {
        toast.error(result.error || 'No se pudo tomar la preparación.')
        return { ok: false, error: result.error || 'No se pudo tomar la preparación.' }
      }
      const patch = readPreparationLockPatch(result.data)
      if (patch) applyPreparationLockPatchToState(card.card_id, patch)
      toast.success(result.data.event === 'PREPARATION_LOCK_TAKEOVER'
        ? `Preparación de NV #${card.nv_folio} tomada`
        : `Preparación de NV #${card.nv_folio} asignada a ti`)
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'No se pudo tomar la preparación.'
      toast.error(message)
      return { ok: false, error: message }
    } finally {
      setClaimingCardId(null)
    }
  }

  const handleTakePreparation = async (card: SalesOrderPreparationCardInfo) => {
    if (!card.locked_by_user_id) {
      await claimPreparation(card)
      return
    }
    setLockTakeoverCard(card)
  }

  const handleTakeoverConfirm = async (reason: string) => {
    if (!lockTakeoverCard) return { ok: false, error: 'No hay tarjeta seleccionada.' }
    return claimPreparation(lockTakeoverCard, reason)
  }

  const handleOwnershipConflict = async () => {
    toast.error('La preparación fue tomada por otro usuario. Se actualizó a sólo lectura.')
    await loadBoard()
  }

  const handlePreparationLinesChange = (lines: SalesOrderPreparationLine[]) => {
    setSelectedPreparationLines(lines)
    const cardId = lines[0]?.card_id ?? selectedCardRef.current?.card_id
    if (cardId) putPreparationLines(preparationLinesCacheRef.current, cardId, lines)
  }

  const handlePreparationLineChange = (line: SalesOrderPreparationLine) => {
    setSelectedPreparationLines(current => current.map(existing => existing.id === line.id ? line : existing))
    patchPreparationLine(preparationLinesCacheRef.current, line)
  }

  const transitionCard = async (card: SalesOrderPreparationCardInfo, toStatus: string, observation?: string): Promise<{ ok: boolean; error?: string }> => {
    if (pendingCardIds.has(card.card_id) || card.status === toStatus) {
      return { ok: false, error: 'La tarjeta ya está siendo procesada o ya se encuentra en ese estado.' }
    }
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
        if (isPreparationLockError(res.error)) void loadBoard()
        return { ok: false, error: res.error ?? 'No se pudo guardar el cambio.' }
      }
      pendingStatusByCardRef.current.delete(card.card_id)
      boardRequestSeqRef.current += 1
      const lockPatch = readPreparationLockPatch(res.data)
      if (lockPatch) applyPreparationLockPatchToState(card.card_id, lockPatch)
      setSelectedCardIds(current => {
        if (!current.has(card.card_id)) return current
        const next = new Set(current)
        next.delete(card.card_id)
        return next
      })
      toast.success(`NV #${card.nv_folio} movida exitosamente`)
      setPendingMovement(null)
      return { ok: true }
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
      if (isPreparationLockError(message)) void loadBoard()
      return { ok: false, error: message }
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
        return { card, ok: res.ok, error: res.error ?? 'Desconocido', data: res.data }
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
    }

    const lockPatches = new Map<string, PreparationLockPatch>()
    for (const result of results) {
      if (!result.ok) continue
      const patch = readPreparationLockPatch(result.data)
      if (patch) lockPatches.set(result.card.card_id, patch)
    }
    if (lockPatches.size > 0) {
      const patchedCards = cardsRef.current.map(item => (
        lockPatches.has(item.card_id) ? { ...item, ...lockPatches.get(item.card_id) } : item
      ))
      cardsRef.current = patchedCards
      setCards(patchedCards)
      setSelectedCard(current => (
        current && lockPatches.has(current.card_id) ? { ...current, ...lockPatches.get(current.card_id) } : current
      ))
    }

    if (failed.length === 0) {
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
      <div className="flex-none px-4 py-2.5 border-b border-[#D1C7BD] bg-[#FCFBF9] shadow-xs z-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 shrink-0">
              <div className="p-1.5 rounded-lg bg-[#72383D]/10 text-[#72383D]">
                <KanbanSquare className="w-4 h-4" />
              </div>
              <h1 className="text-sm font-bold tracking-tight text-[#322D29]">Preparación de Pedidos</h1>
            </div>

            <div
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
                syncIsError
                  ? 'border-[#8A4B4B]/30 bg-[#8A4B4B]/10 text-[#8A4B4B]'
                  : isSyncRunning
                    ? 'border-amber-500/30 bg-amber-50 text-amber-800'
                    : syncIsFresh
                      ? 'border-emerald-500/30 bg-emerald-50 text-emerald-800'
                      : 'border-slate-300 bg-slate-50 text-slate-600'
              }`}
              title={syncError || undefined}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${syncIsError ? 'bg-red-500' : isSyncRunning ? 'bg-amber-500 animate-pulse' : syncIsFresh ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              <span>{isSyncRunning ? 'Sincronizando…' : `Sync: ${syncStatusLabel}`}</span>
              {syncRun ? <span className="opacity-75">· {syncTrigger} {syncTime ? new Date(syncTime).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : ''}</span> : null}
            </div>
          </div>
          
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void runSync('manual')}
              disabled={isSyncing}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border shadow-xs transition-colors ${
                isSyncing
                   ? 'bg-[#F5F0EA] border-[#D1C7BD] text-[#322D29]/50 opacity-80 cursor-not-allowed'
                   : 'bg-[#72383D] text-white hover:bg-[#612F34] border-transparent'
              }`}
            >
              {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span>{isSyncing ? 'Sincronizando...' : 'Actualizar NV'}</span>
            </button>

            <button
              onClick={() => setExclusionsOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border bg-white border-[#D1C7BD] text-[#322D29]/80 hover:bg-[#F5F0EA] shadow-xs transition-colors"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#72383D]" />
              <span>Exclusiones</span>
            </button>

            <div className="relative w-56 sm:w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#322D29]/45" />
              <input
                type="text"
                placeholder="Buscar NV, cliente, comuna, fecha..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-white border border-[#D1C7BD] text-xs text-[#322D29] font-medium focus:outline-none focus:ring-2 focus:ring-[#72383D]/20 focus:border-[#72383D] shadow-xs transition-all placeholder:text-[#322D29]/40"
              />
            </div>

            <div className="relative">
              <ArrowUpDown className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#322D29]/45" />
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as PreparationSort)}
                title="Ordenar tarjetas"
                className="appearance-none py-1.5 pl-8 pr-7 rounded-lg bg-white border border-[#D1C7BD] text-xs font-medium text-[#322D29] focus:outline-none focus:ring-2 focus:ring-[#72383D]/20 focus:border-[#72383D] shadow-xs transition-all cursor-pointer"
              >
                <option value="default">Orden normal</option>
                <option value="comuna">Ordenar por comuna</option>
                <option value="nv">Ordenar por NV</option>
                <option value="date">Ordenar por fecha</option>
              </select>
            </div>

            <button
              onClick={() => setShowAdvanced(v => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold shadow-xs transition-colors ${showAdvanced ? 'bg-[#F5EDE9] border-[#72383D]/40 text-[#72383D]' : 'bg-white border-[#D1C7BD] text-[#322D29]/70 hover:bg-[#F5F0EA]'}`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Filtros</span>
            </button>
          </div>
        </div>

        {/* Filters Expansion - Compacto y operacional */}
        {showAdvanced && (
          <div className="mt-2.5 flex flex-col gap-2 border-t border-[#D1C7BD] pt-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Comunas ({comunaOptions.length})</h2>
                <span className="text-[#D1C7BD]">·</span>
                <button
                  type="button"
                  onClick={selectAllComunas}
                  disabled={comunaOptions.length === 0}
                  className="text-xs font-semibold text-[#72383D] hover:underline disabled:opacity-40"
                >
                  Seleccionar todas
                </button>
                <span className="text-[#D1C7BD]">·</span>
                <button
                  type="button"
                  onClick={clearComunas}
                  disabled={selectedComunas.size === 0}
                  className="text-xs font-semibold text-[#322D29]/60 hover:text-[#322D29] hover:underline disabled:opacity-40"
                >
                  Limpiar
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 ml-auto">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Vendedor:</h2>
                  <select
                    value={effectiveSellerKey}
                    onChange={e => setFilterSellerKey(e.target.value)}
                    className="rounded-lg border border-[#D1C7BD] bg-white px-2.5 py-1 text-xs font-medium text-[#322D29] focus:ring-2 focus:ring-[#72383D]/20 focus:border-[#72383D] focus:outline-none shadow-xs"
                  >
                    <option value="">Todos los vendedores</option>
                    {sellerOptions.map(option => (
                      <option key={option.key} value={option.key}>{option.label} ({option.count})</option>
                    ))}
                  </select>
                </div>

                {hasActiveFilterOrSort && (
                  <button
                    onClick={() => { clearFilters(); setSortBy('default') }}
                    title="Limpiar filtros y orden"
                    className="flex items-center gap-1 rounded-lg border border-[#D1C7BD] bg-white px-2.5 py-1 text-xs font-semibold text-[#322D29]/70 shadow-xs transition-colors hover:bg-[#F5F0EA] hover:text-[#322D29]"
                  >
                    <RotateCcw className="w-3 h-3" /> Limpiar filtros y orden
                  </button>
                )}
              </div>
            </div>

            {/* Chips de Comunas con multiselección */}
            <div className="flex flex-wrap items-center gap-1.5 max-h-24 overflow-y-auto p-1.5 rounded-lg border border-[#DDD4CA] bg-white/70 shadow-xs">
              {comunaOptions.length === 0 ? (
                <p className="px-2 py-1 text-xs text-[#322D29]/40 italic">Sin comunas en el board</p>
              ) : (
                comunaOptions.map(option => {
                  const checked = effectiveSelectedComunas.has(option.key)
                  return (
                    <label
                      key={option.key}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs cursor-pointer transition-all select-none ${
                        checked
                          ? 'bg-[#72383D] text-white shadow-xs font-semibold'
                          : 'bg-white border border-[#DDD4CA] text-[#322D29]/75 hover:bg-[#F5F0EA] font-medium'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleComunaFilter(option.key)}
                        className="h-3 w-3 rounded shrink-0 accent-[#72383D]"
                      />
                      <span>{option.label}</span>
                      <span className={`text-[10px] tabular-nums font-bold ${checked ? 'text-white/80' : 'text-[#322D29]/50'}`}>
                        {option.count}
                      </span>
                    </label>
                  )
                })
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between text-[10px] font-medium text-[#322D29]/50">
              <p>Sin selección se muestran todas las comunas.</p>
              <p>Sólo vendedores presentes en las NV del board.</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Resumen operacional ── */}
      {!loading && !error && (
        <div className="flex-none border-b border-[#D1C7BD] bg-[#FCFBF9] px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
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
              <span className="ml-auto rounded-md border border-[#72383D]/25 bg-[#F5EDE9] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#72383D]">
                Vista filtrada
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Barra de acciones de selección ── */}
      {selectionSummary.nvCount > 0 && (
        <div className="flex-none border-b border-[#72383D]/20 bg-[#FBF6F3] px-4 py-2.5 transition-all">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-bold text-[#72383D]">
                {selectionSummary.nvCount} NV seleccionada{selectionSummary.nvCount === 1 ? '' : 's'}
              </span>
              {selectionSummary.amount > 0 && (
                <span className="font-semibold text-[#322D29]/80">· {formatPreparationClp(selectionSummary.amount)}</span>
              )}
              <span className="text-[#322D29]/65">· {selectionSummary.units} unidades</span>
              {selectionSummary.comunas.length > 0 && (
                <span className="text-[#322D29]/65">· {selectionSummary.comunas.join(' / ')}</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleBulkPrint('prepare')}
                disabled={isBulkPrinting || isMoving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#72383D] hover:bg-[#612F34] text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed shadow-xs transition-colors"
              >
                {isBulkPrinting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
                {isBulkPrinting ? 'Procesando…' : `Imprimir y preparar (${selectionSummary.nvCount})`}
              </button>
              <button
                type="button"
                onClick={() => void handleBulkPrint('print')}
                disabled={isBulkPrinting || isMoving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#D1C7BD] bg-white hover:bg-[#F5F0EA] text-[#322D29]/80 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed shadow-xs transition-colors"
              >
                <Printer className="w-3.5 h-3.5" />
                Imprimir sin mover
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={isBulkPrinting || isMoving}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-[#322D29]/60 hover:text-[#322D29] hover:bg-black/5 disabled:opacity-50 transition-colors"
              >
                <X className="w-3.5 h-3.5" /> Limpiar selección
              </button>
            </div>
          </div>
          {bulkPrintError && (
            <p className="mt-2 rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-2.5 py-1 text-xs font-medium text-[#8A4B4B]">
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
                         currentUserId={currentUserId}
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
        preparationLines={selectedPreparationLines}
        onPreparationLinesChange={handlePreparationLinesChange}
        onPreparationLineChange={handlePreparationLineChange}
        isLoadingPreparationLines={loadingPreparationLines}
        preparationLinesError={preparationLinesError}
        clientData={selectedClientData}
        isLoadingItems={loadingItems}
        currentUserId={currentUserId}
        canClaimPreparation={canManagePreparation}
        canTakeoverPreparation={canTakeoverPreparation}
        onTakePreparation={handleTakePreparation}
        onOwnershipConflict={handleOwnershipConflict}
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

      <PreparationLockDialog
        card={lockTakeoverCard}
        currentUserName={currentUserName}
        open={!!lockTakeoverCard}
        onOpenChange={(next) => { if (!next) setLockTakeoverCard(null) }}
        onConfirm={handleTakeoverConfirm}
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
