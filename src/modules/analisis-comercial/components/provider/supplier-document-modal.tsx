'use client'

import type { SupplierWeeklyDetail, SupplierDocumentDetail, SupplierWeeklyDocumentDetail } from '@/app/actions/comercial/analysis/types'
import { getSupplierDocumentDetail } from '@/app/actions/comercial/analysis/suppliers'
import { useState, useEffect } from 'react'

function money(value: number) {
  return '$' + Math.round(value).toLocaleString('es-CL')
}

type ViewMode = 'LIST' | 'DETAIL'
type ModalType = 'PURCHASE' | 'SALE'

export function SupplierDocumentModal({
  weeklyDetail,
  modalType,
  isOpen,
  onClose,
  supplierId,
}: {
  weeklyDetail: SupplierWeeklyDetail | null
  modalType: ModalType
  isOpen: boolean
  onClose: () => void
  supplierId: string
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('LIST')
  const [selectedDoc, setSelectedDoc] = useState<SupplierDocumentDetail | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [docCache, setDocCache] = useState<Record<string, SupplierDocumentDetail>>({})

  // Reset state when modal opens with new weeklyDetail
  useEffect(() => {
    if (isOpen) {
      setViewMode('LIST')
      setSelectedDoc(null)
      setDocError(null)
    }
  }, [isOpen, weeklyDetail?.weekStart])

  if (!isOpen || !weeklyDetail) return null

  const documents = modalType === 'PURCHASE' ? weeklyDetail.purchaseDocuments : weeklyDetail.saleDocuments
  const title = modalType === 'PURCHASE' ? 'Compras del período' : 'Ventas del período'
  const totalAmount = modalType === 'PURCHASE' ? weeklyDetail.purchases : weeklyDetail.sales

  const handleViewDetail = async (doc: SupplierWeeklyDocumentDetail) => {
    const docId = doc.id
    const kind = doc.kind
    const cacheKey = `${supplierId}:${kind}:${docId}`

    if (docCache[cacheKey]) {
      setSelectedDoc(docCache[cacheKey])
      setViewMode('DETAIL')
      setDocError(null)
      return
    }

    setLoadingDoc(true)
    setDocError(null)

    try {
      const detail = await getSupplierDocumentDetail({ supplierId, documentKind: kind, documentId: docId })
      if (detail) {
        setDocCache(prev => ({ ...prev, [cacheKey]: detail }))
        setSelectedDoc(detail)
        setViewMode('DETAIL')
      } else {
        setDocError(`No se pudo cargar el detalle de "${doc.document} ${doc.documentNumber}".`)
      }
    } catch (err: any) {
      setDocError(err?.message || `Error al cargar detalle de "${doc.document} ${doc.documentNumber}".`)
    } finally {
      setLoadingDoc(false)
    }
  }

  const handleBack = () => {
    setViewMode('LIST')
    setSelectedDoc(null)
    setDocError(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-theme-bg border border-theme-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-theme-border/50 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              {viewMode === 'DETAIL' && (
                <button onClick={handleBack} className="text-xs text-theme-text-muted hover:text-theme-text transition-colors font-medium" type="button">
                  &larr; Volver a documentos
                </button>
              )}
              {viewMode === 'LIST' && (
                <h3 className="text-base font-bold text-theme-text">{title}</h3>
              )}
            </div>
            {viewMode === 'LIST' ? (
              <p className="text-xs text-theme-text-muted mt-0.5">
                {weeklyDetail.label} &middot; {money(totalAmount)}
              </p>
            ) : selectedDoc && (
              <p className="text-xs text-theme-text-muted mt-0.5">
                {selectedDoc.document} {selectedDoc.documentNumber} &middot; {selectedDoc.date}
                &middot; {selectedDoc.skuCount} SKUs &middot; {Math.round(selectedDoc.units)} unid.
                {selectedDoc.customerName ? <> &middot; {selectedDoc.customerName}</> : null}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-theme-text-muted hover:text-theme-text transition-colors text-lg leading-none p-1 shrink-0" type="button" aria-label="Cerrar">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-6">
          {/* Error message */}
          {docError && (
            <div className="mb-4 rounded border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-xs text-rose-600">
              {docError}
            </div>
          )}

          {/* LIST view */}
          {viewMode === 'LIST' && (
            <div className="space-y-2">
              {documents.length === 0 ? (
                <div className="text-xs text-theme-text-muted/60 text-center py-8">
                  {modalType === 'PURCHASE' ? 'Sin recepciones registradas en este período.' : 'Sin facturas emitidas en este período.'}
                </div>
              ) : (
                documents.map(doc => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => handleViewDetail(doc)}
                    className="w-full text-left text-xs rounded-lg bg-theme-surface/50 p-3 border border-theme-border/30 hover:border-theme-border hover:bg-theme-surface/70 transition-all cursor-pointer"
                  >
                    <div className="flex justify-between items-start mb-1">
                      <div className="min-w-0 flex-1">
                        <span className={`font-semibold text-theme-text ${doc.kind === 'CREDIT_NOTE' ? 'text-rose-600/80' : ''}`}>
                          {doc.document}
                        </span>
                        <span className="text-theme-text-muted ml-1">{doc.documentNumber}</span>
                      </div>
                      <span className={`font-bold shrink-0 ml-3 ${doc.kind === 'CREDIT_NOTE' ? 'text-rose-500' : 'text-theme-text'}`}>
                        {doc.kind === 'CREDIT_NOTE' ? '-' : ''}{money(Math.abs(doc.amount))}
                      </span>
                    </div>
                    <div className="flex justify-between text-theme-text-muted">
                      <span>{doc.date} &middot; {doc.units} unid. &middot; {doc.skuCount} SKUs</span>
                      <span className="text-[10px] text-theme-text-muted/60">Ver detalle &rarr;</span>
                    </div>
                    {doc.productsSummary && (
                      <div className="mt-1 text-theme-text-muted/70 truncate" title={doc.productsSummary}>
                        {doc.productsSummary}
                      </div>
                    )}
                  </button>
                ))
              )}
            </div>
          )}

          {/* Loading */}
          {loadingDoc && (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-theme-border border-t-blue-500" />
              <span className="ml-3 text-sm text-theme-text-muted">Cargando documento...</span>
            </div>
          )}

          {/* DETAIL view */}
          {viewMode === 'DETAIL' && selectedDoc && !loadingDoc && (
            <div className="overflow-x-auto rounded-lg border border-theme-border/50">
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead>
                  <tr className="border-b border-theme-border/50 bg-theme-surface/50">
                    <th className="py-2 pl-3 pr-2 font-semibold text-theme-text">SKU</th>
                    <th className="px-2 py-2 font-semibold text-theme-text">Producto</th>
                    <th className="px-2 py-2 font-semibold text-theme-text">Cantidad</th>
                    <th className="px-2 py-2 text-right font-semibold text-theme-text">Unitario</th>
                    <th className="py-2 pl-2 pr-3 text-right font-semibold text-theme-text">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/30">
                  {selectedDoc.lines.map((line, idx) => (
                    <tr key={idx} className="hover:bg-theme-surface/50">
                      <td className="py-2 pl-3 pr-2 text-theme-text font-mono text-[10px]">{line.sku}</td>
                      <td className="px-2 py-2 text-theme-text truncate max-w-[200px]" title={line.description}>{line.description}</td>
                      <td className="px-2 py-2 text-theme-text-muted">{line.quantity}</td>
                      <td className="px-2 py-2 text-right text-theme-text-muted">{money(line.unitAmount)}</td>
                      <td className={`py-2 pl-2 pr-3 text-right font-medium ${line.totalAmount < 0 ? 'text-rose-500' : 'text-theme-text'}`}>
                        {money(line.totalAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-theme-surface/20 border-t border-theme-border/50">
                    <td colSpan={4} className="py-2.5 px-3 text-right font-semibold text-theme-text text-[11px] uppercase tracking-wider">
                      Total en Proveedor
                    </td>
                    <td className={`py-2.5 pl-2 pr-3 text-right font-bold text-sm ${selectedDoc.totalAmount < 0 ? 'text-rose-500' : 'text-theme-text'}`}>
                      {money(selectedDoc.totalAmount)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
