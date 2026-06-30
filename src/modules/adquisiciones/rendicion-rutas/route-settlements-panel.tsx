'use client'

import React, { useState, useEffect } from 'react'
import { getRouteSettlementsDashboardData, createRouteSettlementFromGuide, getRouteSettlementById } from '@/app/actions/adquisiciones/rendicion-rutas'
import { UnifiedRouteSettlementsTable } from './components/unified-route-settlements-table'
import { RouteSettlementDetailPanel } from './components/route-settlement-detail-panel'
import { RouteSettlement, RouteSettlementItem } from './types'
import { AlertTriangle, ClipboardCheck, FileText, CheckCircle2 } from 'lucide-react'

export function RouteSettlementsPanel() {
  const [rows, setRows] = useState<any[]>([])
  const [kpis, setKpis] = useState({ pending_count: 0, in_review_count: 0, settled_count: 0, with_difference_count: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState('ALL')
  
  const [isCreating, setIsCreating] = useState(false)
  const [creatingGuideId, setCreatingGuideId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Detail State
  const [selectedSettlementId, setSelectedSettlementId] = useState<string | null>(null)
  const [detailData, setDetailData] = useState<{ settlement: RouteSettlement, items: RouteSettlementItem[] } | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)

  let renderCount = React.useRef(0)
  
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      renderCount.current += 1
      console.log(`[RendicionRutas:UI] render count: ${renderCount.current}`)
    }
  })

  const loadDashboardData = async () => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[RendicionRutas:UI] fetch start`)
    }
    const t0 = performance.now()
    setIsLoading(true)
    
    const { data, error } = await getRouteSettlementsDashboardData()
    if (error) {
      setErrorMsg(error)
    } else if (data) {
      setRows(data.rows || [])
      if (data.kpis) setKpis(data.kpis)
    }
    
    setIsLoading(false)
    const t1 = performance.now()
    if (process.env.NODE_ENV === 'development') {
      console.log(`[RendicionRutas:UI] fetch end`)
      console.log(`[RendicionRutas:UI] total visual load ms: ${Math.round(t1 - t0)}ms`)
      console.log(`[RendicionRutas:UI] table rendered`)
    }
  }

  const hasFetched = React.useRef(false)

  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[RendicionRutas:UI] mounted`)
    }
    if (!hasFetched.current) {
      hasFetched.current = true
      loadDashboardData()
    }
  }, [])

  const handleCreateSettlement = async (guideId: string) => {
    setIsCreating(true)
    setCreatingGuideId(guideId)
    setErrorMsg(null)
    const { data, error } = await createRouteSettlementFromGuide(guideId)
    if (error) {
      setErrorMsg(error)
    } else {
      await loadDashboardData()
      if (data?.id) {
        handleViewDetail(data.id)
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
          <button onClick={() => setFilterStatus('CREATED_NOT_REVIEWED')} className="p-4 rounded-xl border border-theme-border bg-theme-surface/50 hover:bg-theme-surface transition-colors text-left focus:outline-none focus:ring-2 focus:ring-theme-accent">
            <div className="flex items-center gap-2 mb-2 text-blue-500">
              <FileText className="w-4 h-4" />
              <h3 className="text-[10px] font-bold uppercase tracking-wider">Pendientes de revisar</h3>
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
