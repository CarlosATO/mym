'use client'

import { useState } from 'react'
import { AlertCircle, Ban } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'

export type ExclusionConfirmInput = { reason: string; observation: string }
export type ExclusionConfirmResult = { ok: boolean; error?: string; message?: string }

interface PreparationExclusionDialogProps {
  card: SalesOrderPreparationCardInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (input: ExclusionConfirmInput) => Promise<ExclusionConfirmResult>
}

const statusLabel = (status: string) =>
  status === 'PENDING_ROUTE_PREP' ? 'Pendiente' :
  status === 'IN_PREPARATION' ? 'En preparación' :
  status === 'IN_AUDIT' ? 'En auditoría' :
  status === 'AUDITED' ? 'Auditada' : status

export function PreparationExclusionDialog({ card, open, onOpenChange, onConfirm }: PreparationExclusionDialogProps) {
  const [reason, setReason] = useState('')
  const [observation, setObservation] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setReason('')
    setObservation('')
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
      const result = await onConfirm({ reason: reason.trim(), observation: observation.trim() })
      if (!result.ok) {
        setError(result.error || 'No se pudo excluir la Nota de Venta.')
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
              <Ban className="w-5 h-5 text-[#72383D]" />
              Excluir de preparación
            </DialogTitle>
            <DialogDescription className="text-theme-text/70">
              Oculta la Nota de Venta del flujo de Preparación de PetGroup.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-5">
          {card && (
            <div className="border border-[#D1C7BD] bg-white p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-theme-text">NV #{card.nv_folio}</span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#6B625C]">
                  {statusLabel(card.status)}
                </span>
              </div>
              <p className="text-theme-text/80">{card.client_name}</p>
            </div>
          )}

          <div className="bg-orange-500/10 text-orange-600 dark:text-orange-400 p-3 rounded-md flex items-start gap-2 text-sm">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p>
              Esta acción no anula ni modifica la Nota de Venta en Bsale.
              Sólo la oculta del flujo de Preparación de PetGroup y puede revertirse.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prep-exclusion-reason">Motivo *</Label>
            <Input
              id="prep-exclusion-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Detalla el motivo de la exclusión..."
              disabled={isLoading}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="prep-exclusion-observation">Observación (opcional)</Label>
            <Textarea
              id="prep-exclusion-observation"
              value={observation}
              onChange={(e) => setObservation(e.target.value)}
              placeholder="Contexto adicional, evidencia o validación manual..."
              className="resize-none h-24"
              disabled={isLoading}
            />
          </div>

          {error && <p className="text-xs text-[#8A4B4B]">{error}</p>}
        </div>

        <div className="p-4 border-t border-theme-border/50 flex justify-end gap-3 bg-theme-panel">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isLoading}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!reason.trim() || isLoading}
          >
            {isLoading ? 'Excluyendo...' : 'Excluir de preparación'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
