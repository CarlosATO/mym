'use client'

import React, { useState, useEffect, useRef } from 'react'
import {
  getRouteSettlementsDashboardData,
  getRouteSettlementById,
  getRouteGuideWorkspaceData,
  type RouteSettlementsDashboardKpis,
  type RouteSettlementsDashboardRow,
  type RouteGuideWorkspaceData,
  type SaveRouteSettlementResult,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import { UnifiedRouteSettlementsTable } from './components/unified-route-settlements-table'
import { RouteSettlementDetailPanel } from './components/route-settlement-detail-panel'
import { RouteSettlementWorkspace } from './components/route-settlement-workspace'
import { RouteSettlement, RouteSettlementItem } from './types'
import { AlertTriangle, RefreshCw, Wallet } from 'lucide-react'
import { FundClosuresWorkspace } from './fund-closures-workspace'

const EMPTY_KPIS: RouteSettlementsDashboardKpis = {
  pending_count: 0,
  in_review_count: 0,
  settled_count: 0,
  with_difference_count: 0,
}

let dashboardCache: { kpis: RouteSettlementsDashboardKpis; rows: RouteSettlementsDashboardRow[] } | null = null
let dashboardRequest: Promise<Awaited<ReturnType<typeof getRouteSettlementsDashboardData>>> | null = null

async function loadDashboardPayload(forceRefresh = false) {
  if (forceRefresh) {
    dashboardCache = null
    dashboardRequest = null
  }

  if (dashboardCache) {
    return { data: dashboardCache, error: null }
  }

  if (!dashboardRequest) {
    dashboardRequest = getRouteSettlementsDashboardData().finally(() => {
      dashboardRequest = null
    })
  }

  const result = await dashboardRequest
  if (result.data) {
    dashboardCache = result.data
  }

  return result
}

// ─── Vistas posibles ─────────────────────────────────────────────────────────
type PanelView =
  | { kind: 'list' }
  | { kind: 'loading-workspace'; guideId: string }
  | {
      kind: 'workspace-no-rr'
      guideData: RouteGuideWorkspaceData
      dashboardRow: RouteSettlementsDashboardRow
    }
  | {
      kind: 'loading-settlement'; settlementId: string
    }
  | {
      kind: 'workspace-has-rr'
      guideData: RouteGuideWorkspaceData
      settlement: RouteSettlement
      settlementItems: RouteSettlementItem[]
      dashboardRow: RouteSettlementsDashboardRow
    }

export function RouteSettlementsPanel() {
  const [rows, setRows] = useState<RouteSettlementsDashboardRow[]>([])
  const [kpis, setKpis] = useState<RouteSettlementsDashboardKpis>(EMPTY_KPIS)
  const [isLoading, setIsLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('ALL')
  const [paymentFilter, setPaymentFilter] = useState<'CASH_ONLY' | 'ALL' | 'CREDIT'>('CASH_ONLY')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [view, setView] = useState<PanelView>({ kind: 'list' })
  const [mainTab, setMainTab] = useState<'TRAY' | 'FUND_CLOSURES'>('TRAY')

  const isMountedRef = useRef(false)
  const latestRequestIdRef = useRef(0)
  const renderCount = useRef(0)
  const loadStartedAtRef = useRef<number | null>(null)
  const hasLoggedKpisRef = useRef(false)
  const hasLoggedTableRef = useRef(false)

  useEffect(() => {
    renderCount.current += 1
    if (process.env.NODE_ENV === 'development') {
      console.log('[RendicionRutas:UI] render count', renderCount.current)
    }
  })

  // ── Carga de dashboard ──────────────────────────────────────────────────
  const loadDashboardData = async (forceRefresh = false) => {
    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId

    if (process.env.NODE_ENV === 'development') {
      console.log('[RendicionRutas:UI] fetch start', forceRefresh ? '(forced)' : '')
    }

    loadStartedAtRef.current = performance.now()
    setIsLoading(true)

    const { data, error } = await loadDashboardPayload(forceRefresh)
    if (!isMountedRef.current || requestId !== latestRequestIdRef.current) {
      return
    }

    if (error) {
      setErrorMsg(error)
    } else if (data) {
      setErrorMsg(null)
      setRows(data.rows || [])
      setKpis(data.kpis || EMPTY_KPIS)
      hasLoggedKpisRef.current = false
      hasLoggedTableRef.current = false
    }

    setIsLoading(false)
    if (process.env.NODE_ENV === 'development') {
      console.log('[RendicionRutas:UI] fetch end')
    }
  }

  useEffect(() => {
    isMountedRef.current = true
    if (process.env.NODE_ENV === 'development') {
      console.log('[RendicionRutas:UI] mount')
    }
    loadDashboardData()
    return () => {
      isMountedRef.current = false
      if (process.env.NODE_ENV === 'development') {
        console.log('[RendicionRutas:UI] unmount')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development' || isLoading || hasLoggedKpisRef.current) return
    hasLoggedKpisRef.current = true
    console.log('[RendicionRutas:UI] kpis visible')
  }, [isLoading, kpis])

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development' || isLoading || hasLoggedTableRef.current) return
    hasLoggedTableRef.current = true
    console.log('[RendicionRutas:UI] table visible')
    if (loadStartedAtRef.current !== null) {
      console.log('[RendicionRutas:UI] visual load total ms', Math.round(performance.now() - loadStartedAtRef.current))
    }
  }, [isLoading, rows])

  // ── Actualizar fila localmente tras guardar (sin refrescar todo) ─────────
  const updateRowAfterSave = (
    guideId: string,
    result: SaveRouteSettlementResult
  ) => {
    const update = (currentRows: RouteSettlementsDashboardRow[]) =>
      currentRows.map(r => {
        if (r.route_guide_id !== guideId) return r
        return {
          ...r,
          settlement_id: result.settlement_id,
          settlement_number: result.settlement_number,
          settlement_status: result.settlement_status,
          operational_status: result.operational_status,
          action_type: 'VIEW' as const,
          has_worked_items: true,
        }
      })
    setRows(update)
    if (dashboardCache) {
      dashboardCache = { ...dashboardCache, rows: update(dashboardCache.rows) }
    }
  }

  // ── Manejador de doble clic ──────────────────────────────────────────────
  /**
   * REGLA: No crea RR. Solo navega al workspace correcto.
   * - Sin settlement_id → carga guía desde logistica (modo no-rr)
   * - Con settlement_id  → carga rendición existente (modo has-rr)
   */
  const handleRowDoubleClick = async (row: RouteSettlementsDashboardRow) => {
    setErrorMsg(null)

    if (!row.settlement_id) {
      // ── Guía sin rendición ──────────────────────────────────────────────
      if (process.env.NODE_ENV === 'development') {
        console.log('[RendicionRutas:UI] opening guide workspace (no-rr)', row.route_guide_id)
      }
      setView({ kind: 'loading-workspace', guideId: row.route_guide_id })

      const { data, error } = await getRouteGuideWorkspaceData(row.route_guide_id)
      if (!isMountedRef.current) return

      if (error || !data) {
        setErrorMsg(error ?? 'No se pudo cargar la guía.')
        setView({ kind: 'list' })
        return
      }

      setView({
        kind: 'workspace-no-rr',
        guideData: data,
        dashboardRow: row,
      })
    } else {
      // ── Guía con rendición existente ────────────────────────────────────
      if (process.env.NODE_ENV === 'development') {
        console.log('[RendicionRutas:UI] opening settlement workspace (has-rr)', row.settlement_id)
      }
      setView({ kind: 'loading-settlement', settlementId: row.settlement_id })

      // Cargar RR + items + guía en paralelo
      const [settlementRes, guideRes] = await Promise.all([
        getRouteSettlementById(row.settlement_id),
        getRouteGuideWorkspaceData(row.route_guide_id),
      ])
      if (!isMountedRef.current) return

      if (settlementRes.error || !settlementRes.data) {
        setErrorMsg(settlementRes.error ?? 'No se pudo cargar la rendición.')
        setView({ kind: 'list' })
        return
      }
      if (guideRes.error || !guideRes.data) {
        setErrorMsg(guideRes.error ?? 'No se pudo cargar la guía.')
        setView({ kind: 'list' })
        return
      }

      const sd = settlementRes.data
      setView({
        kind: 'workspace-has-rr',
        guideData: guideRes.data,
        settlement: {
          ...sd,
          guide_number: sd.guide_info?.guide_number,
          route_name: sd.guide_info?.route_name_snapshot,
          driver_name: sd.guide_info?.driver_name_snapshot,
          seller_name: sd.guide_info?.seller_name_snapshot,
        },
        settlementItems: sd.items,
        dashboardRow: row,
      })
    }
  }

  // ── Cerrar workspace ─────────────────────────────────────────────────────
  const handleCloseWorkspace = (savedResult?: SaveRouteSettlementResult) => {
    const currentView = view

    if (savedResult && (currentView.kind === 'workspace-no-rr' || currentView.kind === 'workspace-has-rr')) {
      // Hubo guardado: actualizar fila localmente (sin refrescar todo el dashboard)
      updateRowAfterSave(currentView.dashboardRow.route_guide_id, savedResult)
    }

    setView({ kind: 'list' })
  }

  // ─── Renders de vistas ────────────────────────────────────────────────────

  if (view.kind === 'loading-workspace' || view.kind === 'loading-settlement') {
    return (
      <div className="w-full h-64 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 opacity-50">
          <div className="w-6 h-6 border-2 border-theme-text-muted border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-semibold text-theme-text-muted">Cargando...</span>
        </div>
      </div>
    )
  }

  if (view.kind === 'workspace-no-rr') {
    return (
      <RouteSettlementWorkspace
        mode="no-rr"
        guideData={view.guideData}
        settlement={null}
        settlementItems={null}
        onClose={handleCloseWorkspace}
      />
    )
  }

  if (view.kind === 'workspace-has-rr') {
    return (
      <RouteSettlementWorkspace
        mode="has-rr"
        guideData={view.guideData}
        settlement={view.settlement}
        settlementItems={view.settlementItems}
        onClose={handleCloseWorkspace}
      />
    )
  }

  // ── Vista principal: bandeja (solo informativa) ───────────────────────────
  const statusChips = [
    { value: 'PENDING_SETTLEMENT', label: 'Pendientes', count: kpis.pending_count },
    { value: 'IN_REVIEW', label: 'En revisión', count: kpis.in_review_count },
    { value: 'SETTLED', label: 'Rendidas', count: kpis.settled_count },
    { value: 'SETTLED_WITH_DIFFERENCE', label: 'Diferencias', count: kpis.with_difference_count },
  ]

  return (
    <div className="h-full min-h-0 flex flex-col p-3 lg:p-4 animate-in fade-in duration-300">

      {/* Main Tab Switcher */}
      <div className="shrink-0 flex items-center gap-2 mb-3">
        <button
          onClick={() => setMainTab('TRAY')}
          className={`px-4 py-2 text-sm font-bold rounded-lg border transition-colors ${
            mainTab === 'TRAY'
              ? 'bg-theme-accent text-white border-theme-accent'
              : 'bg-theme-surface border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5'
          }`}
        >
          Bandeja de Rendiciones
        </button>
        <button
          onClick={() => setMainTab('FUND_CLOSURES')}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg border transition-colors ${
            mainTab === 'FUND_CLOSURES'
              ? 'bg-theme-accent text-white border-theme-accent'
              : 'bg-theme-surface border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5'
          }`}
        >
          <Wallet className="w-4 h-4" />
          Cierre de Fondos
        </button>
      </div>

      {mainTab === 'FUND_CLOSURES' ? (
        <div className="flex-1 min-h-0 border border-theme-border rounded-xl overflow-hidden bg-theme-surface">
          <FundClosuresWorkspace />
        </div>
      ) : (
        <>
          {/* Header operativo compacto */}
          <div className="shrink-0 flex flex-col gap-2 border border-theme-border bg-theme-surface/70 px-3 py-2.5 rounded-xl">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-theme-text leading-tight">Rendición de Rutas</h2>
              <p className="hidden md:block text-[11px] text-theme-text-muted leading-tight">
                Bandeja operativa de guías despachadas y rendiciones en curso.
              </p>
            </div>
            <button
              onClick={() => loadDashboardData(true)}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-theme-border bg-theme-text/5 hover:bg-theme-text/10 disabled:opacity-50 disabled:cursor-not-allowed text-[11px] font-semibold text-theme-text-muted hover:text-theme-text transition-colors"
              title="Actualizar bandeja"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              Actualizar
            </button>
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto hide-scrollbar">
            {statusChips.map(chip => {
              const active = filterStatus === chip.value
              return (
                <button
                  key={chip.value}
                  onClick={() => setFilterStatus(chip.value)}
                  className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition-colors ${
                    active
                      ? 'border-theme-accent/60 bg-theme-accent/15 text-theme-text ring-1 ring-theme-accent/20'
                      : 'border-theme-border bg-theme-text/5 text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10'
                  }`}
                >
                  <span>{chip.label}</span>
                  <span className="font-mono text-theme-text">{chip.count}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="shrink-0 mt-3 bg-red-50 dark:bg-red-900/10 border-l-4 border-red-500 p-3 rounded-r-lg">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
            <div className="text-sm font-medium text-red-800 dark:text-red-200">{errorMsg}</div>
          </div>
        </div>
      )}

      {/* Tabla (Scrollable) */}
      <div className="flex-1 min-h-0 mt-3">
        <UnifiedRouteSettlementsTable
          data={rows}
          isLoading={isLoading}
          onRowDoubleClick={handleRowDoubleClick}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          paymentFilter={paymentFilter}
          setPaymentFilter={setPaymentFilter}
        />
      </div>
      
      </>
      )}

    </div>
  )
}
