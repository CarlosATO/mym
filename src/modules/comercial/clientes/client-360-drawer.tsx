"use client"

import { useEffect, useState, useTransition } from 'react'
import { AlertTriangle, CalendarDays, Mail, MapPin, Phone, TrendingUp, UserRoundCheck, X } from 'lucide-react'
import { getCommercialCustomerBehavior, getCommercialCustomerMetricDocuments, getCommercialDocumentDetail, type CommercialCustomerBehavior, type CommercialCustomerBehaviorDocument, type CommercialCustomerMetricDocuments, type CommercialCustomerMetricKey, type CommercialDocumentDetail } from '@/app/actions/comercial/customers'
import type { CommercialCustomerExplorer } from '@/app/actions/comercial/customers'
import { cn } from '@/lib/utils'

type Client360Tab = 'summary' | 'purchases' | 'documents' | 'products'
type DocumentFilter = 'all' | 'invoice' | 'sales_order' | 'credit_note'
type MetricOpenHandler = (metricKey: CommercialCustomerMetricKey) => void
type DocumentOpenHandler = (bsaleDocumentId: number) => void

function fmtMoney(value: number | null | undefined) {
  const n = Number(value || 0)
  if (n === 0) return '$0'
  return '$' + n.toLocaleString('es-CL', { maximumFractionDigits: 0 })
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

function ProductsPlaceholder() {
  const blocks = ['Productos más comprados', 'Proveedores principales', 'Productos sin recompra']

  return (
    <div className="rounded-xl border border-dashed border-theme-border/70 bg-theme-bg/20 px-4 py-6 text-center">
      <div className="text-sm font-bold text-theme-text">Mix de compra</div>
      <div className="mx-auto mt-2 max-w-md text-xs leading-5 text-theme-text-muted">Próxima etapa: análisis por productos, proveedores, categorías, frecuencia y recompra.</div>
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2 text-left">
        {blocks.map(block => (
          <div key={block} className="rounded-lg border border-theme-border/60 bg-theme-bg/20 px-3 py-2 opacity-70">
            <div className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted/60">Preparado</div>
            <div className="mt-1 text-xs font-semibold text-theme-text">{block}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Client360DrawerContent({ customer, onClose }: { customer: CommercialCustomerExplorer; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<Client360Tab>('summary')
  const [behavior, setBehavior] = useState<CommercialCustomerBehavior | null>(null)
  const [behaviorError, setBehaviorError] = useState<string | null>(null)
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
    if (behavior || behaviorError || activeTab === 'summary' || activeTab === 'products') return
    startTransition(async () => {
      const result = await getCommercialCustomerBehavior({ bsaleClientId: customer.bsale_client_id, monthsBack: 12, limit: 20 })
      if ('error' in result) setBehaviorError(result.error)
      else setBehavior(result)
    })
  }, [activeTab, behavior, behaviorError, customer])

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
              <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={cn("whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors", activeTab === tab.key ? "bg-theme-text/10 text-theme-text" : "text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text")}>
                {tab.label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-3.5">
          {activeTab === 'summary' && <SummaryTab customer={customer} alerts={alerts} noSeller={noSeller} onOpenMetric={openMetricDocuments} />}
          {activeTab === 'purchases' && <PurchasesTab behavior={behavior} loading={isPending} error={behaviorError} />}
          {activeTab === 'documents' && (isPending ? <LoadingState /> : behaviorError ? <EmptyState>{behaviorError}</EmptyState> : behavior ? <DocumentsTable documents={behavior.recentDocuments} onOpenDocument={openDocumentDetail} /> : <EmptyState>Selecciona esta pestaña para cargar documentos.</EmptyState>)}
          {activeTab === 'products' && <ProductsPlaceholder />}
        </div>

        {showMetricModal && <MetricDocumentsModal data={metricDocuments} loading={metricLoading} error={metricError} onClose={() => setShowMetricModal(false)} onOpenDocument={openDocumentDetail} />}
        {showDocumentDetail && <DocumentDetailModal detail={documentDetail} loading={documentDetailLoading} error={documentDetailError} onClose={() => setShowDocumentDetail(false)} />}
      </aside>
    </div>
  )
}

export function Client360Drawer({ customer, onClose }: { customer: CommercialCustomerExplorer | null; onClose: () => void }) {
  if (!customer) return null
  return <Client360DrawerContent key={customer.bsale_client_id} customer={customer} onClose={onClose} />
}
