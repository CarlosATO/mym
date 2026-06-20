'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getWarehouses, createWarehouse, updateWarehouse, deactivateWarehouse, importWarehouses, type Warehouse } from '@/app/actions/adquisiciones/warehouses'
import { getRegions, getCommunes } from '@/app/actions/geography'
import * as XLSX from 'xlsx'
import { ArrowLeft } from 'lucide-react'
export function WarehousesPanel() {
  const [data, setData] = useState<Warehouse[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [filters, setFilters] = useState<{ search?: string; warehouse_type?: string; status?: string; is_active?: string; page: number; pageSize: number }>({ page: 1, pageSize: 50 })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; errors: string[] } | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [regions, setRegions] = useState<{ id: string; code: string; name: string }[]>([])
  const [communes, setCommunes] = useState<{ id: string; code: string; name: string }[]>([])
  const [form, setForm] = useState<Record<string, string>>({
    code: '', name: '', warehouse_type: 'CENTRAL', manager_name: '', manager_email: '',
    manager_phone: '', address: '', city: '', commune: '', region: '', region_name: '',
    capacity_m2: '', capacity_pallets: '', is_default: 'false', notes: '', status: 'ACTIVE',
  })
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true); const r = await getWarehouses(filters); setData(r.data); setTotal(r.total); setLoading(false)
  }, [filters])
  useEffect(() => { load() }, [load])
  useEffect(() => { getRegions().then(setRegions) }, [])

  async function handleRegionChange(regionId: string) {
    setForm(p => ({ ...p, region: regionId, commune: '' }))
    if (regionId) {
      const reg = regions.find(r => r.id === regionId)
      setForm(p => ({ ...p, region_name: reg?.name ?? '', commune: '' }))
      const c = await getCommunes(regionId);
      setCommunes(c)
    } else {
      setCommunes([])
    }
  }

  function m(t: string) { setMsg(t); setTimeout(() => setMsg(''), 3500) }
  function resetForm() {
    setForm({ code: '', name: '', warehouse_type: 'CENTRAL', manager_name: '', manager_email: '', manager_phone: '', address: '', city: '', commune: '', region: '', region_name: '', capacity_m2: '', capacity_pallets: '', is_default: 'false', notes: '', status: 'ACTIVE' })
    setEditId(null)
  }
  function openEdit(w: Warehouse) {
    setForm({
      code: w.code, name: w.name, warehouse_type: w.warehouse_type,
      manager_name: w.manager_name ?? '', manager_email: w.manager_email ?? '',
      manager_phone: w.manager_phone ?? '', address: w.address ?? '',
      city: w.city ?? '', commune: w.commune ?? '', region: '', region_name: w.region ?? '',
      capacity_m2: String(w.capacity_m2 ?? ''), capacity_pallets: String(w.capacity_pallets ?? ''),
      is_default: w.is_default ? 'true' : 'false', notes: w.notes ?? '', status: w.status,
    })
    if (w.region) {
      const reg = regions.find(r => r.name === w.region || r.code === w.region)
      if (reg) {
        setForm(p => ({ ...p, region: reg.id, region_name: reg.name }))
        getCommunes(reg.id).then(setCommunes)
      }
    }
    setEditId(w.id); setShowForm(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); const fd = new FormData(e.target as HTMLFormElement)
    if (editId) { const r = await updateWarehouse(editId, fd); if (r.error) { m(r.error); return } m('Bodega actualizada') }
    else { const r = await createWarehouse(fd); if (r.error) { m(r.error); return } m('Bodega creada') }
    setShowForm(false); resetForm(); load()
  }

  async function handleDeactivate(w: Warehouse) {
    if (!confirm(`¿${w.is_active ? 'Desactivar' : 'Activar'} bodega "${w.name}"?`)) return
    const r = await deactivateWarehouse(w.id)
    if (r.error) { m(r.error); return }
    m(r.newActive ? 'Bodega activada' : 'Bodega desactivada'); load()
  }

  function toggleSelect(id: string) { setSelected(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n }) }
  function toggleAll() {
    if (data.every(d => selected.has(d.id))) { setSelected(new Set()); return }
    setSelected(new Set(data.map(d => d.id)))
  }
  function setFilter(k: string, v: string) { setFilters(p => ({ ...p, [k]: v || undefined, page: 1 })); setSelected(new Set()) }

  function downloadTemplate() {
    const headers = ['codigo','nombre','tipo','encargado','correo_encargado','telefono_encargado','direccion','ciudad','comuna','region','capacidad_m2','capacidad_pallets','predeterminada','estado','observacion']
    const ex: Record<string, unknown> = { codigo: 'BOD-001', nombre: 'BODEGA NORTE', tipo: 'SUCURSAL', encargado: 'JUAN PEREZ', correo_encargado: 'jperez@ejemplo.cl', telefono_encargado: '+56 9 1234 5678', direccion: 'AV. NORTE 1234', ciudad: 'SANTIAGO', comuna: 'RECOLETA', region: 'RM', capacidad_m2: 500, capacidad_pallets: 200, predeterminada: 'NO', estado: 'ACTIVA', observacion: 'BODEGA DE RESPALDO' }
    const ws = XLSX.utils.json_to_sheet([ex], { header: headers }); ws['!cols'] = headers.map(() => ({ wch: 22 }))
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Bodegas'); XLSX.writeFile(wb, 'plantilla_bodegas_mym.xlsx')
  }

  function exportExcel(rows: Warehouse[]) {
    const h = ['codigo','nombre','tipo','encargado','correo_encargado','telefono_encargado','direccion','ciudad','comuna','region','capacidad_m2','capacidad_pallets','predeterminada','estado','observacion']
    const d = rows.map(r => ({ codigo: r.code, nombre: r.name, tipo: r.warehouse_type, encargado: r.manager_name ?? '', correo_encargado: r.manager_email ?? '', telefono_encargado: r.manager_phone ?? '', direccion: r.address ?? '', ciudad: r.city ?? '', comuna: r.commune ?? '', region: r.region ?? '', capacidad_m2: r.capacity_m2 ?? '', capacidad_pallets: r.capacity_pallets ?? '', predeterminada: r.is_default ? 'SI' : 'NO', estado: r.status === 'ACTIVE' ? 'ACTIVA' : r.status === 'INACTIVE' ? 'INACTIVA' : 'BLOQUEADA', observacion: r.notes ?? '' }))
    const ws = XLSX.utils.json_to_sheet(d, { header: h }); ws['!cols'] = h.map(() => ({ wch: 22 }))
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Bodegas')
    XLSX.writeFile(wb, `bodegas_mym_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`)
    setShowExport(false)
  }
  async function handleExportAll() { const r = await getWarehouses({ pageSize: 100000 }); exportExcel(r.data) }
  async function handleExportFiltered() { const r = await getWarehouses({ ...filters, pageSize: 100000 }); exportExcel(r.data) }
  function handleExportSelected() { exportExcel(data.filter(d => selected.has(d.id))) }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const wb = XLSX.read(new Uint8Array(ev.target?.result as ArrayBuffer), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]])
      const errors: string[] = []; const seenCode = new Set<string>(); const seenName = new Set<string>(); const vr: Record<string, unknown>[] = []
      let defaultCount = 0
      for (const r of rows) { if (['SI','TRUE','1'].includes(String(r.predeterminada ?? '').trim().toUpperCase())) defaultCount++ }
      if (defaultCount > 1) { errors.push('Solo una bodega puede ser predeterminada'); setPreview({ rows: [], errors }); return }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]; const c = String(r.codigo ?? '').trim().toUpperCase(); const n = String(r.nombre ?? '').trim().toUpperCase()
        if (!c && !n) continue
        if (seenCode.has(c)) { errors.push(`Fila ${i + 1}: Código "${c}" duplicado`); continue }; seenCode.add(c)
        if (seenName.has(n)) { errors.push(`Fila ${i + 1}: Nombre "${n}" duplicado`); continue }; seenName.add(n)
        const t = String(r.tipo ?? '').trim().toUpperCase()
        vr.push({ codigo: c, nombre: n, tipo: t, encargado: String(r.encargado ?? '').trim().toUpperCase(), correo_encargado: String(r.correo_encargado ?? '').trim(), telefono_encargado: String(r.telefono_encargado ?? '').trim(), direccion: String(r.direccion ?? '').trim().toUpperCase(), ciudad: String(r.ciudad ?? '').trim().toUpperCase(), comuna: String(r.comuna ?? '').trim().toUpperCase(), region: String(r.region ?? '').trim().toUpperCase(), capacidad_m2: Number(r.capacidad_m2 || ''), capacidad_pallets: Number(r.capacidad_pallets || ''), predeterminada: String(r.predeterminada ?? '').trim().toUpperCase(), estado: String(r.estado ?? '').trim().toUpperCase(), observacion: String(r.observacion ?? '').trim().toUpperCase() })
      }
      if (errors.length > 0) { setPreview({ rows: [], errors }); return }
      setPreview({ rows: vr, errors: [] })
    }; reader.readAsArrayBuffer(file)
  }

  async function handleImportConfirm() {
    if (!preview || preview.errors.length > 0) return
    const res = await importWarehouses(preview.rows)
    if ('error' in res && typeof res.error === 'string') { m(res.error); return }
    setPreview(null); m(`${res.created} bodegas importadas${res.errors.length > 0 ? `, ${res.errors.length} errores` : ''}`); load()
  }

  const tp = Math.ceil(total / (filters.pageSize ?? 50))
  const typeOpts = ['CENTRAL','SUCURSAL','TRANSITO','DEVOLUCIONES','CONSIGNACION','OTRO']

  if (showForm) {
    return (
      <div className="animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSubmit} className="bg-theme-surface rounded-2xl border border-theme-border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-theme-border bg-theme-text/5 flex items-center justify-between sticky top-0 z-10">
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => { setShowForm(false); resetForm() }} className="p-2 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold text-theme-text">{editId ? 'Editar bodega' : 'Nueva bodega'}</h2>
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
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Código *</label><input name="code" defaultValue={form.code} disabled={!!editId} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text disabled:text-gray-400 dark:disabled:text-theme-text-muted/50 focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Nombre *</label><input name="name" defaultValue={form.name} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Tipo *</label>
                <select name="warehouse_type" defaultValue={form.warehouse_type} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
                  {typeOpts.map(t => <option key={t} value={t} className="bg-white dark:bg-theme-surface">{t}</option>)}
                </select>
              </div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Encargado</label><input name="manager_name" defaultValue={form.manager_name} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Correo encargado</label><input name="manager_email" defaultValue={form.manager_email} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Teléfono encargado</label><input name="manager_phone" defaultValue={form.manager_phone} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4 space-y-1"><label className="text-xs text-theme-text-muted/60">Dirección</label><input name="address" defaultValue={form.address} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Región</label>
                <select value={form.region} onChange={e => handleRegionChange(e.target.value)} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
                  <option value="" className="bg-white dark:bg-theme-surface">Seleccionar región</option>
                  {regions.map(r => <option key={r.id} value={r.id} className="bg-white dark:bg-theme-surface">{r.name}</option>)}
                </select>
                <input name="region" type="hidden" value={form.region_name || form.region} />
              </div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Comuna</label>
                <select name="commune" value={form.commune} onChange={e => setForm(p => ({ ...p, commune: e.target.value }))} disabled={!form.region} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text disabled:text-theme-text-muted/50 focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
                  <option value="" className="bg-white dark:bg-theme-surface">Seleccionar comuna</option>
                  {communes.map(c => <option key={c.id} value={c.name} className="bg-white dark:bg-theme-surface">{c.name}</option>)}
                </select>
              </div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Ciudad</label><input name="city" defaultValue={form.city} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Capacidad m²</label><input name="capacity_m2" type="number" step="0.01" defaultValue={form.capacity_m2} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Capacidad pallets</label><input name="capacity_pallets" type="number" defaultValue={form.capacity_pallets} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30" /></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Predeterminada</label><select name="is_default" defaultValue={form.is_default} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30"><option value="false" className="bg-white dark:bg-theme-surface">NO</option><option value="true" className="bg-white dark:bg-theme-surface">SI</option></select></div>
              <div className="space-y-1"><label className="text-xs text-theme-text-muted/60">Estado</label><select name="status" defaultValue={form.status} className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30"><option value="ACTIVE" className="bg-white dark:bg-theme-surface">ACTIVA</option><option value="INACTIVE" className="bg-white dark:bg-theme-surface">INACTIVA</option><option value="BLOCKED" className="bg-white dark:bg-theme-surface">BLOQUEADA</option></select></div>
              <div className="col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4 space-y-1"><label className="text-xs text-theme-text-muted/60">Observaciones</label><textarea name="notes" defaultValue={form.notes} rows={2} className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30 resize-none" /></div>
            </div>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {msg && <div className="bg-theme-surface border border-theme-border rounded-xl px-4 py-2.5 text-sm text-theme-text">{msg}</div>}

      <div className="flex flex-wrap items-center gap-3">
        <input type="text" value={filters.search ?? ''} onChange={e => setFilter('search', e.target.value)}
          placeholder="Buscar por código, nombre, ciudad, comuna..."
          className="flex-1 min-w-[200px] h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text placeholder:text-gray-400 dark:placeholder:text-theme-text-muted/50 focus:outline-none focus:ring-1 focus:ring-theme-accent/30" />
        <button onClick={() => { resetForm(); setShowForm(true) }} className="h-10 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors">+ Nueva</button>
        <button onClick={downloadTemplate} className="h-10 px-4 rounded-xl border border-theme-border text-theme-text-muted/70 hover:text-theme-text hover:bg-theme-text/5 text-sm font-medium transition-colors">📄 Descargar plantilla</button>
        <label className="h-10 px-4 rounded-xl border border-theme-border text-theme-text-muted/70 hover:text-theme-text hover:bg-theme-text/5 text-sm font-medium transition-colors cursor-pointer inline-flex items-center gap-2">📥 Importar Excel<input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} className="hidden" /></label>
        <div className="relative">
          <button onClick={() => setShowExport(!showExport)} className="h-10 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-semibold transition-colors">📤 Exportar Excel</button>
          {showExport && (<><div className="fixed inset-0 z-40" onClick={() => setShowExport(false)} /><div className="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-theme-surface/95 backdrop-blur-md rounded-2xl border border-theme-border shadow-2xl z-50 py-2"><button onClick={handleExportAll} className="w-full text-left px-4 py-2.5 text-sm text-theme-text-muted hover:bg-theme-text/5">Exportar todas</button><button onClick={handleExportFiltered} className="w-full text-left px-4 py-2.5 text-sm text-theme-text-muted hover:bg-theme-text/5">Exportar filtradas</button><button onClick={handleExportSelected} disabled={selected.size === 0} className="w-full text-left px-4 py-2.5 text-sm text-theme-text-muted hover:bg-theme-text/5 disabled:text-gray-400 dark:disabled:text-theme-text-muted/50 disabled:cursor-not-allowed">Exportar seleccionadas {selected.size > 0 && `(${selected.size})`}</button></div></>)}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <select value={filters.warehouse_type ?? ''} onChange={e => setFilter('warehouse_type', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
          <option value="" className="bg-white dark:bg-theme-surface">Todos los tipos</option>
          {typeOpts.map(t => <option key={t} value={t} className="bg-white dark:bg-theme-surface">{t}</option>)}
        </select>
        <select value={filters.status ?? ''} onChange={e => setFilter('status', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
          <option value="" className="bg-white dark:bg-theme-surface">Todos los estados</option>
          <option value="ACTIVE" className="bg-white dark:bg-theme-surface">ACTIVA</option>
          <option value="INACTIVE" className="bg-white dark:bg-theme-surface">INACTIVA</option>
          <option value="BLOCKED" className="bg-white dark:bg-theme-surface">BLOQUEADA</option>
        </select>
        <button onClick={() => { setFilters({ page: 1, pageSize: 50 }); setSelected(new Set()) }} className="h-9 px-3 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text hover:bg-theme-text/5 text-xs transition-colors">✕ Limpiar filtros</button>
      </div>

      {selected.size > 0 && <div className="text-xs text-theme-text-muted/70 px-1">{selected.size} bodega(s) seleccionada(s)</div>}

      {preview && (<div className="rounded-2xl border border-theme-border bg-theme-surface p-5 space-y-4"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-theme-text">Vista previa - {preview.rows.length} filas</h3><div className="flex gap-2"><button onClick={() => setPreview(null)} className="px-3 py-1.5 rounded-lg border border-theme-border text-xs text-theme-text-muted/70 hover:text-theme-text">Cancelar</button>{preview.errors.length === 0 && preview.rows.length > 0 && <button onClick={handleImportConfirm} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white font-semibold hover:bg-emerald-500">Confirmar</button>}</div></div>{preview.errors.length > 0 && <div className="bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/20 rounded-lg p-3 space-y-1">{preview.errors.map((e, i) => <p key={i} className="text-xs text-red-500 dark:text-red-400">{e}</p>)}</div>}</div>)}

      {loading ? (<div className="rounded-2xl border border-theme-border bg-theme-surface p-10 text-center"><p className="text-theme-text-muted/50 text-sm">Cargando...</p></div>)
      : data.length === 0 ? (<div className="rounded-2xl border border-theme-border bg-theme-surface p-10 text-center"><p className="text-theme-text-muted/50 text-sm">No hay bodegas registradas.</p></div>)
      : (<div className="overflow-x-auto rounded-2xl border border-theme-border bg-theme-surface">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-theme-border text-xs text-theme-text-muted/60 uppercase tracking-wider">
              <th className="py-3 px-4 text-left w-10"><input type="checkbox" checked={data.length > 0 && data.every(d => selected.has(d.id))} onChange={toggleAll} className="accent-emerald-600" /></th>
              <th className="text-left py-3 px-4 font-medium">Código</th>
              <th className="text-left py-3 px-4 font-medium">Nombre</th>
              <th className="text-left py-3 px-4 font-medium">Tipo</th>
              <th className="text-left py-3 px-4 font-medium">Encargado</th>
              <th className="text-left py-3 px-4 font-medium">Ciudad</th>
              <th className="text-left py-3 px-4 font-medium">Comuna</th>
              <th className="text-left py-3 px-4 font-medium">Región</th>
              <th className="text-center py-3 px-4 font-medium">Predet.</th>
              <th className="text-left py-3 px-4 font-medium">Estado</th>
              <th className="text-right py-3 px-4 font-medium">Acciones</th>
            </tr></thead>
            <tbody>
              {data.map(w => (
                <tr key={w.id} className={`border-b border-gray-200 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/3 transition-colors ${selected.has(w.id) ? 'bg-theme-accent/5 dark:bg-theme-accent/10' : ''}`}>
                  <td className="py-3 px-4"><input type="checkbox" checked={selected.has(w.id)} onChange={() => toggleSelect(w.id)} className="accent-emerald-600" /></td>
                  <td className="py-3 px-4 text-theme-text text-xs font-mono font-medium">{w.code}</td>
                  <td className="py-3 px-4 text-gray-900 dark:text-emerald-200/80 text-xs">{w.name}</td>
                  <td className="py-3 px-4 text-theme-text-muted text-xs">{w.warehouse_type}</td>
                  <td className="py-3 px-4 text-theme-text-muted text-xs">{w.manager_name || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted text-xs">{w.city || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted text-xs">{w.commune || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted text-xs">{w.region || '—'}</td>
                  <td className="py-3 px-4 text-center">{w.is_default ? <span className="text-xs text-theme-accent font-semibold">★</span> : '—'}</td>
                  <td className="py-3 px-4">{w.is_active ? <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-theme-accent/10 dark:bg-theme-accent/10 text-theme-accent dark:text-theme-accent border-emerald-300 dark:border-emerald-500/20">Activa</span> : <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-300 dark:border-red-500/20">Inactiva</span>}</td>
                  <td className="py-3 px-4 text-right">
                    <button onClick={() => openEdit(w)} className="text-xs text-theme-text-muted/70 hover:text-gray-900 dark:hover:text-emerald-300 mr-3">Editar</button>
                    <button onClick={() => handleDeactivate(w)} className={`text-xs ${w.is_active ? 'text-red-500/80 dark:text-red-400 hover:text-red-600 dark:hover:text-red-400' : 'text-theme-text-muted/70 hover:text-gray-900 dark:hover:text-emerald-300'}`}>{w.is_active ? 'Desactivar' : 'Activar'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>)}

      {tp > 1 && (
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="text-theme-text-muted/50">Mostrar</span>
            <select value={filters.pageSize} onChange={e => setFilter('pageSize', e.target.value)} className="h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
              <option value={25} className="bg-white dark:bg-theme-surface">25</option>
              <option value={50} className="bg-white dark:bg-theme-surface">50</option>
              <option value={100} className="bg-white dark:bg-theme-surface">100</option>
            </select>
            <span className="text-theme-text-muted/50">de {total} registros</span>
          </div>
          <div className="flex items-center gap-2">
            <button disabled={(filters.page ?? 1) <= 1} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) - 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Anterior</button>
            <span className="text-theme-text-muted/50">Pág. {filters.page ?? 1} de {tp}</span>
            <button disabled={(filters.page ?? 1) >= tp} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) + 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Siguiente</button>
          </div>
        </div>
      )}


    </div>
  )
}
