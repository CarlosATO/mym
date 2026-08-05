'use client'

import { useRef, useState } from 'react'
import { Check, ChevronRight, Download, FileSpreadsheet, Grid2x2, MapPin, Plus, Trash2, Warehouse } from 'lucide-react'
import { buildCampaignImportTemplate } from '@/modules/inventarios/lib/campaign-excel-template'
import { IMPORT_MAX_SIZE } from '@/modules/inventarios/lib/excel-import'

type TheoreticalStockFormat = 'TOTAL_CAMPAIGN' | 'BY_SITE' | 'BY_LOCATION'

interface TheoreticalStockOption {
  value: TheoreticalStockFormat
  label: string
  description: string
  columns: string[]
  icon: React.ReactNode
  filename: string
}

interface InventoryCampaignStockTheoreticalSelectorProps {
  canRead: boolean
  canManage: boolean
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

const FORMAT_LABELS: Record<TheoreticalStockFormat, string> = {
  TOTAL_CAMPAIGN: 'Total de la campaña',
  BY_SITE: 'Desglosado por bodega',
  BY_LOCATION: 'Desglosado por ubicación',
}

export function InventoryCampaignStockTheoreticalSelector({ canRead, canManage }: InventoryCampaignStockTheoreticalSelectorProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<TheoreticalStockFormat | null>(null)
  const [draft, setDraft] = useState<TheoreticalStockFormat | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  if (!canRead && !canManage) return null

  const committed = selected ? OPTIONS.find(option => option.value === selected) ?? null : null
  const fileState: 'pending' | 'ready' | 'invalid' = fileError ? 'invalid' : selectedFile ? 'ready' : 'pending'
  const fileExt = selectedFile ? getFileExtension(selectedFile.name) : ''
  const fileSize = selectedFile ? formatFileSize(selectedFile.size) : ''
  const currentOption = committed ?? null

  const openDialog = () => {
    setDraft(selected)
    setOpen(true)
  }

  const closeDialog = () => {
    setOpen(false)
    setDraft(selected)
  }

  const confirmSelection = () => {
    if (!draft) return
    setSelected(draft)
    setOpen(false)
  }

  const handleDownloadTemplate = () => {
    if (!selected) return
    const option = OPTIONS.find(entry => entry.value === selected)
    if (!option) return
    const buffer = buildCampaignImportTemplate({ scope: selected })
    downloadBuffer(buffer, option.filename)
  }

  const validateFile = (file: File): string | null => {
    if (file.size <= 0) return 'El archivo no puede estar vacío.'
    if (file.size > IMPORT_MAX_SIZE) return 'El archivo supera el límite de 20 MB.'
    const ext = getFileExtension(file.name)
    if (!['xlsx', 'xls', 'csv'].includes(ext)) return 'Solo se admiten archivos XLSX, XLS o CSV.'
    return null
  }

  const handleFileSelected = (file: File | null) => {
    if (!file) {
      setSelectedFile(null)
      setFileError(null)
      return
    }
    const error = validateFile(file)
    if (error) {
      setSelectedFile(null)
      setFileError(error)
      return
    }
    setSelectedFile(file)
    setFileError(null)
  }

  const clearFile = () => {
    setSelectedFile(null)
    setFileError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openFilePicker = () => {
    fileInputRef.current?.click()
  }

  const fileSummary = selectedFile
    ? {
        name: selectedFile.name,
        ext: fileExt.toUpperCase(),
        size: fileSize,
        format: currentOption ? currentOption.label : '—',
      }
    : null

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-bold text-theme-text">Stock teórico de la campaña</h2>
          <p className="text-sm text-theme-text-muted">El stock teórico se carga mediante un único Excel para toda la campaña.</p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openDialog}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover"
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
            <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              Archivo pendiente
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
          {canManage && (
            <>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={handleDownloadTemplate}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-semibold text-theme-text transition-colors hover:bg-theme-text/5"
                >
                  <Download className="h-4 w-4" />
                  Descargar plantilla
                </button>
                <button
                  type="button"
                  onClick={openFilePicker}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover"
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

      {committed && canManage && (
        <div className="mt-4 rounded-xl border border-theme-border bg-theme-bg p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">Archivo local</p>
              <p className="text-sm font-semibold text-theme-text">
                {fileState === 'ready' ? 'Listo para cargar' : fileState === 'invalid' ? 'Archivo no válido' : 'Archivo pendiente'}
              </p>
              {fileError ? (
                <p className="text-sm text-red-600 dark:text-red-400">{fileError}</p>
              ) : (
                <p className="text-sm text-theme-text-muted">
                  {selectedFile ? 'Revisa los datos básicos antes de cargarlo.' : 'Selecciona un archivo local para continuar.'}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selectedFile && (
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
          </div>

          {fileSummary && (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <InfoCard label="Nombre" value={fileSummary.name} />
              <InfoCard label="Extensión" value={fileSummary.ext || '—'} />
              <InfoCard label="Tamaño" value={fileSummary.size} />
              <InfoCard label="Formato" value={fileSummary.format} />
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2 rounded-lg border border-theme-border/70 bg-theme-surface p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-theme-text-muted">La carga se habilitará en el siguiente paso.</p>
            <button
              type="button"
              disabled
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white opacity-50"
            >
              Cargar y validar
            </button>
          </div>
        </div>
      )}

      {open && (
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
                      className={`flex h-full flex-col rounded-xl border p-4 text-left transition-colors ${
                        active
                          ? 'border-theme-accent bg-theme-accent/10 ring-1 ring-theme-accent'
                          : 'border-theme-border bg-theme-bg hover:border-theme-accent/40 hover:bg-theme-text/5'
                      }`}
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
                    disabled={!draft}
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

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-theme-border/70 bg-theme-surface p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted">{label}</p>
      <p className="mt-1 break-words text-sm font-medium text-theme-text">{value}</p>
    </div>
  )
}

function getFileExtension(filename: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename.trim())
  return match ? match[1].toLowerCase() : ''
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
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
