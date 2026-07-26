'use client'

import type { SupplierPurchaseRow } from '@/app/actions/comercial/analysis/types'

function money(value: number) {
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function dateLabel(value: string) {
  if (!value) return '—'
  const [y, m, d] = value.split('-')
  return `${d}/${m}/${y}`
}

export function SupplierLastPurchasesTable({ rows }: { rows: SupplierPurchaseRow[] }) {
  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
      <h3 className="text-sm font-bold text-theme-text">Últimas compras</h3>
      {rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-theme-border bg-theme-bg/40 px-4 py-6 text-center text-sm text-theme-text-muted/70">
          No hay recepciones Bsale sincronizadas para este proveedor.
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[620px] text-xs">
            <thead>
              <tr className="border-b border-theme-border/50">
                <th className="px-3 py-2 text-left font-semibold text-theme-text-muted/70">Fecha</th>
                <th className="px-3 py-2 text-left font-semibold text-theme-text-muted/70">Documento</th>
                <th className="px-3 py-2 text-left font-semibold text-theme-text-muted/70">Productos</th>
                <th className="px-3 py-2 text-right font-semibold text-theme-text-muted/70">Unidades</th>
                <th className="px-3 py-2 text-right font-semibold text-theme-text-muted/70">Monto</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 10).map((row) => (
                <tr key={`${row.document}-${row.date}`} className="border-b border-theme-border/20">
                  <td className="px-3 py-2 text-theme-text">{dateLabel(row.date)}</td>
                  <td className="px-3 py-2 text-theme-text">{row.document}</td>
                  <td className="px-3 py-2 text-theme-text">{row.productsSummary}</td>
                  <td className="px-3 py-2 text-right text-theme-text">{row.units}</td>
                  <td className="px-3 py-2 text-right font-semibold text-theme-text">{money(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
