'use client'

import { X } from 'lucide-react'
import type { CampaignReviewSummary } from '@/app/actions/inventarios/campaign-report'
import { formatCLP, formatQuantity } from '@/modules/inventarios/lib/format'

type KpiGroup = 'stock' | 'operation'

interface InventoryKpiDetailDialogProps {
  group: KpiGroup
  summary: CampaignReviewSummary
  onClose: () => void
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'success' | 'info' | 'neutral' }) {
  const toneClass =
    tone === 'danger'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'success'
        ? 'text-emerald-600 dark:text-emerald-400'
        : tone === 'info'
          ? 'text-sky-600 dark:text-sky-400'
          : 'text-theme-text'
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-theme-border bg-theme-surface px-3 py-2">
      <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-bold ${toneClass}`}>{value}</p>
    </div>
  )
}

export function InventoryKpiDetailDialog({ group, summary, onClose }: InventoryKpiDetailDialogProps) {
  const stock = summary.stock
  const op = summary.operation
  const isStock = group === 'stock'

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <h3 className="text-base font-bold text-theme-text">
            {isStock ? 'Detalle del resultado por producto' : 'Detalle del estado del conteo'}
          </h3>
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
          {isStock && stock && (
            <div className="space-y-4">
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                  Resultado por producto
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MetricCard label="Productos teóricos" value={formatQuantity(stock.products_theoretical)} />
                  <MetricCard label="Productos contados" value={formatQuantity(stock.products_counted)} />
                  <MetricCard label="Faltantes" value={formatQuantity(stock.faltantes)} tone="danger" />
                  <MetricCard label="Sobrantes" value={formatQuantity(stock.sobrantes)} tone="success" />
                  <MetricCard label="Sin diferencia" value={formatQuantity(stock.sin_diferencia)} />
                  <MetricCard label="Con diferencia" value={formatQuantity(stock.products_with_difference)} />
                  <MetricCard label="No incluidos para conteo" value={formatQuantity(stock.out_of_snapshot)} tone="info" />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Valorización</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MetricCard label="Unidades faltantes" value={formatQuantity(stock.units_faltante)} tone="danger" />
                  <MetricCard label="Unidades sobrantes" value={formatQuantity(stock.units_sobrante)} tone="success" />
                  <MetricCard label="Valorización neta" value={formatCLP(stock.net_valuation)} />
                  <MetricCard label="Valorización absoluta" value={formatCLP(stock.absolute_valuation)} />
                </div>
              </div>
            </div>
          )}

          {!isStock && op && (
            <div className="space-y-4">
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Secciones</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MetricCard label="Secciones totales" value={formatQuantity(op.total_sessions)} />
                  <MetricCard label="Terminadas" value={formatQuantity(op.sessions_by_status.APPROVED ?? 0)} tone="success" />
                  <MetricCard
                    label="En curso"
                    value={formatQuantity((op.sessions_by_status.COUNTING ?? 0) + (op.sessions_by_status.UNDER_REVIEW ?? 0))}
                    tone="info"
                  />
                  <MetricCard
                    label="Pendientes"
                    value={formatQuantity((op.sessions_by_status.DRAFT ?? 0) + (op.sessions_by_status.PREPARED ?? 0))}
                    tone="info"
                  />
                  <MetricCard label="En revisión" value={formatQuantity(op.sessions_by_status.UNDER_REVIEW ?? 0)} />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Zonas</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MetricCard label="Zonas totales" value={formatQuantity(op.zones_total)} />
                  <MetricCard label="Completadas" value={formatQuantity(op.zones_completed)} tone="success" />
                  <MetricCard label="En curso" value={formatQuantity(op.zones_in_progress)} tone="info" />
                  <MetricCard label="No iniciadas" value={formatQuantity(op.zones_not_started)} tone="info" />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Ubicaciones</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MetricCard label="Ubicaciones totales" value={formatQuantity(op.locations_total)} />
                  <MetricCard label="Visitadas" value={formatQuantity(op.locations_visited)} />
                  <MetricCard label="Abiertas" value={formatQuantity(op.locations_open)} tone="info" />
                  <MetricCard label="Nunca visitadas" value={formatQuantity(op.locations_never_visited)} tone="info" />
                  <MetricCard label="Visitadas sin registros" value={formatQuantity(op.locations_visited_without_counts)} tone="info" />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Atención</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <MetricCard label="No incluidos para conteo" value={formatQuantity(stock.out_of_snapshot)} tone="info" />
                  <MetricCard label="Códigos pendientes" value={formatQuantity(op.pending_barcode_proposals)} tone="info" />
                  <MetricCard label="Recuentos pendientes" value={formatQuantity(op.pending_recount_count)} tone="danger" />
                  <MetricCard label="Incidentes bloqueantes" value={formatQuantity(op.blocking_incident_count)} tone="danger" />
                </div>
              </div>
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
