'use client'

import { useCallback, useState } from 'react'
import { Upload, Download, Loader2, CheckCircle2, XCircle, FileSpreadsheet } from 'lucide-react'
import { toast } from 'sonner'
import type { SiteOption } from '@/app/actions/inventarios/imports'
import {
  createStockImport,
  registerStockImportFile,
  processStockImport,
  downloadImportTemplate,
} from '@/app/actions/inventarios/imports'
import { IMPORT_MAX_SIZE } from '@/modules/inventarios/lib/excel-import'

interface InventoryImportWizardProps {
  sites: SiteOption[]
  onClose: () => void
  onCreated: (importId: string) => void
}

type Step = 'CONFIG' | 'FILE' | 'PROCESSING' | 'RESULT'

const MODALITY_LABELS: Record<string, string> = {
  GENERAL: 'General (sin ubicaciones)',
  POR_UBICACION: 'Por ubicación',
}

export function InventoryImportWizard({ sites, onClose, onCreated }: InventoryImportWizardProps) {
  const [step, setStep] = useState<Step>('CONFIG')
  const [siteId, setSiteId] = useState('')
  const [modality, setModality] = useState<'GENERAL' | 'POR_UBICACION'>('GENERAL')
  const [cutoffAt, setCutoffAt] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [importId, setImportId] = useState<string | null>(null)
  const [result, setResult] = useState<{ status: string; row_count: number; error_count: number; warning_count: number } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedSite = sites.find(s => s.id === siteId)

  const nowLocal = () => {
    const d = new Date()
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    return d.toISOString().slice(0, 16)
  }

  const handleDownloadTemplate = async () => {
    if (!selectedSite) {
      toast.error('Selecciona una unidad inventariable.')
      return
    }
    if (!cutoffAt) {
      toast.error('Selecciona la fecha y hora de corte.')
      return
    }
    const { data, error } = await downloadImportTemplate({
      siteId: selectedSite.id,
      siteName: selectedSite.name,
      siteCode: selectedSite.code,
      modality,
      cutoffAt: new Date(cutoffAt).toISOString(),
    })
    if (error || !data) {
      toast.error(error ?? 'No se pudo generar la plantilla.')
      return
    }
    const binary = atob(data.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = data.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast.success('Plantilla descargada.')
  }

  const validateFile = (f: File): string | null => {
    const name = (f.name || '').toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
      return 'Solo se admiten archivos XLSX, XLS o CSV.'
    }
    if (f.size > IMPORT_MAX_SIZE) {
      return 'El archivo supera el límite de 20 MB.'
    }
    return null
  }

  const handleFileChange = (f: File | null) => {
    setError(null)
    if (!f) {
      setFile(null)
      return
    }
    const vErr = validateFile(f)
    if (vErr) {
      setError(vErr)
      setFile(null)
      return
    }
    setFile(f)
  }

  const handleUpload = async () => {
    if (!selectedSite || !file || !cutoffAt) {
      setError('Completa la unidad, la fecha de corte y el archivo.')
      return
    }
    setUploading(true)
    setError(null)
    try {
      const created = await createStockImport({
        siteId: selectedSite.id,
        modality,
        cutoffAt: new Date(cutoffAt).toISOString(),
        filename: file.name,
      })
      if (created.error || !created.data) throw new Error(created.error ?? 'No se pudo crear la importación.')
      const { import_id, storage_path } = created.data
      setImportId(import_id)
      setStep('PROCESSING')

      const { createClient } = await import('@/lib/supabase/client')
      const sb = createClient()
      const { error: uploadErr } = await sb.storage
        .from('inventario-imports')
        .upload(storage_path, file, { cacheControl: '3600', upsert: false })

      if (uploadErr) {
        // Intento de limpieza del DRAFT huérfano (best-effort)
        console.error('[ImportWizard] upload error', uploadErr)
        throw new Error(`No se pudo subir el archivo: ${uploadErr.message}`)
      }

      const registered = await registerStockImportFile({
        importId: import_id,
        storagePath: storage_path,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
      })
      if (registered.error) throw new Error(registered.error)

      const processed = await processStockImport(import_id)
      if (processed.error || !processed.data) throw new Error(processed.error ?? 'No se pudo procesar la importación.')

      setResult({
        status: processed.data.status,
        row_count: 0,
        error_count: 0,
        warning_count: 0,
      })
      setStep('RESULT')
      toast.success(
        processed.data.status === 'VALIDATED'
          ? 'Importación validada correctamente.'
          : 'Importación procesada con errores.'
      )
    } catch (err) {
      console.error('[ImportWizard] error', err)
      setError(err instanceof Error ? err.message : 'No se pudo procesar la importación.')
      setStep('FILE')
    } finally {
      setUploading(false)
    }
  }

  const openDetail = useCallback(() => {
    if (importId) {
      onCreated(importId)
    }
  }, [importId, onCreated])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={step === 'CONFIG' || step === 'FILE' ? onClose : undefined} aria-hidden />
      <div className="relative w-full max-w-2xl rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-theme-border/60 px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-theme-accent/10 text-theme-accent">
              <Upload className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-bold text-theme-text">Nueva importación</h2>
              <p className="text-xs text-theme-text-muted">Carga stock teórico y costos desde un archivo Excel.</p>
            </div>
          </div>
          {(step === 'CONFIG' || step === 'FILE') && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-2 py-1 text-xs text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
            >
              Cerrar
            </button>
          )}
        </div>

        <div className="px-5 py-4">
          {step === 'CONFIG' && (
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text-muted">Unidad inventariable</label>
                <select
                  value={siteId}
                  onChange={e => setSiteId(e.target.value)}
                  className="h-9 w-full rounded-lg border border-theme-border bg-theme-bg px-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
                >
                  <option value="">Selecciona una unidad…</option>
                  {sites.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text-muted">Modalidad</label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(['GENERAL', 'POR_UBICACION'] as const).map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModality(m)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        modality === m
                          ? 'border-theme-accent bg-theme-accent/10 text-theme-accent'
                          : 'border-theme-border bg-theme-bg text-theme-text hover:bg-theme-text/5'
                      }`}
                    >
                      <span className="block font-semibold">{MODALITY_LABELS[m]}</span>
                      <span className="block text-xs text-theme-text-muted">
                        {m === 'GENERAL' ? 'Sin ubicaciones.' : 'Una fila por SKU y ubicación.'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text-muted">Fecha y hora de corte</label>
                <input
                  type="datetime-local"
                  value={cutoffAt}
                  max={nowLocal()}
                  onChange={e => setCutoffAt(e.target.value)}
                  className="h-9 w-full rounded-lg border border-theme-border bg-theme-bg px-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
                />
              </div>

              <button
                type="button"
                onClick={handleDownloadTemplate}
                disabled={!selectedSite || !cutoffAt}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-semibold text-theme-text transition-colors hover:bg-theme-text/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                Descargar plantilla oficial
              </button>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setStep('FILE')}
                  disabled={!selectedSite || !cutoffAt}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-theme-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Continuar
                </button>
              </div>
            </div>
          )}

          {step === 'FILE' && (
            <div className="space-y-4">
              <p className="rounded-lg border border-theme-border/60 bg-theme-bg px-3 py-2 text-xs text-theme-text-muted">
                Unidad: <span className="font-semibold text-theme-text">{selectedSite?.name}</span> · Modalidad:{' '}
                <span className="font-semibold text-theme-text">{MODALITY_LABELS[modality]}</span> · Corte:{' '}
                <span className="font-semibold text-theme-text">{cutoffAt.replace('T', ' ')}</span>
              </p>

              <label
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
                  file
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : 'border-theme-border bg-theme-bg hover:border-theme-border-accent'
                }`}
              >
                {file ? (
                  <>
                    <FileSpreadsheet className="h-8 w-8 text-emerald-500" />
                    <span className="text-sm font-semibold text-theme-text">{file.name}</span>
                    <span className="text-xs text-theme-text-muted">
                      {(file.size / 1024).toFixed(1)} KB · Listo para subir
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="h-8 w-8 text-theme-text-muted/60" />
                    <span className="text-sm text-theme-text">Selecciona el archivo (XLSX, XLS o CSV UTF-8)</span>
                    <span className="text-xs text-theme-text-muted">Máximo 20 MB. Sin macros.</span>
                  </>
                )}
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={e => handleFileChange(e.target.files?.[0] ?? null)}
                />
              </label>

              {error && <p className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

              <div className="flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep('CONFIG')}
                  className="inline-flex h-9 items-center rounded-lg border border-theme-border bg-theme-bg px-3 text-xs font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5"
                >
                  Volver
                </button>
                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={!file || uploading}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-theme-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  Subir y validar
                </button>
              </div>
            </div>
          )}

          {step === 'PROCESSING' && (
            <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <Loader2 className="h-10 w-10 animate-spin text-theme-accent" />
              <p className="text-sm font-semibold text-theme-text">Procesando importación…</p>
              <p className="text-xs text-theme-text-muted">Subiendo, descargando y validando el archivo en el servidor.</p>
            </div>
          )}

          {step === 'RESULT' && result && (
            <div className="space-y-4">
              <div
                className={`flex flex-col items-center gap-2 rounded-xl border px-4 py-6 text-center ${
                  result.status === 'VALIDATED'
                    ? 'border-emerald-500/25 bg-emerald-500/5'
                    : 'border-red-500/25 bg-red-500/5'
                }`}
              >
                {result.status === 'VALIDATED' ? (
                  <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                ) : (
                  <XCircle className="h-10 w-10 text-red-500" />
                )}
                <p className="text-base font-bold text-theme-text">
                  {result.status === 'VALIDATED' ? 'Importación validada' : 'Importación rechazada'}
                </p>
                <p className="text-xs text-theme-text-muted">
                  El archivo fue procesado en el servidor. Revisa el detalle para ver incidencias.
                </p>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={openDetail}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-theme-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover"
                >
                  Ver detalle
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
