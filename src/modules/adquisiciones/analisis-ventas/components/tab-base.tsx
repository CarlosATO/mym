'use client'
// tab-base.tsx — Base de análisis completa (port de base.py)
import React, { useState, useMemo } from 'react'
import type { SkuSummary } from '../utils/analytics'
import { fmtMoney, fmtPct, fmtDate, DataTable } from './tab-shared'

interface Props { skus: SkuSummary[] }

const ALERT_COLORS: Record<string, string> = {
  'Producto muerto con stock': 'bg-red-500/20 text-red-500',
  'Demanda histórica sin stock': 'bg-amber-500/20 text-amber-600',
  'Quiebre crítico': 'bg-red-600/20 text-red-600',
  'Riesgo de quiebre': 'bg-orange-500/20 text-orange-500',
  'Venta en caída con stock': 'bg-orange-400/20 text-orange-400',
  'Producto en crecimiento': 'bg-green-500/20 text-green-500',
  'Normal': 'bg-theme-text/10 text-theme-text-muted',
}

export function TabBase({ skus }: Props) {
  const [search, setSearch] = useState('')
  const [alertFilter, setAlertFilter] = useState('Todos')

  const alertCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const s of skus) counts[s.alerta] = (counts[s.alerta] || 0) + 1
    return counts
  }, [skus])

  const filtered = useMemo(() =>
    skus.filter(s => {
      const matchSearch = !search || s.SKU.toLowerCase().includes(search.toLowerCase()) || s.producto.toLowerCase().includes(search.toLowerCase())
      const matchAlert = alertFilter === 'Todos' || s.alerta === alertFilter
      return matchSearch && matchAlert
    }).sort((a, b) => b.venta_6m - a.venta_6m)
  , [skus, search, alertFilter])

  const skuWithIdx = useMemo(() => filtered.map((s, i) => ({ ...s, ranking: i + 1 })), [filtered])

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          placeholder="Buscar por SKU o producto..."
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="flex-1 h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text placeholder:text-theme-text-muted focus:outline-none focus:ring-2 focus:ring-theme-primary"
        />
        <select
          value={alertFilter} onChange={(e) => setAlertFilter(e.target.value)}
          className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-primary"
        >
          <option value="Todos">Todas las alertas ({skus.length})</option>
          {Object.entries(alertCounts).map(([k, v]) => (
            <option key={k} value={k}>{k} ({v})</option>
          ))}
        </select>
      </div>
      <p className="text-xs text-theme-text-muted">Mostrando {filtered.length} de {skus.length} productos</p>

      <div className="border border-theme-border bg-theme-surface/70 rounded-xl overflow-hidden">
        <DataTable
          rows={skuWithIdx}
          columns={[
            { key: 'ranking', label: '#' },
            { key: 'SKU', label: 'SKU' },
            { key: 'producto', label: 'Producto' },
            { key: 'variante', label: 'Variante' },
            { key: 'marca', label: 'Marca' },
            { key: 'tipo_producto', label: 'Categoría' },
            { key: 'venta_6m', label: 'Venta período', fmt: fmtMoney, right: true },
            { key: 'unidades_6m', label: 'Unidades', right: true },
            { key: 'cantidad_disponible', label: 'Stock', right: true },
            { key: 'valor_stock_disponible', label: 'Valor Stock', fmt: fmtMoney, right: true },
            { key: 'dias_cobertura', label: 'Días cob.', right: true, fmt: v => v != null ? v.toFixed(1) : '-' },
            { key: 'suggested_quantity', label: 'Compra sugerida', right: true, className: 'text-theme-primary font-bold' },
            {
              key: 'alerta', label: 'Alerta',
              fmt: (v: string) => (
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${ALERT_COLORS[v] || ALERT_COLORS['Normal']}`}>{v}</span>
              )
            },
          ]}
          maxRows={300}
        />
      </div>
    </div>
  )
}
