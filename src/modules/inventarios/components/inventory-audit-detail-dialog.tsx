'use client'

import { useEffect, useState } from 'react'
import { Loader2, MapPin, X } from 'lucide-react'
import { getInventoryAuditDetail, type InventoryAuditDetail } from '@/app/actions/inventarios/audit-review'
import { formatQuantity, formatSignedQuantity } from '@/modules/inventarios/lib/format'

interface InventoryAuditDetailDialogProps {
  companyId: string
  campaignId: string
  auditId: string
  onClose: () => void
}

function statusLabel(status: string): string {
  return status === 'ASSIGNED' ? 'Asignada' : status === 'IN_PROGRESS' ? 'En progreso' : status === 'SUBMITTED' ? 'Enviada' : status
}

export function InventoryAuditDetailDialog({ companyId, campaignId, auditId, onClose }: InventoryAuditDetailDialogProps) {
  const [detail, setDetail] = useState<InventoryAuditDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getInventoryAuditDetail(companyId, campaignId, auditId).then(result => {
      if (cancelled) return
      if (result.error || !result.data) setError(result.error ?? 'No se pudo cargar el detalle de la auditoría.')
      else setDetail(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [auditId, campaignId, companyId])

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-theme-border px-4 py-3">
          <div>
            <h2 className="text-base font-bold text-theme-text">
              {detail ? `Auditoría #${detail.audit.audit_number}` : 'Detalle de auditoría'}
            </h2>
            {detail && (
              <p className="mt-0.5 text-xs text-theme-text-muted">
                {detail.audit.auditor_name ?? 'Sin asignar'} · {statusLabel(detail.audit.status)} · {detail.product_count} producto(s) · {detail.location_count} ubicación(es)
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border text-theme-text-muted hover:bg-theme-text/5">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!detail && !error && <p className="flex items-center gap-2 text-xs text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Cargando detalle…</p>}
          {error && <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
          {detail && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="Estado" value={statusLabel(detail.audit.status)} />
                <Metric label="Responsable" value={detail.audit.auditor_name ?? 'Sin asignar'} />
                <Metric label="Contadas" value={`${detail.counted_location_count}/${detail.location_count}`} />
                <Metric label="Pendientes" value={String(detail.pending_location_count)} />
              </div>
              {detail.products.map(product => (
                <section key={product.audit_product_id} className="rounded-xl border border-theme-border bg-theme-surface shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-theme-border/60 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-bold text-theme-text">{product.sku ?? '—'}</p>
                      <p className="truncate text-xs text-theme-text-muted">{product.name ?? `V${product.bsale_variant_id}`}</p>
                    </div>
                    <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">{statusLabel(product.status)}</span>
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-theme-text-muted">
                      <span>Origen diferencia: <strong className={product.difference_quantity < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}>{formatSignedQuantity(product.difference_quantity)}</strong></span>
                      <span>Auditado: {product.counted_location_count}/{product.location_count} ubicación(es)</span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {product.locations.map(location => (
                        <div key={location.audit_location_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-theme-border/70 px-2.5 py-1.5 text-xs">
                          <span className="flex items-center gap-1.5 text-theme-text"><MapPin className="h-3 w-3 text-theme-text-muted" />{location.location_name ?? location.location_code ?? 'Ubicación'}</span>
                          <span className="text-theme-text-muted">{location.status === 'COUNTED' ? `Resultado: ${formatQuantity(location.physical_quantity ?? 0)}` : 'Pendiente'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end border-t border-theme-border px-4 py-3"><button type="button" onClick={onClose} className="rounded-lg border border-theme-border px-3 py-1.5 text-sm text-theme-text-muted hover:bg-theme-text/5">Cerrar</button></div>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-theme-border bg-theme-text/[0.03] px-2.5 py-2"><p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">{label}</p><p className="mt-0.5 truncate text-xs font-semibold text-theme-text">{value}</p></div>
}
