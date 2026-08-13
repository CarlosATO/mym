'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import {
  getActiveCompanyCampaignBreakdown,
  type CampaignBreakdown,
  type CampaignBreakdownContribution,
} from '@/app/actions/inventarios/campaign-report'
import { formatCLP, formatDateTimeChile, formatQuantity, formatSignedQuantity } from '@/modules/inventarios/lib/format'

const VARIANCE_LABELS: Record<string, string> = {
  FALTANTE: 'Faltante',
  SOBRANTE: 'Sobrante',
  SIN_DIFERENCIA: 'Sin diferencia',
}

const COVERAGE_LABELS: Record<string, string> = {
  COUNTED: 'Contado',
  NOT_COUNTED: 'No contado',
  OUT_OF_SNAPSHOT: 'No incluido para conteo',
}

const METHOD_LABELS: Record<string, string> = {
  BARCODE: 'Barcode',
  SEARCH_MANUAL: 'Búsqueda manual',
  DISCOVERY: 'Descubrimiento',
  MANUAL: 'Manual',
}

function MethodBadge({ method }: { method: string | null }) {
  if (!method) return <span className="text-xs text-theme-text-muted/50">—</span>
  return <span className="text-xs text-theme-text-muted">{METHOD_LABELS[method] ?? method}</span>
}

interface InventoryCampaignReportDetailProps {
  campaignId: string
  bsaleVariantId: number
  onClose: () => void
}

export function InventoryCampaignReportDetail({ campaignId, bsaleVariantId, onClose }: InventoryCampaignReportDetailProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<CampaignBreakdown | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await getActiveCompanyCampaignBreakdown(campaignId, bsaleVariantId)
      if (cancelled) return
      setLoading(false)
      if (result.error || !result.data) {
        setError(result.error ?? 'No se pudo cargar el detalle del producto.')
        return
      }
      setData(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [campaignId, bsaleVariantId])

  const header = data?.header
  const isOutOfSnapshot = header?.coverage_status === 'OUT_OF_SNAPSHOT'
  const isNotInTheoretical = header && !header.in_theoretical_stock

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-theme-text">Detalle del producto</h3>
            {header?.sku && <span className="rounded-md bg-theme-text/5 px-2 py-0.5 text-xs font-mono text-theme-text-muted">{header.sku}</span>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar detalle"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-theme-accent" />
              <p className="text-sm text-theme-text-muted">Cargando detalle…</p>
            </div>
          )}

          {!loading && error && (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-6 py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-theme-text">No se pudo cargar el detalle</p>
              <p className="max-w-sm text-xs text-theme-text-muted/70">{error}</p>
            </div>
          )}

          {!loading && !error && header && (
            <>
              <div className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  <div>
                    <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Producto</p>
                    <p className="text-sm font-semibold text-theme-text">{header.name ?? `Producto ${header.bsale_variant_id}`}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Teórico global</p>
                    <p className="text-sm font-semibold text-theme-text">{formatQuantity(header.theoretical_quantity)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Contado global</p>
                    <p className="text-sm font-semibold text-theme-text">{formatQuantity(header.physical_quantity)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Diferencia</p>
                    <p
                      className={
                        'text-sm font-bold ' +
                        ((header.difference_quantity ?? 0) > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : (header.difference_quantity ?? 0) < 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-theme-text')
                      }
                    >
                      {formatSignedQuantity(header.difference_quantity)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Estado</p>
                    <p className="text-sm font-semibold text-theme-text">{VARIANCE_LABELS[header.variance_status] ?? header.variance_status}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Costo unitario</p>
                    <p className="text-sm font-semibold text-theme-text">{formatCLP(header.unit_cost)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Impacto</p>
                    <p
                      className={
                        'text-sm font-bold ' +
                        ((header.difference_value ?? 0) > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : (header.difference_value ?? 0) < 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-theme-text')
                      }
                    >
                      {formatCLP(header.difference_value)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Situación del conteo</p>
                    <span className="inline-flex items-center rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-xs font-medium text-theme-text-muted">
                      {COVERAGE_LABELS[header.coverage_status] ?? header.coverage_status}
                    </span>
                  </div>
                </div>

                {isOutOfSnapshot && (
                  <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Este producto forma parte del stock teórico del Inventario, pero no estuvo disponible en las secciones habilitadas
                      para captura. Su resultado económico sigue siendo{' '}
                      <strong>{VARIANCE_LABELS[header.variance_status] ?? header.variance_status}</strong>.
                    </span>
                  </p>
                )}
                {isNotInTheoretical && (
                  <p className="mt-3 flex items-start gap-2 rounded-lg border border-theme-border bg-theme-text/5 px-3 py-2 text-xs text-theme-text-muted">
                    <span>
                      El producto fue encontrado físicamente, pero no figuraba en el stock teórico cargado. Por eso su teórico es 0 y el
                      contado aparece como sobrante.
                    </span>
                  </p>
                )}
              </div>

              <h4 className="mt-4 text-sm font-bold text-theme-text">Dónde fue contado</h4>
              {data.contributions.length === 0 ? (
                <p className="mt-2 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-4 py-6 text-center text-xs text-theme-text-muted">
                  Este producto no registró conteos físicos en ninguna sección del Inventario.
                </p>
              ) : (
                <div className="mt-2 overflow-x-auto rounded-xl border border-theme-border bg-theme-surface shadow-sm">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                        <th className="px-3 py-2">Bodega / Sección</th>
                        <th className="px-3 py-2">Zona</th>
                        <th className="px-3 py-2">Ubicación</th>
                        <th className="px-3 py-2">Contador</th>
                        <th className="px-3 py-2 text-right">Cantidad</th>
                        <th className="px-3 py-2">Método</th>
                        <th className="px-3 py-2">Código escaneado</th>
                        <th className="px-3 py-2">Fecha / hora</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.contributions.map((c: CampaignBreakdownContribution, i: number) => (
                        <tr key={`${c.captured_at}-${i}`} className="border-b border-theme-border/40 transition-colors hover:bg-theme-text/2">
                          <td className="max-w-[200px] truncate px-3 py-1.5 text-theme-text">{c.session_name}</td>
                          <td className="px-3 py-1.5 text-theme-text-muted">{c.zone_code ?? '—'}</td>
                          <td className="max-w-[180px] truncate px-3 py-1.5 text-theme-text-muted">{c.location_code ?? '—'}</td>
                          <td className="px-3 py-1.5 text-theme-text-muted">{c.counted_by_name ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right font-semibold text-theme-text">{formatQuantity(c.physical_quantity)}</td>
                          <td className="px-3 py-1.5">
                            <MethodBadge method={c.identification_method} />
                          </td>
                          <td className="px-3 py-1.5 font-mono text-theme-text-muted">{c.scanned_code ?? '—'}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-theme-text-muted">{formatDateTimeChile(c.captured_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
