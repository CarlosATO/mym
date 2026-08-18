'use client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Camera, Eye, Loader2, X } from 'lucide-react'
import type { CampaignSortBy, CampaignSortDirection, CampaignVarianceItem } from '@/app/actions/inventarios/campaign-report'
import { getActiveCompanyBarcodeEvidence } from '@/app/actions/inventarios/campaign-report'
import { formatCLP, formatQuantity, formatSignedQuantity } from '@/modules/inventarios/lib/format'

const VARIANCE_LABELS: Record<string, string> = {
  FALTANTE: 'Faltante',
  SOBRANTE: 'Sobrante',
  SIN_DIFERENCIA: 'Sin diferencia',
  SIN_CONTEO: 'Pendiente',
}

const COVERAGE_LABELS: Record<string, string> = {
  COUNTED: 'Contado',
  NOT_COUNTED: 'No contado',
  OUT_OF_SNAPSHOT: 'No incluido para conteo',
}

function VarianceBadge({ status }: { status: string }) {
  const tone =
    status === 'SOBRANTE'
      ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:text-emerald-300 dark:bg-emerald-400/10'
      : status === 'FALTANTE'
        ? 'bg-red-500/10 text-red-700 border-red-500/25 dark:text-red-300 dark:bg-red-400/10'
        : 'bg-slate-500/10 text-slate-700 border-slate-500/20 dark:text-slate-300 dark:bg-slate-400/10'
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone}`}>
      {VARIANCE_LABELS[status] ?? status}
    </span>
  )
}

function CoverageBadge({ status }: { status: string }) {
  const tone =
    status === 'OUT_OF_SNAPSHOT'
      ? 'bg-violet-500/10 text-violet-700 border-violet-500/25 dark:text-violet-300 dark:bg-violet-400/10'
      : status === 'NOT_COUNTED'
        ? 'bg-slate-500/10 text-slate-700 border-slate-500/20 dark:text-slate-300 dark:bg-slate-400/10'
        : 'bg-sky-500/10 text-sky-700 border-sky-500/20 dark:text-sky-300 dark:bg-sky-400/10'
  return (
    <span
      title={
        status === 'OUT_OF_SNAPSHOT'
          ? 'El producto existe en el stock teórico, pero no estuvo disponible en las secciones para ser contado.'
          : undefined
      }
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone}`}
    >
      {COVERAGE_LABELS[status] ?? status}
    </span>
  )
}

type SortKey = CampaignSortBy

const SORTABLE: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
  { key: 'SKU', label: 'SKU' },
  { key: 'NAME', label: 'Producto' },
  { key: 'THEORETICAL', label: 'Teórico', numeric: true },
  { key: 'PHYSICAL', label: 'Contado', numeric: true },
  { key: 'DIFFERENCE', label: 'Diferencia', numeric: true },
  { key: 'VARIANCE_STATUS', label: 'Estado' },
  { key: 'COVERAGE_STATUS', label: 'Situación' },
  { key: 'UNIT_COST', label: 'Costo u.', numeric: true },
  { key: 'DIFFERENCE_VALUE', label: 'Impacto', numeric: true },
]

function SortButton({
  column,
  current,
  direction,
  onSort,
}: {
  column: (typeof SORTABLE)[number]
  current: CampaignSortBy | ''
  direction: CampaignSortDirection | ''
  onSort: (key: CampaignSortBy) => void
}) {
  const active = current === column.key
  return (
    <button
      type="button"
      onClick={() => onSort(column.key)}
      title={`Ordenar por ${column.label}`}
      className={`inline-flex items-center gap-1 ${
        column.numeric ? 'w-full justify-end' : 'w-full justify-start'
      } transition-colors hover:text-theme-text`}
    >
      {column.label}
      {active && direction === 'ASC' ? (
        <ArrowUp className="h-3 w-3 text-theme-accent" />
      ) : active && direction === 'DESC' ? (
        <ArrowDown className="h-3 w-3 text-theme-accent" />
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  )
}

interface InventoryCampaignReportTableProps {
  items: CampaignVarianceItem[]
  campaignId: string
  onSelect: (bsaleVariantId: number) => void
  sortBy: CampaignSortBy | ''
  sortDirection: CampaignSortDirection | ''
  onSort: (key: CampaignSortBy) => void
}

export function InventoryCampaignReportTable({ items, campaignId, onSelect, sortBy, sortDirection, onSort }: InventoryCampaignReportTableProps) {
  const [evidence, setEvidence] = useState<EvidenceViewerState | null>(null)

  const openEvidence = async (item: CampaignVarianceItem) => {
    if (!item.evidence_id) return
    setEvidence({ item, loading: true, signedUrl: null, error: null })
    const result = await getActiveCompanyBarcodeEvidence(campaignId, item.evidence_id)
    setEvidence(prev =>
      prev && prev.item.bsale_variant_id === item.bsale_variant_id
        ? {
            item,
            loading: false,
            signedUrl: result.data?.signed_url ?? null,
            error:
              result.error ??
              (result.data?.signed_url ? null : 'No se pudo acceder a la evidencia de este producto.'),
          }
        : prev
    )
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 py-10 text-center">
        <p className="text-sm font-semibold text-theme-text">Sin productos para mostrar</p>
        <p className="mt-1 text-xs text-theme-text-muted/70">Ajusta los filtros para ver otros productos del inventario.</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface shadow-sm">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-theme-border/60 text-left text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
            {SORTABLE.map(col => (
              <th key={col.key} className={col.numeric ? 'px-2 py-1.5 text-right' : 'px-2 py-1.5'}>
                <SortButton column={col} current={sortBy} direction={sortDirection} onSort={onSort} />
              </th>
            ))}
            <th className="px-2 py-1.5">Código Bsale</th>
            <th className="px-2 py-1.5">Códigos adicionales</th>
            <th className="px-2 py-1.5 text-right">Acción</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const diff = item.difference_quantity
            return (
              <tr key={item.product_key} className="border-b border-theme-border/40 transition-colors hover:bg-theme-text/2">
                <td className="px-2 py-1 font-mono font-semibold text-theme-text">{item.sku ?? '—'}</td>
                <td className="max-w-[200px] truncate px-2 py-1 text-theme-text">{item.name ?? '—'}</td>
                <td className="px-2 py-1 text-right text-theme-text-muted">{formatQuantity(item.theoretical_quantity)}</td>
                <td className="px-2 py-1 text-right text-theme-text-muted">{formatQuantity(item.physical_quantity)}</td>
                <td
                  className={
                    'px-2 py-1 text-right font-semibold ' +
                    (diff === null
                      ? 'text-theme-text-muted'
                      : diff > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : diff < 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-theme-text')
                  }
                >
                  {diff === null ? '—' : formatSignedQuantity(diff)}
                </td>
                <td className="px-2 py-1">
                  <VarianceBadge status={item.variance_status} />
                </td>
                <td className="px-2 py-1">
                  <CoverageBadge status={item.coverage_status} />
                </td>
                <td className="px-2 py-1 text-right text-theme-text-muted">{formatCLP(item.unit_cost)}</td>
                <td
                  className={
                    'px-2 py-1 text-right font-semibold ' +
                    ((item.difference_value ?? 0) > 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : (item.difference_value ?? 0) < 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-theme-text')
                  }
                >
                  {item.difference_value === null ? '—' : formatCLP(item.difference_value)}
                </td>
                <td className="px-2 py-1 font-mono text-theme-text-muted">
                  {item.barcode ?? '—'}
                </td>
                <td className="max-w-[180px] px-2 py-1 font-mono text-theme-text">
                  {(item.approved_barcodes ?? []).length > 0 ? (item.approved_barcodes ?? []).join(', ') : '—'}
                </td>
                <td className="px-2 py-1 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {item.has_evidence && item.evidence_id && (
                      <button
                        type="button"
                        onClick={() => openEvidence(item)}
                        title="Ver evidencia fotográfica del producto"
                        aria-label={`Ver evidencia de ${item.name ?? item.sku}`}
                        className="inline-flex h-6 items-center gap-1 rounded-md border border-sky-500/25 bg-sky-500/10 px-1.5 text-[11px] font-medium text-sky-700 transition-colors hover:bg-sky-500/20 dark:text-sky-300"
                      >
                        <Camera className="h-3 w-3" />
                        Foto
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onSelect(item.bsale_variant_id)}
                      className="inline-flex h-6 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-1.5 text-[11px] font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                    >
                      <Eye className="h-3 w-3" />
                      Ver detalle
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {evidence && (
        <EvidenceViewer
          item={evidence.item}
          signedUrl={evidence.signedUrl}
          loading={evidence.loading}
          error={evidence.error}
          onClose={() => setEvidence(null)}
        />
      )}
    </div>
  )
}

interface EvidenceViewerState {
  item: CampaignVarianceItem
  loading: boolean
  signedUrl: string | null
  error: string | null
}

function EvidenceViewer({
  item,
  signedUrl,
  loading,
  error,
  onClose,
}: {
  item: CampaignVarianceItem
  signedUrl: string | null
  loading: boolean
  error: string | null
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-theme-text">Evidencia fotográfica</h3>
            <p className="mt-0.5 truncate text-xs text-theme-text-muted">
              <span className="font-mono">{item.sku ?? '—'}</span> · {item.name ?? `V${item.bsale_variant_id}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-72 flex-1 items-center justify-center overflow-y-auto bg-theme-bg p-4">
          {loading ? (
            <p className="flex items-center gap-1.5 text-xs text-theme-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Cargando evidencia…
            </p>
          ) : error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : signedUrl ? (
            <img src={signedUrl} alt={`Evidencia de ${item.name ?? item.sku}`} className="max-h-[70vh] w-auto rounded-lg border border-theme-border" />
          ) : (
            <p className="text-sm text-theme-text-muted">No se pudo acceder a la evidencia.</p>
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
