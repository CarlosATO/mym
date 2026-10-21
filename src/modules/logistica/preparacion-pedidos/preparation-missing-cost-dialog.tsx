'use client'

import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatPreparationClp } from './preparation-board-utils'
import type { PreparationMissingCostLineV1 } from './preparation-profitability'

interface PreparationMissingCostDialogProps {
  open: boolean
  loading: boolean
  error: string | null
  rows: PreparationMissingCostLineV1[]
  missingNvCount: number
  missingNetAmount: number
  onOpenChange: (open: boolean) => void
}

export function PreparationMissingCostDialog({
  open,
  loading,
  error,
  rows,
  missingNvCount,
  missingNetAmount,
  onOpenChange,
}: PreparationMissingCostDialogProps) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!loading) onOpenChange(next) }}>
      <DialogContent
        className="flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-xl border border-[#DDD4CA] bg-[#FCFBF9] p-0 text-theme-text shadow-xl ring-0"
        style={{ maxWidth: '1040px' }}
      >
        <div className="border-b border-[#E8DFD5] px-5 pb-3 pt-4">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Costos faltantes</DialogTitle>
            <DialogDescription className="text-xs text-theme-text/65">
              {missingNvCount} NV · {formatPreparationClp(missingNetAmount)} sin costo identificado
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {error && <p className="mb-3 rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-3 py-2 text-xs text-[#8A4B4B]">{error}</p>}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-theme-text-muted">
              <Loader2 className="h-4 w-4 animate-spin text-[#72383D]" /> Cargando artículos sin costo…
            </div>
          ) : rows.length === 0 && !error ? (
            <div className="rounded-lg border border-dashed border-[#DDD4CA] px-4 py-10 text-center text-xs text-theme-text-muted">
              No hay artículos sin costo para las NV visibles.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left">
                <thead>
                  <tr className="border-y border-[#E8DFD5] bg-[#F8F5F1]/70 text-[9px] font-bold uppercase tracking-wider text-[#6B625C]">
                    <th className="w-[88px] px-3 py-2">NV</th>
                    <th className="w-[110px] px-3 py-2">SKU</th>
                    <th className="px-3 py-2">Producto</th>
                    <th className="w-[64px] px-2 py-2 text-center">Cant.</th>
                    <th className="w-[104px] px-3 py-2 text-right">Venta neta</th>
                    <th className="w-[116px] px-3 py-2">Situación</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={`${row.bsale_nv_id}-${row.sku ?? ''}-${row.product_name}-${row.variant_id ?? ''}`} className="border-b border-[#E8DFD5] last:border-0 hover:bg-white/60">
                      <td className="whitespace-nowrap px-3 py-2 text-xs font-bold tabular-nums text-theme-text">NV #{row.nv_folio ?? row.bsale_nv_id}</td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-theme-text">{row.sku || '—'}</td>
                      <td className="px-3 py-2 text-xs text-theme-text">
                        <span className="block max-w-[520px] truncate" title={row.product_name}>{row.product_name}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-center text-xs font-bold tabular-nums text-theme-text">{row.quantity}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-xs font-semibold tabular-nums text-theme-text">{formatPreparationClp(Number(row.line_net_amount))}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-[10px] font-semibold text-amber-800">
                        Sin costo válido
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-[#E8DFD5] px-5 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={loading}>Cerrar</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
