'use client'

import { useState, useEffect } from 'react'
import { KpiCard } from '../components/kpi-card'
import { getCommercialAnalysisOverview } from '@/app/actions/comercial/analysis'
import { useDateRange } from '../hooks/use-date-range'
import * as LucideIcons from 'lucide-react'

interface OverviewData {
  netSales: number
  grossSales: number
  ncNet: number
  netSalesAfterNC: number
  totalUnits: number
  uniqueClients: number
  productsSold: number
  suppliersWithSales: number
  stockUnits: number
  stockValue: number
  topSuppliers: Array<{ supplier_id: string; business_name: string; net_sales: number; units: number }>
  topProducts: Array<{ sku: string; quantity: number; net_sales: number }>
  topClients: Array<{ client_id: number; client_name: string; net_sales: number; units: number; invoice_count: number }>
  stockValProducts: Array<{ sku: string; stock_qty: number; stock_value: number }>
  metadata: {
    source: string
    ncSource: string
    documentType: string
    includesNC: boolean
    ncIncludedInNet: boolean
    dateMin: string
    dateMax: string
    dateFrom: string
    dateTo: string
    totalDocs5: number
    totalDocsNC: number
  }
}

function fmt(num: number): string {
  if (num >= 1_000_000) return '$' + (num / 1_000_000).toFixed(1) + 'M'
  if (num >= 1_000) return '$' + (num / 1_000).toFixed(1) + 'K'
  return '$' + num.toLocaleString('es-CL')
}

function fmtNum(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K'
  return num.toLocaleString('es-CL')
}

function fmtDate(d: string): string {
  if (!d) return '—'
  const parts = d.split('-')
  if (parts.length !== 3) return d
  return `${parts[2]}/${parts[1]}/${parts[0]}`
}

export function VistaGeneral() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const { dateFrom, dateTo } = useDateRange()

  useEffect(() => {
    getCommercialAnalysisOverview({ dateFrom, dateTo }).then(d => {
      setData(d as unknown as OverviewData)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [dateFrom, dateTo])

  const meta = data?.metadata

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-base font-bold text-theme-text">Vista general</h1>
          <p className="text-xs text-theme-text-muted/70">
            Resumen comercial consolidado · datos reales Bsale
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {meta && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-theme-accent/10 border border-theme-accent/15">
              <LucideIcons.Database className="h-3 w-3 text-theme-accent" />
              <span className="text-[10px] font-semibold text-theme-text truncate max-w-[200px]">
                FE tipo 5 · {fmtNum(meta.totalDocs5)} facturas
              </span>
            </div>
          )}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <LucideIcons.AlertTriangle className="h-3 w-3 text-amber-500" />
            <span className="text-[10px] font-semibold text-amber-600/80 whitespace-nowrap">
              Recepciones Bsale pendientes
            </span>
          </div>
        </div>
      </div>

      {meta && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-theme-text-muted/70">
          <span className="flex items-center gap-1">
            <LucideIcons.CalendarDays className="h-3 w-3" />
            Período: {fmtDate(meta.dateMin)} al {fmtDate(meta.dateMax)}
          </span>
          <span className="flex items-center gap-1">
            <LucideIcons.FileText className="h-3 w-3" />
            Documento: Factura Electrónica tipo 5
          </span>
          <span className="flex items-center gap-1">
            <LucideIcons.Info className="h-3 w-3" />
            NC tipo 2 descontadas en Neto - NC ({fmtNum(meta.totalDocsNC)} NC por ${fmtNum(data?.ncNet || 0)})
          </span>
          <span className="text-theme-text-muted/40">|</span>
          <span className="text-theme-text-muted/50">Datos reales Bsale · dataset completo</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Ventas netas FE" value={data ? fmt(data.netSales) : '—'} subtitle={`Neto - NC: ${data ? fmt(data.netSalesAfterNC) : '—'}`} icon="TrendingUp" accent loading={loading} />
        <KpiCard title="Unidades vendidas" value={data ? fmtNum(data.totalUnits) : '—'} subtitle="Total unidades" icon="ShoppingCart" loading={loading} />
        <KpiCard title="Clientes compradores" value={data ? fmtNum(data.uniqueClients) : '—'} subtitle="Únicos en el período" icon="Users" loading={loading} />
        <KpiCard title="Productos vendidos" value={data ? fmtNum(data.productsSold) : '—'} subtitle="SKU distintos" icon="Package" loading={loading} />
        <KpiCard title="Proveedores con ventas" value={data ? fmtNum(data.suppliersWithSales) : '—'} subtitle="Reales PetGroup" icon="Truck" loading={loading} />
        <KpiCard title="Stock actual" value={data ? fmtNum(data.stockUnits) : '—'} subtitle={`Valorizado: ${data ? fmt(data.stockValue) : '—'}`} icon="Warehouse" loading={loading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        <div className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
          <h3 className="text-xs font-bold text-theme-text mb-3 uppercase tracking-wider flex items-center gap-1.5">
            <LucideIcons.Truck className="h-3.5 w-3.5 text-theme-accent" /> Top 5 proveedores
          </h3>
          {loading ? (
            <div className="space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="h-8 rounded bg-theme-text/5 animate-pulse" />)}</div>
          ) : data?.topSuppliers?.length ? (
            <div className="space-y-1">
              {data.topSuppliers.map((s, i) => (
                <div key={s.supplier_id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-theme-surface-hover transition-colors">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-bold text-theme-text-muted/50 w-4 shrink-0">#{i + 1}</span>
                    <span className="text-xs font-medium text-theme-text truncate">{s.business_name}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-xs font-semibold text-theme-text-accent">{fmt(s.net_sales)}</span>
                    <span className="text-[10px] text-theme-text-muted/60 ml-2">{fmtNum(s.units)} uds</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-theme-text-muted/50">Sin datos disponibles</p>}
        </div>

        <div className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
          <h3 className="text-xs font-bold text-theme-text mb-3 uppercase tracking-wider flex items-center gap-1.5">
            <LucideIcons.Package className="h-3.5 w-3.5 text-theme-accent" /> Top 5 productos
          </h3>
          {loading ? (
            <div className="space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="h-8 rounded bg-theme-text/5 animate-pulse" />)}</div>
          ) : data?.topProducts?.length ? (
            <div className="space-y-1">
              {data.topProducts.map((p, i) => (
                <div key={p.sku} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-theme-surface-hover transition-colors">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-bold text-theme-text-muted/50 w-4 shrink-0">#{i + 1}</span>
                    <span className="text-xs font-mono font-medium text-theme-text truncate">{p.sku}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-xs font-semibold text-theme-text">{fmt(p.net_sales)}</span>
                    <span className="text-[10px] text-theme-text-muted/60 ml-2">{fmtNum(p.quantity)} uds</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-theme-text-muted/50">Sin datos disponibles</p>}
        </div>

        <div className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
          <h3 className="text-xs font-bold text-theme-text mb-3 uppercase tracking-wider flex items-center gap-1.5">
            <LucideIcons.Users className="h-3.5 w-3.5 text-theme-accent" /> Top 5 clientes
          </h3>
          {loading ? (
            <div className="space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="h-8 rounded bg-theme-text/5 animate-pulse" />)}</div>
          ) : data?.topClients?.length ? (
            <div className="space-y-1">
              {data.topClients.map((c, i) => (
                <div key={c.client_id} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-theme-surface-hover transition-colors">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-bold text-theme-text-muted/50 w-4 shrink-0">#{i + 1}</span>
                    <span className="text-xs font-medium text-theme-text truncate">{c.client_name}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-xs font-semibold text-theme-text-accent">{fmt(c.net_sales)}</span>
                    <span className="text-[10px] text-theme-text-muted/60 ml-2">{c.invoice_count} facturas</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-theme-text-muted/50">Sin datos disponibles</p>}
        </div>
      </div>

      {data?.stockValProducts?.length ? (
        <div className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
          <h3 className="text-xs font-bold text-theme-text mb-3 uppercase tracking-wider flex items-center gap-1.5">
            <LucideIcons.Banknote className="h-3.5 w-3.5 text-theme-accent" /> Productos con mayor stock valorizado
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-theme-border/40">
                  <th className="text-left py-2 px-3 font-semibold text-theme-text-muted/70">SKU</th>
                  <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Stock</th>
                  <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Valorizado</th>
                </tr>
              </thead>
              <tbody>
                {data.stockValProducts.map(p => (
                  <tr key={p.sku} className="border-b border-theme-border/20 hover:bg-theme-surface-hover/50 transition-colors">
                    <td className="py-2 px-3 font-mono font-medium text-theme-text">{p.sku}</td>
                    <td className="py-2 px-3 text-right font-medium text-theme-text">{fmtNum(p.stock_qty)}</td>
                    <td className="py-2 px-3 text-right font-semibold text-theme-text-accent">{fmt(p.stock_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}
