'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  User,
  X,
} from 'lucide-react'
import {
  getActiveCompanyAuditProductResolutionPreview,
  getActiveCompanyAuditResolvableProducts,
  resolveActiveCompanyAuditProduct,
  type AuditDecision,
  type AuditResolutionPreview,
  type AuditResolutionResult,
  type AuditResolvableProduct,
} from '@/app/actions/inventarios/audit-resolution'
import { formatDateTimeChile, formatQuantity, formatSignedQuantity } from '@/modules/inventarios/lib/format'

function makeKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function ProductStatusBadge({ status }: { status: string }) {
  if (status === 'APPROVED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        APROBADO
      </span>
    )
  }
  if (status === 'REJECTED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300">
        <ShieldAlert className="h-3 w-3" />
        RECHAZADO
      </span>
    )
  }
  if (status === 'CANCELLED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-[10px] font-semibold text-theme-text-muted">
        CANCELADO
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
      <ClipboardCheck className="h-3 w-3" />
      PENDIENTE DE DECISIÓN
    </span>
  )
}

// Traduce el blocking_reason del preview a un mensaje de usuario.
function blockingMessage(reason: string | null): string | null {
  switch (reason) {
    case 'NO_CONTEXT':
      return 'Este producto no tiene un contexto de ubicación resoluble para reemplazar el conteo. No puede aprobarse; puedes rechazarlo para conservar el físico sin cambios.'
    case 'AMBIGUOUS_CONTEXT':
      return 'Las contribuciones a reemplazar abarcan más de un contexto de ubicación. No puede aprobarse; puedes rechazarlo para conservar el físico.'
    case 'RESULTS_INCOMPLETE':
      return 'Faltan resultados auditados para este producto. No puede aprobarse; puedes rechazarlo para conservar el físico.'
    case 'CAMPAIGN_STATE':
      return 'El inventario no admite la resolución de auditorías en su estado actual.'
    case 'ALREADY_RESOLVED':
      return 'Este producto ya fue resuelto y no admite una segunda decisión.'
    case 'PRODUCT_STATE':
      return 'El producto no está en estado SUBMITTED y no admite resolución.'
    case 'SCOPE_UNSUPPORTED':
      return 'Este producto sin ubicación previa aún no admite resolución administrativa.'
    default:
      return reason ? `No se puede resolver: ${reason}` : null
  }
}

interface DecisionDialogProps {
  preview: AuditResolutionPreview
  mode: 'approve' | 'reject'
  onClose: () => void
  onDone: (result: AuditResolutionResult) => void
}

function DecisionDialog({ preview, mode, onClose, onDone }: DecisionDialogProps) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keyRef = useRef<string | null>(null)

  const isApprove = mode === 'approve'

  const handleConfirm = async () => {
    if (busy) return
    if (isApprove) {
      if (!preview.applicable) {
        setError('Este producto no puede aprobarse en este momento.')
        return
      }
    } else if (reason.trim().length < 5) {
      setError('El motivo del rechazo debe tener al menos 5 caracteres.')
      return
    }
    if (!keyRef.current) keyRef.current = makeKey()
    setBusy(true)
    setError(null)
    const result = await resolveActiveCompanyAuditProduct({
      auditId: preview.audit_id,
      auditProductId: preview.audit_product_id,
      decision: mode as AuditDecision,
      reason: isApprove ? null : reason.trim(),
      idempotencyKey: keyRef.current,
    })
    setBusy(false)
    if (result.error || !result.data) {
      setError(result.error ?? 'No se pudo completar la resolución.')
      return
    }
    onDone(result.data)
  }

  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <h3 className="text-base font-bold text-theme-text">
            {isApprove ? 'Aprobar y reemplazar conteo' : 'Rechazar auditoría'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div className="rounded-lg border border-theme-border bg-theme-text/5 px-3 py-2 text-xs">
            <p className="font-semibold text-theme-text">{preview.name ?? `V${preview.bsale_variant_id}`}</p>
            <p className="mt-0.5 font-mono text-theme-text-muted">
              {preview.sku ?? '—'} · Auditoría #{preview.audit_number}
            </p>
          </div>

          {isApprove ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              <p className="font-semibold">Reemplazará el resultado efectivo por el conteo auditado.</p>
              <p className="mt-1">
                Físico efectivo actual <strong>{formatQuantity(preview.current_effective_quantity)}</strong> → resultado
                al aprobar <strong>{formatQuantity(preview.result_if_approved)}</strong> (auditado{' '}
                {formatQuantity(preview.audited_total)}).
              </p>
              <p className="mt-1">
                Solo se afectan las ubicaciones auditadas de este producto; el resto del inventario no cambia.
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
                <p className="font-semibold">Rechazar conserva el físico actual sin cambios.</p>
                <p className="mt-1">El resultado auditado queda registrado como histórico y este producto deja de estar pendiente.</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text">Motivo del rechazo</label>
                <textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  placeholder="Explica el motivo (mínimo 5 caracteres)…"
                  className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-border-accent"
                />
                <p className="mt-1 text-[10px] text-theme-text-muted">Entre 5 y 1000 caracteres.</p>
              </div>
            </>
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
            onClick={() => void handleConfirm()}
            disabled={busy}
            className={
              isApprove
                ? 'inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50'
                : 'inline-flex h-8 items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-sm font-semibold text-red-600 transition-colors hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400'
            }
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : isApprove ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
            {busy ? (isApprove ? 'Aprobando…' : 'Rechazando…') : isApprove ? 'Aprobar y reemplazar conteo' : 'Rechazar auditoría'}
          </button>
        </div>
      </div>
    </div>
  )
}

type PreviewState =
  | { state: 'loading' }
  | { state: 'ready'; data: AuditResolutionPreview }
  | { state: 'error'; error: string }

interface InventoryAuditResolutionDialogProps {
  auditId: string
  auditNumber: number
  auditorName: string | null
  onClose: () => void
  onResolved: () => void
}

export function InventoryAuditResolutionDialog({
  auditId,
  auditNumber,
  auditorName,
  onClose,
  onResolved,
}: InventoryAuditResolutionDialogProps) {
  const [products, setProducts] = useState<AuditResolvableProduct[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  const [resolved, setResolved] = useState<Record<string, AuditResolutionResult>>({})
  const [auditStatus, setAuditStatus] = useState<string>('')
  const [decision, setDecision] = useState<{ product: AuditResolvableProduct; preview: AuditResolutionPreview; mode: 'approve' | 'reject' } | null>(null)

  const loadPreview = useCallback(
    async (ap: AuditResolvableProduct) => {
      setPreviews(prev => ({ ...prev, [ap.audit_product_id]: { state: 'loading' } }))
      const res = await getActiveCompanyAuditProductResolutionPreview(auditId, ap.audit_product_id)
      if (res.data) {
        const data = res.data
        setPreviews(prev => ({ ...prev, [ap.audit_product_id]: { state: 'ready', data } }))
        setAuditStatus(data.audit_status)
      } else {
        setPreviews(prev => ({ ...prev, [ap.audit_product_id]: { state: 'error', error: res.error ?? 'No se pudo cargar la vista previa.' } }))
      }
    },
    [auditId]
  )

  useEffect(() => {
    let cancelled = false
    void getActiveCompanyAuditResolvableProducts(auditId).then(res => {
      if (cancelled) return
      setListLoading(false)
      if (res.error || !res.data) {
        setListError(res.error ?? 'No se pudieron cargar los productos de la auditoría.')
        return
      }
      setProducts(res.data.items)
      setAuditStatus(res.data.audit_status)
      res.data.items.forEach(ap => void loadPreview(ap))
    })
    return () => {
      cancelled = true
    }
  }, [auditId, loadPreview])

  const handleResolved = useCallback(
    (ap: AuditResolvableProduct, result: AuditResolutionResult) => {
      setResolved(prev => ({ ...prev, [ap.audit_product_id]: result }))
      setDecision(null)
      void loadPreview(ap)
      onResolved()
    },
    [loadPreview, onResolved]
  )

  const pendingCount = products.filter(p => {
    const resolvedEntry = resolved[p.audit_product_id]
    if (resolvedEntry) return false
    const preview = previews[p.audit_product_id]
    if (preview?.state === 'ready') return preview.data.product_status === 'SUBMITTED'
    return p.product_status === 'SUBMITTED'
  }).length
  const resolvedCount = products.length - pendingCount

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        {/* Cabecera */}
        <div className="flex items-center justify-between gap-2 border-b border-theme-border px-4 py-3">
          <div>
            <h2 className="text-base font-bold text-theme-text">Resolver auditoría #{auditNumber}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-theme-text-muted">
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" />
                {auditorName ?? 'Sin asignar'}
              </span>
              <span className="inline-flex items-center gap-1">
                <ClipboardCheck className="h-3 w-3" />
                {auditStatus || '…'}
              </span>
              <span>
                {pendingCount} pendiente(s) · {resolvedCount} resuelto(s)
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {listLoading && (
            <p className="flex items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-[11px] text-theme-text-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              Cargando productos auditados…
            </p>
          )}

          {!listLoading && listError && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              <span>{listError}</span>
              <button
                type="button"
                onClick={() => {
                  setListLoading(true)
                  setListError(null)
                  void getActiveCompanyAuditResolvableProducts(auditId).then(res => {
                    setListLoading(false)
                    if (res.error || !res.data) {
                      setListError(res.error ?? 'No se pudieron cargar los productos de la auditoría.')
                      return
                    }
                    setProducts(res.data.items)
                    setAuditStatus(res.data.audit_status)
                    res.data.items.forEach(ap => void loadPreview(ap))
                  })
                }}
                className="rounded-md border border-theme-border bg-theme-surface px-2 py-0.5 text-[11px] font-medium text-theme-text hover:bg-theme-text/5"
              >
                Reintentar
              </button>
            </div>
          )}

          {!listLoading && !listError && products.length === 0 && (
            <p className="rounded-lg border border-theme-border bg-theme-surface px-3 py-4 text-center text-xs text-theme-text-muted/70">
              Esta auditoría no tiene productos.
            </p>
          )}

          <div className="space-y-3">
            {products.map(ap => {
              const resolvedEntry = resolved[ap.audit_product_id]
              const previewState = previews[ap.audit_product_id]
              const preview = previewState?.state === 'ready' ? previewState.data : null
              const displayStatus = resolvedEntry
                ? resolvedEntry.decision === 'APPROVED'
                  ? 'APPROVED'
                  : 'REJECTED'
                : (preview?.product_status ?? ap.product_status)
              const isResolved = Boolean(resolvedEntry)

              const campaignMutable =
                preview?.campaign_status === 'IN_PROGRESS' || preview?.campaign_status === 'UNDER_REVIEW'

              const approveEnabled =
                Boolean(preview) && preview!.applicable === true && campaignMutable && !isResolved
              const rejectEnabled =
                Boolean(preview) &&
                !isResolved &&
                preview!.product_status === 'SUBMITTED' &&
                preview!.scope_status === 'LOCATIONS_RESOLVED' &&
                campaignMutable

              const blocking = isResolved ? null : blockingMessage(preview?.blocking_reason ?? null)

              return (
                <section key={ap.audit_product_id} className="rounded-xl border border-theme-border bg-theme-surface shadow-sm">
                  {/* Encabezado del producto */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-theme-border/60 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-mono text-xs font-bold text-theme-text">{ap.sku ?? '—'}</span>
                        <span className="truncate text-xs text-theme-text-muted">{preview?.name ?? ap.name ?? `V${ap.bsale_variant_id}`}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-theme-text-muted">
                        {preview && (
                          <>
                            <span className="inline-flex items-center gap-1">
                              <User className="h-3 w-3" />
                              {preview.auditor.name ?? 'Sin auditor'}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <CalendarClock className="h-3 w-3" />
                              {preview.submitted_at ? formatDateTimeChile(preview.submitted_at) : '—'}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <ProductStatusBadge status={displayStatus} />
                  </div>

                  <div className="px-3 py-2.5">
                    {resolvedEntry && (
                      <div
                        className={`mb-2 rounded-lg border px-3 py-2 text-xs ${
                          resolvedEntry.decision === 'APPROVED'
                            ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
                            : 'border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-300'
                        }`}
                      >
                        <p className="font-semibold">
                          {resolvedEntry.decision === 'APPROVED'
                            ? 'Conteo aprobado y aplicado.'
                            : 'Auditoría rechazada; el físico se conservó.'}
                        </p>
                        {resolvedEntry.reason && <p className="mt-0.5">Motivo: {resolvedEntry.reason}</p>}
                      </div>
                    )}

                    {previewState?.state === 'loading' && (
                      <p className="flex items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-[11px] text-theme-text-muted">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Cargando vista previa…
                      </p>
                    )}

                    {previewState?.state === 'error' && (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                        <span>{previewState.error}</span>
                        <button
                          type="button"
                          onClick={() => void loadPreview(ap)}
                          className="rounded-md border border-theme-border bg-theme-surface px-2 py-0.5 text-[11px] font-medium text-theme-text hover:bg-theme-text/5"
                        >
                          Reintentar
                        </button>
                      </div>
                    )}

                    {preview && (
                      <>
                        {/* Resumen actual → auditado → resultado */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
                          <div className="rounded-lg border border-theme-border bg-theme-text/[0.03] px-2.5 py-2">
                            <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Físico efectivo actual</p>
                            <p className="text-base font-bold text-theme-text">{formatQuantity(preview.current_effective_quantity)}</p>
                          </div>
                          <div className="rounded-lg border border-theme-border bg-theme-text/[0.03] px-2.5 py-2">
                            <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Cantidad auditada</p>
                            <p className="text-base font-bold text-sky-600 dark:text-sky-400">{formatQuantity(preview.audited_total)}</p>
                          </div>
                          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2">
                            <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Resultado al aprobar</p>
                            <p className="text-base font-bold text-emerald-600 dark:text-emerald-400">{formatQuantity(preview.result_if_approved)}</p>
                          </div>
                          <div className="rounded-lg border border-theme-border bg-theme-text/[0.03] px-2.5 py-2">
                            <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Delta</p>
                            <p
                              className={`text-base font-bold ${
                                preview.delta < 0 ? 'text-red-600 dark:text-red-400' : preview.delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-theme-text'
                              }`}
                            >
                              {formatSignedQuantity(preview.delta)}
                            </p>
                          </div>
                        </div>

                        {/* Detalle por ubicación */}
                        {preview.locations.length > 0 && (
                          <div className="mt-2 overflow-x-auto rounded-lg border border-theme-border">
                            <table className="w-full min-w-[520px] border-collapse text-left text-xs">
                              <thead>
                                <tr className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] uppercase tracking-wider text-theme-text-muted">
                                  <th className="px-3 py-1.5">Ubicación</th>
                                  <th className="px-3 py-1.5 text-right">Efectivo actual</th>
                                  <th className="px-3 py-1.5 text-right">Auditado</th>
                                  <th className="px-3 py-1.5 text-right">Delta</th>
                                  <th className="px-3 py-1.5">Contexto</th>
                                </tr>
                              </thead>
                              <tbody>
                                {preview.locations.map(loc => (
                                  <tr key={loc.audit_location_id} className="border-b border-theme-border/50 last:border-0">
                                    <td className="px-3 py-1.5">
                                      <div className="flex items-center gap-1.5">
                                        <MapPin className="h-3 w-3 shrink-0 text-theme-text-muted/50" />
                                        <span className="text-theme-text">{loc.location_name ?? loc.location_code ?? '—'}</span>
                                        {loc.location_code && loc.location_name && (
                                          <span className="font-mono text-[10px] text-theme-text-muted">({loc.location_code})</span>
                                        )}
                                      </div>
                                    </td>
                                    <td className="px-3 py-1.5 text-right text-theme-text">{formatQuantity(loc.current_effective_quantity)}</td>
                                    <td className="px-3 py-1.5 text-right font-medium text-sky-600 dark:text-sky-400">
                                      {loc.audited_quantity === null ? '—' : formatQuantity(loc.audited_quantity)}
                                    </td>
                                    <td className="px-3 py-1.5 text-right">
                                      {loc.delta === null ? (
                                        <span className="text-theme-text-muted/60">—</span>
                                      ) : (
                                        <span
                                          className={
                                            loc.delta < 0
                                              ? 'font-semibold text-red-600 dark:text-red-400'
                                              : loc.delta > 0
                                                ? 'font-semibold text-emerald-600 dark:text-emerald-400'
                                                : 'font-medium text-theme-text'
                                          }
                                        >
                                          {formatSignedQuantity(loc.delta)}
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-3 py-1.5">
                                      {loc.context_error ? (
                                        <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                          {loc.context_error === 'NO_CONTEXT' ? 'Sin contexto' : loc.context_error === 'AMBIGUOUS_CONTEXT' ? 'Contexto ambiguo' : loc.context_error}
                                        </span>
                                      ) : (
                                        <span className="text-[10px] text-theme-text-muted/60">Resoluble</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* Bloqueo */}
                        {blocking && !isResolved && (
                          <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            {blocking}
                          </p>
                        )}

                        {/* Acciones */}
                        {!isResolved && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setDecision({ product: ap, preview, mode: 'approve' })}
                              disabled={!approveEnabled}
                              title={!approveEnabled ? (preview.applicable ? undefined : blockingMessage(preview.blocking_reason) ?? 'No se puede aprobar en este momento') : undefined}
                              className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                              Aprobar y reemplazar conteo
                            </button>
                            <button
                              type="button"
                              onClick={() => setDecision({ product: ap, preview, mode: 'reject' })}
                              disabled={!rejectEnabled}
                              title={!rejectEnabled ? 'Este producto no puede rechazarse en este momento.' : undefined}
                              className="inline-flex h-7 items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400"
                            >
                              <ShieldAlert className="h-3.5 w-3.5" />
                              Rechazar auditoría
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        </div>

        <div className="flex justify-end border-t border-theme-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            Cerrar
          </button>
        </div>
      </div>

      {decision && (
        <DecisionDialog
          preview={decision.preview}
          mode={decision.mode}
          onClose={() => setDecision(null)}
          onDone={result => handleResolved(decision.product, result)}
        />
      )}
    </div>
  )
}
