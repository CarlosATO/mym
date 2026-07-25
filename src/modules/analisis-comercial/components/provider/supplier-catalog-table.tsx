'use client'

import type { SupplierCatalogRow } from '@/app/actions/comercial/analysis/types'

function money(value: number) {
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function dateLabel(value: string | null) {
  if (!value) return '—'
  const [y, m, d] = value.split('-')
  return `${d}/${m}/${y}`
}

export function SupplierCatalogTable({ rows }: { rows: SupplierCatalogRow[] }) {
  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
      <h3 className="text-sm font-bold text-theme-text">Catálogo del proveedor</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[920px] text-xs">
          <thead>
            <tr className="border-b border-theme-border/50">
              <th className="px-3 py-2 text-left font-semibold text-theme-text-muted/70">SKU</th>
              <th className="px-3 py-2 text-left font-semibold text-theme-text-muted/70">Producto</th>
              <th className="px-3 py-2 text-left font-semibold text-theme-text-muted/70">Pseudoproveedor</th>
              <th className="px-3 py-2 text-right font-semibold text-theme-text-muted/70">Stock actual</th>
              <th className="px-3 py-2 text-right font-semibold text-theme-text-muted/70">Costo prom.</th>
              <th className="px-3 py-2 text-right font-semibold text-theme-text-muted/70">Venta período</th>
              <th className="px-3 py-2 text-right font-semibold text-theme-text-muted/70">Unidades</th>
              <th className="px-3 py-2 text-right font-semibold text-theme-text-muted/70">Última venta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.product_id} className="border-b border-theme-border/20 hover:bg-theme-surface-hover/40">
                <td className="px-3 py-2 font-mono text-theme-text">{row.sku}</td>
                <td className="px-3 py-2 text-theme-text">{row.product_name}</td>
                <td className="px-3 py-2 text-theme-text-muted">{row.pseudo_supplier || '—'}</td>
                <td className="px-3 py-2 text-right text-theme-text">{row.stock_current.toLocaleString('es-CL')}</td>
                <td className="px-3 py-2 text-right text-theme-text">{money(row.average_cost)}</td>
                <td className="px-3 py-2 text-right font-semibold text-theme-text">{money(row.sales_amount)}</td>
                <td className="px-3 py-2 text-right text-theme-text">{row.units_sold.toLocaleString('es-CL')}</td>
                <td className="px-3 py-2 text-right text-theme-text-muted">{dateLabel(row.last_sale)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-theme-text-muted/70">
                  No hay productos asociados a este proveedor.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
