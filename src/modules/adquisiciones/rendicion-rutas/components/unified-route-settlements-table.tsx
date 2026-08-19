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
  canCreateSettlement: boolean
  onStartSettlement: (row: RouteSettlementsDashboardRow) => void
}

export function UnifiedRouteSettlementsTable({
  data,
  isLoading,
  onRowDoubleClick,
  filterStatus,
  setFilterStatus,
  paymentFilter,
  setPaymentFilter,
  canCreateSettlement,
  onStartSettlement,
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
      <div className="w-full h-full min-h-0 flex items-center justify-center rounded-[18px] border border-theme-border bg-theme-surface shadow-sm">
        <div className="flex flex-col items-center gap-2 opacity-50">
          <div className="w-6 h-6 border-2 border-theme-text-muted border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-semibold text-theme-text-muted">Cargando datos...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden rounded-[18px] border border-theme-border bg-theme-surface shadow-sm">
      {/* Barra compacta de filtros */}
      <div className="shrink-0 min-w-0 flex flex-col gap-2 border-b border-theme-border/70 bg-theme-surface px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2">
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

        <div className="flex min-w-0 w-full items-center gap-1.5 overflow-x-auto hide-scrollbar lg:w-auto">
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

      <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-contain">
        <table className="w-full min-w-[1840px] table-fixed text-left text-xs whitespace-nowrap">
          <thead className="sticky top-0 z-20 bg-theme-surface">
            <tr className="border-b border-theme-border/70 bg-theme-surface shadow-sm">
              <th className="w-[110px] px-3 py-2.5 font-bold text-theme-text-muted">Guía</th>
              <th className="w-[125px] px-3 py-2.5 font-bold text-theme-text-muted">Rendición</th>
              <th className="w-[95px] px-3 py-2.5 font-bold text-theme-text-muted">Fecha</th>
              <th className="w-[140px] px-3 py-2.5 font-bold text-theme-text-muted">Ruta</th>
              <th className="w-[120px] px-3 py-2.5 font-bold text-theme-text-muted">Conductor</th>
              <th className="w-[120px] px-3 py-2.5 font-bold text-theme-text-muted">Vendedor</th>
              <th className="w-[110px] px-3 py-2.5 text-right font-bold text-theme-text-muted">Total ruta</th>
              <th className="w-[110px] px-3 py-2.5 text-right font-bold text-theme-text-muted">Total rendible</th>
              <th className="w-[110px] px-3 py-2.5 text-right font-bold text-theme-text-muted">Ef. esperado</th>
              <th className="w-[110px] px-3 py-2.5 text-right font-bold text-theme-text-muted">Ef. recibido</th>
              <th className="w-[110px] px-3 py-2.5 text-right font-bold text-theme-text-muted">Dif. ef.</th>
              <th className="w-[115px] px-3 py-2.5 text-right font-bold text-theme-text-muted">Transf. conf.</th>
              <th className="w-[120px] px-3 py-2.5 text-center font-bold text-theme-text-muted">Transf. pend.</th>
              <th className="w-[105px] px-3 py-2.5 text-center font-bold text-theme-text-muted">Fact. rendibles</th>
              <th className="w-[140px] px-3 py-2.5 text-center font-bold text-theme-text-muted">Estado</th>
              <th className="w-[125px] px-3 py-2.5 text-center font-bold text-theme-text-muted">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/50">
            {filteredData.length === 0 ? (
              <tr>
                <td colSpan={16} className="px-4 py-12 text-center text-theme-text-muted">
                  {data.length === 0
                    ? 'No hay guías despachadas disponibles para rendición.'
                    : 'No se encontraron resultados para los filtros seleccionados.'}
                </td>
              </tr>
            ) : (
              filteredData.map((item) => {
                const isSelected = selectedRowId === item.route_guide_id
                const totalRendible = item.total_cash_expected + item.total_check_expected + item.total_transfer_expected
                const isTerminal = item.operational_status === 'CLOSED' || item.operational_status === 'CANCELLED'
                const actionLabel = !item.settlement_id
                  ? 'Iniciar rendición'
                  : isTerminal
                    ? 'Ver detalle'
                    : 'Abrir rendición'
                return (
                  <tr
                    key={item.route_guide_id}
                    tabIndex={0}
                    title={`Doble clic, Enter o botón ${actionLabel}`}
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
                    <td className="w-[110px] px-3 py-2.5 font-bold text-theme-text">{item.guide_number}</td>
                    <td className="w-[125px] px-3 py-2.5 font-mono text-[11px] text-theme-text">{item.settlement_number || '—'}</td>
                    <td className="w-[95px] px-3 py-2.5 text-theme-text-muted">{formatDate(item.guide_date ?? '')}</td>
                    <td className="w-[140px] max-w-[140px] truncate px-3 py-2.5 text-theme-text" title={item.route_name || undefined}>{item.route_name || '—'}</td>
                    <td className="w-[120px] max-w-[120px] truncate px-3 py-2.5 text-theme-text" title={item.driver_name || undefined}>{item.driver_name || '—'}</td>
                    <td className="w-[120px] max-w-[120px] truncate px-3 py-2.5 text-theme-text" title={item.seller_name || undefined}>{item.seller_name || '—'}</td>
                    <td className="w-[110px] px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text">{formatCurrency(item.total_route_amount)}</td>
                    <td className="w-[110px] px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text">{formatCurrency(totalRendible)}</td>
                    <td className="w-[110px] px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text">{formatCurrency(item.total_cash_expected)}</td>
                    <td className="w-[110px] px-3 py-2.5 text-right font-semibold tabular-nums text-green-600 dark:text-green-400">
                      {item.settlement_id ? formatCurrency(item.total_cash_received) : '—'}
                    </td>
                    <td className="w-[110px] px-3 py-2.5 text-right tabular-nums">
                      <span className={`font-bold ${item.total_cash_difference > 0 ? 'text-red-500' : 'text-theme-text-muted'}`}>
                        {item.settlement_id ? formatCurrency(item.total_cash_difference) : '—'}
                      </span>
                    </td>
                    <td className="w-[115px] px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text">
                      {item.settlement_id ? formatCurrency(item.total_transfer_confirmed) : '—'}
                    </td>
                    <td className="w-[120px] px-3 py-2.5 text-center tabular-nums">
                      <span className={`px-2 py-0.5 rounded-md font-medium ${item.total_transfer_pending > 0 ? 'bg-orange-500/10 text-orange-600' : 'bg-theme-text/5 text-theme-text'}`}>
                        {item.total_transfer_pending > 0 ? formatCurrency(item.total_transfer_pending) : '0'}
                      </span>
                    </td>
                    <td className="w-[105px] px-3 py-2.5 text-center tabular-nums">
                      <span className="px-2 py-0.5 rounded-md bg-theme-text/5 text-theme-text font-medium">
                        {item.settlement_id ? `${item.paid_count} / ${item.total_rendible_count}` : `0 / ${item.total_rendible_count}`}
                      </span>
                    </td>
                    <td className="w-[140px] px-3 py-2.5 text-center">
                      <SettlementStatusBadge status={item.operational_status} />
                    </td>
                    <td className="w-[125px] px-3 py-2.5 text-center">
                      <button
                        type="button"
                        disabled={!item.settlement_id && !canCreateSettlement}
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelectedRowId(item.route_guide_id)
                          onStartSettlement(item)
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-theme-border bg-theme-text/5 hover:bg-theme-accent/10 hover:border-theme-accent/40 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-bold text-theme-text-muted hover:text-theme-text transition-colors"
                        title={!item.settlement_id && !canCreateSettlement ? 'No tienes permiso para iniciar rendiciones' : actionLabel}
                      >
                        {actionLabel}
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
