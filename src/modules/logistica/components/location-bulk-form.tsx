'use client'

import React, { useState, useMemo } from 'react'
import { createLocationsBulk } from '@/app/actions/logistica/locations'
import { ArrowLeft, Sparkles, X, AlertTriangle, ChevronDown, ChevronUp, Info, Settings2 } from 'lucide-react'

interface LocationBulkFormProps {
  warehouseId: string
  onClose: () => void
  onSuccess: () => void
}

function padIfNumeric(val: string): string {
  const num = parseInt(val, 10)
  if (!isNaN(num)) {
    return val.length >= 2 ? val : val.padStart(2, '0')
  }
  return val
}

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

export function LocationBulkForm({ warehouseId, onClose, onSuccess }: LocationBulkFormProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [showInstructions, setShowInstructions] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [simpleForm, setSimpleForm] = useState({
    aisle: '1',
    racks: '8',
    levels: '3',
    positions: '1'
  })

  const [bulkForm, setBulkForm] = useState({
    prefix: '',
    codeFormat: '{prefix}P{aisle}-R{rack}-N{level}-U{position}'
  })

  const activeForm = useMemo(() => {
    const format = bulkForm.codeFormat || '{prefix}P{aisle}-R{rack}-N{level}-U{position}'
    return {
      ...bulkForm,
      codeFormat: format,
      aisleFrom: simpleForm.aisle, aisleTo: simpleForm.aisle,
      rackFrom: simpleForm.racks && parseInt(simpleForm.racks) > 0 ? '1' : '', rackTo: simpleForm.racks,
      levelFrom: simpleForm.levels && parseInt(simpleForm.levels) > 0 ? '1' : '', levelTo: simpleForm.levels,
      posFrom: simpleForm.positions && parseInt(simpleForm.positions) > 0 ? '1' : '', posTo: simpleForm.positions,
    }
  }, [simpleForm, bulkForm])

  const totalCombinations = useMemo(() => {
    const p = activeForm.prefix.trim()
    const a = generateRange(activeForm.aisleFrom, activeForm.aisleTo)
    const r = generateRange(activeForm.rackFrom, activeForm.rackTo)
    const l = generateRange(activeForm.levelFrom, activeForm.levelTo)
    const pos = generateRange(activeForm.posFrom, activeForm.posTo)

    let c = 0
    if (a.length || r.length || l.length || pos.length || p) {
      c = Math.max(a.length, 1) * Math.max(r.length, 1) * Math.max(l.length, 1) * Math.max(pos.length, 1)
      if (c === 1 && !a[0] && !r[0] && !l[0] && !pos[0] && !p) {
        c = 0
      }
    }
    return c
  }, [activeForm])

  const previewCodes = useMemo(() => {
    if (totalCombinations === 0) return []
    const prefix = activeForm.prefix.trim()
    const aisles = generateRange(activeForm.aisleFrom, activeForm.aisleTo)
    const racks = generateRange(activeForm.rackFrom, activeForm.rackTo)
    const levels = generateRange(activeForm.levelFrom, activeForm.levelTo)
    const positions = generateRange(activeForm.posFrom, activeForm.posTo)

    const preview: string[] = []
    
    for (const aisle of aisles) {
      for (const rack of racks) {
        for (const level of levels) {
          for (const position of positions) {
            const code = formatCode(activeForm.codeFormat, prefix, aisle, rack, level, position)
            if (code && preview.length < 10) {
              preview.push(code)
            }
          }
        }
      }
    }

    return preview
  }, [activeForm, totalCombinations])

  const isBulkExceeded = totalCombinations > 2000

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (totalCombinations === 0) {
        throw new Error('No hay combinaciones válidas para generar ubicaciones.')
      }
      if (isBulkExceeded) {
        throw new Error('No se permite crear más de 2000 ubicaciones por lote. Ajuste los rangos.')
      }

      const r = await createLocationsBulk({
        ...activeForm,
        warehouse_id: warehouseId
      })

      if (!r.success) throw new Error(r.error)

      onSuccess()
    } catch (err: any) {
      setError(err.message || 'Error al generar ubicaciones')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-theme-surface w-full animate-in zoom-in-95 duration-200">
      <div className="px-6 py-3 border-b border-theme-border bg-theme-surface flex items-center justify-between sticky top-0 z-10 shrink-0 shadow-sm">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-theme-accent" />
          <h2 className="text-lg font-bold text-theme-text">
            Generador Masivo de Ubicaciones
          </h2>
        </div>
        <button 
          onClick={onClose}
          className="p-1.5 rounded-lg text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* LEFT COLUMN: FORM */}
        <div className="flex-1 overflow-y-auto p-6 lg:border-r border-theme-border flex flex-col gap-4">
          
          <div className="flex items-start justify-between bg-theme-text/[0.02] p-3 rounded-lg border border-theme-border/50">
            <p className="text-sm text-theme-text-muted/90">
              Define el pasillo, cantidad de racks, niveles y ubicaciones por nivel.
            </p>
            <button 
              onClick={() => setShowInstructions(!showInstructions)}
              className="text-xs font-semibold text-theme-accent hover:text-theme-accent-hover transition-colors whitespace-nowrap ml-4 flex items-center gap-1"
            >
              <Info className="w-3.5 h-3.5" />
              {showInstructions ? 'Ocultar' : 'Ver instrucciones'}
            </button>
          </div>
          
          {showInstructions && (
            <div className="px-4 py-3 bg-theme-accent/5 border border-theme-accent/20 rounded-lg text-xs text-theme-text-muted animate-in fade-in slide-in-from-top-2">
              <ul className="list-disc pl-4 space-y-1">
                <li>Defina el número o letra del pasillo principal (ej: 1, A, Pasillo Principal).</li>
                <li>Ingrese cuántos Racks o Columnas componen el pasillo.</li>
                <li>Especifique la cantidad de niveles (altura) de cada Rack.</li>
                <li>Si quiere una sola posición por nivel, use 1 en "Ubicaciones por nivel".</li>
                <li>Los códigos generados tendrán el formato WMS estándar: P[pasillo]-R[rack]-N[nivel]-U[ubicacion].</li>
              </ul>
            </div>
          )}

          <form id="bulk-form" onSubmit={handleBulkSubmit} className="space-y-4 max-w-2xl mt-2">
            {error && (
              <div className="bg-red-50 dark:bg-red-500/10 border border-red-300 dark:border-red-500/20 text-red-600 dark:text-red-400 p-3 rounded-lg text-sm font-medium">
                {error}
              </div>
            )}

            {/* Configuración Común */}
            <div className="p-5 border border-theme-border bg-theme-surface rounded-xl shadow-sm space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Pasillo / Zona</label>
                  <input 
                    type="text" 
                    value={simpleForm.aisle} 
                    onChange={e => setSimpleForm(p => ({...p, aisle: e.target.value}))} 
                    placeholder="Ej: 1, A, MERMA" 
                    className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Cantidad de Racks / Col</label>
                  <input 
                    type="number" 
                    min="0"
                    value={simpleForm.racks} 
                    onChange={e => setSimpleForm(p => ({...p, racks: e.target.value}))} 
                    placeholder="Ej: 8" 
                    className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Cantidad de niveles (Alto)</label>
                  <input 
                    type="number" 
                    min="0"
                    value={simpleForm.levels} 
                    onChange={e => setSimpleForm(p => ({...p, levels: e.target.value}))} 
                    placeholder="Ej: 3" 
                    className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wider">Ubicaciones por nivel</label>
                  <input 
                    type="number" 
                    min="0"
                    value={simpleForm.positions} 
                    onChange={e => setSimpleForm(p => ({...p, positions: e.target.value}))} 
                    placeholder="Ej: 1" 
                    className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                  />
                </div>
              </div>
              
              <div className="pt-2">
                <div className="space-y-1.5 max-w-[50%] pr-2.5">
                  <label className="text-xs font-bold text-theme-text-muted/70 uppercase tracking-wider">Prefijo (Opcional)</label>
                  <input 
                    type="text"
                    value={bulkForm.prefix} 
                    onChange={e => setBulkForm(p => ({ ...p, prefix: e.target.value }))}
                    placeholder="Ej: A"
                    className="w-full h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                  />
                </div>
              </div>
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
                <div className="mt-3 p-4 bg-theme-surface border border-theme-border rounded-xl animate-in fade-in slide-in-from-top-2">
                  <label className="text-xs font-bold text-theme-text uppercase tracking-wider block mb-1.5">Estructura del Código (Plantilla)</label>
                  <input 
                    type="text"
                    value={bulkForm.codeFormat} 
                    onChange={e => setBulkForm(p => ({ ...p, codeFormat: e.target.value }))}
                    className="w-full h-10 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm font-mono text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-accent/20 transition-all" 
                  />
                  <p className="text-[10px] text-theme-text-muted mt-2 leading-tight">
                    Variables: <code className="bg-theme-text/5 px-1 py-0.5 rounded">{'{prefix}'}</code> <code className="bg-theme-text/5 px-1 py-0.5 rounded">{'{aisle}'}</code> <code className="bg-theme-text/5 px-1 py-0.5 rounded">{'{rack}'}</code> <code className="bg-theme-text/5 px-1 py-0.5 rounded">{'{level}'}</code> <code className="bg-theme-text/5 px-1 py-0.5 rounded">{'{position}'}</code>
                  </p>
                </div>
              )}
            </div>

          </form>
        </div>

        {/* RIGHT COLUMN: PREVIEW & ACTIONS */}
        <div className="w-full lg:w-[420px] shrink-0 bg-theme-text/[0.015] p-6 overflow-y-auto flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-bold text-theme-text mb-3 border-b border-theme-border pb-2">Resumen y Vista Previa</h3>
            
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-theme-text-muted">Total a generar:</span>
                <span className={`text-lg font-black px-3 py-1 rounded-lg ${isBulkExceeded ? 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-400' : (totalCombinations > 0 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400' : 'bg-theme-text/10 text-theme-text')}`}>
                  {totalCombinations} {totalCombinations === 1 ? 'ubicación' : 'ubicaciones'}
                </span>
              </div>
              
              {isBulkExceeded && (
                <div className="flex items-start gap-2 text-red-500 text-xs font-semibold mt-3 bg-red-50 dark:bg-red-500/10 p-3 rounded-lg border border-red-200 dark:border-red-500/20">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  No se permite crear más de 2000 ubicaciones por lote. Ajuste los rangos.
                </div>
              )}
            </div>

            <div className="bg-theme-surface border border-theme-border rounded-xl p-4 shadow-sm">
              <p className="text-[10px] font-bold text-theme-text-muted uppercase tracking-wider mb-3">Códigos Resultantes (Muestra)</p>
              
              {previewCodes.length > 0 ? (
                <div className="flex flex-col gap-6">
                  {(() => {
                    const prefix = activeForm.prefix.trim()
                    const aisles = generateRange(activeForm.aisleFrom, activeForm.aisleTo)
                    const racks = generateRange(activeForm.rackFrom, activeForm.rackTo)
                    const levels = generateRange(activeForm.levelFrom, activeForm.levelTo).reverse()
                    const positions = generateRange(activeForm.posFrom, activeForm.posTo)

                    return aisles.slice(0, 1).map((aisle, aIdx) => (
                      <div key={aIdx} className="overflow-x-auto pb-2">
                        <p className="font-bold text-theme-text text-xs mb-2 text-center bg-theme-text/5 py-1 rounded">Pasillo {aisle}</p>
                        <table className="w-full text-center border-collapse text-xs">
                          <thead>
                            <tr>
                              <th className="p-1 border-b border-theme-border/60"></th>
                              {racks.slice(0, 4).map(r => (
                                <th key={r} className="p-1 border-b border-theme-border/60 font-bold text-theme-text-muted whitespace-nowrap">Rack {r}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-theme-border/40">
                            {levels.slice(0, 4).map(l => (
                              <tr key={l} className="hover:bg-theme-text/[0.02]">
                                <td className="p-1 font-bold text-theme-text-muted whitespace-nowrap text-right pr-3">Nivel {l}</td>
                                {racks.slice(0, 4).map(r => (
                                  <td key={r} className="p-1 border-l border-theme-border/40 align-top">
                                    <div className="flex flex-col gap-1 items-center">
                                      {positions.slice(0, 2).map(p => (
                                        <div key={p} className="whitespace-nowrap font-mono text-[10px] bg-theme-surface border border-theme-border px-1.5 py-0.5 rounded text-theme-text shadow-sm">
                                          {formatCode(activeForm.codeFormat, prefix, aisle, r, l, p)}
                                        </div>
                                      ))}
                                      {positions.length > 2 && <div className="text-[9px] text-theme-text-muted leading-none mt-0.5">...</div>}
                                    </div>
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {(racks.length > 4 || levels.length > 4) && (
                          <p className="text-[10px] text-theme-text-muted mt-2 italic text-center">* Muestra parcial de {racks.length}x{levels.length}</p>
                        )}
                      </div>
                    ))
                  })()}
                  {generateRange(activeForm.aisleFrom, activeForm.aisleTo).length > 1 && (
                    <p className="text-xs text-theme-text-muted italic text-center">... más pasillos</p>
                  )}
                </div>
              ) : (
                <div className="py-8 text-center border-2 border-dashed border-theme-border rounded-xl">
                  <p className="text-xs text-theme-text-muted italic">Complete los datos para previsualizar los códigos.</p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 pt-5 border-t border-theme-border flex flex-col gap-3">
            <button 
              type="submit" 
              form="bulk-form"
              disabled={loading || totalCombinations === 0 || isBulkExceeded}
              className="w-full py-2.5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-colors shadow-lg shadow-theme-accent/20 disabled:opacity-50 disabled:shadow-none flex items-center justify-center gap-2"
            >
              {loading ? 'Procesando...' : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generar {totalCombinations > 0 ? totalCombinations : ''} Ubicaciones
                </>
              )}
            </button>
            <button 
              type="button" 
              onClick={onClose}
              disabled={loading}
              className="w-full py-2.5 rounded-xl border border-theme-border bg-theme-surface text-theme-text hover:bg-theme-text/5 text-sm font-semibold transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
