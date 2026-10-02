'use client'

import { FileSpreadsheet, X } from 'lucide-react'
import { getVisibleReplenishmentExcelRows, type ImportedRowStatus, type ReplenishmentExcelImportPreview } from './replenishment-excel-import'

interface Props {
  preview: ReplenishmentExcelImportPreview
  loading: boolean
  showAll: boolean
  onShowAllChange: (showAll: boolean) => void
  onClose: () => void
  onPrepare: () => void
}

function statusLabel(status: ImportedRowStatus): string {
  return {
    VALIDO: 'Válido',
    SKU_NO_ENCONTRADO: 'SKU no encontrado',
    CANTIDAD_INVALIDA: 'Cantidad inválida',
    DUPLICADO: 'Duplicado',
    NO_CONFIRMADO: 'No confirmado',
  }[status]
}

export function ReplenishmentExcelImportDialog({ preview, loading, showAll, onShowAllChange, onClose, onPrepare }: Props) {
  const visibleRows = getVisibleReplenishmentExcelRows(preview.rows, showAll)

  return (
    <div className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-theme-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <FileSpreadsheet className="h-5 w-5 shrink-0 text-theme-accent" />
            <div className="min-w-0">
              <h3 className="truncate text-base font-bold text-theme-text">Previsualización de OC desde archivo</h3>
              <p className="truncate text-xs text-theme-text-muted" title={preview.fileName}>{preview.fileName}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text" aria-label="Cerrar previsualización">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 border-b border-theme-border bg-theme-bg/30 p-4 text-xs sm:grid-cols-5">
          <div><span className="text-theme-text-muted">Formato</span><strong className="block text-theme-text">{preview.format}</strong></div>
          <div><span className="text-theme-text-muted">Proveedor</span><strong className="block truncate text-theme-text" title={preview.provider}>{preview.provider}</strong></div>
          <div><span className="text-theme-text-muted">Filas</span><strong className="block text-theme-text">{preview.totalRows}</strong></div>
          <div><span className="text-theme-text-muted">Válidas</span><strong className="block text-emerald-600">{preview.validRows}</strong></div>
          <div><span className="text-theme-text-muted">Errores / ignoradas</span><strong className="block text-theme-text">{preview.errorRows} / {preview.ignoredRows}</strong></div>
        </div>
        <div className="border-b border-theme-border px-5 py-3 text-xs text-theme-text-muted">
          Selección basada en: <strong className="text-theme-text">{preview.selectionBasis === 'CONFIRMADO_Y_CANTIDAD' ? 'Confirmado = Sí y Cantidad > 0' : 'Cantidad &gt; 0 (sin columna Confirmado)'}</strong>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-theme-border px-5 py-3 text-xs">
          <span className="text-theme-text-muted">Mostrando {visibleRows.length} de {preview.totalRows} filas</span>
          <button type="button" onClick={() => onShowAllChange(!showAll)} className="rounded-lg border border-theme-accent/30 px-3 py-1.5 font-semibold text-theme-accent hover:bg-theme-accent/10">
            {showAll ? 'Mostrar solo válidas y errores' : `Mostrar todas las filas (${preview.totalRows})`}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="sticky top-0 bg-theme-surface text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
              <tr><th className="px-4 py-2.5">Fila</th><th className="px-4 py-2.5">SKU</th><th className="px-4 py-2.5">Producto</th><th className="px-4 py-2.5 text-right">Cantidad</th><th className="px-4 py-2.5">Estado</th></tr>
            </thead>
            <tbody>
              {visibleRows.map(row => (
                <tr key={`${row.rowNumber}-${row.sku}`} className="border-t border-theme-border/60">
                  <td className="px-4 py-2 text-theme-text-muted">{row.rowNumber}</td>
                  <td className="px-4 py-2 font-mono font-semibold text-theme-text">{row.sku}</td>
                  <td className="max-w-[360px] truncate px-4 py-2 text-theme-text" title={row.product}>{row.product || '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-theme-text">{row.quantity ?? '—'}</td>
                  <td className={`px-4 py-2 font-semibold ${row.status === 'VALIDO' ? 'text-emerald-600' : row.status === 'NO_CONFIRMADO' ? 'text-theme-text-muted' : 'text-red-600'}`} title={row.reason}>{statusLabel(row.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-theme-border px-5 py-3">
          <p className="text-xs text-theme-text-muted">Esta etapa no crea ninguna OC. Solo se transferirán las filas válidas.</p>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-theme-border px-4 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5">Cerrar</button>
            <button type="button" disabled={loading || preview.validRows === 0} onClick={onPrepare} className="rounded-lg bg-theme-accent px-4 py-2 text-xs font-bold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50">Preparar Orden de Compra</button>
          </div>
        </div>
      </div>
    </div>
  )
}
