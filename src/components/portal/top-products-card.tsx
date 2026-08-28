import type { PortalTopProduct } from '@/app/actions/portal/top-products'

function currency(value: number) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(value)
}

export function TopProductsCard({ products, error }: { products: PortalTopProduct[]; error: boolean }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-theme-border/80 bg-theme-surface/80 shadow-sm">
      <div className="border-b border-theme-border/70 px-4 py-3 sm:px-4">
        <h2 className="text-base font-semibold tracking-tight text-theme-text">Top 5 productos del mes</h2>
        <p className="mt-0.5 text-[10px] text-theme-text-muted/60">Montos netos, sin IVA</p>
      </div>
      {error ? (
        <div className="px-5 py-8 text-center text-xs text-theme-text-muted/75">No se pudo cargar el ranking.</div>
      ) : products.length === 0 ? (
        <div className="px-5 py-8 text-center text-xs text-theme-text-muted/70">No hay ventas de productos este mes.</div>
      ) : (
        <div className="overflow-hidden px-3 py-2 sm:px-4">
          <table className="w-full table-fixed text-[10px] text-theme-text">
            <colgroup>
              <col className="w-7" />
              <col />
              <col className="w-14" />
              <col className="w-[92px]" />
            </colgroup>
            <thead className="border-b border-theme-border/60 text-[9px] font-bold uppercase tracking-[0.06em] text-theme-text-muted/60">
              <tr>
                <th className="pb-2 text-left">#</th>
                <th className="pb-2 text-left">Producto</th>
                <th className="pb-2 text-right">Unidades</th>
                <th className="pb-2 text-right">Venta neta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {products.slice(0, 5).map(product => (
                <tr key={`${product.rank}-${product.sku ?? product.name}`}>
                    <td className="py-1.5 font-semibold tabular-nums text-theme-text-muted">{product.rank}</td>
                    <td className="max-w-0 truncate py-1.5 pr-2 font-medium" title={product.name}>{product.name}</td>
                    <td className="py-1.5 text-right tabular-nums text-theme-text-muted">{product.units.toLocaleString('es-CL')}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">{currency(product.net_sales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
