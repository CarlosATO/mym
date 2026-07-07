"use client"

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getCustomers, createCustomer, updateCustomer,
  deactivateCustomer, reactivateCustomer, getCustomerStats,
  type Customer
} from '@/app/actions/comercial/customers'
import {
  Search, Plus, Building2, User2, Mail, Phone,
  MapPin, Info, AlertCircle, RefreshCw, MoreVertical,
  Edit, ToggleLeft, ToggleRight
} from 'lucide-react'
import { cn } from '@/lib/utils'

/* ─────────────────────────────────────────────────────────────
   TYPES
───────────────────────────────────────────────────────────── */
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

const emptyForm = (): FormData => ({
  business_name: '', rut: '', fantasy_name: '', business_activity: '',
  email: '', phone: '', mobile: '',
  address: '', city: '', commune: '', region: '',
  notes: '', credit_days: '', credit_limit: ''
})

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */
function Lbl({ children }: { children: React.ReactNode }) {
  return <label className="block text-[11px] font-semibold text-theme-text-muted uppercase tracking-wider mb-1">{children}</label>
}
const inp = "w-full h-10 px-3 bg-theme-bg border border-theme-border rounded-lg text-sm text-theme-text placeholder:text-theme-text-muted/40 focus:outline-none focus:border-theme-accent focus:ring-1 focus:ring-theme-accent/30 transition-all"
const roInp = "w-full h-10 px-3 bg-theme-bg/40 border border-theme-border/50 rounded-lg text-sm text-theme-text-muted select-none cursor-default"

function fmtCredit(v: number | null): string {
  if (!v) return '—'
  return '$' + v.toLocaleString('es-CL')
}

/* ─────────────────────────────────────────────────────────────
   ROW MENU
───────────────────────────────────────────────────────────── */
function RowMenu({ customer, onEdit, onToggle }: {
  customer: Customer; onEdit: () => void; onToggle: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        className="p-1.5 rounded-md text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 transition-colors">
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-theme-surface border border-theme-border rounded-xl shadow-xl shadow-black/20 z-50 overflow-hidden">
          <button onClick={() => { setOpen(false); onEdit() }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-theme-text hover:bg-theme-text/5 transition-colors text-left">
            <Edit className="w-3.5 h-3.5 text-theme-accent" />Editar cliente
          </button>
          <button onClick={() => { setOpen(false); onToggle() }}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-theme-text hover:bg-theme-text/5 transition-colors text-left">
            {customer.is_active
              ? <ToggleLeft className="w-3.5 h-3.5 text-red-400" />
              : <ToggleRight className="w-3.5 h-3.5 text-emerald-500" />}
            {customer.is_active ? 'Desactivar' : 'Activar'}
          </button>
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   CUSTOMER FORM — identical structure to CatalogPanel form
───────────────────────────────────────────────────────────── */
function CustomerForm({ editing, onClose, onSaved }: {
  editing: Customer | null; onClose: () => void; onSaved: () => void
}) {
  const isBsale = editing?.source === 'BSALE'
  const [form, setForm] = useState<FormData>(() =>
    editing ? {
      business_name: editing.business_name || '',
      rut: editing.rut || '',
      fantasy_name: editing.fantasy_name || '',
      business_activity: editing.business_activity || '',
      email: editing.email || '',
      phone: editing.phone || '',
      mobile: editing.mobile || '',
      address: editing.address || '',
      city: editing.city || '',
      commune: editing.commune || '',
      region: editing.region || '',
      notes: editing.notes || '',
      credit_days: editing.credit_days != null ? String(editing.credit_days) : '',
      credit_limit: editing.credit_limit != null ? String(editing.credit_limit) : '',
    } : emptyForm()
  )
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const set = (f: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [f]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isBsale && !form.business_name.trim()) { setErr('La razón social es obligatoria'); return }
    
    // Check if anything actually changed for BSALE
    if (editing && isBsale) {
      const notesChanged = form.notes.trim() !== (editing.notes || '').trim()
      if (!notesChanged) {
        setErr('No hay cambios administrativos para guardar.')
        return
      }
    }

    setLoading(true); setErr('')
    try {
      let p: Partial<Customer>
      if (isBsale) {
        p = { notes: form.notes.trim() || undefined }
      } else {
        p = {
          business_name: form.business_name.trim() || undefined,
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
      }
      editing ? await updateCustomer(editing.id, p) : await createCustomer(p)
      onSaved()
    } catch (e: any) {
      setErr(e.message || 'Error al guardar')
    } finally { setLoading(false) }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface animate-in fade-in duration-150">
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-theme-border bg-theme-surface flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-theme-accent/10 flex items-center justify-center">
            <Building2 className="w-4 h-4 text-theme-accent" />
          </div>
          <div>
            <h2 className="text-base font-bold text-theme-text leading-tight">
              {editing ? 'Editar cliente' : 'Nuevo cliente'}
            </h2>
            {editing && <p className="text-xs text-theme-text-muted">{editing.business_name}</p>}
          </div>
        </div>
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 text-sm font-medium transition-colors">
          Cancelar
        </button>
      </div>

      {/* Scrollable form body */}
      <div className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl space-y-8">
          {err && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />{err}
            </div>
          )}

          {/* Bsale block */}
          {isBsale && (
            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-blue-400 mb-1">Integración Bsale — solo lectura</p>
                  <p className="text-xs text-blue-400/80 leading-relaxed">
                    Este cliente proviene de Bsale. Los datos tributarios, comerciales y de contacto se mantienen desde Bsale. 
                    En PetGrup solo se guardan datos administrativos internos. Esta pantalla no sincroniza cambios hacia Bsale.
                  </p>
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {[
                      ['Origen', editing!.source],
                      ['ID Bsale', String(editing!.bsale_client_id ?? '—')],
                      ['RUT origen', editing!.rut ?? '—'],
                      ['Último sync', editing!.last_bsale_sync_at ? new Date(editing!.last_bsale_sync_at).toLocaleDateString('es-CL') : '—'],
                    ].map(([label, val]) => (
                      <div key={label}>
                        <div className="text-[10px] text-blue-400/60 uppercase font-semibold">{label}</div>
                        <div className="text-xs text-blue-400 font-bold mt-0.5">{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Identificación */}
          <section>
            <h3 className="text-sm font-bold text-theme-text mb-4 pb-2 border-b border-theme-border">Identificación</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><Lbl>RUT</Lbl>
                {isBsale ? <input value={form.rut} readOnly className={roInp} /> : <input value={form.rut} onChange={set('rut')} className={inp} placeholder="12.345.678-9" />}
              </div>
              <div><Lbl>Razón Social *</Lbl>
                {isBsale ? <input value={form.business_name} readOnly className={roInp} /> : <input value={form.business_name} onChange={set('business_name')} className={inp} required />}
              </div>
              <div><Lbl>Nombre Fantasía</Lbl>
                {isBsale ? <input value={form.fantasy_name} readOnly className={roInp} /> : <input value={form.fantasy_name} onChange={set('fantasy_name')} className={inp} placeholder="Nombre comercial" />}
              </div>
              <div className="sm:col-span-2 lg:col-span-3"><Lbl>Giro / Actividad</Lbl>
                {isBsale ? <input value={form.business_activity} readOnly className={roInp} /> : <input value={form.business_activity} onChange={set('business_activity')} className={inp} placeholder="Ej. Distribución de alimentos para mascotas" />}
              </div>
            </div>
          </section>

          {/* Contacto */}
          <section>
            <h3 className="text-sm font-bold text-theme-text mb-4 pb-2 border-b border-theme-border">Contacto</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div><Lbl>Email</Lbl>
                {isBsale ? <input value={form.email} readOnly className={roInp} /> : <input value={form.email} onChange={set('email')} type="email" className={inp} placeholder="contacto@empresa.cl" />}
              </div>
              <div><Lbl>Teléfono</Lbl>
                {isBsale ? <input value={form.phone} readOnly className={roInp} /> : <input value={form.phone} onChange={set('phone')} className={inp} placeholder="+56 2 2xxx xxxx" />}
              </div>
              <div><Lbl>Móvil</Lbl>
                {isBsale ? <input value={form.mobile} readOnly className={roInp} /> : <input value={form.mobile} onChange={set('mobile')} className={inp} placeholder="+56 9 xxxx xxxx" />}
              </div>
            </div>
          </section>

          {/* Ubicación */}
          <section>
            <h3 className="text-sm font-bold text-theme-text mb-4 pb-2 border-b border-theme-border">Ubicación</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="sm:col-span-2"><Lbl>Dirección</Lbl>
                {isBsale ? <input value={form.address} readOnly className={roInp} /> : <input value={form.address} onChange={set('address')} className={inp} placeholder="Av. ejemplo 1234" />}
              </div>
              <div><Lbl>Ciudad</Lbl>
                {isBsale ? <input value={form.city} readOnly className={roInp} /> : <input value={form.city} onChange={set('city')} className={inp} placeholder="Santiago" />}
              </div>
              <div><Lbl>Comuna</Lbl>
                {isBsale ? <input value={form.commune} readOnly className={roInp} /> : <input value={form.commune} onChange={set('commune')} className={inp} placeholder="Las Condes" />}
              </div>
              <div className="sm:col-span-2"><Lbl>Región</Lbl>
                {isBsale ? <input value={form.region} readOnly className={roInp} /> : <input value={form.region} onChange={set('region')} className={inp} placeholder="Metropolitana" />}
              </div>
            </div>
          </section>

          {/* Condiciones */}
          <section>
            <h3 className="text-sm font-bold text-theme-text mb-4 pb-2 border-b border-theme-border">Condiciones comerciales</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div><Lbl>Días de crédito</Lbl>
                {isBsale ? <input value={form.credit_days} readOnly className={roInp} /> : <input value={form.credit_days} onChange={set('credit_days')} type="number" min="0" className={inp} placeholder="30" />}
              </div>
              <div><Lbl>Límite de crédito (CLP)</Lbl>
                {isBsale ? <input value={form.credit_limit} readOnly className={roInp} /> : <input value={form.credit_limit} onChange={set('credit_limit')} type="number" min="0" className={inp} placeholder="0" />}
              </div>
            </div>
          </section>

          {/* Notas */}
          <section>
            <h3 className="text-sm font-bold text-theme-text mb-4 pb-2 border-b border-theme-border">Notas internas</h3>
            <textarea value={form.notes} onChange={set('notes')} rows={3}
              className="w-full px-3 py-2 bg-theme-bg border border-theme-border rounded-lg text-sm text-theme-text placeholder:text-theme-text-muted/40 focus:outline-none focus:border-theme-accent focus:ring-1 focus:ring-theme-accent/30 transition-all resize-none"
              placeholder="Notas de uso administrativo…" />
          </section>

          <div className="flex items-center gap-3 pb-8">
            <button disabled={loading} type="submit" onClick={handleSubmit}
              className="px-6 py-2.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold shadow-md shadow-theme-accent/20 disabled:opacity-50 transition-all">
              {loading ? 'Guardando...' : (editing ? 'Guardar cambios' : 'Crear cliente')}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2.5 rounded-lg text-sm font-medium text-theme-text-muted hover:text-theme-text transition-colors">
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   MAIN LIST — pattern identical to CatalogPanel
───────────────────────────────────────────────────────────── */
export function CustomersPanel() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0, bsale: 0, manual: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'BSALE' | 'MANUAL'>('all')
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isNewForm, setIsNewForm] = useState(false)

  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(search), 400)
    return () => clearTimeout(h)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [data, st] = await Promise.all([
        getCustomers({ search: debouncedSearch, status: statusFilter, source: sourceFilter }),
        getCustomerStats()
      ])
      setCustomers(data); setStats(st)
    } catch (e: any) {
      setError(e.message === 'MIGRATION_PENDING' ? 'El módulo Comercial requiere aplicar la migración' : e.message || 'Error')
    } finally { setLoading(false) }
  }, [debouncedSearch, statusFilter, sourceFilter])

  useEffect(() => { load() }, [load])

  const handleToggleActive = async (c: Customer) => {
    try {
      c.is_active ? await deactivateCustomer(c.id) : await reactivateCustomer(c.id)
      await load()
    } catch (e: any) { alert(e.message) }
  }

  const openNew = () => { setSelectedCustomer(null); setIsNewForm(true); setIsDetailOpen(true) }
  const openEdit = (c: Customer) => { setSelectedCustomer(c); setIsNewForm(false); setIsDetailOpen(true) }
  const closeForm = () => { setIsDetailOpen(false); setSelectedCustomer(null) }
  const onSaved = async () => { closeForm(); await load() }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface">

      {/* ── Toolbar (shrink-0, identical to CatalogPanel) ── */}
      <div className="shrink-0 flex flex-col gap-3 p-5 border-b border-theme-border/60 bg-theme-text/[0.01]">
        <div className="flex flex-col md:flex-row items-center gap-3 w-full">

          {/* Sub-tabs (inline, left) */}
          <div className="flex items-center gap-1 shrink-0">
            {[
              { label: 'Clientes', active: true },
              { label: 'Vendedores', active: false },
              { label: 'Rutas / Zonas', active: false },
            ].map(t => (
              <span key={t.label} className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                t.active
                  ? "bg-theme-accent/10 text-theme-accent"
                  : "text-theme-text-muted/40 cursor-not-allowed"
              )}>
                {t.label}
              </span>
            ))}
          </div>

          {/* Search */}
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nombre, RUT, email, ciudad, giro…"
              className="w-full h-11 pl-10 pr-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40"
            />
          </div>

          {/* Filters + actions */}
          <div className="flex items-center gap-2 w-full md:w-auto">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}
              className="h-11 px-3 rounded-xl border border-theme-border bg-theme-surface text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/40">
              <option value="all">Estado: Todos</option>
              <option value="active">Activos</option>
              <option value="inactive">Inactivos</option>
            </select>
            <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value as any)}
              className="h-11 px-3 rounded-xl border border-theme-border bg-theme-surface text-sm text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/40">
              <option value="all">Origen: Todos</option>
              <option value="BSALE">Bsale</option>
              <option value="MANUAL">Manual</option>
            </select>
            <button onClick={load} title="Refrescar"
              className="h-11 w-11 flex items-center justify-center rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text transition-colors">
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
            <button onClick={openNew}
              className="h-11 px-4 flex items-center gap-1.5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold shadow-lg shadow-theme-accent/20 transition-all ml-auto md:ml-0 shrink-0">
              <Plus className="w-4 h-4" />Nuevo cliente
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs text-theme-text-muted">
          <span><span className="font-semibold text-theme-text">{stats.total}</span> clientes</span>
          <span className="text-emerald-500 font-semibold">{stats.active} activos</span>
          {stats.inactive > 0 && <span className="text-red-400 font-semibold">{stats.inactive} inactivos</span>}
          <span className="text-blue-400">{stats.bsale} Bsale</span>
          {stats.manual > 0 && <span className="text-orange-400">{stats.manual} manual</span>}
        </div>
      </div>

      {/* ── Table Area ── */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Panel: Table (now takes full width since drawer is overlay) */}
        <div className="flex-1 flex flex-col min-w-0">
          {error ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <p className="text-red-400 font-semibold text-sm">{error}</p>
              <button onClick={load} className="px-4 py-2 border border-theme-border rounded-lg text-sm hover:bg-theme-text/5 transition-colors">Reintentar</button>
            </div>
          ) : loading && customers.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <RefreshCw className="w-5 h-5 animate-spin text-theme-accent" />
            </div>
          ) : customers.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-theme-text-muted">
              <Building2 className="w-10 h-10 opacity-20" />
              <p className="text-sm">No hay clientes que coincidan con tu búsqueda.</p>
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 z-10 bg-theme-surface">
                  <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
                    <th className="text-left py-3 px-4 w-10">Tipo</th>
                    <th className="text-left py-3 px-4">Nombre / Giro</th>
                    <th className="text-left py-3 px-4 whitespace-nowrap">Doc. identidad</th>
                    <th className="text-left py-3 px-4">Correo electrónico</th>
                    <th className="text-left py-3 px-4">Ubicación</th>
                    <th className="text-right py-3 px-4 whitespace-nowrap">Crédito</th>
                    <th className="text-left py-3 px-4">Origen</th>
                    <th className="text-left py-3 px-4">Estado</th>
                    <th className="text-right py-3 px-4 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map(c => (
                    <tr 
                      key={c.id} 
                      onClick={() => setSelectedCustomer(c)}
                      onDoubleClick={() => openEdit(c)}
                      className={cn(
                        "border-b border-theme-border hover:bg-theme-text/5 transition-colors group cursor-pointer",
                        selectedCustomer?.id === c.id ? "bg-theme-accent/10" : ""
                      )}
                    >
                      {/* Tipo */}
                      <td className="py-3 px-4">
                        <div className={cn(
                          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                          c.customer_type === 'PERSONA' ? "bg-purple-500/10" : "bg-theme-accent/10"
                        )}>
                          {c.customer_type === 'PERSONA'
                            ? <User2 className="w-4 h-4 text-purple-400" />
                            : <Building2 className="w-4 h-4 text-theme-accent" />}
                        </div>
                      </td>

                      {/* Nombre */}
                      <td className="py-3 px-4">
                        <div className="font-semibold text-sm text-theme-text max-w-[220px] truncate">{c.business_name}</div>
                        {c.fantasy_name && <div className="text-xs text-theme-text-muted truncate max-w-[220px]">{c.fantasy_name}</div>}
                        {c.business_activity && <div className="text-[10px] text-theme-text-muted/60 truncate max-w-[220px]">{c.business_activity}</div>}
                      </td>

                      {/* RUT */}
                      <td className="py-3 px-4 text-sm font-mono text-theme-text whitespace-nowrap">
                        {c.rut || <span className="text-theme-text-muted/30">—</span>}
                      </td>

                      {/* Email */}
                      <td className="py-3 px-4">
                        {c.email
                          ? <span className="text-sm text-theme-text block max-w-[180px] truncate">{c.email}</span>
                          : <span className="text-theme-text-muted/30 text-sm">—</span>}
                      </td>

                      {/* Ubicación */}
                      <td className="py-3 px-4">
                        {(c.commune || c.city)
                          ? <div className="flex items-center gap-1 text-xs text-theme-text-muted max-w-[140px]">
                              <MapPin className="w-3 h-3 shrink-0 opacity-50" />
                              <span className="truncate">{[c.commune, c.city].filter(Boolean).join(', ')}</span>
                            </div>
                          : <span className="text-theme-text-muted/30 text-xs">—</span>}
                      </td>

                      {/* Crédito */}
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {c.credit_limit
                          ? <div className="text-sm font-medium text-theme-text">{fmtCredit(c.credit_limit)}</div>
                          : null}
                        {c.credit_days
                          ? <div className="text-[10px] text-theme-text-muted">{c.credit_days} días</div>
                          : (!c.credit_limit && <span className="text-theme-text-muted/30 text-sm">—</span>)}
                      </td>

                      {/* Origen */}
                      <td className="py-3 px-4">
                        <span className={cn(
                          "text-[10px] font-bold px-2 py-0.5 rounded border",
                          c.source === 'BSALE'
                            ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                            : "bg-orange-500/10 text-orange-400 border-orange-500/20"
                        )}>{c.source}</span>
                      </td>

                      {/* Estado */}
                      <td className="py-3 px-4">
                        <span className={cn(
                          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border",
                          c.is_active
                            ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                            : "bg-red-400/10 text-red-400 border-red-400/20"
                        )}>
                          <span className={cn("w-1.5 h-1.5 rounded-full", c.is_active ? "bg-emerald-500" : "bg-red-400")} />
                          {c.is_active ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>

                      {/* Menu */}
                      <td className="py-3 px-4 text-right">
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                          <RowMenu customer={c} onEdit={() => openEdit(c)} onToggle={() => handleToggleActive(c)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer */}
          {!loading && !error && customers.length > 0 && (
            <div className="shrink-0 flex items-center justify-between text-xs p-4 border-t border-theme-border/60 bg-theme-text/[0.01] text-theme-text-muted/50">
              <span>{customers.length} cliente{customers.length !== 1 ? 's' : ''} mostrado{customers.length !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Fixed Drawer Overlay for Detail/Edit ── */}
      {isDetailOpen && (
        <div className="fixed inset-0 z-[100] flex justify-end">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-black/20 animate-in fade-in duration-200"
            onClick={closeForm}
          />
          
          {/* Drawer Panel */}
          <div className="relative w-full sm:w-[45vw] min-w-[480px] max-w-[800px] h-full bg-theme-surface shadow-2xl border-l border-theme-border/50 animate-in slide-in-from-right-full duration-300">
            <CustomerForm editing={isNewForm ? null : selectedCustomer} onClose={closeForm} onSaved={onSaved} />
          </div>
        </div>
      )}
    </div>
  )
}
