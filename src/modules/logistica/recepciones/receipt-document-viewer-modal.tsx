'use client'

/* Signed storage URLs are external and intentionally rendered without next/image. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react'
import { Download, FileText, Image as ImageIcon, Loader2, X } from 'lucide-react'
import { getReceiptDocumentSignedUrl } from '@/app/actions/logistica/recepciones'

interface ReceiptDocumentViewerModalProps {
  documentId: string
  documentType?: string | null
  documentNumber?: string | null
  fileName?: string | null
  onClose: () => void
}

type DocumentLink = {
  signedUrl: string
  downloadUrl: string
  fileName: string
  mimeType: string
  expiresIn: number
}

type ReceiptDocumentResult = DocumentLink | { error: string }

// Strict Mode and fast reopenings can mount the viewer more than once. Share only
// the in-flight request; completed URLs are never cached past this component.
const inFlightRequests = new Map<string, Promise<ReceiptDocumentResult>>()

function loadReceiptDocument(documentId: string): Promise<ReceiptDocumentResult> {
  const existing = inFlightRequests.get(documentId)
  if (existing) return existing

  let request!: Promise<ReceiptDocumentResult>
  request = getReceiptDocumentSignedUrl(documentId)
    .finally(() => {
      if (inFlightRequests.get(documentId) === request) inFlightRequests.delete(documentId)
    })
  inFlightRequests.set(documentId, request)
  return request
}

function documentTitle(documentType?: string | null, documentNumber?: string | null): string {
  return [documentType, documentNumber].filter(Boolean).join(' ') || 'Documento de recepción'
}

export function ReceiptDocumentViewerModal({ documentId, documentType, documentNumber, fileName, onClose }: ReceiptDocumentViewerModalProps) {
  const [link, setLink] = useState<DocumentLink | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState(false)

  useEffect(() => {
    let active = true
    setLink(null)
    setError(null)
    setPreviewError(false)
    setLoading(true)
    const startedAt = performance.now()
    void loadReceiptDocument(documentId).then(result => {
      if (!active) return
      if ('error' in result) {
        setError(result.error || 'No se pudo obtener el documento.')
      } else {
        setLink(result)
      }
      setLoading(false)
      if (process.env.NODE_ENV === 'development') console.info(`[receipt-document] ${documentId} ready in ${Math.round(performance.now() - startedAt)}ms`)
    }).catch(() => {
      if (!active) return
      setError('No se pudo obtener el enlace temporal del documento.')
      setLoading(false)
      if (process.env.NODE_ENV === 'development') console.info(`[receipt-document] ${documentId} failed in ${Math.round(performance.now() - startedAt)}ms`)
    })
    return () => { active = false }
  }, [documentId])

  const title = documentTitle(documentType, documentNumber)
  const displayName = link?.fileName || fileName || 'Documento de recepción'
  const isImage = link?.mimeType.startsWith('image/')
  const isPdf = link?.mimeType === 'application/pdf'

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-5" role="dialog" aria-modal="true" aria-label={`Vista previa ${title}`} onClick={onClose}>
      <div className="flex h-[92vh] w-[96vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl sm:h-[90vh] sm:w-[90vw]" onClick={event => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-theme-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-theme-accent">
              {isImage ? <ImageIcon className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
              Documento de recepción
            </p>
            <h2 className="truncate text-sm font-semibold text-theme-text">{title}</h2>
            <p className="truncate text-[11px] text-theme-text-muted">{displayName}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {link && !error && (
              <a href={link.downloadUrl} download={link.fileName} className="inline-flex items-center gap-2 rounded-lg bg-theme-accent px-3 py-2 text-xs font-bold text-white hover:bg-theme-accent-hover">
                <Download className="h-4 w-4" /> Descargar archivo original
              </a>
            )}
            <button type="button" onClick={onClose} className="inline-flex items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5">
              <X className="h-4 w-4" /> Cerrar
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-100 p-3 sm:p-5">
          {loading && <div className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-5 w-5 animate-spin" /> Cargando documento...</div>}
          {!loading && error && <div className="max-w-md text-center text-sm text-red-700"><p>{error}</p><p className="mt-1 text-xs text-red-600/80">El archivo puede haber sido eliminado, estar vencido o no pertenecer a la empresa activa.</p></div>}
          {!loading && !error && link && previewError && <p className="max-w-md text-center text-sm text-slate-600">La previsualización no está disponible. Puedes descargar el archivo original.</p>}
          {!loading && !error && link && !previewError && isImage && <img src={link.signedUrl} alt={displayName} className="max-h-full max-w-full object-contain" onError={() => setPreviewError(true)} />}
          {!loading && !error && link && !previewError && isPdf && <iframe src={link.signedUrl} title={displayName} className="h-full w-full rounded border border-theme-border bg-white" onError={() => setPreviewError(true)} />}
          {!loading && !error && link && !isImage && !isPdf && <p className="max-w-md text-center text-sm text-slate-600">Este tipo de archivo no tiene previsualización disponible. Puedes descargar el archivo original.</p>}
        </div>
      </div>
    </div>
  )
}
