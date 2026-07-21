"use client"

import { useEffect, useState, useTransition } from 'react'
import { AlertTriangle, CalendarDays, Mail, MapPin, Phone, TrendingUp, UserRoundCheck, X } from 'lucide-react'
import { getCommercialCustomerBehavior, getCommercialCustomerMetricDocuments, getCommercialCustomerPurchaseMix, getCommercialCustomerReceivables, getCommercialDocumentDetail, type CommercialCustomerBehavior, type CommercialCustomerBehaviorDocument, type CommercialCustomerMetricDocuments, type CommercialCustomerMetricKey, type CommercialCustomerPurchaseMix, type CommercialCustomerPurchaseMixProduct, type CommercialCustomerReceivables, type CommercialCustomerReceivablesInvoice, type CommercialDocumentDetail } from '@/app/actions/comercial/customers'
import type { CommercialCustomerExplorer } from '@/app/actions/comercial/customers'
import { cn } from '@/lib/utils'

export type Client360Tab = 'summary' | 'purchases' | 'documents' | 'products' | 'receivables'
type DocumentFilter = 'all' | 'invoice' | 'sales_order' | 'credit_note'
type ReceivableFilter = 'all' | 'pending' | 'overdue' | 'paid'
type MetricOpenHandler = (metricKey: CommercialCustomerMetricKey) => void
type DocumentOpenHandler = (bsaleDocumentId: number) => void

function fmtMoney(value: number | null | undefined) {
  const n = Number(value || 0)
  if (n === 0) return '$0'
  return '$' + n.toLocaleString('es-CL', { maximumFractionDigits: 0 })
}

function fmtCompactMoney(value: number | null | undefined) {
  const n = Number(value || 0)
  if (n === 0) return '$0'
  if (Math.abs(n) >= 1000000) return '$' + (n / 1000000).toLocaleString('es-CL', { maximumFractionDigits: 1 }) + 'MM'
  if (Math.abs(n) >= 1000) return '$' + Math.round(n / 1000).toLocaleString('es-CL') + 'K'
  return fmtMoney(n)
}

function fmtSignedMoney(value: number | null | undefined) {
  const n = Number(value || 0)
  if (n < 0) return '-$' + Math.abs(n).toLocaleString('es-CL', { maximumFractionDigits: 0 })
  return fmtMoney(n)
}

function fmtDate(value: string | null) {
  if (!value) return 'Sin dato'
  return new Date(value + 'T00:00:00').toLocaleDateString('es-CL')
}

function fmtDateTime(value: string | null) {
  if (!value) return 'Sin dato'
  return new Date(value).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statusLabel(status: string | null) {
  if (!status) return 'SIN ESTADO'
  return status.replaceAll('_', ' ')
}

function statusClass(status: string | null) {
  switch (status) {
    case 'ACTIVO': return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
    case 'NUEVO': return 'bg-blue-500/10 text-blue-400 border-blue-500/20'
    case 'OBSERVACION': return 'bg-amber-500/10 text-amber-400 border-amber-500/20'
    case 'RIESGO': return 'bg-orange-500/10 text-orange-400 border-orange-500/20'
    case 'PERDIDO': return 'bg-red-500/10 text-red-400 border-red-500/20'
    case 'INACTIVO': return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
    case 'SIN_VENTA_HISTORICA': return 'bg-theme-text/5 text-theme-text-muted border-theme-border'
    default: return 'bg-theme-text/5 text-theme-text-muted border-theme-border'
  }
}

function documentTone(type: CommercialCustomerBehaviorDocument['type']) {
  switch (type) {
    case 'invoice': return 'border-sky-500/20 bg-sky-500/10 text-sky-400'
    case 'sales_order': return 'border-violet-500/20 bg-violet-500/10 text-violet-400'
    case 'credit_note': return 'border-red-500/20 bg-red-500/10 text-red-400'
  }
}

function receivableStatusTone(status: string | null) {
  switch (status) {
    case 'PAGADA': return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'PAGO_PARCIAL': return 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    case 'PENDIENTE': return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    case 'VENCIDA': return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
    default: return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
  }
}

function riskTone(status: string | null) {
  switch (status) {
    case 'SIN_DEUDA': return 'text-emerald-500'
    case 'BAJO': return 'text-sky-500'
    case 'MEDIO': return 'text-amber-500'
    case 'ALTO': return 'text-orange-500'
    case 'CRITICO': return 'text-red-500'
    default: return 'text-theme-text'
  }
}

function behaviorText(receivables: CommercialCustomerReceivables) {
  const summary = receivables.summary
  if (!summary) return 'Sin datos suficientes de cobranza para este cliente.'
  if (summary.total_pending <= 0) return 'Cliente sin deuda vigente.'
  if (summary.risk_status === 'CRITICO' || summary.payment_behavior_label === 'DEUDA_CRITICA') return 'Cliente con deuda vencida crítica. Revisar antes de nuevas condiciones comerciales.'
  if (summary.payment_behavior_label === 'ATRASO_RECURRENTE') return 'Cliente con atraso recurrente en facturas pendientes.'
  if (summary.payment_behavior_label === 'ATRASO_LEVE') return 'Cliente con atraso leve; monitorear próximos pagos.'
  if (summary.total_paid > 0 && summary.total_pending > 0) return 'Cliente con pagos recientes, pero mantiene saldo pendiente.'
  if (summary.payment_behavior_label === 'SIN_DATOS_PAGO') return 'Sin datos suficientes de pago para concluir comportamiento.'
  return 'Pago regular según la cobranza registrada.'
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/65">{title}</h3>
      {children}
    </section>
  )
}

function Metric({ label, value, hint, tone = 'text-theme-text', featured = false, onOpen }: { label: string; value: string; hint?: string; tone?: string; featured?: boolean; onOpen?: () => void }) {
  const interactive = Boolean(onOpen)

  return (
    <div
      onDoubleClick={onOpen}
      title={interactive ? 'Doble click para ver documentos' : undefined}
      className={cn(
        "rounded-lg border px-2.5 py-1.5 transition-colors",
        featured ? "border-sky-500/35 bg-sky-500/10 shadow-sm" : "border-theme-border/60 bg-theme-bg/30",
        interactive && "cursor-pointer hover:border-theme-text/25 hover:bg-theme-text/[0.045]"
      )}
    >
      <div className={cn("text-[9px] uppercase tracking-wide font-semibold leading-4", featured ? "text-sky-700 dark:text-sky-300" : "text-theme-text-muted/60")}>{label}</div>
      <div className={cn("text-[13px] font-black leading-5", tone)}>{value}</div>
      {hint && <div className="text-[9px] text-theme-text-muted/50 truncate leading-4">{hint}</div>}
    </div>
  )
}

function InfoRow({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-theme-border/50 bg-theme-bg/25 px-2.5 py-1.5">
      {icon && <div className="mt-0.5 text-theme-text-muted/50">{icon}</div>}
      <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-wide text-theme-text-muted/60 font-semibold">{label}</div>
        <div className="text-xs text-theme-text mt-0.5 break-words">{value || <span className="text-theme-text-muted/45">Sin dato</span>}</div>
      </div>
    </div>
  )
}

function AlertBadge({ children, tone = 'text-theme-text-muted border-theme-border bg-theme-bg/40' }: { children: React.ReactNode; tone?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold", tone)}>{children}</span>
}

function LoadingState() {
  return <div className="rounded-xl border border-theme-border/70 bg-theme-bg/25 px-3 py-6 text-center text-xs text-theme-text-muted">Cargando comportamiento del cliente...</div>
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-theme-border/70 bg-theme-bg/20 px-3 py-5 text-center text-xs text-theme-text-muted">{children}</div>
}

function MiniDocumentTable({ title, documents }: { title: string; documents: CommercialCustomerBehaviorDocument[] }) {
  return (
    <Section title={title}>
      {documents.length === 0 ? <EmptyState>Sin documentos para mostrar.</EmptyState> : (
        <div className="overflow-hidden rounded-xl border border-theme-border/70 bg-theme-bg/20">
          <table className="w-full text-xs">
            <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-bold">Fecha</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Folio</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Monto</th>
                <th className="hidden sm:table-cell px-2.5 py-1.5 text-left font-bold">Vendedor certificado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {documents.slice(0, 6).map(doc => (
                <tr key={`${doc.type}-${doc.bsale_document_id}`} className="text-theme-text">
                  <td className="px-2.5 py-1.5 text-theme-text-muted whitespace-nowrap">{fmtDate(doc.date)}</td>
                  <td className="px-2.5 py-1.5 font-mono">{doc.number || doc.bsale_document_id}</td>
                  <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(doc.amount)}</td>
                  <td className="hidden sm:table-cell px-2.5 py-1.5 text-theme-text-muted truncate max-w-[160px]" title={doc.sellerName}>{doc.sellerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function DocumentsTable({ documents, onOpenDocument }: { documents: CommercialCustomerBehaviorDocument[]; onOpenDocument: DocumentOpenHandler }) {
  const [filter, setFilter] = useState<DocumentFilter>('all')
  const filtered = filter === 'all' ? documents : documents.filter(doc => doc.type === filter)
  const filters: { key: DocumentFilter; label: string }[] = [
    { key: 'all', label: 'Todos' },
    { key: 'invoice', label: 'Facturas' },
    { key: 'sales_order', label: 'NV' },
    { key: 'credit_note', label: 'NC' },
  ]

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {filters.map(item => (
          <button key={item.key} onClick={() => setFilter(item.key)} className={cn("rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors", filter === item.key ? "border-theme-text/20 bg-theme-text/10 text-theme-text" : "border-theme-border bg-theme-bg/20 text-theme-text-muted hover:text-theme-text")}>{item.label}</button>
        ))}
      </div>
      {filtered.length === 0 ? <EmptyState>No hay documentos para este filtro.</EmptyState> : (
        <div className="overflow-x-auto rounded-xl border border-theme-border/70 bg-theme-bg/20">
          <table className="w-full min-w-[660px] text-xs">
            <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-bold">Fecha</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Tipo</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Folio</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Monto</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Vendedor certificado</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Bsale ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {filtered.map(doc => (
                <tr key={`${doc.type}-${doc.bsale_document_id}`} onDoubleClick={() => onOpenDocument(doc.bsale_document_id)} className="cursor-pointer text-theme-text hover:bg-theme-text/[0.035]">
                  <td className="px-2.5 py-1.5 text-theme-text-muted whitespace-nowrap">{fmtDate(doc.date)}</td>
                  <td className="px-2.5 py-1.5"><span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", documentTone(doc.type))}>{doc.label}</span></td>
                  <td className="px-2.5 py-1.5 font-mono">{doc.number || '—'}</td>
                  <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(doc.amount)}</td>
                  <td className="px-2.5 py-1.5 text-theme-text-muted max-w-[180px] truncate" title={doc.sellerName}>{doc.sellerName}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-theme-text-muted/70">{doc.bsale_document_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function MetricDocumentsModal({ data, loading, error, onClose, onOpenDocument }: { data: CommercialCustomerMetricDocuments | null; loading: boolean; error: string | null; onClose: () => void; onOpenDocument: DocumentOpenHandler }) {
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-theme-border px-4 py-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Detalle de métrica</div>
            <h3 className="text-base font-black text-theme-text">{data?.title || 'Cargando documentos'}</h3>
            {data?.note && <div className="mt-0.5 text-xs text-theme-text-muted">{data.note}</div>}
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text" aria-label="Cerrar detalle de métrica"><X className="w-4 h-4" /></button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          {loading && <LoadingState />}
          {error && <EmptyState>{error}</EmptyState>}
          {!loading && !error && data && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <Metric label="Documentos" value={String(data.summary.documentsCount)} />
                <Metric label="Facturas" value={fmtMoney(data.summary.invoiceGrossAmount)} />
                <Metric label="NC" value={fmtMoney(data.summary.creditNoteAmount)} tone={data.summary.creditNoteAmount > 0 ? 'text-red-400' : 'text-theme-text'} />
                <Metric label="Neto" value={fmtMoney(data.summary.netAmount)} tone="text-sky-600 dark:text-sky-300" />
                <Metric label="NV" value={fmtMoney(data.summary.salesOrderAmount)} />
              </div>
              {data.documents.length === 0 ? <EmptyState>No hay documentos para esta métrica.</EmptyState> : (
                <div className="overflow-x-auto rounded-xl border border-theme-border/70 bg-theme-bg/20">
                  <table className="w-full min-w-[720px] text-xs">
                    <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
                      <tr>
                        <th className="px-2.5 py-1.5 text-left font-bold">Fecha</th>
                        <th className="px-2.5 py-1.5 text-left font-bold">Tipo</th>
                        <th className="px-2.5 py-1.5 text-left font-bold">Folio</th>
                        <th className="px-2.5 py-1.5 text-right font-bold">Monto</th>
                        <th className="px-2.5 py-1.5 text-left font-bold">Vendedor certificado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-theme-border/60">
                      {data.documents.map(doc => (
                        <tr key={`${doc.type}-${doc.bsale_document_id}`} onDoubleClick={() => onOpenDocument(doc.bsale_document_id)} className="cursor-pointer text-theme-text hover:bg-theme-text/[0.035]">
                          <td className="px-2.5 py-1.5 text-theme-text-muted whitespace-nowrap">{fmtDate(doc.date)}</td>
                          <td className="px-2.5 py-1.5"><span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", documentTone(doc.type))}>{doc.label}</span></td>
                          <td className="px-2.5 py-1.5 font-mono">{doc.number || doc.bsale_document_id}</td>
                          <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(doc.amount)}</td>
                          <td className="px-2.5 py-1.5 text-theme-text-muted truncate max-w-[220px]" title={doc.sellerName}>{doc.sellerName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function DocumentDetailModal({ detail, loading, error, onClose }: { detail: CommercialDocumentDetail | null; loading: boolean; error: string | null; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-theme-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Detalle documento</div>
            <h3 className="truncate text-base font-black text-theme-text">{detail ? `${detail.header.document_type_label} ${detail.header.number || detail.header.bsale_document_id}` : 'Cargando documento'}</h3>
            {detail && <div className="mt-0.5 text-xs text-theme-text-muted">{fmtDate(detail.header.emission_date)} · {detail.header.client_name || 'Cliente no identificado'} · Vendedor certificado: {detail.header.seller_name}</div>}
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text" aria-label="Cerrar detalle documento"><X className="w-4 h-4" /></button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4">
          {loading && <LoadingState />}
          {error && <EmptyState>{error}</EmptyState>}
          {!loading && !error && detail && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <Metric label="Neto" value={fmtMoney(detail.header.net_amount)} />
                <Metric label="IVA" value={fmtMoney(detail.header.tax_amount)} />
                <Metric label="Exento" value={fmtMoney(detail.header.exempt_amount)} />
                <Metric label="Descuento" value={fmtMoney(detail.header.discount_amount)} />
                <Metric label="Total" value={fmtMoney(detail.header.total_amount)} tone="text-sky-600 dark:text-sky-300" />
              </div>

              <div className="overflow-x-auto rounded-xl border border-theme-border/70 bg-theme-bg/20">
                <table className="w-full min-w-[820px] text-xs">
                  <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
                    <tr>
                      <th className="px-2.5 py-1.5 text-left font-bold">#</th>
                      <th className="px-2.5 py-1.5 text-left font-bold">SKU</th>
                      <th className="px-2.5 py-1.5 text-left font-bold">Producto</th>
                      <th className="px-2.5 py-1.5 text-left font-bold">Formato</th>
                      <th className="px-2.5 py-1.5 text-right font-bold">Cant.</th>
                      <th className="px-2.5 py-1.5 text-right font-bold">Precio unit.</th>
                      <th className="px-2.5 py-1.5 text-right font-bold">Descuento</th>
                      <th className="px-2.5 py-1.5 text-right font-bold">Total línea</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border/60">
                    {detail.items.map(item => (
                      <tr key={item.bsale_detail_id} className="text-theme-text">
                        <td className="px-2.5 py-1.5 text-theme-text-muted">{item.line_number ?? '—'}</td>
                        <td className="px-2.5 py-1.5 font-mono text-theme-text-muted">{item.sku || 'Sin SKU'}</td>
                        <td className="px-2.5 py-1.5 min-w-[260px] font-medium">{item.description || 'Producto sin nombre'}</td>
                        <td className="px-2.5 py-1.5 text-theme-text-muted whitespace-nowrap">{item.format || '—'}</td>
                        <td className="px-2.5 py-1.5 text-right">{item.quantity.toLocaleString('es-CL')}</td>
                        <td className="px-2.5 py-1.5 text-right">{fmtMoney(item.net_unit_value || item.total_unit_value)}</td>
                        <td className="px-2.5 py-1.5 text-right text-theme-text-muted">{fmtMoney(item.net_discount)}</td>
                        <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(item.total_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap justify-end gap-3 text-xs text-theme-text-muted">
                <span>Líneas: <b className="text-theme-text">{detail.totals.lines}</b></span>
                <span>Unidades: <b className="text-theme-text">{detail.totals.units.toLocaleString('es-CL')}</b></span>
                <span>Subtotal: <b className="text-theme-text">{fmtMoney(detail.totals.subtotal)}</b></span>
                <span>Impuestos: <b className="text-theme-text">{fmtMoney(detail.totals.taxes)}</b></span>
                <span>Total: <b className="text-theme-text">{fmtMoney(detail.totals.total)}</b></span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryTab({ customer, alerts, noSeller, onOpenMetric }: { customer: CommercialCustomerExplorer; alerts: { label: string; tone: string }[]; noSeller: boolean; onOpenMetric: MetricOpenHandler }) {
  return (
    <div className="space-y-4">
      <Section title="Ventas oficiales">
        <div className="rounded-xl border border-theme-border/70 bg-theme-bg/25 p-2.5 space-y-2">
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
            <Metric label="Venta mes actual" value={fmtMoney(customer.official_sales_current_month_net)} hint="facturas - notas de crédito" tone="text-sky-700 dark:text-sky-300" featured onOpen={() => onOpenMetric('current_month_sales')} />
            <Metric label="Venta oficial total" value={fmtMoney(customer.official_sales_total)} onOpen={() => onOpenMetric('official_sales_total')} />
            <Metric label="Venta 90d" value={fmtMoney(customer.official_sales_90d)} tone="text-blue-500" onOpen={() => onOpenMetric('official_sales_90d')} />
            <Metric label="Venta 180d" value={fmtMoney(customer.official_sales_180d)} onOpen={() => onOpenMetric('official_sales_180d')} />
            <Metric label="Facturas totales" value={String(customer.official_invoice_docs_total)} onOpen={() => onOpenMetric('invoices_total')} />
            <Metric label="Ticket promedio" value={fmtMoney(customer.avg_ticket_gross_total)} onOpen={() => onOpenMetric('avg_ticket')} />
          </div>
          <div className="text-[10px] text-theme-text-muted/45">Mes actual bruto {fmtMoney(customer.official_sales_current_month_gross)} · NC mes {fmtMoney(customer.credit_notes_current_month)} · Última factura {fmtDate(customer.last_invoice_date)} · {customer.days_since_last_invoice != null ? `${customer.days_since_last_invoice} días sin compra` : 'sin fecha de última factura'}</div>
        </div>
      </Section>

      <Section title="Correcciones / Notas de crédito">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
          <Metric label="NC total monto" value={fmtMoney(customer.credit_note_amount_total)} tone={customer.credit_note_count_total > 0 ? 'text-red-400' : 'text-theme-text'} onOpen={() => onOpenMetric('credit_notes_total')} />
          <Metric label="NC total cantidad" value={String(customer.credit_note_count_total)} />
          <Metric label="NC mes actual" value={fmtMoney(customer.credit_notes_current_month)} hint="incluida en venta neta" tone={customer.credit_notes_current_month > 0 ? 'text-red-400' : 'text-theme-text'} />
          <Metric label="NC 90d" value={String(customer.credit_note_count_90d)} hint={fmtMoney(customer.credit_note_amount_90d)} onOpen={() => onOpenMetric('credit_notes_90d')} />
        </div>
      </Section>

      <Section title="Pedidos operativos">
        <div className="rounded-xl border border-theme-border/70 bg-theme-bg/25 p-2.5 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="NV 90d cantidad" value={String(customer.sales_order_count_90d)} onOpen={() => onOpenMetric('sales_orders_90d')} />
            <Metric label="NV 90d monto" value={fmtMoney(customer.sales_order_amount_90d)} onOpen={() => onOpenMetric('sales_orders_90d')} />
          </div>
          <div className="text-[10px] text-theme-text-muted/45">Nota de Venta es pedido operativo; no suma como venta oficial.</div>
        </div>
      </Section>

      <Section title="Comportamiento del cliente">
        <div className="rounded-lg border border-dashed border-theme-border/70 bg-theme-bg/15 px-2.5 py-1.5 text-[10px] text-theme-text-muted/55">Detalle ampliado disponible en Compras y Documentos.</div>
      </Section>

      <Section title="Contacto y ubicación">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <InfoRow label="Email" value={customer.email} icon={<Mail className="w-3.5 h-3.5" />} />
          <InfoRow label="Teléfono / móvil" value={[customer.phone, customer.mobile].filter(Boolean).join(' / ')} icon={<Phone className="w-3.5 h-3.5" />} />
          <InfoRow label="Dirección" value={customer.address} icon={<MapPin className="w-3.5 h-3.5" />} />
          <InfoRow label="Comuna / ciudad" value={[customer.commune, customer.city].filter(Boolean).join(', ')} icon={<MapPin className="w-3.5 h-3.5" />} />
          <InfoRow label="Región" value={customer.region} />
          <InfoRow label="Giro" value={customer.business_activity} />
        </div>
      </Section>

      <Section title="Vendedor comercial">
        <div className="rounded-xl border border-theme-border/70 bg-theme-bg/25 p-2.5 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-md border px-2 py-0.5 text-[10px] font-bold", noSeller ? "border-slate-400/20 bg-slate-500/5 text-slate-400" : "border-emerald-400/20 bg-emerald-500/5 text-emerald-400")}>{noSeller ? 'Sin vendedor identificado' : 'Certificado desde Bsale'}</span>
            <span className="text-[10px] text-theme-text-muted/55">Fuente: vendedores por documento Bsale</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <InfoRow label="Vendedor principal" value={customer.main_seller_name || 'No identificado'} />
            <InfoRow label="Último vendedor" value={customer.last_seller_name || 'No identificado'} />
          </div>
        </div>
      </Section>

      <Section title="Alertas simples">
        <div className="flex flex-wrap gap-1.5">
          {alerts.length > 0 ? alerts.map(alert => <AlertBadge key={alert.label} tone={alert.tone}>{alert.label}</AlertBadge>) : <AlertBadge tone="border-emerald-500/20 bg-emerald-500/10 text-emerald-500">Sin alertas comerciales críticas</AlertBadge>}
        </div>
      </Section>

      <Section title="Estado de datos">
        <div className="rounded-xl border border-theme-border/70 bg-theme-bg/35 px-3 py-2 text-xs text-theme-text-muted flex items-start gap-2">
          <CalendarDays className="w-4 h-4 mt-0.5 opacity-60" />
          <div>
            <div>Última actualización comercial: <span className="text-theme-text">{fmtDateTime(customer.snapshot_calculated_at)}</span></div>
            <div className="mt-0.5 text-[11px] text-theme-text-muted/55 flex items-center gap-1"><TrendingUp className="w-3 h-3" />Datos calculados desde Bsale y métricas comerciales PetGrup</div>
          </div>
        </div>
      </Section>
    </div>
  )
}

function PurchasesTab({ behavior, loading, error }: { behavior: CommercialCustomerBehavior | null; loading: boolean; error: string | null }) {
  if (loading) return <LoadingState />
  if (error) return <EmptyState>{error}</EmptyState>
  if (!behavior) return <EmptyState>Selecciona esta pestaña para cargar comportamiento.</EmptyState>

  const summary = behavior.behaviorSummary

  return (
    <div className="space-y-4">
      <Section title="Comportamiento 12 meses">
        <div className="grid grid-cols-2 xl:grid-cols-5 gap-2">
          <Metric label="Venta neta 12m" value={fmtMoney(summary.totalNetSales12m)} tone="text-sky-400" />
          <Metric label="Facturas 12m" value={String(summary.invoices12m)} />
          <Metric label="Ticket promedio 12m" value={fmtMoney(summary.avgTicket12m)} />
          <Metric label="NC 12m" value={String(summary.creditNotes12m)} hint={fmtMoney(summary.totalCreditNotes12m)} tone={summary.totalCreditNotes12m > 0 ? 'text-red-400' : 'text-theme-text'} />
          <Metric label="NV 12m" value={String(summary.salesOrders12m)} />
        </div>
        <div className="rounded-lg border border-theme-border/60 bg-theme-bg/20 px-2.5 py-1.5 text-[10px] text-theme-text-muted">Tendencia: <span className="font-semibold text-theme-text">{summary.trendLabel}</span> · Mejor mes: {summary.bestMonth || 'Sin dato'} · Última factura: {fmtDate(summary.lastInvoiceDate)}</div>
      </Section>

      <Section title="Evolución mensual">
        <div className="overflow-x-auto rounded-xl border border-theme-border/70 bg-theme-bg/20">
          <table className="w-full min-w-[680px] text-xs">
            <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-bold">Mes</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Facturas</th>
                <th className="px-2.5 py-1.5 text-right font-bold">NC</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Venta neta</th>
                <th className="px-2.5 py-1.5 text-right font-bold">NV</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Ticket</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {behavior.monthlyEvolution.map(month => (
                <tr key={month.month} className="text-theme-text">
                  <td className="px-2.5 py-1.5 font-semibold capitalize">{month.monthLabel}</td>
                  <td className="px-2.5 py-1.5 text-right">{month.invoiceCount} · {fmtMoney(month.invoiceGrossAmount)}</td>
                  <td className="px-2.5 py-1.5 text-right text-theme-text-muted">{month.creditNoteCount} · {fmtMoney(month.creditNoteAmount)}</td>
                  <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(month.netSalesAmount)}</td>
                  <td className="px-2.5 py-1.5 text-right text-theme-text-muted">{month.salesOrderCount} · {fmtMoney(month.salesOrderAmount)}</td>
                  <td className="px-2.5 py-1.5 text-right text-theme-text-muted">{fmtMoney(month.avgTicket)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <MiniDocumentTable title="Últimas facturas" documents={behavior.recentInvoices} />
      <MiniDocumentTable title="Últimas notas de crédito" documents={behavior.recentCreditNotes} />
    </div>
  )
}

function QuantityChart({ mix }: { mix: CommercialCustomerPurchaseMix }) {
  const maxMonthlyAmount = Math.max(...mix.monthlyQuantityEvolution.map(month => month.netSalesAmount || 0), 0)

  if (maxMonthlyAmount === 0) {
    return (
      <Section title="Comportamiento mensual de compra">
        <EmptyState>Sin compras facturadas en el período.</EmptyState>
      </Section>
    )
  }

  return (
    <Section title="Comportamiento mensual de compra">
      <div className="rounded-xl border border-theme-border/70 bg-theme-bg/20 p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-theme-text-muted/55">
          <span>Monto facturado mensual según facturas oficiales Bsale. Escala ajustada al cliente.</span>
          <span className="font-semibold text-theme-text-muted">Máximo mensual: {fmtMoney(maxMonthlyAmount)}</span>
        </div>
        <div className="flex h-40 items-end gap-1.5 border-b border-theme-border/60 pb-2">
          {mix.monthlyQuantityEvolution.map(month => {
            const hasAmount = month.netSalesAmount > 0
            const height = hasAmount ? Math.max(8, Math.round((month.netSalesAmount / maxMonthlyAmount) * 100)) : 0
            return (
              <div key={month.month} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <div className="text-[9px] font-semibold text-theme-text opacity-0 transition-opacity group-hover:opacity-100">{fmtCompactMoney(month.netSalesAmount)}</div>
                <div
                  className={cn("w-full max-w-8 rounded-t-md border transition-colors", hasAmount ? "border-sky-600/30 bg-sky-600/35 dark:border-sky-400/25 dark:bg-sky-400/25 group-hover:bg-sky-600/50 dark:group-hover:bg-sky-400/40" : "h-1 border-theme-border/60 bg-theme-text/5")}
                  style={hasAmount ? { height: `${height}%` } : undefined}
                  title={`${month.monthLabel}: ${fmtMoney(month.netSalesAmount)} · ${month.totalUnits.toLocaleString('es-CL')} un. · ${month.invoiceCount} facturas`}
                />
              </div>
            )
          })}
        </div>
        <div className="mt-2 grid grid-cols-12 gap-1 text-center text-[9px] text-theme-text-muted/65">
          {mix.monthlyQuantityEvolution.map(month => (
            <div key={month.month} className="min-w-0">
              <div className="truncate capitalize">{month.monthLabel.split(' ')[0]}</div>
              <div className="truncate font-semibold text-theme-text-muted/75">{fmtCompactMoney(month.netSalesAmount)}</div>
              <div className="truncate text-theme-text-muted/45">{month.totalUnits.toLocaleString('es-CL')} un.</div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[10px] text-theme-text-muted/50">Unidades facturadas por mes como dato secundario. Meses sin compra se muestran en cero.</div>
      </div>
    </Section>
  )
}

function ProductRankingTable({ title, products }: { title: string; products: CommercialCustomerPurchaseMixProduct[] }) {
  return (
    <Section title={title}>
      {products.length === 0 ? <EmptyState>Sin productos para mostrar.</EmptyState> : (
        <div className="overflow-x-auto rounded-xl border border-theme-border/70 bg-theme-bg/20">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-bold">Producto</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Formatos</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Unidades</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Monto</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Facturas</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Última compra</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {products.map(product => (
                <tr key={`${product.sku}-${product.productName}`} className="text-theme-text">
                  <td className="px-2.5 py-1.5 min-w-[240px]">
                    <div className="font-semibold">{product.productName}</div>
                    <div className="font-mono text-[10px] text-theme-text-muted/60">{product.sku || 'Sin SKU'}</div>
                  </td>
                  <td className="px-2.5 py-1.5 text-theme-text-muted max-w-[160px] truncate" title={product.formats.join(', ')}>{product.formats.join(', ') || '—'}</td>
                  <td className="px-2.5 py-1.5 text-right font-semibold">{product.totalUnits.toLocaleString('es-CL')}</td>
                  <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(product.totalAmount)}</td>
                  <td className="px-2.5 py-1.5 text-right text-theme-text-muted">{product.invoiceCount}</td>
                  <td className="px-2.5 py-1.5 text-theme-text-muted whitespace-nowrap">{fmtDate(product.lastPurchaseDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function StaleProductsTable({ products }: { products: CommercialCustomerPurchaseMixProduct[] }) {
  return (
    <Section title="Productos sin recompra">
      <div className="mb-2 text-[10px] text-theme-text-muted/55">Productos comprados antes, sin recompra en más de 90 días.</div>
      {products.length === 0 ? <EmptyState>No hay productos sin recompra para este rango.</EmptyState> : (
        <div className="overflow-x-auto rounded-xl border border-theme-border/70 bg-theme-bg/20">
          <table className="w-full min-w-[680px] text-xs">
            <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-bold">Producto</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Última compra</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Días</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Unidades</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {products.map(product => (
                <tr key={`stale-${product.sku}-${product.productName}`} className="text-theme-text">
                  <td className="px-2.5 py-1.5 font-semibold">{product.productName}</td>
                  <td className="px-2.5 py-1.5 text-theme-text-muted">{fmtDate(product.lastPurchaseDate)}</td>
                  <td className="px-2.5 py-1.5 text-right text-theme-text-muted">{product.daysSinceLastPurchase ?? '—'}</td>
                  <td className="px-2.5 py-1.5 text-right">{product.totalUnits.toLocaleString('es-CL')}</td>
                  <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(product.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function RecentProductActivity({ mix }: { mix: CommercialCustomerPurchaseMix }) {
  return (
    <Section title="Actividad reciente">
      {mix.recentProductActivity.length === 0 ? <EmptyState>Sin actividad reciente de productos.</EmptyState> : (
        <div className="overflow-x-auto rounded-xl border border-theme-border/70 bg-theme-bg/20">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-bold">Fecha</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Factura</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Producto</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Formato</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Cant.</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {mix.recentProductActivity.slice(0, 10).map((item, index) => (
                <tr key={`${item.date}-${item.invoiceNumber}-${item.sku}-${index}`} className="text-theme-text">
                  <td className="px-2.5 py-1.5 text-theme-text-muted whitespace-nowrap">{fmtDate(item.date)}</td>
                  <td className="px-2.5 py-1.5 font-mono">{item.invoiceNumber || '—'}</td>
                  <td className="px-2.5 py-1.5 min-w-[240px]"><div className="font-semibold">{item.productName}</div><div className="font-mono text-[10px] text-theme-text-muted/60">{item.sku}</div></td>
                  <td className="px-2.5 py-1.5 text-theme-text-muted">{item.format || '—'}</td>
                  <td className="px-2.5 py-1.5 text-right">{item.quantity.toLocaleString('es-CL')}</td>
                  <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(item.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function PurchaseMixTab({ mix, loading, error }: { mix: CommercialCustomerPurchaseMix | null; loading: boolean; error: string | null }) {
  const [rankingMode, setRankingMode] = useState<'amount' | 'units'>('amount')

  if (loading) return <LoadingState />
  if (error) return <EmptyState>{error}</EmptyState>
  if (!mix) return <EmptyState>Selecciona esta pestaña para cargar el mix de compra.</EmptyState>
  if (mix.mixSummary.totalProducts === 0) return <EmptyState>Sin facturas con productos para este cliente.</EmptyState>

  const ranking = rankingMode === 'amount' ? mix.topProductsByAmount : mix.topProductsByUnits

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-theme-border/60 bg-theme-bg/20 px-2.5 py-1.5 text-[10px] text-theme-text-muted">Basado en facturas oficiales Bsale. No incluye notas de venta ni descuenta notas de crédito por producto en esta versión.</div>
      <Section title="Resumen mix de compra">
        <div className="grid grid-cols-2 xl:grid-cols-5 gap-2">
          <Metric label="Productos distintos" value={String(mix.mixSummary.totalProducts)} />
          <Metric label="Unidades 12m" value={mix.mixSummary.totalUnits12m.toLocaleString('es-CL')} />
          <Metric label="Monto facturado 12m" value={fmtMoney(mix.mixSummary.totalAmount12m)} tone="text-sky-600 dark:text-sky-300" />
          <Metric label="Meses con compra" value={String(mix.mixSummary.monthsWithPurchases)} />
          <Metric label="Producto principal" value={mix.mixSummary.topProductSharePercent + '%'} hint={mix.mixSummary.topProductName || 'Sin dato'} />
        </div>
      </Section>
      <QuantityChart mix={mix} />
      <Section title="Ranking productos">
        <div className="mb-2 flex gap-1.5">
          <button onClick={() => setRankingMode('amount')} className={cn("rounded-md border px-2 py-0.5 text-[10px] font-semibold", rankingMode === 'amount' ? "border-theme-text/20 bg-theme-text/10 text-theme-text" : "border-theme-border bg-theme-bg/20 text-theme-text-muted hover:text-theme-text")}>Top por monto</button>
          <button onClick={() => setRankingMode('units')} className={cn("rounded-md border px-2 py-0.5 text-[10px] font-semibold", rankingMode === 'units' ? "border-theme-text/20 bg-theme-text/10 text-theme-text" : "border-theme-border bg-theme-bg/20 text-theme-text-muted hover:text-theme-text")}>Top por unidades</button>
        </div>
        <ProductRankingTable title={rankingMode === 'amount' ? 'Top productos por monto' : 'Top productos por unidades'} products={ranking} />
      </Section>
      <StaleProductsTable products={mix.staleProducts} />
      <RecentProductActivity mix={mix} />
    </div>
  )
}

function ReceivablesChart({ receivables }: { receivables: CommercialCustomerReceivables }) {
  const months = receivables.monthlyBehavior
  const [hoveredMonth, setHoveredMonth] = useState<string | null>(null)
  const [pinnedMonth, setPinnedMonth] = useState<string | null>(null)
  const maxValue = Math.max(...months.flatMap(month => [month.invoiced_amount, month.paid_amount]), 0)
  const activeMonth = months.find(month => month.month === (pinnedMonth || hoveredMonth)) || months[months.length - 1]
  const activeIndex = activeMonth ? months.findIndex(month => month.month === activeMonth.month) : -1
  const activeX = activeIndex >= 0 ? (months.length === 1 ? 50 : (activeIndex / (months.length - 1)) * 100) : 50

  if (months.length === 0) return <EmptyState>Sin comportamiento mensual de cobranza para mostrar.</EmptyState>

  const buildPoints = (key: 'invoiced_amount' | 'paid_amount') => months.map((month, index) => {
    const x = months.length === 1 ? 50 : (index / (months.length - 1)) * 100
    const y = maxValue > 0 ? 38 - (month[key] / maxValue) * 32 : 38
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')

  return (
    <Section title="Facturado vs Pagado">
      <div className="rounded-xl border border-theme-border/70 bg-gradient-to-br from-theme-bg/50 to-theme-surface p-3 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-theme-text-muted/55">
          <span>Facturado por fecha de emisión; pagado por fecha real de pago.</span>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" />Facturado</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />Pagado</span>
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_190px]">
        <div className="relative">
        <svg viewBox="0 0 100 42" className="h-44 w-full overflow-visible" onMouseLeave={() => setHoveredMonth(null)}>
          {[6, 14, 22, 30, 38].map(y => <line key={y} x1="0" y1={y} x2="100" y2={y} className="stroke-theme-border/60" strokeWidth="0.22" />)}
          <line x1="0" y1="38" x2="100" y2="38" className="stroke-theme-border" strokeWidth="0.5" />
          <polyline points={buildPoints('invoiced_amount')} fill="none" stroke="rgb(2 132 199)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={buildPoints('paid_amount')} fill="none" stroke="rgb(5 150 105)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          {months.map((month, index) => {
            const x = months.length === 1 ? 50 : (index / (months.length - 1)) * 100
            const invoiceY = maxValue > 0 ? 38 - (month.invoiced_amount / maxValue) * 32 : 38
            const paidY = maxValue > 0 ? 38 - (month.paid_amount / maxValue) * 32 : 38
            const active = activeMonth?.month === month.month
            return (
              <g key={month.month} onMouseEnter={() => setHoveredMonth(month.month)} onClick={() => setPinnedMonth(pinnedMonth === month.month ? null : month.month)} className="cursor-pointer">
                {active && <line x1={x} y1="5" x2={x} y2="38" stroke="currentColor" className="text-theme-text-muted/30" strokeWidth="0.35" strokeDasharray="1 1" />}
                <circle cx={x} cy={invoiceY} r={active ? '1.9' : '1.35'} fill="rgb(2 132 199)" stroke="var(--theme-surface)" strokeWidth="0.45" />
                <circle cx={x} cy={paidY} r={active ? '1.9' : '1.35'} fill="rgb(5 150 105)" stroke="var(--theme-surface)" strokeWidth="0.45" />
              </g>
            )
          })}
        </svg>
        {hoveredMonth && activeMonth && (
          <div
            className="pointer-events-none absolute top-3 z-10 min-w-[180px] rounded-xl border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text shadow-xl"
            style={{ left: `${activeX}%`, transform: activeX > 72 ? 'translateX(-100%)' : activeX < 18 ? 'translateX(0)' : 'translateX(-50%)' }}
          >
            <div className="font-black capitalize">{activeMonth.monthLabel}</div>
            <div className="mt-1.5 space-y-1">
              <div className="flex justify-between gap-3"><span className="text-theme-text-muted">Facturado</span><b className="text-sky-600 dark:text-sky-300">{fmtMoney(activeMonth.invoiced_amount)}</b></div>
              <div className="flex justify-between gap-3"><span className="text-theme-text-muted">Pagado</span><b className="text-emerald-600 dark:text-emerald-300">{fmtMoney(activeMonth.paid_amount)}</b></div>
              <div className="flex justify-between gap-3 border-t border-theme-border/60 pt-1"><span className="text-theme-text-muted">Diferencia</span><b>{fmtSignedMoney(activeMonth.net_cash_gap)}</b></div>
            </div>
          </div>
        )}
        </div>
        {activeMonth && (
          <div className="rounded-xl border border-theme-border/70 bg-theme-bg/45 p-3 text-xs shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">{pinnedMonth ? 'Mes fijado' : 'Mes destacado'}</div>
            <div className="mt-1 text-sm font-black capitalize text-theme-text">{activeMonth.monthLabel}</div>
            <div className="mt-2 space-y-1.5">
              <div className="flex justify-between gap-3"><span className="text-theme-text-muted">Facturado</span><b className="text-sky-600 dark:text-sky-300">{fmtMoney(activeMonth.invoiced_amount)}</b></div>
              <div className="flex justify-between gap-3"><span className="text-theme-text-muted">Pagado</span><b className="text-emerald-600 dark:text-emerald-300">{fmtMoney(activeMonth.paid_amount)}</b></div>
              <div className="flex justify-between gap-3 border-t border-theme-border/60 pt-1.5"><span className="text-theme-text-muted">Diferencia</span><b className={activeMonth.net_cash_gap > 0 ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300'}>{fmtSignedMoney(activeMonth.net_cash_gap)}</b></div>
            </div>
            <div className="mt-2 text-[10px] text-theme-text-muted/50">Click en un punto para fijar/liberar.</div>
          </div>
        )}
        </div>
        <div className="mt-2 grid grid-cols-6 gap-1 text-center text-[9px] text-theme-text-muted/65 sm:grid-cols-12">
          {months.map(month => (
            <div key={month.month} className="min-w-0">
              <div className="truncate capitalize">{month.monthLabel.split(' ')[0]}</div>
              <div className="truncate font-semibold text-sky-500">{fmtCompactMoney(month.invoiced_amount)}</div>
              <div className="truncate text-emerald-500">{fmtCompactMoney(month.paid_amount)}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 rounded-lg border border-theme-border-accent bg-theme-accent-muted px-2.5 py-1.5 text-[10px] text-theme-text">Pagos disponibles desde backfill/sync actual. El histórico puede estar incompleto.</div>
      </div>
    </Section>
  )
}

function ReceivableInvoicesTable({ invoices }: { invoices: CommercialCustomerReceivablesInvoice[] }) {
  const [filter, setFilter] = useState<ReceivableFilter>('all')
  const filters: { key: ReceivableFilter; label: string }[] = [
    { key: 'all', label: 'Todas' },
    { key: 'pending', label: 'Pendientes' },
    { key: 'overdue', label: 'Vencidas' },
    { key: 'paid', label: 'Pagadas' },
  ]
  const filtered = invoices.filter(invoice => {
    if (filter === 'all') return true
    if (filter === 'pending') return invoice.pending_amount > 0
    if (filter === 'overdue') return invoice.receivable_status === 'VENCIDA'
    return invoice.receivable_status === 'PAGADA'
  })

  return (
    <Section title="Detalle facturas">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {filters.map(item => (
          <button key={item.key} onClick={() => setFilter(item.key)} className={cn("rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors", filter === item.key ? "border-theme-text/20 bg-theme-text/10 text-theme-text" : "border-theme-border bg-theme-bg/20 text-theme-text-muted hover:text-theme-text")}>{item.label}</button>
        ))}
      </div>
      {filtered.length === 0 ? <EmptyState>No hay facturas para este filtro.</EmptyState> : (
        <div className="overflow-x-auto rounded-xl border border-theme-border/70 bg-theme-bg/20">
          <table className="w-full min-w-[840px] text-xs">
            <thead className="bg-theme-text/[0.025] text-[10px] uppercase tracking-wide text-theme-text-muted/60">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-bold">Factura</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Emisión</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Vencimiento</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Total</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Pagado</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Pendiente</th>
                <th className="px-2.5 py-1.5 text-right font-bold">Días vencido</th>
                <th className="px-2.5 py-1.5 text-left font-bold">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {filtered.map(invoice => (
                <tr key={invoice.bsale_document_id} className="text-theme-text">
                  <td className="px-2.5 py-1.5 font-mono">{invoice.document_number || invoice.bsale_document_id}</td>
                  <td className="px-2.5 py-1.5 text-theme-text-muted whitespace-nowrap">{fmtDate(invoice.emission_date)}</td>
                  <td className="px-2.5 py-1.5 text-theme-text-muted whitespace-nowrap">{fmtDate(invoice.expiration_date)}</td>
                  <td className="px-2.5 py-1.5 text-right font-semibold">{fmtMoney(invoice.total_amount)}</td>
                  <td className="px-2.5 py-1.5 text-right text-emerald-700 dark:text-emerald-300">{fmtMoney(invoice.paid_amount)}</td>
                  <td className={cn("px-2.5 py-1.5 text-right font-semibold", invoice.pending_amount > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300')}>{fmtMoney(invoice.pending_amount)}</td>
                  <td className="px-2.5 py-1.5 text-right text-theme-text-muted">{invoice.days_overdue > 0 ? invoice.days_overdue : '—'}</td>
                  <td className="px-2.5 py-1.5"><span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-bold", receivableStatusTone(invoice.receivable_status))}>{statusLabel(invoice.receivable_status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function ReceivablesTab({ receivables, loading, error }: { receivables: CommercialCustomerReceivables | null; loading: boolean; error: string | null }) {
  if (loading) return <LoadingState />
  if (error) return <EmptyState>{error}</EmptyState>
  if (!receivables) return <EmptyState>Selecciona esta pestaña para cargar pagos y cobranza.</EmptyState>
  if (!receivables.summary) return <EmptyState>Sin datos de cobranza para este cliente.</EmptyState>

  const summary = receivables.summary
  const internal = summary.is_internal_account || summary.exclude_from_external_reports
  const avgDays = summary.avg_days_to_pay == null ? 'Sin dato' : `${Math.round(summary.avg_days_to_pay)} días`
  const hasRecentPayments = receivables.monthlyBehavior.some(month => month.paid_amount > 0)

  return (
    <div className="space-y-4">
      {internal && (
        <div className="rounded-xl border border-theme-border-accent bg-theme-accent-muted px-3 py-2.5 text-xs text-theme-text shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-black uppercase tracking-wide">Cuenta interna / Tienda propia</div>
            {!summary.is_commissionable && <span className="rounded-md border border-theme-border bg-theme-surface px-1.5 py-0.5 text-[10px] font-bold text-theme-text">No comisionable</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            <span className="text-theme-text-muted">Canal: <b className="text-theme-text">{summary.reporting_channel || 'Sin canal'}</b></span>
            <span className="text-theme-text-muted">Reporte: <b className="text-theme-text">{summary.reporting_seller_name || 'Sin responsable'}</b></span>
          </div>
        </div>
      )}

      <Section title="KPIs cobranza">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
          <Metric label="Facturado" value={fmtMoney(summary.total_invoiced)} tone="text-sky-600 dark:text-sky-300" />
          <Metric label="Pagado" value={fmtMoney(summary.total_paid)} tone="text-emerald-700 dark:text-emerald-300" />
          <Metric label="Pendiente" value={fmtMoney(summary.total_pending)} tone={summary.total_pending > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'} featured={summary.total_pending > 0} />
          <Metric label="Vencido" value={fmtMoney(summary.overdue_amount)} tone={summary.overdue_amount > 0 ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'} />
          <Metric label="Facturas pendientes" value={String(summary.pending_invoices_count)} />
          <Metric label="Facturas vencidas" value={String(summary.overdue_invoices_count)} tone={summary.overdue_invoices_count > 0 ? 'text-red-700 dark:text-red-300' : 'text-theme-text'} />
          <Metric label="Promedio días pago" value={avgDays} />
          <Metric label="Último pago" value={fmtDateTime(summary.last_payment_date)} />
        </div>
      </Section>

      <Section title="Análisis automático">
        <div className="rounded-xl border border-theme-border/70 bg-theme-bg/25 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-md border px-2 py-0.5 text-[10px] font-black", receivableStatusTone(summary.total_pending <= 0 ? 'PAGADA' : summary.overdue_amount > 0 ? 'VENCIDA' : 'PENDIENTE'))}>{statusLabel(summary.payment_behavior_label)}</span>
            <span className={cn("font-black", riskTone(summary.risk_status))}>Riesgo {statusLabel(summary.risk_status)}</span>
          </div>
          <div className="mt-2 text-theme-text-muted">{behaviorText(receivables)}</div>
          {!hasRecentPayments && <div className="mt-2 text-[10px] text-amber-600 dark:text-amber-300">Histórico de pagos incompleto: considerar backfill antes de conclusiones definitivas.</div>}
        </div>
      </Section>

      <ReceivablesChart receivables={receivables} />
      <ReceivableInvoicesTable invoices={receivables.invoices} />
    </div>
  )
}

function Client360DrawerContent({ customer, onClose, initialTab = 'summary' }: { customer: CommercialCustomerExplorer; onClose: () => void; initialTab?: Client360Tab }) {
  const [activeTab, setActiveTab] = useState<Client360Tab>(initialTab)
  const [behavior, setBehavior] = useState<CommercialCustomerBehavior | null>(null)
  const [behaviorError, setBehaviorError] = useState<string | null>(null)
  const [purchaseMix, setPurchaseMix] = useState<CommercialCustomerPurchaseMix | null>(null)
  const [purchaseMixError, setPurchaseMixError] = useState<string | null>(null)
  const [purchaseMixLoading, setPurchaseMixLoading] = useState(false)
  const [receivables, setReceivables] = useState<CommercialCustomerReceivables | null>(null)
  const [receivablesError, setReceivablesError] = useState<string | null>(null)
  const [receivablesLoading, setReceivablesLoading] = useState(false)
  const [metricDocuments, setMetricDocuments] = useState<CommercialCustomerMetricDocuments | null>(null)
  const [metricError, setMetricError] = useState<string | null>(null)
  const [metricLoading, setMetricLoading] = useState(false)
  const [showMetricModal, setShowMetricModal] = useState(false)
  const [documentDetail, setDocumentDetail] = useState<CommercialDocumentDetail | null>(null)
  const [documentDetailError, setDocumentDetailError] = useState<string | null>(null)
  const [documentDetailLoading, setDocumentDetailLoading] = useState(false)
  const [showDocumentDetail, setShowDocumentDetail] = useState(false)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (behavior || behaviorError || activeTab === 'summary' || activeTab === 'products' || activeTab === 'receivables') return
    startTransition(async () => {
      const result = await getCommercialCustomerBehavior({ bsaleClientId: customer.bsale_client_id, monthsBack: 12, limit: 20 })
      if ('error' in result) setBehaviorError(result.error)
      else setBehavior(result)
    })
  }, [activeTab, behavior, behaviorError, customer])

  useEffect(() => {
    if (activeTab !== 'receivables' || receivables || receivablesError || receivablesLoading) return
    const handle = setTimeout(() => {
      setReceivablesLoading(true)
      startTransition(async () => {
        const result = await getCommercialCustomerReceivables({ bsaleClientId: customer.bsale_client_id, monthsBack: 12, limit: 200 })
        if ('error' in result) setReceivablesError(result.error)
        else setReceivables(result)
        setReceivablesLoading(false)
      })
    }, 0)
    return () => clearTimeout(handle)
  }, [activeTab, customer.bsale_client_id, receivables, receivablesError, receivablesLoading])

  async function openMetricDocuments(metricKey: CommercialCustomerMetricKey) {
    setShowMetricModal(true)
    setMetricLoading(true)
    setMetricError(null)
    setMetricDocuments(null)
    const result = await getCommercialCustomerMetricDocuments({ bsaleClientId: customer.bsale_client_id, metricKey })
    if ('error' in result) setMetricError(result.error)
    else setMetricDocuments(result)
    setMetricLoading(false)
  }

  async function openDocumentDetail(bsaleDocumentId: number) {
    setShowDocumentDetail(true)
    setDocumentDetailLoading(true)
    setDocumentDetailError(null)
    setDocumentDetail(null)
    const result = await getCommercialDocumentDetail({ bsaleDocumentId })
    if ('error' in result) setDocumentDetailError(result.error)
    else setDocumentDetail(result)
    setDocumentDetailLoading(false)
  }

  function selectTab(tab: Client360Tab) {
    setActiveTab(tab)
    if (tab === 'products' && !purchaseMix && !purchaseMixError && !purchaseMixLoading) {
      setPurchaseMixLoading(true)
      startTransition(async () => {
        const result = await getCommercialCustomerPurchaseMix({ bsaleClientId: customer.bsale_client_id, monthsBack: 12, topLimit: 15 })
        if ('error' in result) setPurchaseMixError(result.error)
        else setPurchaseMix(result)
        setPurchaseMixLoading(false)
      })
    }
    if (tab === 'receivables' && !receivables && !receivablesError && !receivablesLoading) {
      setReceivablesLoading(true)
      startTransition(async () => {
        const result = await getCommercialCustomerReceivables({ bsaleClientId: customer.bsale_client_id, monthsBack: 12, limit: 200 })
        if ('error' in result) setReceivablesError(result.error)
        else setReceivables(result)
        setReceivablesLoading(false)
      })
    }
  }

  const lowQuality = customer.quality_score < 60
  const noSeller = !customer.main_seller_name && !customer.last_seller_name
  const noHistory = customer.status === 'SIN_VENTA_HISTORICA'
  const risky = customer.status === 'RIESGO' || customer.status === 'PERDIDO'
  const incompleteData = lowQuality || !customer.has_email || !customer.has_phone || !customer.has_address
  const alerts = [
    noHistory && { label: 'Sin venta histórica', tone: 'border-theme-border bg-theme-text/5 text-theme-text-muted' },
    risky && { label: 'Cliente en riesgo/perdido', tone: 'border-orange-400/30 bg-orange-500/10 text-orange-400' },
    customer.credit_note_count_total > 0 && { label: 'Con notas de crédito', tone: 'border-red-400/30 bg-red-500/10 text-red-400' },
    customer.has_anomalous_receipt && { label: 'Boleta anómala', tone: 'border-orange-400/30 bg-orange-500/10 text-orange-400' },
    incompleteData && { label: 'Datos incompletos', tone: 'border-amber-400/30 bg-amber-500/10 text-amber-400' },
    noSeller && { label: 'Sin vendedor identificado', tone: 'border-slate-400/30 bg-slate-500/10 text-slate-400' },
  ].filter(Boolean) as { label: string; tone: string }[]

  const tabs: { key: Client360Tab; label: string }[] = [
    { key: 'summary', label: 'Resumen' },
    { key: 'purchases', label: 'Compras' },
    { key: 'documents', label: 'Documentos' },
    { key: 'products', label: 'Mix de compra' },
    { key: 'receivables', label: 'Pagos / Cobranza' },
  ]

  return (
    <div className="fixed inset-0 z-[110] flex justify-end">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[1px] animate-in fade-in duration-150" onClick={onClose} />
      <aside className="relative h-full w-full md:w-[88vw] lg:w-[76vw] xl:w-[68vw] min-w-0 sm:min-w-[560px] max-w-[1280px] bg-theme-surface border-l border-theme-border shadow-2xl flex flex-col animate-in slide-in-from-right-full duration-300">
        <header className="shrink-0 border-b border-theme-border bg-theme-text/[0.015] px-5 pt-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] text-theme-text-muted font-semibold uppercase tracking-wider">
                Cliente 360
                <span className="rounded border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-400">Bsale</span>
              </div>
              <h2 className="mt-1 text-lg font-black text-theme-text truncate">{customer.business_name}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-theme-text-muted">
                <span className="font-mono">{customer.rut || 'Sin RUT'}</span>
                {customer.fantasy_name && <span>{customer.fantasy_name}</span>}
              </div>
            </div>
            <button onClick={onClose} className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text transition-colors" aria-label="Cerrar Cliente 360">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className={cn("inline-flex items-center px-2 py-1 rounded-md text-[11px] font-bold border", statusClass(customer.status))}>{statusLabel(customer.status)}</span>
            <span className={cn("inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold border", lowQuality ? "border-amber-400/30 bg-amber-500/10 text-amber-400" : "border-emerald-500/20 bg-emerald-500/10 text-emerald-500")}>
              <UserRoundCheck className="w-3 h-3" /> Calidad {customer.quality_score}%
            </span>
            {customer.credit_note_count_total > 0 && <AlertBadge tone="border-red-400/30 bg-red-500/10 text-red-400">NC</AlertBadge>}
            {customer.has_anomalous_receipt && <AlertBadge tone="border-orange-400/30 bg-orange-500/10 text-orange-400"><AlertTriangle className="w-3 h-3" />Boleta anómala</AlertBadge>}
          </div>

          <div className="mt-3 flex gap-0.5 overflow-x-auto border-t border-theme-border/60 pt-2">
            {tabs.map(tab => (
              <button key={tab.key} onClick={() => selectTab(tab.key)} className={cn("whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors", activeTab === tab.key ? "bg-theme-text/10 text-theme-text" : "text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text")}>
                {tab.label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-3.5">
          {activeTab === 'summary' && <SummaryTab customer={customer} alerts={alerts} noSeller={noSeller} onOpenMetric={openMetricDocuments} />}
          {activeTab === 'purchases' && <PurchasesTab behavior={behavior} loading={isPending} error={behaviorError} />}
          {activeTab === 'documents' && (isPending ? <LoadingState /> : behaviorError ? <EmptyState>{behaviorError}</EmptyState> : behavior ? <DocumentsTable documents={behavior.recentDocuments} onOpenDocument={openDocumentDetail} /> : <EmptyState>Selecciona esta pestaña para cargar documentos.</EmptyState>)}
          {activeTab === 'products' && <PurchaseMixTab mix={purchaseMix} loading={purchaseMixLoading} error={purchaseMixError} />}
          {activeTab === 'receivables' && <ReceivablesTab receivables={receivables} loading={receivablesLoading} error={receivablesError} />}
        </div>

        {showMetricModal && <MetricDocumentsModal data={metricDocuments} loading={metricLoading} error={metricError} onClose={() => setShowMetricModal(false)} onOpenDocument={openDocumentDetail} />}
        {showDocumentDetail && <DocumentDetailModal detail={documentDetail} loading={documentDetailLoading} error={documentDetailError} onClose={() => setShowDocumentDetail(false)} />}
      </aside>
    </div>
  )
}

export function Client360Drawer({ customer, onClose, initialTab = 'summary' }: { customer: CommercialCustomerExplorer | null; onClose: () => void; initialTab?: Client360Tab }) {
  if (!customer) return null
  return <Client360DrawerContent key={`${customer.bsale_client_id}-${initialTab}`} customer={customer} onClose={onClose} initialTab={initialTab} />
}
