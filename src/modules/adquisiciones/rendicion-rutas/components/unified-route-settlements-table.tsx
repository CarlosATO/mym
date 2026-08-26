import React, { useState, useMemo, useRef } from 'react'
import type { RouteSettlementsDashboardRow } from '@/app/actions/adquisiciones/rendicion-rutas'
import { formatCurrency, formatDate } from '../utils/route-settlement-formatters'
import { SettlementStatusBadge } from './route-settlement-badges'
import { ArrowRight, Filter, Search, X } from 'lucide-react'
import { OperationalTableResizeHandle, shouldIgnoreOperationalRowDoubleClick, useOperationalTableWidths, type OperationalTableColumn } from '@/components/ui/operational-table'

const ROUTE_SETTLEMENTS_TABLE_KEY = 'mym:table:adquisiciones:rendicion-rutas'
const ROUTE_SETTLEMENT_COLUMNS: OperationalTableColumn[] = [
  { id: 'guide', defaultWidth: 110, minWidth: 95, maxWidth: 180 },
  { id: 'settlement', defaultWidth: 125, minWidth: 105, maxWidth: 210 },
  { id: 'date', defaultWidth: 95, minWidth: 85, maxWidth: 145 },
  { id: 'route', defaultWidth: 140, minWidth: 115, maxWidth: 280 },
  { id: 'driver', defaultWidth: 120, minWidth: 105, maxWidth: 240 },
  { id: 'seller', defaultWidth: 120, minWidth: 105, maxWidth: 240 },
  { id: 'routeTotal', defaultWidth: 110, minWidth: 100, maxWidth: 180 },
  { id: 'settleableTotal', defaultWidth: 110, minWidth: 100, maxWidth: 180 },
  { id: 'cashExpected', defaultWidth: 110, minWidth: 100, maxWidth: 180 },
  { id: 'checkExpected', defaultWidth: 110, minWidth: 100, maxWidth: 180 },
  { id: 'cashReceived', defaultWidth: 110, minWidth: 100, maxWidth: 180 },
  { id: 'checkReceived', defaultWidth: 110, minWidth: 100, maxWidth: 180 },
  { id: 'cashDifference', defaultWidth: 110, minWidth: 100, maxWidth: 180 },
  { id: 'transferConfirmed', defaultWidth: 115, minWidth: 105, maxWidth: 190 },
  { id: 'transferPending', defaultWidth: 120, minWidth: 105, maxWidth: 200 },
  { id: 'settleableInvoices', defaultWidth: 105, minWidth: 95, maxWidth: 180 },
  { id: 'status', defaultWidth: 140, minWidth: 120, maxWidth: 220 },
  { id: 'actions', defaultWidth: 125, minWidth: 115, maxWidth: 190, sticky: 'right', resizable: false },
]

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
  const { widths, setColumnWidth, persist, reset: resetWidths } = useOperationalTableWidths(ROUTE_SETTLEMENTS_TABLE_KEY, ROUTE_SETTLEMENT_COLUMNS)

  // Ref para distinguir doble clic de clic simple
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const filteredData = useMemo(() => {
    return data.filter(row => {
       if (filterStatus !== 'ALL') {
         const isRendida = filterStatus === 'SETTLED' && (row.operational_status === 'SETTLED' || row.operational_status === 'CLOSED')
         if (!isRendida && row.operational_status !== filterStatus) return false
       }

       const countedAmount = row.total_cash_expected + row.total_check_expected
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

  function routeSettlementColumn(id: string) { return ROUTE_SETTLEMENT_COLUMNS.find(column => column.id === id)! }
  function resizeHandle(id: string) {
    const column = routeSettlementColumn(id)
    return <OperationalTableResizeHandle column={column} width={widths[id] ?? column.defaultWidth} onResize={width => setColumnWidth(column, width)} onResizeEnd={persist} />
  }

  if (isLoading && data.length === 0) {
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
    <div className="relative h-full min-h-0 min-w-0 flex flex-col overflow-hidden rounded-[18px] border border-theme-border bg-theme-surface shadow-sm">
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
           <button
             type="button"
             onClick={resetWidths}
             className="shrink-0 rounded-lg border border-theme-border px-2.5 py-1.5 text-[11px] font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
           >
             Restablecer anchos
           </button>
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

         {isLoading && <div role="status" aria-live="polite" className="pointer-events-none absolute left-1/2 top-16 z-50 inline-flex -translate-x-1/2 items-center rounded-full border border-theme-border bg-theme-surface/95 px-3 py-1.5 text-[11px] font-semibold text-theme-text-muted shadow-md">Actualizando...</div>}

         <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-contain">
           <table className="w-full min-w-[1840px] table-fixed text-left text-xs whitespace-nowrap">
             <colgroup>{ROUTE_SETTLEMENT_COLUMNS.map(column => <col key={column.id} style={{ width: widths[column.id] ?? column.defaultWidth }} />)}</colgroup>
             <thead className="sticky top-0 z-20 bg-theme-surface">
               <tr className="border-b border-theme-border/70 bg-theme-surface shadow-sm">
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 font-bold text-theme-text-muted">Guía{resizeHandle('guide')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 font-bold text-theme-text-muted">Rendición{resizeHandle('settlement')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 font-bold text-theme-text-muted">Fecha{resizeHandle('date')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 font-bold text-theme-text-muted">Ruta{resizeHandle('route')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 font-bold text-theme-text-muted">Conductor{resizeHandle('driver')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 font-bold text-theme-text-muted">Vendedor{resizeHandle('seller')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-right font-bold text-theme-text-muted">Total ruta{resizeHandle('routeTotal')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-right font-bold text-theme-text-muted">Total rendible{resizeHandle('settleableTotal')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-right font-bold text-theme-text-muted">Ef. esperado{resizeHandle('cashExpected')}</th>
                <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-right font-bold text-theme-text-muted">Cheque esp.{resizeHandle('checkExpected')}</th>
                 <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-right font-bold text-theme-text-muted">Ef. recibido{resizeHandle('cashReceived')}</th>
                 <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-right font-bold text-theme-text-muted">Cheque rec.{resizeHandle('checkReceived')}</th>
                 <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-right font-bold text-theme-text-muted">Dif. ef.{resizeHandle('cashDifference')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-right font-bold text-theme-text-muted">Transf. conf.{resizeHandle('transferConfirmed')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-center font-bold text-theme-text-muted">Transf. pend.{resizeHandle('transferPending')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-center font-bold text-theme-text-muted">Fact. rendibles{resizeHandle('settleableInvoices')}</th>
               <th className="relative border-r border-theme-border/30 px-3 py-2.5 text-center font-bold text-theme-text-muted">Estado{resizeHandle('status')}</th>
               <th className="sticky right-0 z-30 border-l border-theme-border bg-theme-surface px-3 py-2.5 text-center font-bold text-theme-text-muted">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/50">
            {filteredData.length === 0 ? (
              <tr>
                 <td colSpan={18} className="px-4 py-12 text-center text-theme-text-muted">
                  {data.length === 0
                    ? 'No hay guías despachadas disponibles para rendición.'
                    : 'No se encontraron resultados para los filtros seleccionados.'}
                </td>
              </tr>
            ) : (
              filteredData.map((item) => {
                const isSelected = selectedRowId === item.route_guide_id
                const totalRendible = item.total_cash_expected + item.total_check_expected
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
                     onDoubleClick={(event) => { if (!shouldIgnoreOperationalRowDoubleClick(event.target)) handleRowDoubleClick(item) }}
                    onKeyDown={handleKeyDown}
                    className={`
                      cursor-pointer transition-colors select-none outline-none
                      ${isSelected
                        ? 'bg-theme-accent/10 ring-1 ring-inset ring-theme-accent/30'
                        : 'hover:bg-theme-text/[0.03] focus:bg-theme-text/[0.04]'}
                    `}
                  >
                     <td className="truncate px-3 py-2.5 font-bold text-theme-text" title={item.guide_number || undefined}>{item.guide_number || '—'}</td>
                     <td className="truncate px-3 py-2.5 font-mono text-[11px] text-theme-text" title={item.settlement_number || undefined}>{item.settlement_number || '—'}</td>
                     <td className="truncate px-3 py-2.5 text-theme-text-muted" title={formatDate(item.guide_date ?? '')}>{formatDate(item.guide_date ?? '')}</td>
                     <td className="truncate px-3 py-2.5 text-theme-text" title={item.route_name || undefined}>{item.route_name || '—'}</td>
                     <td className="truncate px-3 py-2.5 text-theme-text" title={item.driver_name || undefined}>{item.driver_name || '—'}</td>
                     <td className="truncate px-3 py-2.5 text-theme-text" title={item.seller_name || undefined}>{item.seller_name || '—'}</td>
                     <td className="truncate px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text" title={formatCurrency(item.total_route_amount)}>{formatCurrency(item.total_route_amount)}</td>
                     <td className="truncate px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text" title={formatCurrency(totalRendible)}>{formatCurrency(totalRendible)}</td>
                      <td className="truncate px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text" title={formatCurrency(item.total_cash_expected)}>{formatCurrency(item.total_cash_expected)}</td>
                      <td className="truncate px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text" title={formatCurrency(item.total_check_expected)}>{formatCurrency(item.total_check_expected)}</td>
                      <td className="truncate px-3 py-2.5 text-right font-semibold tabular-nums text-green-600 dark:text-green-400" title={item.settlement_id ? formatCurrency(item.total_cash_received) : '—'}>
                       {item.settlement_id ? formatCurrency(item.total_cash_received) : '—'}
                     </td>
                      <td className="truncate px-3 py-2.5 text-right font-semibold tabular-nums text-green-600 dark:text-green-400" title={item.settlement_id ? formatCurrency(item.total_check_received) : '—'}>
                       {item.settlement_id ? formatCurrency(item.total_check_received) : '—'}
                     </td>
                     <td className="truncate px-3 py-2.5 text-right tabular-nums" title={item.settlement_id ? formatCurrency(item.total_cash_difference) : '—'}>
                      <span className={`font-bold ${item.total_cash_difference > 0 ? 'text-red-500' : 'text-theme-text-muted'}`}>
                        {item.settlement_id ? formatCurrency(item.total_cash_difference) : '—'}
                      </span>
                    </td>
                     <td className="truncate px-3 py-2.5 text-right font-semibold tabular-nums text-theme-text" title={item.settlement_id ? formatCurrency(item.total_transfer_confirmed) : '—'}>
                      {item.settlement_id ? formatCurrency(item.total_transfer_confirmed) : '—'}
                    </td>
                     <td className="truncate px-3 py-2.5 text-center tabular-nums">
                      <span className={`px-2 py-0.5 rounded-md font-medium ${item.total_transfer_pending > 0 ? 'bg-orange-500/10 text-orange-600' : 'bg-theme-text/5 text-theme-text'}`}>
                        {item.total_transfer_pending > 0 ? formatCurrency(item.total_transfer_pending) : '0'}
                      </span>
                    </td>
                     <td className="truncate px-3 py-2.5 text-center tabular-nums">
                      <span className="px-2 py-0.5 rounded-md bg-theme-text/5 text-theme-text font-medium">
                        {item.settlement_id ? `${item.paid_count} / ${item.total_rendible_count}` : `0 / ${item.total_rendible_count}`}
                      </span>
                    </td>
                     <td className="truncate px-3 py-2.5 text-center">
                      <SettlementStatusBadge status={item.operational_status} />
                    </td>
                     <td className="sticky right-0 z-10 bg-theme-surface px-3 py-2.5 text-center">
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
