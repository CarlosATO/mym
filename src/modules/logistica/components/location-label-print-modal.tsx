'use client'

import { useMemo, useState } from 'react'
import { Check, ChevronDown, Printer, Search, X } from 'lucide-react'
import { type LocationWithLayout } from '@/app/actions/logistica/location-layouts'
import { generateLocationLabelsPdf, type LocationLabelFormat, type LocationLabelRecord } from '@/lib/pdf/generate-location-labels-pdf'

type PrintMode = 'all' | 'aisle' | 'rack' | 'specific'

interface LocationLabelPrintModalProps {
  warehouseName: string
  locations: LocationWithLayout[]
  onClose: () => void
}

function naturalCompare(a: string | null, b: string | null): number {
  return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare(a ?? '', b ?? '')
}

function isPrintableLocation(location: LocationWithLayout): boolean {
  const code = location.code ?? ''
  return code.trim().length > 0 && code.length <= 50 && !/[\u0000-\u001F\u007F]/.test(code)
}

export function LocationLabelPrintModal({ warehouseName, locations, onClose }: LocationLabelPrintModalProps) {
  const [mode, setMode] = useState<PrintMode>('all')
  const [aisle, setAisle] = useState('')
  const [rack, setRack] = useState('')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [generating, setGenerating] = useState(false)
  const [format, setFormat] = useState<LocationLabelFormat>('labels')

  const activeLocations = useMemo(() => locations.filter(location => location.is_active), [locations])
  const validLocations = useMemo(() => activeLocations.filter(isPrintableLocation), [activeLocations])
  const invalidCount = activeLocations.length - validLocations.length
  const aisles = useMemo(() => Array.from(new Set(validLocations.map(location => location.aisle).filter(Boolean) as string[])).sort(naturalCompare), [validLocations])
  const racks = useMemo(() => validLocations
    .filter(location => !aisle || location.aisle === aisle)
    .map(location => location.rack)
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort(naturalCompare), [validLocations, aisle])

  const visibleLocations = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return validLocations
    return validLocations.filter(location => [location.code, location.aisle, location.rack, location.level, location.position]
      .some(value => value?.toLowerCase().includes(query)))
  }, [validLocations, search])

  const selectedLocations = useMemo(() => {
    if (mode === 'all') return validLocations
    if (mode === 'aisle') return validLocations.filter(location => location.aisle === aisle)
    if (mode === 'rack') return validLocations.filter(location => location.aisle === aisle && location.rack === rack)
    return validLocations.filter(location => selectedIds.has(location.id))
  }, [mode, validLocations, aisle, rack, selectedIds])

  const orderedLocations = useMemo(() => [...selectedLocations].sort((a, b) =>
    naturalCompare(a.aisle, b.aisle) || naturalCompare(a.rack, b.rack) || naturalCompare(a.level, b.level) || naturalCompare(a.position, b.position) || naturalCompare(a.code, b.code)), [selectedLocations])

  function changeMode(nextMode: PrintMode) {
    setMode(nextMode)
    if (nextMode !== 'rack') setRack('')
    if (nextMode !== 'specific') setSelectedIds(new Set())
  }

  function toggleVisible() {
    const next = new Set(selectedIds)
    const allVisibleSelected = visibleLocations.length > 0 && visibleLocations.every(location => next.has(location.id))
    visibleLocations.forEach(location => {
      if (allVisibleSelected) next.delete(location.id)
      else next.add(location.id)
    })
    setSelectedIds(next)
  }

  async function handleGenerate() {
    if (orderedLocations.length === 0) return
    setGenerating(true)
    try {
      const printableLocations: LocationLabelRecord[] = orderedLocations.map(location => ({
        id: location.id,
        code: location.code.trim(),
        name: location.name,
        aisle: location.aisle,
        rack: location.rack,
        level: location.level,
        position: location.position,
      }))
      const blob = generateLocationLabelsPdf(warehouseName, printableLocations, format)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const filenamePrefix = format === 'full-sheet' ? 'hojas-ubicaciones' : 'etiquetas-ubicaciones'
      link.download = `${filenamePrefix}-${warehouseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.pdf`
      link.click()
      URL.revokeObjectURL(url)
      onClose()
    } finally {
      setGenerating(false)
    }
  }

  const scopeLabel = mode === 'all' ? 'Toda la bodega' : mode === 'aisle' ? `Pasillo ${aisle || '—'}` : mode === 'rack' ? `Pasillo ${aisle || '—'} · Rack ${rack || '—'}` : 'Ubicaciones específicas'
  const estimatedPages = format === 'full-sheet' ? orderedLocations.length : Math.ceil(orderedLocations.length / 24)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="location-label-print-title">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-theme-border px-5 py-4">
          <div><h2 id="location-label-print-title" className="flex items-center gap-2 text-base font-bold text-theme-text"><Printer className="h-4 w-4 text-theme-accent" /> Imprimir etiquetas</h2><p className="mt-1 text-xs text-theme-text-muted">{warehouseName}</p></div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text" aria-label="Cerrar"><X className="h-5 w-5" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <p className="mb-3 text-sm font-semibold text-theme-text">¿Qué desea imprimir?</p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {([['all', 'Toda la bodega'], ['aisle', 'Un pasillo'], ['rack', 'Un rack'], ['specific', 'Específicas']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => changeMode(value)} className={`rounded-xl border px-3 py-3 text-left text-xs font-semibold transition-colors ${mode === value ? 'border-theme-accent bg-theme-accent/10 text-theme-text-accent' : 'border-theme-border text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'}`}>{label}</button>)}
          </div>

          {mode === 'aisle' && <label className="mt-4 block text-xs font-semibold text-theme-text">Pasillo<select value={aisle} onChange={event => setAisle(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text"><option value="">Seleccione un pasillo</option>{aisles.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
           {mode === 'rack' && <div className="mt-4 grid gap-3 md:grid-cols-2"><label className="text-xs font-semibold text-theme-text">Pasillo<select value={aisle} onChange={event => { setAisle(event.target.value); setRack('') }} className="mt-1 h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text"><option value="">Seleccione un pasillo</option>{aisles.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label className="text-xs font-semibold text-theme-text">Rack<select value={rack} onChange={event => setRack(event.target.value)} disabled={!aisle} className="mt-1 h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text disabled:opacity-50"><option value="">Seleccione un rack</option>{racks.map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>}
            {mode === 'specific' && <div className="mt-4 space-y-3"><div className="flex flex-col gap-2 sm:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar código, pasillo, rack o nivel..." className="h-10 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-sm text-theme-text" /></div><button type="button" onClick={toggleVisible} disabled={visibleLocations.length === 0} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 disabled:opacity-40"><Check className="h-4 w-4" /> Seleccionar visibles</button></div><div className="max-h-64 overflow-y-auto rounded-xl border border-theme-border">{visibleLocations.map(location => <label key={location.id} className="flex cursor-pointer items-center gap-3 border-b border-theme-border/60 px-3 py-2.5 last:border-0 hover:bg-theme-text/5"><input type="checkbox" checked={selectedIds.has(location.id)} onChange={() => { const next = new Set(selectedIds); if (next.has(location.id)) next.delete(location.id); else next.add(location.id); setSelectedIds(next) }} className="accent-emerald-600" /><span className="min-w-0 flex-1"><span className="block truncate font-mono text-xs font-bold text-theme-text">{location.code}</span><span className="block truncate text-[11px] text-theme-text-muted">{[location.aisle, location.rack, location.level, location.position].filter(Boolean).join(' · ') || 'Sin desglose'}</span></span></label>)}{visibleLocations.length === 0 && <p className="p-6 text-center text-xs text-theme-text-muted">No hay ubicaciones que coincidan.</p>}</div></div>}

          <div className="mt-5"><p className="mb-2 text-sm font-semibold text-theme-text">Formato de impresión</p><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setFormat('labels')} className={`rounded-xl border px-3 py-3 text-left text-xs font-semibold transition-colors ${format === 'labels' ? 'border-theme-accent bg-theme-accent/10 text-theme-text-accent' : 'border-theme-border text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'}`}><span className="block">Etiquetas</span><span className="mt-1 block text-[10px] font-normal opacity-70">3 × 8 por página</span></button><button type="button" onClick={() => setFormat('full-sheet')} className={`rounded-xl border px-3 py-3 text-left text-xs font-semibold transition-colors ${format === 'full-sheet' ? 'border-theme-accent bg-theme-accent/10 text-theme-text-accent' : 'border-theme-border text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'}`}><span className="block">Hoja completa</span><span className="mt-1 block text-[10px] font-normal opacity-70">1 ubicación por página</span></button></div></div>

          <div className="mt-5 rounded-xl border border-theme-border bg-theme-text/[0.025] p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">Resumen</p><div className="mt-2 grid gap-2 text-xs text-theme-text md:grid-cols-5"><span><strong>Bodega:</strong> {warehouseName}</span><span><strong>Alcance:</strong> {scopeLabel}</span><span><strong>Formato:</strong> {format === 'full-sheet' ? 'Hoja completa' : 'Etiquetas'}</span><span><strong>Ubicaciones:</strong> <strong className="text-theme-accent">{orderedLocations.length}</strong></span><span><strong>Páginas:</strong> <strong className="text-theme-accent">{estimatedPages}</strong></span></div>{invalidCount > 0 && <p className="mt-3 text-[11px] text-amber-600">{invalidCount} ubicación(es) activa(s) se excluirán por código inválido.</p>}</div>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-theme-border px-5 py-4"><button type="button" onClick={onClose} className="rounded-lg border border-theme-border px-4 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5">Cancelar</button><button type="button" onClick={handleGenerate} disabled={orderedLocations.length === 0 || generating} className="inline-flex items-center gap-2 rounded-lg bg-theme-accent px-4 py-2 text-xs font-bold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40">{generating ? <ChevronDown className="h-4 w-4 animate-bounce" /> : <Printer className="h-4 w-4" />} Generar PDF</button></div>
      </div>
    </div>
  )
}
