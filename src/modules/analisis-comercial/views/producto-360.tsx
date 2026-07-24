'use client'

import { useState, useEffect } from 'react'
import { KpiCard } from '../components/kpi-card'
import { getProductsForSearch, getProductAnalysisOverview } from '@/app/actions/comercial/analysis'
import * as LucideIcons from 'lucide-react'

interface ClientRow {
  client_id: number
  client_name: string
  net_sales: number
  units: number
}

interface RecentSale {
  date: string
  qty: number
  net: number
}

interface ProductData {
  product: { sku: string; description: string; is_active: boolean }
  realSupplier: { id: string; business_name: string } | null
  pseudoSupplier: { id: string; business_name: string; bsale_product_type_name: string } | null
  unitCost: number
  netSales: number
  totalUnits: number
  avgPrice: number
  marginPercent: number | null
  stockQty: number
  stockAvail: number
  uniqueClients: number
  topClients: ClientRow[]
  recentSales: RecentSale[]
}

function fmt(num: number): string {
  return '$' + Math.round(num).toLocaleString('es-CL')
}

function fmtNum(num: number): string {
  return Math.round(num).toLocaleString('es-CL')
}

export function Producto360() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ sku: string; description: string | null }>>([])
  const [selectedSku, setSelectedSku] = useState('')
  const [data, setData] = useState<ProductData | null>(null)
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (query.length < 2) return
    const timer = setTimeout(() => {
      setSearching(true)
      getProductsForSearch(query).then(r => {
        setResults(r || [])
        setSearching(false)
      }).catch(() => setSearching(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  const loadProduct = (sku: string) => {
    if (!sku) { setData(null); return }
    setLoading(true)
    getProductAnalysisOverview({ sku }).then(d => {
      setData(d as unknown as ProductData)
      setLoading(false)
    }).catch(() => setLoading(false))
  }

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div>
        <h1 className="text-base font-bold text-theme-text">Producto 360</h1>
        <p className="text-xs text-theme-text-muted/70">
          Análisis por SKU/producto · ventas · stock · margen
        </p>
      </div>

      <div className="relative">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-theme-border bg-theme-surface/60 focus-within:border-theme-accent/50 transition-colors">
          <LucideIcons.Search className="h-3.5 w-3.5 text-theme-text-muted/60 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar por SKU o nombre de producto..."
            className="flex-1 bg-transparent text-xs text-theme-text placeholder:text-theme-text-muted/40 outline-none"
          />
          {searching && <LucideIcons.Loader2 className="h-3 w-3 animate-spin text-theme-text-muted/40" />}
          {selectedSku && (
            <button onClick={() => { setSelectedSku(''); setQuery(''); setResults([]); setData(null) }} className="text-theme-text-muted/40 hover:text-theme-text transition-colors">
              <LucideIcons.X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {query.length >= 2 && results.length > 0 && !selectedSku && (
          <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-theme-border bg-theme-surface shadow-xl z-10 max-h-60 overflow-y-auto">
            {results.map(p => (
              <button
                key={p.sku}
                onClick={() => { setSelectedSku(p.sku); setQuery(`${p.sku} — ${p.description || ''}`); setResults([]); loadProduct(p.sku) }}
                className="w-full text-left px-3 py-2 text-xs text-theme-text hover:bg-theme-surface-hover transition-colors flex items-center gap-2 border-b border-theme-border/20 last:border-0"
              >
                <span className="font-mono font-medium text-theme-text-accent">{p.sku}</span>
                <span className="text-theme-text-muted truncate">{p.description || ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!selectedSku ? (
        <div className="rounded-xl border border-theme-border bg-theme-surface/40 p-8 text-center">
          <p className="text-sm text-theme-text-muted/60">
            Busque un producto por SKU o nombre para ver su análisis.
          </p>
        </div>
      ) : (
        <>
          {data && (
            <>
              <div className="rounded-xl border border-theme-border bg-theme-surface/60 p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-theme-text">{data.product?.sku}</span>
                  {data.product?.description && (
                    <span className="text-xs text-theme-text-muted truncate">— {data.product.description}</span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[11px]">
                  {data.realSupplier && (
                    <span className="text-theme-text-muted">
                      Proveedor real: <strong className="text-theme-text">{data.realSupplier.business_name}</strong>
                    </span>
                  )}
                  {data.pseudoSupplier && (
                    <span className="text-theme-text-muted">
                      Pseudoproveedor: <strong className="text-theme-text">{data.pseudoSupplier.business_name || data.pseudoSupplier.bsale_product_type_name}</strong>
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KpiCard title="Venta neta" value={fmt(data.netSales)} icon="TrendingUp" accent loading={loading} />
                <KpiCard title="Unidades" value={fmtNum(data.totalUnits)} icon="ShoppingCart" loading={loading} />
                <KpiCard title="Clientes" value={fmtNum(data.uniqueClients)} icon="Users" loading={loading} />
                <KpiCard title="Precio prom." value={fmt(data.avgPrice)} icon="Tag" loading={loading} />
                <KpiCard title="Stock actual" value={fmtNum(data.stockQty)} subtitle={`Disponible: ${fmtNum(data.stockAvail)}`} icon="Package" loading={loading} />
                <KpiCard title="Costo unitario" value={fmt(data.unitCost)} icon="Banknote" loading={loading} />
                <KpiCard title="Margen estimado" value={data.marginPercent !== null ? `${data.marginPercent}%` : '—'} icon="Percent" accent={!!(data.marginPercent !== null && data.marginPercent > 0)} loading={loading} />
              </div>

              {data.topClients?.length > 0 && (
                <div className="rounded-xl border border-theme-border bg-theme-surface/60">
                  <div className="px-4 py-3 border-b border-theme-border/60">
                    <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider">Top clientes</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-theme-border/40">
                          <th className="text-left py-2 px-3 font-semibold text-theme-text-muted/70">Cliente</th>
                          <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Venta neta</th>
                          <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Unidades</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.topClients.map(c => (
                          <tr key={c.client_id} className="border-b border-theme-border/20 hover:bg-theme-surface-hover/50 transition-colors">
                            <td className="py-2 px-3 text-theme-text truncate max-w-[200px]">{c.client_name}</td>
                            <td className="py-2 px-3 text-right font-semibold text-theme-text-accent">{fmt(c.net_sales)}</td>
                            <td className="py-2 px-3 text-right font-medium text-theme-text">{fmtNum(c.units)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {data.recentSales?.length > 0 && (
                <div className="rounded-xl border border-theme-border bg-theme-surface/60">
                  <div className="px-4 py-3 border-b border-theme-border/60">
                    <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider">Últimas ventas</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-theme-border/40">
                          <th className="text-left py-2 px-3 font-semibold text-theme-text-muted/70">Fecha</th>
                          <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Unidades</th>
                          <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Neto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recentSales.slice(0, 15).map((s, i) => (
                          <tr key={i} className="border-b border-theme-border/20 hover:bg-theme-surface-hover/50 transition-colors">
                            <td className="py-2 px-3 text-theme-text-muted">{s.date}</td>
                            <td className="py-2 px-3 text-right font-medium text-theme-text">{s.qty}</td>
                            <td className="py-2 px-3 text-right font-semibold text-theme-text-accent">{fmt(s.net)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
