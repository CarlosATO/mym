'use client'

import { useState } from 'react'
import { AlertTriangle, UserCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'

interface PreparationLockDialogProps {
  card: SalesOrderPreparationCardInfo | null
  currentUserName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => Promise<{ ok: boolean; error?: string }>
}

export function PreparationLockDialog({
  card,
  currentUserName,
  open,
  onOpenChange,
  onConfirm,
}: PreparationLockDialogProps) {
  const [reason, setReason] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setReason('')
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (isLoading) return
    if (!next) reset()
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
        setError(result.error || 'No se pudo tomar la preparación.')
        return
      }
      reset()
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
              Tomar preparación de otro usuario
            </DialogTitle>
            <DialogDescription className="text-theme-text/70">
              La preparación pasará a tu control exclusivo. El usuario anterior perderá la escritura.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-5">
          {card && (
            <div className="border border-[#D1C7BD] bg-white p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-theme-text">NV #{card.nv_folio}</span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#6B625C]">{card.client_name}</span>
              </div>
              <p className="text-theme-text/80">
                Responsable actual: <strong>{card.locked_by_user_name || 'otro usuario'}</strong>
              </p>
              <p className="text-theme-text/80">
                Nuevo responsable: <strong>{currentUserName || 'tu usuario'}</strong>
              </p>
            </div>
          )}

          <div className="bg-amber-500/10 text-amber-800 p-3 rounded-md flex items-start gap-2 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <p>El takeover queda registrado en el historial con usuario anterior, usuario nuevo y motivo.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="preparation-lock-reason">Motivo *</Label>
            <Textarea
              id="preparation-lock-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ej: el preparador anterior no está disponible / cambio de turno..."
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
            {isLoading ? 'Tomando...' : 'Tomar preparación'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
