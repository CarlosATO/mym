'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { Download, ExternalLink, FileText, Image, Loader2, X } from 'lucide-react'
import {
  getSettlementAttachmentSignedUrl,
  SettlementItemAttachment,
} from '@/app/actions/adquisiciones/rendicion-rutas-adjuntos'

interface SettlementDocumentViewerModalProps {
  invoiceNumber: string
  attachments: SettlementItemAttachment[]
  initialAttachmentId?: string
  onClose: () => void
}

function formatBytes(size: number | null) {
  if (!size) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function fileKind(mime: string | null) {
  if (mime === 'application/pdf') return 'PDF'
  if (mime?.startsWith('image/')) return 'Imagen'
  return mime || 'Archivo'
}

export function SettlementDocumentViewerModal({
  invoiceNumber,
  attachments,
  initialAttachmentId,
  onClose,
}: SettlementDocumentViewerModalProps) {
  const initialIndex = Math.max(0, attachments.findIndex(att => att.id === initialAttachmentId))
  const [selectedIndex, setSelectedIndex] = useState(initialIndex >= 0 ? initialIndex : 0)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const selected = attachments[selectedIndex]
  const isImage = selected?.file_mime_type?.startsWith('image/')
  const isPdf = selected?.file_mime_type === 'application/pdf'

  useEffect(() => {
    let mounted = true
    if (!selected) return

    setIsLoading(true)
    setErrorMsg(null)
    setSignedUrl(null)

    getSettlementAttachmentSignedUrl(selected.id).then(({ data, error }) => {
      if (!mounted) return
      if (error || !data?.signedUrl) {
        setErrorMsg(error || 'No se pudo generar la URL firmada del documento.')
      } else {
        setSignedUrl(data.signedUrl)
      }
      setIsLoading(false)
    })

    return () => {
      mounted = false
    }
  }, [selected])

  const title = useMemo(() => selected?.file_name || 'Documento', [selected])

  if (!selected) return null

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 lg:p-6 animate-in fade-in duration-150">
      <div className="w-full max-w-6xl h-full max-h-[90vh] rounded-xl border border-theme-border bg-theme-surface shadow-2xl overflow-hidden flex flex-col">
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-theme-border/70 bg-theme-text/[0.02]">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-theme-text truncate">
              Factura <span className="font-mono text-theme-accent">{invoiceNumber}</span> · {title}
            </h3>
            <p className="text-[11px] text-theme-text-muted truncate">
              {fileKind(selected.file_mime_type)} · {formatBytes(selected.file_size)}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {signedUrl && (
              <>
                <a
                  href={signedUrl}
                  download={selected.file_name}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-text/5 hover:bg-theme-text/10 text-xs font-semibold text-theme-text transition-colors"
                >
                  <Download className="w-3.5 h-3.5" /> Descargar
                </a>
                <a
                  href={signedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-theme-border bg-theme-text/5 hover:bg-theme-text/10 text-xs font-semibold text-theme-text transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Nueva pestaña
                </a>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors"
              title="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex">
          {attachments.length > 1 && (
            <aside className="hidden md:block w-64 shrink-0 border-r border-theme-border/70 bg-theme-text/[0.015] overflow-y-auto p-2">
              {attachments.map((att, index) => {
                const active = index === selectedIndex
                return (
                  <button
                    key={att.id}
                    type="button"
                    onClick={() => setSelectedIndex(index)}
                    className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left text-xs transition-colors ${
                      active ? 'bg-theme-accent/15 text-theme-text' : 'text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                    }`}
                  >
                    {att.file_mime_type?.startsWith('image/') ? <Image className="w-4 h-4 shrink-0" /> : <FileText className="w-4 h-4 shrink-0" />}
                    <span className="truncate">{att.file_name}</span>
                  </button>
                )
              })}
            </aside>
          )}

          <div className="flex-1 min-w-0 bg-theme-surface-sunken flex items-center justify-center overflow-hidden">
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-theme-text-muted">
                <Loader2 className="w-4 h-4 animate-spin" /> Cargando documento...
              </div>
            )}

            {!isLoading && errorMsg && (
              <div className="max-w-md rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-200">
                {errorMsg}
              </div>
            )}

            {!isLoading && !errorMsg && signedUrl && isImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={signedUrl} alt={selected.file_name} className="max-w-full max-h-full object-contain p-4" />
            )}

            {!isLoading && !errorMsg && signedUrl && isPdf && (
              <iframe src={signedUrl} className="w-full h-full border-none bg-white" title={selected.file_name} />
            )}

            {!isLoading && !errorMsg && signedUrl && !isImage && !isPdf && (
              <div className="text-center space-y-3">
                <FileText className="w-10 h-10 mx-auto text-theme-text-muted" />
                <p className="text-sm text-theme-text-muted">Este tipo de archivo no se puede previsualizar aquí.</p>
                <a href={signedUrl} target="_blank" rel="noreferrer" className="text-sm font-bold text-theme-accent hover:underline">
                  Abrir documento
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
