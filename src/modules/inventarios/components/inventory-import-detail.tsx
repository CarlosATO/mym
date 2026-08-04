'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  X,
  RefreshCw,
  Download,
  Upload,
  Loader2,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getStockImport,
  getStockImportRows,
  getStockImportIssues,
  revalidateStockImport,
  replaceStockImportFile,
  type StockImportDetail,
  type StockImportRowItem,
} from '@/app/actions/inventarios/imports'
import { buildImportIssuesCsv } from '@/modules/inventarios/lib/excel-import'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'
import { IMPORT_MAX_SIZE } from '@/modules/inventarios/lib/excel-import'

interface InventoryImportDetailProps {
  importId: string
  canManage: boolean
  onClose: () => void
  onChanged: () => void
}

type Filter = 'ALL' | 'VALID' | 'WARNING' | 'ERROR'

const FILTER_LABELS: Record<Filter, string> = {
  ALL: 'Todos',
  VALID: 'Válidas',
  WARNING: 'Con advertencias',
  ERROR: 'Con errores',
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

const ROW_BADGE: Record<string, { label: string; cls: string }> = {
  VALID: { label: 'Válida', cls: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  WARNING: { label: 'Advertencia', cls: 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  ERROR: { label: 'Error', cls: 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400' },
}

const PAGE_SIZE = 50

export function InventoryImportDetail({ importId, canManage, onClose, onChanged }: InventoryImportDetailProps) {
  const [detail, setDetail] = useState<StockImportDetail | null>(null)
  const [rows, setRows] = useState<StockImportRowItem[]>([])
  const [total, setTotal] = useState(0)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [rowsLoading, setRowsLoading] = useState(true)
  const [revalidating, setRevalidating] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [replacingFile, setReplacingFile] = useState<File | null>(null)
  const [replaceError, setReplaceError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadDetail = useCallback(async () => {
    const res = await getStockImport(importId)
    if (res.error || !res.data) {
      setError(res.error ?? 'No se pudo cargar la importación.')
      setLoading(false)
      return
    }
    setDetail(res.data)
    setError(null)
    setLoading(false)
  }, [importId])

  const loadRows = useCallback(async () => {
    setRowsLoading(true)
    const res = await getStockImportRows({ importId, filter, page, pageSize: PAGE_SIZE })
    if (res.error) {
      toast.error(res.error)
    } else {
      setRows(res.data?.rows ?? [])
      setTotal(res.data?.total ?? 0)
    }
    setRowsLoading(false)
  }, [importId, filter, page])

  useEffect(() => {
    getStockImport(importId).then(res => {
      if (res.error || !res.data) {
        setError(res.error ?? 'No se pudo cargar la importación.')
        setLoading(false)
        return
      }
      setDetail(res.data)
      setError(null)
      setLoading(false)
    })
  }, [importId])

  useEffect(() => {
    if (!detail) return
    getStockImportRows({ importId, filter, page, pageSize: PAGE_SIZE }).then(res => {
      setRows(res.error ? [] : (res.data?.rows ?? []))
      setTotal(res.error ? 0 : (res.data?.total ?? 0))
      setRowsLoading(false)
    })
  }, [importId, detail, filter, page])

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])

  const handleRevalidate = async () => {
    if (!canManage) return
    setRevalidating(true)
    const res = await revalidateStockImport(importId)
    setRevalidating(false)
    if (res.error) {
      toast.error(res.error)
      return
    }
    toast.success(res.data?.status === 'VALIDATED' ? 'Importación validada correctamente.' : 'Importación rechazada tras revalidar.')
    await Promise.all([loadDetail(), loadRows()])
    onChanged()
  }

  const handleReplaceFile = async () => {
    if (!canManage || !replacingFile) return
    setReplaceError(null)
    setReplacing(true)
    try {
      const current = detail
      if (!current) throw new Error('La importación no está cargada.')

      const pathParts = (current.storage_path ?? '').split('/')
      const prefix = pathParts.slice(0, 4).join('/') + '/'
      const storagePath = `${prefix}${Date.now()}-${replacingFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`

      const { createClient } = await import('@/lib/supabase/client')
      const sb = createClient()
      const { error: uploadErr } = await sb.storage
        .from('inventario-imports')
        .upload(storagePath, replacingFile, { cacheControl: '3600', upsert: false })
      if (uploadErr) throw new Error(`No se pudo subir el archivo: ${uploadErr.message}`)

      const replaced = await replaceStockImportFile({
        importId,
        storagePath,
        filename: replacingFile.name,
        mimeType: replacingFile.type || 'application/octet-stream',
        fileSize: replacingFile.size,
      })
      if (replaced.error) throw new Error(replaced.error)

      // Limpia el archivo anterior de storage (best-effort)
      if (current.storage_path && current.storage_path !== storagePath) {
        try {
          await sb.storage.from('inventario-imports').remove([current.storage_path])
        } catch {
          // best-effort
        }
      }

      setReplacingFile(null)
      toast.success('Archivo reemplazado. La importación quedó en borrador.')
      await loadDetail()
      onChanged()
    } catch (err) {
      console.error('[ImportDetail] replace error', err)
      setReplaceError(err instanceof Error ? err.message : 'No se pudo reemplazar el archivo.')
    } finally {
      setReplacing(false)
    }
  }

  const handleDownloadCsv = async () => {
    const res = await getStockImportIssues(importId)
    if (res.error || !res.data) {
      toast.error(res.error ?? 'No se pudieron descargar las incidencias.')
      return
    }
    const csv = buildImportIssuesCsv(res.data)
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `errores-importacion-${detail?.original_filename ?? importId}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
        <div className="relative w-full max-w-5xl rounded-2xl border border-theme-border bg-theme-surface p-10 text-center shadow-2xl">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-theme-accent" />
          <p className="mt-3 text-sm text-theme-text-muted">Cargando importación…</p>
        </div>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
        <div className="relative w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-6 text-center shadow-2xl">
          <XCircle className="mx-auto h-8 w-8 text-red-500" />
          <p className="mt-3 text-sm text-theme-text">{error ?? 'No se pudo cargar la importación.'}</p>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-theme-accent px-4 text-xs font-semibold text-white"
          >
            Cerrar
          </button>
        </div>
      </div>
    )
  }

  const statusBadge = STATUS_STYLES[detail.status] ?? STATUS_STYLES.DRAFT

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div className="relative flex max-h-[92vh] w-full max-w-5xl flex-col rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-theme-border/60 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-accent/10 text-theme-accent">
              <FileSpreadsheet className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-base font-bold text-theme-text">{detail.original_filename}</h2>
              <p className="truncate text-xs text-theme-text-muted">
                {detail.site_name} ({detail.site_code}) · {MODALITY_LABELS[detail.modality] ?? detail.modality} · Corte:{' '}
                {formatDateTimeChile(detail.cutoff_at)}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadge}`}>
              {STATUS_LABELS[detail.status] ?? detail.status}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {detail.file_issues && detail.file_issues.length > 0 && (
            <div className="mb-4 space-y-1">
              {detail.file_issues.map((issue, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                    issue.level === 'ERROR'
                      ? 'border-red-500/25 bg-red-500/5 text-red-600 dark:text-red-400'
                      : 'border-amber-500/25 bg-amber-500/5 text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {issue.level === 'ERROR' ? (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>
                    <span className="font-semibold">{issue.code}:</span> {issue.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-theme-border/60 bg-theme-bg p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Filas</p>
              <p className="mt-1 text-xl font-bold text-theme-text">{detail.row_count}</p>
            </div>
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-red-500/70">Errores</p>
              <p className="mt-1 text-xl font-bold text-red-500">{detail.error_count}</p>
            </div>
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-500/70">Advertencias</p>
              <p className="mt-1 text-xl font-bold text-amber-500">{detail.warning_count}</p>
            </div>
            <div className="rounded-xl border border-theme-border/60 bg-theme-bg p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">Cargado por</p>
              <p className="mt-1 truncate text-sm font-semibold text-theme-text">{detail.created_by_name ?? '—'}</p>
              <p className="text-[11px] text-theme-text-muted/70">{formatDateTimeChile(detail.created_at)}</p>
            </div>
          </div>

          <p className="mt-4 flex items-center gap-1.5 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-600 dark:text-sky-300">
            <Info className="h-3.5 w-3.5 shrink-0" />
            Una importación con advertencias puede utilizarse, pero los productos sin costo dejarán la valorización incompleta.
          </p>

          {canManage && detail.status !== 'CONSUMED' && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleRevalidate}
                disabled={revalidating}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-semibold text-theme-text transition-colors hover:bg-theme-text/5 disabled:opacity-50"
              >
                {revalidating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Revalidar
              </button>
              <button
                type="button"
                onClick={handleDownloadCsv}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-semibold text-theme-text transition-colors hover:bg-theme-text/5"
              >
                <Download className="h-3.5 w-3.5" />
                Descargar CSV de incidencias
              </button>
            </div>
          )}

          {canManage && detail.status !== 'CONSUMED' && (
            <div className="mt-3 rounded-xl border border-dashed border-theme-border/70 p-3">
              <label className="flex cursor-pointer items-center gap-3">
                {replacingFile ? (
                  <span className="flex items-center gap-2 text-sm text-emerald-500">
                    <FileSpreadsheet className="h-4 w-4" /> {replacingFile.name}
                  </span>
                ) : (
                  <span className="flex items-center gap-2 text-xs text-theme-text-muted">
                    <Upload className="h-4 w-4" /> Selecciona un archivo para reemplazar el actual
                  </span>
                )}
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0] ?? null
                    setReplaceError(null)
                    if (!f) {
                      setReplacingFile(null)
                      return
                    }
                    const name = (f.name || '').toLowerCase()
                    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
                      setReplaceError('Solo se admiten archivos XLSX, XLS o CSV.')
                      setReplacingFile(null)
                      return
                    }
                    if (f.size > IMPORT_MAX_SIZE) {
                      setReplaceError('El archivo supera el límite de 20 MB.')
                      setReplacingFile(null)
                      return
                    }
                    setReplacingFile(f)
                  }}
                />
              </label>
              {replacingFile && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={handleReplaceFile}
                    disabled={replacing}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-50"
                  >
                    {replacing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    Reemplazar y volver a borrador
                  </button>
                </div>
              )}
              {replaceError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{replaceError}</p>}
            </div>
          )}

          <div className="mt-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-theme-text">Filas de la importación</h3>
              <div className="flex flex-wrap items-center gap-1.5">
                {(['ALL', 'VALID', 'WARNING', 'ERROR'] as Filter[]).map(f => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => {
                      setFilter(f)
                      setPage(1)
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${
                      filter === f
                        ? 'border-theme-accent bg-theme-accent/10 text-theme-accent'
                        : 'border-theme-border bg-theme-bg text-theme-text-muted hover:bg-theme-text/5'
                    }`}
                  >
                    {FILTER_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-theme-border/60">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-theme-border/60 bg-theme-bg text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                    <th className="px-3 py-2">Fila</th>
                    <th className="px-3 py-2">SKU</th>
                    <th className="px-3 py-2">Producto</th>
                    <th className="px-3 py-2">Ubicación</th>
                    <th className="px-3 py-2 text-right">Cantidad</th>
                    <th className="px-3 py-2 text-right">Costo (CLP)</th>
                    <th className="px-3 py-2">Estado</th>
                    <th className="px-3 py-2">Incidencias</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsLoading ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center">
                        <Loader2 className="mx-auto h-6 w-6 animate-spin text-theme-accent" />
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-xs text-theme-text-muted">
                        No hay filas para el filtro seleccionado.
                      </td>
                    </tr>
                  ) : (
                    rows.map(row => (
                      <tr key={row.row_index} className="border-b border-theme-border/40 last:border-0 hover:bg-theme-text/2">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-theme-text-muted">{row.row_index}</td>
                        <td className="max-w-[140px] truncate px-3 py-2 font-mono text-xs text-theme-text">{row.sku}</td>
                        <td className="max-w-[180px] truncate px-3 py-2 text-theme-text-muted">
                          {row.product_name ?? row.entered_name ?? '—'}
                        </td>
                        <td className="max-w-[120px] truncate px-3 py-2 text-theme-text-muted">{row.location_code ?? '—'}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right text-theme-text">
                          {row.quantity == null ? '—' : Number(row.quantity).toLocaleString('es-CL')}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right text-theme-text">
                          {row.cost == null ? '—' : `$${Number(row.cost).toLocaleString('es-CL')}`}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${ROW_BADGE[row.row_status]?.cls ?? ''}`}
                          >
                            {ROW_BADGE[row.row_status]?.label ?? row.row_status}
                          </span>
                        </td>
                        <td className="max-w-[240px] px-3 py-2">
                          {row.issues.length === 0 ? (
                            <span className="flex items-center gap-1 text-xs text-theme-text-muted/60">
                              <CheckCircle2 className="h-3 w-3" /> Sin incidencias
                            </span>
                          ) : (
                            <ul className="space-y-1">
                              {row.issues.map((issue, i) => (
                                <li key={i} className="flex items-start gap-1 text-xs">
                                  {issue.level === 'ERROR' ? (
                                    <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
                                  ) : (
                                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                                  )}
                                  <span className="text-theme-text-muted">
                                    <span className="font-semibold text-theme-text">{issue.code}:</span> {issue.message}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="mt-3 flex items-center justify-between px-1">
                <p className="text-xs text-theme-text-muted/70">
                  Mostrando {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} de {total} filas
                </p>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-lg border border-theme-border bg-theme-surface px-2 py-1 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 disabled:opacity-40"
                  >
                    Anterior
                  </button>
                  <span className="px-1 text-xs font-medium text-theme-text-muted">
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="rounded-lg border border-theme-border bg-theme-surface px-2 py-1 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 disabled:opacity-40"
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
