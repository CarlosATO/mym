'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { createLocation, updateLocation, type Location } from '@/app/actions/logistica/locations'
import { Save, X, Settings2, ChevronDown, ChevronUp } from 'lucide-react'

interface LocationFormProps {
  warehouseId: string
  warehouseName?: string
  editLoc?: Location | null
  onClose: () => void
  onSuccess: (locationId: string) => void
}

function padIfNumeric(val: string): string {
  const num = parseInt(val, 10)
  if (!isNaN(num)) {
    return val.length >= 2 ? val : val.padStart(2, '0')
  }
  return val
}

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
  
  if (!aisle) res = res.replace(/P(?=-|$)/gi, '').replace(/PAS-/gi, '')
  if (!rack) res = res.replace(/-R(?=-|$)/gi, '').replace(/RACK-/gi, '')
  if (!level) res = res.replace(/-N(?=-|$)/gi, '').replace(/NIV-/gi, '')
  if (!position) res = res.replace(/-U(?=-|$)/gi, '').replace(/UBI-/gi, '')

  res = res.replace(/[-_+/]{2,}/g, (match) => match[0])
  res = res.replace(/^[-_+/]+|[-_+/]+$/g, '')
  return res.toUpperCase()
}

export function LocationForm({ warehouseId, warehouseName, editLoc, onClose, onSuccess }: LocationFormProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [form, setForm] = useState({
    code: '',
    name: '',
    warehouse_id: warehouseId,
    aisle: '',
    rack: '',
    level: '',
    position: '',
    description: '',
    is_active: true
  })

  const [manualCode, setManualCode] = useState(false)

  useEffect(() => {
    if (editLoc) {
      setForm({
        code: editLoc.code || '',
        name: editLoc.name || '',
        warehouse_id: editLoc.warehouse_id || warehouseId,
        aisle: editLoc.aisle || '',
        rack: editLoc.rack || '',
        level: editLoc.level || '',
        position: editLoc.position || '',
        description: editLoc.description || '',
        is_active: editLoc.is_active ?? true
      })
      setManualCode(true) // For editing, we keep the existing code unless they change fields
    } else {
      setForm(prev => ({ ...prev, warehouse_id: warehouseId }))
    }
  }, [editLoc, warehouseId])

  const generatedCode = useMemo(() => {
    const pAisle = form.aisle.trim().toUpperCase()
    const pRack = padIfNumeric(form.rack.trim())
    const pLevel = padIfNumeric(form.level.trim())
    const pPos = padIfNumeric(form.position.trim())

    return formatCode('{prefix}P{aisle}-R{rack}-N{level}-U{position}', '', pAisle, pRack, pLevel, pPos)
  }, [form.aisle, form.rack, form.level, form.position])

  // Update actual code when auto-generated code changes (unless manual override is used)
  useEffect(() => {
    if (!manualCode) {
      setForm(prev => ({ ...prev, code: generatedCode }))
    }
  }, [generatedCode, manualCode])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    
    try {
      if (!form.rack.trim() || !form.level.trim() || !form.position.trim()) {
        throw new Error('Rack, Nivel y Ubicación son obligatorios.')
      }
      
      const finalCode = manualCode ? form.code : generatedCode
      if (!finalCode) {
        throw new Error('No se pudo generar un código válido.')
      }
      
      setLoading(true)

      if (editLoc) {
        const r = await updateLocation(editLoc.id, {
          code: finalCode,
          name: form.name || undefined,
          aisle: form.aisle || undefined,
          rack: form.rack || undefined,
          level: form.level || undefined,
          position: form.position || undefined,
          description: form.description || undefined,
          is_active: form.is_active
        })
        if (!r.success) throw new Error(r.error)
        onSuccess(editLoc.id)
      } else {
        const r = await createLocation({
          code: finalCode,
          name: form.name || undefined,
          warehouse_id: form.warehouse_id,
          aisle: form.aisle || undefined,
          rack: form.rack || undefined,
          level: form.level || undefined,
          position: form.position || undefined,
          description: form.description || undefined
        })
        if (!r.success) throw new Error(r.error)
        onSuccess((r as any).data?.id || finalCode)
      }
    } catch (err: any) {
      setError(err.message || 'Error al guardar la ubicación')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-theme-surface w-full animate-in slide-in-from-right-8 duration-300 border-l border-theme-border shadow-xl">
      <div className="px-5 py-4 border-b border-theme-border flex flex-col gap-1 shrink-0 bg-theme-surface">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-theme-text">
            {editLoc ? 'Editar Ubicación' : 'Nueva Ubicación'}
          </h2>
          <button 
            onClick={onClose}
            className="p-1.5 rounded-lg text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {warehouseName && (
          <p className="text-xs font-semibold text-theme-text-muted">{warehouseName}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-5 pb-8">
        <form id="location-form" onSubmit={handleSave} className="space-y-6">
          {error && (
            <div className="bg-red-50 dark:bg-red-500/10 border border-red-300 dark:border-red-500/20 text-red-600 dark:text-red-400 p-3 rounded-lg text-sm font-medium">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <h3 className="text-sm font-bold text-theme-text border-b border-theme-border pb-2">Estructura Física</h3>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Pasillo / Zona</label>
                <input 
                  type="text"
                  value={form.aisle} 
                  onChange={e => {
                    setForm(p => ({ ...p, aisle: e.target.value }))
                    if (editLoc) setManualCode(false)
                  }}
                  placeholder="Ej: A, 1"
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Rack / Columna *</label>
                <input 
                  type="text"
                  value={form.rack} 
                  onChange={e => {
                    setForm(p => ({ ...p, rack: e.target.value }))
                    if (editLoc) setManualCode(false)
                  }}
                  placeholder="Ej: 1"
                  required
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Nivel / Altura *</label>
                <input 
                  type="text"
                  value={form.level} 
                  onChange={e => {
                    setForm(p => ({ ...p, level: e.target.value }))
                    if (editLoc) setManualCode(false)
                  }}
                  placeholder="Ej: 3"
                  required
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Ubicación (Pos) *</label>
                <input 
                  type="text"
                  value={form.position} 
                  onChange={e => {
                    setForm(p => ({ ...p, position: e.target.value }))
                    if (editLoc) setManualCode(false)
                  }}
                  placeholder="Ej: 1"
                  required
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                />
              </div>
            </div>
          </div>

          <div className="bg-theme-text/[0.02] border border-theme-border rounded-xl p-4 shadow-sm flex flex-col items-center">
            <p className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider mb-2">Código Generado</p>
            <div className="font-mono text-lg font-black text-theme-accent tracking-wide bg-theme-surface px-4 py-2 rounded-lg border border-theme-accent/20 shadow-sm">
              {manualCode ? form.code : (generatedCode || '---')}
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-bold text-theme-text border-b border-theme-border pb-2">Detalles Opcionales</h3>
            
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Nombre descriptivo</label>
              <input 
                type="text"
                value={form.name} 
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder="Ej: Rack de alta rotación..."
                className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Descripción</label>
              <textarea 
                value={form.description} 
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                placeholder="Observaciones..."
                rows={2} 
                className="w-full rounded-xl border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 resize-none transition-all" 
              />
            </div>

            {editLoc && (
              <div className="flex items-center gap-2.5 pt-2">
                <input 
                  type="checkbox"
                  checked={form.is_active}
                  onChange={e => setForm(p => ({ ...p, is_active: e.target.checked }))}
                  className="w-4 h-4 accent-theme-accent rounded cursor-pointer transition-all"
                />
                <span className="text-sm font-bold text-theme-text">Ubicación Activa</span>
              </div>
            )}
          </div>

          {/* Opciones Avanzadas Accordion */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-xs font-bold text-theme-text-muted hover:text-theme-text transition-colors bg-theme-text/5 px-3 py-2 rounded-lg"
            >
              <Settings2 className="w-4 h-4" />
              Opciones avanzadas
              {showAdvanced ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />}
            </button>
            
            {showAdvanced && (
              <div className="mt-3 p-4 bg-theme-surface border border-theme-border rounded-xl animate-in fade-in slide-in-from-top-2 space-y-2">
                <label className="text-xs font-bold text-theme-text uppercase tracking-wider block">Código Manual</label>
                <p className="text-[10px] text-theme-text-muted mb-2">Edita el código solo si necesitas un formato especial que no sigue el estándar WMS.</p>
                <input 
                  type="text"
                  value={form.code} 
                  onChange={e => {
                    setForm(p => ({ ...p, code: e.target.value }))
                    setManualCode(true)
                  }}
                  className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm font-mono text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                />
              </div>
            )}
          </div>
        </form>
      </div>

      <div className="p-5 border-t border-theme-border flex items-center justify-end gap-3 shrink-0 bg-theme-surface">
        <button 
          type="button" 
          onClick={onClose}
          disabled={loading}
          className="px-5 py-2.5 rounded-xl border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 text-sm font-semibold transition-colors disabled:opacity-50"
        >
          Cancelar
        </button>
        <button 
          type="submit" 
          form="location-form"
          disabled={loading}
          className="px-6 py-2.5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-colors shadow-lg shadow-theme-accent/20 disabled:opacity-50 disabled:shadow-none flex items-center gap-2"
        >
          {loading ? 'Guardando...' : (
            <>
              <Save className="w-4 h-4" />
              Guardar
            </>
          )}
        </button>
      </div>
    </div>
  )
}
