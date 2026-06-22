'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getSuppliers, createSupplier, updateSupplier, deactivateSupplier, importSuppliers, type Supplier } from '@/app/actions/adquisiciones/suppliers'
import * as XLSX from 'xlsx'
import { Search, Plus, FileSpreadsheet, Upload, Download, MoreHorizontal, Filter, X, ArrowLeft } from 'lucide-react'
import { useMemo } from 'react'

export function SuppliersPanel() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({ region: '', city: '', is_active: '' })
  const [showFilters, setShowFilters] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; errors: string[]; warnings: string[] } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  
  const filteredSuppliers = useMemo(() => {
    return suppliers.filter(s => {
      if (filters.region && s.region !== filters.region) return false
      if (filters.city && s.city !== filters.city) return false
      if (filters.is_active === 'true' && !s.is_active) return false
      if (filters.is_active === 'false' && s.is_active) return false
      return true
    })
  }, [suppliers, filters])

  const uniqueRegions = useMemo(() => Array.from(new Set(suppliers.map(s => s.region).filter(Boolean))), [suppliers])
  const uniqueCities = useMemo(() => Array.from(new Set(suppliers.map(s => s.city).filter(Boolean))), [suppliers])

  function exportToExcel(rows: Supplier[], label: string) {
    const headers = [
      'rut', 'razon_social', 'nombre_fantasia', 'giro', 'contacto', 'correo',
      'telefono', 'direccion', 'ciudad', 'region', 'condicion_pago',
      'dias_credito', 'descuento_porcentaje', 'observacion', 'estado'
    ]
    const data = rows.map(r => ({
      rut: r.rut || '', razon_social: r.business_name, nombre_fantasia: r.fantasy_name || '',
      giro: r.business_activity || '', contacto: r.contact_name || '', correo: r.contact_email || '',
      telefono: r.contact_phone || '', direccion: r.address || '', ciudad: r.city || '',
      region: r.region || '', condicion_pago: r.payment_terms || '', dias_credito: r.credit_days,
      descuento_porcentaje: r.discount_percent, observacion: r.notes || '', estado: r.is_active ? 'Activo' : 'Inactivo'
    }))
    const ws = XLSX.utils.json_to_sheet(data, { header: headers })
    ws['!cols'] = headers.map(() => ({ wch: 22 }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Proveedores')
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    XLSX.writeFile(wb, `proveedores_mym_${label}_${date}.xlsx`)
    setShowExportMenu(false)
  }

  function handleExportAll() { exportToExcel(suppliers, 'todos') }
  function handleExportFiltered() { exportToExcel(filteredSuppliers, 'filtrados') }

  function downloadTemplate() {
    const headers = [
      'rut', 'razon_social', 'nombre_fantasia', 'giro', 'contacto', 'correo',
      'telefono', 'direccion', 'ciudad', 'region', 'condicion_pago',
      'dias_credito', 'descuento_porcentaje', 'observacion',
    ]
    const example = {
      rut: '76.123.456-7',
      razon_social: 'Distribuidora de Alimentos Ltda.',
      nombre_fantasia: 'Alimentos Premium',
      giro: 'Venta al por mayor de alimentos para mascotas',
      contacto: 'Juan Pérez',
      correo: 'jperez@ejemplo.cl',
      telefono: '+56 9 1234 5678',
      direccion: 'Av. Principal 1234',
      ciudad: 'Santiago',
      region: 'Región Metropolitana',
      condicion_pago: '30 días',
      dias_credito: 30,
      descuento_porcentaje: 5,
      observacion: 'Proveedor con descuento por volumen',
    }
    const ws = XLSX.utils.json_to_sheet([example], { header: headers })
    ws['!cols'] = headers.map(() => ({ wch: 22 }))
    ws['!rows'] = [{ hpx: 28 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Proveedores')
    XLSX.writeFile(wb, 'plantilla_proveedores_mym.xlsx')
  }

  const [form, setForm] = useState({
    rut: '', business_name: '', fantasy_name: '', business_activity: '',
    contact_name: '', contact_email: '', contact_phone: '', address: '',
    city: '', region: '', payment_terms: '', credit_days: '0', discount_percent: '0', notes: '',
  })

  const load = useCallback(async () => {
    setLoading(true)
    const data = await getSuppliers(search || undefined)
    setSuppliers(data)
    setLoading(false)
  }, [search])

  useEffect(() => { load() }, [load])

  function msg(text: string) { setMessage(text); setTimeout(() => setMessage(''), 3500) }

  function resetForm() {
    setForm({ rut: '', business_name: '', fantasy_name: '', business_activity: '', contact_name: '', contact_email: '', contact_phone: '', address: '', city: '', region: '', payment_terms: '', credit_days: '0', discount_percent: '0', notes: '' })
    setEditId(null)
  }

  async function openEdit(s: Supplier) {
    setForm({
      rut: s.rut ?? '', business_name: s.business_name, fantasy_name: s.fantasy_name ?? '',
      business_activity: s.business_activity ?? '', contact_name: s.contact_name ?? '',
      contact_email: s.contact_email ?? '', contact_phone: s.contact_phone ?? '',
      address: s.address ?? '', city: s.city ?? '', region: s.region ?? '',
      payment_terms: s.payment_terms ?? '', credit_days: String(s.credit_days),
      discount_percent: String(s.discount_percent), notes: s.notes ?? '',
    })
    setEditId(s.id)
    setShowForm(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const fd = new FormData()
    Object.entries(form).forEach(([k, v]) => fd.set(k, v))
    if (editId) {
      const res = await updateSupplier(editId, fd)
      if (res.error) { msg(res.error); return }
      msg('Proveedor actualizado')
    } else {
      const res = await createSupplier(fd)
      if (res.error) { msg(res.error); return }
      msg('Proveedor creado')
    }
    setShowForm(false)
    resetForm()
    load()
  }

  async function handleDeactivate(s: Supplier) {
    if (!confirm(`¿Desactivar proveedor "${s.business_name}"?`)) return
    const res = await deactivateSupplier(s.id)
    if (res.error) { msg(res.error); return }
    msg(res.newActive ? 'Proveedor activado' : 'Proveedor desactivado')
    load()
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer)
      const workbook = XLSX.read(data, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
      const errors: string[] = []
      const warnings: string[] = []
      function normalizeRut(r: string) { return r.replace(/[.-]/g, '').replace(/\s/g, '').toUpperCase() }
      const seenRuts = new Set<string>()
      const validRows: Record<string, unknown>[] = []

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const rut = String(row.rut ?? '').trim()
        const bname = String(row.razon_social ?? '').trim()
        if (!rut && !bname) continue
        const rutNorm = rut ? normalizeRut(rut) : ''
        if (rutNorm && seenRuts.has(rutNorm)) { errors.push(`Fila ${i + 1}: RUT ${rut} duplicado en el archivo`); continue }
        if (rutNorm) seenRuts.add(rutNorm)
        // Store as plain object with trimmed strings
        validRows.push({
          rut, razon_social: bname,
          nombre_fantasia: String(row.nombre_fantasia ?? '').trim(),
          giro: String(row.giro ?? '').trim(),
          contacto: String(row.contacto ?? '').trim(),
          correo: String(row.correo ?? '').trim(),
          telefono: String(row.telefono ?? '').trim(),
          direccion: String(row.direccion ?? '').trim(),
          ciudad: String(row.ciudad ?? '').trim(),
          region: String(row.region ?? '').trim(),
          condicion_pago: String(row.condicion_pago ?? '').trim(),
          dias_credito: Number(row.dias_credito || 0),
          descuento_porcentaje: Number(row.descuento_porcentaje || 0),
          observacion: String(row.observacion ?? '').trim(),
        })
      }

      if (errors.length > 0) {
        setPreview({ rows: [], errors, warnings })
        return
      }

      setPreview({ rows: validRows, errors: [], warnings })
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleImportConfirm() {
    if (!preview || preview.errors.length > 0) return
    const cleanRows = preview.rows.map(row => ({
      rut: String(row.rut ?? '').trim(),
      razon_social: String(row.razon_social ?? '').trim(),
      nombre_fantasia: String(row.nombre_fantasia ?? '').trim(),
      giro: String(row.giro ?? '').trim(),
      contacto: String(row.contacto ?? '').trim(),
      correo: String(row.correo ?? '').trim(),
      telefono: String(row.telefono ?? '').trim(),
      direccion: String(row.direccion ?? '').trim(),
      ciudad: String(row.ciudad ?? '').trim(),
      region: String(row.region ?? '').trim(),
      condicion_pago: String(row.condicion_pago ?? '').trim(),
      dias_credito: Number(row.dias_credito || 0),
      descuento_porcentaje: Number(row.descuento_porcentaje || 0),
      observacion: String(row.observacion ?? '').trim(),
    }))
    const res = await importSuppliers(cleanRows)
    if ('error' in res && typeof res.error === 'string') { msg(res.error); return }
    setPreview(null)
    msg(`${res.created} proveedores importados${res.errors.length > 0 ? `, ${res.errors.length} errores` : ''}`)
    load()
  }

  if (showForm) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-theme-surface animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSubmit} className="flex-1 overflow-auto">
          <div className="px-6 py-4 border-b border-theme-border bg-theme-text/5 flex items-center justify-between sticky top-0 z-10">
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => { setShowForm(false); resetForm() }} className="p-2 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold text-theme-text">{editId ? 'Editar proveedor' : 'Nuevo proveedor'}</h2>
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => { setShowForm(false); resetForm() }} className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-sm font-semibold transition-colors">
                Cancelar
              </button>
              <button type="submit" className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-colors shadow-lg shadow-theme-accent/20">
                Guardar
              </button>
            </div>
          </div>
          <div className="p-6 lg:p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-5">
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">RUT</label>
                  <input type="text" value={form.rut} onChange={e => setForm(p => ({ ...p, rut: e.target.value }))}
                    disabled={!!editId}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text disabled:text-theme-text-muted/50 focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Razón social *</label>
                  <input type="text" value={form.business_name} onChange={e => setForm(p => ({ ...p, business_name: e.target.value }))} required
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Nombre fantasía</label>
                  <input type="text" value={form.fantasy_name} onChange={e => setForm(p => ({ ...p, fantasy_name: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Giro</label>
                  <input type="text" value={form.business_activity} onChange={e => setForm(p => ({ ...p, business_activity: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Contacto</label>
                  <input type="text" value={form.contact_name} onChange={e => setForm(p => ({ ...p, contact_name: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Correo</label>
                  <input type="email" value={form.contact_email} onChange={e => setForm(p => ({ ...p, contact_email: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Teléfono</label>
                  <input type="text" value={form.contact_phone} onChange={e => setForm(p => ({ ...p, contact_phone: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Condición de pago</label>
                  <input type="text" value={form.payment_terms} onChange={e => setForm(p => ({ ...p, payment_terms: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Días crédito</label>
                  <input type="number" min="0" value={form.credit_days} onChange={e => setForm(p => ({ ...p, credit_days: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Descuento %</label>
                  <input type="number" min="0" max="100" step="0.01" value={form.discount_percent} onChange={e => setForm(p => ({ ...p, discount_percent: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Ciudad</label>
                  <input type="text" value={form.city} onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Región</label>
                  <input type="text" value={form.region} onChange={e => setForm(p => ({ ...p, region: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4 space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Dirección</label>
                  <input type="text" value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>
                <div className="col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4 space-y-1">
                  <label className="text-xs text-theme-text-muted/60">Observaciones</label>
                  <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={3}
                    className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30 resize-none" />
                </div>
            </div>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface">
      {message && (
        <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-4 py-2.5 text-sm text-theme-text-muted">{message}</div>
      )}

      <div className="shrink-0 flex flex-col gap-4 p-5 border-b border-theme-border/60 bg-theme-text/[0.01]">
        {/* Barra superior de herramientas */}
        <div className="flex flex-col md:flex-row items-center gap-3 w-full">
          {/* Búsqueda */}
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por RUT, razón social, fantasía o correo..."
              className="w-full h-11 pl-10 pr-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40" />
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto">
            {/* Opciones Importar/Exportar */}
            <div className="relative group z-10">
              <button className="h-11 px-3 md:px-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text text-sm font-semibold transition-all flex items-center justify-center gap-2">
                <MoreHorizontal className="w-5 h-5 md:w-4 md:h-4" />
                <span className="hidden md:inline">Opciones</span>
              </button>
              <div className="absolute right-0 top-full mt-2 w-56 bg-theme-surface backdrop-blur-xl border border-theme-border rounded-2xl shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 p-2">
                <button onClick={downloadTemplate} className="w-full text-left px-3 py-2.5 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4" /> Descargar plantilla
                </button>
                <label className="w-full text-left px-3 py-2.5 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors flex items-center gap-2 cursor-pointer">
                  <Upload className="w-4 h-4" /> Importar Excel
                  <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileUpload} className="hidden" />
                </label>
                <div className="h-px bg-theme-border my-1" />
                <div className="w-full text-left px-3 py-2 text-[10px] font-bold text-theme-text-muted/50 uppercase tracking-wider">Exportar</div>
                <button onClick={handleExportAll} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Todos los proveedores</button>
                <button onClick={handleExportFiltered} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Proveedores filtrados</button>
              </div>
            </div>

            {/* Filtros Toggle */}
            <button onClick={() => setShowFilters(!showFilters)} className={`h-11 px-3 md:px-4 rounded-xl border transition-all flex items-center justify-center gap-2 text-sm font-semibold ${showFilters ? 'bg-theme-text/10 border-theme-border text-theme-text' : 'bg-theme-surface border-theme-border hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text'}`}>
              <Filter className="w-4 h-4" />
              <span className="hidden md:inline">Filtros</span>
            </button>

            {/* Nuevo */}
            <button onClick={() => { resetForm(); setShowForm(true) }} className="h-11 px-4 md:px-5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-all shadow-lg shadow-theme-accent/20 flex items-center justify-center gap-2 ml-auto md:ml-0">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Nuevo</span>
            </button>
          </div>
        </div>

        {/* Panel de Filtros Expandible */}
        {showFilters && (
          <div className="p-5 rounded-2xl border border-theme-border bg-theme-text/5 animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-xs font-bold text-theme-text-muted/80 uppercase tracking-wider">Filtros Avanzados</h4>
              <button onClick={() => setFilters({ region: '', city: '', is_active: '' })} className="text-xs font-semibold text-theme-text-accent hover:text-theme-text flex items-center gap-1 transition-colors">
                <X className="w-3 h-3" /> Limpiar filtros
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <select value={filters.region} onChange={e => setFilters(p => ({...p, region: e.target.value}))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Todas las regiones</option>
                {uniqueRegions.map(r => <option key={String(r)} value={String(r)}>{String(r)}</option>)}
              </select>
              <select value={filters.city} onChange={e => setFilters(p => ({...p, city: e.target.value}))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Todas las ciudades</option>
                {uniqueCities.map(c => <option key={String(c)} value={String(c)}>{String(c)}</option>)}
              </select>
              <select value={filters.is_active} onChange={e => setFilters(p => ({...p, is_active: e.target.value}))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Estado (Todos)</option>
                <option value="true">Activos</option>
                <option value="false">Inactivos</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {preview && (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-theme-text">Vista previa - {preview.rows.length} filas válidas</h3>
            <div className="flex gap-2">
              <button onClick={() => setPreview(null)} className="px-3 py-1.5 rounded-lg border border-theme-border text-xs text-theme-text-muted/70 hover:text-theme-text">Cancelar</button>
              {preview.errors.length === 0 && preview.rows.length > 0 && (
                <button onClick={handleImportConfirm} className="px-3 py-1.5 rounded-lg bg-theme-accent text-xs text-white font-semibold hover:bg-theme-accent-hover">Confirmar importación</button>
              )}
            </div>
          </div>
          {preview.errors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 space-y-1">
              {preview.errors.map((e, i) => <p key={i} className="text-xs text-red-400">{e}</p>)}
            </div>
          )}
          {preview.rows.length > 0 && (
            <div className="overflow-x-auto text-xs text-theme-text-muted/70 max-h-48 overflow-y-auto">
              <table className="w-full">
                <thead><tr className="border-b border-theme-border text-theme-accent/60">
                  <th className="text-left py-2 px-2">RUT</th>
                  <th className="text-left py-2 px-2">Razón social</th>
                  <th className="text-left py-2 px-2">Contacto</th>
                  <th className="text-left py-2 px-2">Correo</th>
                </tr></thead>
                <tbody>
                  {preview.rows.map((r, i) => (
                    <tr key={i} className="border-b border-theme-border">
                      <td className="py-2 px-2">{String(r.rut ?? '')}</td>
                      <td className="py-2 px-2">{String(r.razon_social ?? '')}</td>
                      <td className="py-2 px-2">{String(r.contacto ?? '')}</td>
                      <td className="py-2 px-2">{String(r.correo ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Cargando...</p>
        </div>
      ) : filteredSuppliers.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No hay proveedores registrados.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-theme-surface">
              <tr className="border-b border-theme-border text-xs text-theme-accent/60 uppercase tracking-wider">
                <th className="text-left py-3 px-4 font-medium">RUT</th>
                <th className="text-left py-3 px-4 font-medium">Razón social</th>
                <th className="text-left py-3 px-4 font-medium">Nombre fantasía</th>
                <th className="text-left py-3 px-4 font-medium">Contacto</th>
                <th className="text-left py-3 px-4 font-medium">Correo</th>
                <th className="text-left py-3 px-4 font-medium">Teléfono</th>
                <th className="text-left py-3 px-4 font-medium">Cond. pago</th>
                <th className="text-left py-3 px-4 font-medium">Días</th>
                <th className="text-left py-3 px-4 font-medium">Dto %</th>
                <th className="text-left py-3 px-4 font-medium">Estado</th>
                <th className="text-right py-3 px-4 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredSuppliers.map(s => (
                <tr key={s.id} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                  <td className="py-3 px-4 text-theme-text-accent/80 text-xs font-mono">{s.rut || '—'}</td>
                  <td className="py-3 px-4 text-theme-text text-xs font-medium">{s.business_name}</td>
                  <td className="py-3 px-4 text-theme-text-accent/80 text-xs">{s.fantasy_name || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-accent/80 text-xs">{s.contact_name || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted/60 text-xs">{s.contact_email || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted/60 text-xs">{s.contact_phone || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-accent/80 text-xs">{s.payment_terms || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-accent/80 text-xs">{s.credit_days}</td>
                  <td className="py-3 px-4 text-theme-text-accent/80 text-xs">{s.discount_percent}%</td>
                  <td className="py-3 px-4">
                    {s.is_active ? (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-theme-accent-hover/10 text-theme-accent border-theme-accent/20">Activo</span>
                    ) : (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-red-500/10 text-red-400 border-red-500/20">Inactivo</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button onClick={() => openEdit(s)} className="text-xs text-theme-accent/70 hover:text-theme-text-muted mr-3">Editar</button>
                    <button onClick={() => handleDeactivate(s)}
                      className={`text-xs ${s.is_active ? 'text-red-400/70 hover:text-red-400' : 'text-theme-accent/70 hover:text-theme-text-muted'}`}>
                      {s.is_active ? 'Desactivar' : 'Activar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}


    </div>
  )
}
