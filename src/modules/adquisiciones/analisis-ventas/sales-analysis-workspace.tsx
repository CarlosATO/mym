'use client'

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import {
  FileUp, RefreshCw, BarChart3, TrendingDown, Package, ShoppingCart,
  AlertTriangle, Database, Activity, Search, Loader2, Info, Filter,
} from 'lucide-react'
import * as XLSX from 'xlsx'
import { UploadDataModal } from './components/upload-data-modal'
import { getLatestSalesAnalysisReport } from '@/app/actions/adquisiciones/analisis-ventas'
import { toast } from 'sonner'
import type { NormalizedSale, NormalizedStock, SkuSummary } from './utils/analytics'
import { parseAndNormalizeSales, parseAndNormalizeStock, buildSkuSummary, classifySkus } from './utils/analytics'

// Tabs
import { TabHallazgos } from './components/tab-hallazgos'
import { TabResumen } from './components/tab-resumen'
import { TabPareto } from './components/tab-pareto'
import { TabStockSinVentas } from './components/tab-stock-sin-ventas'
import { TabDemandaSinStock } from './components/tab-demanda-sin-stock'
import { TabQuiebres } from './components/tab-quiebres'
import { TabCaidas } from './components/tab-caidas'
import { TabBase } from './components/tab-base'
import { TabReposicion } from './components/tab-reposicion'

// ─── Tipos ─────────────────────────────────────────────────────────────────────

interface ReportState {
  sales: NormalizedSale[]
  stock: NormalizedStock[]
  skus: SkuSummary[]
  minDate: Date
  maxDate: Date
  diagnostics: Record<string, any>
  loadedAt: string
}

// ─── Tabs del dashboard ────────────────────────────────────────────────────────

const TABS = [
  { id: 'reposicion', label: 'Análisis de reposición', icon: ShoppingCart },
  { id: 'hallazgos', label: 'Hallazgos', icon: AlertTriangle },
  { id: 'resumen', label: 'Resumen Ejecutivo', icon: BarChart3 },
  { id: 'pareto', label: 'Pareto 80/20', icon: Activity },
  { id: 'stock-sin-ventas', label: 'Stock sin ventas', icon: Package },
  { id: 'demanda-sin-stock', label: 'Demanda sin stock', icon: TrendingDown },
  { id: 'quiebres', label: 'Quiebres de stock', icon: AlertTriangle },
  { id: 'caidas', label: 'Caídas y crecimiento', icon: TrendingDown },
  { id: 'base', label: 'Base de análisis', icon: Database },
]

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(val: number): string {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(val)
}

/** Reconstruye NormalizedSale[] y NormalizedStock[] desde los items del reporte guardado en Supabase */
function rebuildFromReport(dbReport: any): ReportState | null {
  if (!dbReport?.items?.length) return null
  try {
    // Los datos crudos NO están en Supabase — solo el resumen (SkuSummary).
    // Necesitamos guardar la data cruda en localStorage para re-análisis dinámico.
    const rawSales = getSavedRawData('sales')
    const rawStock = getSavedRawData('stock')
    if (!rawSales || !rawStock) return null

    const { sales, minDate, maxDate } = parseAndNormalizeSales(rawSales)
    const { stock } = parseAndNormalizeStock(rawStock)
    const skuRaw = buildSkuSummary(sales, stock, maxDate, minDate, maxDate)
    const skus = classifySkus(skuRaw)

    return {
      sales, stock, skus, minDate, maxDate,
      diagnostics: dbReport.diagnostics || {},
      loadedAt: dbReport.created_at,
    }
  } catch {
    return null
  }
}

function getSavedRawData(key: 'sales' | 'stock'): any[] | null {
  try {
    const raw = localStorage.getItem(`mym_analytics_raw_${key}`)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function saveRawData(key: 'sales' | 'stock', data: any[]) {
  try {
    localStorage.setItem(`mym_analytics_raw_${key}`, JSON.stringify(data))
  } catch { /* quota exceeded — silently ignore */ }
}

export { saveRawData }

// ─── Componente principal ─────────────────────────────────────────────────────

export function SalesAnalysisWorkspace() {
  const [isLoadingDb, setIsLoadingDb] = useState(true)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('reposicion')
  const [reportState, setReportState] = useState<ReportState | null>(null)
  const [minSalesFilter, setMinSalesFilter] = useState(50000)

  // Filtros globales
  const [catFilter, setCatFilter] = useState('Todas')
  const [brandFilter, setBrandFilter] = useState('Todas')

  // Carga inicial: trae el reporte guardado y reconstruye desde localStorage
  const loadFromDB = useCallback(async () => {
    setIsLoadingDb(true)
    try {
      const res = await getLatestSalesAnalysisReport()
      if (res.success && res.data) {
        const rebuilt = rebuildFromReport(res.data)
        if (rebuilt) {
          setReportState(rebuilt)
        }
      }
    } catch (err) {
      toast.error('Error cargando datos')
    } finally {
      setIsLoadingDb(false)
    }
  }, [])

  useEffect(() => { loadFromDB() }, [loadFromDB])

  // Filtros derivados
  const categories = useMemo(() => {
    if (!reportState) return []
    const set = new Set(reportState.skus.map(s => s.tipo_producto).filter(Boolean))
    return ['Todas', ...Array.from(set).sort()]
  }, [reportState])

  const brands = useMemo(() => {
    if (!reportState) return []
    const set = new Set(reportState.skus.map(s => s.marca).filter(Boolean))
    return ['Todas', ...Array.from(set).sort()]
  }, [reportState])

  const filteredSales = useMemo(() => {
    if (!reportState) return []
    return reportState.sales.filter(s => {
      const matchCat = catFilter === 'Todas' || s.tipo_producto === catFilter
      const matchBrand = brandFilter === 'Todas' || s.marca === brandFilter
      return matchCat && matchBrand
    })
  }, [reportState, catFilter, brandFilter])

  const filteredStock = useMemo(() => {
    if (!reportState) return []
    return reportState.stock.filter(s => {
      const matchCat = catFilter === 'Todas' || s.tipo_producto === catFilter
      const matchBrand = brandFilter === 'Todas' || s.marca === brandFilter
      return matchCat && matchBrand
    })
  }, [reportState, catFilter, brandFilter])

  const filteredSkus = useMemo(() => {
    if (!reportState) return []
    return reportState.skus.filter(s => {
      const matchCat = catFilter === 'Todas' || s.tipo_producto === catFilter
      const matchBrand = brandFilter === 'Todas' || s.marca === brandFilter
      return matchCat && matchBrand
    })
  }, [reportState, catFilter, brandFilter])

  // ── Render: pantalla de carga ──
  if (isLoadingDb) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-theme-primary" />
          <p className="text-sm text-theme-text-muted">Cargando datos del análisis...</p>
        </div>
      </div>
    )
  }

  // ── Render: sin datos ──
  if (!reportState) {
    return (
      <>
        <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
          <div className="flex flex-col items-center gap-3 text-center max-w-md">
            <div className="p-4 rounded-full bg-theme-primary/10 border border-theme-primary/20">
              <BarChart3 className="h-10 w-10 text-theme-primary" />
            </div>
            <h2 className="text-xl font-bold text-theme-text">Dashboard de Análisis Comercial</h2>
            <p className="text-sm text-theme-text-muted leading-relaxed">
              Carga los archivos de ventas y stock exportados desde Bsale para iniciar el análisis de reposición, hallazgos ejecutivos, Pareto, quiebres y más.
            </p>
          </div>
          <Button onClick={() => setIsModalOpen(true)} className="gap-2 h-11 px-6 text-sm font-bold">
            <FileUp className="h-4 w-4" />
            Cargar Archivos y Generar Análisis
          </Button>
        </div>
        <UploadDataModal
          open={isModalOpen}
          onOpenChange={setIsModalOpen}
          onSuccess={loadFromDB}
        />
      </>
    )
  }

  const { minDate, maxDate, diagnostics, loadedAt } = reportState
  const formattedLoadedAt = loadedAt ? new Date(loadedAt).toLocaleString('es-CL') : '-'

  // ── Render: con datos ──
  return (
    <div className="flex h-full flex-col gap-0 animate-in fade-in duration-300">
      {/* Header del dashboard */}
      <div className="shrink-0 border-b border-theme-border bg-theme-surface/80 backdrop-blur-sm px-4 py-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-theme-text">Dashboard Comercial MYM</h2>
            <div className="flex flex-wrap gap-3 text-xs text-theme-text-muted mt-0.5">
              <span>Ventas: <strong className="text-theme-text">{minDate.toLocaleDateString('es-CL')} → {maxDate.toLocaleDateString('es-CL')}</strong></span>
              <span>Actualizado: <strong className="text-theme-text">{formattedLoadedAt}</strong></span>
              {diagnostics?.skus_sold && <span>SKU vendidos: <strong className="text-theme-text">{diagnostics.skus_sold}</strong></span>}
              {diagnostics?.sales_rows && <span>Filas ventas: <strong className="text-theme-text">{diagnostics.sales_rows.toLocaleString('es-CL')}</strong></span>}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={loadFromDB} className="gap-1.5 text-xs">
              <RefreshCw className="h-3.5 w-3.5" /> Actualizar
            </Button>
            <Button size="sm" onClick={() => setIsModalOpen(true)} className="gap-1.5 text-xs">
              <FileUp className="h-3.5 w-3.5" /> Cargar Nuevos Datos
            </Button>
          </div>
        </div>

        {/* Filtros globales */}
        <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t border-theme-border/50">
          <Filter className="h-3.5 w-3.5 text-theme-text-muted shrink-0" />
          <span className="text-xs font-semibold text-theme-text-muted">Filtros:</span>
          <select
            className="h-7 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-primary"
            value={catFilter} onChange={e => setCatFilter(e.target.value)}
          >
            {categories.map(c => <option key={c} value={c}>{c === 'Todas' ? `Categoría (${categories.length - 1})` : c}</option>)}
          </select>
          <select
            className="h-7 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-primary"
            value={brandFilter} onChange={e => setBrandFilter(e.target.value)}
          >
            {brands.map(b => <option key={b} value={b}>{b === 'Todas' ? `Marca (${brands.length - 1})` : b}</option>)}
          </select>
          <div className="flex items-center gap-1.5 ml-2">
            <span className="text-xs text-theme-text-muted">Venta mín. ranking:</span>
            <input
              type="number" value={minSalesFilter} onChange={e => setMinSalesFilter(Number(e.target.value))}
              className="h-7 w-24 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-primary"
            />
          </div>
        </div>
      </div>

      {/* Barra de tabs */}
      <div className="shrink-0 border-b border-theme-border bg-theme-surface/60 overflow-x-auto">
        <nav className="flex gap-0 min-w-max">
          {TABS.map(tab => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold border-b-2 whitespace-nowrap transition-all ${
                  activeTab === tab.id
                    ? 'border-theme-primary text-theme-primary bg-theme-primary/8'
                    : 'border-transparent text-theme-text-muted hover:text-theme-text hover:border-theme-border'
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {tab.label}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Contenido del tab */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {activeTab === 'reposicion' && (
          <TabReposicion allSales={filteredSales} allStock={filteredStock} globalMaxDate={maxDate} globalMinDate={minDate} />
        )}
        {activeTab === 'hallazgos' && (
          <TabHallazgos allSales={filteredSales} allStock={filteredStock} globalMaxDate={maxDate} globalMinDate={minDate} minSalesFilter={minSalesFilter} />
        )}
        {activeTab === 'resumen' && (
          <TabResumen allSales={filteredSales} allStock={filteredStock} globalMaxDate={maxDate} globalMinDate={minDate} />
        )}
        {activeTab === 'pareto' && (
          <TabPareto allSales={filteredSales} allStock={filteredStock} globalMaxDate={maxDate} globalMinDate={minDate} />
        )}
        {activeTab === 'stock-sin-ventas' && (
          <TabStockSinVentas allSales={filteredSales} allStock={filteredStock} globalMaxDate={maxDate} globalMinDate={minDate} />
        )}
        {activeTab === 'demanda-sin-stock' && (
          <TabDemandaSinStock allSales={filteredSales} allStock={filteredStock} globalMaxDate={maxDate} globalMinDate={minDate} />
        )}
        {activeTab === 'quiebres' && (
          <TabQuiebres allSales={filteredSales} allStock={filteredStock} globalMaxDate={maxDate} globalMinDate={minDate} />
        )}
        {activeTab === 'caidas' && (
          <TabCaidas allSales={filteredSales} allStock={filteredStock} globalMaxDate={maxDate} globalMinDate={minDate} minSalesFilter={minSalesFilter} />
        )}
        {activeTab === 'base' && (
          <TabBase skus={filteredSkus} />
        )}
      </div>

      <UploadDataModal open={isModalOpen} onOpenChange={setIsModalOpen} onSuccess={loadFromDB} />
    </div>
  )
}
