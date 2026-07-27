'use client'

import type { SupplierPurchaseRow } from '@/app/actions/comercial/analysis/types'
import { useState } from 'react'

function money(value: number) {
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function dateLabel(value: string) {
  if (!value) return '—'
  const [y, m, d] = value.split('-')
  return `${d}/${m}/${y}`
}

export function SupplierLastPurchasesTable({ rows }: { rows: SupplierPurchaseRow[] }) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null)

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
      <h3 className="text-sm font-bold text-theme-text mb-4">Últimas compras</h3>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-theme-border bg-theme-bg/40 px-4 py-6 text-center text-sm text-theme-text-muted/70">
          No hay recepciones Bsale sincronizadas para este proveedor.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 10).map((row) => {
            const rowKey = `${row.document}-${row.date}`
            const isExpanded = expandedRow === rowKey
            return (
              <div key={rowKey} className="rounded-lg border border-theme-border/50 bg-theme-surface/40 overflow-hidden transition-colors hover:border-theme-border/80">
                <div 
                  className="px-4 py-3 flex items-center justify-between cursor-pointer"
                  onClick={() => setExpandedRow(isExpanded ? null : rowKey)}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 min-w-0 flex-1">
                    <div className="text-theme-text-muted text-xs whitespace-nowrap">{dateLabel(row.date)}</div>
                    <div className="font-semibold text-theme-text text-sm truncate w-32">{row.document}</div>
                    <div className="text-theme-text-muted/80 text-xs truncate max-w-[250px] hidden md:block" title={row.productsSummary}>
                      {row.productsSummary}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 sm:gap-6 shrink-0 ml-4">
                    <div className="text-right hidden sm:block">
                      <div className="text-xs text-theme-text-muted">Unidades</div>
                      <div className="font-medium text-theme-text text-sm">{row.units}</div>
                    </div>
                    <div className="text-right w-24">
                      <div className="text-xs text-theme-text-muted">Total</div>
                      <div className="font-bold text-blue-600 dark:text-blue-400 text-sm">{money(row.amount)}</div>
                    </div>
                    <div className={`text-theme-text-muted/60 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </div>
                  </div>
                </div>
                {isExpanded && row.products && (
                  <div className="px-4 py-3 border-t border-theme-border/30 bg-theme-surface/20">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[500px] text-xs">
                        <thead>
                          <tr className="border-b border-theme-border/30">
                            <th className="px-2 py-2 text-left font-semibold text-theme-text-muted uppercase tracking-wider">SKU</th>
                            <th className="px-2 py-2 text-left font-semibold text-theme-text-muted uppercase tracking-wider">Producto</th>
                            <th className="px-2 py-2 text-right font-semibold text-theme-text-muted uppercase tracking-wider">Cant.</th>
                            <th className="px-2 py-2 text-right font-semibold text-theme-text-muted uppercase tracking-wider">Costo Unit.</th>
                            <th className="px-2 py-2 text-right font-semibold text-theme-text-muted uppercase tracking-wider">Subtotal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.products.map((p, i) => (
                            <tr key={`${p.sku}-${i}`} className="border-b border-theme-border/10 last:border-0 hover:bg-theme-bg/30">
                              <td className="px-2 py-2 text-theme-text/80 whitespace-nowrap">{p.sku}</td>
                              <td className="px-2 py-2 text-theme-text truncate max-w-[200px]" title={p.name}>{p.name}</td>
                              <td className="px-2 py-2 text-right text-theme-text">{p.quantity}</td>
                              <td className="px-2 py-2 text-right text-theme-text-muted">{p.unitCost ? money(p.unitCost) : '—'}</td>
                              <td className="px-2 py-2 text-right font-medium text-theme-text/90">{p.subtotal ? money(p.subtotal) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
