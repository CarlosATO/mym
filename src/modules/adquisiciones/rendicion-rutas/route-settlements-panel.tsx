'use client'

import React, { useState, useEffect, useRef } from 'react'
import {
  getRouteSettlementsDashboardData,
  createRouteSettlementFromGuide,
  getRouteSettlementById,
  type RouteSettlementsDashboardKpis,
  type RouteSettlementsDashboardRow,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import { UnifiedRouteSettlementsTable } from './components/unified-route-settlements-table'
import { RouteSettlementDetailPanel } from './components/route-settlement-detail-panel'
import { RouteSettlement, RouteSettlementItem } from './types'
import { AlertTriangle, ClipboardCheck, FileText, CheckCircle2 } from 'lucide-react'

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

function applyCreatedSettlementToRows(
  currentRows: RouteSettlementsDashboardRow[],
  guideId: string,
  settlementId: string | null | undefined,
  settlementNumber: string | null | undefined
) {
  return currentRows.map(row => {
    if (row.route_guide_id !== guideId) return row
    return {
      ...row,
      settlement_id: settlementId ?? row.settlement_id,
      settlement_number: settlementNumber ?? row.settlement_number,
      settlement_status: 'IN_REVIEW',
      has_worked_items: false,
      operational_status: 'PENDING_SETTLEMENT' as const,
      action_type: 'VIEW' as const
    }
  })
}

export function RouteSettlementsPanel() {
  const [rows, setRows] = useState<RouteSettlementsDashboardRow[]>([])
  const [kpis, setKpis] = useState<RouteSettlementsDashboardKpis>(EMPTY_KPIS)
  const [isLoading, setIsLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('ALL')
  
  const [isCreating, setIsCreating] = useState(false)
  const [creatingGuideId, setCreatingGuideId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Detail State
  const [selectedSettlementId, setSelectedSettlementId] = useState<string | null>(null)
  const [detailData, setDetailData] = useState<{ settlement: RouteSettlement, items: RouteSettlementItem[] } | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)

  const renderCount = useRef(0)
  const isMountedRef = useRef(false)
  const loadStartedAtRef = useRef<number | null>(null)
  const latestRequestIdRef = useRef(0)
  const hasLoggedKpisRef = useRef(false)
  const hasLoggedTableRef = useRef(false)
  
  useEffect(() => {
    renderCount.current += 1
    if (process.env.NODE_ENV === 'development') console.log('[RendicionRutas:UI] render count', renderCount.current)
  })

  const loadDashboardData = async (forceRefresh = false) => {
    const requestId = latestRequestIdRef.current + 1
    latestRequestIdRef.current = requestId

    if (process.env.NODE_ENV === 'development') {
      console.log('[RendicionRutas:UI] fetch start')
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

  const handleCreateSettlement = async (guideId: string) => {
    if (isCreating) return
    setIsCreating(true)
    setCreatingGuideId(guideId)
    setErrorMsg(null)
    const { data, error } = await createRouteSettlementFromGuide(guideId)
    if (error) {
      setErrorMsg(error)
    } else {
      setRows(currentRows => applyCreatedSettlementToRows(currentRows, guideId, data?.id, data?.settlement_number))
      if (dashboardCache) {
        dashboardCache = {
          ...dashboardCache,
          rows: applyCreatedSettlementToRows(dashboardCache.rows, guideId, data?.id, data?.settlement_number)
        }
      }
    }
    setIsCreating(false)
    setCreatingGuideId(null)
  }

  const handleViewDetail = async (settlementId: string) => {
    setSelectedSettlementId(settlementId)
    setIsLoadingDetail(true)
    setErrorMsg(null)
    const { data, error } = await getRouteSettlementById(settlementId)
    if (error) {
      setErrorMsg(error)
      setSelectedSettlementId(null)
    } else {
      setDetailData({
        settlement: {
          ...data,
          guide_number: data.guide_info?.guide_number,
          route_name: data.guide_info?.route_name_snapshot,
          driver_name: data.guide_info?.driver_name_snapshot,
          seller_name: data.guide_info?.seller_name_snapshot
        },
        items: data.items
      })
    }
    setIsLoadingDetail(false)
  }

  const handleCloseDetail = () => {
    setSelectedSettlementId(null)
    setDetailData(null)
  }

  if (selectedSettlementId && detailData) {
    return (
      <RouteSettlementDetailPanel 
        settlement={detailData.settlement}
        items={detailData.items}
        onClose={handleCloseDetail}
      />
    )
  }

  if (selectedSettlementId && isLoadingDetail) {
    return (
      <div className="w-full h-64 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 opacity-50">
          <div className="w-6 h-6 border-2 border-theme-text-muted border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-semibold text-theme-text-muted">Cargando detalle...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      
      {/* Header and KPIs */}
      <div>
        <h2 className="text-xl font-bold text-theme-text mb-1">Rendición de Rutas</h2>
        <p className="text-sm text-theme-text-muted mb-6">
          Control de guías despachadas, pagos recibidos, transferencias, pendientes y diferencias.
        </p>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <button onClick={() => setFilterStatus('PENDING_SETTLEMENT')} className="p-4 rounded-xl border border-theme-border bg-theme-surface/50 hover:bg-theme-surface transition-colors text-left focus:outline-none focus:ring-2 focus:ring-theme-accent">
            <div className="flex items-center gap-2 mb-2 text-theme-text-muted">
              <ClipboardCheck className="w-4 h-4" />
              <h3 className="text-[10px] font-bold uppercase tracking-wider">Guías por rendir</h3>
            </div>
            <p className="text-2xl font-bold text-theme-text">{kpis.pending_count}</p>
          </button>
          <button onClick={() => setFilterStatus('IN_REVIEW')} className="p-4 rounded-xl border border-theme-border bg-theme-surface/50 hover:bg-theme-surface transition-colors text-left focus:outline-none focus:ring-2 focus:ring-theme-accent">
            <div className="flex items-center gap-2 mb-2 text-blue-500">
              <FileText className="w-4 h-4" />
              <h3 className="text-[10px] font-bold uppercase tracking-wider">En revisión</h3>
            </div>
            <p className="text-2xl font-bold text-theme-text">{kpis.in_review_count}</p>
          </button>
          <button onClick={() => setFilterStatus('SETTLED')} className="p-4 rounded-xl border border-theme-border bg-theme-surface/50 hover:bg-theme-surface transition-colors text-left focus:outline-none focus:ring-2 focus:ring-theme-accent">
            <div className="flex items-center gap-2 mb-2 text-green-500">
              <CheckCircle2 className="w-4 h-4" />
              <h3 className="text-[10px] font-bold uppercase tracking-wider">Rendidas</h3>
            </div>
            <p className="text-2xl font-bold text-theme-text">{kpis.settled_count}</p>
          </button>
          <button onClick={() => setFilterStatus('SETTLED_WITH_DIFFERENCE')} className="p-4 rounded-xl border border-theme-border bg-theme-surface/50 hover:bg-theme-surface transition-colors text-left focus:outline-none focus:ring-2 focus:ring-theme-accent">
            <div className="flex items-center gap-2 mb-2 text-orange-500">
              <AlertTriangle className="w-4 h-4" />
              <h3 className="text-[10px] font-bold uppercase tracking-wider">Con Diferencias</h3>
            </div>
            <p className="text-2xl font-bold text-theme-text">{kpis.with_difference_count}</p>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-red-50 dark:bg-red-900/10 border-l-4 border-red-500 p-4 rounded-r-xl">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
            <div className="text-sm font-medium text-red-800 dark:text-red-200">{errorMsg}</div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="pt-2">
        <UnifiedRouteSettlementsTable 
          data={rows}
          isLoading={isLoading}
          onCreateSettlement={handleCreateSettlement}
          isCreating={isCreating}
          creatingGuideId={creatingGuideId}
          onViewDetail={handleViewDetail}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
        />
      </div>

    </div>
  )
}
