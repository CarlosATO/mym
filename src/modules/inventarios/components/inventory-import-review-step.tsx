'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ClipboardList, FileSpreadsheet, Loader2, Lock } from 'lucide-react'
import {
  attachStockImportToSession,
  getValidatedStockImportsForSession,
  prepareInventorySessionFromImport,
  type ValidatedStockImportOption,
} from '@/app/actions/inventarios/sessions'
import { InventoryLoadingState } from '@/modules/inventarios/components/inventory-loading-state'
import { formatDateTimeChile } from '@/modules/inventarios/lib/format'
import { notifyInventoryNavigation } from '@/modules/inventarios/components/inventory-navigation-feedback'

interface InventoryImportReviewStepProps {
  companyId: string
  sessionId: string
  setup: {
    session: {
      name: string
      site_name?: string | null
      site_type?: string | null
      stock_source?: string | null
      stock_import_id?: string | null
      scope_mode?: string | null
    } | null
  }
}

function makeKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function useIdempotencyKey(): () => string {
  const ref = useRef<string | null>(null)
  return () => {
    if (!ref.current) ref.current = makeKey()
    return ref.current
  }
}

const MODALITY_LABELS: Record<string, string> = {
  GENERAL: 'General',
  POR_UBICACION: 'Por ubicación',
}

const TYPE_LABELS: Record<string, string> = {
  INTERNAL_WAREHOUSE: 'Bodega interna',
  OWN_STORE: 'Tienda propia',
  EXTERNAL_SITE: 'Sitio externo',
}

export function InventoryImportReviewStep({
  companyId,
  sessionId,
  setup,
}: InventoryImportReviewStepProps) {
  const router = useRouter()
  const session = setup.session
  const [imports, setImports] = useState<ValidatedStockImportOption[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(session?.stock_import_id ?? null)
  const [loading, setLoading] = useState(true)
  const [attaching, setAttaching] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idempotencyRef = useIdempotencyKey()

  useEffect(() => {
    getValidatedStockImportsForSession(sessionId).then(result => {
      if (result.data) setImports(result.data)
      setLoading(false)
    })
  }, [sessionId])

  if (!session) return null

  const hasImport = Boolean(session.stock_import_id) && selectedId !== null
  const ready = hasImport

  const handleSelect = async (importId: string) => {
    setError(null)
    setSelectedId(importId)
    setAttaching(true)
    const result = await attachStockImportToSession(companyId, sessionId, importId, makeKey())
    setAttaching(false)
    if (result.error) {
      setError(result.error)
      setSelectedId(session?.stock_import_id ?? null)
      return
    }
  }

  const handlePrepare = async () => {
    if (preparing) return
    setPreparing(true)
    setError(null)
    const key = idempotencyRef()
    const result = await prepareInventorySessionFromImport(companyId, sessionId, key)
    setPreparing(false)
    setShowConfirm(false)
    if (result.error) {
      setError(result.error)
      return
    }
    notifyInventoryNavigation()
    router.push(`/dashboard/inventarios/jornadas/${sessionId}?tab=operacion`)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
        <p className="flex items-center gap-1.5 font-semibold">
          <Lock className="h-4 w-4" /> Al preparar la sección de conteo, el stock y los costos quedarán congelados
        </p>
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300/80">
          Al preparar la sección de conteo, el stock y los costos quedarán congelados y esta importación no podrá
          reutilizarse.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Bodega inventariable heredada */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-theme-text">Bodega inventariable</h3>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Sección de conteo</p>
            <p className="truncate font-medium text-theme-text">{session.name}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Bodega</p>
            <p className="truncate font-medium text-theme-text">{session.site_name ?? '—'}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Tipo de bodega</p>
            <p className="font-medium text-theme-text">{TYPE_LABELS[session.site_type as string] ?? session.site_type ?? '—'}</p>
          </div>
          <div>
            <p className="text-[11px] text-theme-text-muted/60 uppercase tracking-wider">Fuente</p>
            <p className="font-medium text-theme-text">Archivo Excel</p>
          </div>
        </div>
      </div>

      {/* Selección de importación */}
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-theme-text">Importación de stock</h3>
        {loading ? (
          <InventoryLoadingState compact label="Cargando importaciones…" />
        ) : imports.length === 0 ? (
          <p className="rounded-lg border border-theme-border/60 bg-theme-bg px-3 py-2 text-xs text-theme-text-muted">
            No hay importaciones VALIDATED disponibles para esta bodega. Sube y valida un archivo desde{' '}
            <a href="/dashboard/inventarios/importaciones" className="text-theme-accent underline">
              Importaciones
            </a>
            .
          </p>
        ) : (
          <ul className="space-y-2">
            {imports.map(imp => {
              const selected = imp.id === selectedId
              return (
                <li key={imp.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(imp.id)}
                    disabled={attaching}
                    className={`w-full rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${
                      selected
                        ? 'border-theme-accent bg-theme-accent/10'
                        : 'border-theme-border bg-theme-bg hover:bg-theme-text/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <FileSpreadsheet className="h-4 w-4 shrink-0 text-theme-accent" />
                        <span className="truncate text-sm font-semibold text-theme-text">{imp.original_filename}</span>
                      </div>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          selected
                            ? 'border-theme-accent/40 bg-theme-accent/10 text-theme-accent'
                            : 'border-theme-border bg-theme-text/5 text-theme-text-muted'
                        }`}
                      >
                        {selected ? 'Seleccionada' : 'Seleccionar'}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-theme-text-muted">
                      <span>Modalidad: {MODALITY_LABELS[imp.modality] ?? imp.modality}</span>
                      <span>Corte: {formatDateTimeChile(imp.cutoff_at)}</span>
                      <span>Filas: {imp.row_count}</span>
                      <span>Errores: {imp.error_count}</span>
                      <span>Advertencias: {imp.warning_count}</span>
                      <span>
                        Costo: {imp.products_with_cost} con / {imp.products_without_cost} sin
                      </span>
                      <span>Cobertura: {imp.cost_coverage}%</span>
                    </div>
                    <div className="mt-2 text-[11px] text-theme-text-muted/70">
                      Validada el {formatDateTimeChile(imp.validated_at)} · {imp.created_by_name ?? '—'}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Preparar */}
      <div className="flex flex-col items-start gap-3 rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-theme-text">
            {ready ? 'Importación seleccionada' : 'Selecciona una importación'}
          </p>
          <p className="text-xs text-theme-text-muted">
            {ready
              ? 'La sección de conteo está lista para prepararse con el stock y costos congelados.'
              : 'Debes seleccionar una importación VALIDATED para poder preparar la sección de conteo.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          disabled={!ready || preparing}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
        >
          {preparing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ClipboardList className="h-4 w-4" />
          )}
          {!preparing && 'Preparar sección de conteo'}
        </button>
      </div>

      {/* Diálogo de confirmación */}
      {showConfirm && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
            <h3 className="text-base font-bold text-theme-text">Preparar sección de conteo desde importación</h3>
            <p className="mt-2 text-sm text-theme-text-muted">
              Al preparar la sección de conteo, el stock y los costos quedarán <strong>congelados</strong> y esta
              importación <strong>no podrá reutilizarse</strong>. La sección de conteo quedará en estado{' '}
              <strong>Preparada</strong>.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={preparing}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handlePrepare}
                disabled={preparing}
                className="inline-flex h-8 items-center rounded-lg bg-theme-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:opacity-40"
              >
                {preparing ? 'Preparando…' : 'Confirmar preparación'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
