'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, UserCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import type { SalesOrderAudit } from '@/app/actions/logistica/sales-order-audit'

interface AuditTakeoverDialogProps {
  open: boolean
  card: SalesOrderPreparationCardInfo
  audit: SalesOrderAudit | null
  currentUserName: string
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => Promise<{ ok: boolean; error?: string }>
}

export function AuditTakeoverDialog({
  open,
  card,
  audit,
  currentUserName,
  onOpenChange,
  onConfirm,
}: AuditTakeoverDialogProps) {
  const [reason, setReason] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setReason('')
      setError(null)
      setIsLoading(false)
    }
  }, [open])

  const handleOpenChange = (next: boolean) => {
    if (isLoading) return
    onOpenChange(next)
  }

  const handleConfirm = async () => {
    if (!reason.trim()) {
      setError('El motivo es obligatorio.')
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const result = await onConfirm(reason.trim())
      if (!result.ok) {
        setError(result.error || 'No se pudo tomar la auditoría.')
        return
      }
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de conexión.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden bg-theme-base border-theme-border text-theme-text">
        <div className="p-6 pb-4 border-b border-theme-border/50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <UserCheck className="w-5 h-5 text-[#72383D]" />
              Tomar Auditoría de otro usuario
            </DialogTitle>
            <DialogDescription className="text-theme-text/70">
              La auditoría pasará a tu control exclusivo. El auditor anterior perderá la escritura.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-5">
          <div className="border border-[#D1C7BD] bg-white p-4 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-theme-text">NV #{card.nv_folio}</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#6B625C]">{card.client_name}</span>
            </div>
            <p className="text-theme-text/80">
              Auditor actual: <strong>{audit?.locked_by_name || audit?.auditor_name || 'otro usuario'}</strong>
            </p>
            <p className="text-theme-text/80">
              Nuevo auditor: <strong>{currentUserName || 'tu usuario'}</strong>
            </p>
          </div>

          <div className="bg-amber-500/10 text-amber-800 p-3 rounded-md flex items-start gap-2 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <p>El cambio de auditor queda registrado con el motivo informado. No modifica cantidades ni la NV.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="audit-takeover-reason">Motivo *</Label>
            <Textarea
              id="audit-takeover-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ej: cambio de turno / el auditor anterior no está disponible..."
              className="resize-none h-24"
              disabled={isLoading}
              autoFocus
            />
          </div>

          {error && <p className="text-xs text-[#8A4B4B]">{error}</p>}
        </div>

        <div className="p-4 border-t border-theme-border/50 flex justify-end gap-3 bg-theme-panel">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isLoading}>
            Cancelar
          </Button>
          <Button onClick={handleConfirm} disabled={!reason.trim() || isLoading}>
            {isLoading ? 'Tomando...' : 'Tomar auditoría'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
