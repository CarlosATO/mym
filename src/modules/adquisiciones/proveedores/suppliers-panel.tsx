'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { getSuppliers, createSupplier, updateSupplier, deactivateSupplier, importSuppliers, getBsalePseudoStats, type Supplier, type BsalePseudoStat } from '@/app/actions/adquisiciones/suppliers'
import * as XLSX from 'xlsx'
import { Search, Plus, FileSpreadsheet, Upload, Download, MoreHorizontal, Filter, X, ArrowLeft, Check, AlertCircle } from 'lucide-react'
import { PseudoSupplierBsaleSyncStatus } from '@/components/integraciones/bsale-sync-status'

export function SuppliersPanel() {
  const [activeTab, setActiveTab] = useState<'REAL' | 'BSALE'>('REAL')

  // REAL
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  // BSALE
  const [pseudos, setPseudos] = useState<BsalePseudoStat[]>([])

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

  // Form states
  const [form, setForm] = useState({
    rut: '', business_name: '', fantasy_name: '', business_activity: '',
    contact_name: '', contact_email: '', contact_phone: '', address: '',
    city: '', region: '', payment_terms: '', credit_days: '0', discount_percent: '0', notes: '',
  })

  // Association Checklist states
  const [pseudoSearch, setPseudoSearch] = useState('')
  const [selectedPseudos, setSelectedPseudos] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    if (activeTab === 'REAL') {
      const data = await getSuppliers(search || undefined, 'REAL')
      setSuppliers(data)
    } else {
      const data = await getBsalePseudoStats()
      // local search
      const term = search.toLowerCase()
      setPseudos(data.filter(p => !term || p.display_name.toLowerCase().includes(term) || p.business_name.toLowerCase().includes(term) || p.suggested_root.toLowerCase().includes(term)))
    }
    setLoading(false)
  }, [search, activeTab])

  useEffect(() => { load() }, [load])

  // Pre-load all pseudos for the form checklist if needed
  const [allPseudos, setAllPseudos] = useState<BsalePseudoStat[]>([])
  const loadAllPseudos = async () => {
    const data = await getBsalePseudoStats()
    setAllPseudos(data)
  }

  const visibleRealSuppliers = useMemo(() => {
    return suppliers.filter(s => s.supplier_kind === 'REAL')
  }, [suppliers])

  const filteredSuppliers = useMemo(() => {
    return visibleRealSuppliers.filter(s => {
      if (filters.region && s.region !== filters.region) return false
      if (filters.city && s.city !== filters.city) return false
      if (filters.is_active === 'true' && !s.is_active) return false
      if (filters.is_active === 'false' && s.is_active) return false
      return true
    })
  }, [visibleRealSuppliers, filters])

  useEffect(() => {
    console.log('[SuppliersPanel]', {
      activeTab,
      realSuppliersLength: suppliers.length,
      visibleRealSuppliersLength: visibleRealSuppliers.length,
      pseudoSuppliersLength: pseudos.length,
    })
  }, [activeTab, suppliers, visibleRealSuppliers, pseudos])

  const uniqueRegions = useMemo(() => Array.from(new Set(visibleRealSuppliers.map(s => s.region).filter(Boolean))), [visibleRealSuppliers])
  const uniqueCities = useMemo(() => Array.from(new Set(visibleRealSuppliers.map(s => s.city).filter(Boolean))), [visibleRealSuppliers])

  const filteredFormPseudos = useMemo(() => {
    let list = allPseudos
    const t = pseudoSearch.toLowerCase()
    if (t) {
      list = list.filter(p => p.display_name.toLowerCase().includes(t) || p.suggested_root.toLowerCase().includes(t))
    }
    // Always show selected, then group by remanente vs normal
    return list.sort((a, b) => {
      const aSel = selectedPseudos.has(a.id) ? 1 : 0
      const bSel = selectedPseudos.has(b.id) ? 1 : 0
      if (aSel !== bSel) return bSel - aSel
      const aRem = a.total_products === 0 ? 1 : 0
      const bRem = b.total_products === 0 ? 1 : 0
      if (aRem !== bRem) return aRem - bRem
      return a.display_name.localeCompare(b.display_name)
    })
  }, [allPseudos, pseudoSearch, selectedPseudos])

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

  function msg(text: string) { setMessage(text); setTimeout(() => setMessage(''), 3500) }

  function resetForm() {
    setForm({ rut: '', business_name: '', fantasy_name: '', business_activity: '', contact_name: '', contact_email: '', contact_phone: '', address: '', city: '', region: '', payment_terms: '', credit_days: '0', discount_percent: '0', notes: '' })
    setEditId(null)
    setSelectedPseudos(new Set())
    setPseudoSearch('')
  }

  async function openCreate() {
    resetForm()
    await loadAllPseudos()
    setShowForm(true)
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
    const stats = await getBsalePseudoStats()
    setAllPseudos(stats)
    const sel = new Set<string>()
    stats.forEach(p => {
      if (p.parent_supplier_id === s.id) sel.add(p.id)
    })
    setSelectedPseudos(sel)
    setShowForm(true)
  }

  function togglePseudo(p: BsalePseudoStat) {
    const next = new Set(selectedPseudos)
    if (next.has(p.id)) {
      next.delete(p.id)
      setSelectedPseudos(next)
    } else {
      if (p.parent_supplier_id && p.parent_supplier_id !== editId) {
        if (!confirm(`El pseudoproveedor "${p.display_name}" ya está asociado a "${p.parent_supplier_name}". ¿Deseas reasignarlo a este proveedor?`)) {
          return
        }
      }
      next.add(p.id)
      setSelectedPseudos(next)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const fd = new FormData()
    Object.entries(form).forEach(([k, v]) => fd.set(k, v))
    const ids = Array.from(selectedPseudos)

    if (editId) {
      const res = await updateSupplier(editId, fd, ids)
      if (res.error) { msg(res.error); return }
      msg('Proveedor actualizado exitosamente con sus asociaciones')
    } else {
      const res = await createSupplier(fd, ids)
      if (res.error) { msg(res.error); return }
      msg('Proveedor real y asociaciones guardados con éxito')
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
              <h2 className="text-lg font-bold text-theme-text">{editId ? 'Editar Proveedor Real' : 'Nuevo Proveedor Real'}</h2>
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => { setShowForm(false); resetForm() }} className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-sm font-semibold transition-colors">
                Cancelar
              </button>
              <button type="submit" className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-colors shadow-lg shadow-theme-accent/20">
                Guardar Proveedor
              </button>
            </div>
          </div>
          <div className="p-6 lg:p-8">
            <div className="max-w-7xl mx-auto space-y-10">
              
              <div className="space-y-6">
                <div className="border-b border-theme-border pb-4">
                  <h3 className="text-base font-bold text-theme-text">Datos Legales y Comerciales</h3>
                  <p className="text-xs text-theme-text-muted mt-1">Información principal del proveedor real.</p>
                </div>
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

              {/* Sección de Asociación Bsale */}
              <div className="space-y-6">
                <div className="border-b border-theme-border pb-4 flex items-end justify-between">
                  <div>
                    <h3 className="text-base font-bold text-theme-text">Asociar pseudoproveedores Bsale</h3>
                    <p className="text-xs text-theme-text-muted mt-1">Selecciona qué orígenes operativos de Bsale pertenecen a esta entidad legal.</p>
                  </div>
                  <div className="text-xs font-semibold px-3 py-1 bg-theme-accent/10 text-theme-accent rounded-lg border border-theme-accent/20">
                    {selectedPseudos.size} seleccionados
                  </div>
                </div>
                
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
                  <input type="text" value={pseudoSearch} onChange={e => setPseudoSearch(e.target.value)}
                    placeholder="Filtrar por nombre o raíz sugerida..."
                    className="w-full h-10 pl-9 pr-4 rounded-xl border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
                </div>

                <div className="border border-theme-border rounded-xl bg-theme-surface overflow-hidden">
                  <div className="max-h-96 overflow-y-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-theme-text/5 sticky top-0 z-10 shadow-sm">
                        <tr>
                          <th className="py-3 px-4 font-semibold text-theme-text-muted w-10"></th>
                          <th className="py-3 px-4 font-semibold text-theme-text-muted">Nombre Bsale</th>
                          <th className="py-3 px-4 font-semibold text-theme-text-muted">Raíz</th>
                          <th className="py-3 px-4 font-semibold text-theme-text-muted text-right">Productos</th>
                          <th className="py-3 px-4 font-semibold text-theme-text-muted">Estado Actual</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-theme-border/50">
                        {filteredFormPseudos.map(p => {
                          const isSelected = selectedPseudos.has(p.id)
                          const isRemnant = p.total_products === 0
                          const hasOtherParent = p.parent_supplier_id !== null && p.parent_supplier_id !== editId
                          
                          return (
                            <tr key={p.id} className={`hover:bg-theme-text/5 transition-colors cursor-pointer ${isSelected ? 'bg-theme-accent/5' : ''}`}
                                onClick={() => togglePseudo(p)}>
                              <td className="py-3 px-4 w-10">
                                <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${isSelected ? 'bg-theme-accent border-theme-accent' : 'border-theme-border bg-theme-surface'}`}>
                                  {isSelected && <Check className="w-3 h-3 text-white" />}
                                </div>
                              </td>
                              <td className="py-3 px-4 font-medium text-theme-text">
                                {p.display_name}
                                {isRemnant && <span className="ml-2 text-[10px] bg-theme-text/10 text-theme-text-muted px-1.5 py-0.5 rounded">Remanente</span>}
                              </td>
                              <td className="py-3 px-4 text-theme-text-muted/80">{p.suggested_root}</td>
                              <td className="py-3 px-4 text-right font-mono">{p.total_products}</td>
                              <td className="py-3 px-4">
                                {hasOtherParent ? (
                                  <span className="flex items-center gap-1 text-[11px] font-semibold text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded w-fit">
                                    <AlertCircle className="w-3 h-3" /> Asociado a {p.parent_supplier_name}
                                  </span>
                                ) : (p.parent_supplier_id !== null && p.parent_supplier_id === editId) ? (
                                  <span className="text-[11px] font-semibold text-theme-accent bg-theme-accent/10 px-2 py-0.5 rounded w-fit">
                                    Asociado actual
                                  </span>
                                ) : isRemnant ? (
                                  <span className="text-[11px] font-medium text-theme-text-muted bg-theme-text/5 px-2 py-0.5 rounded w-fit">
                                    Remanente sin productos
                                  </span>
                                ) : (
                                  <span className="text-[11px] font-medium text-theme-text-muted bg-theme-text/5 px-2 py-0.5 rounded w-fit">
                                    Sin asociar
                                  </span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                        {filteredFormPseudos.length === 0 && (
                          <tr><td colSpan={5} className="py-8 text-center text-theme-text-muted/50">No se encontraron pseudoproveedores</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

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

      {/* TABS */}
      <div className="shrink-0 flex items-center border-b border-theme-border bg-theme-text/[0.02] px-5 pt-3">
        <button onClick={() => { setActiveTab('REAL'); setSearch('') }} className={`px-4 py-2 text-sm font-bold border-b-2 transition-all ${activeTab === 'REAL' ? 'border-theme-accent text-theme-accent' : 'border-transparent text-theme-text-muted hover:text-theme-text'}`}>
          Proveedores Reales
        </button>
        <button onClick={() => { setActiveTab('BSALE'); setSearch('') }} className={`px-4 py-2 text-sm font-bold border-b-2 transition-all ${activeTab === 'BSALE' ? 'border-theme-accent text-theme-accent' : 'border-transparent text-theme-text-muted hover:text-theme-text'}`}>
          Pseudoproveedores Bsale
        </button>
      </div>

      <div className="shrink-0 flex flex-col gap-4 p-5 border-b border-theme-border/60 bg-theme-text/[0.01]">
        
        {activeTab === 'BSALE' && (
          <div className="flex w-full">
            <PseudoSupplierBsaleSyncStatus />
          </div>
        )}

        <div className="flex flex-col md:flex-row items-center gap-3 w-full">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder={activeTab === 'REAL' ? "Buscar reales por RUT o razón social..." : "Buscar pseudos por nombre o raíz..."}
              className="w-full h-11 pl-10 pr-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40" />
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto">
            {activeTab === 'REAL' && (
              <>
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
                    <button onClick={() => exportToExcel(suppliers, 'todos_reales')} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Todos los proveedores</button>
                    <button onClick={() => exportToExcel(filteredSuppliers, 'filtrados_reales')} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Proveedores filtrados</button>
                  </div>
                </div>

                <button onClick={() => setShowFilters(!showFilters)} className={`h-11 px-3 md:px-4 rounded-xl border transition-all flex items-center justify-center gap-2 text-sm font-semibold ${showFilters ? 'bg-theme-text/10 border-theme-border text-theme-text' : 'bg-theme-surface border-theme-border hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text'}`}>
                  <Filter className="w-4 h-4" />
                  <span className="hidden md:inline">Filtros</span>
                </button>

                <button onClick={openCreate} className="h-11 px-4 md:px-5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-all shadow-lg shadow-theme-accent/20 flex items-center justify-center gap-2 ml-auto md:ml-0">
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">Nuevo</span>
                </button>
              </>
            )}
          </div>
        </div>

        {activeTab === 'REAL' && showFilters && (
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

      {activeTab === 'REAL' && preview && (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-5 space-y-4 m-5 mb-0">
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
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-theme-text-muted/50 text-sm font-medium">Cargando...</p>
        </div>
      ) : activeTab === 'REAL' ? (
        filteredSuppliers.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-10 text-center animate-in fade-in">
            <div className="w-16 h-16 rounded-2xl bg-theme-text/5 border border-theme-border flex items-center justify-center mb-4">
              <FileSpreadsheet className="w-8 h-8 text-theme-text-muted/40" />
            </div>
            <h3 className="text-base font-bold text-theme-text mb-1">Aún no existen proveedores reales</h3>
            <p className="text-sm text-theme-text-muted/70 max-w-sm mb-6">Crea un proveedor real (legal) y asóciale los pseudoproveedores operativos de Bsale para unificar su catálogo.</p>
            <button onClick={openCreate} className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold shadow-lg shadow-theme-accent/20">
              Crear Proveedor Real
            </button>
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
                  <th className="text-left py-3 px-4 font-medium">Cond. pago</th>
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
                    <td className="py-3 px-4 text-theme-text-accent/80 text-xs">{s.payment_terms || '—'}</td>
                    <td className="py-3 px-4">
                      {s.is_active ? (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-theme-accent-hover/10 text-theme-accent border-theme-accent/20">Activo</span>
                      ) : (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-red-500/10 text-red-400 border-red-500/20">Inactivo</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button onClick={() => openEdit(s)} className="text-xs text-theme-accent/70 hover:text-theme-text-muted mr-3 font-semibold">Editar</button>
                      <button onClick={() => handleDeactivate(s)}
                        className={`text-xs font-semibold ${s.is_active ? 'text-red-400/70 hover:text-red-400' : 'text-theme-accent/70 hover:text-theme-text-muted'}`}>
                        {s.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="flex-1 overflow-auto bg-theme-text/[0.02]">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-theme-surface">
              <tr className="border-b border-theme-border text-[11px] text-theme-text-muted uppercase tracking-wider font-semibold">
                <th className="text-left py-3 px-4">Pseudoproveedor Bsale</th>
                <th className="text-left py-3 px-4">Raíz Sugerida</th>
                <th className="text-left py-3 px-4">Proveedor Real Asociado</th>
                <th className="text-right py-3 px-4">Productos Totales</th>
                <th className="text-right py-3 px-4">Activos / Inactivos</th>
                <th className="text-right py-3 px-4">Mappings C / S Costo</th>
                <th className="text-left py-3 px-4">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/50">
              {pseudos.map(p => {
                const isRemnant = p.total_products === 0
                return (
                  <tr key={p.id} className="hover:bg-theme-surface transition-colors">
                    <td className="py-3 px-4 font-medium text-theme-text text-xs">
                      {p.display_name}
                      {p.display_name !== p.business_name && (
                        <div className="text-[10px] text-theme-text-muted/60 font-mono mt-0.5">{p.business_name}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-theme-text-muted text-xs font-mono">{p.suggested_root}</td>
                    <td className="py-3 px-4">
                      {p.parent_supplier_name ? (
                        <span className="text-xs font-semibold text-theme-text-accent bg-theme-accent/5 px-2 py-1 rounded border border-theme-accent/10">
                          {p.parent_supplier_name}
                        </span>
                      ) : (
                        <span className="text-xs text-theme-text-muted/50 italic">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs text-theme-text">{p.total_products}</td>
                    <td className="py-3 px-4 text-right text-xs">
                      <span className="text-emerald-500/80 font-mono">{p.active_products}</span>
                      <span className="text-theme-text-muted/30 mx-1">/</span>
                      <span className="text-theme-text-muted/80 font-mono">{p.inactive_products}</span>
                    </td>
                    <td className="py-3 px-4 text-right text-xs">
                      <span className="text-emerald-500/80 font-mono">{p.mappings_with_cost}</span>
                      <span className="text-theme-text-muted/30 mx-1">/</span>
                      <span className="text-theme-text-muted/80 font-mono">{p.mappings_without_cost}</span>
                    </td>
                    <td className="py-3 px-4">
                      {p.parent_supplier_id ? (
                        <span className="text-[10px] font-semibold text-theme-accent bg-theme-accent/10 px-2 py-0.5 rounded border border-theme-accent/20">Asociado</span>
                      ) : isRemnant ? (
                        <span className="text-[10px] font-semibold text-theme-text-muted bg-theme-text/5 px-2 py-0.5 rounded border border-theme-border">Remanente sin productos</span>
                      ) : (
                        <span className="text-[10px] font-semibold text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded border border-orange-400/20">Sin proveedor real</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {pseudos.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-theme-text-muted/50 text-sm">
                    No se encontraron pseudoproveedores operativos Bsale.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
