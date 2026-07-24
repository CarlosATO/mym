'use client'

import { useState, useEffect } from 'react'
import { KpiCard } from '../components/kpi-card'
import { getSuppliersForSelector, getSupplierAnalysisOverview } from '@/app/actions/comercial/analysis'
import { useDateRange } from '../hooks/use-date-range'

interface SupplierInfo {
  id: string
  business_name: string
  supplier_kind: string
}

interface ProductRow {
  sku: string
  product_name: string
  pseudo_supplier: string
  units: number
  net_sales: number
  stock: number
  unit_cost: number
  margin_percent: number | null
  last_sale_date: string
}

interface ClientRow {
  client_id: number
  client_name: string
  net_sales: number
  units: number
  invoice_count: number
  last_purchase: string
}

interface SupplierData {
  supplier: SupplierInfo
  netSales: number
  totalUnits: number
  uniqueClients: number
  productsSold: number
  stockUnits: number
  stockValue: number
  topProducts: ProductRow[]
  topClients: ClientRow[]
}

function fmt(num: number): string {
  return '$' + Math.round(num).toLocaleString('es-CL')
}

function fmtNum(num: number): string {
  return Math.round(num).toLocaleString('es-CL')
}

function fmtDate(d: string): string {
  if (!d) return '—'
  const parts = d.split('-')
  if (parts.length !== 3) return d
  return `${parts[2]}/${parts[1]}/${parts[0]}`
}

export function Proveedor360() {
  const [suppliers, setSuppliers] = useState<Array<{ id: string; business_name: string }>>([])
  const [selectedId, setSelectedId] = useState('')
  const [data, setData] = useState<SupplierData | null>(null)
  const [loading, setLoading] = useState(false)
  const { dateFrom, dateTo } = useDateRange()

  useEffect(() => {
    getSuppliersForSelector().then(setSuppliers)
  }, [])

  useEffect(() => {
    if (!selectedId) return
    getSupplierAnalysisOverview({ supplierId: selectedId, dateFrom, dateTo }).then(d => {
      setData(d as unknown as SupplierData)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [selectedId, dateFrom, dateTo])

  return (
    <div className="p-5 lg:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-base font-bold text-theme-text">Proveedor 360</h1>
          <p className="text-xs text-theme-text-muted/70">
            Análisis por proveedor real · ventas · stock · clientes · margen
          </p>
        </div>
        <select
          value={selectedId}
          onChange={e => setSelectedId(e.target.value)}
          className="text-xs rounded-lg border border-theme-border bg-theme-surface px-3 py-1.5 text-theme-text font-medium focus:outline-none focus:ring-1 focus:ring-theme-accent/50 max-w-[300px]"
        >
          <option value="">Seleccionar proveedor real</option>
          {suppliers.map(s => (
            <option key={s.id} value={s.id}>{s.business_name}</option>
          ))}
        </select>
      </div>

      {!selectedId ? (
        <div className="rounded-xl border border-theme-border bg-theme-surface/40 p-8 text-center">
          <p className="text-sm text-theme-text-muted/60">
            Seleccione un proveedor real PetGroup para ver su análisis completo de ventas, stock y clientes.
          </p>
        </div>
      ) : (
        <>
          {data && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiCard title="Venta neta FE" value={fmt(data.netSales)} icon="TrendingUp" accent loading={loading} />
              <KpiCard title="Unidades vendidas" value={fmtNum(data.totalUnits)} icon="ShoppingCart" loading={loading} />
              <KpiCard title="Clientes compradores" value={fmtNum(data.uniqueClients)} icon="Users" loading={loading} />
              <KpiCard title="Productos vendidos" value={fmtNum(data.productsSold)} icon="Package" loading={loading} />
              <KpiCard title="Stock actual" value={fmtNum(data.stockUnits)} subtitle={`Valorizado: ${fmt(data.stockValue)}`} icon="Warehouse" loading={loading} />
            </div>
          )}

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2">
              <span className="text-amber-500 text-sm">⚠</span>
              <p className="text-[11px] text-amber-600/80 font-medium">
                Recepciones/ingresos Bsale aún no sincronizados. La comparación compra vs venta se habilitará cuando exista historial de recepciones.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-theme-border bg-theme-surface/60">
              <div className="px-4 py-3 border-b border-theme-border/60">
                <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider">Productos del proveedor</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-theme-border/40">
                      <th className="text-left py-2 px-3 font-semibold text-theme-text-muted/70">SKU</th>
                      <th className="text-left py-2 px-3 font-semibold text-theme-text-muted/70">Producto</th>
                      <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Venta</th>
                      <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Stock</th>
                      <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Margen</th>
                      <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Últ. venta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.topProducts?.slice(0, 15).map(p => (
                      <tr key={p.sku} className="border-b border-theme-border/20 hover:bg-theme-surface-hover/50 transition-colors">
                        <td className="py-2 px-3 font-mono font-medium text-theme-text">{p.sku}</td>
                        <td className="py-2 px-3 text-theme-text-muted truncate max-w-[140px]">{p.product_name || '—'}</td>
                        <td className="py-2 px-3 text-right font-semibold text-theme-text-accent">{fmt(p.net_sales)}</td>
                        <td className="py-2 px-3 text-right font-medium text-theme-text">{fmtNum(p.stock)}</td>
                        <td className="py-2 px-3 text-right font-medium text-theme-text">{p.margin_percent != null ? `${p.margin_percent}%` : '—'}</td>
                        <td className="py-2 px-3 text-right text-theme-text-muted">{fmtDate(p.last_sale_date)}</td>
                      </tr>
                    )) || (
                      <tr><td colSpan={6} className="py-4 text-center text-theme-text-muted/50">Sin datos de ventas para este proveedor</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl border border-theme-border bg-theme-surface/60">
              <div className="px-4 py-3 border-b border-theme-border/60">
                <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider">Clientes principales</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-theme-border/40">
                      <th className="text-left py-2 px-3 font-semibold text-theme-text-muted/70">Cliente</th>
                      <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Venta neta</th>
                      <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Facturas</th>
                      <th className="text-right py-2 px-3 font-semibold text-theme-text-muted/70">Últ. compra</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.topClients?.slice(0, 10).map(c => (
                      <tr key={c.client_id} className="border-b border-theme-border/20 hover:bg-theme-surface-hover/50 transition-colors">
                        <td className="py-2 px-3 text-theme-text truncate max-w-[160px]">{c.client_name}</td>
                        <td className="py-2 px-3 text-right font-semibold text-theme-text-accent">{fmt(c.net_sales)}</td>
                        <td className="py-2 px-3 text-right font-medium text-theme-text">{c.invoice_count}</td>
                        <td className="py-2 px-3 text-right text-theme-text-muted">{fmtDate(c.last_purchase)}</td>
                      </tr>
                    )) || (
                      <tr><td colSpan={4} className="py-4 text-center text-theme-text-muted/50">Sin datos de clientes para este proveedor</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
