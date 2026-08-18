'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Barcode, Eye, Loader2, RefreshCw } from 'lucide-react'
import {
  getActiveCompanyBarcodeSummary,
  type BarcodeIncidentSummaryResult,
} from '@/app/actions/inventarios/campaign-report'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'

interface InventoryBarcodeIncidentsListProps {
  campaignId: string
  companyId: string
  initialSummary: BarcodeIncidentSummaryResult | null
  campaignStatus: string | null
}

export function InventoryBarcodeIncidentsList({
  campaignId,
  companyId,
  initialSummary,
  campaignStatus,
}: InventoryBarcodeIncidentsListProps) {
  const [summary, setSummary] = useState<BarcodeIncidentSummaryResult | null>(initialSummary)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    const result = await getActiveCompanyBarcodeSummary(campaignId)
    setLoading(false)
    if (result.error || !result.data) {
      setError(result.error ?? 'No se pudieron cargar las incidencias.')
      return
    }
    setSummary(result.data)
  }, [companyId, campaignId])

  const totals = useMemo(() => {
    const items = summary?.items ?? []
    return {
      products: items.length,
      barcodes: items.reduce((a, i) => a + i.pending_barcode_count, 0),
      locations: items.reduce((a, i) => a + i.location_count, 0),
    }
  }, [summary])

  const hasIncidents = (summary?.items?.length ?? 0) > 0

  return (
    <div className="space-y-3">
      <nav className="flex items-center gap-1.5 text-xs text-theme-text-muted">
        <Link href="/dashboard/inventarios" className="transition-colors hover:text-theme-text">
          Inventarios
        </Link>
        <span>/</span>
        <Link
          href={`/dashboard/inventarios/campanas/${campaignId}`}
          className="transition-colors hover:text-theme-text"
        >
          Inventario actual
        </Link>
        <span>/</span>
        <span className="font-medium text-theme-text">Incidencias de códigos</span>
      </nav>

      <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-bold text-theme-text">Incidencias de códigos</h1>
            <p className="text-[11px] text-theme-text-muted">Códigos de barras pendientes de revisión por producto.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {campaignStatus && <InventoryStatusBadge status={campaignStatus} />}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {loading ? 'Actualizando…' : 'Actualizar'}
            </button>
            <Link
              href={`/dashboard/inventarios/campanas/${campaignId}?tab=informe`}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Volver al informe
            </Link>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-theme-text-muted">
          <span>
            Productos con incidencias <strong className="text-theme-text">{totals.products}</strong>
          </span>
          <span>
            Códigos pendientes <strong className="text-theme-text">{totals.barcodes}</strong>
          </span>
          <span>
            Ubicaciones involucradas <strong className="text-theme-text">{totals.locations}</strong>
          </span>
        </div>
      </section>

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-theme-border bg-theme-surface px-2 py-0.5 text-[11px] font-medium text-theme-text hover:bg-theme-text/5"
          >
            Reintentar
          </button>
        </div>
      )}

      {!error && !hasIncidents && (
        <section className="flex min-h-52 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 text-center">
          <Barcode className="h-8 w-8 text-theme-text-muted/50" />
          <p className="text-sm font-semibold text-theme-text">No hay códigos pendientes de revisión.</p>
          <p className="max-w-sm text-xs text-theme-text-muted/70">
            Cuando existan códigos de barras por revisar, aparecerán agrupados por producto aquí.
          </p>
        </section>
      )}

      {hasIncidents && (
        <section className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface shadow-sm">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                <th className="px-3 py-2">SKU</th>
                <th className="px-3 py-2">Producto</th>
                <th className="px-3 py-2 text-right">Veces encontrado</th>
                <th className="px-3 py-2 text-right">Ubicaciones</th>
                <th className="px-3 py-2">Última detección</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.items ?? []).map(item => (
                <tr key={item.bsale_variant_id} className="border-b border-theme-border/40 transition-colors hover:bg-theme-text/2">
                  <td className="px-3 py-1.5 font-mono font-semibold text-theme-text">{item.sku ?? '—'}</td>
                  <td className="max-w-[340px] whitespace-normal px-3 py-1.5 text-theme-text">{item.product_name ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-theme-text">{item.occurrence_count}</td>
                  <td className="px-3 py-1.5 text-right text-theme-text-muted">{item.location_count}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-theme-text-muted">{formatDateTimeChile(item.latest_detected_at)}</td>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                      Pendiente
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <Link
                      href={`/dashboard/inventarios/campanas/${campaignId}/incidencias-codigos/${item.bsale_variant_id}`}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Ver detalle
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
