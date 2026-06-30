import React, { useState, useMemo } from 'react'
import type { RouteSettlementsDashboardRow } from '@/app/actions/adquisiciones/rendicion-rutas'
import { formatCurrency, formatDate } from '../utils/route-settlement-formatters'
import { SettlementStatusBadge } from './route-settlement-badges'
import { ClipboardCheck, Eye, Search, Filter, X } from 'lucide-react'

interface UnifiedTableProps {
  data: RouteSettlementsDashboardRow[]
  isLoading: boolean
  onCreateSettlement: (guideId: string) => void
  isCreating: boolean
  creatingGuideId: string | null
  onViewDetail: (settlementId: string) => void
  filterStatus: string
  setFilterStatus: (status: string) => void
}

export function UnifiedRouteSettlementsTable({
  data,
  isLoading,
  onCreateSettlement,
  isCreating,
  creatingGuideId,
  onViewDetail,
  filterStatus,
  setFilterStatus
}: UnifiedTableProps) {
  
  const [searchTerm, setSearchTerm] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const filteredData = useMemo(() => {
    return data.filter(row => {
      if (filterStatus !== 'ALL' && row.operational_status !== filterStatus) return false
      
      if (searchTerm) {
        const lowerSearch = searchTerm.toLowerCase()
        const matchesGuide = row.guide_number?.toLowerCase().includes(lowerSearch)
        const matchesSettlement = row.settlement_number?.toLowerCase().includes(lowerSearch)
        const matchesRoute = row.route_name?.toLowerCase().includes(lowerSearch)
        const matchesDriver = row.driver_name?.toLowerCase().includes(lowerSearch)
        const matchesSeller = row.seller_name?.toLowerCase().includes(lowerSearch)
        if (!(matchesGuide || matchesSettlement || matchesRoute || matchesDriver || matchesSeller)) return false
      }

      if (dateFrom && row.guide_date && row.guide_date < dateFrom) return false
      if (dateTo && row.guide_date && row.guide_date > dateTo) return false

      return true
    })
  }, [data, dateFrom, dateTo, filterStatus, searchTerm])

  if (isLoading) {
    return (
      <div className="w-full h-64 flex items-center justify-center border border-theme-border rounded-xl bg-theme-surface/50">
        <div className="flex flex-col items-center gap-2 opacity-50">
          <div className="w-6 h-6 border-2 border-theme-text-muted border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-semibold text-theme-text-muted">Cargando datos...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="relative w-full md:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted" />
          <input 
            type="text" 
            placeholder="Buscar por guía, rendición, ruta, conductor o vendedor..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-theme-surface border border-theme-border rounded-xl focus:outline-none focus:border-theme-accent transition-colors text-theme-text placeholder-theme-text-muted"
          />
        </div>
        
        <div className="flex items-center gap-2 w-full md:w-auto overflow-x-auto">
          <Filter className="w-4 h-4 text-theme-text-muted shrink-0" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2 text-theme-text focus:outline-none focus:border-theme-accent"
            aria-label="Fecha desde"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2 text-theme-text focus:outline-none focus:border-theme-accent"
            aria-label="Fecha hasta"
          />
          <select 
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2 text-theme-text focus:outline-none focus:border-theme-accent"
          >
            <option value="ALL">Todos los estados</option>
            <option value="PENDING_SETTLEMENT">Pendiente de rendición</option>
            <option value="IN_REVIEW">En revisión</option>
            <option value="SETTLED">Rendida</option>
            <option value="SETTLED_WITH_DIFFERENCE">Con diferencias</option>
            <option value="CLOSED">Cerrada</option>
            <option value="CANCELLED">Anulada</option>
          </select>
          {(filterStatus !== 'ALL' || searchTerm !== '' || dateFrom !== '' || dateTo !== '') && (
            <button 
              onClick={() => { setFilterStatus('ALL'); setSearchTerm(''); setDateFrom(''); setDateTo(''); }}
              className="p-2 text-theme-text-muted hover:text-red-500 transition-colors shrink-0"
              title="Limpiar filtros"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead>
            <tr className="border-b border-theme-border/50 bg-theme-text/5">
              <th className="px-4 py-3 font-bold text-theme-text-muted">N° Guía</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted">N° Rendición</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted">Fecha</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted">Ruta</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted">Conductor</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted">Vendedor</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-right">Total Ruta</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-right">Efectivo Esp.</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-right">Efectivo Recib.</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-right">Diferencia</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-center">Transf. Pend.</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-center">Facturas</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-center">Estado</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-center">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/50">
            {filteredData.length === 0 ? (
              <tr>
                <td colSpan={14} className="px-4 py-12 text-center text-theme-text-muted">
                  No se encontraron resultados para los filtros seleccionados.
                </td>
              </tr>
            ) : (
              filteredData.map((item) => (
                <tr key={item.route_guide_id} className="hover:bg-theme-text/[0.02] transition-colors">
                  <td className="px-4 py-3 font-bold text-theme-text">{item.guide_number}</td>
                  <td className="px-4 py-3 text-theme-text font-mono text-[11px]">{item.settlement_number || '—'}</td>
                  <td className="px-4 py-3 text-theme-text-muted">{formatDate(item.guide_date ?? '')}</td>
                  <td className="px-4 py-3 text-theme-text">{item.route_name || '—'}</td>
                  <td className="px-4 py-3 text-theme-text max-w-[120px] truncate" title={item.driver_name || undefined}>{item.driver_name || '—'}</td>
                  <td className="px-4 py-3 text-theme-text max-w-[120px] truncate" title={item.seller_name || undefined}>{item.seller_name || '—'}</td>
                  <td className="px-4 py-3 text-theme-text text-right font-semibold">{formatCurrency(item.total_route_amount)}</td>
                  <td className="px-4 py-3 text-theme-text text-right font-semibold">{formatCurrency(item.total_cash_expected)}</td>
                  <td className="px-4 py-3 text-theme-text text-right font-semibold text-green-600 dark:text-green-400">
                    {item.settlement_id ? formatCurrency(item.total_cash_received) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={`font-bold ${item.total_cash_difference > 0 ? 'text-red-500' : 'text-theme-text-muted'}`}>
                      {item.settlement_id ? formatCurrency(item.total_cash_difference) : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full font-medium ${item.total_transfer_pending > 0 ? 'bg-orange-500/10 text-orange-600' : 'bg-theme-text/5 text-theme-text'}`}>
                      {item.total_transfer_pending > 0 ? formatCurrency(item.total_transfer_pending) : '0'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="px-2 py-0.5 rounded-full bg-theme-text/5 text-theme-text font-medium">{item.total_invoices}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <SettlementStatusBadge status={item.operational_status} />
                  </td>
                  <td className="px-4 py-3 text-center">
                    {item.action_type === 'CREATE' ? (
                      <button
                        onClick={() => onCreateSettlement(item.route_guide_id)}
                        disabled={isCreating && creatingGuideId === item.route_guide_id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white font-bold text-[11px] uppercase tracking-wider transition-all disabled:opacity-50 w-32 justify-center"
                      >
                        {isCreating && creatingGuideId === item.route_guide_id ? (
                          <>
                            <div className="w-3 h-3 border-2 border-white/50 border-t-white rounded-full animate-spin" />
                            Creando...
                          </>
                        ) : (
                          <>
                            <ClipboardCheck className="w-3.5 h-3.5" />
                            Crear RR
                          </>
                        )}
                      </button>
                    ) : (
                      <button
                        onClick={() => item.settlement_id && onViewDetail(item.settlement_id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-theme-border hover:bg-theme-text/5 text-theme-text font-bold text-[11px] uppercase tracking-wider transition-all w-32 justify-center"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Ver Detalle
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
