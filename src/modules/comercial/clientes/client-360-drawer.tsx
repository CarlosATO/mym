"use client"

import { AlertTriangle, CalendarDays, Mail, MapPin, Phone, TrendingUp, UserRoundCheck, X } from 'lucide-react'
import type { CommercialCustomerExplorer } from '@/app/actions/comercial/customers'
import { cn } from '@/lib/utils'

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-theme-text-muted/70">{title}</h3>
      {children}
    </section>
  )
}

function Metric({ label, value, hint, tone = 'text-theme-text' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-theme-border/70 bg-theme-bg/35 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-theme-text-muted/60 font-semibold">{label}</div>
      <div className={cn("mt-0.5 text-sm font-black", tone)}>{value}</div>
      {hint && <div className="text-[10px] text-theme-text-muted/45 truncate">{hint}</div>}
    </div>
  )
}

function InfoRow({ label, value, icon }: { label: string; value: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-theme-border/50 bg-theme-bg/25 px-3 py-2">
      {icon && <div className="mt-0.5 text-theme-text-muted/50">{icon}</div>}
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-theme-text-muted/60 font-semibold">{label}</div>
        <div className="text-xs text-theme-text mt-0.5 break-words">{value || <span className="text-theme-text-muted/45">Sin dato</span>}</div>
      </div>
    </div>
  )
}

function AlertBadge({ children, tone = 'text-theme-text-muted border-theme-border bg-theme-bg/40' }: { children: React.ReactNode; tone?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold", tone)}>{children}</span>
}

export function Client360Drawer({ customer, onClose }: { customer: CommercialCustomerExplorer | null; onClose: () => void }) {
  if (!customer) return null

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

  return (
    <div className="fixed inset-0 z-[110] flex justify-end">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[1px] animate-in fade-in duration-150" onClick={onClose} />
      <aside className="relative h-full w-full sm:w-[55vw] lg:w-[50vw] xl:w-[46vw] min-w-0 sm:min-w-[520px] max-w-[900px] bg-theme-surface border-l border-theme-border shadow-2xl flex flex-col animate-in slide-in-from-right-full duration-300">
        <header className="shrink-0 border-b border-theme-border bg-theme-text/[0.015] px-5 py-4">
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
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <Section title="Ventas oficiales">
            <div className="rounded-xl border border-theme-border/70 bg-theme-bg/25 p-3 space-y-2">
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
                <Metric label="Venta mes actual" value={fmtMoney(customer.official_sales_current_month_net)} hint="facturas - notas de crédito" tone="text-sky-400" />
                <Metric label="Venta oficial total" value={fmtMoney(customer.official_sales_total)} />
                <Metric label="Venta 90d" value={fmtMoney(customer.official_sales_90d)} tone="text-blue-400" />
                <Metric label="Venta 180d" value={fmtMoney(customer.official_sales_180d)} />
                <Metric label="Última factura" value={fmtDate(customer.last_invoice_date)} />
                <Metric label="Días sin compra" value={customer.days_since_last_invoice != null ? String(customer.days_since_last_invoice) : 'Sin dato'} />
                <Metric label="Facturas totales" value={String(customer.official_invoice_docs_total)} />
                <Metric label="Ticket promedio" value={fmtMoney(customer.avg_ticket_gross_total)} />
              </div>
              <div className="text-[11px] text-theme-text-muted/50">Mes actual bruto {fmtMoney(customer.official_sales_current_month_gross)} · NC mes {fmtMoney(customer.credit_notes_current_month)}</div>
            </div>
          </Section>

          <Section title="Correcciones / Notas de crédito">
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
              <Metric label="NC total monto" value={fmtMoney(customer.credit_note_amount_total)} tone={customer.credit_note_count_total > 0 ? 'text-red-400' : 'text-theme-text'} />
              <Metric label="NC total cantidad" value={String(customer.credit_note_count_total)} />
              <Metric label="NC mes actual" value={fmtMoney(customer.credit_notes_current_month)} hint="incluida en venta neta" tone={customer.credit_notes_current_month > 0 ? 'text-red-400' : 'text-theme-text'} />
              <Metric label="NC 90d monto" value={fmtMoney(customer.credit_note_amount_90d)} />
              <Metric label="NC 90d cantidad" value={String(customer.credit_note_count_90d)} />
            </div>
          </Section>

          <Section title="Pedidos operativos">
            <div className="rounded-xl border border-theme-border/70 bg-theme-bg/25 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Metric label="NV 90d cantidad" value={String(customer.sales_order_count_90d)} />
                <Metric label="NV 90d monto" value={fmtMoney(customer.sales_order_amount_90d)} />
              </div>
              <div className="text-[11px] text-theme-text-muted/50">Nota de Venta es pedido operativo; no suma como venta oficial.</div>
            </div>
          </Section>

          <Section title="Comportamiento del cliente">
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
              <Metric label="Última factura" value={fmtDate(customer.last_invoice_date)} />
              <Metric label="Días sin compra" value={customer.days_since_last_invoice != null ? String(customer.days_since_last_invoice) : 'Sin dato'} />
              <Metric label="Facturas totales" value={String(customer.official_invoice_docs_total)} />
              <Metric label="Ticket promedio" value={fmtMoney(customer.avg_ticket_gross_total)} />
              <Metric label="NV 90d" value={String(customer.sales_order_count_90d)} hint={fmtMoney(customer.sales_order_amount_90d)} />
              <Metric label="NC total" value={String(customer.credit_note_count_total)} hint={fmtMoney(customer.credit_note_amount_total)} />
            </div>
            <div className="rounded-lg border border-dashed border-theme-border/70 px-3 py-2 text-[11px] text-theme-text-muted/55">Próxima etapa: últimas compras, productos, proveedores, evolución y pagos.</div>
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
            <div className="space-y-2">
              <div className={cn("rounded-xl border px-3 py-2", noSeller ? "border-slate-400/20 bg-slate-500/5" : "border-emerald-400/20 bg-emerald-500/5")}>
                <div className={cn("text-xs font-semibold", noSeller ? "text-slate-400" : "text-emerald-400")}>{noSeller ? 'Sin vendedor identificado' : 'Certificado desde Bsale'}</div>
                <div className="mt-0.5 text-[11px] text-theme-text-muted/60">Fuente: endpoint de vendedores por documento Bsale.</div>
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
      </aside>
    </div>
  )
}
