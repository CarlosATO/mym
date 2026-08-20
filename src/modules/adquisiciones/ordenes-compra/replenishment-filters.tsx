'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarRange, Check, ChevronDown, Filter, Loader2, Search, Settings2, X } from 'lucide-react'
import { VIEWS, type HistorialVisible, type ViewId } from './replenishment-columns'

interface PeriodOption {
  label: string
  value: number
}

interface ReplenishmentFiltersProps {
  periodOptions: PeriodOption[]
  coverageOptions: PeriodOption[]
  draftPeriodIdx: number
  draftCoverageIdx: number
  onDraftPeriodChange: (index: number) => void
  onDraftCoverageChange: (index: number) => void
  supplierOptions: string[]
  lineOptions: string[]
  draftSupplier: string
  draftLine: string
  onDraftSupplierChange: (value: string) => void
  onDraftLineChange: (value: string) => void
  onClearSupplier: () => void
  onClearLine: () => void
  draftSearch: string
  onDraftSearchChange: (value: string) => void
  onClearSearch: () => void
  draftStatus: string
  onDraftStatusChange: (value: string) => void
  draftShowAll: boolean
  onDraftShowAllChange: (value: boolean) => void
  busy: boolean
  initialLoading: boolean
  viewLabel: string
  onSelectView: (view: ViewId) => void
  historialOptions: { id: HistorialVisible; label: string }[]
  historialVisible: HistorialVisible
  onSelectHistorial: (h: HistorialVisible) => void
  onOpenConfig: () => void
}

type OpenMenu = 'estado' | 'historial' | 'proveedor' | 'linea' | null

const STATUS_OPTIONS = [
  { id: 'TODOS', label: 'Todos' },
  { id: 'REPONER', label: 'A reponer' },
  { id: 'CRITICO', label: 'Críticos' },
  { id: 'SIN_COSTO', label: 'Sin costo' },
]

const inputClass = 'h-8 rounded-md border border-theme-border bg-theme-bg/40 px-2.5 text-xs text-theme-text outline-none transition placeholder:text-theme-text-muted/45 focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/15 disabled:cursor-not-allowed disabled:opacity-60'
const triggerClass = 'flex h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-semibold transition'
const optionRowClass = 'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-theme-text transition hover:bg-theme-text/5'
const filterLabelClass = 'px-0.5 text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted/70'

export function ReplenishmentFilters({
  periodOptions,
  coverageOptions,
  draftPeriodIdx,
  draftCoverageIdx,
  onDraftPeriodChange,
  onDraftCoverageChange,
  supplierOptions,
  lineOptions,
  draftSupplier,
  draftLine,
  onDraftSupplierChange,
  onDraftLineChange,
  onClearSupplier,
  onClearLine,
  draftSearch,
  onDraftSearchChange,
  onClearSearch,
  draftStatus,
  onDraftStatusChange,
  draftShowAll,
  onDraftShowAllChange,
  busy,
  initialLoading,
  viewLabel,
  onSelectView,
  historialOptions,
  historialVisible,
  onSelectHistorial,
  onOpenConfig,
}: ReplenishmentFiltersProps) {
  const [open, setOpen] = useState<OpenMenu>(null)
  const [proveedorQuery, setProveedorQuery] = useState('')
  const [lineaQuery, setLineaQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  // Cierre por clic fuera
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Cierre por Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  const statusLabel = STATUS_OPTIONS.find(s => s.id === draftStatus)?.label || 'Todos'
  const hasStatus = draftStatus !== 'TODOS'

  const filteredSuppliers = useMemo(() => {
    const q = proveedorQuery.trim().toLowerCase()
    return q ? supplierOptions.filter(s => s.toLowerCase().includes(q)) : supplierOptions
  }, [supplierOptions, proveedorQuery])

  const filteredLines = useMemo(() => {
    const q = lineaQuery.trim().toLowerCase()
    return q ? lineOptions.filter(l => l.toLowerCase().includes(q)) : lineOptions
  }, [lineOptions, lineaQuery])

  const selectSupplier = (s: string) => { onDraftSupplierChange(s); setProveedorQuery(s); setOpen(null) }
  const selectLine = (l: string) => { onDraftLineChange(l); setLineaQuery(l); setOpen(null) }
  const clearSupplier = () => { onClearSupplier(); setProveedorQuery(''); setOpen(null) }
  const clearLine = () => { onClearLine(); setLineaQuery(''); setOpen(null) }
  const clearSearch = () => { onClearSearch(); setOpen(null) }

  return (
    <div ref={rootRef} className="shrink-0 border-b border-theme-border bg-theme-surface px-5 py-1.5">
      {/* Toolbar única */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex shrink-0 flex-col gap-0.5">
          <label htmlFor="replenishment-period" className={filterLabelClass}>Período de análisis</label>
          <select
            id="replenishment-period"
            aria-label="Período de análisis"
            value={draftPeriodIdx}
            onChange={e => onDraftPeriodChange(Number(e.target.value))}
            className={`${inputClass} max-w-[135px] cursor-pointer`}
          >
            {periodOptions.map((o, i) => (
              <option key={i} value={i}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5">
          <label htmlFor="replenishment-coverage" className={filterLabelClass}>Cobertura objetivo</label>
          <select
            id="replenishment-coverage"
            aria-label="Cobertura objetivo"
            value={draftCoverageIdx}
            onChange={e => onDraftCoverageChange(Number(e.target.value))}
            className={`${inputClass} max-w-[100px] cursor-pointer`}
          >
            {coverageOptions.map((o, i) => (
              <option key={i} value={i}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5">
          <label htmlFor="replenishment-supplier" className={filterLabelClass}>Proveedor</label>
          <div className="relative w-[155px]">
            <input
              id="replenishment-supplier"
              aria-label="Proveedor"
              value={open === 'proveedor' ? proveedorQuery : draftSupplier}
              onChange={e => { setProveedorQuery(e.target.value); setOpen('proveedor') }}
              onFocus={() => { setProveedorQuery(draftSupplier); setOpen('proveedor') }}
              placeholder={initialLoading ? 'Cargando proveedores...' : 'Proveedor...'}
              disabled={initialLoading}
              className={`${inputClass} w-full pr-7`}
            />
            {!initialLoading && draftSupplier && (
              <button
                onClick={clearSupplier}
                aria-label="Limpiar proveedor"
                className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-theme-text-muted/70 transition hover:bg-theme-text/10 hover:text-theme-text"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5">
          <label htmlFor="replenishment-line" className={filterLabelClass}>Línea de artículos</label>
          <div className="relative w-[155px]">
            <input
              id="replenishment-line"
              aria-label="Línea de artículos"
              value={open === 'linea' ? lineaQuery : draftLine}
              onChange={e => { setLineaQuery(e.target.value); setOpen('linea') }}
              onFocus={() => { setLineaQuery(draftLine); setOpen('linea') }}
              placeholder={initialLoading ? 'Cargando líneas...' : 'Línea de artículos...'}
              disabled={initialLoading}
              className={`${inputClass} w-full pr-7`}
            />
            {!initialLoading && draftLine && (
              <button
                onClick={clearLine}
                aria-label="Limpiar línea de artículos"
                className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-theme-text-muted/70 transition hover:bg-theme-text/10 hover:text-theme-text"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5">
          <label htmlFor="replenishment-search" className={filterLabelClass}>SKU / Producto</label>
          <div className="relative w-[160px]">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-theme-text-muted/60" />
            <input
              id="replenishment-search"
              aria-label="Buscar SKU o producto"
              type="text"
              value={draftSearch}
              onChange={e => onDraftSearchChange(e.target.value)}
              placeholder="Buscar SKU o producto..."
              disabled={initialLoading}
              className={`${inputClass} w-full pl-7 pr-7`}
            />
            {!initialLoading && draftSearch !== '' && (
              <button
                onClick={clearSearch}
                aria-label="Limpiar búsqueda"
                className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-theme-text-muted/70 transition hover:bg-theme-text/10 hover:text-theme-text"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5">
          <span className={filterLabelClass}>Estado</span>
          <button
            onClick={() => setOpen(prev => (prev === 'estado' ? null : 'estado'))}
            aria-expanded={open === 'estado'}
            className={`${triggerClass} ${
              open === 'estado' || hasStatus
                ? 'border-theme-accent/50 bg-theme-accent/10 text-theme-text'
                : 'border-theme-border bg-theme-bg/40 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            Estado · {statusLabel}
            <ChevronDown className={`h-3 w-3 transition-transform ${open === 'estado' ? 'rotate-180' : ''}`} />
          </button>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5">
          <span className={filterLabelClass}>Productos</span>
          <label className="flex h-8 cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-theme-text">
            <input
              type="checkbox"
              checked={draftShowAll}
              onChange={e => onDraftShowAllChange(e.target.checked)}
              disabled={initialLoading}
              className="h-3.5 w-3.5 rounded border-theme-border text-theme-accent disabled:cursor-not-allowed disabled:opacity-60"
            />
            Todos
          </label>
        </div>

        {/* Vistas: botones segmentados siempre disponibles */}
        <div className="flex shrink-0 flex-col gap-0.5">
          <span className={filterLabelClass}>Vista de análisis</span>
          <div className="flex h-8 items-center gap-0.5 rounded-md border border-theme-border bg-theme-bg/40 p-0.5" role="group" aria-label="Vista de análisis">
            {VIEWS.map(v => (
              <button
                key={v.id}
                onClick={() => onSelectView(v.id)}
                className={`flex h-6 items-center rounded px-2 text-[11px] font-semibold transition ${
                  viewLabel === v.label
                    ? 'bg-theme-accent text-white shadow-sm'
                    : 'text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        {viewLabel === 'Personalizada' && (
          <span className="inline-flex shrink-0 items-center rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-[10px] font-semibold text-theme-text-muted">
            Personalizada
          </span>
        )}

        <div className="flex shrink-0 flex-col gap-0.5">
          <span className={filterLabelClass}>Detalle temporal</span>
          <button
            onClick={() => setOpen(prev => (prev === 'historial' ? null : 'historial'))}
            aria-expanded={open === 'historial'}
            title="Análisis por semanas"
            className={`${triggerClass} ${
              open === 'historial'
                ? 'border-theme-accent/50 bg-theme-accent/10 text-theme-text'
                : 'border-theme-border bg-theme-bg/40 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
            }`}
          >
            <CalendarRange className="h-3.5 w-3.5" />
            Análisis por semanas · {historialVisible === 'Oculto' ? 'Oculto' : historialVisible}
            <ChevronDown className={`h-3 w-3 transition-transform ${open === 'historial' ? 'rotate-180' : ''}`} />
          </button>
        </div>

        <div className="flex shrink-0 flex-col gap-0.5">
          <span aria-hidden="true" className="h-[15px]" />
          <button
            onClick={onOpenConfig}
            title="Configuración de columnas"
            className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-theme-border bg-theme-bg/40 px-2 text-xs font-semibold text-theme-text-muted transition hover:bg-theme-text/5 hover:text-theme-text"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Configuración
          </button>
        </div>

        <div className="ml-auto flex h-8 shrink-0 items-center gap-1.5">
          {busy && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-theme-accent" />
              <span className="text-xs font-semibold text-theme-text-muted">Consultando...</span>
            </>
          )}
        </div>
      </div>

      {/* Área temporal contextual: en flujo, empuja la tabla (nunca la cubre) */}
      {open && (
        <div className="mt-2 rounded-lg border border-theme-border bg-theme-surface p-2 shadow-sm">
          {open === 'estado' && (
            <div className="flex flex-wrap gap-1">
              {STATUS_OPTIONS.map(o => (
                <button
                  key={o.id}
                  onClick={() => { onDraftStatusChange(o.id); setOpen(null) }}
                  className={`flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-semibold transition ${
                    draftStatus === o.id
                      ? 'border-theme-accent/50 bg-theme-accent/10 text-theme-text'
                      : 'border-theme-border text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                  }`}
                >
                  {draftStatus === o.id && <Check className="h-3 w-3" />}
                  {o.label}
                </button>
              ))}
            </div>
          )}

          {open === 'historial' && (
            <div className="flex flex-wrap gap-1">
              <span className="flex h-7 items-center px-1 text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted/70">Análisis por semanas</span>
              {historialOptions.map(o => (
                <button
                  key={o.id}
                  onClick={() => { onSelectHistorial(o.id); setOpen(null) }}
                  className={`flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-semibold transition ${
                    historialVisible === o.id
                      ? 'border-theme-accent/50 bg-theme-accent/10 text-theme-text'
                      : 'border-theme-border text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                  }`}
                >
                  {historialVisible === o.id && <Check className="h-3 w-3" />}
                  {o.label}
                </button>
              ))}
            </div>
          )}

          {open === 'proveedor' && (
            <div className="max-h-[320px] overflow-y-auto overscroll-contain">
              {filteredSuppliers.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-theme-text-muted">Sin resultados</p>
              ) : (
                filteredSuppliers.map(s => (
                  <button key={s} onClick={() => selectSupplier(s)} className={optionRowClass}>
                    {draftSupplier === s && <Check className="h-3 w-3 shrink-0 text-theme-accent" />}
                    <span className="truncate">{s}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {open === 'linea' && (
            <div className="max-h-[320px] overflow-y-auto overscroll-contain">
              {filteredLines.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-theme-text-muted">
                  {lineOptions.length === 0 ? 'Sin líneas disponibles' : 'Sin resultados'}
                </p>
              ) : (
                filteredLines.map(l => (
                  <button key={l} onClick={() => selectLine(l)} className={optionRowClass}>
                    {draftLine === l && <Check className="h-3 w-3 shrink-0 text-theme-accent" />}
                    <span className="truncate">{l}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
