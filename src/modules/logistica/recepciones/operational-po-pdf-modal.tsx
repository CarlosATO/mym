'use client'

import { useEffect, useRef, useState } from 'react'
import { Download, FileText, Loader2, X } from 'lucide-react'
import { getOperationalPurchaseOrderPdfData, type OperationalPurchaseOrderPdfData } from '@/app/actions/logistica/recepciones'
import { generateOperationalPurchaseOrderPdf, downloadOperationalPurchaseOrderPdf } from '@/lib/pdf/generate-operational-po-pdf'

interface OperationalPoPdfModalProps {
  poId: string
  onClose: () => void
}

function buildFileName(data: OperationalPurchaseOrderPdfData): string {
  const number = data.po.correlative.trim().replace(/^OC-/, '') || 'SIN_NUMERO'
  return `OC_OPERACIONAL_${number}`
}

export function OperationalPoPdfModal({ poId, onClose }: OperationalPoPdfModalProps) {
  const [data, setData] = useState<OperationalPurchaseOrderPdfData | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const previewUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    void getOperationalPurchaseOrderPdfData(poId).then(result => {
      if (!active) return
      if (!result) {
        setError('No se pudo cargar la copia operacional de la OC.')
        setLoading(false)
        return
      }
      setData(result)
      const url = URL.createObjectURL(generateOperationalPurchaseOrderPdf(result))
      previewUrlRef.current = url
      setPreviewUrl(url)
      setLoading(false)
    }).catch(() => {
      if (!active) return
      setError('No se pudo generar la previsualización de la OC.')
      setLoading(false)
    })

    return () => {
      active = false
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }, [poId])

  async function download() {
    if (!data || downloading) return
    setDownloading(true)
    try {
      await downloadOperationalPurchaseOrderPdf(data, buildFileName(data))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-5" role="dialog" aria-modal="true" aria-label="Vista previa de OC para bodega" onClick={onClose}>
      <div className="flex h-[92vh] w-[96vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl sm:h-[90vh] sm:w-[90vw]" onClick={event => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-theme-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-theme-accent"><FileText className="h-3 w-3" /> Copia operacional · Bodega</p>
            <h2 className="truncate text-sm font-semibold text-theme-text">{data ? `OC ${data.po.correlative}` : 'Vista previa de OC'}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => void download()} disabled={!data || loading || downloading} className="inline-flex items-center gap-2 rounded-lg bg-theme-accent px-3 py-2 text-xs font-bold text-white hover:bg-theme-accent-hover disabled:opacity-50">
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Descargar PDF
            </button>
            <button type="button" onClick={onClose} className="inline-flex items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5"><X className="h-4 w-4" /> Cerrar</button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-100">
          {loading && <div className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-5 w-5 animate-spin" /> Generando copia operacional...</div>}
          {!loading && error && <p className="px-5 text-center text-sm text-red-700">{error}</p>}
          {!loading && !error && previewUrl && <iframe src={previewUrl} title="Vista previa de OC operacional" className="h-full w-full border-0 bg-white" />}
        </div>
      </div>
    </div>
  )
}
