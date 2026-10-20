'use client'

import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { SalesOrderAuditFinalization } from '@/app/actions/logistica/sales-order-audit'
import { auditBlockerMessages } from './audit-ui-utils'

interface AuditCloseReviewDialogProps {
  open: boolean
  loading: boolean
  error: string | null
  finalization: SalesOrderAuditFinalization | null
  summary: {
    totalLines: number
    auditedLines: number
    conformingLines: number
    incidentLines: number
    openIncidents: number
    requested: number
    prepared: number
    audited: number
  }
  packageCount: number | null
  hasGlobalPhoto: boolean
  finalizing: boolean
  finalizeError: string | null
  onOpenChange: (open: boolean) => void
  onFinalize: () => Promise<{ ok: boolean; error?: string }>
}

export function AuditCloseReviewDialog({
  open,
  loading,
  error,
  finalization,
  summary,
  packageCount,
  hasGlobalPhoto,
  finalizing,
  finalizeError,
  onOpenChange,
  onFinalize,
}: AuditCloseReviewDialogProps) {
  const ready = finalization?.can_finalize === true
  const busy = loading || finalizing
  const blockers = finalization ? auditBlockerMessages(finalization.blockers) : []

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[660px] max-h-[90vh] flex flex-col gap-0 overflow-hidden border-theme-border bg-theme-base p-0 text-theme-text">
        <div className="border-b border-theme-border/50 px-6 pb-4 pt-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              {loading
                ? <Loader2 className="h-5 w-5 animate-spin text-[#72383D]" />
                : ready
                  ? <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  : <ShieldAlert className="h-5 w-5 text-amber-600" />}
              {loading ? 'Revisando cierre…' : ready ? '✓ Auditoría lista para finalizar' : 'Auditoría aún no puede cerrar'}
            </DialogTitle>
            <DialogDescription className="text-xs text-theme-text/70">
              {ready
                ? 'La finalización completa la Auditoría y mueve la tarjeta a Auditadas.'
                : 'Esta revisión no cambia el estado de la tarjeta ni completa la Auditoría.'}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {error && <p className="rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-3 py-2 text-xs text-[#8A4B4B]">{error}</p>}
          {finalizeError && <p className="rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-3 py-2 text-xs text-[#8A4B4B]">{finalizeError}</p>}

          {loading && !finalization ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-theme-text-muted">
              <Loader2 className="h-4 w-4 animate-spin text-[#72383D]" /> Validando requisitos de cierre…
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-[#DDD4CA] bg-white px-4 py-3">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold tabular-nums text-theme-text">
                  <span>{summary.auditedLines}/{summary.totalLines} líneas</span>
                  <span className="text-theme-text-muted">·</span>
                  <span className="text-emerald-700">{summary.conformingLines} conformes</span>
                  <span className="text-theme-text-muted">·</span>
                  <span className={summary.openIncidents > 0 ? 'text-[#8A4B4B]' : 'text-theme-text'}>{summary.openIncidents} incidencias</span>
                  <span className="text-theme-text-muted">·</span>
                  <span>{packageCount == null ? 'Sin bultos' : `${packageCount} bultos`}</span>
                </p>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-theme-text-muted">
                  <span>Solicitado {summary.requested}</span>
                  <span>·</span>
                  <span>Preparado {summary.prepared}</span>
                  <span>·</span>
                  <span>Auditado {summary.audited}</span>
                  <span>·</span>
                  <span>Foto general: {hasGlobalPhoto ? 'Sí' : 'No'}</span>
                </p>
              </div>

              {!loading && finalization && (
                ready ? (
                  <div className="rounded-lg border border-emerald-300/70 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
                    La Auditoría cumple todos los requisitos de cierre.
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    <p className="font-bold">Requisitos pendientes</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {blockers.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
                    </ul>
                  </div>
                )
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-theme-border/50 bg-theme-panel px-4 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {ready ? 'Cancelar' : 'Cerrar'}
          </Button>
          {ready && (
            <Button onClick={() => void onFinalize()} disabled={busy}>
              {finalizing ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Finalizando…</> : 'Finalizar Auditoría'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
