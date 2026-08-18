'use client'

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Barcode, Camera, ChevronDown, ChevronUp, Loader2, Search, ShieldCheck, Trash2, Wrench, X } from 'lucide-react'
import {
  approveBarcode,
  correctActiveCompanyBarcodeIncidentProduct,
  getActiveCompanyBarcodeDetail,
  getActiveCompanyBarcodeEvidence,
  invalidateActiveCompanyBarcodeIncidentCount,
  rejectBarcode,
  searchActiveCompanyBarcodeIncidentTargetProducts,
  type BarcodeIncidentDetailResult,
  type BarcodeProductSearchItem,
  type BarcodeRejectReasonCode,
  type CountInvalidateReasonCode,
} from '@/app/actions/inventarios/campaign-report'
import { formatDateTimeChile, formatQuantity } from '@/modules/inventarios/lib/format'

const REASON_OPTIONS: Array<{ value: BarcodeRejectReasonCode; label: string }> = [
  { value: 'CODE_NOT_MATCH_PRODUCT', label: 'El código no corresponde al producto' },
  { value: 'PHOTO_INVALID', label: 'La evidencia no permite validar' },
  { value: 'LABEL_OTHER_PRODUCT', label: 'La etiqueta corresponde a otro producto' },
  { value: 'INTERNAL_NOT_REUSABLE', label: 'Código interno/no reutilizable' },
  { value: 'OTHER', label: 'Otro' },
]

const REMOVE_REASON_OPTIONS: Array<{ value: CountInvalidateReasonCode; label: string }> = [
  { value: 'DUPLICATE_COUNT', label: 'Conteo duplicado' },
  { value: 'ENTRY_ERROR', label: 'Registro ingresado por error' },
  { value: 'NOT_PART_OF_INVENTORY', label: 'No correspondía incluirlo en el Inventario' },
  { value: 'INVALID_EVIDENCE', label: 'Evidencia/detección inválida' },
  { value: 'OTHER', label: 'Otro' },
]

function newOperationKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function formatError(error: string, businessCode: string | undefined, mode: 'approve' | 'reject'): string {
  if (businessCode === 'PERMISSION_REQUIRED') return 'No tienes permisos para esta acción.'
  if (businessCode === 'BARCODE_ALREADY_ASSOCIATED')
    return 'Este código ya está asociado oficialmente a otro producto.'
  if (error.includes('INV_')) return 'No se pudo completar la operación.'
  return mode === 'approve'
    ? 'No fue posible autorizar el código. Intenta nuevamente.'
    : 'No fue posible rechazar el código. Intenta nuevamente.'
}

function formatPhysicalError(error: string, businessCode: string | undefined): string {
  if (businessCode === 'PERMISSION_REQUIRED') return 'No tienes permisos para corregir el conteo físico.'
  if (businessCode === 'CAMPAIGN_ALREADY_APPROVED') return 'El Inventario ya fue cerrado y su resultado físico es definitivo.'
  if (businessCode === 'SESSION_ALREADY_APPROVED')
    return 'La sesión ya fue aprobada; esta versión bloquea correcciones físicas hasta tener reapertura administrativa.'
  if (error.includes('INV_')) return 'No se pudo completar la corrección del conteo.'
  return error || 'No se pudo completar la corrección del conteo.'
}

interface PhotoViewerProps {
  productName: string
  sku: string | null
  bsaleBarcode: string | null
  scannedCode: string
  bodega: string | null
  zone: string | null
  location: string | null
  countedByName: string | null
  capturedAt: string | null
  physicalQuantity: number
  signedUrl: string | null
  onClose: () => void
}

function PhotoViewer({
  productName,
  sku,
  bsaleBarcode,
  scannedCode,
  bodega,
  zone,
  location,
  countedByName,
  capturedAt,
  physicalQuantity,
  signedUrl,
  onClose,
}: PhotoViewerProps) {
  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <h3 className="text-base font-bold text-theme-text">Evidencia fotográfica</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar foto"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[1fr_260px]">
          <div className="flex min-h-72 items-center justify-center">
            {signedUrl ? (
              <img
                src={signedUrl}
                alt={`Evidencia ${scannedCode}`}
                className="max-h-[60vh] w-auto rounded-lg border border-theme-border bg-theme-bg"
              />
            ) : (
              <div className="flex min-h-52 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 text-center">
                <Camera className="h-8 w-8 text-theme-text-muted/50" />
                <p className="text-sm font-semibold text-theme-text">Sin evidencia fotográfica</p>
                <p className="max-w-xs text-xs text-theme-text-muted/70">
                  No se encontró una fotografía disponible para esta detección.
                </p>
              </div>
            )}
          </div>
          <div className="space-y-2.5 rounded-xl border border-theme-border bg-theme-surface px-3 py-3 text-xs">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Producto</span>
              <span className="font-semibold text-theme-text">{productName}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">SKU</span>
              <span className="font-mono text-theme-text">{sku ?? '—'}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Código registrado en Bsale</span>
              <span className="font-mono text-theme-text">{bsaleBarcode ?? 'Sin código registrado en Bsale'}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Código encontrado</span>
              <span className="font-mono text-theme-text">{scannedCode}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Bodega</span>
              <span className="text-theme-text">{bodega ?? '—'}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Zona</span>
              <span className="text-theme-text">{zone ?? '—'}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Ubicación</span>
              <span className="text-theme-text">{location ?? '—'}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Contador</span>
              <span className="text-theme-text">{countedByName ?? '—'}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Fecha / hora</span>
              <span className="text-theme-text">{formatDateTimeChile(capturedAt)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Cantidad</span>
              <span className="font-semibold text-theme-text">{formatQuantity(physicalQuantity)}</span>
            </div>
          </div>
        </div>
        <div className="flex justify-end border-t border-theme-border/60 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}

interface DecisionDialogProps {
  productName: string
  sku: string | null
  scannedCode: string
  bsaleVariantId: number
  campaignId: string
  companyId: string
  mode: 'approve' | 'reject'
  onDone: () => void
  onClose: () => void
}

function DecisionDialog({ productName, sku, scannedCode, bsaleVariantId, campaignId, companyId, mode, onDone, onClose }: DecisionDialogProps) {
  const [reasonCode, setReasonCode] = useState<BarcodeRejectReasonCode | ''>('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keyRef = useRef<string | null>(null)

  const isReject = mode === 'reject'
  const notesRequired = isReject && reasonCode === 'OTHER'

  const handleConfirm = async () => {
    if (busy) return
    if (isReject) {
      if (!reasonCode) {
        setError('Selecciona un motivo de rechazo.')
        return
      }
      if (notesRequired && notes.trim().length < 5) {
        setError('El motivo Otro requiere una nota explicativa (mínimo 5 caracteres).')
        return
      }
    }
    if (!keyRef.current) keyRef.current = newOperationKey()
    setBusy(true)
    setError(null)
    const result = isReject
      ? await rejectBarcode(companyId, campaignId, scannedCode, bsaleVariantId, reasonCode as BarcodeRejectReasonCode, notes.trim(), keyRef.current)
      : await approveBarcode(companyId, campaignId, scannedCode, bsaleVariantId, keyRef.current)
    setBusy(false)
    if (result.error || !result.data) {
      setError(formatError(result.error ?? '', result.businessCode, isReject ? 'reject' : 'approve'))
      return
    }
    onDone()
  }

  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <h3 className="text-base font-bold text-theme-text">{isReject ? 'Rechazar código' : 'Autorizar código'}</h3>
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
            <p className="font-semibold text-theme-text">{productName}</p>
            <p className="mt-0.5 font-mono text-theme-text-muted">
              Código encontrado {scannedCode} {sku ? `· SKU ${sku}` : ''}
            </p>
          </div>

          {isReject ? (
            <>
              <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
                <p className="font-semibold">Rechazar este código no elimina el conteo físico registrado.</p>
                <p className="mt-1">
                  Si el producto seleccionado también es incorrecto, queda pendiente revisar/corregir ese conteo antes de
                  cerrar el Inventario.
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text">Motivo del rechazo</label>
                <select
                  value={reasonCode}
                  onChange={e => setReasonCode(e.target.value as BarcodeRejectReasonCode | '')}
                  className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-border-accent"
                >
                  <option value="">Selecciona un motivo…</option>
                  {REASON_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text">
                  Notas {notesRequired ? '(obligatorias)' : '(opcional)'}
                </label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-border-accent"
                  placeholder="Contexto del rechazo…"
                />
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              Autorizarás que este código queda reconocido como válido para <strong>{productName}</strong>. Todas las
              ocurrencias pendientes de este código se resolverán como autorizadas.
            </div>
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
            disabled={busy}
            className={
              isReject
                ? 'inline-flex h-8 items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-sm font-semibold text-red-600 transition-colors hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400'
                : 'inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50'
            }
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {busy ? (isReject ? 'Rechazando…' : 'Autorizando…') : isReject ? 'Rechazar código' : 'Autorizar código'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface CountCorrectionDialogProps {
  productName: string
  sku: string | null
  bsaleBarcode: string | null
  campaignId: string
  occurrence: BarcodeIncidentDetailResult['occurrences'][number]
  currentBsaleVariantId: number
  onDone: () => void
  onClose: () => void
}

function CountCorrectionDialog({
  productName,
  sku,
  bsaleBarcode,
  campaignId,
  occurrence,
  currentBsaleVariantId,
  onDone,
  onClose,
}: CountCorrectionDialogProps) {
  const [mode, setMode] = useState<'product' | 'remove'>('product')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<BarcodeProductSearchItem[]>([])
  const [selected, setSelected] = useState<BarcodeProductSearchItem | null>(null)
  const [reasonCode, setReasonCode] = useState<CountInvalidateReasonCode | ''>('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef<string | null>(null)

  const runSearch = async () => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    setError(null)
    const result = await searchActiveCompanyBarcodeIncidentTargetProducts(campaignId, query.trim(), currentBsaleVariantId)
    setSearching(false)
    if (result.error || !result.data) {
      setError(result.error ?? 'No se pudieron buscar productos.')
      return
    }
    setResults(result.data.items)
  }

  const confirm = async () => {
    if (busy) return
    setError(null)
    if (!keyRef.current) keyRef.current = newOperationKey()

    if (mode === 'product') {
      if (!selected) {
        setError('Selecciona el producto correcto.')
        return
      }
      setBusy(true)
      const result = await correctActiveCompanyBarcodeIncidentProduct(
        campaignId,
        occurrence.proposal_id,
        selected.bsale_variant_id,
        `Producto corregido desde incidencias de código. Código encontrado: ${occurrence.scanned_code}.`,
        keyRef.current,
      )
      setBusy(false)
      if (result.error || !result.data) {
        setError(formatPhysicalError(result.error ?? '', result.businessCode))
        return
      }
      onDone()
      return
    }

    if (!reasonCode) {
      setError('Selecciona un motivo.')
      return
    }
    if (reasonCode === 'OTHER' && notes.trim().length < 5) {
      setError('El motivo Otro requiere una nota explicativa.')
      return
    }
    const reasonLabel = REMOVE_REASON_OPTIONS.find(o => o.value === reasonCode)?.label ?? reasonCode
    const reason = reasonCode === 'OTHER' ? notes.trim() : `${reasonLabel}${notes.trim() ? `. ${notes.trim()}` : ''}`
    setBusy(true)
    const result = await invalidateActiveCompanyBarcodeIncidentCount(
      campaignId,
      occurrence.proposal_id,
      reasonCode,
      reason,
      keyRef.current,
    )
    setBusy(false)
    if (result.error || !result.data) {
      setError(formatPhysicalError(result.error ?? '', result.businessCode))
      return
    }
    onDone()
  }

  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-theme-border/60 px-4 py-3">
          <h3 className="text-base font-bold text-theme-text">Corregir conteo</h3>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div className="grid gap-2 rounded-lg border border-theme-border bg-theme-text/5 px-3 py-2 text-xs sm:grid-cols-2">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Producto registrado</p>
              <p className="font-semibold text-theme-text">{productName}</p>
              <p className="font-mono text-theme-text-muted">SKU {sku ?? '—'}</p>
              <p className="font-mono text-theme-text-muted">Código Bsale {bsaleBarcode ?? '—'}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Contexto físico</p>
              <p className="text-theme-text">{formatQuantity(occurrence.physical_quantity)} unidades</p>
              <p className="font-mono text-theme-text-muted">Código encontrado {occurrence.scanned_code}</p>
              <p className="text-theme-text-muted">
                {occurrence.bodega ?? '—'} · {occurrence.zone_code ?? '—'} · {occurrence.location_code ?? '—'}
              </p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setMode('product')} className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${mode === 'product' ? 'border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'border-theme-border bg-theme-surface text-theme-text-muted hover:bg-theme-text/5'}`}>
              <span className="block font-semibold">El producto es incorrecto</span>
              <span>Las unidades sí fueron encontradas, pero pertenecen a otro producto.</span>
            </button>
            <button type="button" onClick={() => setMode('remove')} className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${mode === 'remove' ? 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-theme-border bg-theme-surface text-theme-text-muted hover:bg-theme-text/5'}`}>
              <span className="block font-semibold">Eliminar del conteo</span>
              <span>Este registro no debe formar parte del resultado físico del Inventario.</span>
            </button>
          </div>

          {mode === 'product' ? (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text">Buscar producto correcto</label>
                <div className="flex gap-2">
                  <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void runSearch() }} className="h-8 flex-1 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-border-accent" placeholder="SKU o descripción" />
                  <button type="button" onClick={() => void runSearch()} disabled={searching} className="inline-flex h-8 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text hover:bg-theme-text/5 disabled:opacity-50">
                    {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    Buscar
                  </button>
                </div>
              </div>
              {results.length > 0 && (
                <div className="max-h-52 overflow-y-auto rounded-lg border border-theme-border">
                  {results.map(item => (
                    <button type="button" key={item.bsale_variant_id} onClick={() => setSelected(item)} className={`grid w-full grid-cols-[1fr_auto] gap-2 border-b border-theme-border/40 px-3 py-2 text-left text-xs last:border-b-0 ${selected?.bsale_variant_id === item.bsale_variant_id ? 'bg-sky-500/10' : 'hover:bg-theme-text/5'}`}>
                      <span>
                        <span className="block font-semibold text-theme-text">{item.product_name ?? 'Producto'}</span>
                        <span className="font-mono text-theme-text-muted">SKU {item.sku ?? '—'}</span>
                      </span>
                      <span className="font-mono text-theme-text-muted">Bsale {item.bsale_code ?? item.bsale_variant_id}</span>
                    </button>
                  ))}
                </div>
              )}
              {selected && (
                <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
                  <p className="font-semibold">Se corregirá el conteo:</p>
                  <p className="mt-1">De: {productName} — {formatQuantity(occurrence.physical_quantity)} unidades</p>
                  <p>A: {selected.product_name ?? 'Producto'} — {formatQuantity(occurrence.physical_quantity)} unidades</p>
                  <p className="mt-2 font-semibold">El registro original y su evidencia se conservarán para auditoría.</p>
                  <p>El código encontrado no será autorizado automáticamente.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                <p className="font-semibold">Se eliminarán {formatQuantity(occurrence.physical_quantity)} unidades del resultado físico de:</p>
                <p className="mt-1 font-bold">{productName}</p>
                <p className="mt-2 font-semibold">Esta acción quitará estas unidades del resultado del Inventario.</p>
                <p>El registro original, la evidencia y la decisión administrativa se conservarán para auditoría.</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text">Motivo</label>
                <select value={reasonCode} onChange={e => setReasonCode(e.target.value as CountInvalidateReasonCode | '')} className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-border-accent">
                  <option value="">Selecciona un motivo…</option>
                  {REMOVE_REASON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-theme-text">Nota {reasonCode === 'OTHER' ? '(obligatoria)' : '(opcional)'}</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-border-accent" placeholder="Contexto administrativo" />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-theme-border/60 px-4 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted hover:bg-theme-text/5">Cancelar</button>
          <button type="button" onClick={() => void confirm()} disabled={busy} className={mode === 'remove' ? 'inline-flex h-8 items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-sm font-semibold text-red-600 transition-colors hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400' : 'inline-flex h-8 items-center gap-1 rounded-lg bg-sky-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50'}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'remove' ? <Trash2 className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}
            {busy ? 'Procesando…' : mode === 'remove' ? 'Eliminar del conteo' : 'Confirmar corrección'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface InventoryBarcodeIncidentDetailProps {
  campaignId: string
  companyId: string
  initialDetail: BarcodeIncidentDetailResult
}

export function InventoryBarcodeIncidentDetail({ campaignId, companyId, initialDetail }: InventoryBarcodeIncidentDetailProps) {
  const [detail, setDetail] = useState<BarcodeIncidentDetailResult>(initialDetail)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [photo, setPhoto] = useState<{ occurrence: BarcodeIncidentDetailResult['occurrences'][number]; signedUrl: string | null } | null>(null)
  const [photoLoading, setPhotoLoading] = useState(false)
  const [decision, setDecision] = useState<{ mode: 'approve' | 'reject'; scannedCode: string } | null>(null)
  const [correction, setCorrection] = useState<BarcodeIncidentDetailResult['occurrences'][number] | null>(null)

  const product = detail.product
  const canReview = Boolean(detail.can_review_barcodes_authorized)
  // Congelado: campaña APPROVED/CANCELLED → solo lectura (consultar fotos/historial,
  // sin autorizar/rechazar/corregir). El backend rechaza cualquier mutación.
  const frozen = detail.campaign_status === 'APPROVED' || detail.campaign_status === 'CANCELLED'
  const canMutate = canReview && !frozen

  const reload = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    const result = await getActiveCompanyBarcodeDetail(campaignId, product?.bsale_variant_id ?? 0)
    setLoading(false)
    if (result.error || !result.data) {
      setError(result.error ?? 'No se pudo cargar el detalle.')
      return
    }
    setDetail(result.data)
  }, [companyId, campaignId, product?.bsale_variant_id])

  const openPhoto = async (occurrence: BarcodeIncidentDetailResult['occurrences'][number]) => {
    if (!companyId || !occurrence.evidence_id) return
    setPhotoLoading(true)
    const result = await getActiveCompanyBarcodeEvidence(campaignId, occurrence.evidence_id)
    setPhotoLoading(false)
    setPhoto({ occurrence, signedUrl: result.data?.signed_url ?? null })
  }

  const handleDecided = () => {
    setDecision(null)
    setCorrection(null)
    void reload()
  }

  const barcodeUnits = detail.barcodes.map(b => {
    const occurrences = detail.occurrences.filter(o => o.scanned_code === b.scanned_code)
    return { ...b, occurrences }
  })

  return (
    <div className="space-y-3">
      <nav className="flex items-center gap-1.5 text-xs text-theme-text-muted">
        <Link href="/dashboard/inventarios" className="transition-colors hover:text-theme-text">
          Inventarios
        </Link>
        <span>/</span>
        <Link href={`/dashboard/inventarios/campanas/${campaignId}`} className="transition-colors hover:text-theme-text">
          Inventario actual
        </Link>
        <span>/</span>
        <Link
          href={`/dashboard/inventarios/campanas/${campaignId}/incidencias-codigos`}
          className="transition-colors hover:text-theme-text"
        >
          Incidencias de códigos
        </Link>
        <span>/</span>
        <span className="font-medium text-theme-text">Detalle del producto</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/dashboard/inventarios/campanas/${campaignId}/incidencias-codigos`}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Volver al listado
        </Link>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowLeft className="hidden" />}
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {product && (
        <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-sm">
          <h1 className="text-lg font-bold text-theme-text">{product.product_name ?? 'Producto'}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-theme-text-muted">
            <span>
              SKU: <strong className="font-mono text-theme-text">{product.sku ?? '—'}</strong>
            </span>
            <span>
              Código registrado en Bsale:{' '}
              <strong className="font-mono text-theme-text">{product.bsale_barcode ?? 'Sin código registrado en Bsale'}</strong>
            </span>
            <span>
              Veces encontrado: <strong className="text-theme-text">{detail.occurrences.length}</strong>
            </span>
          </div>
          {frozen && (
            <p className="mt-2 rounded-lg border border-theme-border bg-theme-text/5 px-3 py-2 text-[11px] text-theme-text-muted">
              Este inventario está cerrado (solo lectura). No se pueden autorizar, rechazar ni corregir incidencias; la
              evidencia y el historial permanecen consultables.
            </p>
          )}
        </section>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {barcodeUnits.length === 0 && (
        <section className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-theme-border bg-theme-surface/60 px-6 text-center">
          <Barcode className="h-8 w-8 text-theme-text-muted/50" />
          <p className="text-sm font-semibold text-theme-text">No hay códigos pendientes de revisión.</p>
        </section>
      )}

      {barcodeUnits.map(barcode => {
        const isOpen = expanded === barcode.scanned_code
        return (
          <section key={barcode.scanned_code} className="rounded-xl border border-theme-border bg-theme-surface shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <p className="font-mono text-sm font-bold text-theme-text">{barcode.scanned_code}</p>
                <p className="text-xs text-theme-text-muted">
                  Código encontrado · {barcode.occurrence_count}{' '}
                  {barcode.occurrence_count === 1 ? 'occurrence' : 'occurrences'} · {barcode.location_count}{' '}
                  {barcode.location_count === 1 ? 'ubicación' : 'ubicaciones'} · Pendiente
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!canMutate ? (
                  <span className="text-[11px] text-theme-text-muted/60">
                    {frozen ? 'Inventario cerrado: solo lectura' : 'Requiere permisos de administrador'}
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setDecision({ mode: 'approve', scannedCode: barcode.scanned_code })}
                      className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-600 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Autorizar código
                    </button>
                    <button
                      type="button"
                      onClick={() => setDecision({ mode: 'reject', scannedCode: barcode.scanned_code })}
                      className="inline-flex h-7 items-center rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/20 dark:text-red-400"
                    >
                      Rechazar código
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : barcode.scanned_code)}
                  aria-label={isOpen ? 'Contraer' : 'Expandir'}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                >
                  {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {isOpen && (
              <div className="overflow-x-auto border-t border-theme-border/60">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-theme-border/60 text-left text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted/60">
                      <th className="px-3 py-1.5">Bodega / Sección</th>
                      <th className="px-3 py-1.5">Zona</th>
                      <th className="px-3 py-1.5">Ubicación</th>
                      <th className="px-3 py-1.5">Contador</th>
                      <th className="px-3 py-1.5">Código encontrado</th>
                      <th className="px-3 py-1.5 text-right">Cantidad</th>
                      <th className="px-3 py-1.5">Fecha / hora</th>
                      <th className="px-3 py-1.5">Evidencia</th>
                      <th className="px-3 py-1.5 text-right">Conteo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {barcode.occurrences.map(occ => (
                      <tr key={occ.proposal_id} className="border-b border-theme-border/40 transition-colors hover:bg-theme-text/2">
                        <td className="max-w-[200px] whitespace-normal px-3 py-1.5 text-theme-text">{occ.bodega}</td>
                        <td className="px-3 py-1.5 text-theme-text-muted">{occ.zone_code ?? '—'}</td>
                        <td className="max-w-[160px] truncate px-3 py-1.5 text-theme-text-muted" title={occ.location_code ?? undefined}>
                          {occ.location_code ?? '—'}
                        </td>
                        <td className="px-3 py-1.5 text-theme-text-muted">{occ.counted_by_name ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-theme-text">{occ.scanned_code}</td>
                        <td className="px-3 py-1.5 text-right font-semibold text-theme-text">{formatQuantity(occ.physical_quantity)}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-theme-text-muted">{formatDateTimeChile(occ.captured_at)}</td>
                        <td className="px-3 py-1.5">
                          {occ.evidence_id ? (
                            <button
                              type="button"
                              onClick={() => openPhoto(occ)}
                              disabled={photoLoading}
                              className="inline-flex h-6 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-1.5 text-[11px] font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-50"
                            >
                              <Camera className="h-3 w-3" />
                              {photoLoading ? 'Cargando…' : 'Ver foto'}
                            </button>
                          ) : (
                            <span className="text-[11px] text-theme-text-muted/50">Sin evidencia</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {canMutate ? (
                            <button
                              type="button"
                              onClick={() => setCorrection(occ)}
                              className="inline-flex h-6 items-center gap-1 rounded-md border border-theme-border bg-theme-surface px-1.5 text-[11px] font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                            >
                              <Wrench className="h-3 w-3" />
                              Corregir conteo
                            </button>
                          ) : (
                            <span className="text-[11px] text-theme-text-muted/50">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )
      })}

      {photo && product && (
        <PhotoViewer
          productName={product.product_name ?? 'Producto'}
          sku={product.sku ?? null}
          bsaleBarcode={product.bsale_barcode ?? null}
          scannedCode={photo.occurrence.scanned_code}
          bodega={photo.occurrence.bodega}
          zone={photo.occurrence.zone_code}
          location={photo.occurrence.location_code}
          countedByName={photo.occurrence.counted_by_name}
          capturedAt={photo.occurrence.captured_at}
          physicalQuantity={photo.occurrence.physical_quantity}
          signedUrl={photo.signedUrl}
          onClose={() => setPhoto(null)}
        />
      )}

      {decision && product && (
        <DecisionDialog
          productName={product.product_name ?? 'Producto'}
          sku={product.sku ?? null}
          scannedCode={decision.scannedCode}
          bsaleVariantId={product.bsale_variant_id}
          campaignId={campaignId}
          companyId={companyId}
          mode={decision.mode}
          onDone={handleDecided}
          onClose={() => setDecision(null)}
        />
      )}

      {correction && product && (
        <CountCorrectionDialog
          productName={product.product_name ?? 'Producto'}
          sku={product.sku ?? null}
          bsaleBarcode={product.bsale_barcode ?? null}
          campaignId={campaignId}
          occurrence={correction}
          currentBsaleVariantId={product.bsale_variant_id}
          onDone={handleDecided}
          onClose={() => setCorrection(null)}
        />
      )}
    </div>
  )
}
