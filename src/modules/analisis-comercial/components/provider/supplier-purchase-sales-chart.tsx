'use client'

import type { SupplierMonthlyPoint } from '@/app/actions/comercial/analysis/types'

function money(value: number) {
  return '$' + Math.round(value).toLocaleString('es-CL')
}

export function SupplierPurchaseSalesChart({ monthly, hasReceptionData }: { monthly: SupplierMonthlyPoint[]; hasReceptionData: boolean }) {
  const maxValue = Math.max(1, ...monthly.flatMap((item) => [item.purchases, item.sales]))

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-theme-text">Compra mensual vs venta mensual</h3>
          <p className="mt-1 text-xs text-theme-text-muted/70">
            {hasReceptionData ? 'Comparación mensual de compras y ventas del proveedor.' : 'Ventas mensuales disponibles. Compras en 0 porque recepciones Bsale aún no están sincronizadas.'}
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {monthly.length === 0 ? (
          <div className="rounded-lg border border-theme-border bg-theme-bg/40 px-4 py-6 text-center text-sm text-theme-text-muted/70">
            No hay ventas en el período seleccionado para este proveedor.
          </div>
        ) : (
          monthly.map((item) => (
            <div key={item.month} className="grid items-center gap-3 md:grid-cols-[80px_1fr_90px_1fr_90px]">
              <div className="text-xs font-semibold text-theme-text-muted">{item.month}</div>
              <div className="h-3 rounded-full bg-theme-bg overflow-hidden">
                <div className="h-full rounded-full bg-sky-500/70" style={{ width: `${(item.purchases / maxValue) * 100}%` }} />
              </div>
              <div className="text-right text-xs text-theme-text-muted">{item.purchases > 0 ? money(item.purchases) : '0'}</div>
              <div className="h-3 rounded-full bg-theme-bg overflow-hidden">
                <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${(item.sales / maxValue) * 100}%` }} />
              </div>
              <div className="text-right text-xs font-semibold text-theme-text">{money(item.sales)}</div>
            </div>
          ))
        )}
      </div>
      {!hasReceptionData && (
        <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
          Recepciones Bsale aún no sincronizadas. Para completar Compra vs Venta se requiere espejo de recepciones Bsale.
        </div>
      )}
    </section>
  )
}
