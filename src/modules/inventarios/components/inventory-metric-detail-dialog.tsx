'use client'

import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import {
  getActiveCompanyCampaignReadinessDetail,
  type CampaignReadinessDetailRow,
  type CampaignReadinessDetailType,
} from '@/app/actions/inventarios/campaign-report'
import { formatCLP, formatDateTimeChile, formatQuantity } from '@/modules/inventarios/lib/format'

/**
 * Estándar MYM — Drill-down de métricas / cards / KPIs.
 *
 * Contrato de uso:
 *   <MetricDetailDialog
 *     campaignId="..."
 *     title="Ubicaciones nunca visitadas"
 *     countLabel="ubicaciones"
 *     detailType="NEVER_VISITED_LOCATIONS"
 *     columns={[
 *       { key: 'bodega', label: 'Bodega / Sección', primary: true },
 *       { key: 'zona', label: 'Zona' },
 *       { key: 'ubicacion', label: 'Ubicación' },
 *       { key: 'situacion', label: 'Situación', badge: true },
 *     ]}
 *   />
 *
 * Cada columna declara su propio `key` y `label`; el tipo de dato define qué
 * columnas son relevantes. La fuente de verdad es Backend
 * (get_inventory_campaign_readiness_detail): la UI solo presenta y el total
 * mostrado coincide exactamente con el contador del indicador origen.
 *
 * Formato por columna:
 *   - primary  : texto con mayor peso y sin truncar (hasta 2 líneas).
 *   - badge    : píldora con el valor textual.
 *   - money    : formatea como CLP.
 *   - date     : formatea fecha/hora.
 *   - quantity : formatea número.
 *   - progress : muestra "visitadas / total" como progreso.
 */

export type MetricColumnKind = 'text' | 'badge' | 'money' | 'date' | 'quantity' | 'progress'

export interface MetricColumn {
  key: string
  label: string
  kind?: MetricColumnKind
  primary?: boolean
  /** Claves usadas por kind='progress' → `${valueKey} / ${totalKey}` */
  valueKey?: string
  totalKey?: string
  numeric?: boolean
}

interface MetricDetailDialogProps {
  campaignId: string
  title: string
  countLabel: string
  detailType: CampaignReadinessDetailType
  columns: MetricColumn[]
  onClose: () => void
}

function renderValue(row: CampaignReadinessDetailRow, col: MetricColumn): React.ReactNode {
  if (col.kind === 'money') {
    const v = row[col.key as keyof CampaignReadinessDetailRow] as number | null | undefined
    return <span className="text-right font-semibold text-theme-text">{formatCLP(v)}</span>
  }
  if (col.kind === 'date') {
    const v = row[col.key as keyof CampaignReadinessDetailRow] as string | null | undefined
    return <span className="whitespace-nowrap text-theme-text-muted">{formatDateTimeChile(v)}</span>
  }
  if (col.kind === 'quantity') {
    const v = row[col.key as keyof CampaignReadinessDetailRow] as number | null | undefined
    return <span className="text-right font-semibold text-theme-text">{formatQuantity(v)}</span>
  }
  if (col.kind === 'progress' && col.valueKey && col.totalKey) {
    const v = row[col.valueKey as keyof CampaignReadinessDetailRow] as number | null | undefined
    const t = row[col.totalKey as keyof CampaignReadinessDetailRow] as number | null | undefined
    return (
      <span className="whitespace-nowrap font-semibold text-theme-text">
        {formatQuantity(v)} / {formatQuantity(t)}
      </span>
    )
  }
  if (col.kind === 'badge') {
    const v = row[col.key as keyof CampaignReadinessDetailRow] as string | null | undefined
    return <span className="inline-flex items-center rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-[11px] font-medium text-theme-text-muted">{v ?? '—'}</span>
  }
  const v = row[col.key as keyof CampaignReadinessDetailRow]
  const raw = v === null || v === undefined ? null : String(v)
  return <span className={col.primary ? 'font-semibold text-theme-text' : 'text-theme-text-muted'}>{raw ?? '—'}</span>
}

export function MetricDetailDialog({ campaignId, title, countLabel, detailType, columns, onClose }: MetricDetailDialogProps) {
  const [rows, setRows] = useState<CampaignReadinessDetailRow[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await getActiveCompanyCampaignReadinessDetail(campaignId, detailType)
      if (cancelled) return
      setLoading(false)
      if (result.error || !result.data) {
        setError(result.error ?? 'No se pudo cargar el detalle.')
        return
      }
      setRows(result.data.rows)
      setCount(result.data.count)
    })()
    return () => {
      cancelled = true
    }
  }, [campaignId, detailType])

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h3 className="text-base font-bold text-theme-text">{title}</h3>
            <span className="text-xs text-theme-text-muted">{formatQuantity(count)} {countLabel}</span>
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
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-red-500/20 bg-red-500/5 px-6 text-center">
              <p className="text-sm font-semibold text-theme-text">No se pudo cargar el detalle</p>
              <p className="text-xs text-theme-text-muted/70">{error}</p>
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 text-center">
              <p className="text-sm font-semibold text-theme-text">Sin elementos para mostrar</p>
              <p className="text-xs text-theme-text-muted/70">No hay filas para este indicador.</p>
            </div>
          )}

          {!loading && !error && rows.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface shadow-sm">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                    {columns.map(col => (
                      <th key={col.key} className={col.numeric || col.kind === 'money' || col.kind === 'quantity' ? 'px-3 py-2 text-right' : 'px-3 py-2'}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-b border-theme-border/40 transition-colors hover:bg-theme-text/2">
                      {columns.map(col => (
                        <td
                          key={col.key}
                          className={
                            (col.numeric || col.kind === 'money' || col.kind === 'quantity' ? 'px-3 py-1.5 text-right' : 'px-3 py-1.5') +
                            (col.primary ? ' max-w-[240px] whitespace-normal' : ' whitespace-normal')
                          }
                          title={typeof row[col.key as keyof CampaignReadinessDetailRow] === 'string' ? String(row[col.key as keyof CampaignReadinessDetailRow]) : undefined}
                        >
                          {renderValue(row, col)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-theme-border/60 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
