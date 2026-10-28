'use client'

/* Signed storage URLs are external and intentionally rendered without next/image. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react'
import { Download, FileText, Image as ImageIcon, Loader2, X } from 'lucide-react'
import { getPurchaseOrderInvoiceSignedUrl, type PurchaseOrderInvoiceDocument } from '@/app/actions/adquisiciones/purchase-orders'

type PurchaseOrderInvoiceViewerModalProps = {
  correlative: string
  supplierName: string
  documents: PurchaseOrderInvoiceDocument[]
  onClose: () => void
}

type InvoiceLink = {
  signedUrl: string
  downloadUrl: string
  fileName: string
  mimeType: string
}

export function PurchaseOrderInvoiceViewerModal({ correlative, supplierName, documents, onClose }: PurchaseOrderInvoiceViewerModalProps) {
  const [selectedId, setSelectedId] = useState(documents[0]?.id ?? '')
  const [link, setLink] = useState<InvoiceLink | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState(false)

  const selected = documents.find(document => document.id === selectedId) ?? documents[0] ?? null

  useEffect(() => {
    if (!selected) return
    let active = true
    setLink(null)
    setError(null)
    setPreviewError(false)
    if (!selected.has_file) {
      setError('Esta factura no tiene un archivo adjunto disponible.')
      return () => { active = false }
    }
    setLoading(true)
    void getPurchaseOrderInvoiceSignedUrl(selected.id).then(result => {
      if (!active) return
      if ('error' in result) setError(result.error || 'No se pudo obtener la factura.')
      else setLink(result)
      setLoading(false)
    }).catch(() => {
      if (!active) return
      setError('No se pudo obtener el enlace temporal de la factura.')
      setLoading(false)
    })
    return () => { active = false }
  }, [selected?.id, selected?.has_file])

  const isImage = link?.mimeType.startsWith('image/')
  const isPdf = link?.mimeType === 'application/pdf'
  const title = selected?.document_number ? `Factura ${selected.document_number}` : 'Factura sin número'
  const displayName = link?.fileName || selected?.file_name || 'Archivo de factura'

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-5" role="dialog" aria-modal="true" aria-label={`Facturas ${correlative}`} onClick={onClose}>
      <div className="flex h-[92vh] w-[96vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl sm:h-[90vh] sm:w-[90vw]" onClick={event => event.stopPropagation()}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-theme-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-theme-accent">Facturas de recepción</p>
            <h2 className="truncate text-sm font-semibold text-theme-text">{correlative} · {supplierName}</h2>
            <p className="truncate text-[11px] text-theme-text-muted">{documents.length} {documents.length === 1 ? 'factura registrada' : 'facturas registradas'}</p>
          </div>
          <button type="button" onClick={onClose} className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5"><X className="h-4 w-4" /> Cerrar</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="max-h-48 shrink-0 overflow-y-auto border-b border-theme-border p-3 md:max-h-none md:w-64 md:border-b-0 md:border-r">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-theme-text-muted">Documentos</p>
            <div className="space-y-1.5">
              {documents.map(document => (
                <button key={document.id} type="button" onClick={() => setSelectedId(document.id)} className={`block w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors ${selected?.id === document.id ? 'border-theme-accent/40 bg-theme-accent/10 text-theme-text' : 'border-theme-border text-theme-text-muted hover:bg-theme-text/5'}`}>
                  <span className="flex items-center gap-1.5 font-semibold"><FileText className="h-3.5 w-3.5 shrink-0" />{document.document_number || 'Sin número'}</span>
                  <span className="mt-1 block truncate text-[11px] text-theme-text-muted" title={document.file_name || undefined}>{document.file_name || (document.has_file ? 'Archivo adjunto' : 'Sin archivo')}</span>
                </button>
              ))}
            </div>
          </aside>
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-theme-border px-4 py-3">
              <div className="min-w-0"><p className="truncate text-sm font-semibold text-theme-text">{title}</p><p className="truncate text-[11px] text-theme-text-muted">{displayName}</p></div>
              {link && !error && <a href={link.downloadUrl} download={link.fileName} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-theme-accent px-3 py-2 text-xs font-bold text-white hover:bg-theme-accent-hover"><Download className="h-4 w-4" /> Descargar original</a>}
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-100 p-3 sm:p-5">
              {loading && <div className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-5 w-5 animate-spin" /> Cargando factura...</div>}
              {!loading && error && <div className="max-w-md text-center text-sm text-red-700"><p>{error}</p><p className="mt-1 text-xs text-red-600/80">El archivo puede haber sido eliminado, estar vencido o no pertenecer a la empresa activa.</p></div>}
              {!loading && !error && link && previewError && <p className="max-w-md text-center text-sm text-slate-600">La previsualización no está disponible. Puedes descargar el archivo original.</p>}
              {!loading && !error && link && !previewError && isImage && <img src={link.signedUrl} alt={displayName} className="max-h-full max-w-full object-contain" onError={() => setPreviewError(true)} />}
              {!loading && !error && link && !previewError && isPdf && <iframe src={link.signedUrl} title={displayName} className="h-full w-full rounded border border-theme-border bg-white" onError={() => setPreviewError(true)} />}
              {!loading && !error && link && !isImage && !isPdf && <p className="max-w-md text-center text-sm text-slate-600">Este tipo de archivo no tiene previsualización disponible. Puedes descargar el archivo original.</p>}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
