'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronRight, Download, FileSpreadsheet, Grid2x2, Loader2, MapPin, Plus, Trash2, Warehouse } from 'lucide-react'
import { createCampaignStockImport, finalizeCampaignStockImport, getCampaignStockImport, registerCampaignStockImportFile, type CampaignStockImportDetail, type CampaignStockImportRowItem } from '@/app/actions/inventarios/imports'
import { generateInventoryCampaignSessions, type InventoryCampaignSessionGenerationSummary } from '@/app/actions/inventarios/campaigns'
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client'
import { buildCampaignImportTemplate } from '@/modules/inventarios/lib/campaign-excel-template'
import type { CampaignImportScope } from '@/modules/inventarios/lib/campaign-excel'
import { IMPORT_BUCKET, IMPORT_MAX_SIZE } from '@/modules/inventarios/lib/excel-import'

interface InventoryCampaignStockTheoreticalSelectorProps {
  canRead: boolean
  canManage: boolean
  canGenerateSessions: boolean
  campaignId: string
  campaignStatus: string
  cutoffAt: string
  initialImport: CampaignStockImportDetail | null
  sessionCount: number
  sessionsPending: number
  siteCount: number
}

interface TheoreticalStockOption {
  value: CampaignImportScope
  label: string
  description: string
  columns: string[]
  filename: string
  icon: React.ReactNode
}

const OPTIONS: TheoreticalStockOption[] = [
  {
    value: 'TOTAL_CAMPAIGN',
    label: 'Total de la campaña',
    description: 'Una cantidad total por producto, considerando todas las unidades incluidas. No requiere bodega ni ubicación.',
    columns: ['SKU', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
    filename: 'plantilla-stock-total-campana.xlsx',
    icon: <Grid2x2 className="h-4 w-4" />,
  },
  {
    value: 'BY_SITE',
    label: 'Desglosado por bodega',
    description: 'El mismo archivo indica cuánto corresponde a cada bodega o unidad.',
    columns: ['SKU', 'CODIGO_UNIDAD', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
    filename: 'plantilla-stock-por-bodega.xlsx',
    icon: <Warehouse className="h-4 w-4" />,
  },
  {
    value: 'BY_LOCATION',
    label: 'Desglosado por ubicación',
    description: 'El mismo archivo indica la bodega y ubicación correspondiente a cada cantidad.',
    columns: ['SKU', 'CODIGO_UNIDAD', 'CODIGO_UBICACION', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
    filename: 'plantilla-stock-por-ubicacion.xlsx',
    icon: <MapPin className="h-4 w-4" />,
  },
]

const FORMAT_LABELS: Record<CampaignImportScope, string> = {
  TOTAL_CAMPAIGN: 'Total de la campaña',
  BY_SITE: 'Desglosado por bodega',
  BY_LOCATION: 'Desglosado por ubicación',
}

const PROCESS_STAGE_LABELS = {
  CREATING: 'Creando importación',
  UPLOADING: 'Subiendo archivo',
  VALIDATING: 'Validando contenido',
} as const

const PREVIEW_ROW_LIMIT = 20

export function InventoryCampaignStockTheoreticalSelector({
  canRead,
  canManage,
  canGenerateSessions,
  campaignId,
  campaignStatus,
  cutoffAt,
  initialImport,
  sessionCount,
  sessionsPending,
  siteCount,
}: InventoryCampaignStockTheoreticalSelectorProps) {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<CampaignImportScope | null>(() => initialImport?.import.theoretical_scope ?? null)
  const [draft, setDraft] = useState<CampaignImportScope | null>(() => initialImport?.import.theoretical_scope ?? null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [processStage, setProcessStage] = useState<keyof typeof PROCESS_STAGE_LABELS | null>(null)
  const [processError, setProcessError] = useState<string | null>(null)
  const [result, setResult] = useState<CampaignStockImportDetail | null>(() => initialImport)
  const [generationOpen, setGenerationOpen] = useState(false)
  const [generationStage, setGenerationStage] = useState<'GENERATING' | null>(null)
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [generationSummary, setGenerationSummary] = useState<InventoryCampaignSessionGenerationSummary | null>(null)

  if (!canRead && !canManage) return null

  const effectiveScope = selected ?? result?.import.theoretical_scope ?? null
  const committed = effectiveScope ? OPTIONS.find(option => option.value === effectiveScope) ?? null : null
  const isProcessing = processStage !== null
  const isValidated = result?.import.status === 'VALIDATED'
  const isRejected = result?.import.status === 'REJECTED'
  const canEditFormat = canManage && !isProcessing && !isValidated

  const currentStateLabel = isProcessing
    ? PROCESS_STAGE_LABELS[processStage]
    : isValidated
      ? 'Archivo validado'
      : isRejected
        ? 'Archivo rechazado'
        : selectedFile
          ? 'Archivo seleccionado'
          : 'Archivo pendiente'

  const selectedOptionLabel = effectiveScope ? FORMAT_LABELS[effectiveScope] : '—'
  const preview = buildValidatedCampaignPreview(result)
  const previewScope = result?.import.theoretical_scope ?? selected
  const showUnitColumn = previewScope === 'BY_SITE' || previewScope === 'BY_LOCATION'
  const showLocationColumn = previewScope === 'BY_LOCATION'
  const hasUnits = siteCount > 0
  const sessionsComplete = hasUnits && sessionsPending === 0
  const sessionsPartial = hasUnits && sessionsPending > 0 && sessionCount > 0
  const generationButtonLabel = sessionsPartial ? 'Generar jornadas faltantes' : 'Generar jornadas'
  const validatedMessage = sessionsComplete
    ? 'El stock teórico fue validado correctamente. Todas las unidades ya tienen una jornada en borrador.'
    : sessionsPartial
      ? 'El stock teórico fue validado correctamente. Aún quedan jornadas pendientes por generar.'
      : 'El stock teórico fue validado correctamente. Aún no se han generado las jornadas.'
  const canShowGenerateSessions =
    canGenerateSessions &&
    campaignStatus === 'DRAFT' &&
    isValidated

  const openDialog = () => {
    if (!canEditFormat) return
    setDraft(selected)
    setOpen(true)
  }

  const closeDialog = () => {
    setOpen(false)
    setDraft(selected)
  }

  const confirmSelection = () => {
    if (!draft) return
    if (draft !== selected) {
      setSelectedFile(null)
      setFileError(null)
      setProcessError(null)
      setResult(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    setSelected(draft)
    setOpen(false)
  }

  const handleDownloadTemplate = () => {
    if (!selected || isProcessing || isValidated) return
    const option = OPTIONS.find(entry => entry.value === selected)
    if (!option) return
    downloadBuffer(buildCampaignImportTemplate({ scope: selected }), option.filename)
  }

  const validateFile = (file: File): string | null => {
    if (file.size <= 0) return 'El archivo no puede estar vacío.'
    if (file.size > IMPORT_MAX_SIZE) return 'El archivo supera el límite de 20 MB.'
    const ext = getFileExtension(file.name)
    if (!['xlsx', 'xls', 'csv'].includes(ext)) return 'Solo se admiten archivos XLSX, XLS o CSV.'
    return null
  }

  const handleFileSelected = (file: File | null) => {
    if (!canManage || isProcessing || isValidated) return
    setProcessError(null)
    setFileError(null)
    if (!file) {
      setSelectedFile(null)
      setResult(null)
      return
    }
    const error = validateFile(file)
    if (error) {
      setSelectedFile(null)
      setResult(null)
      setFileError(error)
      return
    }
    setSelectedFile(file)
    setResult(null)
  }

  const clearFile = () => {
    if (isProcessing || isValidated) return
    setSelectedFile(null)
    setFileError(null)
    setProcessError(null)
    setResult(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openFilePicker = () => {
    if (!canManage || isProcessing || isValidated) return
    fileInputRef.current?.click()
  }

  const openGenerateDialog = () => {
    if (!canShowGenerateSessions) return
    setGenerationError(null)
    setGenerationOpen(true)
  }

  const closeGenerateDialog = () => {
    if (generationStage) return
    setGenerationOpen(false)
  }

  const handleGenerateSessions = async () => {
    if (!canShowGenerateSessions || !result) return
    setGenerationError(null)
    setGenerationStage('GENERATING')
    try {
      const generated = await generateInventoryCampaignSessions({
        campaignId,
        stockImportId: result.import.id,
        idempotencyKey: crypto.randomUUID(),
      })
      if (generated.error || !generated.data) {
        throw new Error(generated.error ?? 'No se pudieron generar las jornadas.')
      }
      setGenerationSummary(generated.data)
      setGenerationOpen(false)
      router.refresh()
    } catch (err) {
      setGenerationError(err instanceof Error ? err.message : 'No se pudieron generar las jornadas.')
    } finally {
      setGenerationStage(null)
    }
  }

  const handleUpload = async () => {
    if (!canManage || isProcessing || isValidated || !selected || !selectedFile) return
    setProcessError(null)
    try {
      setProcessStage('CREATING')
      const created = await createCampaignStockImport({
        campaignId,
        theoreticalScope: selected,
        cutoffAt,
        currency: 'CLP',
        originalFilename: selectedFile.name,
        mimeType: selectedFile.type || guessMimeType(selectedFile.name),
        fileSize: selectedFile.size,
        idempotencyKey: crypto.randomUUID(),
      })
      if (created.error || !created.data) throw new Error(created.error ?? 'No se pudo crear la importación.')

      setProcessStage('UPLOADING')
      await uploadCampaignFile(created.data.storage_path, created.data.upload_token, created.data.signed_upload_url, selectedFile)

      setProcessStage('VALIDATING')
      const registered = await registerCampaignStockImportFile({
        importId: created.data.import_id,
        storagePath: created.data.storage_path,
        filename: selectedFile.name,
        mimeType: selectedFile.type || guessMimeType(selectedFile.name),
        fileSize: selectedFile.size,
        idempotencyKey: crypto.randomUUID(),
      })
      if (registered.error || !registered.data) throw new Error(registered.error ?? 'No se pudo registrar el archivo.')

      const finalized = await finalizeCampaignStockImport({
        importId: registered.data.import_id,
        idempotencyKey: crypto.randomUUID(),
      })
      if (finalized.error || !finalized.data) throw new Error(finalized.error ?? 'No se pudo validar la importación.')

      const detailed = await getCampaignStockImport(finalized.data.import_id)
      if (detailed.error || !detailed.data) throw new Error(detailed.error ?? 'No se pudo consultar el resultado de la validación.')

      setResult(detailed.data)
      setProcessError(null)
    } catch (err) {
      setProcessError(err instanceof Error ? err.message : 'No se pudo completar la carga y validación.')
    } finally {
      setProcessStage(null)
    }
  }

  const selectedFileInfo = selectedFile
    ? {
        name: selectedFile.name,
        ext: getFileExtension(selectedFile.name).toUpperCase() || '—',
        size: formatFileSize(selectedFile.size),
      }
    : null

  const summary = result?.summary ?? null

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-bold text-theme-text">Stock teórico de la campaña</h2>
          <p className="text-sm text-theme-text-muted">El stock teórico se carga mediante un único Excel para toda la campaña.</p>
        </div>
        {canEditFormat && (
          <button
            type="button"
            onClick={openDialog}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-50"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Configurar stock teórico
          </button>
        )}
      </div>

      {committed ? (
        <div className="mt-4 rounded-xl border border-theme-border/80 bg-theme-bg p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">Formato seleccionado</p>
              <p className="mt-1 text-sm font-semibold text-theme-text">{FORMAT_LABELS[committed.value]}</p>
            </div>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(result?.import.status ?? null, isProcessing)}`}>
              {currentStateLabel}
            </span>
          </div>
          <p className="mt-3 text-sm text-theme-text-muted">{committed.description}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {committed.columns.map(column => (
              <span key={column} className="inline-flex rounded-full border border-theme-border bg-theme-surface px-2.5 py-1 text-xs font-medium text-theme-text-muted">
                {column}
              </span>
            ))}
          </div>
          {canEditFormat && (
            <>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={handleDownloadTemplate}
                  disabled={isProcessing || isValidated}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-semibold text-theme-text transition-colors hover:bg-theme-text/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Download className="h-4 w-4" />
                  Descargar plantilla
                </button>
                <button
                  type="button"
                  onClick={openFilePicker}
                  disabled={isProcessing || isValidated}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  Seleccionar archivo
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={e => handleFileSelected(e.target.files?.[0] ?? null)}
                />
              </div>
              <p className="mt-4 text-xs text-theme-text-muted">La selección se guardará al cargar el archivo.</p>
            </>
          )}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-theme-border bg-theme-bg p-4 text-sm text-theme-text-muted">
          Aún no has elegido el formato del Excel maestro.
        </div>
      )}

      {selected && canManage && (
        <div className="mt-4 rounded-xl border border-theme-border bg-theme-bg p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">Archivo local</p>
              <p className="text-sm font-semibold text-theme-text">{currentStateLabel}</p>
              <p className="text-sm text-theme-text-muted">
                {isValidated
                  ? 'La validación ya terminó. El siguiente paso será preparar la campaña.'
                  : 'La estructura y los datos se validarán al cargar el archivo.'}
              </p>
            </div>
            {selectedFile && !isProcessing && !isValidated && (
              <button
                type="button"
                onClick={clearFile}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Quitar archivo
              </button>
            )}
          </div>

          {selectedFileInfo && (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <InfoCard label="Nombre" value={selectedFileInfo.name} />
              <InfoCard label="Extensión" value={selectedFileInfo.ext} />
              <InfoCard label="Tamaño" value={selectedFileInfo.size} />
              <InfoCard label="Formato" value={selectedOptionLabel} />
            </div>
          )}

          {fileError && (
            <p className="mt-4 rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400">{fileError}</p>
          )}

          {processError && (
            <p className="mt-4 rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400">{processError}</p>
          )}

          {isProcessing && (
            <div className="mt-4 rounded-lg border border-theme-border/70 bg-theme-surface p-3 text-sm text-theme-text-muted">
              <span className="inline-flex items-center gap-2 font-medium text-theme-text">
                <Loader2 className="h-4 w-4 animate-spin text-theme-accent" />
                {PROCESS_STAGE_LABELS[processStage ?? 'CREATING']}
              </span>
            </div>
          )}

          {isValidated && summary && (
            <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Archivo validado</p>
              <p className="mt-1 text-sm text-theme-text-muted">{validatedMessage}</p>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <InfoCard label="Archivo" value={result?.import.original_filename ?? selectedFile?.name ?? '—'} />
                <InfoCard label="Formato" value={selectedOptionLabel} />
                <InfoCard label="Filas totales" value={String(summary.total_rows)} />
                <InfoCard label="Filas válidas" value={String(summary.valid_rows)} />
                <InfoCard label="Advertencias" value={String(summary.issue_warning_count)} />
                <InfoCard label="Errores" value="0" />
              </div>

              {preview.rows.length > 0 && (
                <div className="mt-5 rounded-xl border border-emerald-500/15 bg-theme-surface p-4">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-theme-text">Productos reconocidos</p>
                      <p className="text-xs text-theme-text-muted">
                        La descripción oficial del catálogo es la referencia principal.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 overflow-x-auto rounded-lg border border-theme-border/60">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-theme-border/60 bg-theme-bg text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                          <th className="px-3 py-2">SKU</th>
                          <th className="px-3 py-2">Producto</th>
                          <th className="px-3 py-2">Descripción del archivo</th>
                          {showUnitColumn && <th className="px-3 py-2">Unidad</th>}
                          {showLocationColumn && <th className="px-3 py-2">Ubicación</th>}
                          <th className="px-3 py-2 text-right">Cantidad teórica</th>
                          <th className="px-3 py-2 text-right">Costo unitario</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map(row => (
                          <tr key={`${row.row_index}-${row.sku}`} className="border-b border-theme-border/40 last:border-0 hover:bg-theme-text/2">
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-theme-text">{row.sku}</td>
                            <td className="max-w-[260px] px-3 py-2 text-theme-text-muted">
                              <p className="truncate font-medium text-theme-text">{row.canonicalProductDescription ?? '—'}</p>
                            </td>
                            <td className="max-w-[240px] px-3 py-2 text-theme-text-muted">
                              {row.enteredDescription ? (
                                <span className="block break-words text-sm text-theme-text-muted">{row.enteredDescription}</span>
                              ) : (
                                <span className="text-theme-text-muted/60">—</span>
                              )}
                            </td>
                            {showUnitColumn && (
                              <td className="max-w-[140px] truncate px-3 py-2 text-theme-text-muted">
                                {row.entered_site_code ?? '—'}
                              </td>
                            )}
                            {showLocationColumn && (
                              <td className="max-w-[160px] truncate px-3 py-2 text-theme-text-muted">
                                {row.entered_location_code ?? '—'}
                              </td>
                            )}
                            <td className="whitespace-nowrap px-3 py-2 text-right text-theme-text">
                              {row.quantity == null ? '—' : Number(row.quantity).toLocaleString('es-CL')}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right text-theme-text">
                              {row.cost == null ? '—' : `$${Number(row.cost).toLocaleString('es-CL')}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {preview.showLimitNotice && (
                    <p className="mt-3 text-xs text-theme-text-muted">
                      Mostrando {PREVIEW_ROW_LIMIT} de {preview.totalRows} productos/filas validadas.
                    </p>
                  )}

                  {canShowGenerateSessions && !sessionsComplete && (
                    <div className="mt-5 rounded-xl border border-theme-accent/20 bg-theme-accent/5 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-theme-text">{generationButtonLabel}</p>
                          <p className="text-sm text-theme-text-muted">
                            PetGroup creará una jornada en borrador por cada unidad incluida en la campaña.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={openGenerateDialog}
                          disabled={Boolean(generationStage)}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Plus className="h-4 w-4" />
                          {generationButtonLabel}
                        </button>
                      </div>
                    </div>
                  )}

                  {canShowGenerateSessions && sessionsComplete && (
                    <div className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Jornadas generadas</p>
                          <p className="text-sm text-theme-text-muted">Todas las unidades ya tienen una jornada en borrador.</p>
                        </div>
                        <div className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-white/60 px-3 py-2 text-sm font-medium text-theme-text dark:bg-theme-surface/40">
                          <Check className="h-4 w-4 text-emerald-600" />
                          {sessionCount} de {siteCount} unidades listas
                        </div>
                      </div>
                    </div>
                  )}

                  {generationError && (
                    <p className="mt-4 rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                      {generationError}
                    </p>
                  )}

                  {generationSummary && (
                    <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                      <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Jornadas generadas</p>
                      <p className="mt-1 text-sm text-theme-text-muted">
                        {generationSummary.sessions_created === 0
                          ? 'Todas las jornadas ya existían. No se duplicó nada.'
                          : 'Las jornadas quedaron creadas y la campaña se actualizó.'}
                      </p>
                      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <InfoCard label="Unidades totales" value={String(generationSummary.total_units)} />
                        <InfoCard label="Jornadas creadas" value={String(generationSummary.sessions_created)} />
                        <InfoCard label="Jornadas existentes" value={String(generationSummary.sessions_existing)} />
                        <InfoCard label="Jornadas pendientes" value={String(generationSummary.sessions_pending)} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {isRejected && summary && (
            <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
              <p className="text-sm font-semibold text-red-700 dark:text-red-300">Archivo rechazado</p>
              <p className="mt-1 text-sm text-theme-text-muted">Revisa las incidencias y corrige el archivo antes de volver a cargarlo.</p>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <InfoCard label="Archivo" value={result?.import.original_filename ?? selectedFile?.name ?? '—'} />
                <InfoCard label="Formato" value={selectedOptionLabel} />
                <InfoCard label="Advertencias" value={String(summary.issue_warning_count)} />
                <InfoCard label="Errores" value={String(summary.issue_error_count)} />
              </div>

              <div className="mt-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">Incidencias</p>
                <div className="space-y-2">
                  {(result?.issues ?? []).map((issue, index) => (
                    <div key={`${issue.row_index ?? 'x'}-${issue.field ?? 'field'}-${index}`} className="rounded-lg border border-red-500/15 bg-theme-surface p-3 text-sm">
                      <p className="font-medium text-theme-text">
                        {issue.row_index ? `Fila ${issue.row_index}` : 'Archivo'}{issue.field ? ` · ${issueFieldLabel(issue.field)}` : ''}
                      </p>
                      <p className="text-theme-text-muted">{issue.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!isProcessing && !isValidated && (
            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-theme-border/70 bg-theme-surface p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-theme-text-muted">La carga se habilitará en el siguiente paso.</p>
              <button
                type="button"
                onClick={handleUpload}
                disabled={!selectedFile || Boolean(fileError)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cargar y validar
              </button>
            </div>
          )}

          {isValidated && (
            <p className="mt-4 text-xs text-theme-text-muted">La selección quedó bloqueada hasta preparar la campaña.</p>
          )}

      {isRejected && (
        <p className="mt-4 text-xs text-theme-text-muted">Puedes quitar el archivo, elegir otro y volver a cargarlo.</p>
      )}
    </div>
  )}

      {generationOpen && canShowGenerateSessions && result && (
        <div className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-theme-border/60 px-5 py-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-theme-text">Generar jornadas</h3>
                <p className="text-sm text-theme-text-muted">No se iniciará el conteo.</p>
              </div>
              <button
                type="button"
                onClick={closeGenerateDialog}
                disabled={Boolean(generationStage)}
                className="rounded-lg px-2 py-1 text-sm text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cerrar
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <InfoCard label="Unidades" value={String(siteCount)} />
                <InfoCard label="Existentes" value={String(sessionCount)} />
                <InfoCard label="Pendientes" value={String(sessionsPending)} />
                <InfoCard label="Importación" value={result.import.original_filename} />
              </div>
              <p className="text-sm text-theme-text-muted">
                PetGroup creará una jornada en borrador por cada unidad incluida en la campaña.
              </p>
              <div className="rounded-xl border border-theme-border/70 bg-theme-bg p-4 text-sm text-theme-text-muted">
                {generationStage ? (
                  <span className="inline-flex items-center gap-2 font-medium text-theme-text">
                    <Loader2 className="h-4 w-4 animate-spin text-theme-accent" />
                    Generando jornadas…
                  </span>
                ) : (
                  <p>No se iniciará el conteo.</p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-theme-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
              <button
                type="button"
                onClick={closeGenerateDialog}
                disabled={Boolean(generationStage)}
                className="inline-flex h-9 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleGenerateSessions}
                disabled={Boolean(generationStage)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generationStage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {generationStage ? 'Generando jornadas…' : 'Generar jornadas'}
              </button>
            </div>
          </div>
        </div>
      )}

      {open && canEditFormat && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-4xl rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-theme-border/60 px-5 py-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-theme-text">Configurar stock teórico</h3>
                <p className="text-sm text-theme-text-muted">Elige una sola forma de estructurar el Excel maestro.</p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                className="rounded-lg px-2 py-1 text-sm text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              >
                Cerrar
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {OPTIONS.map(option => {
                  const active = draft === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setDraft(option.value)}
                      disabled={isProcessing}
                      className={`flex h-full flex-col rounded-xl border p-4 text-left transition-colors ${
                        active
                          ? 'border-theme-accent bg-theme-accent/10 ring-1 ring-theme-accent'
                          : 'border-theme-border bg-theme-bg hover:border-theme-accent/40 hover:bg-theme-text/5'
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${active ? 'bg-theme-accent text-white' : 'bg-theme-text/5 text-theme-text-muted'}`}>
                          {option.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-theme-text">{option.label}</p>
                        </div>
                        {active && <Check className="h-4 w-4 text-theme-accent" />}
                      </div>
                      <p className="mt-3 text-sm text-theme-text-muted">{option.description}</p>
                      <div className="mt-4 rounded-lg border border-theme-border/70 bg-theme-surface p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted">Columnas esperadas</p>
                        <p className="mt-1 text-sm font-medium text-theme-text">{option.columns.join(' | ')}</p>
                      </div>
                    </button>
                  )
                })}
              </div>

              <div className="flex flex-col gap-3 border-t border-theme-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-theme-text-muted">La selección se guardará al cargar el archivo.</p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeDialog}
                    className="inline-flex h-9 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={confirmSelection}
                    disabled={!draft || isProcessing}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Confirmar formato
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export function buildValidatedCampaignPreview(detail: CampaignStockImportDetail | null): {
  rows: CampaignStockImportRowItem[]
  totalRows: number
  showLimitNotice: boolean
} {
  const rows = detail?.import.status === 'VALIDATED' ? detail.rows : []
  const totalRows = rows.length
  return {
    rows: rows.slice(0, PREVIEW_ROW_LIMIT),
    totalRows,
    showLimitNotice: totalRows > PREVIEW_ROW_LIMIT,
  }
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-theme-border/70 bg-theme-surface p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted">{label}</p>
      <p className="mt-1 break-words text-sm font-medium text-theme-text">{value}</p>
    </div>
  )
}

function issueFieldLabel(field: string): string {
  if (field === 'sku') return 'SKU'
  if (field === 'entered_site_code') return 'Código de unidad'
  if (field === 'entered_location_code') return 'Código de ubicación'
  if (field === 'quantity') return 'Cantidad teórica'
  if (field === 'cost') return 'Costo unitario'
  return field
}

function statusBadgeClass(status: string | null, isProcessing: boolean): string {
  if (isProcessing) return 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  if (status === 'VALIDATED') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  if (status === 'REJECTED') return 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300'
  return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
}

function getFileExtension(filename: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename.trim())
  return match ? match[1].toLowerCase() : ''
}

function guessMimeType(filename: string): string {
  const ext = getFileExtension(filename)
  if (ext === 'xls') return 'application/vnd.ms-excel'
  if (ext === 'csv') return 'text/csv'
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

async function uploadCampaignFile(storagePath: string, uploadToken: string, signedUploadUrl: string, file: File) {
  const client = createBrowserSupabaseClient()
  const storage = client.storage as unknown as SignedStorageClient
  const bucket = storage.from(IMPORT_BUCKET)
  if (typeof bucket.uploadToSignedUrl === 'function') {
    const { error } = await bucket.uploadToSignedUrl(storagePath, uploadToken, file, {
      contentType: file.type || guessMimeType(file.name),
    })
    if (error) throw new Error('No se pudo subir el archivo seleccionado.')
    return
  }

  const response = await fetch(signedUploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type || guessMimeType(file.name),
    },
    body: file,
  })
  if (!response.ok) throw new Error('No se pudo subir el archivo seleccionado.')
}

interface SignedUploadBucket {
  uploadToSignedUrl?: (
    storagePath: string,
    token: string,
    file: File,
    options?: { contentType?: string }
  ) => Promise<{ error: { message?: string } | null }>
}

interface SignedStorageClient {
  from(bucket: string): SignedUploadBucket
}

function downloadBuffer(buffer: Uint8Array, filename: string) {
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
