'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  getPendingReceivablePOs,
  getPurchaseOrderReceiptDetails,
  type PurchaseOrderPending
} from '@/app/actions/logistica/recepciones'
import {
  Search, CheckCircle2, Clock, AlertCircle, Package,
  MapPin, Calendar, FileText, Paperclip, Layers, X,
  Eye, PackageOpen, Loader2
} from 'lucide-react'
import { erpInputClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'

type FilterTab = 'ALL' | 'PENDING' | 'PARTIAL' | 'RECEIVED'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'RECEPCION_TOTAL') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25">
      <CheckCircle2 className="w-2.5 h-2.5" /> Recibida
    </span>
  )
  if (status === 'RECEPCION_PARCIAL') return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/25">
      <Clock className="w-2.5 h-2.5" /> Parcial
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/25">
      <AlertCircle className="w-2.5 h-2.5" /> Pendiente
    </span>
  )
}

// ─── Detail Skeleton ──────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-4 p-6">
      <div className="h-3 bg-theme-text/10 rounded w-1/3" />
      <div className="space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-8 bg-theme-text/6 rounded" />)}
      </div>
      <div className="h-3 bg-theme-text/10 rounded w-1/4 mt-4" />
      <div className="space-y-2">
        {[1, 2].map(i => <div key={i} className="h-8 bg-theme-text/6 rounded" />)}
      </div>
    </div>
  )
}

// ─── Detail Panel (right side) ────────────────────────────────────────────────

function DetailPanel({
  summary,
  cachedDetail,
  onClose,
  onDetailLoaded,
  receivingId,
  onReceive
}: {
  summary: PurchaseOrderPending
  cachedDetail: any | null
  onClose: () => void
  onDetailLoaded: (poId: string, data: any) => void
  receivingId: string | null
  onReceive: (id: string) => void
}) {
  const [detail, setDetail] = useState<any>(cachedDetail)
  const [loadingDetail, setLoadingDetail] = useState(!cachedDetail)
  const [successReceipt, setSuccessReceipt] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const flash = sessionStorage.getItem('mym_receipt_success')
      if (flash) {
        try {
          const data = JSON.parse(flash)
          if (data.poId === summary.id && data.receiptNumber) {
            setSuccessReceipt(data.receiptNumber)
            sessionStorage.removeItem('mym_receipt_success')
          }
        } catch (e) {}
      }
    }
  }, [summary.id])

  useEffect(() => {
    if (cachedDetail) {
      setDetail(cachedDetail)
      setLoadingDetail(false)
      return
    }
    let active = true
    setDetail(null)
    setLoadingDetail(true)
    const perfLabel = `openReceptionDetail:${summary.id}`
    if (process.env.NODE_ENV === 'development') console.time(perfLabel)
    getPurchaseOrderReceiptDetails(summary.id).then(res => {
      if (process.env.NODE_ENV === 'development') console.timeEnd(perfLabel)
      if (active) {
        setDetail(res)
        setLoadingDetail(false)
        if (res) onDetailLoaded(summary.id, res)
      }
    })
    return () => { active = false }
  }, [summary.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const isTotal = summary.status === 'RECEPCION_TOTAL'
  const isPartial = summary.status === 'RECEPCION_PARCIAL'

  return (
    <div className="h-full flex flex-col bg-theme-surface border-l border-theme-border">

      {/* ── Header (fixed height, no excessive padding) ── */}
      <div className="shrink-0 border-b border-theme-border/70">
        {successReceipt && (
          <div className="bg-emerald-500/10 border-b border-emerald-500/20 px-5 py-2.5 flex items-center justify-between animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                Recepción <span className="font-mono text-emerald-700 dark:text-emerald-300">{successReceipt}</span> registrada correctamente
              </span>
            </div>
            <button onClick={() => setSuccessReceipt(null)} className="text-emerald-600 hover:bg-emerald-500/10 p-1 rounded transition-colors" title="Cerrar aviso">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {/* Title row */}
        <div className="flex items-center justify-between gap-4 px-5 py-3 bg-theme-text/[0.02]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-theme-accent/10 flex items-center justify-center shrink-0">
              <PackageOpen className="w-4 h-4 text-theme-accent" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold text-theme-accent">{summary.correlative}</span>
                <StatusBadge status={summary.status} />
              </div>
              <p className="text-xs text-theme-text-muted truncate">{summary.supplier_name}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isTotal ? (
              <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 className="w-3 h-3" /> Completada
              </span>
            ) : isPartial ? (
              <button
                disabled={!!receivingId}
                onClick={() => onReceive(summary.id)}
                className="px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all active:scale-95 flex items-center gap-1.5 disabled:opacity-50"
              >
                {receivingId === summary.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {receivingId === summary.id ? 'Cargando...' : 'Recibir saldo'}
              </button>
            ) : (
              <button
                disabled={!!receivingId}
                onClick={() => onReceive(summary.id)}
                className="px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all active:scale-95 flex items-center gap-1.5 disabled:opacity-50"
              >
                {receivingId === summary.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {receivingId === summary.id ? 'Cargando...' : 'Recibir OC'}
              </button>
            )}
            <button
              onClick={onClose}
              title="Cerrar detalle"
              className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* KPI row — from summary data, no loading wait */}
        <div className="grid grid-cols-5 divide-x divide-theme-border/50 border-t border-theme-border/50">
          {[
            { label: 'Total OC', value: fmt(summary.grand_total), color: '' },
            { label: 'Recibido', value: fmt(summary.amount_received), color: 'text-emerald-600 dark:text-emerald-400' },
            { label: 'Solicitada', value: String(summary.qty_ordered), color: '' },
            { label: 'Recibida', value: String(summary.qty_received), color: 'text-emerald-600 dark:text-emerald-400' },
            { label: 'Pendiente', value: String(summary.qty_pending), color: summary.qty_pending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-theme-text-muted' },
          ].map(({ label, value, color }) => (
            <div key={label} className="px-4 py-2">
              <p className="text-[9px] font-bold uppercase tracking-wider text-theme-text-muted mb-0.5">{label}</p>
              <p className={cn('text-xs font-bold', color || 'text-theme-text')}>{value}</p>
            </div>
          ))}
        </div>

        {/* Secondary info row */}
        <div className="flex items-center gap-4 px-5 py-2 text-[11px] text-theme-text-muted border-t border-theme-border/40">
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            {new Date(summary.issue_date).toLocaleDateString('es-CL')}
          </span>
          {summary.warehouse_name && (
            <span className="flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {summary.warehouse_name}
            </span>
          )}
          {summary.latest_receipt_number && (
            <span className="flex items-center gap-1 text-theme-accent">
              <FileText className="w-3 h-3" />
              {summary.latest_receipt_number}
            </span>
          )}
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto">
        {loadingDetail ? (
          <DetailSkeleton />
        ) : !detail ? (
          <div className="p-8 text-center text-sm text-theme-text-muted">No se pudo cargar el detalle.</div>
        ) : (
          <div className="p-5 space-y-6">

            {/* Receipts */}
            {detail.receipts?.length > 0 && (
              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-2 flex items-center gap-1.5">
                  <FileText className="w-3 h-3 text-theme-accent" /> Recepciones Registradas
                </h3>
                <div className="space-y-1.5">
                  {detail.receipts.map((rec: any) => {
                    const doc = rec.receipt_documents?.[0]
                    return (
                      <div key={rec.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-theme-text/[0.03] border border-theme-border/50">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] font-bold text-theme-accent">{rec.receipt_number}</span>
                            <span className="text-[10px] text-theme-text-muted">
                              {rec.received_at ? new Date(rec.received_at).toLocaleDateString('es-CL') : '—'}
                            </span>
                          </div>
                          {doc && (
                            <p className="text-[10px] text-theme-text-muted mt-0.5 flex items-center gap-1 truncate">
                              <Paperclip className="w-2.5 h-2.5 shrink-0" />
                              {doc.document_type} {doc.document_number || ''} {doc.file_name ? `· ${doc.file_name}` : ''}
                            </p>
                          )}
                        </div>
                        <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 shrink-0">
                          {fmt(Number(rec.receipt_total_gross || 0))}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {/* Lines */}
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-2 flex items-center gap-1.5">
                <Layers className="w-3 h-3 text-theme-accent" /> Líneas de la Orden
              </h3>
              <div className="rounded-lg border border-theme-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-theme-text/[0.04] border-b border-theme-border text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
                      <th className="text-left px-3 py-2">Producto</th>
                      <th className="text-right px-3 py-2">P.Un.</th>
                      <th className="text-right px-3 py-2">Pedida</th>
                      <th className="text-right px-3 py-2">Recibida</th>
                      <th className="text-right px-3 py-2">Pendiente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items?.map((item: any) => {
                      const qOrd = Number(item.quantity || 0)
                      const qRec = Number(item.quantity_received || 0)
                      const qPen = Math.max(0, qOrd - qRec)
                      return (
                        <tr key={item.id} className="border-b border-theme-border/40 hover:bg-theme-text/[0.02]">
                          <td className="px-3 py-2">
                            <p className="font-medium text-theme-text truncate max-w-[200px]" title={item.product_description}>{item.product_description}</p>
                          </td>
                          <td className="px-3 py-2 text-right text-theme-text-muted">{fmt(Number(item.unit_price || 0))}</td>
                          <td className="px-3 py-2 text-right">{qOrd}</td>
                          <td className="px-3 py-2 text-right text-emerald-600 dark:text-emerald-400 font-semibold">{qRec}</td>
                          <td className={cn('px-3 py-2 text-right font-bold', qPen > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-theme-text-muted/40')}>{qPen}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Lots */}
            {detail.receiptItems?.length > 0 && (
              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted mb-2 flex items-center gap-1.5">
                  <Package className="w-3 h-3 text-theme-accent" /> Lotes y Ubicaciones
                </h3>
                <div className="rounded-lg border border-theme-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-theme-text/[0.04] border-b border-theme-border text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
                        <th className="text-left px-3 py-2">Recepción</th>
                        <th className="text-left px-3 py-2">Cond.</th>
                        <th className="text-left px-3 py-2">Lote</th>
                        <th className="text-left px-3 py-2">Vence</th>
                        <th className="text-left px-3 py-2">Ubicación</th>
                        <th className="text-right px-3 py-2">Cant.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.receiptItems.map((ri: any) => {
                        const rec = detail.receipts?.find((r: any) => r.id === ri.receipt_id)
                        return (
                          <tr key={ri.id} className="border-b border-theme-border/40 hover:bg-theme-text/[0.02]">
                            <td className="px-3 py-1.5 font-mono text-[10px] text-theme-accent">{rec?.receipt_number || '—'}</td>
                            <td className="px-3 py-1.5">
                              <span className={cn('px-1 py-0.5 rounded text-[9px] font-bold border',
                                ri.condition === 'CONFORME'
                                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                                  : 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
                              )}>
                                {ri.condition}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-theme-text">{ri.lot_number || '—'}</td>
                            <td className="px-3 py-1.5 text-theme-text-muted">{ri.expiration_date ? new Date(ri.expiration_date).toLocaleDateString('es-CL') : '—'}</td>
                            <td className="px-3 py-1.5 text-theme-text-muted">{ri.locations?.name || ri.locations?.code || '—'}</td>
                            <td className="px-3 py-1.5 text-right font-semibold text-emerald-600 dark:text-emerald-400">{ri.quantity_received}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tray Table (full-width, no detail open) ──────────────────────────────────

function TrayTable({
  pos,
  loading,
  search,
  setSearch,
  filterTab,
  setFilterTab,
  counts,
  filteredPOs,
  onOpenDetail,
  onPrefetch,
  receivingId,
  onReceive
}: {
  pos: PurchaseOrderPending[]
  loading: boolean
  search: string
  setSearch: (v: string) => void
  filterTab: FilterTab
  setFilterTab: (v: FilterTab) => void
  counts: { all: number; pending: number; partial: number; received: number }
  filteredPOs: PurchaseOrderPending[]
  onOpenDetail: (po: PurchaseOrderPending) => void
  onPrefetch: (poId: string) => void
  receivingId: string | null
  onReceive: (id: string) => void
}) {

  const tabBtn = (id: FilterTab, label: string, activeColor: string) => (
    <button
      key={id}
      onClick={() => setFilterTab(id)}
      className={cn(
        'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap',
        filterTab === id ? `${activeColor} text-white shadow-sm` : 'text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5'
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-theme-border/60 bg-theme-text/[0.01]">
        <div className="flex gap-1 p-1 rounded-xl bg-theme-text/[0.04] border border-theme-border/40">
          {tabBtn('ALL', `Todos (${counts.all})`, 'bg-theme-accent')}
          {tabBtn('PENDING', `Pendientes (${counts.pending})`, 'bg-blue-500')}
          {tabBtn('PARTIAL', `Parciales (${counts.partial})`, 'bg-amber-500')}
          {tabBtn('RECEIVED', `Recibidas (${counts.received})`, 'bg-emerald-500')}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-text-muted/50" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar OC, proveedor, documento..."
            className={cn(erpInputClass, 'w-full h-9 pl-9 pr-3 text-xs')}
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin w-6 h-6 border-2 border-theme-accent border-t-transparent rounded-full mx-auto" />
            <p className="text-xs text-theme-text-muted mt-3">Cargando recepciones...</p>
          </div>
        ) : filteredPOs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 h-full p-12">
            <AlertCircle className="w-10 h-10 text-theme-text-muted/20" />
            <p className="text-sm text-theme-text-muted">{search ? 'Sin resultados para la búsqueda' : 'No hay órdenes en este filtro'}</p>
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-theme-surface border-b border-theme-border text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
                <th className="text-left px-4 py-3">N° OC</th>
                <th className="text-left px-4 py-3">Proveedor</th>
                <th className="text-left px-4 py-3">Fecha</th>
                <th className="text-left px-4 py-3">Bodega</th>
                <th className="text-center px-4 py-3">Estado</th>
                <th className="text-right px-4 py-3">Solicitada</th>
                <th className="text-right px-4 py-3">Recibida</th>
                <th className="text-right px-4 py-3">Pendiente</th>
                <th className="text-right px-4 py-3">Total OC</th>
                <th className="text-right px-4 py-3">Monto Rec.</th>
                <th className="text-left px-4 py-3">Últ. Recepción</th>
                <th className="text-right px-4 py-3">Acción</th>
              </tr>
            </thead>
            <tbody>
              {filteredPOs.map(po => {
                const isTotal = po.status === 'RECEPCION_TOTAL'
                const isPartial = po.status === 'RECEPCION_PARCIAL'
                return (
                  <tr
                    key={po.id}
                    onDoubleClick={() => {
                      if (isTotal) onOpenDetail(po)
                      else onReceive(po.id)
                    }}
                    onMouseEnter={() => onPrefetch(po.id)}
                    className="border-b border-theme-border/40 hover:bg-theme-accent/[0.03] transition-colors cursor-pointer group"
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-mono font-bold text-theme-accent text-[11px]">{po.correlative}</span>
                    </td>
                    <td className="px-4 py-2.5 max-w-[180px]">
                      <p className="truncate font-medium text-theme-text" title={po.supplier_name}>{po.supplier_name}</p>
                    </td>
                    <td className="px-4 py-2.5 text-theme-text-muted whitespace-nowrap">
                      {new Date(po.issue_date).toLocaleDateString('es-CL')}
                    </td>
                    <td className="px-4 py-2.5 text-theme-text-muted max-w-[120px]">
                      <p className="truncate">{po.warehouse_name || '—'}</p>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <StatusBadge status={po.status} />
                    </td>
                    <td className="px-4 py-2.5 text-right text-theme-text">{po.qty_ordered}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-emerald-600 dark:text-emerald-400">{po.qty_received}</td>
                    <td className={cn('px-4 py-2.5 text-right font-bold', po.qty_pending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-theme-text-muted/40')}>
                      {po.qty_pending}
                    </td>
                    <td className="px-4 py-2.5 text-right text-theme-text-muted">{fmt(po.grand_total)}</td>
                    <td className="px-4 py-2.5 text-right text-emerald-600 dark:text-emerald-400 font-medium">
                      {po.amount_received > 0 ? fmt(po.amount_received) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-theme-text-muted">
                      {po.latest_receipt_number ? (
                        <span className="font-mono text-[10px] text-theme-accent">{po.latest_receipt_number}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {isTotal ? (
                        <button
                          onClick={() => onOpenDetail(po)}
                          className="px-2.5 py-1 rounded-lg border border-theme-border hover:bg-theme-text/10 text-theme-text-muted text-[10px] font-semibold transition-all flex items-center gap-1 ml-auto"
                        >
                          <Eye className="w-3 h-3" /> Ver
                        </button>
                      ) : isPartial ? (
                        <button
                          disabled={!!receivingId}
                          onClick={(e) => { e.stopPropagation(); onReceive(po.id) }}
                          className="px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/25 text-[10px] font-bold transition-all disabled:opacity-50 flex items-center gap-1"
                        >
                          {receivingId === po.id && <Loader2 className="w-3 h-3 animate-spin" />}
                          {receivingId === po.id ? 'Cargando...' : 'Recibir saldo'}
                        </button>
                      ) : (
                        <button
                          disabled={!!receivingId}
                          onClick={(e) => { e.stopPropagation(); onReceive(po.id) }}
                          className="px-2.5 py-1 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-[10px] font-bold transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                        >
                          {receivingId === po.id && <Loader2 className="w-3 h-3 animate-spin" />}
                          {receivingId === po.id ? 'Cargando...' : 'Recibir'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ─── Compact List (left side when detail is open) ─────────────────────────────

function CompactList({
  filteredPOs,
  selectedId,
  onSelect,
  onPrefetch,
}: {
  filteredPOs: PurchaseOrderPending[]
  selectedId: string
  onSelect: (po: PurchaseOrderPending) => void
  onPrefetch: (poId: string) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      {filteredPOs.map(po => {
        const pct = po.qty_ordered > 0 ? Math.min(100, Math.round((po.qty_received / po.qty_ordered) * 100)) : 0
        return (
          <button
            key={po.id}
            onClick={() => onSelect(po)}
            onMouseEnter={() => onPrefetch(po.id)}
            className={cn(
              'w-full text-left px-3 py-2.5 border-b border-theme-border/40 transition-colors',
              selectedId === po.id
                ? 'bg-theme-accent/8 border-l-2 border-l-theme-accent'
                : 'hover:bg-theme-text/[0.03] border-l-2 border-l-transparent'
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="font-mono text-[10px] font-bold text-theme-accent">{po.correlative}</span>
              <StatusBadge status={po.status} />
            </div>
            <p className="text-[10px] font-medium text-theme-text truncate mb-1.5">{po.supplier_name}</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-0.5 rounded-full bg-theme-text/10">
                <div
                  className={cn('h-full rounded-full', pct === 100 ? 'bg-emerald-500' : pct > 0 ? 'bg-amber-500' : 'bg-blue-400')}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-[9px] text-theme-text-muted shrink-0">{pct}%</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function RecepcionesPanel() {
  const router = useRouter()
  const [pos, setPos] = useState<PurchaseOrderPending[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterTab, setFilterTab] = useState<FilterTab>('ALL')

  const [receivingId, setReceivingId] = useState<string | null>(null)
  const handleReceive = (id: string) => {
    if (receivingId) return
    setReceivingId(id)
    router.push(`/dashboard/logistica/recepciones/${id}`)
  }

  // null = tray view (no detail). string = detail open for this poId.
  const [detailPoId, setDetailPoId] = useState<string | null>(null)

  // Cache: poId → full detail data. Persists between opens.
  const detailCache = useRef<Record<string, any>>({})
  // Track pending prefetch requests to avoid duplicates
  const pendingRequestsRef = useRef<Record<string, boolean>>({})

  const [initialPoIdSet, setInitialPoIdSet] = useState(false)
  
  useEffect(() => {
    if (pos.length > 0 && !initialPoIdSet && typeof window !== 'undefined') {
      let activePoId = null
      
      const flash = sessionStorage.getItem('mym_receipt_success')
      if (flash) {
        try {
          const data = JSON.parse(flash)
          if (data.poId) activePoId = data.poId
        } catch (e) {}
      }
      
      if (!activePoId) {
        const params = new URLSearchParams(window.location.search)
        activePoId = params.get('poId')
      }
      
      if (activePoId) {
        setDetailPoId(activePoId)
      }
      setInitialPoIdSet(true)
    }
  }, [pos, initialPoIdSet])

  const loadPOs = useCallback(async () => {
    if (process.env.NODE_ENV === 'development') console.time('loadRecepciones')
    setLoading(true)
    const list = await getPendingReceivablePOs()
    setPos(list)
    setLoading(false)
    if (process.env.NODE_ENV === 'development') console.timeEnd('loadRecepciones')
    // NO auto-select
  }, [])

  useEffect(() => { loadPOs() }, [loadPOs])

  const filteredPOs = pos.filter(po => {
    if (filterTab === 'PENDING' && po.status !== 'EMITIDA') return false
    if (filterTab === 'PARTIAL' && po.status !== 'RECEPCION_PARCIAL') return false
    if (filterTab === 'RECEIVED' && po.status !== 'RECEPCION_TOTAL') return false
    const s = search.toLowerCase()
    return (
      po.correlative.toLowerCase().includes(s) ||
      po.supplier_name.toLowerCase().includes(s) ||
      (po.warehouse_name?.toLowerCase().includes(s) ?? false) ||
      (po.latest_receipt_number?.toLowerCase().includes(s) ?? false)
    )
  })

  // If detail is open and the PO is no longer in filteredPOs → close detail
  useEffect(() => {
    if (detailPoId && !filteredPOs.find(p => p.id === detailPoId)) {
      setDetailPoId(null)
    }
  }, [filteredPOs, detailPoId])

  const counts = {
    all: pos.length,
    pending: pos.filter(p => p.status === 'EMITIDA').length,
    partial: pos.filter(p => p.status === 'RECEPCION_PARCIAL').length,
    received: pos.filter(p => p.status === 'RECEPCION_TOTAL').length,
  }

  const detailSummary = detailPoId ? (filteredPOs.find(p => p.id === detailPoId) ?? null) : null

  const openDetail = (po: PurchaseOrderPending) => setDetailPoId(po.id)
  const closeDetail = () => setDetailPoId(null)

  const prefetchDetail = (poId: string) => {
    if (detailCache.current[poId] || pendingRequestsRef.current[poId]) return
    pendingRequestsRef.current[poId] = true
    getPurchaseOrderReceiptDetails(poId).then(data => {
      if (data) {
        detailCache.current[poId] = data
      }
      delete pendingRequestsRef.current[poId]
    }).catch(() => {
      delete pendingRequestsRef.current[poId]
    })
  }

  // Tray mode: no detail open
  if (!detailSummary) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-theme-surface">
        <TrayTable
          pos={pos}
          loading={loading}
          search={search}
          setSearch={setSearch}
          filterTab={filterTab}
          setFilterTab={setFilterTab}
          counts={counts}
          filteredPOs={filteredPOs}
          onOpenDetail={openDetail}
          onPrefetch={prefetchDetail}
          receivingId={receivingId}
          onReceive={handleReceive}
        />
      </div>
    )
  }

  // Master-detail mode: detail open
  return (
    <div className="flex h-full overflow-hidden bg-theme-surface">

      {/* ─── LEFT: Compact list ───────────────────────────────────────── */}
      <div className="w-[320px] shrink-0 flex flex-col bg-theme-text/[0.01] border-r border-theme-border">
        {/* List header */}
        <div className="shrink-0 px-3 py-2.5 border-b border-theme-border/60 bg-theme-text/[0.02]">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-theme-text-muted/50" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar..."
              className={cn(erpInputClass, 'w-full h-7 pl-7 pr-2 rounded-md text-[11px]')}
            />
          </div>
        </div>
        <CompactList
          filteredPOs={filteredPOs}
          selectedId={detailPoId!}
          onSelect={(po) => setDetailPoId(po.id)}
          onPrefetch={prefetchDetail}
        />
      </div>

      {/* ─── RIGHT: Detail ────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <DetailPanel
          key={detailSummary.id}
          summary={detailSummary}
          cachedDetail={detailCache.current[detailSummary.id] ?? null}
          onClose={closeDetail}
          onDetailLoaded={(poId, data) => { detailCache.current[poId] = data }}
          receivingId={receivingId}
          onReceive={handleReceive}
        />
      </div>

    </div>
  )
}
