'use client'

import { useCallback, useState } from 'react'
import { Plus, RefreshCw, FileSpreadsheet, Upload } from 'lucide-react'
import type { SiteOption, StockImportListItem } from '@/app/actions/inventarios/imports'
import { listStockImports } from '@/app/actions/inventarios/imports'
import { InventoryImportWizard } from '@/modules/inventarios/components/inventory-import-wizard'
import { InventoryImportDetail } from '@/modules/inventarios/components/inventory-import-detail'
import { InventoryEmptyState } from '@/modules/inventarios/components/inventory-empty-state'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'

interface InventoryImportsPanelProps {
  canRead: boolean
  canManage: boolean
  sites: SiteOption[]
  initialImports: StockImportListItem[]
  initialTotal: number
}

const STATUS_STYLES: Record<string, string> = {
  VALIDATED: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  REJECTED: 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400',
  DRAFT: 'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-300',
  CONSUMED: 'border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-300',
}

const STATUS_LABELS: Record<string, string> = {
  VALIDATED: 'Validada',
  REJECTED: 'Rechazada',
  DRAFT: 'Borrador',
  CONSUMED: 'Consumida',
}

const MODALITY_LABELS: Record<string, string> = {
  GENERAL: 'General',
  POR_UBICACION: 'Por ubicación',
}

export function InventoryImportsPanel({
  canRead,
  canManage,
  sites,
  initialImports,
  initialTotal,
}: InventoryImportsPanelProps) {
  const [imports, setImports] = useState<StockImportListItem[]>(initialImports)
  const [total, setTotal] = useState(initialTotal)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const res = await listStockImports({ page: 1, pageSize: 50 })
    if (!res.error) {
      setImports(res.data?.imports ?? [])
      setTotal(res.data?.total ?? 0)
    }
    setLoading(false)
  }, [])

  const handleCreated = useCallback(
    (importId: string) => {
      setWizardOpen(false)
      setDetailId(importId)
      refresh()
    },
    [refresh]
  )

  if (!canRead) {
    return (
      <InventoryEmptyState
        title="Sin acceso"
        description="Tu rol no tiene permiso para ver las importaciones de stock."
        icon={<FileSpreadsheet className="h-5 w-5" />}
      />
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-theme-text-muted">
          {total} importación(es) registrada(s)
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            {loading ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-theme-text-muted border-t-transparent" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Actualizar
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
            >
              <Plus className="h-3.5 w-3.5" />
              Nueva importación
            </button>
          )}
        </div>
      </div>

      {imports.length === 0 ? (
        <div className="rounded-xl border border-theme-border bg-theme-surface p-6 shadow-sm">
          <InventoryEmptyState
            title="Sin importaciones"
            description="Carga stock teórico y costos desde una plantilla Excel para preparar futuras jornadas."
            icon={<Upload className="h-5 w-5" />}
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface shadow-sm">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                <th className="px-3 py-2.5">Archivo</th>
                <th className="px-3 py-2.5">Unidad inventariable</th>
                <th className="px-3 py-2.5">Tipo de unidad</th>
                <th className="px-3 py-2.5">Modalidad</th>
                <th className="px-3 py-2.5">Corte</th>
                <th className="px-3 py-2.5">Estado</th>
                <th className="px-3 py-2.5 text-right">Filas</th>
                <th className="px-3 py-2.5 text-right">Errores</th>
                <th className="px-3 py-2.5 text-right">Advertencias</th>
                <th className="px-3 py-2.5">Usuario</th>
                <th className="px-3 py-2.5">Carga</th>
                <th className="px-3 py-2.5 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {imports.map(item => (
                <tr key={item.id} className="border-b border-theme-border/40 last:border-0 hover:bg-theme-text/2">
                  <td className="max-w-[180px] truncate px-3 py-2.5 font-medium text-theme-text" title={item.original_filename}>
                    {item.original_filename}
                  </td>
                  <td className="max-w-[160px] truncate px-3 py-2.5 text-theme-text-muted">
                    {item.site_name}
                    <span className="ml-1 font-mono text-xs text-theme-text-muted/60">{item.site_code}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-theme-text-muted">
                    {item.site_type === 'INTERNAL_WAREHOUSE' ? 'Bodega interna' : item.site_type === 'OWN_STORE' ? 'Tienda propia' : 'Sitio externo'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-theme-text-muted">
                    {MODALITY_LABELS[item.modality] ?? item.modality}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-theme-text-muted">{formatDateTimeChile(item.cutoff_at)}</td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[item.status] ?? STATUS_STYLES.DRAFT}`}>
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-theme-text">{item.row_count}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${item.error_count > 0 ? 'text-red-500' : 'text-theme-text-muted/50'}`}>
                    {item.error_count}
                  </td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${item.warning_count > 0 ? 'text-amber-500' : 'text-theme-text-muted/50'}`}>
                    {item.warning_count}
                  </td>
                  <td className="max-w-[120px] truncate px-3 py-2.5 text-theme-text-muted">{item.created_by_name ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-theme-text-muted">{formatDateTimeChile(item.created_at)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => setDetailId(item.id)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                    >
                      <FileSpreadsheet className="h-3 w-3" />
                      Ver detalle
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {wizardOpen && (
        <InventoryImportWizard sites={sites} onClose={() => setWizardOpen(false)} onCreated={handleCreated} />
      )}

      {detailId && (
        <InventoryImportDetail
          importId={detailId}
          canManage={canManage}
          onClose={() => setDetailId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}
