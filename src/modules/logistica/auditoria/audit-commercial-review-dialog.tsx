'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { previewSalesOrderAuditCommercialAcceptance } from '@/app/actions/logistica/sales-order-audit-commercial-preview'
import { confirmSalesOrderAuditCommercialAcceptance } from '@/app/actions/logistica/sales-order-audit-commercial-confirm'
import { acceptCommercialReview, loadCommercialReview, type CommercialPreview } from './audit-commercial-review-flow'

type Props = { open: boolean; companyId: string; cardId: string; auditId: string; onOpenChange: (open: boolean) => void; onAccepted: (status: 'ACCEPTED' | 'ALREADY_ACCEPTED') => void }
const money = (value: number | null) => value == null ? 'No disponible' : `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 20 }).format(value)}`
const reason: Record<string, string> = {
  TAX_EVIDENCE_INCOMPLETE_OR_AMBIGUOUS: 'La evidencia tributaria está incompleta o es ambigua.', IDENTITY_AMBIGUOUS: 'La identidad comercial es ambigua.', AUDITED_QUANTITIES_MISMATCH: 'Las cantidades vigentes no coinciden con lo auditado.', DISCOUNT_EVIDENCE_MISSING: 'Falta evidencia verificable del descuento.', DISCOUNT_CHANGED: 'El descuento no cumple el criterio permitido.', UNIT_PRICE_CHANGED_OR_MISSING: 'El precio unitario cambió o no está disponible.', TAX_AMOUNT_INVALID: 'El impuesto no coincide con la tasa comprobada.', NET_AMOUNT_INVALID: 'El neto de una línea no es válido.', NET_AMOUNT_NOT_PROPORTIONAL: 'El neto no es proporcional a la cantidad.', GROSS_AMOUNT_INVALID: 'El total de una línea no es coherente.', UNSUPPORTED_COMMERCIAL_CHANGE: 'El cambio comercial requiere otra resolución.',
}

function VersionTable({ title, version, changed }: { title: string; version: CommercialPreview['comparison']['previous']; changed: Set<number> }) {
  return <section className="space-y-2">
    <h3 className="font-bold text-theme-text">{title}</h3>
    <div className="hidden overflow-x-auto rounded-lg border border-[#DDD4CA] bg-white lg:block">
      <table className="w-full min-w-[760px] text-left text-xs">
        <thead><tr className="border-b bg-[#F8F5F1]"><th className="p-2">Producto</th><th className="p-2">Estado</th><th className="p-2">Cantidad</th><th className="p-2">Precio neto</th><th className="p-2">Neto</th><th className="p-2">Descuento neto</th><th className="p-2">Impuesto</th><th className="p-2">Total</th></tr></thead>
        <tbody>{version.lines.map((line, index) => <tr key={`${line.variantId}-${index}`} className={`border-b last:border-0 ${line.variantId != null && changed.has(line.variantId) ? 'bg-amber-50' : ''}`}>
          <td className="p-2"><span className="font-semibold">{line.sku || 'Sin SKU'}</span><br />{line.productName || 'Sin descripción'}</td>
          <td className="p-2">{line.variantId != null && changed.has(line.variantId) ? 'Modificado' : 'Sin cambios'}</td>
          <td className="p-2 tabular-nums">{line.quantity ?? '—'}</td><td className="p-2">{money(line.unitNetValue)}</td><td className="p-2">{money(line.lineNetAmount)}</td><td className="p-2">{money(line.netDiscount)}</td><td className="p-2">{money(line.lineTaxAmount)}</td><td className="p-2">{money(line.lineGrossAmount)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="space-y-2 lg:hidden">
      {version.lines.map((line, index) => {
        const modified = line.variantId != null && changed.has(line.variantId)
        return <div key={`${line.variantId}-${index}`} className={`rounded-lg border p-3 text-xs ${modified ? 'border-amber-300 bg-amber-50' : 'border-[#DDD4CA] bg-white'}`}>
          <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-bold">{line.sku || 'Sin SKU'}</p><p>{line.productName || 'Sin descripción'}</p></div><span className={`rounded px-2 py-0.5 font-semibold ${modified ? 'bg-amber-100 text-amber-900' : 'bg-[#F8F5F1] text-[#6B625C]'}`}>{modified ? 'Modificado' : 'Sin cambios'}</span></div>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums">
            <div><dt>Cantidad</dt><dd className="font-semibold">{line.quantity ?? '—'}</dd></div><div><dt>Precio neto</dt><dd className="font-semibold">{money(line.unitNetValue)}</dd></div>
            <div><dt>Neto</dt><dd className="font-semibold">{money(line.lineNetAmount)}</dd></div><div><dt>Descuento neto</dt><dd className="font-semibold">{money(line.netDiscount)}</dd></div>
            <div><dt>Impuesto</dt><dd className="font-semibold">{money(line.lineTaxAmount)}</dd></div><div><dt>Total</dt><dd className="font-semibold">{money(line.lineGrossAmount)}</dd></div>
          </dl>
        </div>
      })}
    </div>
    <p className="text-xs tabular-nums">Neto <strong>{money(version.netAmount)}</strong> · Impuestos <strong>{money(version.taxAmount)}</strong> · Total <strong>{money(version.totalAmount)}</strong></p>
  </section>
}

export function AuditCommercialReviewDialog({ open, companyId, cardId, auditId, onOpenChange, onAccepted }: Props) {
  const [preview, setPreview] = useState<CommercialPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const acceptingRef = useRef(false)
  const refresh = useCallback(async () => {
    const seq = ++sequence.current
    setPreview(null); setApproved(false); setError(null); setLoading(true)
    try {
      const result = await loadCommercialReview({ companyId, cardId, auditId }, previewSalesOrderAuditCommercialAcceptance)
      if (seq === sequence.current) setPreview(result)
    } catch (cause) {
      if (seq === sequence.current) setError(cause instanceof Error ? cause.message : 'No se pudo revisar el cambio comercial.')
    } finally { if (seq === sequence.current) setLoading(false) }
  }, [companyId, cardId, auditId])
  useEffect(() => {
    if (open) void refresh()
    return () => { sequence.current += 1 }
  }, [open, refresh])
  const accept = async () => {
    if (acceptingRef.current) return
    acceptingRef.current = true; setAccepting(true); setError(null)
    try {
      const result = await acceptCommercialReview({ companyId, cardId, auditId }, preview, approved, confirmSalesOrderAuditCommercialAcceptance)
      setPreview(null); setApproved(false); onAccepted(result.status)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'No se pudo aceptar el cambio comercial.'
      setError(message)
      if (message.includes('Vuelve a revisar')) setPreview(null)
      setApproved(false)
    } finally { acceptingRef.current = false; setAccepting(false) }
  }
  const changed = new Set(preview?.differences.flatMap(difference => [difference.previous?.variantId, difference.current?.variantId].filter((value): value is number => value != null)) ?? [])
  return <Dialog open={open} onOpenChange={next => { if (!accepting) { if (!next) { sequence.current += 1; setPreview(null); setApproved(false) } onOpenChange(next) } }}>
    <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-[960px] flex-col overflow-hidden border-theme-border bg-theme-base p-0 sm:max-w-[960px]">
      <DialogHeader className="shrink-0 border-b px-4 py-4 pr-12 sm:px-6 sm:pr-12"><DialogTitle>Revisar cambio comercial</DialogTitle><DialogDescription>Compara la versión aceptada con la vigente en Bsale antes de autorizar el cambio.</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm sm:px-6">
        {loading && <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Consultando Bsale…</p>}
        {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-800">{error}</p>}
        {preview && <>
          <VersionTable title="Versión comercial anterior" version={preview.comparison.previous} changed={changed} />
          <VersionTable title="Versión vigente en Bsale" version={preview.comparison.current} changed={changed} />
          {preview.errors.length > 0 && <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-3"><p className="font-semibold">No es posible aceptar este cambio:</p><ul className="list-disc pl-5">{preview.errors.map(item => <li key={item}>{reason[item] ?? item}</li>)}</ul></div>}
          {!preview.historicalTaxRateCertified && <p className="rounded border border-amber-300 bg-amber-50 p-3">La tasa tributaria histórica por línea no está certificada.</p>}
          {preview.eligible && preview.reviewedReference && <label className="flex items-start gap-2 rounded border border-[#DDD4CA] bg-white p-3"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} disabled={accepting} /><span>Confirmo que revisé las versiones y autorizo aceptar la versión vigente. La aceptación quedará registrada con mi usuario.</span></label>}
        </>}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-theme-panel px-4 py-3">
        <Button variant="outline" disabled={loading || accepting} onClick={() => onOpenChange(false)}>Cerrar</Button>
        {error && <Button variant="outline" disabled={loading || accepting} onClick={() => void refresh()}>Volver a revisar</Button>}
        {preview?.eligible && preview.reviewedReference && <Button disabled={!approved || loading || accepting} onClick={() => void accept()}>{accepting ? 'Aceptando…' : 'Aceptar nueva versión comercial'}</Button>}
      </div>
    </DialogContent>
  </Dialog>
}
