'use client'

import { useRef, useState } from 'react'
import { AlertTriangle, Loader2, ShieldCheck, X } from 'lucide-react'
import {
  getActiveCompanyCampaignClose,
  type CampaignCloseReadiness,
  type CampaignReadinessDetailType,
} from '@/app/actions/inventarios/campaign-report'
import { MetricDetailDialog, type MetricColumn } from '@/modules/inventarios/components/inventory-metric-detail-dialog'

interface PendienteDetail {
  title: string
  countLabel: string
  detailType: CampaignReadinessDetailType
  columns: MetricColumn[]
}

const PENDIENTE_CONFIGS: Record<string, Omit<PendienteDetail, 'title' | 'countLabel'>> = {
  sessions_draft: {
    detailType: 'PENDING_SESSIONS',
    columns: [
      { key: 'bodega', label: 'Bodega / Sección', primary: true },
      { key: 'estado', label: 'Estado' },
      { key: 'situacion', label: 'Situación', kind: 'badge' },
    ],
  },
  sessions_prepared: {
    detailType: 'PENDING_SESSIONS',
    columns: [
      { key: 'bodega', label: 'Bodega / Sección', primary: true },
      { key: 'estado', label: 'Estado' },
      { key: 'situacion', label: 'Situación', kind: 'badge' },
    ],
  },
  sessions_counting: {
    detailType: 'COUNTING_SESSIONS',
    columns: [
      { key: 'bodega', label: 'Bodega / Sección', primary: true },
      { key: 'estado', label: 'Estado' },
      { key: 'zonas_total', label: 'Zonas', kind: 'quantity' },
      { key: 'zonas_completadas', label: 'Completadas', kind: 'quantity' },
      { key: 'zonas_en_curso', label: 'En curso', kind: 'quantity' },
      { key: 'ubicaciones_visitadas', label: 'Progreso', kind: 'progress', valueKey: 'ubicaciones_visitadas', totalKey: 'ubicaciones_total' },
    ],
  },
  locations_open: {
    detailType: 'OPEN_LOCATIONS',
    columns: [
      { key: 'bodega', label: 'Bodega / Sección', primary: true },
      { key: 'zona', label: 'Zona' },
      { key: 'ubicacion', label: 'Ubicación' },
      { key: 'responsable', label: 'Responsable' },
      { key: 'abierta_desde', label: 'Abierta desde', kind: 'date' },
      { key: 'situacion', label: 'Situación', kind: 'badge' },
    ],
  },
  locations_never_visited: {
    detailType: 'NEVER_VISITED_LOCATIONS',
    columns: [
      { key: 'bodega', label: 'Bodega / Sección', primary: true },
      { key: 'zona', label: 'Zona' },
      { key: 'ubicacion', label: 'Ubicación' },
      { key: 'situacion', label: 'Situación', kind: 'badge' },
    ],
  },
  zones_incomplete: {
    detailType: 'IN_PROGRESS_ZONES',
    columns: [
      { key: 'bodega', label: 'Bodega / Sección', primary: true },
      { key: 'zona', label: 'Zona' },
      { key: 'responsable', label: 'Responsable' },
      { key: 'ubicaciones_visitadas', label: 'Progreso', kind: 'progress', valueKey: 'ubicaciones_visitadas', totalKey: 'ubicaciones_total' },
      { key: 'situacion', label: 'Situación', kind: 'badge' },
    ],
  },
  zones_not_started: {
    detailType: 'IN_PROGRESS_ZONES',
    columns: [
      { key: 'bodega', label: 'Bodega / Sección', primary: true },
      { key: 'zona', label: 'Zona' },
      { key: 'responsable', label: 'Responsable' },
      { key: 'situacion', label: 'Situación', kind: 'badge' },
    ],
  },
  pending_barcode_proposals: {
    detailType: 'PENDING_BARCODES',
    columns: [
      { key: 'codigo_escaneado', label: 'Código escaneado', primary: true },
      { key: 'producto', label: 'SKU / Producto propuesto' },
      { key: 'bodega', label: 'Bodega / Sección' },
      { key: 'zona', label: 'Zona' },
      { key: 'ubicacion', label: 'Ubicación' },
      { key: 'estado', label: 'Estado', kind: 'badge' },
    ],
  },
  products_out_of_snapshot: {
    detailType: 'OUT_OF_SNAPSHOT_PRODUCTS',
    columns: [
      { key: 'sku', label: 'SKU', primary: true },
      { key: 'producto', label: 'Producto' },
      { key: 'stock_teorico', label: 'Stock teórico', kind: 'quantity', numeric: true },
      { key: 'costo_unitario', label: 'Costo unitario', kind: 'money', numeric: true },
      { key: 'situacion', label: 'Situación', kind: 'badge' },
    ],
  },
}

function newOperationKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function formatBusinessError(error: string, businessCode?: string): string {
  if (businessCode === 'PERMISSION_REQUIRED') return 'No tienes permisos para cerrar este inventario.'
  if (businessCode === 'ALREADY_CLOSED') return 'El inventario ya se encuentra cerrado.'
  if (businessCode === 'CONFIRM_REQUIRED') return 'Confirma que deseas cerrar el inventario con los pendientes.'
  if (businessCode === 'BLOCKING_INCIDENTS')
    return 'Existen incidentes críticos o recuentos sin decisión que impiden el cierre.'
  if (error && error.includes('INV_')) return 'No fue posible cerrar el inventario.'
  return error || 'No se pudo cerrar el inventario.'
}

interface InventoryCampaignCloseDialogProps {
  campaignId: string
  campaignName: string
  readiness: CampaignCloseReadiness
  onClose: () => void
  onClosed: () => void
}

export function InventoryCampaignCloseDialog({ campaignId, campaignName, readiness, onClose, onClosed }: InventoryCampaignCloseDialogProps) {
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendiente, setPendiente] = useState<PendienteDetail | null>(null)
  const keyRef = useRef<string | null>(null)

  const w = readiness.warnings
  const blockerCount = readiness.blocker_count ?? 0
  const hasBlockers = blockerCount > 0
  const hasWarnings = (readiness.warning_count ?? 0) > 0
  const validReason = reason.trim().length >= 5 && reason.trim().length <= 1000

  const handleConfirm = async () => {
    if (busy) return
    if (hasBlockers) return
    if (reason.trim().length < 5 || reason.trim().length > 1000) {
      setError('El motivo debe tener entre 5 y 1000 caracteres.')
      return
    }
    if (hasWarnings && !confirm) {
      setError('Debes confirmar el cierre con los pendientes para continuar.')
      return
    }
    if (!keyRef.current) keyRef.current = newOperationKey()
    setBusy(true)
    setError(null)
    const result = await getActiveCompanyCampaignClose(campaignId, reason.trim(), hasWarnings ? confirm : true, keyRef.current)
    setBusy(false)
    if (result.error || !result.data) {
      setError(formatBusinessError(result.error ?? '', result.businessCode))
      return
    }
    onClosed()
  }

  const openPendiente = (key: string, title: string, countLabel: string) => {
    const config = PENDIENTE_CONFIGS[key]
    if (!config) return
    setPendiente({ title, countLabel, ...config })
  }

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-theme-text-muted/60" />
            <h3 className="text-base font-bold text-theme-text">Cerrar inventario</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar diálogo"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-sm text-theme-text">{campaignName}</p>

          {hasBlockers && (
            <div className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              <p className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="h-3.5 w-3.5" />
                El inventario no puede cerrarse por los siguientes bloqueadores:
              </p>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {readiness.blockers?.blocking_incident_count > 0 && <li>Incidentes críticos o bloqueantes pendientes.</li>}
                {readiness.blockers?.undecided_recount_count > 0 && (
                  <li>Recuentos terminados sin decisión aplicable.</li>
                )}
              </ul>
            </div>
          )}

          {hasWarnings && !hasBlockers && (
            <div className="rounded-lg border border-theme-border bg-theme-surface/60 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500 dark:text-sky-400" />
                <div>
                  <p className="text-xs font-bold text-theme-text">Elementos pendientes detectados</p>
                  <p className="mt-0.5 text-[11px] text-theme-text-muted/80">
                    El cierre puede continuar, pero estos pendientes quedarán registrados.
                  </p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {w.sessions_draft > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('sessions_draft', 'Secciones pendientes', 'secciones')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px] font-medium text-theme-text transition-colors hover:bg-theme-text/5"
                  >
                    {w.sessions_draft} secciones pendientes
                  </button>
                )}
                {w.sessions_prepared > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('sessions_prepared', 'Secciones preparadas', 'secciones')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px] font-medium text-theme-text transition-colors hover:bg-theme-text/5"
                  >
                    {w.sessions_prepared} preparadas
                  </button>
                )}
                {w.sessions_counting > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('sessions_counting', 'Secciones en conteo', 'secciones')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-sky-500/25 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-700 transition-colors hover:bg-sky-500/20 dark:text-sky-300"
                  >
                    {w.sessions_counting} en conteo
                  </button>
                )}
                {w.locations_open > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('locations_open', 'Ubicaciones abiertas', 'ubicaciones')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-sky-500/25 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-700 transition-colors hover:bg-sky-500/20 dark:text-sky-300"
                  >
                    {w.locations_open} ubicaciones abiertas
                  </button>
                )}
                {w.locations_never_visited > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('locations_never_visited', 'Ubicaciones nunca visitadas', 'ubicaciones')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px] font-medium text-theme-text transition-colors hover:bg-theme-text/5"
                  >
                    {w.locations_never_visited} nunca visitadas
                  </button>
                )}
                {w.zones_incomplete > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('zones_incomplete', 'Zonas en curso', 'zonas')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px] font-medium text-theme-text transition-colors hover:bg-theme-text/5"
                  >
                    {w.zones_incomplete} zonas en curso
                  </button>
                )}
                {w.zones_not_started > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('zones_not_started', 'Zonas no iniciadas', 'zonas')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px] font-medium text-theme-text transition-colors hover:bg-theme-text/5"
                  >
                    {w.zones_not_started} zonas no iniciadas
                  </button>
                )}
                {w.pending_barcode_proposals > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('pending_barcode_proposals', 'Códigos pendientes de revisión', 'códigos')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px] font-medium text-theme-text transition-colors hover:bg-theme-text/5"
                  >
                    {w.pending_barcode_proposals} códigos pendientes
                  </button>
                )}
                {w.products_out_of_snapshot > 0 && (
                  <button
                    type="button"
                    onDoubleClick={() => openPendiente('products_out_of_snapshot', 'Productos no incluidos para conteo', 'productos')}
                    title="Doble clic para ver el detalle"
                    className="inline-flex cursor-pointer items-center rounded-md border border-theme-border bg-theme-surface px-2 py-1 text-[11px] font-medium text-theme-text transition-colors hover:bg-theme-text/5"
                  >
                    {w.products_out_of_snapshot} no incluidos para conteo
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-theme-border bg-theme-text/5 px-3 py-2 text-xs text-theme-text-muted">
            <p className="font-semibold text-theme-text">Esta acción finalizará todas las tareas y bloqueará nuevas capturas.</p>
            <p className="mt-1">Las zonas o ubicaciones no contadas permanecerán identificadas como tales.</p>
          </div>

          <div>
            <label htmlFor="close-reason" className="mb-1 block text-xs font-semibold text-theme-text">
              Motivo del cierre
            </label>
            <textarea
              id="close-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              placeholder="Conteo físico finalizado por el equipo."
              className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-border-accent"
            />
            <p className="mt-1 text-[11px] text-theme-text-muted/70">Mínimo 5 caracteres.</p>
          </div>

          {hasWarnings && !hasBlockers && (
            <label className="flex items-start gap-2 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text">
              <input
                type="checkbox"
                checked={confirm}
                onChange={e => setConfirm(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <span>Confirmo que deseo cerrar el Inventario con estos pendientes.</span>
            </label>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-theme-border/60 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || hasBlockers || !validReason || (hasWarnings && !confirm)}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-red-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {busy ? 'Cerrando inventario...' : 'Cerrar inventario'}
          </button>
        </div>
      </div>

      {pendiente && (
        <MetricDetailDialog
          campaignId={campaignId}
          title={pendiente.title}
          countLabel={pendiente.countLabel}
          detailType={pendiente.detailType}
          columns={pendiente.columns}
          onClose={() => setPendiente(null)}
        />
      )}
    </div>
  )
}
