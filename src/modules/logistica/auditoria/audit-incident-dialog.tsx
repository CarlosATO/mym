'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, ImagePlus, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type {
  SalesOrderAuditAttachment,
  SalesOrderAuditIncident,
  SalesOrderAuditLine,
} from '@/app/actions/logistica/sales-order-audit'
import {
  AUDIT_MANUAL_INCIDENT_OPTIONS,
  AUDIT_EVIDENCE_ACCEPT,
  AUDIT_INCIDENT_LABELS,
  validateAuditEvidenceFile,
} from './audit-ui-utils'
import {
  incidentRequiresObservation,
  incidentRequiresPhoto,
  type AuditIncidentType,
} from './audit-policy'

interface AuditIncidentDialogProps {
  open: boolean
  mode: 'AUTO' | 'MANUAL'
  line: SalesOrderAuditLine | null
  auditQuantity: number
  automaticType: AuditIncidentType | null
  existingIncident: SalesOrderAuditIncident | null
  existingEvidence: SalesOrderAuditAttachment[]
  onOpenChange: (open: boolean) => void
  onConfirm: (input: {
    incidentType: AuditIncidentType
    observation: string | null
    file: File | null
  }) => Promise<{
    ok: boolean
    error?: string
    incident?: SalesOrderAuditIncident | null
    uploadError?: string | null
  }>
  onRetryUpload: (input: { incidentId: string; file: File }) => Promise<{ ok: boolean; error?: string }>
}

function defaultManualType(existing: SalesOrderAuditIncident | null): AuditIncidentType | null {
  if (existing && (existing.incident_type === 'WRONG_PRODUCT'
      || existing.incident_type === 'DAMAGED_PRODUCT'
      || existing.incident_type === 'PRODUCT_NOT_FOUND'
      || existing.incident_type === 'OTHER')) {
    return existing.incident_type
  }
  return null
}

export function AuditIncidentDialog({
  open,
  mode,
  line,
  auditQuantity,
  automaticType,
  existingIncident,
  existingEvidence,
  onOpenChange,
  onConfirm,
  onRetryUpload,
}: AuditIncidentDialogProps) {
  const [manualType, setManualType] = useState<AuditIncidentType | null>(() => defaultManualType(existingIncident))
  const [observation, setObservation] = useState(existingIncident?.observation ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmedIncidentId, setConfirmedIncidentId] = useState<string | null>(null)

  // Al abrir, precargar el estado desde la incidencia existente. No se resetea
  // si el detalle cambia mientras el modal sigue abierto (por ejemplo, tras
  // confirmar y quedar pendiente la fotografía obligatoria).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) {
      setManualType(defaultManualType(existingIncident))
      setObservation(existingIncident?.observation ?? '')
      setFile(null)
      setPreviewUrl(null)
      setError(null)
      setLoading(false)
      setConfirmedIncidentId(null)
    }
  }, [open])

  useEffect(() => {
    if (!file || !file.type.startsWith('image/') || file.type === 'image/heic') {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const selectedType = mode === 'AUTO' ? automaticType : manualType
  const requiresPhoto = incidentRequiresPhoto(selectedType)
  const requiresObservation = incidentRequiresObservation(selectedType)
  const difference = line ? auditQuantity - line.prepared_quantity_snapshot : 0
  const evidenceForSelectedType = useMemo(() => {
    if (!existingIncident || existingIncident.incident_type !== selectedType) return []
    return existingEvidence
  }, [existingEvidence, existingIncident, selectedType])

  const handleFile = (selected: File | null) => {
    if (!selected) {
      setFile(null)
      return
    }
    const validation = validateAuditEvidenceFile(selected)
    if (!validation.ok) {
      setError(validation.error ?? 'La fotografía no es válida.')
      setFile(null)
      return
    }
    setError(null)
    setFile(selected)
  }

  const handleConfirm = async () => {
    if (!line || !selectedType) {
      setError('Selecciona un tipo de incidencia.')
      return
    }
    if (selectedType === 'PRODUCT_NOT_FOUND' && auditQuantity > 0) {
      setError('Producto no encontrado sólo es válido cuando la cantidad auditada es 0.')
      return
    }
    if (requiresObservation && !observation.trim()) {
      setError('La observación es obligatoria para la incidencia Otro.')
      return
    }
    if (requiresPhoto && !file) {
      setError('Debes adjuntar una fotografía obligatoria.')
      return
    }

    setLoading(true)
    setError(null)
    const startedAt = performance.now()
    try {
      if (confirmedIncidentId) {
        if (!file) {
          setError('Selecciona la fotografía para reintentar la subida.')
          return
        }
        const retry = await onRetryUpload({ incidentId: confirmedIncidentId, file })
        if (!retry.ok) {
          setError(retry.error || 'No se pudo subir la fotografía.')
          return
        }
        onOpenChange(false)
        return
      }

      const result = await onConfirm({
        incidentType: selectedType,
        observation: observation.trim() || null,
        file,
      })
      const confirmMs = performance.now() - startedAt

      if (!result.ok) {
        setError(result.error || 'No se pudo confirmar la incidencia.')
        return
      }

      if (result.incident) {
        if (result.uploadError) {
          setConfirmedIncidentId(result.incident.id)
          setError(result.uploadError)
          return
        }
      }
      const closeStartedAt = performance.now()
      onOpenChange(false)
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[audit-confirm][modal]', {
          confirmMs: Math.round(confirmMs * 10) / 10,
          closeMs: Math.round((performance.now() - closeStartedAt) * 10) / 10,
          totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
          hasFile: Boolean(file),
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de conexión.')
    } finally {
      setLoading(false)
    }
  }

  const title = confirmedIncidentId
    ? 'Fotografía obligatoria pendiente'
    : mode === 'AUTO'
      ? 'Incidencia de Auditoría'
      : 'Reportar incidencia'

  return (
    <Dialog open={open} onOpenChange={next => { if (!loading) onOpenChange(next) }}>
      <DialogContent className="max-w-2xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden bg-theme-base border-theme-border text-theme-text">
        <div className="p-6 pb-4 border-b border-theme-border/50">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <AlertTriangle className="w-5 h-5 text-[#8A4B4B]" />
              {title}
            </DialogTitle>
            <DialogDescription className="text-theme-text/70">
              {mode === 'AUTO'
                ? 'La diferencia cuantitativa se clasifica automáticamente. La NV y lo preparado no se modifican.'
                : 'Registra una condición física encontrada aunque las cantidades coincidan.'}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-5">
          {line && (
            <div className="rounded-lg border border-[#DDD4CA] bg-white p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs font-semibold text-theme-text">{line.sku || '—'}</p>
                  <p className="text-sm font-semibold text-theme-text">{line.product_name}</p>
                </div>
                <span className="rounded-md bg-[#F5EDE9] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#72383D]">
                  {AUDIT_INCIDENT_LABELS[selectedType ?? 'OTHER']}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                <div><p className="text-[10px] font-bold uppercase text-[#6B625C]">Solicitado</p><p className="font-bold tabular-nums">{line.requested_quantity_snapshot}</p></div>
                <div><p className="text-[10px] font-bold uppercase text-[#6B625C]">Preparado</p><p className="font-bold tabular-nums">{line.prepared_quantity_snapshot}</p></div>
                <div><p className="text-[10px] font-bold uppercase text-[#6B625C]">Auditado</p><p className="font-bold tabular-nums">{auditQuantity}</p></div>
                <div><p className="text-[10px] font-bold uppercase text-[#6B625C]">Diferencia</p><p className={`font-bold tabular-nums ${difference < 0 ? 'text-[#8A4B4B]' : difference > 0 ? 'text-[#806238]' : 'text-theme-text'}`}>{difference > 0 ? '+' : ''}{difference}</p></div>
              </div>
            </div>
          )}

          {mode === 'AUTO' && automaticType === 'QUANTITY_GREATER_THAN_PREPARED' && (
            <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Se encontraron más unidades físicas que las declaradas en Preparación. La NV no cambia y no significa que se despacharán más unidades.
            </div>
          )}
          {mode === 'AUTO' && automaticType === 'QUANTITY_LOWER_THAN_PREPARED' && (
            <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Se encontraron menos unidades físicas que las declaradas en Preparación. La diferencia queda registrada como incidencia.
            </div>
          )}

          {mode === 'MANUAL' && (
            <div className="space-y-2">
              <Label>Tipo de incidencia *</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {AUDIT_MANUAL_INCIDENT_OPTIONS.map(option => {
                  const disabled = option.value === 'PRODUCT_NOT_FOUND' && auditQuantity > 0
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled || loading}
                      onClick={() => setManualType(option.value)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm font-semibold transition-colors ${
                        manualType === option.value
                          ? 'border-[#72383D] bg-[#F5EDE9] text-[#72383D]'
                          : 'border-[#DDD4CA] bg-white text-theme-text hover:bg-[#F8F5F1]'
                      } disabled:cursor-not-allowed disabled:opacity-45`}
                    >
                      {option.label}
                      {disabled && <span className="mt-0.5 block text-[10px] font-normal">Requiere cantidad auditada 0</span>}
                    </button>
                  )
                })}
              </div>
              {selectedType === 'PRODUCT_NOT_FOUND' && auditQuantity > 0 && (
                <p className="text-xs text-[#8A4B4B]">Producto no encontrado sólo es válido cuando la cantidad auditada es 0.</p>
              )}
              {selectedType === 'WRONG_PRODUCT' && (
                <p className="text-xs text-theme-text-muted">El producto físico encontrado no corresponde al producto auditado. No se modifica el SKU de la línea.</p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="audit-incident-observation">
              Observación {requiresObservation ? '*' : '(opcional)'}
            </Label>
            <Textarea
              id="audit-incident-observation"
              value={observation}
              onChange={event => setObservation(event.target.value)}
              placeholder={requiresObservation ? 'Describe la condición encontrada...' : 'Observación opcional...'}
              className="resize-none h-20"
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="audit-incident-photo">
                Fotografía {requiresPhoto ? '(obligatoria)' : '(opcional)'}
              </Label>
              {requiresPhoto && !file && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-[#8A4B4B]">Falta evidencia</span>
              )}
            </div>
            <label
              htmlFor="audit-incident-photo"
              className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[#B8ABA0] bg-white px-4 py-3 text-sm font-semibold text-theme-text hover:bg-[#F8F5F1]"
            >
              <ImagePlus className="h-4 w-4 text-[#72383D]" />
              {file ? file.name : 'Agregar fotografía'}
              <input
                id="audit-incident-photo"
                type="file"
                accept={AUDIT_EVIDENCE_ACCEPT}
                className="sr-only"
                disabled={loading}
                onChange={event => {
                  const selected = event.target.files?.[0] ?? null
                  event.currentTarget.value = ''
                  handleFile(selected)
                }}
              />
            </label>
            {previewUrl && (
              <img src={previewUrl} alt={`Vista previa de ${file?.name ?? 'fotografía'}`} className="h-32 w-32 rounded-lg border border-[#DDD4CA] object-cover" />
            )}
            {file && !previewUrl && <p className="text-xs text-theme-text-muted">Archivo seleccionado: {file.name}</p>}
            {evidenceForSelectedType.length > 0 && (
              <div className="space-y-1">
                {evidenceForSelectedType.map(evidence => (
                  <p key={evidence.id} className="flex items-center gap-1.5 text-xs text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> {evidence.file_name}
                  </p>
                ))}
                {requiresPhoto && (
                  <p className="text-[10px] text-amber-800">La nueva confirmación creará una incidencia nueva y requiere una fotografía nueva.</p>
                )}
              </div>
            )}
          </div>

          {confirmedIncidentId && (
            <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              La incidencia ya fue registrada, pero falta subir la fotografía obligatoria. El cierre seguirá bloqueado hasta completarla.
            </div>
          )}

          {error && <p className="rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-3 py-2 text-xs text-[#8A4B4B]">{error}</p>}
        </div>

        <div className="p-4 border-t border-theme-border/50 flex justify-end gap-3 bg-theme-panel">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancelar
          </Button>
          <Button onClick={handleConfirm} disabled={loading || !selectedType}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : confirmedIncidentId ? <Camera className="h-4 w-4" /> : null}
            {loading ? 'Guardando…' : confirmedIncidentId ? 'Reintentar fotografía' : 'Confirmar incidencia'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
