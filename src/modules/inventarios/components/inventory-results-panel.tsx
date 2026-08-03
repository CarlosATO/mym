import Link from 'next/link'
import { FileCheck2, Package, Search } from 'lucide-react'
import type { InventoryResultsResult } from '@/app/actions/inventarios/results'
import { InventoryPagination } from '@/modules/inventarios/components/inventory-pagination'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'

interface InventoryResultsPanelProps {
  sessionId: string
  results: InventoryResultsResult
  search: string
  differenceType: string
}

function formatQuantity(value: number): string {
  return value.toLocaleString('es-CL', { maximumFractionDigits: 3 })
}

function DifferenceBadge({ type }: { type: string }) {
  if (type === 'FALTANTE') {
    return <span className="inline-flex items-center rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">Faltante</span>
  }
  if (type === 'SOBRANTE') {
    return <span className="inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">Sobrante</span>
  }
  return <span className="inline-flex items-center rounded-full border border-slate-500/20 bg-slate-500/10 px-2 py-0.5 text-xs font-medium text-slate-700 dark:text-slate-300">Sin diferencia</span>
}

const DIFFERENCE_TABS = [
  { value: '', label: 'Todos' },
  { value: 'FALTANTE', label: 'Faltantes' },
  { value: 'SOBRANTE', label: 'Sobrantes' },
  { value: 'SIN_DIFERENCIA', label: 'Sin diferencia' },
]

export function InventoryResultsPanel({ sessionId, results, search, differenceType }: InventoryResultsPanelProps) {
  const { summary, items, total, page_size } = results
  const version = results.official_version
  const session = results.session

  const buildHref = (targetPage: number) => {
    const sp = new URLSearchParams()
    sp.set('tab', 'resultados')
    if (search) sp.set('q', search)
    if (differenceType) sp.set('dif', differenceType)
    sp.set('page', String(targetPage))
    return `/dashboard/inventarios/jornadas/${sessionId}?${sp.toString()}`
  }

  const buildFilterHref = (dif: string) => {
    const sp = new URLSearchParams()
    sp.set('tab', 'resultados')
    if (search) sp.set('q', search)
    if (dif) sp.set('dif', dif)
    return `/dashboard/inventarios/jornadas/${sessionId}?${sp.toString()}`
  }

  const status = session.status
  const isExported = status === 'EXPORTED'
  const isReconciled = status === 'RECONCILED'

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Productos contados</p>
          <p className="mt-1 text-xl font-bold text-theme-text">{summary.product_count}</p>
        </div>
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Sin diferencia</p>
          <p className="mt-1 text-xl font-bold text-theme-text">{summary.no_difference}</p>
        </div>
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Con faltante</p>
          <p className="mt-1 text-xl font-bold text-red-600 dark:text-red-400">{summary.missing}</p>
        </div>
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Con sobrante</p>
          <p className="mt-1 text-xl font-bold text-emerald-600 dark:text-emerald-400">{summary.surplus}</p>
        </div>
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Diferencia absoluta</p>
          <p className="mt-1 text-xl font-bold text-theme-text">{formatQuantity(summary.absolute_difference_total)}</p>
        </div>
      </div>

      {/* Datos de aprobación */}
      <div className="flex flex-col gap-2 rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5 text-theme-text">
            <FileCheck2 className="h-4 w-4 text-emerald-500" />
            <span className="font-semibold">Versión oficial {version?.version_number ?? '—'}</span>
          </span>
          {version?.approved_at && (
            <span className="text-theme-text-muted">
              Aprobada el {formatDateTimeChile(version.approved_at)}
              {version.approved_by_name ? ` por ${version.approved_by_name}` : ''}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-theme-text-muted">Estado actual:</span>
          <InventoryStatusBadge status={status} />
          {!isExported && !isReconciled && (
            <span className="text-theme-text-muted/70">Exportación y conciliación pendientes.</span>
          )}
          {isExported && !isReconciled && (
            <span className="text-theme-text-muted/70">Exportada, conciliación pendiente.</span>
          )}
          {isReconciled && (
            <span className="text-theme-text-muted/70">Exportada y conciliada.</span>
          )}
        </div>
      </div>

      {/* Filtros */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            {DIFFERENCE_TABS.map(tab => (
              <Link
                key={tab.value}
                href={buildFilterHref(tab.value)}
                className={
                  differenceType === tab.value
                    ? 'inline-flex h-7 items-center rounded-lg bg-theme-accent/10 px-2.5 text-xs font-semibold text-theme-accent'
                    : 'inline-flex h-7 items-center rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text'
                }
              >
                {tab.label}
              </Link>
            ))}
          </div>
          <form action={`/dashboard/inventarios/jornadas/${sessionId}`} className="flex items-center gap-2">
            <input type="hidden" name="tab" value="resultados" />
            {differenceType && <input type="hidden" name="dif" value={differenceType} />}
            <div className="relative flex-1 md:w-56">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/60" />
              <input
                name="q"
                defaultValue={search}
                placeholder="Buscar por SKU o producto"
                className="h-8 w-full rounded-lg border border-theme-border bg-theme-bg pl-7 pr-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
                aria-label="Buscar producto"
              />
            </div>
            <button
              type="submit"
              className="inline-flex h-8 items-center rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
            >
              Buscar
            </button>
          </form>
        </div>
      </div>

      {/* Tabla */}
      <div className="rounded-xl border border-theme-border bg-theme-surface shadow-sm">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
            <Package className="h-6 w-6 text-theme-text-muted/40" />
            <p className="text-sm font-medium text-theme-text-muted">Sin resultados para los filtros aplicados.</p>
            {(search || differenceType) && (
              <Link href={buildHref(1)} className="text-xs font-semibold text-theme-accent hover:underline">
                Limpiar filtros
              </Link>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                  <th className="px-3 py-2.5">SKU</th>
                  <th className="px-3 py-2.5">Producto</th>
                  <th className="px-3 py-2.5 text-right">Teórico</th>
                  <th className="px-3 py-2.5 text-right">Físico</th>
                  <th className="px-3 py-2.5 text-right">Diferencia</th>
                  <th className="px-3 py-2.5">Clasificación</th>
                  <th className="px-3 py-2.5">Origen</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={`${item.sku}-${item.product}`} className="border-b border-theme-border/40 last:border-0 hover:bg-theme-text/2">
                    <td className="max-w-[120px] truncate px-3 py-2 font-mono text-xs text-theme-text-muted">{item.sku}</td>
                    <td className="max-w-[260px] truncate px-3 py-2">
                      <span className="font-medium text-theme-text">{item.product}</span>
                      {item.barcode && <span className="ml-2 text-xs text-theme-text-muted/60">{item.barcode}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-theme-text-muted">{formatQuantity(item.theoretical)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-theme-text">{formatQuantity(item.physical)}</td>
                    <td
                      className={
                        item.difference > 0
                          ? 'whitespace-nowrap px-3 py-2 text-right font-semibold text-red-600 dark:text-red-400'
                          : item.difference < 0
                            ? 'whitespace-nowrap px-3 py-2 text-right font-semibold text-emerald-600 dark:text-emerald-400'
                            : 'whitespace-nowrap px-3 py-2 text-right text-theme-text-muted'
                      }
                    >
                      {item.difference === 0 ? '0' : `${item.difference > 0 ? '+' : '−'}${formatQuantity(Math.abs(item.difference))}`}
                    </td>
                    <td className="px-3 py-2">
                      <DifferenceBadge type={item.difference_type} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-theme-text-muted">
                      {item.provenance === 'RECUENTO' ? 'Recuento aplicado' : 'Conteo normal'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {items.length > 0 && (
          <div className="px-4 py-3">
            <InventoryPagination
              page={results.page}
              pageSize={page_size}
              total={total}
              buildHref={buildHref}
              label="productos"
            />
          </div>
        )}
      </div>
    </div>
  )
}
