"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createCustomer,
  getCommercialCustomersExplorer,
  type CommercialCustomerExplorer,
  type CommercialCustomerStats,
  type Customer,
} from '@/app/actions/comercial/customers'
import { forceSyncBsaleClients, getSyncStatus } from '@/app/actions/integraciones/sync'
import {
  AlertCircle, Building2, CloudSync, Mail, MapPin, Phone,
  Plus, RefreshCw, Search, ShieldAlert, TrendingUp, UserRoundCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type FormData = {
  business_name: string
  rut: string
  fantasy_name: string
  business_activity: string
  email: string
  phone: string
  mobile: string
  address: string
  city: string
  commune: string
  region: string
  notes: string
  credit_days: string
  credit_limit: string
}

type SaleFilter = 'all' | 'with_sales' | 'without_sales'

type SyncStatus = {
  isLocked?: boolean
  lastSuccess?: { finished_at: string }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Error inesperado'
}

const emptyForm = (): FormData => ({
  business_name: '', rut: '', fantasy_name: '', business_activity: '',
  email: '', phone: '', mobile: '',
  address: '', city: '', commune: '', region: '',
  notes: '', credit_days: '', credit_limit: '',
})

const inp = "w-full h-10 px-3 bg-theme-bg border border-theme-border rounded-lg text-sm text-theme-text placeholder:text-theme-text-muted/40 focus:outline-none focus:border-theme-accent focus:ring-1 focus:ring-theme-accent/30 transition-all"

function fmtMoney(value: number | null | undefined) {
  const n = Number(value || 0)
  if (n === 0) return '$0'
  return '$' + n.toLocaleString('es-CL', { maximumFractionDigits: 0 })
}

function fmtDate(value: string | null) {
  if (!value) return '—'
  return new Date(value + 'T00:00:00').toLocaleDateString('es-CL')
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

function KpiCard({ label, value, tone, hint, secondary }: { label: string; value: string; tone: string; hint?: string; secondary?: string }) {
  return (
    <div className="rounded-xl border border-theme-border/70 bg-theme-bg/40 px-3 py-2 min-w-[132px]">
      <div className="text-[10px] uppercase tracking-wide text-theme-text-muted/65 font-semibold leading-none">{label}</div>
      <div className={cn("mt-1 text-base font-black leading-tight", tone)}>{value}</div>
      {hint && <div className="text-[10px] text-theme-text-muted/50 mt-0.5 truncate leading-tight">{hint}</div>}
      {secondary && <div className="text-[10px] text-theme-text-muted/40 truncate leading-tight" title={secondary}>{secondary}</div>}
    </div>
  )
}

function buildCommercialCustomerStats(rows: CommercialCustomerExplorer[]): CommercialCustomerStats {
  return {
    total: rows.length,
    active: rows.filter(row => row.status === 'ACTIVO' || row.status === 'NUEVO').length,
    observacion: rows.filter(row => row.status === 'OBSERVACION').length,
    riesgo: rows.filter(row => row.status === 'RIESGO').length,
    inactive: rows.filter(row => row.status === 'INACTIVO').length,
    perdido: rows.filter(row => row.status === 'PERDIDO').length,
    sinVentaHistorica: rows.filter(row => row.status === 'SIN_VENTA_HISTORICA').length,
    withOfficialSales: rows.filter(row => row.official_sales_total > 0).length,
    officialSalesTotal: rows.reduce((sum, row) => sum + row.official_sales_total, 0),
    officialSalesCurrentMonth: rows.reduce((sum, row) => sum + row.official_sales_current_month_net, 0),
    official_sales_current_month_gross_total: rows.reduce((sum, row) => sum + row.official_sales_current_month_gross, 0),
    credit_notes_current_month_total: rows.reduce((sum, row) => sum + row.credit_notes_current_month, 0),
    official_sales_current_month_net_total: rows.reduce((sum, row) => sum + row.official_sales_current_month_net, 0),
    officialSales90d: rows.reduce((sum, row) => sum + row.official_sales_90d, 0),
    withCreditNotes: rows.filter(row => row.credit_note_count_total > 0).length,
    withAnomalousReceipt: rows.filter(row => row.has_anomalous_receipt).length,
    lowQuality: rows.filter(row => row.quality_score < 60).length,
  }
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <label className="block text-[11px] font-semibold text-theme-text-muted uppercase tracking-wider mb-1">{children}</label>
}

function ManualCustomerForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<FormData>(emptyForm)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const set = (field: keyof FormData) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm(prev => ({ ...prev, [field]: event.target.value }))
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!form.business_name.trim()) {
      setErr('La razón social es obligatoria')
      return
    }

    setLoading(true)
    setErr('')
    try {
      const payload: Partial<Customer> = {
        business_name: form.business_name.trim(),
        rut: form.rut.trim() || undefined,
        fantasy_name: form.fantasy_name.trim() || undefined,
        business_activity: form.business_activity.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        mobile: form.mobile.trim() || undefined,
        address: form.address.trim() || undefined,
        city: form.city.trim() || undefined,
        commune: form.commune.trim() || undefined,
        region: form.region.trim() || undefined,
        notes: form.notes.trim() || undefined,
        credit_days: form.credit_days ? Number(form.credit_days) : undefined,
        credit_limit: form.credit_limit ? Number(form.credit_limit) : undefined,
      }
      await createCustomer(payload)
      onSaved()
    } catch (error: unknown) {
      setErr(getErrorMessage(error) || 'Error al guardar')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface animate-in fade-in duration-150">
      <div className="shrink-0 px-5 py-4 border-b border-theme-border bg-theme-surface flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-theme-text leading-tight">Nuevo cliente manual</h2>
          <p className="text-xs text-theme-text-muted mt-1">Los clientes Bsale se mantienen desde la integración.</p>
        </div>
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 text-sm font-medium transition-colors">
          Cancelar
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl space-y-7">
          {err && <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4" />{err}</div>}

          <section>
            <h3 className="text-sm font-bold text-theme-text mb-4 pb-2 border-b border-theme-border">Identificación</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><Lbl>Razón social *</Lbl><input value={form.business_name} onChange={set('business_name')} className={inp} required /></div>
              <div><Lbl>RUT</Lbl><input value={form.rut} onChange={set('rut')} className={inp} placeholder="12.345.678-9" /></div>
              <div><Lbl>Nombre fantasía</Lbl><input value={form.fantasy_name} onChange={set('fantasy_name')} className={inp} /></div>
              <div><Lbl>Giro / Actividad</Lbl><input value={form.business_activity} onChange={set('business_activity')} className={inp} /></div>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-bold text-theme-text mb-4 pb-2 border-b border-theme-border">Contacto y ubicación</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><Lbl>Email</Lbl><input value={form.email} onChange={set('email')} type="email" className={inp} /></div>
              <div><Lbl>Teléfono</Lbl><input value={form.phone} onChange={set('phone')} className={inp} /></div>
              <div className="sm:col-span-2"><Lbl>Dirección</Lbl><input value={form.address} onChange={set('address')} className={inp} /></div>
              <div><Lbl>Ciudad</Lbl><input value={form.city} onChange={set('city')} className={inp} /></div>
              <div><Lbl>Comuna</Lbl><input value={form.commune} onChange={set('commune')} className={inp} /></div>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-bold text-theme-text mb-4 pb-2 border-b border-theme-border">Condiciones y notas</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><Lbl>Días de crédito</Lbl><input value={form.credit_days} onChange={set('credit_days')} type="number" min="0" className={inp} /></div>
              <div><Lbl>Límite de crédito</Lbl><input value={form.credit_limit} onChange={set('credit_limit')} type="number" min="0" className={inp} /></div>
              <div className="sm:col-span-2"><Lbl>Notas internas</Lbl><textarea value={form.notes} onChange={set('notes')} rows={3} className="w-full px-3 py-2 bg-theme-bg border border-theme-border rounded-lg text-sm text-theme-text resize-none" /></div>
            </div>
          </section>

          <div className="flex items-center gap-3 pb-8">
            <button disabled={loading} type="submit" className="px-6 py-2.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold shadow-md shadow-theme-accent/20 disabled:opacity-50 transition-all">
              {loading ? 'Guardando...' : 'Crear cliente manual'}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-medium text-theme-text-muted hover:text-theme-text transition-colors">Cancelar</button>
          </div>
        </div>
      </form>
    </div>
  )
}

export function CustomersPanel() {
  const [customers, setCustomers] = useState<CommercialCustomerExplorer[]>([])
  const [stats, setStats] = useState<CommercialCustomerStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sellerFilter, setSellerFilter] = useState('all')
  const [communeFilter, setCommuneFilter] = useState('all')
  const [saleFilter, setSaleFilter] = useState<SaleFilter>('all')
  const [withCreditNotes, setWithCreditNotes] = useState(false)
  const [lowQuality, setLowQuality] = useState(false)
  const [anomalousReceipt, setAnomalousReceipt] = useState(false)
  const [isNewFormOpen, setIsNewFormOpen] = useState(false)

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(handle)
  }, [search])

  const loadSyncStatus = useCallback(async () => {
    try {
      const status = await getSyncStatus('BSALE', 'clients')
      setSyncStatus(status)
    } catch (err) {
      console.error('Failed to load sync status', err)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await getCommercialCustomersExplorer()
      setCustomers(rows)
      setStats(buildCommercialCustomerStats(rows))
    } catch (err: unknown) {
      const message = getErrorMessage(err)
      setError(message === 'MIGRATION_PENDING' ? 'El Explorador Comercial requiere aplicar la migración' : message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const handle = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(handle)
  }, [load])
  useEffect(() => {
    const handle = setTimeout(() => { void loadSyncStatus() }, 0)
    return () => clearTimeout(handle)
  }, [loadSyncStatus])

  const sellers = useMemo(() => Array.from(new Set(customers.map(c => c.main_seller_name).filter(Boolean) as string[])).sort(), [customers])
  const communes = useMemo(() => Array.from(new Set(customers.map(c => c.commune || c.city).filter(Boolean) as string[])).sort(), [customers])

  const filteredCustomers = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase()
    return customers.filter(customer => {
      const searchable = [customer.business_name, customer.fantasy_name, customer.rut, customer.rut_clean, customer.email, customer.commune, customer.city, customer.main_seller_name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      if (query && !searchable.includes(query)) return false
      if (statusFilter !== 'all' && customer.status !== statusFilter) return false
      if (sellerFilter !== 'all' && customer.main_seller_name !== sellerFilter) return false
      if (communeFilter !== 'all' && (customer.commune || customer.city) !== communeFilter) return false
      if (saleFilter === 'with_sales' && customer.official_sales_total <= 0) return false
      if (saleFilter === 'without_sales' && customer.official_sales_total > 0) return false
      if (withCreditNotes && customer.credit_note_count_total <= 0) return false
      if (lowQuality && customer.quality_score >= 60) return false
      if (anomalousReceipt && !customer.has_anomalous_receipt) return false
      return true
    })
  }, [customers, debouncedSearch, statusFilter, sellerFilter, communeFilter, saleFilter, withCreditNotes, lowQuality, anomalousReceipt])

  const handleForceSync = async () => {
    if (isSyncing || syncStatus?.isLocked) return
    setIsSyncing(true)
    setSyncError(null)
    try {
      const res = await forceSyncBsaleClients()
      if (res.status === 'SKIPPED') setSyncError(res.message || 'La sincronización está bloqueada o en curso.')
      await load()
      await loadSyncStatus()
    } catch (err: unknown) {
      setSyncError(getErrorMessage(err) || 'Error al sincronizar')
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface">
      <div className="shrink-0 flex flex-col gap-2.5 px-4 py-3 border-b border-theme-border/60 bg-theme-text/[0.01]">
        <div className="flex flex-col md:flex-row items-center gap-2 w-full">
          <div className="flex items-center gap-1 shrink-0">
            {[
              { label: 'Clientes', active: true },
              { label: 'Vendedores', active: false },
              { label: 'Rutas / Zonas', active: false },
            ].map(tab => (
              <span key={tab.label} className={cn(
                "px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors",
                tab.active ? "bg-theme-accent/10 text-theme-accent" : "text-theme-text-muted/40 cursor-not-allowed"
              )}>{tab.label}</span>
            ))}
          </div>

          <div className="relative flex-1 w-full">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-theme-text-muted/50" />
            <input
              type="text"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Buscar cliente, RUT, email, comuna o vendedor…"
              className="w-full h-9 pl-8 pr-3 rounded-lg border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40"
            />
          </div>

          <button onClick={load} title="Recargar esta vista, sin sincronizar Bsale" className="h-9 w-9 flex items-center justify-center rounded-lg border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text transition-colors">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </button>
          <button onClick={() => setIsNewFormOpen(true)} className="h-9 px-3 flex items-center gap-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold shadow-sm shadow-theme-accent/15 transition-all shrink-0">
            <Plus className="w-3.5 h-3.5" />Nuevo cliente manual
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard label="Total clientes" value={String(stats?.total ?? 0)} tone="text-theme-text" hint="Base Bsale 360" />
          <KpiCard label="Activos" value={String(stats?.active ?? 0)} tone="text-emerald-500" hint="ACTIVO + NUEVO" />
          <KpiCard label="Riesgo / Perdidos" value={String((stats?.riesgo ?? 0) + (stats?.perdido ?? 0))} tone="text-orange-400" hint="requieren seguimiento" />
          <KpiCard label="Sin venta histórica" value={String(stats?.sinVentaHistorica ?? 0)} tone="text-theme-text-muted" hint="sin factura oficial" />
          <KpiCard
            label="Venta mes actual"
            value={fmtMoney(stats?.official_sales_current_month_net_total)}
            tone="text-blue-400"
            hint="facturas - notas de crédito"
            secondary={`Bruto: ${fmtMoney(stats?.official_sales_current_month_gross_total)} · NC: ${fmtMoney(stats?.credit_notes_current_month_total)}`}
          />
          <KpiCard label="Con NC" value={String(stats?.withCreditNotes ?? 0)} tone="text-red-400" hint="clientes con notas de crédito" />
        </div>

        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-2">
          <div className="flex items-center flex-wrap gap-1.5">
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} className="h-8 px-2.5 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text">
              <option value="all">Estado comercial: Todos</option>
              {['NUEVO', 'ACTIVO', 'OBSERVACION', 'RIESGO', 'INACTIVO', 'PERDIDO', 'SIN_VENTA_HISTORICA'].map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select>
            <select value={sellerFilter} onChange={event => setSellerFilter(event.target.value)} className="h-8 px-2.5 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text max-w-[200px]">
              <option value="all">Vendedor: Todos</option>
              {sellers.map(seller => <option key={seller} value={seller}>{seller}</option>)}
            </select>
            <select value={communeFilter} onChange={event => setCommuneFilter(event.target.value)} className="h-8 px-2.5 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text max-w-[180px]">
              <option value="all">Comuna: Todas</option>
              {communes.map(commune => <option key={commune} value={commune}>{commune}</option>)}
            </select>
            <select value={saleFilter} onChange={event => setSaleFilter(event.target.value as SaleFilter)} className="h-8 px-2.5 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text">
              <option value="all">Venta: Todas</option>
              <option value="with_sales">Con venta oficial</option>
              <option value="without_sales">Sin venta oficial</option>
            </select>
            <button onClick={() => setWithCreditNotes(v => !v)} className={cn("h-8 px-2.5 rounded-lg border text-xs font-semibold", withCreditNotes ? "border-red-400/30 bg-red-500/10 text-red-400" : "border-theme-border text-theme-text-muted")}>Con NC</button>
            <button onClick={() => setLowQuality(v => !v)} className={cn("h-8 px-2.5 rounded-lg border text-xs font-semibold", lowQuality ? "border-amber-400/30 bg-amber-500/10 text-amber-400" : "border-theme-border text-theme-text-muted")}>Calidad baja</button>
            <button onClick={() => setAnomalousReceipt(v => !v)} className={cn("h-8 px-2.5 rounded-lg border text-xs font-semibold", anomalousReceipt ? "border-orange-400/30 bg-orange-500/10 text-orange-400" : "border-theme-border text-theme-text-muted")}>Boleta anómala</button>
          </div>

          <div className="flex items-center flex-wrap gap-2 text-[11px] text-theme-text-muted">
            {syncStatus?.isLocked || isSyncing ? <span className="flex items-center gap-1 text-blue-500 font-medium"><RefreshCw className="w-3 h-3 animate-spin" /> Sync: En proceso</span>
              : syncStatus?.lastSuccess ? <span className="flex items-center gap-1 text-emerald-500 font-medium"><CloudSync className="w-3 h-3" /> Sync: OK</span>
              : <span className="flex items-center gap-1 text-theme-text-muted font-medium"><CloudSync className="w-3 h-3" /> Sync: Pendiente</span>}
            <span title="Las ventas, estados y alertas se calculan desde la capa comercial.">Datos comerciales calculados</span>
            <button onClick={handleForceSync} disabled={isSyncing || syncStatus?.isLocked} title="Sincroniza clientes desde Bsale. Las métricas comerciales se actualizan con el proceso analítico." className="h-7 px-2 flex items-center gap-1.5 rounded-md border border-theme-border/60 bg-theme-surface hover:bg-theme-text/5 text-theme-text hover:border-theme-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium">
              <RefreshCw className={cn("w-3 h-3 text-theme-text-muted", (isSyncing || syncStatus?.isLocked) && "animate-spin")} />
              Forzar sync Bsale
            </button>
            {syncError && <span className="text-red-400 font-medium" title={syncError}><AlertCircle className="w-3.5 h-3.5" /></span>}
          </div>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          {error ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <p className="text-red-400 font-semibold text-sm">{error}</p>
              <button onClick={load} className="px-4 py-2 border border-theme-border rounded-lg text-sm hover:bg-theme-text/5 transition-colors">Reintentar</button>
            </div>
          ) : loading && customers.length === 0 ? (
            <div className="flex-1 flex items-center justify-center"><RefreshCw className="w-5 h-5 animate-spin text-theme-accent" /></div>
          ) : filteredCustomers.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-theme-text-muted">
              <Building2 className="w-10 h-10 opacity-20" />
              <p className="text-sm">No hay clientes que coincidan con los filtros.</p>
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs border-collapse min-w-[1240px]">
                <thead className="sticky top-0 z-10 bg-theme-surface">
                  <tr className="border-b border-theme-border text-[10px] text-theme-text-muted/70 uppercase tracking-wide">
                    <th className="text-left py-2 px-3">Cliente / Giro</th>
                    <th className="text-left py-2 px-3 whitespace-nowrap">RUT</th>
                    <th className="text-left py-2 px-3">Comuna / Ciudad</th>
                    <th className="text-left py-2 px-3">Estado comercial</th>
                    <th className="text-right py-2 px-3">Venta oficial total</th>
                    <th className="text-right py-2 px-3">Venta mes actual</th>
                    <th className="text-right py-2 px-3">Venta 90d</th>
                    <th className="text-left py-2 px-3">Última factura</th>
                    <th className="text-right py-2 px-3">Días</th>
                    <th className="text-left py-2 px-3">Vendedor principal</th>
                    <th className="text-center py-2 px-3">NC total</th>
                    <th className="text-center py-2 px-3">Calidad</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map(customer => {
                    const incomplete = customer.quality_score < 60
                    const noHistory = customer.status === 'SIN_VENTA_HISTORICA'
                    return (
                      <tr key={`${customer.company_id}-${customer.bsale_client_id}`} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors group">
                        <td className="py-2 px-3">
                          <div className="font-semibold text-[13px] text-theme-text max-w-[250px] truncate leading-tight">{customer.business_name}</div>
                          <div className="flex items-center gap-1.5 mt-0.5 min-h-3.5">
                            {customer.business_activity && <span className="text-[10px] text-theme-text-muted/55 truncate max-w-[190px] leading-tight">{customer.business_activity}</span>}
                            {customer.has_anomalous_receipt && <span title="Boleta anómala"><ShieldAlert className="w-3 h-3 text-orange-400" /></span>}
                            {customer.credit_note_count_total > 0 && <span className="text-[10px] text-red-400 font-bold">NC</span>}
                            {incomplete && <span className="text-[10px] text-amber-400 font-bold">datos incompletos</span>}
                            {noHistory && <span className="text-[10px] text-theme-text-muted font-bold">sin venta</span>}
                          </div>
                        </td>
                        <td className="py-2 px-3 font-mono text-theme-text whitespace-nowrap">{customer.rut || '—'}</td>
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-1 text-[11px] text-theme-text-muted max-w-[150px]"><MapPin className="w-3 h-3 shrink-0 opacity-40" /><span className="truncate">{[customer.commune, customer.city].filter(Boolean).join(', ') || '—'}</span></div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-theme-text-muted/40">
                            {customer.has_email && <Mail className="w-2.5 h-2.5" />}
                            {customer.has_phone && <Phone className="w-2.5 h-2.5" />}
                            {customer.has_address && <MapPin className="w-2.5 h-2.5" />}
                          </div>
                        </td>
                        <td className="py-2 px-3"><span className={cn("inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold border", statusClass(customer.status))}>{statusLabel(customer.status)}</span></td>
                        <td className="py-2 px-3 text-right font-semibold text-theme-text whitespace-nowrap">{fmtMoney(customer.official_sales_total)}</td>
                        <td className="py-2 px-3 text-right whitespace-nowrap" title={`Bruto ${fmtMoney(customer.official_sales_current_month_gross)} / NC ${fmtMoney(customer.credit_notes_current_month)}`}>
                          <div className="text-sky-400 font-semibold">{fmtMoney(customer.official_sales_current_month_net)}</div>
                          {customer.credit_notes_current_month > 0 && <div className="text-[10px] text-theme-text-muted/45 leading-tight">Bruto {fmtMoney(customer.official_sales_current_month_gross)} / NC {fmtMoney(customer.credit_notes_current_month)}</div>}
                        </td>
                        <td className="py-2 px-3 text-right text-blue-400 font-semibold whitespace-nowrap">{fmtMoney(customer.official_sales_90d)}</td>
                        <td className="py-2 px-3 text-theme-text-muted whitespace-nowrap">{fmtDate(customer.last_invoice_date)}</td>
                        <td className="py-2 px-3 text-right text-theme-text-muted">{customer.days_since_last_invoice ?? '—'}</td>
                        <td className="py-2 px-3 text-theme-text max-w-[170px] truncate">{customer.main_seller_name || '—'}</td>
                        <td className="py-2 px-3 text-center"><span className={cn("text-[11px] font-bold", customer.credit_note_count_total > 0 ? "text-red-400" : "text-theme-text-muted/30")}>{customer.credit_note_count_total}</span></td>
                        <td className="py-2 px-3 text-center"><span className={cn("inline-flex items-center gap-1 text-[11px] font-bold", incomplete ? "text-amber-400" : "text-emerald-500")}><UserRoundCheck className="w-2.5 h-2.5" />{customer.quality_score}%</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !error && filteredCustomers.length > 0 && (
            <div className="shrink-0 flex items-center justify-between text-[11px] px-3 py-2 border-t border-theme-border/60 bg-theme-text/[0.01] text-theme-text-muted/50">
              <span>{filteredCustomers.length} de {customers.length} clientes comerciales</span>
              <span className="flex items-center gap-1"><TrendingUp className="w-2.5 h-2.5" />Datasource: comercial.vw_client_360</span>
            </div>
          )}
        </div>
      </div>

      {isNewFormOpen && (
        <div className="fixed inset-0 z-[100] flex justify-end">
          <div className="absolute inset-0 bg-black/20 animate-in fade-in duration-200" onClick={() => setIsNewFormOpen(false)} />
          <div className="relative w-full sm:w-[45vw] min-w-[480px] max-w-[800px] h-full bg-theme-surface shadow-2xl border-l border-theme-border/50 animate-in slide-in-from-right-full duration-300">
            <ManualCustomerForm onClose={() => setIsNewFormOpen(false)} onSaved={async () => { setIsNewFormOpen(false); await load() }} />
          </div>
        </div>
      )}
    </div>
  )
}
