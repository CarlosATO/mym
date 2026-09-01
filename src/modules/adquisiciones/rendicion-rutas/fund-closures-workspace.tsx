'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { getPendingRouteFundGroups, getFundClosures, getFundClosureById, executeCloseFundClosure, addClosureExpense, addClosureDeposit, getAttachmentSignedUrl, canCancelFundClosure, cancelFundClosure } from '@/app/actions/adquisiciones/route-fund-closures'
import { PendingRouteFundGroup, RouteFundClosure } from './fund-closures-types'
import { CreateFundClosureDialog } from './components/create-fund-closure-dialog'
import { FundClosureDeposits } from './components/fund-closure-deposits'
import { RefreshCw, Plus, AlertTriangle, FileText, Wallet, Eye, Download, Paperclip, Search, ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { toast } from 'sonner'
import { formatCivilDate, formatInstantInSantiago, todayInSantiago } from '@/lib/datetime'
import { sortOperationalRows, type OperationalTableColumn, type OperationalTableSort, type OperationalTableSortDirection } from '@/components/ui/operational-table'

const PENDING_FUNDS_TABLE_COLUMNS: OperationalTableColumn[] = [
  { id: 'origin', defaultWidth: 180, minWidth: 140, sortable: true, sortKey: 'settlement_number', sortType: 'text' },
  { id: 'guide', defaultWidth: 145, minWidth: 120, sortable: true, sortKey: 'guide_number', sortType: 'text' },
  { id: 'date', defaultWidth: 145, minWidth: 125, sortable: true, sortKey: 'closed_at', sortType: 'date' },
  { id: 'custodian', defaultWidth: 170, minWidth: 140, sortable: true, sortKey: 'custody_name', sortType: 'text' },
  { id: 'cashReceived', defaultWidth: 145, minWidth: 125, sortable: true, sortKey: 'cash_received', sortType: 'number' },
  { id: 'expenses', defaultWidth: 120, minWidth: 110, sortable: true, sortKey: 'active_route_expenses', sortType: 'number' },
  { id: 'netCash', defaultWidth: 155, minWidth: 135, sortable: true, sortKey: 'net_cash_pending', sortType: 'number' },
  { id: 'checks', defaultWidth: 110, minWidth: 100, sortable: true, sortKey: 'checks_received', sortType: 'number' },
]

function sortIndicator(active: boolean, direction?: OperationalTableSortDirection) {
  if (!active) return <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 text-theme-text-muted/40" />
  return direction === 'asc'
    ? <ChevronUp aria-label="Orden ascendente" className="h-3.5 w-3.5 text-theme-accent" />
    : <ChevronDown aria-label="Orden descendente" className="h-3.5 w-3.5 text-theme-accent" />
}

function formatPendingAmount(value: number) {
  return `$${Number(value || 0).toLocaleString('es-CL')}`
}

type PhysicalClosureData = Pick<RouteFundClosure, 'total_cash_received' | 'total_expenses'> & {
  cash_delivered?: number | null
  physical_difference?: number | null
}

function physicalClosureBalance(closure: PhysicalClosureData) {
  const expected = Number(closure.total_cash_received || 0) - Number(closure.total_expenses || 0)
  const delivered = Number(closure.cash_delivered || 0)
  const difference = Number(closure.physical_difference ?? delivered - expected)
  return { expected, delivered, difference, pending: expected - delivered }
}

function physicalDifferenceLabel(difference: number) {
  if (difference === 0) return `Cuadrado ${formatPendingAmount(0)}`
  return `${difference < 0 ? 'Faltante' : 'Sobrante'} ${formatPendingAmount(Math.abs(difference))}`
}

function physicalPendingLabel(balance: ReturnType<typeof physicalClosureBalance>) {
  if (balance.difference === 0) return formatPendingAmount(0)
  return `${balance.difference < 0 ? 'Faltante' : 'Sobrante'} ${formatPendingAmount(Math.abs(balance.pending))}`
}

function pendingGroupKey(group: PendingRouteFundGroup) {
  return `${group.route_settlement_id}:${group.custody_user_id}`
}

function PendingTotal({ label, value, emphasized = false }: { label: string; value: number; emphasized?: boolean }) {
  return <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className={`mt-1 tabular-nums ${emphasized ? 'font-bold text-theme-text' : 'font-semibold text-theme-text'}`}>{formatPendingAmount(value)}</p></div>
}

export function FundClosuresWorkspace() {
  const [activeTab, setActiveTab] = useState<'PENDING' | 'HISTORY'>('PENDING')
  
  // Pending view state
  const [pendingFunds, setPendingFunds] = useState<PendingRouteFundGroup[]>([])
  const [selectedPendingIds, setSelectedPendingIds] = useState<Set<string>>(new Set())
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [preparedSelection, setPreparedSelection] = useState<PendingRouteFundGroup[] | null>(null)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isLoadingPending, setIsLoadingPending] = useState(false)
  const [pendingSort, setPendingSort] = useState<OperationalTableSort | null>(null)
  
  // History view state
  const [closures, setClosures] = useState<any[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [filters, setFilters] = useState({ search: '', dateFrom: '', dateTo: '', status: '' })
  
  // Detail view state
  const [selectedClosureId, setSelectedClosureId] = useState<string | null>(null)
  
  const [hasCancelPermission, setHasCancelPermission] = useState(false)
  
  useEffect(() => {
    canCancelFundClosure().then(setHasCancelPermission)
  }, [])
  
  const loadPendingFunds = async () => {
    setIsLoadingPending(true)
    try {
      const data = await getPendingRouteFundGroups()
      setPendingFunds(data)
      setSelectedPendingIds(new Set())
      setSelectionError(null)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setIsLoadingPending(false)
    }
  }

  const loadHistory = async () => {
    setIsLoadingHistory(true)
    try {
      const data = await getFundClosures(filters)
      setClosures(data)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setIsLoadingHistory(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'PENDING') loadPendingFunds()
    else if (activeTab === 'HISTORY') loadHistory()
  }, [activeTab, filters.dateFrom, filters.dateTo, filters.status])

  const refreshAfterClosureMutation = async () => {
    await Promise.all([loadHistory(), loadPendingFunds()])
  }

  const togglePendingSelection = (id: string) => {
    const next = new Set(selectedPendingIds)
    if (next.has(id)) {
      next.delete(id)
      setSelectionError(null)
    } else {
      const group = pendingFunds.find(fund => pendingGroupKey(fund) === id)
      const selectedCustody = pendingFunds.find(fund => next.has(pendingGroupKey(fund)))?.custody_user_id
      if (group && selectedCustody && group.custody_user_id !== selectedCustody) {
        setSelectionError('No puedes agrupar Rendiciones de custodios diferentes en un mismo cierre.')
        return
      }
      next.add(id)
      setSelectionError(null)
    }
    setSelectedPendingIds(next)
  }

  const handlePrepareClosure = () => {
    if (selectedPendingIds.size === 0) return
    setPreparedSelection(pendingFunds.filter(fund => selectedPendingIds.has(pendingGroupKey(fund))))
    setIsCreateDialogOpen(true)
  }

  const selectedFunds = pendingFunds.filter(fund => selectedPendingIds.has(pendingGroupKey(fund)))
  const sortedPendingFunds = useMemo(
    () => sortOperationalRows(pendingFunds, pendingSort, PENDING_FUNDS_TABLE_COLUMNS, (row, sortKey) => row[sortKey as keyof PendingRouteFundGroup]),
    [pendingFunds, pendingSort],
  )

  const cyclePendingSort = (column: OperationalTableColumn) => {
    if (!column.sortKey) return
    setPendingSort(current => current?.column !== column.id
      ? { column: column.id, direction: 'asc' }
      : current.direction === 'asc'
        ? { column: column.id, direction: 'desc' }
        : null)
  }
  const selectedTotals = selectedFunds.reduce((totals, fund) => ({
    cashReceived: totals.cashReceived + Number(fund.cash_received || 0),
    expenses: totals.expenses + Number(fund.active_route_expenses || 0),
    netCash: totals.netCash + Number(fund.net_cash_pending || 0),
    checks: totals.checks + Number(fund.checks_received || 0),
  }), { cashReceived: 0, expenses: 0, netCash: 0, checks: 0 })

  const handleSelectAll = (checked: boolean) => {
    if (!checked) {
      setSelectedPendingIds(new Set())
      setSelectionError(null)
      return
    }
    const custodyIds = new Set(pendingFunds.map(fund => fund.custody_user_id))
    if (custodyIds.size > 1) {
      setSelectionError('No puedes seleccionar todas: las Rendiciones pertenecen a custodios diferentes.')
      return
    }
    setSelectedPendingIds(new Set(pendingFunds.map(pendingGroupKey)))
    setSelectionError(null)
  }

  if (selectedClosureId) {
    return <FundClosureDetail
      closureId={selectedClosureId}
      onBack={() => setSelectedClosureId(null)}
      onCancelled={async () => {
        await refreshAfterClosureMutation()
        setSelectedClosureId(null)
        setActiveTab('HISTORY')
      }}
    />
  }

  return (
    <div className="flex flex-col h-full bg-theme-surface">
      <div className="flex items-center gap-2 border-b border-theme-border px-4 py-2">
        <button
          onClick={() => setActiveTab('PENDING')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${activeTab === 'PENDING' ? 'border-theme-accent text-theme-text' : 'border-transparent text-theme-text-muted hover:text-theme-text'}`}
        >
          Fondos Pendientes
        </button>
        <button
          onClick={() => setActiveTab('HISTORY')}
          className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${activeTab === 'HISTORY' ? 'border-theme-accent text-theme-text' : 'border-transparent text-theme-text-muted hover:text-theme-text'}`}
        >
          Historial de Cierres
        </button>
      </div>

       <div className="flex-1 overflow-auto p-3">
        {activeTab === 'PENDING' ? (
          <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <h3 className="text-lg font-bold text-theme-text">Fondos recibidos por rendir</h3>
                <div className="flex items-center gap-2">
                <button onClick={loadPendingFunds} disabled={isLoadingPending} className="p-2 border border-theme-border rounded-md hover:bg-theme-text/5 text-theme-text">
                  <RefreshCw className={`w-4 h-4 ${isLoadingPending ? 'animate-spin' : ''}`} />
                </button>
                <button 
                  onClick={handlePrepareClosure}
                  disabled={selectedPendingIds.size === 0}
                  className="px-4 py-2 bg-theme-accent text-white font-bold text-sm rounded-lg hover:bg-theme-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Crear cierre ({selectedPendingIds.size})
                </button>
              </div>
            </div>

            {selectionError && <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{selectionError}</div>}

            {selectedPendingIds.size > 0 && (
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-theme-border bg-theme-surface px-3 py-3 sm:grid-cols-5">
                <PendingTotal label="Efectivo recibido" value={selectedTotals.cashReceived} />
                <PendingTotal label="Gastos" value={selectedTotals.expenses} />
                <PendingTotal label="Efectivo a entregar" value={selectedTotals.netCash} emphasized />
                <PendingTotal label="Cheques" value={selectedTotals.checks} />
                 <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Origen de fondos</p><p className="mt-1 font-bold tabular-nums text-theme-text">Rendiciones: {selectedFunds.reduce((sum, fund) => sum + fund.payment_ids.length, 0)} · Cobros posteriores: {selectedFunds.reduce((sum, fund) => sum + (fund.post_settlement_payment_ids?.length ?? 0), 0)}</p></div>
              </div>
            )}

             <div className="bg-theme-surface border border-theme-border rounded-xl overflow-hidden">
               <table className="w-full text-left text-sm text-theme-text">
                 <thead className="bg-theme-text/5 border-b border-theme-border text-theme-text-muted">
                  <tr>
                    <th className="px-3 py-2 w-10">
                      <input type="checkbox" checked={selectedPendingIds.size === pendingFunds.length && pendingFunds.length > 0} onChange={(e) => handleSelectAll(e.target.checked)} aria-label="Seleccionar Rendiciones" />
                    </th>
                    {PENDING_FUNDS_TABLE_COLUMNS.map(column => {
                      const active = pendingSort?.column === column.id
                      const label = column.id === 'origin' ? 'Origen' : column.id === 'guide' ? 'Guía' : column.id === 'date' ? 'Fecha' : column.id === 'custodian' ? 'Custodio' : column.id === 'cashReceived' ? 'Efectivo recibido' : column.id === 'expenses' ? 'Gastos' : column.id === 'netCash' ? 'Efectivo a entregar' : 'Cheques'
                      return <th key={column.id} className={`px-3 py-2 font-semibold ${['cashReceived', 'expenses', 'netCash', 'checks'].includes(column.id) ? 'text-right' : ''}`}>
                        <button type="button" onClick={() => cyclePendingSort(column)} className={`group inline-flex w-full items-center gap-1 ${['cashReceived', 'expenses', 'netCash', 'checks'].includes(column.id) ? 'justify-end' : 'justify-start'}`} aria-label={`Ordenar por ${label}`} title={`Ordenar por ${label}`}>
                          <span>{label}</span>{sortIndicator(active, active ? pendingSort?.direction : undefined)}
                        </button>
                      </th>
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border">
                  {pendingFunds.length === 0 ? (
                    <tr>
                       <td colSpan={9} className="p-8 text-center text-theme-text-muted">No hay fondos pendientes por rendir.</td>
                    </tr>
                   ) : sortedPendingFunds.map(fund => {
                    const isCarryForward = fund.pending_origin_status === 'CARRY_FORWARD'
                    const rowTone = isCarryForward
                      ? 'bg-amber-50 hover:bg-amber-100 dark:bg-amber-950 dark:hover:bg-amber-900'
                      : 'bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950 dark:hover:bg-emerald-900'
                    const selectedTone = isCarryForward ? 'bg-amber-100 dark:bg-amber-950' : 'bg-emerald-100 dark:bg-emerald-950'
                    return <tr key={pendingGroupKey(fund)} className={`transition-colors ${selectedPendingIds.has(pendingGroupKey(fund)) ? `${selectedTone} ring-1 ring-inset ring-theme-accent/30` : rowTone}`}>
                       <td className="px-3 py-1.5">
                         <input type="checkbox" checked={selectedPendingIds.has(pendingGroupKey(fund))} onChange={() => togglePendingSelection(pendingGroupKey(fund))} aria-label={`Seleccionar ${fund.settlement_number}`} className="h-3.5 w-3.5" />
                       </td>
                        <td className="px-3 py-1.5 font-semibold"><div className="flex flex-wrap gap-0.5">{fund.payment_ids.length > 0 && <span className="rounded bg-theme-text/10 px-1 py-0.5 text-[9px] font-bold text-theme-text">Rendición</span>}{(fund.post_settlement_payment_ids?.length ?? 0) > 0 && <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[9px] font-bold text-violet-700 dark:text-violet-300">Cobro posterior</span>}</div><span className="mt-0.5 block">{fund.settlement_number}</span></td>
                       <td className="px-3 py-1.5 font-semibold">{fund.guide_number}</td>
                       <td className="px-3 py-1.5 whitespace-nowrap text-theme-text-muted">{formatInstantInSantiago(fund.closed_at)}</td>
                       <td className="px-3 py-1.5 text-theme-text-muted">{fund.custody_name ?? fund.custody_user_id}</td>
                       <td className="px-3 py-1.5 text-right font-mono font-bold">{formatPendingAmount(fund.cash_received)}</td>
                       <td className="px-3 py-1.5 text-right font-mono">{formatPendingAmount(fund.active_route_expenses)}</td>
                       <td className="px-3 py-1.5 text-right font-mono font-bold text-theme-text">{formatPendingAmount(fund.net_cash_pending)}</td>
                       <td className="px-3 py-1.5 text-right font-mono">{formatPendingAmount(fund.checks_received)}</td>
                     </tr>
                   })}
                </tbody>
              </table>
            </div>

            {preparedSelection && (
              <div className="rounded-xl border border-theme-accent/40 bg-theme-accent/5 px-4 py-3 text-sm text-theme-text">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold">Selección preparada para crear cierre</p>
                    <p className="mt-1 text-xs text-theme-text-muted">{preparedSelection.length} Rendición{preparedSelection.length === 1 ? '' : 'es'} del custodio {preparedSelection[0]?.custody_name ?? preparedSelection[0]?.custody_user_id}. No se ha creado ningún Cierre de Fondos.</p>
                  </div>
                  <button type="button" onClick={() => setPreparedSelection(null)} className="text-xs font-semibold text-theme-text-muted hover:text-theme-text">Cerrar</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
             <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-theme-text shrink-0">Historial de Cierres</h3>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2 bg-theme-surface border border-theme-border rounded-lg px-2 py-1.5">
                  <Search className="w-4 h-4 text-theme-text-muted" />
                  <input type="text" placeholder="Buscar CFC..." className="bg-transparent border-none text-sm outline-none w-32 md:w-40 text-theme-text" value={filters.search} onChange={e => setFilters({...filters, search: e.target.value})} onKeyDown={e => e.key === 'Enter' && loadHistory()} />
                </div>
                <input type="date" className="bg-theme-surface border border-theme-border rounded-lg px-2 py-1.5 text-sm outline-none text-theme-text" value={filters.dateFrom} onChange={e => setFilters({...filters, dateFrom: e.target.value})} />
                <input type="date" className="bg-theme-surface border border-theme-border rounded-lg px-2 py-1.5 text-sm outline-none text-theme-text" value={filters.dateTo} onChange={e => setFilters({...filters, dateTo: e.target.value})} />
                <select className="bg-theme-surface border border-theme-border rounded-lg px-2 py-1.5 text-sm outline-none text-theme-text" value={filters.status} onChange={e => setFilters({...filters, status: e.target.value})}>
                  <option value="">Todos los estados</option>
                  <option value="OPEN">Abierto</option>
                  <option value="CLOSED">Cerrado</option>
                  <option value="WITH_DIFFERENCE">Con Diferencia</option>
                  <option value="CANCELLED">Anulado</option>
                </select>
                {hasCancelPermission && (
                  <div className="flex items-center gap-2 bg-theme-surface border border-theme-border rounded-lg px-2 py-1.5">
                    <Search className="w-4 h-4 text-theme-text-muted" />
                    <input type="text" placeholder="ID Custodio..." className="bg-transparent border-none text-sm outline-none w-32 text-theme-text" value={(filters as any).custody_user_id || ''} onChange={e => setFilters({...filters, custody_user_id: e.target.value} as any)} onKeyDown={e => e.key === 'Enter' && loadHistory()} />
                  </div>
                )}
                <button onClick={loadHistory} disabled={isLoadingHistory} className="p-2 border border-theme-border rounded-lg hover:bg-theme-text/5 text-theme-text transition-colors" title="Actualizar">
                  <RefreshCw className={`w-4 h-4 ${isLoadingHistory ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>
            
            <div className="border border-theme-border rounded-xl bg-theme-surface overflow-x-auto hide-scrollbar">
              <table className="w-full text-left text-sm text-theme-text min-w-[1000px]">
                <thead className="bg-theme-text/5 border-b border-theme-border whitespace-nowrap">
                  <tr>
                    <th className="p-3">Nº Cierre</th>
                    <th className="p-3">Fecha</th>
                     <th className="p-3">Estado</th>
                     <th className="p-3 text-center">Guías</th>
                     <th className="p-3 text-center">Cobros</th>
                     <th className="p-3 text-center">Facturas</th>
                    <th className="p-3 text-right">Efectivo</th>
                    <th className="p-3 text-right">Cheques</th>
                    <th className="p-3 text-right">Gastos</th>
                    <th className="p-3 text-right">Depósitos</th>
                    <th className="p-3 text-right">Saldo Pdte</th>
                     <th className="p-3 text-center">Custodio</th>
                    <th className="p-3 text-center">Adjuntos</th>
                    <th className="p-3 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border">
                  {closures.length === 0 ? (
                    <tr><td colSpan={13} className="p-8 text-center text-theme-text-muted">No se encontraron cierres con los filtros aplicados.</td></tr>
                  ) : closures.map(closure => {
                    const physicalBalance = physicalClosureBalance(closure);
                    const uniqueGuides = [...new Set((closure.items || []).map((i:any) => i.guide_number).filter(Boolean))];
                     const uniqueInvoices = [...new Set((closure.items || []).map((i:any) => i.invoice_number).filter(Boolean))];
                    
                    const guideText = uniqueGuides.length > 0 
                      ? (uniqueGuides.length <= 2 ? uniqueGuides.join(', ') : `${uniqueGuides.length} guías`) 
                      : '---';
                      
                    const invoiceText = uniqueInvoices.length > 0
                      ? (uniqueInvoices.length <= 2 ? uniqueInvoices.join(', ') : `${uniqueInvoices.length} facturas`)
                      : '---';
                      
                    const attachCount = Array.isArray(closure.attachments) ? closure.attachments.length : 0;
                    return (
                    <tr key={closure.id} className="hover:bg-theme-text/5 transition-colors">
                      <td className="p-3 font-bold text-theme-text whitespace-nowrap">{closure.closure_number}</td>
                      <td className="p-3 whitespace-nowrap text-theme-text-muted">{formatInstantInSantiago(closure.created_at, { year: 'numeric', month: '2-digit', day: '2-digit' })}</td>
                      <td className="p-3 whitespace-nowrap">
                        <span className={`px-2 py-1 text-[11px] font-bold rounded ${closure.status === 'CLOSED' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : closure.status === 'WITH_DIFFERENCE' ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400' : closure.status === 'CANCELLED' ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'}`}>{closure.status}</span>
                      </td>
                      <td className="p-3 text-center font-mono text-xs text-theme-text" title={uniqueGuides.join(', ')}>{guideText}</td>
                      <td className="p-3 text-center font-mono text-xs text-theme-text">{closure.payment_count ?? new Set((closure.items || []).map((item: any) => item.payment_id).filter(Boolean)).size}</td>
                      <td className="p-3 text-center font-mono text-xs text-theme-text" title={uniqueInvoices.join(', ')}>{closure.invoice_count ?? invoiceText}</td>
                      <td className="p-3 text-right font-mono text-theme-text">${Number(closure.total_cash_received).toLocaleString('es-CL')}</td>
                      <td className="p-3 text-right font-mono text-theme-text">${Number(closure.total_check_received).toLocaleString('es-CL')}</td>
                      <td className="p-3 text-right font-mono text-red-600 dark:text-red-400">${Number(closure.total_expenses).toLocaleString('es-CL')}</td>
                      <td className="p-3 text-right font-mono text-emerald-600 dark:text-emerald-400">${Number(closure.total_deposits).toLocaleString('es-CL')}</td>
                      <td className={`p-3 text-right font-mono font-bold ${physicalBalance.difference === 0 ? 'text-theme-text' : 'text-orange-500'}`}>{physicalPendingLabel(physicalBalance)}</td>
                       <td className="p-3 text-center text-xs text-theme-text-muted">
                         {closure.custody_user ? `${closure.custody_user.nombre || ''} ${closure.custody_user.apellido || ''}`.trim() : '---'}
                       </td>
                      <td className="p-3 text-center">
                        {attachCount > 0 ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-theme-text/10 text-theme-text text-xs font-bold font-mono"><Paperclip className="w-3 h-3" /> {attachCount}</span>
                        ) : <span className="text-theme-text-muted text-xs">-</span>}
                      </td>
                      <td className="p-3 text-center flex items-center justify-center gap-2">
                        <button onClick={() => setSelectedClosureId(closure.id)} className="px-3 py-1.5 bg-theme-text/10 hover:bg-theme-text/20 rounded-lg text-xs font-bold transition-colors text-theme-text whitespace-nowrap">
                          Ver Detalle
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      {isCreateDialogOpen && preparedSelection && (
        <CreateFundClosureDialog
          groups={preparedSelection}
          onClose={() => setIsCreateDialogOpen(false)}
          onCreated={() => {
            setIsCreateDialogOpen(false)
            setPreparedSelection(null)
            setSelectedPendingIds(new Set())
            loadPendingFunds()
          }}
          onPartialFailure={(closureId, message) => {
            setIsCreateDialogOpen(false)
            setPreparedSelection(null)
            setSelectedPendingIds(new Set())
            toast.error(message)
            setSelectedClosureId(closureId)
            loadPendingFunds()
          }}
        />
      )}
    </div>
  )
}

function FundClosureDetail({ closureId, onBack, onCancelled }: { closureId: string; onBack: () => void; onCancelled: () => Promise<void> }) {
  const [data, setData] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasCancelPermission, setHasCancelPermission] = useState(false)
  
  useEffect(() => {
    canCancelFundClosure().then(setHasCancelPermission)
  }, [])

  const load = async () => {
    try {
      setIsLoading(true)
      const res = await getFundClosureById(closureId)
      setData(res)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [closureId])

  const [viewerState, setViewerState] = useState<{isOpen: boolean, url: string | null, type: string, name: string}>({isOpen: false, url: null, type: '', name: ''})

  const handleOpenAttachment = async (attach: any) => {
    try {
      toast.loading("Generando enlace seguro...", { id: 'attach' })
      const url = await getAttachmentSignedUrl(attach.storage_path)
      setViewerState({ isOpen: true, url, type: attach.file_mime_type || '', name: attach.file_name || 'Documento' })
      toast.success("Documento cargado", { id: 'attach' })
    } catch(err:any) {
      toast.error(err.message, { id: 'attach' })
    }
  }

  const handleClose = async () => {
    try {
      await executeCloseFundClosure(closureId)
      toast.success("Cierre completado")
      load()
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')

  const handleCancelClosure = async () => {
    if (!cancelReason || cancelReason.trim().length < 5) {
      toast.error("Debe proporcionar un motivo válido (mínimo 5 caracteres)")
      return
    }
    try {
      setIsSubmitting(true)
      toast.loading("Anulando cierre...", { id: 'cancel' })
      await cancelFundClosure(closureId, cancelReason)
      toast.success("Cierre anulado con éxito", { id: 'cancel' })
      setIsCancelModalOpen(false)
      await onCancelled()
    } catch (err: any) {
      toast.error(err.message, { id: 'cancel' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false)
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleExpenseSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const routeGuideId = data.items[0]?.route_guide_id
    if (!routeGuideId) return alert("No hay guía asociada para aplicar gasto")
    
    setIsSubmitting(true)
    const formData = new FormData(e.currentTarget)
    formData.append('route_guide_id', routeGuideId)
    formData.append('expense_scope', 'GUIDE')
    
    try {
      toast.loading("Guardando gasto...", { id: 'expense' })
      await addClosureExpense(closureId, formData)
      toast.success("Gasto agregado", { id: 'expense' })
      setIsExpenseModalOpen(false)
      load()
    } catch(err:any){
      toast.error(err.message, { id: 'expense' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDepositSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsSubmitting(true)
    const formData = new FormData(e.currentTarget)
    
    try {
      toast.loading("Guardando depósito...", { id: 'deposit' })
      await addClosureDeposit(closureId, formData)
      toast.success("Depósito agregado", { id: 'deposit' })
      setIsDepositModalOpen(false)
      load()
    } catch(err:any){
      toast.error(err.message, { id: 'deposit' })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isLoading) return <div className="p-8">Cargando...</div>
  if (!data) return <div className="p-8">Error cargando datos.</div>

  const closure = data.closure
  const isClosed = closure.status === 'CLOSED' || closure.status === 'WITH_DIFFERENCE' || closure.status === 'CANCELLED'
  const isFinalized = closure.status === 'CLOSED' || closure.status === 'WITH_DIFFERENCE'
  const physicalBalance = physicalClosureBalance(closure)
  const paymentRows = data.items.map((item: any) => {
    const allocations = Array.isArray(item.allocations) && item.allocations.length > 0
      ? item.allocations
      : [{ invoice_number: item.invoice_number, customer_name: item.customer_name }]
    return {
      ...item,
      allocations,
      customers: [...new Set(allocations.map((allocation: any) => allocation.customer_name).filter(Boolean))],
      invoiceNumbers: [...new Set(allocations.map((allocation: any) => allocation.invoice_number).filter(Boolean))],
    }
  })

  return (
    <div className="flex flex-col h-full bg-theme-surface">
      <div className="flex flex-col md:flex-row md:items-center gap-4 border-b border-theme-border px-4 py-3 relative">
        <button onClick={onBack} className="text-sm font-bold text-theme-text-muted hover:text-theme-text">← Volver</button>
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-xl font-bold text-theme-text">Cierre {closure.closure_number}</h2>
            <p className="text-xs text-theme-text-muted">Custodio: {closure.custody_user ? `${closure.custody_user.nombre || ''} ${closure.custody_user.apellido || ''}`.trim() : 'No disponible'}</p>
          </div>
          <span className={`px-2 py-0.5 text-xs font-bold rounded ${closure.status === 'CLOSED' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : closure.status === 'WITH_DIFFERENCE' ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400' : closure.status === 'CANCELLED' ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'}`}>{closure.status}</span>
        </div>
        
        <div className="ml-auto flex flex-wrap gap-2">
          {!isClosed ? (
            <>
              <button onClick={() => setIsExpenseModalOpen(true)} className="px-3 py-1.5 border border-theme-border rounded-lg text-sm font-bold text-theme-text hover:bg-theme-text/5">
                + Gasto
              </button>
              <button onClick={() => setIsDepositModalOpen(true)} className="px-3 py-1.5 border border-theme-border rounded-lg text-sm font-bold text-theme-text hover:bg-theme-text/5">
                + Depósito
              </button>
              <button onClick={onBack} className="px-4 py-1.5 border border-theme-border rounded-lg text-sm font-bold text-theme-text hover:bg-theme-text/5" title="Guarda los cambios temporalmente sin cerrar la rendición">
                Guardar y Salir
              </button>
              <button onClick={handleClose} className="px-4 py-1.5 bg-emerald-500 text-white rounded-lg text-sm font-bold hover:bg-emerald-600">
                Finalizar Cierre
              </button>
            </>
          ) : (
            <span className="px-3 py-1.5 text-sm font-bold text-theme-text-muted bg-theme-text/5 rounded-lg border border-theme-border">Modo Lectura (Cierre Finalizado)</span>
          )}
          {hasCancelPermission && closure.status !== 'CANCELLED' && (
             <button onClick={() => setIsCancelModalOpen(true)} className="px-4 py-1.5 border border-red-500 text-red-500 rounded-lg text-sm font-bold hover:bg-red-500 hover:text-white transition-colors ml-2 flex items-center gap-2">
               Anular
             </button>
          )}
        </div>
      </div>

      {isCancelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-theme-surface w-full max-w-md rounded-xl shadow-2xl border border-theme-border flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-red-500/30 flex justify-between items-center bg-red-500/10">
              <h3 className="font-bold text-red-600 dark:text-red-400">Anular Cierre de Fondos</h3>
              <button onClick={() => setIsCancelModalOpen(false)} className="text-red-600/70 hover:text-red-600">✕</button>
            </div>
            <div className="p-5 flex flex-col gap-4">
              <p className="text-sm text-theme-text">Esta acción marcará el cierre como anulado y liberará todos sus fondos y facturas asociadas a la bandeja de rendición original del custodio. Esta acción <strong>no</strong> se puede deshacer.</p>
              <div>
                <label className="block text-xs font-bold text-theme-text-muted mb-1">Motivo de la Anulación (Obligatorio)</label>
                <textarea 
                  value={cancelReason} 
                  onChange={(e) => setCancelReason(e.target.value)} 
                  rows={3} 
                  className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text focus:border-red-500 focus:outline-none" 
                  placeholder="Explique detalladamente por qué se anula este cierre..."
                ></textarea>
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <button type="button" onClick={() => setIsCancelModalOpen(false)} className="px-4 py-2 text-sm font-bold border border-theme-border rounded-lg text-theme-text hover:bg-theme-text/5">Cancelar</button>
                <button type="button" onClick={handleCancelClosure} disabled={isSubmitting || cancelReason.trim().length < 5} className="px-4 py-2 text-sm font-bold bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50">Confirmar Anulación</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isExpenseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-theme-surface w-full max-w-md rounded-xl shadow-2xl border border-theme-border flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-theme-border flex justify-between items-center bg-theme-text/5">
              <h3 className="font-bold text-theme-text">Agregar Gasto</h3>
              <button onClick={() => setIsExpenseModalOpen(false)} className="text-theme-text-muted hover:text-theme-text">✕</button>
            </div>
            <form onSubmit={handleExpenseSubmit} className="p-5 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-theme-text-muted mb-1">Tipo de Gasto</label>
                <select name="expense_type" required className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text">
                  <option value="">Seleccione...</option>
                  <option value="PEAJES">Peajes</option>
                  <option value="COMBUSTIBLE">Combustible</option>
                  <option value="VIATICOS">Viáticos</option>
                  <option value="MANTENIMIENTO">Mantenimiento</option>
                  <option value="OTROS">Otros</option>
                </select>
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-theme-text-muted mb-1">Monto ($)</label>
                  <input type="number" name="amount" min="1" required className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" placeholder="0" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-bold text-theme-text-muted mb-1">Fecha</label>
                  <input type="date" name="expense_date" required defaultValue={todayInSantiago()} className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-theme-text-muted mb-1">Adjunto (Opcional)</label>
                <input type="file" name="file" accept="image/*,.pdf" className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text file:mr-4 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-theme-text/10 file:text-theme-text hover:file:bg-theme-text/20" />
              </div>
              <div>
                <label className="block text-xs font-bold text-theme-text-muted mb-1">Observación</label>
                <textarea name="notes" rows={2} className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" placeholder="Detalles opcionales..."></textarea>
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <button type="button" onClick={() => setIsExpenseModalOpen(false)} className="px-4 py-2 text-sm font-bold border border-theme-border rounded-lg text-theme-text hover:bg-theme-text/5">Cancelar</button>
                <button type="submit" disabled={isSubmitting} className="px-4 py-2 text-sm font-bold bg-theme-accent text-white rounded-lg hover:bg-theme-accent-hover disabled:opacity-50">Guardar Gasto</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isDepositModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-theme-surface w-full max-w-md rounded-xl shadow-2xl border border-theme-border flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-theme-border flex justify-between items-center bg-theme-text/5">
              <h3 className="font-bold text-theme-text">Registrar Depósito o Entrega</h3>
              <button onClick={() => setIsDepositModalOpen(false)} className="text-theme-text-muted hover:text-theme-text">✕</button>
            </div>
            <form onSubmit={handleDepositSubmit} className="p-5 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-theme-text-muted mb-1">Método</label>
                <select name="deposit_method" required className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text">
                  <option value="DEPOSIT">Depósito Bancario</option>
                  <option value="CASH_DELIVERY">Entrega de Efectivo (Caja)</option>
                  <option value="TRANSFER">Transferencia</option>
                  <option value="OTHER">Otro</option>
                </select>
              </div>
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-xs font-bold text-theme-text-muted mb-1">Monto ($)</label>
                  <input type="number" name="amount" min="1" required className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" placeholder="0" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-bold text-theme-text-muted mb-1">Fecha</label>
                  <input type="date" name="deposit_date" required defaultValue={todayInSantiago()} className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-theme-text-muted mb-1">Nº Referencia (Opcional)</label>
                <input type="text" name="reference_number" className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" placeholder="Ej: 12345678" />
              </div>
              <div>
                <label className="block text-xs font-bold text-theme-text-muted mb-1">Comprobante (Opcional)</label>
                <input type="file" name="file" accept="image/*,.pdf" className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text file:mr-4 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-theme-text/10 file:text-theme-text hover:file:bg-theme-text/20" />
              </div>
              <div>
                <label className="block text-xs font-bold text-theme-text-muted mb-1">Observación</label>
                <textarea name="notes" rows={2} className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" placeholder="Detalles opcionales..."></textarea>
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <button type="button" onClick={() => setIsDepositModalOpen(false)} className="px-4 py-2 text-sm font-bold border border-theme-border rounded-lg text-theme-text hover:bg-theme-text/5">Cancelar</button>
                <button type="submit" disabled={isSubmitting} className="px-4 py-2 text-sm font-bold bg-theme-accent text-white rounded-lg hover:bg-theme-accent-hover disabled:opacity-50">Guardar Depósito</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isFinalized && <div className="mb-4"><FundClosureDeposits closureId={closureId} /></div>}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Columna Izquierda: Fondos */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h3 className="font-bold text-theme-text flex items-center gap-2">
              <Wallet className="w-5 h-5 text-theme-accent" /> Fondos Incluidos
            </h3>
            <div className="border border-theme-border rounded-xl bg-theme-surface overflow-hidden">
              <table className="w-full text-left text-sm text-theme-text">
                <thead className="bg-theme-text/5 border-b border-theme-border">
                  <tr>
                     <th className="p-3">Origen / Rendición</th>
                     <th className="p-3">Facturas</th>
                    <th className="p-3">Cliente</th>
                    <th className="p-3">Método</th>
                    <th className="p-3 text-right">Monto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border">
                   {paymentRows.map((item: any) => (
                     <tr key={item.id}>
                       <td className="p-3 font-mono text-theme-text-muted"><span className={`mb-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${item.source_type === 'POST_SETTLEMENT_PAYMENT' ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'bg-theme-text/10 text-theme-text'}`}>{item.source_type === 'POST_SETTLEMENT_PAYMENT' ? 'Cobro posterior' : 'Rendición'}</span><span className="block">{item.settlement_number || '---'}</span><span className="block text-xs">GR {item.guide_number || '---'} · RR {item.settlement_number || '---'}</span></td>
                       <td className="p-3" title={item.invoiceNumbers.join(', ')}>{item.invoiceNumbers.length} factura{item.invoiceNumbers.length === 1 ? '' : 's'}</td>
                       <td className="p-3">{item.customers.join(', ') || 'Cliente no disponible'}</td>
                       <td className="p-3">
                        <span className="px-2 py-0.5 rounded bg-theme-text/10 text-[11px] font-bold">
                           {item.payment_method === 'CASH' ? 'Efectivo' : 'Cheque'}{item.source_type === 'POST_SETTLEMENT_PAYMENT' && <span className="ml-1 text-theme-text-muted">· {formatInstantInSantiago(item.received_at)}</span>}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono">${Number(item.amount).toLocaleString('es-CL')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-col xl:flex-row gap-4">
             <div className="flex-1 flex flex-col gap-3 min-w-0">
              <h3 className="font-bold text-theme-text flex items-center gap-2">Gastos</h3>
              <div className="border border-theme-border rounded-xl bg-theme-surface overflow-x-auto hide-scrollbar text-sm">
                <table className="w-full text-left">
                  <thead className="bg-theme-text/10 border-b border-theme-border whitespace-nowrap text-theme-text font-bold">
                    <tr>
                      <th className="p-3">Tipo</th>
                      <th className="p-3">Fecha</th>
                      <th className="p-3 text-right">Monto</th>
                      <th className="p-3 text-center">Adjunto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border">
                  {data.expenses.length === 0 ? (
                    <tr><td colSpan={4} className="p-4 text-center text-theme-text-muted">No hay gastos registrados</td></tr>
                  ) : data.expenses.map((e:any) => {
                    const attach = data.attachments.find((a:any) => a.expense_id === e.id);
                    return (
                      <tr key={e.id} className="hover:bg-theme-text/5 transition-colors">
                        <td className="p-3 text-theme-text font-medium">{e.expense_type}</td>
                        <td className="p-3 text-theme-text-muted whitespace-nowrap">{formatCivilDate(e.expense_date)}</td>
                        <td className="p-3 text-right font-mono text-red-600 dark:text-red-400 font-bold">${Number(e.amount).toLocaleString('es-CL')}</td>
                        <td className="p-3 text-center">
                          {attach ? (
                            <button onClick={() => handleOpenAttachment(attach)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-theme-text/10 hover:bg-theme-text/20 rounded-lg text-xs font-bold text-theme-text transition-colors">
                              <Eye className="w-4 h-4" /> Ver
                            </button>
                          ) : <span className="text-theme-text-muted text-xs">-</span>}
                        </td>
                      </tr>
                    )
                  })}
                  </tbody>
                </table>
              </div>
            </div>
            
          </div>
        </div>

        {/* Columna Derecha: Totales */}
        <div className="flex flex-col gap-3">
           <h3 className="font-bold text-theme-text flex items-center gap-2">Resumen</h3>
           <div className="border border-theme-border rounded-xl bg-theme-surface p-4 flex flex-col gap-3 text-sm text-theme-text">
              <div className="flex justify-between items-center text-theme-text-muted">
                <span>Efectivo Recibido</span>
                <span className="font-mono">${Number(closure.total_cash_received).toLocaleString('es-CL')}</span>
              </div>
             <div className="flex justify-between items-center text-theme-text-muted">
               <span>Cheques Recibidos</span>
               <span className="font-mono">${Number(closure.total_check_received).toLocaleString('es-CL')}</span>
             </div>
              <div className="h-px bg-theme-border my-1" />
              <div className="flex justify-between items-center font-bold">
                <span>Efectivo esperado a entregar</span>
                <span className="font-mono">{formatPendingAmount(physicalBalance.expected)}</span>
              </div>
              <div className="flex justify-between items-center text-red-500 mt-2">
                <span>Gastos</span>
                <span className="font-mono">-${Number(closure.total_expenses).toLocaleString('es-CL')}</span>
              </div>
              <div className="flex justify-between items-center text-theme-text-muted">
                <span>Efectivo entregado</span>
                <span className="font-mono">{formatPendingAmount(physicalBalance.delivered)}</span>
              </div>
              <div className={`flex justify-between items-center font-semibold ${physicalBalance.difference === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-orange-500'}`}>
                <span>Diferencia</span>
                <span className="font-mono">{physicalDifferenceLabel(physicalBalance.difference)}</span>
              </div>
              <div className="flex justify-between items-center text-emerald-500">
                <span>Depósitos registrados</span>
                <span className="font-mono">{formatPendingAmount(Number(closure.total_deposits))}</span>
              </div>

              <div className="h-px bg-theme-border my-1" />
              <div className="flex justify-between items-center font-bold text-lg">
                <span>Saldo Pendiente</span>
                <span className={`font-mono ${physicalBalance.difference === 0 ? 'text-theme-text' : 'text-orange-500'}`}>
                  {physicalPendingLabel(physicalBalance)}
                </span>
              </div>
              <div className="flex justify-between items-center text-theme-text-muted">
                <span>Resultado</span>
                <span className="font-semibold">{physicalDifferenceLabel(physicalBalance.difference)}</span>
              </div>
           </div>
        </div>
        </div>
      </div>

      {viewerState.isOpen && viewerState.url && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-theme-surface w-full max-w-4xl h-[85vh] rounded-xl shadow-2xl border border-theme-border flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-theme-border flex justify-between items-center bg-theme-text/5">
              <div>
                <h3 className="font-bold text-theme-text">{viewerState.name}</h3>
                <span className="text-xs text-theme-text-muted">{viewerState.type}</span>
              </div>
              <div className="flex gap-2">
                <a href={viewerState.url} target="_blank" rel="noreferrer" className="p-2 hover:bg-theme-text/10 rounded-lg text-theme-text transition-colors flex items-center gap-2" title="Abrir en nueva pestaña">
                  <Eye className="w-4 h-4" /> <span className="text-sm font-bold hidden sm:inline">Abrir pestaña</span>
                </a>
                <a href={viewerState.url} download={viewerState.name} className="p-2 hover:bg-theme-text/10 rounded-lg text-theme-text transition-colors flex items-center gap-2" title="Descargar">
                  <Download className="w-4 h-4" /> <span className="text-sm font-bold hidden sm:inline">Descargar</span>
                </a>
                <div className="w-px h-6 bg-theme-border mx-1 self-center" />
                <button onClick={() => setViewerState({isOpen: false, url: null, type: '', name: ''})} className="p-2 hover:bg-theme-text/10 rounded-lg text-theme-text transition-colors font-bold text-sm">Cerrar ✕</button>
              </div>
            </div>
            <div className="flex-1 bg-theme-text/5 overflow-auto flex items-center justify-center p-4">
              {viewerState.type.includes('pdf') ? (
                <iframe src={viewerState.url} className="w-full h-full rounded border border-theme-border bg-white" />
              ) : viewerState.type.includes('image') ? (
                <img src={viewerState.url} alt={viewerState.name} className="max-w-full max-h-full object-contain rounded drop-shadow-xl" />
              ) : (
                <div className="text-center flex flex-col items-center gap-3">
                  <FileText className="w-16 h-16 text-theme-text-muted" />
                  <p className="text-theme-text font-bold text-lg">Vista previa no disponible para este formato</p>
                  <p className="text-theme-text-muted text-sm max-w-md">Para visualizar este documento, por favor descárguelo a su dispositivo o ábralo en una nueva pestaña.</p>
                  <a href={viewerState.url} download={viewerState.name} className="px-6 py-2 bg-theme-accent text-white rounded-lg font-bold mt-2 hover:bg-theme-accent-hover transition-colors">Descargar Archivo</a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
