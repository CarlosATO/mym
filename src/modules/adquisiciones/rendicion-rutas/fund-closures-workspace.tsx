'use client'

import React, { useState, useEffect } from 'react'
import { getPendingRouteFunds, createFundClosure, getFundClosures, getFundClosureById, executeCloseFundClosure, addClosureExpense, addClosureDeposit, getAttachmentSignedUrl, canCancelFundClosure, cancelFundClosure } from '@/app/actions/adquisiciones/route-fund-closures'
import { PendingRouteFund, RouteFundClosure } from './fund-closures-types'
import { RefreshCw, Plus, CheckCircle, AlertTriangle, FileText, DollarSign, Wallet, Eye, Download, Paperclip, Search, Filter } from 'lucide-react'
import { toast } from 'sonner'

export function FundClosuresWorkspace() {
  const [activeTab, setActiveTab] = useState<'PENDING' | 'HISTORY'>('PENDING')
  
  // Pending view state
  const [pendingFunds, setPendingFunds] = useState<PendingRouteFund[]>([])
  const [selectedPendingIds, setSelectedPendingIds] = useState<Set<string>>(new Set())
  const [isLoadingPending, setIsLoadingPending] = useState(false)
  
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
      const data = await getPendingRouteFunds()
      setPendingFunds(data)
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

  const togglePendingSelection = (id: string) => {
    const next = new Set(selectedPendingIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedPendingIds(next)
  }

  const handleCreateClosure = async () => {
    if (selectedPendingIds.size === 0) return
    const selected = pendingFunds.filter(f => selectedPendingIds.has(f.route_settlement_item_id))
    try {
      toast.loading("Creando cierre...")
      const closureId = await createFundClosure(selected)
      toast.dismiss()
      toast.success("Cierre creado con éxito")
      setSelectedPendingIds(new Set())
      setSelectedClosureId(closureId)
    } catch (err: any) {
      toast.dismiss()
      toast.error(err.message)
    }
  }

  if (selectedClosureId) {
    return <FundClosureDetail closureId={selectedClosureId} onBack={() => setSelectedClosureId(null)} />
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

      <div className="flex-1 overflow-auto p-4">
        {activeTab === 'PENDING' ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-theme-text">Fondos recibidos por rendir</h3>
              <div className="flex items-center gap-2">
                <button onClick={loadPendingFunds} disabled={isLoadingPending} className="p-2 border border-theme-border rounded-md hover:bg-theme-text/5 text-theme-text">
                  <RefreshCw className={`w-4 h-4 ${isLoadingPending ? 'animate-spin' : ''}`} />
                </button>
                <button 
                  onClick={handleCreateClosure}
                  disabled={selectedPendingIds.size === 0}
                  className="px-4 py-2 bg-theme-accent text-white font-bold text-sm rounded-lg hover:bg-theme-accent-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Crear Cierre ({selectedPendingIds.size})
                </button>
              </div>
            </div>

            <div className="bg-theme-surface border border-theme-border rounded-xl overflow-hidden">
              <table className="w-full text-left text-sm text-theme-text">
                <thead className="bg-theme-text/5 border-b border-theme-border text-theme-text-muted">
                  <tr>
                    <th className="p-3 w-10">
                      <input 
                        type="checkbox" 
                        checked={selectedPendingIds.size === pendingFunds.length && pendingFunds.length > 0}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedPendingIds(new Set(pendingFunds.map(f => f.route_settlement_item_id)))
                          else setSelectedPendingIds(new Set())
                        }}
                      />
                    </th>
                    <th className="p-3 font-semibold">Guía</th>
                    <th className="p-3 font-semibold">Factura</th>
                    <th className="p-3 font-semibold">Cliente</th>
                    <th className="p-3 font-semibold">Método</th>
                    <th className="p-3 font-semibold text-right">Monto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border">
                  {pendingFunds.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-theme-text-muted">No hay fondos pendientes por rendir.</td>
                    </tr>
                  ) : pendingFunds.map(fund => (
                    <tr key={fund.route_settlement_item_id} className="hover:bg-theme-text/5">
                      <td className="p-3">
                        <input 
                          type="checkbox" 
                          checked={selectedPendingIds.has(fund.route_settlement_item_id)}
                          onChange={() => togglePendingSelection(fund.route_settlement_item_id)}
                        />
                      </td>
                      <td className="p-3">{fund.settlement_number || '---'}</td>
                      <td className="p-3 font-mono">{fund.invoice_number}</td>
                      <td className="p-3">{fund.customer_name}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded bg-theme-text/10 text-[11px] font-bold">
                          {fund.payment_method === 'CASH' ? 'Efectivo' : 'Cheque'}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono font-bold">${fund.amount.toLocaleString('es-CL')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                    <th className="p-3 text-center">Facturas</th>
                    <th className="p-3 text-right">Efectivo</th>
                    <th className="p-3 text-right">Cheques</th>
                    <th className="p-3 text-right">Gastos</th>
                    <th className="p-3 text-right">Depósitos</th>
                    <th className="p-3 text-right">Saldo Pdte</th>
                    {hasCancelPermission && <th className="p-3 text-center">Custodio</th>}
                    <th className="p-3 text-center">Adjuntos</th>
                    <th className="p-3 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border">
                  {closures.length === 0 ? (
                    <tr><td colSpan={12} className="p-8 text-center text-theme-text-muted">No se encontraron cierres con los filtros aplicados.</td></tr>
                  ) : closures.map(closure => {
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
                      <td className="p-3 whitespace-nowrap text-theme-text-muted">{new Date(closure.created_at).toLocaleDateString('es-CL')}</td>
                      <td className="p-3 whitespace-nowrap">
                        <span className={`px-2 py-1 text-[11px] font-bold rounded ${closure.status === 'CLOSED' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : closure.status === 'WITH_DIFFERENCE' ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400' : closure.status === 'CANCELLED' ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'}`}>{closure.status}</span>
                      </td>
                      <td className="p-3 text-center font-mono text-xs text-theme-text" title={uniqueGuides.join(', ')}>{guideText}</td>
                      <td className="p-3 text-center font-mono text-xs text-theme-text" title={uniqueInvoices.join(', ')}>{invoiceText}</td>
                      <td className="p-3 text-right font-mono text-theme-text">${Number(closure.total_cash_received).toLocaleString('es-CL')}</td>
                      <td className="p-3 text-right font-mono text-theme-text">${Number(closure.total_check_received).toLocaleString('es-CL')}</td>
                      <td className="p-3 text-right font-mono text-red-600 dark:text-red-400">${Number(closure.total_expenses).toLocaleString('es-CL')}</td>
                      <td className="p-3 text-right font-mono text-emerald-600 dark:text-emerald-400">${Number(closure.total_deposits).toLocaleString('es-CL')}</td>
                      <td className="p-3 text-right font-mono font-bold text-theme-text">${Number(closure.total_pending).toLocaleString('es-CL')}</td>
                      {hasCancelPermission && (
                        <td className="p-3 text-center text-xs text-theme-text-muted">
                          {closure.custody_user ? `${closure.custody_user.first_name || ''} ${closure.custody_user.last_name || ''}` : '---'}
                        </td>
                      )}
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
    </div>
  )
}

function FundClosureDetail({ closureId, onBack }: { closureId: string; onBack: () => void }) {
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
      load()
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
  const isClosed = closure.status === 'CLOSED' || closure.status === 'CANCELLED'

  return (
    <div className="flex flex-col h-full bg-theme-surface">
      <div className="flex flex-col md:flex-row md:items-center gap-4 border-b border-theme-border px-4 py-3 relative">
        <button onClick={onBack} className="text-sm font-bold text-theme-text-muted hover:text-theme-text">← Volver</button>
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-theme-text">Cierre {closure.closure_number}</h2>
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
                  <input type="date" name="expense_date" required defaultValue={new Date().toISOString().split('T')[0]} className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" />
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
                  <input type="date" name="deposit_date" required defaultValue={new Date().toISOString().split('T')[0]} className="w-full border border-theme-border rounded-lg px-3 py-2 text-sm bg-theme-surface text-theme-text" />
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

      <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-6 overflow-auto">
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
                    <th className="p-3">Guía</th>
                    <th className="p-3">Factura</th>
                    <th className="p-3">Cliente</th>
                    <th className="p-3">Método</th>
                    <th className="p-3 text-right">Monto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border">
                  {data.items.map((item: any) => (
                    <tr key={item.id}>
                      <td className="p-3 font-mono text-theme-text-muted">{item.guide_number || '---'}</td>
                      <td className="p-3 font-mono">{item.invoice_number}</td>
                      <td className="p-3">{item.customer_name}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded bg-theme-text/10 text-[11px] font-bold">
                          {item.payment_method === 'CASH' ? 'Efectivo' : 'Cheque'}
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
                        <td className="p-3 text-theme-text-muted whitespace-nowrap">{new Date(e.expense_date).toLocaleDateString('es-CL')}</td>
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
            
            <div className="flex-1 flex flex-col gap-3 min-w-0">
              <h3 className="font-bold text-theme-text flex items-center gap-2">Depósitos y Entregas</h3>
              <div className="border border-theme-border rounded-xl bg-theme-surface overflow-x-auto hide-scrollbar text-sm">
                <table className="w-full text-left">
                  <thead className="bg-theme-text/10 border-b border-theme-border whitespace-nowrap text-theme-text font-bold">
                    <tr>
                      <th className="p-3">Método</th>
                      <th className="p-3">Fecha</th>
                      <th className="p-3 text-right">Monto</th>
                      <th className="p-3 text-center">Comprobante</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border">
                  {data.deposits.length === 0 ? (
                    <tr><td colSpan={4} className="p-4 text-center text-theme-text-muted">No hay depósitos registrados</td></tr>
                  ) : data.deposits.map((d:any) => {
                    const attach = data.attachments.find((a:any) => a.deposit_id === d.id);
                    return (
                      <tr key={d.id} className="hover:bg-theme-text/5 transition-colors">
                        <td className="p-3 text-theme-text font-medium">{d.deposit_method}</td>
                        <td className="p-3 text-theme-text-muted whitespace-nowrap">{new Date(d.deposit_date).toLocaleDateString('es-CL')}</td>
                        <td className="p-3 text-right font-mono text-emerald-600 dark:text-emerald-400 font-bold">${Number(d.amount).toLocaleString('es-CL')}</td>
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
               <span>Total a Rendir</span>
               <span className="font-mono">${(Number(closure.total_cash_received) + Number(closure.total_check_received)).toLocaleString('es-CL')}</span>
             </div>
             
             <div className="flex justify-between items-center text-red-500 mt-2">
               <span>Gastos</span>
               <span className="font-mono">-${Number(closure.total_expenses).toLocaleString('es-CL')}</span>
             </div>
             <div className="flex justify-between items-center text-emerald-500">
               <span>Depósitos/Entregas</span>
               <span className="font-mono">-${Number(closure.total_deposits).toLocaleString('es-CL')}</span>
             </div>
             
             <div className="h-px bg-theme-border my-1" />
             <div className="flex justify-between items-center font-bold text-lg">
               <span>Saldo Pendiente</span>
               <span className={`font-mono ${Number(closure.total_pending) > 0 ? 'text-orange-500' : 'text-theme-text'}`}>
                 ${Number(closure.total_pending).toLocaleString('es-CL')}
               </span>
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
