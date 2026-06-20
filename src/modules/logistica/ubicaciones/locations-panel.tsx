'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { 
  getLocations, 
  createLocation, 
  deactivateLocation, 
  createLocationsBulk, 
  updateLocation, 
  type Location 
} from '@/app/actions/logistica/locations'
import { getWarehouses, type Warehouse } from '@/app/actions/adquisiciones/warehouses'
import { 
  ArrowLeft, 
  Plus, 
  X, 
  Search, 
  Filter, 
  Edit, 
  Sparkles, 
  CheckCircle, 
  AlertTriangle, 
  Building2 
} from 'lucide-react'

// Helpers for numeric range padding
function padIfNumeric(val: string): string {
  const num = parseInt(val, 10)
  if (!isNaN(num)) {
    return val.length >= 2 ? val : val.padStart(2, '0')
  }
  return val
}

// Ranges helper matching the backend logic
function generateRange(from: string, to: string): string[] {
  const f = (from ?? '').trim()
  const t = (to ?? '').trim()

  if (!f && !t) return ['']
  if (!f) return [padIfNumeric(t)]
  if (!t) return [padIfNumeric(f)]

  const numFrom = parseInt(f, 10)
  const numTo = parseInt(t, 10)
  if (!isNaN(numFrom) && !isNaN(numTo)) {
    const list: string[] = []
    const min = Math.min(numFrom, numTo)
    const max = Math.max(numFrom, numTo)
    const padLength = Math.max(f.length, t.length, 2)
    
    for (let i = min; i <= max; i++) {
      list.push(i.toString().padStart(padLength, '0'))
    }
    return list
  }

  if (f.length === 1 && t.length === 1) {
    const list: string[] = []
    const charCodeFrom = f.charCodeAt(0)
    const charCodeTo = t.charCodeAt(0)
    const min = Math.min(charCodeFrom, charCodeTo)
    const max = Math.max(charCodeFrom, charCodeTo)
    for (let i = min; i <= max; i++) {
      list.push(String.fromCharCode(i).toUpperCase())
    }
    return list
  }

  return [f.toUpperCase()]
}

// Code formatting helper
function formatCode(
  formatStr: string,
  prefix: string,
  aisle: string,
  rack: string,
  level: string,
  position: string
): string {
  let res = formatStr
    .replace(/{prefix}/gi, prefix)
    .replace(/{aisle}/gi, aisle)
    .replace(/{rack}/gi, rack)
    .replace(/{level}/gi, level)
    .replace(/{position}/gi, position)
  
  res = res.replace(/[-_+/]{2,}/g, (match) => match[0])
  res = res.replace(/^[-_+/]+|[-_+/]+$/g, '')
  return res.toUpperCase()
}

export function LocationsPanel() {
  const [view, setView] = useState<'list' | 'new' | 'edit' | 'bulk'>('list')
  const [data, setData] = useState<Location[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0 })
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [filters, setFilters] = useState<{ 
    search?: string
    warehouse_id?: string
    is_active?: boolean
    page: number
    pageSize: number 
  }>({ page: 1, pageSize: 50 })
  
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [editLoc, setEditLoc] = useState<Location | null>(null)

  // Single creation form state
  const [form, setForm] = useState({
    warehouse_id: '',
    code: '',
    name: '',
    aisle: '',
    rack: '',
    level: '',
    position: '',
    description: '',
    is_active: true
  })

  // Bulk creation form state
  const [bulkForm, setBulkForm] = useState({
    warehouse_id: '',
    prefix: '',
    aisles: '', // comma-separated pasillos
    rackFrom: '',
    rackTo: '',
    levelFrom: '',
    levelTo: '',
    positionFrom: '',
    positionTo: '',
    codeFormat: '{aisle}-R{rack}-N{level}-P{position}'
  })

  const load = useCallback(async () => {
    setLoading(true)
    const r = await getLocations(filters)
    setData(r.data)
    setTotal(r.total)
    setStats(r.stats)
    setLoading(false)
  }, [filters])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    getWarehouses({ pageSize: 10000, is_active: 'true' }).then(res => {
      setWarehouses(res.data)
      if (res.data.length > 0) {
        setFilters(prev => ({ ...prev, warehouse_id: res.data[0].id }))
        setForm(prev => ({ ...prev, warehouse_id: res.data[0].id }))
        setBulkForm(prev => ({ ...prev, warehouse_id: res.data[0].id }))
      }
    })
  }, [])

  function showMsg(text: string) {
    setMsg(text)
    setTimeout(() => setMsg(''), 4500)
  }

  function resetForm() {
    setForm({
      warehouse_id: filters.warehouse_id || (warehouses.length > 0 ? warehouses[0].id : ''),
      code: '',
      name: '',
      aisle: '',
      rack: '',
      level: '',
      position: '',
      description: '',
      is_active: true
    })
  }

  function resetBulkForm() {
    setBulkForm({
      warehouse_id: filters.warehouse_id || (warehouses.length > 0 ? warehouses[0].id : ''),
      prefix: '',
      aisles: '',
      rackFrom: '',
      rackTo: '',
      levelFrom: '',
      levelTo: '',
      positionFrom: '',
      positionTo: '',
      codeFormat: '{aisle}-R{rack}-N{level}-P{position}'
    })
  }

  // Handle single location creation or editing
  async function handleSaveLocation(e?: React.FormEvent) {
    if (e) e.preventDefault()
    console.log("[LOCATION_SAVE_CLICK]", form)

    if (!form.warehouse_id) {
      showMsg('Debe seleccionar una bodega')
      return
    }

    let targetCode = form.code.trim()
    if (!targetCode) {
      const parts: string[] = []
      if (form.aisle.trim()) parts.push(form.aisle.trim().toUpperCase())
      if (form.rack.trim()) parts.push(`R${padIfNumeric(form.rack.trim().toUpperCase())}`)
      if (form.level.trim()) parts.push(`N${padIfNumeric(form.level.trim().toUpperCase())}`)
      if (form.position.trim()) parts.push(`P${padIfNumeric(form.position.trim().toUpperCase())}`)
      targetCode = parts.join('-')
    }

    if (!targetCode) {
      showMsg('El código de ubicación es obligatorio')
      return
    }

    console.log("[LOCATION_SAVE_TARGET_CODE]", targetCode)

    if (view === 'edit' && editLoc) {
      const r = await updateLocation(editLoc.id, {
        code: targetCode,
        name: form.name || undefined,
        aisle: form.aisle || undefined,
        rack: form.rack || undefined,
        level: form.level || undefined,
        position: form.position || undefined,
        description: form.description || undefined,
        is_active: form.is_active
      })

      if (r.error) {
        console.error("[LOCATION_SAVE_ERROR]", r.error)
        showMsg(r.error)
        return
      }
      showMsg('Ubicación actualizada con éxito')
    } else {
      const r = await createLocation({
        warehouse_id: form.warehouse_id,
        code: targetCode,
        name: form.name || undefined,
        aisle: form.aisle || undefined,
        rack: form.rack || undefined,
        level: form.level || undefined,
        position: form.position || undefined,
        description: form.description || undefined
      })

      if (r.error) {
        console.error("[LOCATION_SAVE_ERROR]", r.error)
        showMsg(r.error)
        return
      }
      showMsg('Ubicación creada con éxito')
    }

    setView('list')
    setEditLoc(null)
    resetForm()
    load()
  }

  // Handle bulk creation
  async function handleBulkSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault()
    if (!bulkForm.warehouse_id) {
      showMsg('Debe seleccionar una bodega de destino')
      return
    }

    setLoading(true)
    const r = await createLocationsBulk(bulkForm)
    setLoading(false)

    if (r.error) {
      showMsg(r.error)
      return
    }

    const res = r as { success: boolean; created: number; skipped_duplicates: number; errors: string[] }
    const feedback = `Creación masiva terminada. Creadas: ${res.created}, Omitidas duplicadas: ${res.skipped_duplicates}${res.errors.length > 0 ? `, Errores: ${res.errors.length}` : ''}`
    showMsg(feedback)
    setView('list')
    resetBulkForm()
    load()
  }

  async function handleToggleActive(loc: Location) {
    if (!confirm(`¿Desea ${loc.is_active ? 'desactivar' : 'activar'} la ubicación "${loc.code}"?`)) return
    const r = await deactivateLocation(loc.id)
    if (r.error) {
      showMsg(r.error)
      return
    }
    showMsg(r.newActive ? 'Ubicación activada' : 'Ubicación desactivada')
    load()
  }

  function handleEditClick(loc: Location) {
    setEditLoc(loc)
    setForm({
      warehouse_id: loc.warehouse_id,
      code: loc.code,
      name: loc.name || '',
      aisle: loc.aisle || '',
      rack: loc.rack || '',
      level: loc.level || '',
      position: loc.position || '',
      description: loc.description || '',
      is_active: loc.is_active
    })
    setView('edit')
  }

  function handleAutogenerateCode(formatType: 'simple' | 'labeled') {
    const aisle = form.aisle.trim().toUpperCase()
    const rack = form.rack.trim().toUpperCase()
    const level = form.level.trim().toUpperCase()
    const position = form.position.trim().toUpperCase()

    if (!aisle && !rack && !level && !position) {
      showMsg('Complete al menos un campo (Pasillo, Rack, Nivel o Posición) para autogenerar')
      return
    }

    if (formatType === 'simple') {
      const parts = [aisle, rack, level, position].filter(Boolean)
      setForm(prev => ({ ...prev, code: parts.join('-') }))
    } else {
      const parts: string[] = []
      if (aisle) parts.push(aisle)
      if (rack) parts.push(`R${padIfNumeric(rack)}`)
      if (level) parts.push(`N${padIfNumeric(level)}`)
      if (position) parts.push(`P${padIfNumeric(position)}`)
      setForm(prev => ({ ...prev, code: parts.join('-') }))
    }
  }

  // Real-time calculation of bulk combinations and previews
  const { totalCombinations, previewCodes } = useMemo(() => {
    const prefix = bulkForm.prefix.trim()
    
    // Comma-separated aisles list
    const rawAisles = bulkForm.aisles
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
    const aisles = rawAisles.length > 0 ? rawAisles : ['']
    
    const racks = generateRange(bulkForm.rackFrom.trim(), bulkForm.rackTo.trim())
    const levels = generateRange(bulkForm.levelFrom.trim(), bulkForm.levelTo.trim())
    const positions = generateRange(bulkForm.positionFrom.trim(), bulkForm.positionTo.trim())

    const total = aisles.length * racks.length * levels.length * positions.length
    
    // Debug log to confirm calculation parameters
    console.log('[BULK_CALCULATION]', { 
      rawAisles, 
      aisles, 
      racks, 
      levels, 
      positions, 
      total 
    })
    
    const preview: string[] = []
    
    for (const aisle of aisles) {
      for (const rack of racks) {
        for (const level of levels) {
          for (const position of positions) {
            const code = formatCode(bulkForm.codeFormat, prefix, aisle, rack, level, position)
            if (code && preview.length < 10) {
              preview.push(code)
            }
          }
        }
      }
    }

    return { totalCombinations: total, previewCodes: preview }
  }, [bulkForm])

  const tp = Math.ceil(total / filters.pageSize)
  const isBulkExceeded = totalCombinations > 2000

  // ----------------------------------------------------
  // RENDER SCREEN: CREATION OR EDITING (INLINE FULL PANEL)
  // ----------------------------------------------------
  if (view === 'new' || view === 'edit') {
    return (
      <div className="animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSaveLocation} className="bg-theme-surface rounded-2xl border border-theme-border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-theme-border bg-theme-text/5 flex items-center justify-between sticky top-0 z-10">
            <div className="flex items-center gap-4">
              <button 
                type="button" 
                onClick={() => { setView('list'); setEditLoc(null); resetForm() }} 
                className="p-2 rounded-lg hover:bg-theme-text/10 text-theme-text-muted hover:text-theme-text transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold text-theme-text">
                {view === 'edit' ? `Editar Ubicación: ${editLoc?.code}` : 'Nueva Ubicación'}
              </h2>
            </div>
            <div className="flex gap-3">
              <button 
                type="button" 
                onClick={() => { setView('list'); setEditLoc(null); resetForm() }} 
                className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-sm font-semibold transition-colors"
              >
                Cancelar
              </button>
              <button 
                type="button" 
                onClick={() => handleSaveLocation()}
                className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-colors shadow-lg shadow-theme-accent/20"
              >
                Guardar
              </button>
            </div>
          </div>
          
          <div className="p-6 lg:p-8 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
              {/* Bodega (disabled on edit) */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Bodega *</label>
                <select 
                  value={form.warehouse_id} 
                  onChange={e => setForm(p => ({ ...p, warehouse_id: e.target.value }))}
                  disabled={view === 'edit'}
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 disabled:opacity-50 transition-all"
                >
                  {warehouses.map(w => (
                    <option key={w.id} value={w.id} className="bg-white dark:bg-theme-surface">{w.name} ({w.code})</option>
                  ))}
                </select>
              </div>

              {/* Código */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Código de Ubicación</label>
                <div className="flex gap-2">
                  <input 
                    type="text"
                    value={form.code} 
                    onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                    placeholder="Ej: A-01-R02-N03"
                    className="flex-1 h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm font-mono text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                  />
                  {view === 'new' && (
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleAutogenerateCode('simple')}
                        className="px-3 h-10 rounded-xl border border-theme-border hover:bg-theme-text/5 text-xs font-bold text-theme-text transition-colors"
                        title="Unir pasillo-rack-nivel-pos"
                      >
                        Simple
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAutogenerateCode('labeled')}
                        className="px-3 h-10 rounded-xl border border-theme-border hover:bg-theme-text/5 text-xs font-bold text-theme-accent transition-colors"
                        title="Unir con etiquetas R, N, P"
                      >
                        Etiquetas
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Nombre */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Nombre descriptivo (Opcional)</label>
                <input 
                  type="text"
                  value={form.name} 
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="Ej: RACK CENTRAL 1"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                />
              </div>

              {/* Pasillo */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Pasillo (Opcional)</label>
                <input 
                  type="text"
                  value={form.aisle} 
                  onChange={e => setForm(p => ({ ...p, aisle: e.target.value }))}
                  placeholder="Ej: A o 1"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none" 
                />
              </div>

              {/* Rack */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Rack / Estante (Opcional)</label>
                <input 
                  type="text"
                  value={form.rack} 
                  onChange={e => setForm(p => ({ ...p, rack: e.target.value }))}
                  placeholder="Ej: 01"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none" 
                />
              </div>

              {/* Nivel */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Nivel (Opcional)</label>
                <input 
                  type="text"
                  value={form.level} 
                  onChange={e => setForm(p => ({ ...p, level: e.target.value }))}
                  placeholder="Ej: 02"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none" 
                />
              </div>

              {/* Posición */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Posición (Opcional)</label>
                <input 
                  type="text"
                  value={form.position} 
                  onChange={e => setForm(p => ({ ...p, position: e.target.value }))}
                  placeholder="Ej: 03"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none" 
                />
              </div>

              {/* Active/Inactive state (only visible on edit) */}
              {view === 'edit' && (
                <div className="flex items-center h-full pt-6">
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input 
                      type="checkbox"
                      checked={form.is_active}
                      onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))}
                      className="w-5 h-5 accent-theme-accent rounded-lg cursor-pointer transition-all"
                    />
                    <span className="text-sm font-semibold text-theme-text">Ubicación Activa</span>
                  </label>
                </div>
              )}
            </div>

            {/* Descripción */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-theme-text-muted/70">Descripción detallada</label>
              <textarea 
                value={form.description} 
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                placeholder="Detalles sobre el uso, tipo de mercadería u observaciones de la ubicación..."
                rows={4} 
                className="w-full rounded-xl border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 resize-none" 
              />
            </div>
          </div>
        </form>
      </div>
    )
  }

  // ----------------------------------------------------
  // RENDER SCREEN: BULK CREATION (INLINE FULL PANEL)
  // ----------------------------------------------------
  if (view === 'bulk') {
    return (
      <div className="animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleBulkSubmit} className="bg-theme-surface rounded-2xl border border-theme-border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-theme-border bg-theme-text/5 flex items-center justify-between sticky top-0 z-10">
            <div className="flex items-center gap-4">
              <button 
                type="button" 
                onClick={() => { setView('list'); resetBulkForm() }} 
                className="p-2 rounded-lg hover:bg-theme-text/10 text-theme-text-muted hover:text-theme-text transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-theme-accent" />
                <h2 className="text-lg font-bold text-theme-text">Generador Masivo de Ubicaciones</h2>
              </div>
            </div>
            <div className="flex gap-3">
              <button 
                type="button" 
                onClick={() => { setView('list'); resetBulkForm() }} 
                className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-sm font-semibold transition-colors"
              >
                Cancelar
              </button>
              <button 
                type="button" 
                onClick={() => handleBulkSubmit()}
                disabled={isBulkExceeded || totalCombinations === 0}
                className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover disabled:bg-theme-text/10 disabled:text-theme-text-muted/40 disabled:cursor-not-allowed text-white text-sm font-bold transition-all shadow-lg shadow-theme-accent/20"
              >
                Confirmar
              </button>
            </div>
          </div>
          
          <div className="p-6 lg:p-8 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Bodega de Destino *</label>
                <select 
                  value={bulkForm.warehouse_id} 
                  onChange={e => setBulkForm(p => ({ ...p, warehouse_id: e.target.value }))}
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none"
                >
                  {warehouses.map(w => (
                    <option key={w.id} value={w.id} className="bg-white dark:bg-theme-surface">{w.name} ({w.code})</option>
                  ))}
                </select>
              </div>
              
              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Prefijo Opcional</label>
                <input 
                  type="text"
                  value={bulkForm.prefix}
                  onChange={e => setBulkForm(p => ({ ...p, prefix: e.target.value }))}
                  placeholder="Ej: BOD1-"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm font-mono text-theme-text focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-theme-text-muted/70">Formato del Código *</label>
                <select
                  value={bulkForm.codeFormat}
                  onChange={e => setBulkForm(p => ({ ...p, codeFormat: e.target.value }))}
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none"
                >
                  <option value="{prefix}{aisle}-R{rack}-N{level}-P{position}">Etiquetado (A-R01-N01-P01)</option>
                  <option value="{prefix}{aisle}-{rack}-{level}-{position}">Simple (A-01-01-01)</option>
                  <option value="{prefix}PAS-{aisle}-RACK-{rack}-NIV-{level}-POS-{position}">Completo (PAS-A-RACK-01-NIV-01-POS-01)</option>
                </select>
              </div>
            </div>

            {/* Range configuration */}
            <div className="bg-theme-text/5 rounded-2xl p-5 border border-theme-border/60 space-y-4">
              <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider">Definición de Rangos</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {/* Comma separated pasillos */}
                <div className="space-y-1 bg-theme-surface p-3.5 rounded-xl border border-theme-border md:col-span-1">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wide">Pasillos</label>
                  <input 
                    type="text" 
                    placeholder="Ej: A,B,C,1,2" 
                    value={bulkForm.aisles}
                    onChange={e => setBulkForm(p => ({ ...p, aisles: e.target.value }))}
                    className="w-full h-9 mt-1 rounded bg-theme-text/5 border border-theme-border text-xs px-3 font-semibold text-theme-text"
                  />
                  <p className="text-[10px] text-theme-text-muted/60 mt-1">Escriba valores separados por coma</p>
                </div>

                {/* Racks */}
                <div className="space-y-1 bg-theme-surface p-3.5 rounded-xl border border-theme-border">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wide">Racks / Módulos</label>
                  <div className="flex gap-2 items-center mt-1">
                    <input 
                      type="text" 
                      placeholder="1" 
                      maxLength={3}
                      value={bulkForm.rackFrom}
                      onChange={e => setBulkForm(p => ({ ...p, rackFrom: e.target.value }))}
                      className="w-full h-9 text-center rounded bg-theme-text/5 border border-theme-border text-xs font-bold text-theme-text"
                    />
                    <span className="text-xs text-theme-text-muted">a</span>
                    <input 
                      type="text" 
                      placeholder="20" 
                      maxLength={3}
                      value={bulkForm.rackTo}
                      onChange={e => setBulkForm(p => ({ ...p, rackTo: e.target.value }))}
                      className="w-full h-9 text-center rounded bg-theme-text/5 border border-theme-border text-xs font-bold text-theme-text"
                    />
                  </div>
                </div>

                {/* Niveles */}
                <div className="space-y-1 bg-theme-surface p-3.5 rounded-xl border border-theme-border">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wide">Niveles / Alturas</label>
                  <div className="flex gap-2 items-center mt-1">
                    <input 
                      type="text" 
                      placeholder="1" 
                      maxLength={3}
                      value={bulkForm.levelFrom}
                      onChange={e => setBulkForm(p => ({ ...p, levelFrom: e.target.value }))}
                      className="w-full h-9 text-center rounded bg-theme-text/5 border border-theme-border text-xs font-bold text-theme-text"
                    />
                    <span className="text-xs text-theme-text-muted">a</span>
                    <input 
                      type="text" 
                      placeholder="5" 
                      maxLength={3}
                      value={bulkForm.levelTo}
                      onChange={e => setBulkForm(p => ({ ...p, levelTo: e.target.value }))}
                      className="w-full h-9 text-center rounded bg-theme-text/5 border border-theme-border text-xs font-bold text-theme-text"
                    />
                  </div>
                </div>

                {/* Posiciones */}
                <div className="space-y-1 bg-theme-surface p-3.5 rounded-xl border border-theme-border">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wide">Posiciones</label>
                  <div className="flex gap-2 items-center mt-1">
                    <input 
                      type="text" 
                      placeholder="1" 
                      maxLength={3}
                      value={bulkForm.positionFrom}
                      onChange={e => setBulkForm(p => ({ ...p, positionFrom: e.target.value }))}
                      className="w-full h-9 text-center rounded bg-theme-text/5 border border-theme-border text-xs font-bold text-theme-text"
                    />
                    <span className="text-xs text-theme-text-muted">a</span>
                    <input 
                      type="text" 
                      placeholder="4" 
                      maxLength={3}
                      value={bulkForm.positionTo}
                      onChange={e => setBulkForm(p => ({ ...p, positionTo: e.target.value }))}
                      className="w-full h-9 text-center rounded bg-theme-text/5 border border-theme-border text-xs font-bold text-theme-text"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Estimate & Preview area */}
            <div className="bg-theme-surface border border-theme-border rounded-2xl p-5 space-y-4 shadow-sm">
              <div className="flex items-center justify-between border-b border-theme-border pb-3">
                <div>
                  <p className="text-xs text-theme-text-muted">Cantidad estimada a generar:</p>
                  <p className={`text-2xl font-extrabold ${isBulkExceeded ? 'text-red-500 animate-pulse' : 'text-theme-text'}`}>
                    {totalCombinations} ubicaciones
                  </p>
                </div>
                {isBulkExceeded ? (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-500 rounded-xl px-3 py-1.5 flex items-center gap-1.5 text-xs font-bold">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>Supera límite de 2000</span>
                  </div>
                ) : (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded-xl px-3 py-1.5 flex items-center gap-1.5 text-xs font-bold">
                    <CheckCircle className="w-4 h-4 shrink-0" />
                    <span>Rango permitido</span>
                  </div>
                )}
              </div>

              {isBulkExceeded && (
                <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-4 text-xs text-red-500 leading-relaxed font-semibold">
                  ⚠️ El número total de ubicaciones a crear excede el límite operacional de 2000 por operación. Por favor, disminuya los rangos o elimine pasillos de la lista para poder proceder.
                </div>
              )}

              {/* Preview layout */}
              {previewCodes.length > 0 && (
                <div className="space-y-2.5">
                  <p className="text-xs text-theme-text-muted/65 font-bold uppercase tracking-wider">Vista previa de los primeros 10 códigos:</p>
                  <div className="flex flex-wrap gap-2">
                    {previewCodes.map((code, idx) => (
                      <span 
                        key={idx} 
                        className="text-xs font-mono font-bold bg-theme-text/5 text-theme-text-accent px-3 py-1.5 rounded-lg border border-theme-border"
                      >
                        {code}
                      </span>
                    ))}
                    {totalCombinations > 10 && (
                      <span className="text-xs font-semibold text-theme-text-muted px-3 py-1.5 italic bg-theme-text/5 rounded-lg">
                        ... y {totalCombinations - 10} más
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>
      </div>
    )
  }

  // ----------------------------------------------------
  // RENDER SCREEN: LIST OF LOCATIONS (DEFAULT VIEW)
  // ----------------------------------------------------
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {msg && (
        <div className="bg-theme-accent-hover/10 border border-theme-accent/20 rounded-xl px-4 py-3 text-sm text-theme-text-accent flex items-center gap-2 font-medium shadow-sm transition-all">
          <CheckCircle className="w-4 h-4 shrink-0 text-theme-accent" />
          <span>{msg}</span>
        </div>
      )}

      {/* HEADER CONTROLS */}
      <div className="bg-theme-surface border border-theme-border rounded-2xl p-5 space-y-4 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xs font-semibold text-theme-text-muted/60 uppercase tracking-wider">Bodega de Trabajo</h2>
            <div className="relative w-64">
              <select 
                value={filters.warehouse_id ?? ''} 
                onChange={e => {
                  const val = e.target.value
                  setFilters(p => ({ ...p, warehouse_id: val || undefined, page: 1 }))
                  setForm(p => ({ ...p, warehouse_id: val }))
                  setBulkForm(p => ({ ...p, warehouse_id: val }))
                }}
                className="w-full h-10 pl-3 pr-8 rounded-xl border border-theme-border bg-theme-surface text-sm font-medium text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 appearance-none transition-colors"
              >
                {warehouses.map(w => (
                  <option key={w.id} value={w.id} className="bg-white dark:bg-theme-surface">{w.name} ({w.code})</option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-theme-text-muted/60 text-xs">▼</div>
            </div>
          </div>
          
          <div className="flex items-center gap-2 shrink-0">
            <button 
              onClick={() => { resetForm(); setView('new') }} 
              className="h-10 px-4 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-md shadow-theme-accent/20 flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nueva ubicación</span>
            </button>
            <button 
              onClick={() => { resetBulkForm(); setView('bulk') }} 
              className="h-10 px-4 rounded-xl border border-theme-border bg-theme-surface text-theme-text hover:bg-theme-text/5 text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-theme-accent" />
              <span>Generar masivamente</span>
            </button>
          </div>
        </div>

        {/* RESUMEN CARDS */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-theme-text/5 border border-theme-border/50 rounded-xl p-4 flex flex-col justify-center">
            <p className="text-[10px] text-theme-text-muted/60 font-semibold uppercase tracking-wider">Total Ubicaciones</p>
            <p className="text-2xl font-extrabold text-theme-text mt-1">{stats.total}</p>
          </div>
          <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-4 flex flex-col justify-center">
            <p className="text-[10px] text-emerald-500/70 font-semibold uppercase tracking-wider">Activas</p>
            <p className="text-2xl font-extrabold text-emerald-500 mt-1">{stats.active}</p>
          </div>
          <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-4 flex flex-col justify-center">
            <p className="text-[10px] text-red-500/70 font-semibold uppercase tracking-wider">Inactivas</p>
            <p className="text-2xl font-extrabold text-red-500 mt-1">{stats.inactive}</p>
          </div>
        </div>
      </div>

      {/* FILTER CONTROLS */}
      <div className="flex flex-col md:flex-row items-center gap-3 w-full bg-theme-surface border border-theme-border rounded-xl p-3 shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
          <input 
            type="text" 
            value={filters.search ?? ''} 
            onChange={e => setFilters(p => ({ ...p, search: e.target.value || undefined, page: 1 }))}
            placeholder="Buscar por código, nombre o descripción..."
            className="w-full h-10 pl-10 pr-4 rounded-lg border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-xs text-theme-text placeholder:text-theme-text-muted/40" 
          />
        </div>
        <div className="flex items-center gap-2 w-full md:w-auto shrink-0">
          <select 
            value={filters.is_active === undefined ? '' : String(filters.is_active)} 
            onChange={e => {
              const val = e.target.value
              setFilters(p => ({ 
                ...p, 
                is_active: val === 'true' ? true : val === 'false' ? false : undefined, 
                page: 1 
              }))
            }}
            className="h-10 px-3 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20"
          >
            <option value="" className="bg-white dark:bg-theme-surface">Todos los estados</option>
            <option value="true" className="bg-white dark:bg-theme-surface">Activas</option>
            <option value="false" className="bg-white dark:bg-theme-surface">Inactivas</option>
          </select>
        </div>
      </div>

      {/* TABLE LIST */}
      {loading ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-16 text-center">
          <div className="w-8 h-8 mx-auto animate-spin border-4 border-theme-accent border-t-transparent rounded-full mb-3" />
          <p className="text-theme-text-muted/50 text-xs font-semibold">Cargando ubicaciones...</p>
        </div>
      ) : data.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-16 text-center">
          <Building2 className="w-8 h-8 mx-auto text-theme-text-muted/30 mb-2" />
          <p className="text-theme-text-muted/50 text-xs font-semibold">No se encontraron ubicaciones para la bodega seleccionada.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-theme-border bg-theme-surface shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider bg-theme-text/5">
                <th className="text-left py-3 px-4 font-semibold">Código</th>
                <th className="text-left py-3 px-4 font-semibold">Nombre</th>
                <th className="text-left py-3 px-4 font-semibold">Bodega</th>
                <th className="text-left py-3 px-4 font-semibold">Pasillo</th>
                <th className="text-left py-3 px-4 font-semibold">Rack</th>
                <th className="text-left py-3 px-4 font-semibold">Nivel</th>
                <th className="text-left py-3 px-4 font-semibold">Posición</th>
                <th className="text-left py-3 px-4 font-semibold">Estado</th>
                <th className="text-right py-3 px-4 font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {data.map(loc => (
                <tr key={loc.id} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                  <td className="py-3 px-4 text-xs font-mono font-bold text-theme-accent">{loc.code}</td>
                  <td className="py-3 px-4 text-xs text-theme-text">{loc.name || '—'}</td>
                  <td className="py-3 px-4 text-xs text-theme-text">{loc.warehouse_name}</td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted">{loc.aisle || '—'}</td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted">{loc.rack || '—'}</td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted">{loc.level || '—'}</td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted">{loc.position || '—'}</td>
                  <td className="py-3 px-4">
                    {loc.is_active ? (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Activa</span>
                    ) : (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded border bg-red-500/10 text-red-500 border-red-500/20">Inactiva</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button 
                        onClick={() => handleEditClick(loc)} 
                        className="text-theme-text-muted hover:text-theme-text p-1 rounded transition-colors"
                        title="Editar"
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        onClick={() => handleToggleActive(loc)} 
                        className={`text-xs font-semibold ${loc.is_active ? 'text-red-500 hover:text-red-400' : 'text-theme-accent hover:text-theme-accent-hover'}`}
                      >
                        {loc.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* PAGINATION */}
      {tp > 1 && (
        <div className="flex items-center justify-between text-xs bg-theme-surface border border-theme-border rounded-xl p-3 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-theme-text-muted/50">Mostrar</span>
            <select 
              value={filters.pageSize} 
              onChange={e => setFilters(p => ({ ...p, pageSize: parseInt(e.target.value) || 50, page: 1 }))} 
              className="h-8 rounded-lg border border-theme-border bg-theme-text/5 px-2 text-xs text-theme-text"
            >
              <option value={25} className="bg-white dark:bg-theme-surface">25</option>
              <option value={50} className="bg-white dark:bg-theme-surface">50</option>
              <option value={100} className="bg-white dark:bg-theme-surface">100</option>
            </select>
            <span className="text-theme-text-muted/50">de {total} registros</span>
          </div>
          <div className="flex items-center gap-2">
            <button disabled={filters.page <= 1} onClick={() => setFilters(p => ({ ...p, page: p.page - 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors">Anterior</button>
            <span className="text-theme-text-muted/50 font-medium">Pág. {filters.page} de {tp}</span>
            <button disabled={filters.page >= tp} onClick={() => setFilters(p => ({ ...p, page: p.page + 1 }))} className="px-3 py-1.5 rounded-lg border border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors">Siguiente</button>
          </div>
        </div>
      )}
    </div>
  )
}
