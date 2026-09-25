'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarRange, Check, ChevronDown, Filter, Loader2, RefreshCw, Search, Settings2, X } from 'lucide-react'
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
  headerDisabled: boolean
  onBack?: () => void
  onRefresh: () => void
}

type OpenMenu = 'estado' | 'historial' | 'proveedor' | 'linea' | null

const STATUS_OPTIONS = [
  { id: 'TODOS', label: 'Todos' },
  { id: 'REPONER', label: 'A reponer' },
  { id: 'CRITICO', label: 'Críticos' },
  { id: 'SIN_COSTO', label: 'Sin costo' },
]

const inputClass =
  'h-[30px] rounded border border-[#D1C7BD] bg-[#EFE9E1]/70 px-2 text-xs text-[#322D29] outline-none transition placeholder:text-[#AC9C8D]/70 focus:border-[#72383D] focus:ring-2 focus:ring-[#72383D]/15 disabled:cursor-not-allowed disabled:opacity-60'
const triggerClass =
  'flex h-[30px] shrink-0 items-center gap-1 rounded border px-2 text-xs font-semibold transition'
const optionRowClass =
  'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs font-medium text-[#322D29] transition hover:bg-[#D1C7BD]/35'
const filterLabelClass = 'block text-[9px] font-bold uppercase tracking-[0.08em] text-[#AC9C8D] leading-none mb-[3px]'

/** Celda de filtro: label encima + control debajo */
function FilterCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className={filterLabelClass}>{label}</span>
      {children}
    </div>
  )
}

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
  headerDisabled,
  onBack,
  onRefresh,
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
    <div ref={rootRef} className="shrink-0 border-b border-[#D1C7BD] bg-[#EFE9E1]">

      {/* ═══════════════════════════════════════════════════════════
          TOOLBAR 1 — PARÁMETROS DE REPOSICIÓN
          Grid explícito: label ENCIMA del control en cada celda.
          Desktop xl+: una línea.
          Desktop lg: puede hacer wrap controlado (2 líneas).
          Mobile: columnas apiladas.
      ═══════════════════════════════════════════════════════════ */}
      <div className="border-b border-[#D1C7BD] px-4 py-1.5">
        <div
          className="grid items-end gap-x-3 gap-y-2"
          style={{
            gridTemplateColumns:
              'clamp(110px,150px,170px) 128px 104px minmax(140px,1fr) minmax(130px,1fr) minmax(145px,1fr) 108px 68px auto',
          }}
        >
          {/* ── Título ── */}
          <div className="flex items-end pb-[3px]">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#72383D] leading-tight">
              Parámetros{'\u00A0'}de<br />reposición
            </span>
          </div>

          {/* ── PERÍODO ── */}
          <FilterCell label="Período de análisis">
            <select
              id="replenishment-period"
              aria-label="Período de análisis"
              value={draftPeriodIdx}
              onChange={e => onDraftPeriodChange(Number(e.target.value))}
              className={`${inputClass} w-full cursor-pointer`}
            >
              {periodOptions.map((o, i) => (
                <option key={i} value={i}>{o.label}</option>
              ))}
            </select>
          </FilterCell>

          {/* ── COBERTURA ── */}
          <FilterCell label="Cobertura objetivo">
            <select
              id="replenishment-coverage"
              aria-label="Cobertura objetivo"
              value={draftCoverageIdx}
              onChange={e => onDraftCoverageChange(Number(e.target.value))}
              className={`${inputClass} w-full cursor-pointer`}
            >
              {coverageOptions.map((o, i) => (
                <option key={i} value={i}>{o.label}</option>
              ))}
            </select>
          </FilterCell>

          {/* ── PROVEEDOR ── */}
          <FilterCell label="Proveedor">
            <div className="relative w-full">
              <input
                id="replenishment-supplier"
                aria-label="Proveedor"
                value={open === 'proveedor' ? proveedorQuery : draftSupplier}
                onChange={e => { setProveedorQuery(e.target.value); setOpen('proveedor') }}
                onFocus={() => { setProveedorQuery(draftSupplier); setOpen('proveedor') }}
                placeholder={initialLoading ? 'Cargando...' : 'Proveedor...'}
                disabled={initialLoading}
                className={`${inputClass} w-full pr-6`}
              />
              {!initialLoading && draftSupplier && (
                <button
                  onClick={clearSupplier}
                  aria-label="Limpiar proveedor"
                  className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[#AC9C8D] transition hover:bg-[#D1C7BD]/40 hover:text-[#72383D]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </FilterCell>

          {/* ── LÍNEA ── */}
          <FilterCell label="Línea de artículos">
            <div className="relative w-full">
              <input
                id="replenishment-line"
                aria-label="Línea de artículos"
                value={open === 'linea' ? lineaQuery : draftLine}
                onChange={e => { setLineaQuery(e.target.value); setOpen('linea') }}
                onFocus={() => { setLineaQuery(draftLine); setOpen('linea') }}
                placeholder={initialLoading ? 'Cargando...' : 'Línea...'}
                disabled={initialLoading}
                className={`${inputClass} w-full pr-6`}
              />
              {!initialLoading && draftLine && (
                <button
                  onClick={clearLine}
                  aria-label="Limpiar línea de artículos"
                  className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[#AC9C8D] transition hover:bg-[#D1C7BD]/40 hover:text-[#72383D]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </FilterCell>

          {/* ── SKU / PRODUCTO ── */}
          <FilterCell label="SKU / Producto">
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-[#AC9C8D]/60" />
              <input
                id="replenishment-search"
                aria-label="Buscar SKU o producto"
                type="text"
                value={draftSearch}
                onChange={e => onDraftSearchChange(e.target.value)}
                placeholder="Buscar..."
                disabled={initialLoading}
                className={`${inputClass} w-full pl-5 pr-6`}
              />
              {!initialLoading && draftSearch !== '' && (
                <button
                  onClick={clearSearch}
                  aria-label="Limpiar búsqueda"
                  className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[#AC9C8D] transition hover:bg-[#D1C7BD]/40 hover:text-[#72383D]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </FilterCell>

          {/* ── ESTADO ── */}
          <FilterCell label="Estado">
            <button
              onClick={() => setOpen(prev => (prev === 'estado' ? null : 'estado'))}
              aria-expanded={open === 'estado'}
              className={`${triggerClass} w-full justify-between ${
                open === 'estado' || hasStatus
                  ? 'border-[#72383D]/50 bg-[#72383D]/10 text-[#72383D]'
                  : 'border-[#D1C7BD] bg-[#EFE9E1]/70 text-[#AC9C8D] hover:bg-[#D1C7BD]/40 hover:text-[#322D29]'
              }`}
            >
              <span className="flex items-center gap-1 min-w-0">
                <Filter className="h-3 w-3 shrink-0" />
                <span className="truncate text-[11px]">{statusLabel}</span>
              </span>
              <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open === 'estado' ? 'rotate-180' : ''}`} />
            </button>
          </FilterCell>

          {/* ── PRODUCTOS (checkbox Todos) ── */}
          <FilterCell label="Productos">
            <label className="flex h-[30px] cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-[#322D29]">
              <input
                type="checkbox"
                checked={draftShowAll}
                onChange={e => onDraftShowAllChange(e.target.checked)}
                disabled={initialLoading}
                className="h-3.5 w-3.5 rounded border-[#D1C7BD] text-[#72383D] disabled:cursor-not-allowed disabled:opacity-60"
              />
              Todos
            </label>
          </FilterCell>

          {/* ── ACTUALIZAR — siempre al extremo derecho ── */}
          <div className="flex items-end">
            <button
              onClick={onRefresh}
              disabled={headerDisabled}
              title={headerDisabled && !busy ? 'Aplica una consulta antes de actualizar' : undefined}
              className="flex h-[30px] shrink-0 items-center gap-1.5 rounded border border-[#D1C7BD] bg-[#EFE9E1] px-3 text-xs font-semibold text-[#72383D] whitespace-nowrap transition hover:border-[#72383D]/50 hover:bg-[#D1C7BD]/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Actualizar
            </button>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          TOOLBAR 2 — VISTA Y ANÁLISIS
          Franja compacta que aprovecha el ancho completo.
      ═══════════════════════════════════════════════════════════ */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 px-4 py-1.5">
        {/* Título */}
        <div className="flex items-end pb-[3px]">
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#72383D] leading-tight whitespace-nowrap">
            Vista y análisis
          </span>
        </div>

        {/* VISTA — botones segmentados */}
        <FilterCell label="Vista">
          <div
            className="flex h-[30px] items-center gap-0.5 rounded border border-[#D1C7BD] bg-[#D1C7BD]/35 p-0.5"
            role="group"
            aria-label="Vista de análisis"
          >
            {VIEWS.map(v => (
              <button
                key={v.id}
                onClick={() => onSelectView(v.id)}
                className={`flex h-[22px] items-center rounded px-2.5 text-[11px] font-semibold transition ${
                  viewLabel === v.label
                    ? 'bg-[#72383D] text-white'
                    : 'text-[#AC9C8D] hover:bg-[#D1C7BD]/50 hover:text-[#322D29]'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </FilterCell>

        {viewLabel === 'Personalizada' && (
          <span className="mb-0.5 inline-flex shrink-0 self-end items-center rounded-full border border-[#D1C7BD] bg-[#D1C7BD]/35 px-2 py-0.5 text-[10px] font-semibold text-[#AC9C8D]">
            Personalizada
          </span>
        )}

        {/* DETALLE TEMPORAL */}
        <FilterCell label="Detalle temporal">
          <button
            onClick={() => setOpen(prev => (prev === 'historial' ? null : 'historial'))}
            aria-expanded={open === 'historial'}
            title="Análisis por semanas"
            className={`${triggerClass} ${
              open === 'historial'
                ? 'border-[#72383D]/50 bg-[#72383D]/10 text-[#72383D]'
                : 'border-[#D1C7BD] bg-[#EFE9E1]/70 text-[#AC9C8D] hover:bg-[#D1C7BD]/40 hover:text-[#322D29]'
            }`}
          >
            <CalendarRange className="h-3 w-3 shrink-0" />
            <span className="truncate max-w-[170px] text-[11px]">
              Análisis por semanas · {historialVisible === 'Oculto' ? 'Oculto' : historialVisible}
            </span>
            <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open === 'historial' ? 'rotate-180' : ''}`} />
          </button>
        </FilterCell>

        {/* CONFIGURACIÓN */}
        <div className="flex items-end">
          <button
            onClick={onOpenConfig}
            title="Configuración de columnas"
            className="flex h-[30px] shrink-0 items-center gap-1 rounded border border-[#D1C7BD] bg-[#EFE9E1]/70 px-2 text-xs font-semibold text-[#AC9C8D] transition hover:border-[#72383D]/40 hover:text-[#72383D]"
          >
            <Settings2 className="h-3 w-3" />
            Configuración
          </button>
        </div>

        {/* Spinner consultando */}
        {busy && (
          <div className="ml-auto flex items-center gap-1.5 self-end pb-0.5">
            <Loader2 className="h-3 w-3 animate-spin text-[#72383D]" />
            <span className="text-[11px] font-semibold text-[#AC9C8D]">Consultando...</span>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════
          PANEL CONTEXTUAL DE DROPDOWNS
          En flujo — empuja la tabla, nunca superpuesto.
      ═══════════════════════════════════════════════════════════ */}
      {open && (
        <div className="border-t border-[#D1C7BD] bg-[#EFE9E1] px-4 py-2">
          {open === 'estado' && (
            <div className="flex flex-wrap gap-1">
              {STATUS_OPTIONS.map(o => (
                <button
                  key={o.id}
                  onClick={() => { onDraftStatusChange(o.id); setOpen(null) }}
                  className={`flex h-7 items-center gap-1 rounded border px-2.5 text-xs font-semibold transition ${
                    draftStatus === o.id
                      ? 'border-[#72383D]/50 bg-[#72383D]/10 text-[#72383D]'
                      : 'border-[#D1C7BD] text-[#AC9C8D] hover:bg-[#D1C7BD]/40 hover:text-[#322D29]'
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
              <span className="flex h-7 items-center px-1 text-[10px] font-semibold uppercase tracking-wide text-[#AC9C8D]/70">
                Análisis por semanas
              </span>
              {historialOptions.map(o => (
                <button
                  key={o.id}
                  onClick={() => { onSelectHistorial(o.id); setOpen(null) }}
                  className={`flex h-7 items-center gap-1 rounded border px-2.5 text-xs font-semibold transition ${
                    historialVisible === o.id
                      ? 'border-[#72383D]/50 bg-[#72383D]/10 text-[#72383D]'
                      : 'border-[#D1C7BD] text-[#AC9C8D] hover:bg-[#D1C7BD]/40 hover:text-[#322D29]'
                  }`}
                >
                  {historialVisible === o.id && <Check className="h-3 w-3" />}
                  {o.label}
                </button>
              ))}
            </div>
          )}

          {open === 'proveedor' && (
            <div className="max-h-[280px] overflow-y-auto overscroll-contain">
              {filteredSuppliers.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-[#AC9C8D]">Sin resultados</p>
              ) : (
                filteredSuppliers.map(s => (
                  <button key={s} onClick={() => selectSupplier(s)} className={optionRowClass}>
                    {draftSupplier === s && <Check className="h-3 w-3 shrink-0 text-[#72383D]" />}
                    <span className="truncate">{s}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {open === 'linea' && (
            <div className="max-h-[280px] overflow-y-auto overscroll-contain">
              {filteredLines.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-[#AC9C8D]">
                  {lineOptions.length === 0 ? 'Sin líneas disponibles' : 'Sin resultados'}
                </p>
              ) : (
                filteredLines.map(l => (
                  <button key={l} onClick={() => selectLine(l)} className={optionRowClass}>
                    {draftLine === l && <Check className="h-3 w-3 shrink-0 text-[#72383D]" />}
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
