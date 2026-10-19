'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Loader2, RotateCcw, ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import {
  getSalesOrderPreparationExclusions,
  revokeSalesOrderPreparationExclusion,
  type SalesOrderPreparationExclusion,
} from '@/app/actions/logistica/sales-order-preparation'

interface PreparationExclusionsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  canRevoke: boolean
  refreshToken?: number
  onChanged: () => Promise<void> | void
}

type ViewMode = 'active' | 'history'

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function PreparationExclusionsDrawer({ open, onOpenChange, canRevoke, refreshToken = 0, onChanged }: PreparationExclusionsDrawerProps) {
  const [rows, setRows] = useState<SalesOrderPreparationExclusion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('active')

  const [revokeTarget, setRevokeTarget] = useState<SalesOrderPreparationExclusion | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const result = await getSalesOrderPreparationExclusions()
    if (result.error) {
      setError(result.error)
    } else {
      setRows(result.data)
      setError(null)
    }
    setLoading(false)
  }, [])

  // Recarga al abrir o cuando una exclusión confirmada incrementa el token.
  // Si el drawer está cerrado, no se consulta el historial.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      void load()
    }
  }, [open, load, refreshToken])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleOpenChange = (next: boolean) => {
    if (isRevoking) return
    if (!next) {
      setRevokeTarget(null)
      setRevokeReason('')
      setRevokeError(null)
      setView('active')
    }
    onOpenChange(next)
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    if (!revokeReason.trim()) {
      setRevokeError('El motivo de revocación es obligatorio.')
      return
    }
    setIsRevoking(true)
    setRevokeError(null)
    try {
      const result = await revokeSalesOrderPreparationExclusion({
        bsaleNvId: revokeTarget.bsale_nv_id,
        revokedReason: revokeReason.trim(),
      })
      if (!result.ok) {
        setRevokeError(result.error || 'No se pudo revocar la exclusión.')
        return
      }
      toast.success(`NV #${revokeTarget.nv_folio} reintegrada a preparación`)
      setRevokeTarget(null)
      setRevokeReason('')
      await load()
      await onChanged()
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : 'Error de conexión.')
    } finally {
      setIsRevoking(false)
    }
  }

  const visibleRows = rows.filter((row) => (view === 'active' ? row.active : !row.active))

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden bg-theme-base border-theme-border text-theme-text">
        <div className="p-6 pb-4 border-b border-theme-border/50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <ShieldCheck className="w-5 h-5 text-[#72383D]" />
              Exclusiones de preparación
            </DialogTitle>
            <DialogDescription className="text-theme-text/70">
              Exclusiones administrativas reversibles. No anulan ni modifican la Nota de Venta en Bsale.
            </DialogDescription>
          </DialogHeader>
        </div>

        {revokeTarget ? (
          <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-5">
            <div className="bg-orange-500/10 text-orange-600 dark:text-orange-400 p-3 rounded-md flex items-start gap-2 text-sm">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <p>
                Se revocará la exclusión administrativa de la NV #{revokeTarget.nv_folio}.
                Si la NV sigue siendo elegible, volverá a aparecer en Preparación con su misma tarjeta/estado.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="prep-revoke-reason">Motivo de revocación *</Label>
              <Textarea
                id="prep-revoke-reason"
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                placeholder="Detalla por qué se reintegra la NV al flujo de preparación..."
                className="resize-none h-24"
                disabled={isRevoking}
                autoFocus
              />
            </div>
            {revokeError && <p className="text-xs text-[#8A4B4B]">{revokeError}</p>}
          </div>
        ) : (
          <>
            <div className="px-6 pt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView('active')}
                className={`px-3 py-1.5 text-[11px] font-bold border transition-colors ${view === 'active' ? 'bg-[#72383D] text-white border-transparent' : 'bg-white text-[#322D29]/60 border-[#D1C7BD] hover:bg-[#F5F0EA]'}`}
              >
                Activas ({rows.filter((row) => row.active).length})
              </button>
              <button
                type="button"
                onClick={() => setView('history')}
                className={`px-3 py-1.5 text-[11px] font-bold border transition-colors ${view === 'history' ? 'bg-[#72383D] text-white border-transparent' : 'bg-white text-[#322D29]/60 border-[#D1C7BD] hover:bg-[#F5F0EA]'}`}
              >
                Historial ({rows.filter((row) => !row.active).length})
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1">
              {loading ? (
                <div className="flex items-center justify-center py-10 text-theme-text/60">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : error ? (
                <p className="text-sm text-[#8A4B4B]">{error}</p>
              ) : visibleRows.length === 0 ? (
                <p className="py-10 text-center text-sm text-theme-text/50">
                  {view === 'active' ? 'No hay exclusiones activas.' : 'No hay exclusiones revocadas.'}
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {visibleRows.map((row) => (
                    <div key={row.id} className="border border-[#D1C7BD] bg-white p-4 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-sm text-theme-text">NV #{row.nv_folio}</p>
                          <p className="text-[10px] text-theme-text/45 font-mono">bsale_nv_id {row.bsale_nv_id}</p>
                        </div>
                        <span className={`shrink-0 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] border ${row.active ? 'border-[#72383D]/30 bg-[#F5EDE9] text-[#72383D]' : 'border-[#AC9C8D]/30 bg-[#F5F0EA] text-[#6B625C]'}`}>
                          {row.active ? 'Activa' : 'Revocada'}
                        </span>
                      </div>

                      <div className="text-xs text-theme-text/80 space-y-1">
                        <p><span className="font-semibold">Motivo:</span> {row.reason}</p>
                        {row.observation && <p><span className="font-semibold">Observación:</span> {row.observation}</p>}
                      </div>

                      <div className="text-[11px] text-theme-text/55 space-y-0.5">
                        <p>Excluyó: {row.excluded_by_name || row.excluded_by} · {formatDate(row.excluded_at)}</p>
                        {!row.active && (
                          <p>Revocó: {row.revoked_by_name || row.revoked_by} · {formatDate(row.revoked_at)}
                            {row.revoked_reason ? ` · ${row.revoked_reason}` : ''}
                          </p>
                        )}
                      </div>

                      {row.active && canRevoke && (
                        <div className="pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setRevokeTarget(row)
                              setRevokeReason('')
                              setRevokeError(null)
                            }}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Reintegrar a preparación
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div className="p-4 border-t border-theme-border/50 flex justify-end gap-3 bg-theme-panel">
          {revokeTarget ? (
            <>
              <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={isRevoking}>
                Cancelar
              </Button>
              <Button onClick={handleRevoke} disabled={!revokeReason.trim() || isRevoking}>
                {isRevoking ? 'Reintegrando...' : 'Reintegrar a preparación'}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cerrar
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
