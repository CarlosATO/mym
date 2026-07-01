import React, { useState, useMemo, useRef } from 'react'
import type { RouteSettlementsDashboardRow } from '@/app/actions/adquisiciones/rendicion-rutas'
import { formatCurrency, formatDate } from '../utils/route-settlement-formatters'
import { SettlementStatusBadge } from './route-settlement-badges'
import { ArrowRight, Filter, Search, X } from 'lucide-react'

interface UnifiedTableProps {
  data: RouteSettlementsDashboardRow[]
  isLoading: boolean
  onRowDoubleClick: (row: RouteSettlementsDashboardRow) => void
  filterStatus: string
  setFilterStatus: (status: string) => void
  paymentFilter: 'CASH_ONLY' | 'ALL' | 'CREDIT'
  setPaymentFilter: (filter: 'CASH_ONLY' | 'ALL' | 'CREDIT') => void
}

export function UnifiedRouteSettlementsTable({
  data,
  isLoading,
  onRowDoubleClick,
  filterStatus,
  setFilterStatus,
  paymentFilter,
  setPaymentFilter,
}: UnifiedTableProps) {

  const [searchTerm, setSearchTerm] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)

  // Ref para distinguir doble clic de clic simple
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const filteredData = useMemo(() => {
    return data.filter(row => {
      if (filterStatus !== 'ALL' && row.operational_status !== filterStatus) return false

      const countedAmount = row.total_cash_expected + row.total_check_expected + row.total_transfer_expected
      if (paymentFilter === 'CASH_ONLY' && countedAmount <= 0) return false
      if (paymentFilter === 'CREDIT' && row.total_credit_amount <= 0) return false

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
  }, [data, dateFrom, dateTo, filterStatus, paymentFilter, searchTerm])

  /** Clic simple: solo selecciona la fila (resalta), no abre ni crea nada */
  const handleRowClick = (rowId: string) => {
    setSelectedRowId(rowId)
  }

  /** Doble clic: abre el workspace de la guía/rendición */
  const handleRowDoubleClick = (row: RouteSettlementsDashboardRow) => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    onRowDoubleClick(row)
  }

  /** Enter cuando hay una fila seleccionada */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && selectedRowId) {
      const selectedRow = filteredData.find(r => r.route_guide_id === selectedRowId)
      if (selectedRow) onRowDoubleClick(selectedRow)
    }
  }

  if (isLoading) {
    return (
      <div className="w-full h-full min-h-[260px] flex items-center justify-center border border-theme-border rounded-xl bg-theme-surface/50">
        <div className="flex flex-col items-center gap-2 opacity-50">
          <div className="w-6 h-6 border-2 border-theme-text-muted border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-semibold text-theme-text-muted">Cargando datos...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col rounded-xl border border-theme-border bg-theme-surface overflow-hidden">
      {/* Barra compacta de filtros */}
      <div className="shrink-0 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between px-3 py-2 border-b border-theme-border/70 bg-theme-surface/95">
        <div className="flex items-center gap-2 min-w-0">
          <div className="relative w-full lg:w-[360px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-text-muted" />
            <input
              type="text"
              placeholder="Buscar guía, rendición, ruta, conductor o vendedor..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-theme-bg/40 border border-theme-border rounded-lg focus:outline-none focus:border-theme-accent transition-colors text-theme-text placeholder-theme-text-muted"
            />
          </div>
          <span className="hidden xl:inline text-[10px] text-theme-text-muted whitespace-nowrap" title="Doble clic o Enter sobre una fila seleccionada para abrir">
            Doble clic / Enter para abrir
          </span>
        </div>

        <div className="flex items-center gap-1.5 w-full lg:w-auto overflow-x-auto hide-scrollbar">
          <Filter className="w-3.5 h-3.5 text-theme-text-muted shrink-0" />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="text-xs bg-theme-bg/40 border border-theme-border rounded-lg px-2.5 py-1.5 text-theme-text focus:outline-none focus:border-theme-accent"
            aria-label="Fecha desde"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="text-xs bg-theme-bg/40 border border-theme-border rounded-lg px-2.5 py-1.5 text-theme-text focus:outline-none focus:border-theme-accent"
            aria-label="Fecha hasta"
          />
          <select
            value={paymentFilter}
            onChange={(e) => setPaymentFilter(e.target.value as 'CASH_ONLY' | 'ALL' | 'CREDIT')}
            className="text-xs bg-theme-bg/40 border border-theme-border rounded-lg px-2.5 py-1.5 text-theme-text focus:outline-none focus:border-theme-accent"
            aria-label="Filtro tipo de pago"
          >
            <option value="CASH_ONLY">Solo rendibles</option>
            <option value="ALL">Todos</option>
            <option value="CREDIT">Crédito</option>
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="text-xs bg-theme-bg/40 border border-theme-border rounded-lg px-2.5 py-1.5 text-theme-text focus:outline-none focus:border-theme-accent"
          >
            <option value="ALL">Todos los estados</option>
            <option value="PENDING_SETTLEMENT">Pendiente de rendición</option>
            <option value="IN_REVIEW">En revisión</option>
            <option value="SETTLED">Rendida</option>
            <option value="SETTLED_WITH_DIFFERENCE">Con diferencias</option>
            <option value="CLOSED">Cerrada</option>
            <option value="CANCELLED">Anulada</option>
          </select>
          {(filterStatus !== 'ALL' || paymentFilter !== 'CASH_ONLY' || searchTerm !== '' || dateFrom !== '' || dateTo !== '') && (
            <button
              onClick={() => { setFilterStatus('ALL'); setPaymentFilter('CASH_ONLY'); setSearchTerm(''); setDateFrom(''); setDateTo('') }}
              className="p-1.5 rounded-lg text-theme-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
              title="Limpiar filtros"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead>
            <tr className="sticky top-0 z-10 border-b border-theme-border/70 bg-theme-surface/95 backdrop-blur-sm shadow-sm">
              <th className="px-3 py-2 font-bold text-theme-text-muted">Guía</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted">Rendición</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted">Fecha</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted">Ruta</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted">Conductor</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted">Vendedor</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Total ruta</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Total rendible</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Ef. esperado</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Ef. recibido</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Dif. ef.</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Transf. conf.</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-center">Transf. pend.</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-center">Fact. rendibles</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-center">Estado</th>
              <th className="px-3 py-2 font-bold text-theme-text-muted text-center">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/50">
            {filteredData.length === 0 ? (
              <tr>
                <td colSpan={16} className="px-4 py-12 text-center text-theme-text-muted">
                  No se encontraron resultados para los filtros seleccionados.
                </td>
              </tr>
            ) : (
              filteredData.map((item) => {
                const isSelected = selectedRowId === item.route_guide_id
                const totalRendible = item.total_cash_expected + item.total_check_expected + item.total_transfer_expected
                return (
                  <tr
                    key={item.route_guide_id}
                    tabIndex={0}
                    title="Doble clic, Enter o botón Abrir"
                    onClick={() => handleRowClick(item.route_guide_id)}
                    onDoubleClick={() => handleRowDoubleClick(item)}
                    onKeyDown={handleKeyDown}
                    className={`
                      cursor-pointer transition-colors select-none outline-none
                      ${isSelected
                        ? 'bg-theme-accent/10 ring-1 ring-inset ring-theme-accent/30'
                        : 'hover:bg-theme-text/[0.03] focus:bg-theme-text/[0.04]'}
                    `}
                  >
                    <td className="px-3 py-2 font-bold text-theme-text">{item.guide_number}</td>
                    <td className="px-3 py-2 text-theme-text font-mono text-[11px]">{item.settlement_number || '—'}</td>
                    <td className="px-3 py-2 text-theme-text-muted">{formatDate(item.guide_date ?? '')}</td>
                    <td className="px-3 py-2 text-theme-text max-w-[180px] truncate" title={item.route_name || undefined}>{item.route_name || '—'}</td>
                    <td className="px-3 py-2 text-theme-text max-w-[120px] truncate" title={item.driver_name || undefined}>{item.driver_name || '—'}</td>
                    <td className="px-3 py-2 text-theme-text max-w-[120px] truncate" title={item.seller_name || undefined}>{item.seller_name || '—'}</td>
                    <td className="px-3 py-2 text-theme-text text-right font-semibold">{formatCurrency(item.total_route_amount)}</td>
                    <td className="px-3 py-2 text-theme-text text-right font-semibold">{formatCurrency(totalRendible)}</td>
                    <td className="px-3 py-2 text-theme-text text-right font-semibold">{formatCurrency(item.total_cash_expected)}</td>
                    <td className="px-3 py-2 text-theme-text text-right font-semibold text-green-600 dark:text-green-400">
                      {item.settlement_id ? formatCurrency(item.total_cash_received) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`font-bold ${item.total_cash_difference > 0 ? 'text-red-500' : 'text-theme-text-muted'}`}>
                        {item.settlement_id ? formatCurrency(item.total_cash_difference) : '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-theme-text text-right font-semibold">
                      {item.settlement_id ? formatCurrency(item.total_transfer_confirmed) : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`px-2 py-0.5 rounded-md font-medium ${item.total_transfer_pending > 0 ? 'bg-orange-500/10 text-orange-600' : 'bg-theme-text/5 text-theme-text'}`}>
                        {item.total_transfer_pending > 0 ? formatCurrency(item.total_transfer_pending) : '0'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className="px-2 py-0.5 rounded-md bg-theme-text/5 text-theme-text font-medium">
                        {item.settlement_id ? `${item.paid_count} / ${item.total_rendible_count}` : `0 / ${item.total_rendible_count}`}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <SettlementStatusBadge status={item.operational_status} />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedRowId(item.route_guide_id)
                          onRowDoubleClick(item)
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-theme-border bg-theme-text/5 hover:bg-theme-accent/10 hover:border-theme-accent/40 text-[11px] font-bold text-theme-text-muted hover:text-theme-text transition-colors"
                        title="Abrir guía"
                      >
                        Abrir
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
