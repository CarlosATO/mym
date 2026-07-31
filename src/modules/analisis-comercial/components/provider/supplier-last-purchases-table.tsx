'use client'

import type { SupplierPurchaseRow, SupplierDocumentDetail } from '@/app/actions/comercial/analysis/types'
import { useState } from 'react'
import { SupplierDocumentModal } from './supplier-document-modal'

function money(value: number) {
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function dateLabel(value: string) {
  if (!value) return '—'
  const [y, m, d] = value.split('-')
  return `${d}/${m}/${y}`
}

export function SupplierLastPurchasesTable({ rows, supplierId }: { rows: SupplierPurchaseRow[], supplierId: string }) {
  const [selectedDetail, setSelectedDetail] = useState<SupplierDocumentDetail | null>(null)

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface/60 p-4">
      <h3 className="text-sm font-bold text-theme-text mb-4">Últimas compras</h3>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-theme-border bg-theme-bg/40 px-4 py-6 text-center text-sm text-theme-text-muted/70">
          No hay recepciones Bsale sincronizadas para este proveedor.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 10).map((row, i) => {
            const rowKey = `${row.document}-${row.documentNumber}-${row.date}-${i}`
            return (
              <div
                key={rowKey}
                className="rounded-lg border border-theme-border/50 bg-theme-surface/40 overflow-hidden transition-colors hover:border-theme-border/80 cursor-pointer"
                onClick={() => {
                  setSelectedDetail({
                    id: rowKey,
                    date: row.date,
                    document: row.document,
                    documentNumber: row.documentNumber || '',
                    totalAmount: row.amount,
                    units: row.units,
                    skuCount: row.productCount,
                    lines: row.products.map(p => ({
                      sku: p.sku,
                      description: p.name,
                      quantity: p.quantity,
                      unitAmount: p.unitCost || 0,
                      totalAmount: p.subtotal || 0,
                      kind: 'PURCHASE'
                    }))
                  })
                }}
              >
                <div className="px-4 py-3 flex items-center justify-between">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 min-w-0 flex-1">
                    <div className="text-theme-text-muted text-xs whitespace-nowrap">{dateLabel(row.date)}</div>
                    <div className="font-semibold text-theme-text text-sm truncate w-32 group-hover:text-blue-500 transition-colors">
                      {row.document} {row.documentNumber}
                    </div>
                    <div className="text-theme-text-muted/80 text-xs truncate max-w-[250px] hidden md:block" title={row.productsSummary}>
                      {row.productsSummary}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 sm:gap-6 shrink-0 ml-4">
                    <div className="text-right hidden sm:block">
                      <div className="text-xs text-theme-text-muted">SKUs / Unid.</div>
                      <div className="font-medium text-theme-text text-sm">{row.productCount} / {row.units}</div>
                    </div>
                    <div className="text-right w-24">
                      <div className="text-xs text-theme-text-muted">Total</div>
                      <div className="font-bold text-blue-600 dark:text-blue-400 text-sm">{money(row.amount)}</div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedDetail && (
        <SupplierDocumentModal
          isOpen={true}
          onClose={() => setSelectedDetail(null)}
          supplierId={supplierId}
          listType={null}
          weeklyLabel={null}
          weeklyDetail={null}
          isLoadingWeekly={false}
          initialDocumentDetail={selectedDetail}
        />
      )}
    </section>
  )
}
