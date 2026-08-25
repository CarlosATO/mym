'use client'

import { useState } from 'react'
import { AlertTriangle, LockKeyhole } from 'lucide-react'
import { closeRouteSettlement, type RouteSettlementDetail } from '@/app/actions/adquisiciones/rendicion-rutas'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function RouteSettlementCloseDialog({
  settlement,
  open,
  onOpenChange,
  onClosed,
}: {
  settlement: RouteSettlementDetail['settlement']
  open: boolean
  onOpenChange: (open: boolean) => void
  onClosed: () => Promise<void>
}) {
  const [isClosing, setIsClosing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resultLabel = financialResultLabel(settlement.derived_financial_result ?? settlement.financial_result)

  async function handleClose() {
    setIsClosing(true)
    setError(null)
    const result = await closeRouteSettlement(settlement.id)
    if (result.error) {
      setError(result.error)
      setIsClosing(false)
      return
    }
    onOpenChange(false)
    setIsClosing(false)
    await onClosed()
  }

  return (
    <Dialog open={open} onOpenChange={openState => { if (!isClosing) onOpenChange(openState) }}>
      <DialogContent className="max-w-md border-theme-border bg-theme-surface text-theme-text">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-theme-text"><LockKeyhole className="h-4 w-4 text-theme-text-muted" />Cerrar rendición</DialogTitle>
          <DialogDescription className="text-theme-text-muted">{settlement.settlement_number}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-theme-border px-3 py-3">
            <Metric label="Facturas" value={settlement.invoice_count} />
            <Metric label="Resueltas" value={`${settlement.resolved_invoice_count} / ${settlement.invoice_count}`} />
            <Metric label="Pagadas" value={settlement.paid_count} />
            <Metric label="Pago pendiente" value={settlement.pending_payment_count} />
            <Metric label="Crédito" value={settlement.credit_count} />
            <Metric label="No entregadas" value={settlement.not_delivered_count} />
          </div>
          <div className="rounded-lg bg-theme-text/[0.03] px-3 py-2">
            <span className="text-theme-text-muted">Resultado previsto</span>
            <p className="mt-0.5 font-semibold text-theme-text">{resultLabel}</p>
          </div>
          <p className="leading-5 text-theme-text-muted">Después de cerrar la rendición no podrás modificar pagos ni situaciones de facturas mediante el flujo normal.</p>
        </div>

        {error && <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}
        <DialogFooter className="border-theme-border bg-theme-text/[0.02]">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isClosing}>Cancelar</Button>
          <Button type="button" onClick={handleClose} disabled={isClosing}>{isClosing ? 'Cerrando...' : 'Cerrar rendición'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-0.5 font-semibold tabular-nums text-theme-text">{value}</p></div>
}

export function financialResultLabel(result: string | null) {
  if (result === 'WITH_PENDING') return 'Con pagos pendientes'
  if (result === 'WITH_DIFFERENCE') return 'Con diferencia'
  return 'Cuadrada'
}
