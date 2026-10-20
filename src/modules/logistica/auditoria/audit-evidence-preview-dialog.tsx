'use client'

import { useEffect, useState } from 'react'
import { FileImage, ImageOff, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export type AuditEvidencePreview = {
  signedUrl: string | null
  fileName: string
  mimeType: string
  uploadedAt: string | null
}

interface AuditEvidencePreviewDialogProps {
  open: boolean
  loading: boolean
  error: string | null
  evidence: AuditEvidencePreview | null
  onOpenChange: (open: boolean) => void
}

function formatUploadedAt(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function AuditEvidencePreviewDialog({
  open,
  loading,
  error,
  evidence,
  onOpenChange,
}: AuditEvidencePreviewDialogProps) {
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    if (!open) setImageError(false)
  }, [open])

  useEffect(() => {
    setImageError(false)
  }, [evidence?.signedUrl])

  const isHeic = Boolean(evidence && (
    evidence.mimeType === 'image/heic' || /\.heic$/i.test(evidence.fileName)
  ))
  const uploadedAt = formatUploadedAt(evidence?.uploadedAt ?? null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden bg-theme-base border-theme-border text-theme-text">
        <div className="p-5 pb-3 border-b border-theme-border/50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <FileImage className="h-5 w-5 text-[#72383D]" />
              Evidencia fotográfica
            </DialogTitle>
            <DialogDescription className="text-theme-text/70">
              Vista previa temporal de la evidencia registrada en Auditoría.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-theme-text-muted">
              <Loader2 className="h-7 w-7 animate-spin text-[#72383D]" />
              <p className="text-sm font-medium">Preparando vista previa…</p>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-4 py-3 text-sm text-[#8A4B4B]">
              {error}
            </div>
          ) : evidence ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <p className="min-w-0 break-all font-semibold text-theme-text">{evidence.fileName}</p>
                {uploadedAt && <p className="text-theme-text-muted">{uploadedAt}</p>}
              </div>

              {isHeic ? (
                <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[#B8ABA0] bg-white px-6 py-16 text-center">
                  <ImageOff className="h-10 w-10 text-[#72383D]" />
                  <p className="text-sm font-bold text-theme-text">Vista previa no disponible para este formato.</p>
                  <p className="text-xs text-theme-text-muted">El archivo HEIC quedó registrado correctamente como evidencia.</p>
                </div>
              ) : evidence.signedUrl && !imageError ? (
                <div className="flex items-center justify-center rounded-lg border border-[#DDD4CA] bg-[#F8F5F1] p-2">
                  <img
                    src={evidence.signedUrl}
                    alt={`Evidencia ${evidence.fileName}`}
                    className="max-h-[70vh] w-auto max-w-full object-contain"
                    onError={() => setImageError(true)}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[#B8ABA0] bg-white px-6 py-16 text-center">
                  <ImageOff className="h-10 w-10 text-[#72383D]" />
                  <p className="text-sm font-bold text-theme-text">No se pudo cargar la vista previa.</p>
                  <p className="text-xs text-theme-text-muted">El archivo sigue registrado como evidencia.</p>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="p-4 border-t border-theme-border/50 flex justify-end bg-theme-panel">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cerrar</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
