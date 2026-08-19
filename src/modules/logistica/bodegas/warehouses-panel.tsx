'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getWarehouses, createWarehouse, updateWarehouse, deactivateWarehouse, importWarehouses, type Warehouse } from '@/app/actions/adquisiciones/warehouses'
import { getWarehouseLocationStats, type WarehouseStats } from '@/app/actions/logistica/location-layouts'
import { getRegions, getCommunes } from '@/app/actions/geography'
import * as XLSX from 'xlsx'
import { ArrowLeft, Download, FileSpreadsheet, Filter, Grid2X2, List, MoreHorizontal, Plus, Search, Upload, X } from 'lucide-react'
import { WarehouseSummary, WarehouseVisualOverview } from '../components/warehouse-visual-overview'

export function WarehousesPanel() {
  const [data, setData] = useState<Warehouse[]>([])
  const [stats, setStats] = useState<WarehouseStats[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [filters, setFilters] = useState<{ search?: string; warehouse_type?: string; status?: string; is_active?: string; page: number; pageSize: number }>({ page: 1, pageSize: 50 })
  const [viewMode, setViewMode] = useState<'table' | 'visual'>('visual')
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; errors: string[] } | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [regions, setRegions] = useState<{ id: string; code: string; name: string }[]>([])
  const [communes, setCommunes] = useState<{ id: string; code: string; name: string }[]>([])
  const [form, setForm] = useState<Record<string, string>>({
    code: '', name: '', warehouse_type: 'CENTRAL', manager_name: '', manager_email: '',
    manager_phone: '', address: '', city: '', commune: '', region: '', region_name: '',
    capacity_m2: '', capacity_pallets: '', is_default: 'false', notes: '', status: 'ACTIVE',
  })
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true); 
    const [r, s] = await Promise.all([
      getWarehouses(filters),
      getWarehouseLocationStats()
    ]);
    setData(r.data); setTotal(r.total); setStats(s); setLoading(false)
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
      <div className="flex flex-col h-full overflow-hidden bg-theme-surface animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSubmit} className="flex-1 overflow-auto">
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
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface">
      {msg && <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-5 py-2.5 text-sm text-theme-text-accent">{msg}</div>}

      {!(viewMode === 'visual' && selectedWarehouseId) && (
        <>
          <div className="shrink-0 border-b border-theme-border/60 bg-theme-text/[0.012]">
            <div className="flex items-end justify-between gap-4 px-5 pt-4 pb-3">
              <div className="min-w-0">
                <h1 className="text-base font-semibold tracking-tight text-theme-text">Bodegas</h1>
                <p className="mt-0.5 text-[11px] text-theme-text-muted/70">Centros operativos, capacidad y estructura de almacenamiento</p>
              </div>
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-theme-text-muted/70">{total.toLocaleString('es-CL')} registros</span>
            </div>

            <div className="flex flex-col gap-3 px-5 pb-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
                  <input type="text" value={filters.search ?? ''} onChange={e => setFilter('search', e.target.value)} placeholder="Buscar por código, nombre, ciudad o comuna..." className="h-10 w-full rounded-xl border border-theme-border bg-theme-surface pl-10 pr-4 text-sm text-theme-text placeholder:text-theme-text-muted/40 transition-all focus:border-theme-accent focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => setShowFilters(!showFilters)} className={`inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold transition-all ${showFilters ? 'border-theme-border bg-theme-text/10 text-theme-text' : 'border-theme-border bg-theme-surface text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'}`}><Filter className="h-4 w-4" /><span className="hidden sm:inline">Filtros</span>{((filters.warehouse_type && filters.warehouse_type !== '') || (filters.status && filters.status !== '')) && <span className="h-1.5 w-1.5 rounded-full bg-theme-accent" />}</button>
                  <div className="flex items-center rounded-xl border border-theme-border bg-theme-text/5 p-0.5">
                    <button onClick={() => { setViewMode('table'); setSelectedWarehouseId(null) }} className={`flex h-8 items-center justify-center rounded-lg px-2.5 text-xs font-semibold transition-all ${viewMode === 'table' ? 'bg-theme-surface text-theme-text shadow-sm ring-1 ring-theme-border/60' : 'text-theme-text-muted/80 hover:text-theme-text'}`} title="Vista tabla"><List className="h-4 w-4 sm:mr-1.5" /><span className="hidden sm:inline">Tabla</span></button>
                    <button onClick={() => setViewMode('visual')} className={`flex h-8 items-center justify-center rounded-lg px-2.5 text-xs font-semibold transition-all ${viewMode === 'visual' ? 'bg-theme-surface text-theme-text shadow-sm ring-1 ring-theme-border/60' : 'text-theme-text-muted/80 hover:text-theme-text'}`} title="Vista operativa"><Grid2X2 className="h-4 w-4 sm:mr-1.5" /><span className="hidden sm:inline">Operativa</span></button>
                  </div>
                  <button onClick={() => { resetForm(); setShowForm(true) }} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-theme-accent px-3.5 text-sm font-semibold text-white shadow-sm shadow-theme-accent/20 transition-colors hover:bg-theme-accent-hover"><Plus className="h-4 w-4" /><span>Nueva</span></button>
                  <div className="relative">
                    <button onClick={() => setShowExport(!showExport)} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm font-semibold text-theme-text-muted transition-all hover:bg-theme-text/5 hover:text-theme-text"><MoreHorizontal className="h-4 w-4" /><span className="hidden lg:inline">Opciones</span></button>
                    {showExport && (<><div className="fixed inset-0 z-40" onClick={() => setShowExport(false)} /><div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-2xl border border-theme-border bg-theme-surface p-2 shadow-xl"><button onClick={downloadTemplate} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"><FileSpreadsheet className="h-4 w-4" /> Descargar plantilla</button><label className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"><Upload className="h-4 w-4" /> Importar<input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} className="hidden" /></label><div className="my-1 h-px bg-theme-border" /><button onClick={handleExportAll} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"><Download className="h-4 w-4" /> Exportar todas</button><button onClick={handleExportFiltered} className="w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text">Exportar filtradas</button><button onClick={handleExportSelected} disabled={selected.size === 0} className="w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-40">Seleccionadas {selected.size > 0 && `(${selected.size})`}</button></div></>)}
                  </div>
                </div>
              </div>

              {showFilters && (
                <div className="flex flex-wrap items-center gap-3 border-t border-theme-border/40 pt-3 animate-in fade-in slide-in-from-top-2 duration-200">
                <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.12em] text-theme-text-muted/60">Filtrar por</span>
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
                <button onClick={() => { setFilters({ page: 1, pageSize: 50 }); setSelected(new Set()) }} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-theme-border px-3 text-xs text-theme-text-muted/70 transition-colors hover:bg-theme-text/5 hover:text-theme-text"><X className="h-3.5 w-3.5" /> Limpiar filtros</button>
                </div>
              )}
            </div>
          </div>
          <WarehouseSummary warehouses={data} stats={stats} />
          {selected.size > 0 && viewMode === 'table' && <div className="text-xs text-theme-text-muted/70 px-4 py-2 border-b border-theme-border bg-theme-text/[0.02]">{selected.size} bodega(s) seleccionada(s)</div>}
        </>
      )}

      {preview && (<div className="rounded-2xl border border-theme-border bg-theme-surface p-5 space-y-4"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-theme-text">Vista previa - {preview.rows.length} filas</h3><div className="flex gap-2"><button onClick={() => setPreview(null)} className="px-3 py-1.5 rounded-lg border border-theme-border text-xs text-theme-text-muted/70 hover:text-theme-text">Cancelar</button>{preview.errors.length === 0 && preview.rows.length > 0 && <button onClick={handleImportConfirm} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white font-semibold hover:bg-emerald-500">Confirmar</button>}</div></div>{preview.errors.length > 0 && <div className="bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/20 rounded-lg p-3 space-y-1">{preview.errors.map((e, i) => <p key={i} className="text-xs text-red-500 dark:text-red-400">{e}</p>)}</div>}</div>)}

      {loading ? (<div className="rounded-2xl border border-theme-border bg-theme-surface p-10 text-center"><p className="text-theme-text-muted/50 text-sm">Cargando...</p></div>)
      : data.length === 0 ? (<div className="rounded-2xl border border-theme-border bg-theme-surface p-10 text-center"><p className="text-theme-text-muted/50 text-sm">No hay bodegas registradas.</p></div>)
      : viewMode === 'visual' ? (
          <div className={`flex-1 overflow-hidden flex ${selectedWarehouseId ? '' : 'p-4 md:p-5'}`}>
            <WarehouseVisualOverview warehouses={data} stats={stats} onWarehouseSelect={setSelectedWarehouseId} />
          </div>
        )
      : (<div className="min-h-0 flex-1 overflow-auto px-4 pb-4 md:px-5 md:pb-5">
          <div className="overflow-hidden rounded-xl border border-theme-border bg-theme-surface">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-theme-surface">
                <tr className="border-b border-theme-border bg-theme-text/[0.025] text-[10px] uppercase tracking-[0.12em] text-theme-text-muted/80">
                  <th className="w-10 px-3 py-2.5 text-left"><input aria-label="Seleccionar todas las bodegas" type="checkbox" checked={data.length > 0 && data.every(d => selected.has(d.id))} onChange={toggleAll} className="accent-emerald-600" /></th>
                  <th className="px-3 py-2.5 text-left font-semibold">Bodega</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Código</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Tipo</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Pasillos</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Ubicaciones</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Con stock</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Vacías</th>
                  <th className="px-3 py-2.5 text-center font-semibold">Estado</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.map(w => {
                  const warehouseStats = stats.find(s => s.warehouse_id === w.id)
                  const totalLocations = warehouseStats?.total_locations || 0
                  const locationsWithStock = warehouseStats?.locations_with_stock || 0
                  return (
                    <tr key={w.id} className={`group border-b border-theme-border/70 transition-colors last:border-b-0 hover:bg-theme-accent/[0.035] ${selected.has(w.id) ? 'bg-theme-accent/10' : ''}`}>
                      <td className="px-3 py-2"><input aria-label={`Seleccionar ${w.name}`} type="checkbox" checked={selected.has(w.id)} onChange={() => toggleSelect(w.id)} className="accent-emerald-600" /></td>
                      <td className="max-w-[220px] px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {w.is_default && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-theme-accent" title="Bodega predeterminada" />}
                          <span className="truncate text-xs font-semibold text-theme-text" title={w.name}>{w.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] font-semibold tabular-nums text-theme-text-muted">{w.code}</td>
                      <td className="px-3 py-2 text-[11px] text-theme-text-muted">{w.warehouse_type}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-theme-text-muted">{warehouseStats?.total_aisles || 0}</td>
                      <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums text-theme-text">{totalLocations}</td>
                      <td className="px-3 py-2 text-right text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{locationsWithStock}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-theme-text-muted">{totalLocations - locationsWithStock}</td>
                      <td className="px-3 py-2 text-center">{w.is_active ? <span className="inline-flex items-center rounded-md border border-theme-accent/25 bg-theme-accent/10 px-2 py-0.5 text-[10px] font-semibold text-theme-text-accent">Activa</span> : <span className="inline-flex items-center rounded-md border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-500">Inactiva</span>}</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1 rounded-lg border border-theme-border/70 bg-theme-surface px-1 py-0.5 opacity-80 transition-all group-hover:border-theme-border group-hover:opacity-100">
                          <button onClick={() => openEdit(w)} className="rounded-md px-2 py-1 text-xs font-medium text-theme-text-muted hover:bg-theme-accent/10 hover:text-theme-text-accent">Editar</button>
                          <button onClick={() => handleDeactivate(w)} className={`rounded-md px-2 py-1 text-xs font-medium ${w.is_active ? 'text-red-500/80 hover:bg-red-500/10 hover:text-red-500' : 'text-theme-text-muted hover:bg-theme-accent/10 hover:text-theme-text-accent'}`}>{w.is_active ? 'Desactivar' : 'Activar'}</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>)}

      {tp > 1 && (
        <div className="shrink-0 flex flex-col gap-3 border-t border-theme-border/60 bg-theme-text/[0.012] px-5 py-3 text-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="text-theme-text-muted/50">Mostrar</span>
            <select value={filters.pageSize} onChange={e => setFilter('pageSize', e.target.value)} className="h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30">
              <option value={25} className="bg-white dark:bg-theme-surface">25</option>
              <option value={50} className="bg-white dark:bg-theme-surface">50</option>
              <option value={100} className="bg-white dark:bg-theme-surface">100</option>
            </select>
            <span className="text-theme-text-muted/60">de <strong className="font-semibold text-theme-text">{total.toLocaleString('es-CL')}</strong> registros</span>
          </div>
          <div className="flex items-center gap-2">
            <button disabled={(filters.page ?? 1) <= 1} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) - 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Anterior</button>
            <span className="min-w-[92px] text-center text-theme-text-muted/60">Pág. <strong className="font-semibold text-theme-text">{filters.page ?? 1}</strong> de {tp}</span>
            <button disabled={(filters.page ?? 1) >= tp} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) + 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Siguiente</button>
          </div>
        </div>
      )}


    </div>
  )
}
