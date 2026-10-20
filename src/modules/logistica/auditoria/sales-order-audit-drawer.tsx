'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  FileImage,
  FileText,
  ImagePlus,
  Loader2,
  LockKeyhole,
  MapPin,
  Package,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import {
  confirmSalesOrderAuditLine,
  finalizeSalesOrderAudit,
  getSalesOrderAuditAttachmentSignedUrl,
  getSalesOrderAuditDetail,
  getSalesOrderAuditFinalizationStatus,
  setSalesOrderAuditPackageCount,
  takeSalesOrderAudit,
  uploadSalesOrderAuditEvidence,
  type SalesOrderAudit,
  type SalesOrderAuditAttachment,
  type SalesOrderAuditConfirmResult,
  type SalesOrderAuditDetail,
  type SalesOrderAuditFinalization,
  type SalesOrderAuditFinalizeResult,
  type SalesOrderAuditIncident,
  type SalesOrderAuditLine,
} from '@/app/actions/logistica/sales-order-audit'
import { getAuditCache, setAuditCache } from './audit-cache'
import {
  AUDIT_EVIDENCE_ACCEPT,
  AUDIT_INCIDENT_LABELS,
  getAuditLineResultLabel,
  getAuditLineResultTone,
  formatAuditedTotal,
  formatPreparedTotal,
  formatSnapshotLines,
  getAuditOpenIncident,
  isAuditGlobalPhoto,
  summarizeAuditDetail,
  validateAuditEvidenceFile,
} from './audit-ui-utils'
import {
  incidentRequiresPhoto,
  isAuditLockError,
  type AuditIncidentType,
} from './audit-policy'
import { AuditIncidentDialog } from './audit-incident-dialog'
import { AuditTakeoverDialog } from './audit-takeover-dialog'
import { AuditCloseReviewDialog } from './audit-close-review-dialog'
import { AuditEvidencePreviewDialog, type AuditEvidencePreview } from './audit-evidence-preview-dialog'

interface SalesOrderAuditDrawerProps {
  card: SalesOrderPreparationCardInfo
  currentUserId: string
  currentUserName: string
  canManage: boolean
  canAuthorizeException: boolean
  onClose: () => void
  onAuditLockChange: () => void
  onOwnershipConflict: () => void
  onFinalized?: (result: SalesOrderAuditFinalizeResult) => void
}

type IncidentDialogState = {
  mode: 'AUTO' | 'MANUAL'
  line: SalesOrderAuditLine
  auditQuantity: number
  automaticType: AuditIncidentType | null
  existingIncident: SalesOrderAuditIncident | null
}

function formatAuditDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value.length <= 10 ? `${value}T12:00:00` : value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' })
}

function resultToneClasses(tone: 'pending' | 'ok' | 'incident'): string {
  if (tone === 'ok') return 'border-emerald-300/70 bg-emerald-50 text-emerald-800'
  if (tone === 'incident') return 'border-red-300/70 bg-red-50 text-red-800'
  return 'border-[#D8CFC5] bg-[#F8F5F1] text-[#6B625C]'
}

function HeaderStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-bold uppercase tracking-wider text-[#6B625C]">{label}</p>
      <p className={`truncate text-xs font-bold tabular-nums ${accent ? 'text-[#72383D]' : 'text-theme-text'}`} title={value}>{value}</p>
    </div>
  )
}

function SideStat({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-bold uppercase tracking-wider text-[#6B625C]">{label}</p>
      <p className={`text-xs font-bold tabular-nums ${accent ? 'text-[#72383D]' : 'text-theme-text'}`}>{value}</p>
    </div>
  )
}

export function SalesOrderAuditDrawer({
  card,
  currentUserId,
  currentUserName,
  canManage,
  canAuthorizeException,
  onClose,
  onAuditLockChange,
  onOwnershipConflict,
  onFinalized,
}: SalesOrderAuditDrawerProps) {
  const [detail, setDetail] = useState<SalesOrderAuditDetail | null>(() => getAuditCache(card.card_id))
  const [loading, setLoading] = useState(!detail)
  const [error, setError] = useState<string | null>(null)
  const [lineDrafts, setLineDrafts] = useState<Record<string, string>>({})
  const [savingLineId, setSavingLineId] = useState<string | null>(null)
  const [lineError, setLineError] = useState<string | null>(null)
  const [incidentDialog, setIncidentDialog] = useState<IncidentDialogState | null>(null)
  const [takeoverOpen, setTakeoverOpen] = useState(false)
  const [taking, setTaking] = useState(false)
  const [takeError, setTakeError] = useState<string | null>(null)
  const [packageDraft, setPackageDraft] = useState('')
  const [savingPackage, setSavingPackage] = useState(false)
  const [packageError, setPackageError] = useState<string | null>(null)
  const [globalUploading, setGlobalUploading] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [lineUploadingId, setLineUploadingId] = useState<string | null>(null)
  const [precloseOpen, setPrecloseOpen] = useState(false)
  const [precloseLoading, setPrecloseLoading] = useState(false)
  const [preclose, setPreclose] = useState<SalesOrderAuditFinalization | null>(null)
  const [precloseError, setPrecloseError] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [finalizeError, setFinalizeError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewEvidence, setPreviewEvidence] = useState<AuditEvidencePreview | null>(null)

  const requestSeqRef = useRef(0)
  const previewRequestSeqRef = useRef(0)
  const mountedRef = useRef(true)
  const finalizingRef = useRef(false)

  const audit = detail?.audit ?? null
  const lines = detail?.lines ?? []
  const incidents = detail?.incidents ?? []
  const attachments = detail?.attachments ?? []
  const summary = useMemo(() => summarizeAuditDetail(detail), [detail])
  const preparerId = audit?.prepared_by_user_id_snapshot ?? card.assigned_user_id ?? null
  const isPreparer = Boolean(preparerId && preparerId === currentUserId)
  const isOwner = Boolean(audit?.locked_by_user_id && audit.locked_by_user_id === currentUserId)
  const isLockedByOther = Boolean(audit?.locked_by_user_id && !isOwner)
  const isFinalized = card.status === 'AUDITED' || audit?.status === 'COMPLETED'
  const canWrite = canManage && isOwner && !isPreparer && !isFinalized
  const canTake = !isFinalized && canManage && !isPreparer && !isOwner && Boolean(
    !audit || !audit.locked_by_user_id || (isLockedByOther && canAuthorizeException)
  )
  const packageCount = audit?.package_count ?? null
  const globalPhoto = attachments.find(isAuditGlobalPhoto) ?? null
  const preparerName = audit?.preparer_name || card.assigned_user_name || '—'
  const auditorName = audit?.auditor_name || audit?.locked_by_name || 'Sin auditor'
  const comuna = card.normalized_city || card.municipality_raw || card.city_raw || '—'

  const patchDetail = useCallback((updater: (current: SalesOrderAuditDetail) => SalesOrderAuditDetail) => {
    setDetail(current => {
      if (!current) return current
      const next = updater(current)
      setAuditCache(card.card_id, next)
      return next
    })
  }, [card.card_id])

  const loadDetail = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setError(null)
    const cached = getAuditCache(card.card_id)
    if (cached) {
      setDetail(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[audit-detail-load][start]', {
        cardId: card.card_id,
        cardStatus: card.status,
        cacheHit: Boolean(cached),
      })
    }

    try {
      const result = await getSalesOrderAuditDetail(card.card_id, card.company_id)
      if (!mountedRef.current || seq !== requestSeqRef.current) return

      if (result.data) {
        setDetail(result.data)
        setAuditCache(card.card_id, result.data)
        setError(null)
      } else if (result.error) {
        setError(result.error)
      } else {
        setError('No se pudo cargar la Auditoría.')
      }
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[audit-detail-load][done]', {
          cardId: card.card_id,
          auditStatus: result.data?.audit?.status ?? null,
          hasAudit: Boolean(result.data?.audit),
          error: result.error,
        })
      }
    } catch (err: unknown) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return
      const message = err instanceof Error ? err.message : 'No se pudo cargar la Auditoría.'
      setError(message)
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[audit-detail-load][failed]', { cardId: card.card_id, error: message })
      }
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setLoading(false)
      }
    }
  }, [card.card_id])

  useEffect(() => {
    mountedRef.current = true
    void loadDetail()
    return () => {
      mountedRef.current = false
      requestSeqRef.current += 1
    }
  }, [loadDetail])

  useEffect(() => {
    setPackageDraft(audit?.package_count == null ? '' : String(audit.package_count))
  }, [audit?.package_count])

  const applyLineConfirmation = useCallback((line: SalesOrderAuditLine, incident: SalesOrderAuditIncident | null) => {
    setLineDrafts(current => {
      const next = { ...current }
      delete next[line.id]
      return next
    })
    patchDetail(current => {
      const nextIncidents = current.incidents.map(item => (
        item.audit_line_id === line.id && item.status === 'OPEN'
          ? { ...item, status: 'SUPERSEDED' as const }
          : item
      ))
      if (incident) nextIncidents.push(incident)
      return {
        ...current,
        lines: current.lines.map(item => item.id === line.id ? line : item),
        incidents: nextIncidents,
      }
    })
  }, [patchDetail])

  const handleTake = async (reason?: string | null): Promise<{ ok: boolean; error?: string }> => {
    if (!canManage) return { ok: false, error: 'No tienes permiso para gestionar Auditoría.' }
    if (isPreparer) return { ok: false, error: 'No puedes auditar una preparación realizada por ti.' }
    setTaking(true)
    setTakeError(null)
    try {
      const result = await takeSalesOrderAudit({ cardId: card.card_id, reason })
      if (result.error || !result.data) {
        const message = result.error || 'No se pudo tomar la auditoría.'
        setTakeError(message)
        if (isAuditLockError(message)) {
          await loadDetail()
          onOwnershipConflict()
        }
        return { ok: false, error: message }
      }
      toast.success(result.data.event === 'AUDIT_LOCK_TAKEOVER' ? 'Auditoría tomada' : 'Auditoría asignada a ti')
      await loadDetail()
      onAuditLockChange()
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'No se pudo tomar la auditoría.'
      setTakeError(message)
      return { ok: false, error: message }
    } finally {
      setTaking(false)
    }
  }

  const handleTakeoverConfirm = async (reason: string) => handleTake(reason)

  const handleConfirmLine = async (line: SalesOrderAuditLine) => {
    if (!canWrite) {
      setLineError('Esta auditoría está asignada a otro usuario o no tienes permiso de escritura.')
      return
    }
    const raw = lineDrafts[line.id] ?? (line.audit_quantity == null ? '' : String(line.audit_quantity))
    if (raw.trim() === '') {
      setLineError('Ingresa la cantidad auditada.')
      return
    }
    const quantity = Number(raw)
    if (!Number.isFinite(quantity) || quantity < 0) {
      setLineError('La cantidad auditada debe ser mayor o igual a 0.')
      return
    }
    setLineError(null)
    setSavingLineId(line.id)
    const startedAt = performance.now()
    try {
      const difference = quantity - Number(line.prepared_quantity_snapshot)
      if (difference !== 0) {
        const automaticType: AuditIncidentType = difference < 0
          ? 'QUANTITY_LOWER_THAN_PREPARED'
          : 'QUANTITY_GREATER_THAN_PREPARED'
        setIncidentDialog({
          mode: 'AUTO',
          line,
          auditQuantity: quantity,
          automaticType,
          existingIncident: getAuditOpenIncident(incidents, line.id),
        })
        return
      }

      const actionStartedAt = performance.now()
      const result = await confirmSalesOrderAuditLine({
        auditLineId: line.id,
        auditQuantity: quantity,
        incidentType: null,
        observation: null,
        companyId: card.company_id,
      })
      const actionMs = performance.now() - actionStartedAt
      if (result.error || !result.data) {
        const message = result.error || 'No se pudo confirmar la línea.'
        setLineError(message)
        if (isAuditLockError(message)) {
          await loadDetail()
          onOwnershipConflict()
        }
        return
      }
      const patchStartedAt = performance.now()
      applyLineConfirmation(result.data.line, result.data.incident)
      const patchMs = performance.now() - patchStartedAt
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[audit-confirm][client-line]', {
          actionMs: Math.round(actionMs * 10) / 10,
          patchMs: Math.round(patchMs * 10) / 10,
          totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
        })
      }
    } finally {
      setSavingLineId(null)
    }
  }

  const handleReportIncident = (line: SalesOrderAuditLine) => {
    if (!canWrite) {
      setLineError('Esta auditoría está asignada a otro usuario o no tienes permiso de escritura.')
      return
    }
    const raw = lineDrafts[line.id] ?? (line.audit_quantity == null ? '' : String(line.audit_quantity))
    if (raw.trim() === '') {
      setLineError('Primero registra la cantidad auditada.')
      return
    }
    const quantity = Number(raw)
    if (!Number.isFinite(quantity) || quantity < 0) {
      setLineError('La cantidad auditada debe ser mayor o igual a 0.')
      return
    }
    setLineError(null)
    setIncidentDialog({
      mode: 'MANUAL',
      line,
      auditQuantity: quantity,
      automaticType: null,
      existingIncident: getAuditOpenIncident(incidents, line.id),
    })
  }

  const handleIncidentConfirm = async (input: {
    incidentType: AuditIncidentType
    observation: string | null
    file: File | null
  }): Promise<{
    ok: boolean
    error?: string
    incident?: SalesOrderAuditIncident | null
    uploadError?: string | null
  }> => {
    const dialog = incidentDialog
    if (!dialog) return { ok: false, error: 'No hay línea seleccionada.' }
    setSavingLineId(dialog.line.id)
    setLineError(null)
    const startedAt = performance.now()
    try {
      const actionStartedAt = performance.now()
      const result: { data: SalesOrderAuditConfirmResult | null; error: string | null } = await confirmSalesOrderAuditLine({
        auditLineId: dialog.line.id,
        auditQuantity: dialog.auditQuantity,
        incidentType: input.incidentType,
        observation: input.observation,
        companyId: card.company_id,
      })
      const actionMs = performance.now() - actionStartedAt
      if (result.error || !result.data) {
        const message = result.error || 'No se pudo confirmar la incidencia.'
        setLineError(message)
        if (isAuditLockError(message)) {
          await loadDetail()
          onOwnershipConflict()
        }
        return { ok: false, error: message }
      }

      const patchStartedAt = performance.now()
      applyLineConfirmation(result.data.line, result.data.incident)
      const patchMs = performance.now() - patchStartedAt

      let uploadError: string | null = null
      if (input.file && result.data.incident && audit) {
        const upload = await uploadSalesOrderAuditEvidence({
          auditId: audit.id,
          cardId: card.card_id,
          attachmentType: 'INCIDENT_EVIDENCE',
          file: input.file,
          incidentId: result.data.incident.id,
          auditLineId: result.data.incident.audit_line_id,
          companyId: card.company_id,
        })
        if (upload.error || !upload.data) {
          uploadError = upload.error || 'No se pudo subir la fotografía.'
        } else {
          const attachment = upload.data
          patchDetail(current => ({ ...current, attachments: [...current.attachments, attachment] }))
        }
      }

      if (process.env.NODE_ENV !== 'production') {
        console.debug('[audit-confirm][client-incident]', {
          actionMs: Math.round(actionMs * 10) / 10,
          patchMs: Math.round(patchMs * 10) / 10,
          totalMs: Math.round((performance.now() - startedAt) * 10) / 10,
          hasFile: Boolean(input.file),
        })
      }
      return { ok: true, incident: result.data.incident, uploadError }
    } finally {
      setSavingLineId(null)
    }
  }

  const handleRetryIncidentUpload = async (input: { incidentId: string; file: File }): Promise<{ ok: boolean; error?: string }> => {
    if (!audit || !incidentDialog) return { ok: false, error: 'No hay auditoría activa.' }
    const upload = await uploadSalesOrderAuditEvidence({
      auditId: audit.id,
      cardId: card.card_id,
      attachmentType: 'INCIDENT_EVIDENCE',
      file: input.file,
      incidentId: input.incidentId,
      auditLineId: incidentDialog.line.id,
      companyId: card.company_id,
    })
    if (upload.error || !upload.data) {
      return { ok: false, error: upload.error || 'No se pudo subir la fotografía.' }
    }
    const attachment = upload.data
    patchDetail(current => ({ ...current, attachments: [...current.attachments, attachment] }))
    toast.success('Fotografía registrada')
    return { ok: true }
  }

  const handleLineEvidence = async (line: SalesOrderAuditLine, incident: SalesOrderAuditIncident, file: File | null) => {
    if (!file || !audit || !canWrite) return
    const validation = validateAuditEvidenceFile(file)
    if (!validation.ok) {
      setLineError(validation.error ?? 'La fotografía no es válida.')
      return
    }
    setLineUploadingId(line.id)
    setLineError(null)
    try {
      const upload = await uploadSalesOrderAuditEvidence({
        auditId: audit.id,
        cardId: card.card_id,
        attachmentType: 'INCIDENT_EVIDENCE',
        file,
        incidentId: incident.id,
        auditLineId: line.id,
        companyId: card.company_id,
      })
      if (upload.error || !upload.data) {
        const message = upload.error || 'No se pudo subir la fotografía.'
        setLineError(message)
        if (isAuditLockError(message)) {
          await loadDetail()
          onOwnershipConflict()
        }
        return
      }
      const attachment = upload.data
      patchDetail(current => ({ ...current, attachments: [...current.attachments, attachment] }))
      toast.success('Fotografía registrada')
    } finally {
      setLineUploadingId(null)
    }
  }

  const handleSavePackage = async () => {
    if (!audit || !canWrite) {
      setPackageError('No tienes permiso de escritura sobre esta auditoría.')
      return
    }
    const raw = packageDraft.trim()
    if (raw === '') {
      setPackageError('Ingresa la cantidad final de bultos.')
      return
    }
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0) {
      setPackageError('La cantidad de bultos no puede ser negativa.')
      return
    }
    setSavingPackage(true)
    setPackageError(null)
    try {
      const result = await setSalesOrderAuditPackageCount({ auditId: audit.id, packageCount: value })
      if (result.error || !result.data) {
        const message = result.error || 'No se pudo guardar la cantidad de bultos.'
        setPackageError(message)
        if (isAuditLockError(message)) {
          await loadDetail()
          onOwnershipConflict()
        }
        return
      }
      patchDetail(current => ({
        ...current,
        audit: current.audit ? { ...current.audit, package_count: value } : current.audit,
      }))
      toast.success('Cantidad de bultos guardada')
    } finally {
      setSavingPackage(false)
    }
  }

  const handleGlobalPhoto = async (file: File | null) => {
    if (!file || !audit || !canWrite || globalPhoto) return
    const validation = validateAuditEvidenceFile(file)
    if (!validation.ok) {
      setGlobalError(validation.error ?? 'La fotografía no es válida.')
      return
    }
    setGlobalUploading(true)
    setGlobalError(null)
    try {
      const upload = await uploadSalesOrderAuditEvidence({
        auditId: audit.id,
        cardId: card.card_id,
        attachmentType: 'GLOBAL_DISPATCH_PHOTO',
        file,
        companyId: card.company_id,
      })
      if (upload.error || !upload.data) {
        const message = upload.error || 'No se pudo subir la fotografía general.'
        setGlobalError(message)
        if (isAuditLockError(message)) {
          await loadDetail()
          onOwnershipConflict()
        }
        return
      }
      const attachment = upload.data
      patchDetail(current => ({ ...current, attachments: [...current.attachments, attachment] }))
      toast.success('Foto general registrada')
    } finally {
      setGlobalUploading(false)
    }
  }

  const handleOpenEvidence = async (attachment: SalesOrderAuditAttachment) => {
    const seq = ++previewRequestSeqRef.current
    const isHeic = attachment.mime_type === 'image/heic' || /\.heic$/i.test(attachment.file_name)
    setPreviewEvidence({
      signedUrl: null,
      fileName: attachment.file_name,
      mimeType: attachment.mime_type,
      uploadedAt: attachment.uploaded_at,
    })
    setPreviewOpen(true)
    setPreviewError(null)

    if (isHeic) {
      setPreviewLoading(false)
      return
    }

    setPreviewLoading(true)
    try {
      const result = await getSalesOrderAuditAttachmentSignedUrl(attachment.id)
      if (seq !== previewRequestSeqRef.current) return
      if (result.error || !result.data) {
        setPreviewError(result.error || 'No se pudo preparar la vista previa.')
        return
      }
      setPreviewEvidence(result.data)
    } finally {
      if (seq === previewRequestSeqRef.current) setPreviewLoading(false)
    }
  }

  const handleReviewClose = async () => {
    if (!audit) return
    setPrecloseOpen(true)
    setPrecloseLoading(true)
    setPrecloseError(null)
    setPreclose(null)
    setFinalizeError(null)
    try {
      const result = await getSalesOrderAuditFinalizationStatus(audit.id)
      if (result.error || !result.data) {
        setPrecloseError(result.error || 'No se pudo revisar el cierre.')
        return
      }
      setPreclose(result.data)
    } finally {
      setPrecloseLoading(false)
    }
  }

  const handleFinalize = async (): Promise<{ ok: boolean; error?: string }> => {
    if (!audit || !preclose?.can_finalize || finalizingRef.current) {
      return { ok: false, error: 'La Auditoría aún no cumple los requisitos de cierre.' }
    }
    finalizingRef.current = true
    setFinalizing(true)
    setFinalizeError(null)
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[audit-finalize][request]', {
        auditId: audit.id,
        cardId: card.card_id,
        companyId: card.company_id,
      })
    }
    try {
      const result = await finalizeSalesOrderAudit({
        auditId: audit.id,
        cardId: card.card_id,
        companyId: card.company_id,
      })
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[audit-finalize][response]', {
          ok: Boolean(result.data) && !result.error,
          error: result.error,
          auditStatus: result.data?.audit_status ?? null,
          cardStatus: result.data?.card_status ?? null,
        })
      }
      if (result.error || !result.data) {
        const message = result.error || 'No se pudo finalizar la Auditoría.'
        setFinalizeError(message)
        if (isAuditLockError(message)) {
          await loadDetail()
          onOwnershipConflict()
        }
        return { ok: false, error: message }
      }

      const finalized = result.data
      patchDetail(current => ({
        ...current,
        audit: current.audit
          ? {
              ...current.audit,
              status: 'COMPLETED',
              completed_at: finalized.completed_at,
              locked_by_user_id: null,
              locked_at: null,
              assigned_auditor_user_id: finalized.assigned_auditor_user_id,
              package_count: finalized.package_count,
              auditor_name: finalized.auditor_name ?? current.audit.auditor_name,
            }
          : current.audit,
      }))
      setPrecloseOpen(false)
      setPreclose(null)
      toast.success('Auditoría finalizada')
      onAuditLockChange()
      onFinalized?.(finalized)
      void loadDetail()
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'No se pudo finalizar la Auditoría.'
      setFinalizeError(message)
      return { ok: false, error: message }
    } finally {
      finalizingRef.current = false
      setFinalizing(false)
    }
  }

  const hasSnapshot = Boolean(audit && lines.length > 0)
  const requestedTotal = hasSnapshot ? summary.requested : card.total_quantity
  const preparedTotal = formatPreparedTotal(hasSnapshot, summary.prepared)
  const hasAnyAudited = lines.some(line => line.audit_quantity != null)
  const auditedTotal = formatAuditedTotal(hasSnapshot, hasAnyAudited, summary.audited)
  const auditedLinesDisplay = formatSnapshotLines(hasSnapshot, summary.auditedLines, summary.totalLines)

  return (
    <>
      <div className="fixed inset-0 z-50 bg-[#322D29]/35 backdrop-blur-sm transition-opacity" onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-drawer-title"
        className="fixed inset-y-0 right-0 z-50 flex w-[96vw] max-w-[1550px] flex-col border-l border-[#D1C7BD] bg-[#EFE9E1] shadow-2xl lg:w-[86vw] xl:w-[80vw]"
      >
        <header className="flex-none border-b border-[#D1C7BD] bg-white">
          <div className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="audit-drawer-title" className="text-base font-bold tracking-tight text-theme-text sm:text-lg">
                  AUDITORÍA · NV #{card.nv_folio}
                </h2>
                <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  isFinalized
                    ? 'border-emerald-300/70 bg-emerald-50 text-emerald-800'
                    : 'border-[#72383D]/30 bg-[#F5EDE9] text-[#72383D]'
                }`}>
                  {isFinalized ? 'Auditada' : 'En auditoría'}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-theme-text-muted">
                <span className="max-w-[360px] truncate font-semibold text-theme-text" title={card.client_name}>{card.client_name}</span>
                <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {comuna}</span>
                <span>{formatAuditDate(card.route_date || card.nv_emission_date)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-theme-text-muted transition-colors hover:bg-theme-border/50 hover:text-theme-text"
              aria-label="Cerrar auditoría"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-[#E8DFD5] bg-[#FCFBF9] px-4 py-2 sm:grid-cols-3 sm:px-5 xl:grid-cols-6">
            <HeaderStat label="Preparó" value={preparerName} />
            <HeaderStat label="Audita" value={auditorName} />
            <HeaderStat label="Bultos" value={packageCount == null ? '—' : String(packageCount)} />
            <HeaderStat label="Solicitado" value={String(requestedTotal)} accent />
            <HeaderStat label="Preparado" value={preparedTotal} accent />
            <HeaderStat label="Auditado" value={auditedTotal} accent />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 lg:p-5">
          {loading && !detail && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-theme-text-muted">
              <Loader2 className="h-7 w-7 animate-spin text-[#72383D]" />
              <p className="text-sm font-medium">Cargando auditoría…</p>
            </div>
          )}

          {error && (
            <div className="mb-3 rounded-lg border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-4 py-3 text-xs text-[#8A4B4B]">
              {error}
            </div>
          )}

          {(!loading || detail) ? (
            <>
              <div className="space-y-2">
                {isFinalized && (
                  <div className="rounded-lg border border-emerald-300/70 bg-emerald-50 px-4 py-3 text-emerald-900">
                    <p className="flex items-center gap-2 text-sm font-bold"><CheckCircle2 className="h-4 w-4" /> AUDITORÍA FINALIZADA</p>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                      <div>
                        <p className="text-[9px] font-bold uppercase tracking-wider text-emerald-700/80">Auditor</p>
                        <p className="font-semibold">{auditorName}</p>
                      </div>
                      <div>
                        <p className="text-[9px] font-bold uppercase tracking-wider text-emerald-700/80">Bultos</p>
                        <p className="font-semibold tabular-nums">{packageCount == null ? '—' : packageCount}</p>
                      </div>
                      <div>
                        <p className="text-[9px] font-bold uppercase tracking-wider text-emerald-700/80">Finalizada</p>
                        <p className="font-semibold">{formatAuditDate(audit?.completed_at ?? null)}</p>
                      </div>
                      <div>
                        <p className="text-[9px] font-bold uppercase tracking-wider text-emerald-700/80">Foto general</p>
                        <p className="font-semibold">{globalPhoto ? 'Sí' : 'No'}</p>
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] text-emerald-800/80">La preparación fue auditada físicamente. Esta tarjeta es de sólo lectura.</p>
                  </div>
                )}

                {!isFinalized && (
                  <>
                {isPreparer && (
                  <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
                    <p className="flex items-center gap-2 font-bold"><LockKeyhole className="h-4 w-4" /> No puedes auditar una preparación realizada por ti.</p>
                    <p className="mt-0.5 text-xs">Puedes consultar la Auditoría en modo sólo lectura.</p>
                  </div>
                )}

                {!isPreparer && !canManage && (
                  <div className="rounded-lg border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-3.5 py-2.5 text-sm text-[#8A4B4B]">
                    No tienes permiso para gestionar Auditoría.
                  </div>
                )}

                {!isPreparer && canManage && isLockedByOther && (
                  <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-bold">Esta Nota de Venta está siendo auditada por {audit?.locked_by_name || audit?.auditor_name || 'otro usuario'}.</p>
                        <p className="mt-0.5 text-xs">Modo sólo lectura. Puedes consultar, pero no registrar cantidades, incidencias, fotos ni bultos.</p>
                      </div>
                      {canTake && (
                        <button type="button" onClick={() => setTakeoverOpen(true)} disabled={taking} className="rounded-md bg-[#72383D] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#612F34] disabled:opacity-50">
                          {taking ? 'Tomando…' : 'TOMAR AUDITORÍA'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {!isPreparer && canManage && !audit && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#DDD4CA] bg-white px-3.5 py-2.5 text-sm text-theme-text">
                    <div>
                      <p className="font-bold">Esta Nota de Venta aún no tiene auditoría iniciada.</p>
                      <p className="mt-0.5 text-xs text-theme-text-muted">Al tomarla se crea la fotografía de Solicitado / Preparado / Auditado.</p>
                    </div>
                    {canTake && (
                      <button type="button" onClick={() => void handleTake()} disabled={taking} className="rounded-md bg-[#72383D] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#612F34] disabled:opacity-50">
                        {taking ? 'Tomando…' : 'TOMAR AUDITORÍA'}
                      </button>
                    )}
                  </div>
                )}

                {!isPreparer && canManage && audit && !audit.locked_by_user_id && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
                    <p className="font-bold">Esta auditoría aún no tiene responsable.</p>
                    {canTake && (
                      <button type="button" onClick={() => void handleTake()} disabled={taking} className="rounded-md bg-[#72383D] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#612F34] disabled:opacity-50">
                        {taking ? 'Tomando…' : 'TOMAR AUDITORÍA'}
                      </button>
                    )}
                  </div>
                )}

                {isOwner && !isPreparer && (
                  <div className="rounded-lg border border-emerald-300/70 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-900">
                    <p className="flex items-center gap-2 font-bold"><ShieldCheck className="h-4 w-4" /> Tu auditoría</p>
                    <p className="mt-0.5 text-xs">Tienes el control exclusivo de esta Auditoría. Los cambios se registran contra tu usuario.</p>
                  </div>
                )}

                {takeError && <p className="rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-3 py-2 text-xs text-[#8A4B4B]">{takeError}</p>}
                  </>
                )}
              </div>

              <div className="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_360px]">
                <section className="min-w-0 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-theme-text">
                      <Package className="h-4 w-4 text-[#72383D]" /> Productos
                      <span className="font-extrabold text-[#72383D]">({hasSnapshot ? summary.totalLines : '—'})</span>
                    </h3>
                    <button type="button" onClick={() => void loadDetail()} disabled={loading} className="flex items-center gap-1 rounded-md border border-[#D1C7BD] bg-white px-2.5 py-1.5 text-[11px] font-semibold text-theme-text hover:bg-[#F8F5F1] disabled:opacity-50">
                      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Actualizar
                    </button>
                  </div>

                  {lines.length === 0 ? (
                    <div className="rounded-lg border border-[#DDD4CA] bg-white px-4 py-10 text-center text-xs text-theme-text-muted">
                      {audit ? 'La auditoría no tiene líneas registradas.' : 'Toma la auditoría para materializar el snapshot de líneas.'}
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-lg border border-[#DDD4CA] bg-white shadow-xs">
                      <table className="w-full min-w-[900px] border-collapse text-left">
                        <thead>
                          <tr className="border-b border-[#DDD4CA] bg-[#F8F5F1] text-[9px] font-bold uppercase tracking-wider text-[#6B625C]">
                            <th className="w-[110px] px-3 py-2">SKU</th>
                            <th className="px-3 py-2">Producto</th>
                            <th className="w-[72px] px-2 py-2 text-center">Solicitado</th>
                            <th className="w-[72px] px-2 py-2 text-center">Preparado</th>
                            <th className="w-[100px] px-2 py-2 text-center">Auditado</th>
                            <th className="w-[170px] px-3 py-2">Resultado</th>
                            {!isFinalized && <th className="w-[150px] px-3 py-2">Acciones</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map(line => {
                            const quantity = lineDrafts[line.id] ?? (line.audit_quantity == null ? '' : String(line.audit_quantity))
                            const openIncident = getAuditOpenIncident(incidents, line.id)
                            const tone = getAuditLineResultTone(line)
                            const resultLabel = getAuditLineResultLabel(line, openIncident)
                            const incidentEvidence = openIncident ? attachments.filter(item => item.incident_id === openIncident.id) : []
                            const missingRequiredEvidence = Boolean(openIncident && incidentRequiresPhoto(openIncident.incident_type) && incidentEvidence.length === 0)
                            const previousIncidents = incidents.filter(item => item.audit_line_id === line.id && item.status === 'SUPERSEDED').length
                            const disabled = !canWrite || savingLineId === line.id
                            return (
                              <Fragment key={line.id}>
                                <tr className="border-b border-[#E8DFD5] align-top hover:bg-[#FCFBF9]">
                                  <td className="px-3 py-2">
                                    <p className="break-all font-mono text-[11px] font-semibold text-theme-text">{line.sku || '—'}</p>
                                  </td>
                                  <td className="px-3 py-2">
                                    <p className="max-w-[420px] truncate text-xs font-semibold text-theme-text" title={line.product_name}>{line.product_name}</p>
                                    {previousIncidents > 0 && <p className="mt-0.5 text-[10px] text-theme-text-muted">{previousIncidents} incidencia{previousIncidents === 1 ? '' : 's'} anterior{previousIncidents === 1 ? '' : 'es'}</p>}
                                  </td>
                                  <td className="px-2 py-2 text-center text-xs font-bold tabular-nums text-theme-text">{line.requested_quantity_snapshot}</td>
                                  <td className="px-2 py-2 text-center text-xs font-bold tabular-nums text-theme-text">{line.prepared_quantity_snapshot}</td>
                                  <td className="px-2 py-2 text-center">
                                    {isFinalized ? (
                                      <span className="text-xs font-bold tabular-nums text-theme-text">{line.audit_quantity == null ? '—' : line.audit_quantity}</span>
                                    ) : (
                                    <input
                                      id={`audit-qty-${line.id}`}
                                      type="number"
                                      min={0}
                                      step="any"
                                      inputMode="decimal"
                                      placeholder="—"
                                      aria-label={`Cantidad auditada de ${line.product_name}`}
                                      value={quantity}
                                      disabled={disabled}
                                      onChange={event => setLineDrafts(current => ({ ...current, [line.id]: event.target.value }))}
                                      onKeyDown={event => { if (event.key === 'Enter') void handleConfirmLine(line) }}
                                      className="w-20 rounded border border-[#D1C7BD] bg-white px-1.5 py-1 text-center text-xs font-bold tabular-nums text-theme-text placeholder:text-theme-text-muted focus:border-[#72383D] focus:outline-none focus:ring-1 focus:ring-[#72383D]/20 disabled:bg-[#F0ECE8] disabled:opacity-60"
                                    />
                                    )}
                                  </td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${resultToneClasses(tone)}`}>
                                      {resultLabel}
                                    </span>
                                    {line.line_status === 'CONFIRMED' && line.requested_quantity_snapshot !== line.prepared_quantity_snapshot && (
                                      <p className="mt-0.5 text-[10px] text-theme-text-muted">Faltante declarado en Preparación</p>
                                    )}
                                    {openIncident && (
                                      <p className="mt-0.5 text-[10px] font-semibold text-[#8A4B4B]">{AUDIT_INCIDENT_LABELS[openIncident.incident_type]}</p>
                                    )}
                                  </td>
                                  {!isFinalized && (
                                  <td className="px-3 py-2">
                                    <div className="flex flex-wrap items-center gap-1">
                                      <button type="button" onClick={() => void handleConfirmLine(line)} disabled={disabled} className="rounded bg-[#72383D] px-2 py-1 text-[10px] font-bold text-white hover:bg-[#612F34] disabled:opacity-40">
                                        {savingLineId === line.id ? 'Guardando…' : 'Confirmar'}
                                      </button>
                                      <button type="button" onClick={() => handleReportIncident(line)} disabled={disabled} className="rounded border border-[#8A4B4B]/30 bg-[#8A4B4B]/5 px-2 py-1 text-[10px] font-semibold text-[#8A4B4B] hover:bg-[#8A4B4B]/10 disabled:opacity-40">
                                        Incidencia
                                      </button>
                                    </div>
                                  </td>
                                  )}
                                </tr>
                                {openIncident && (
                                  <tr className="border-b border-[#E8DFD5] bg-[#FCFBF9]">
                                    <td colSpan={7} className="px-3 py-2">
                                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-theme-text">
                                        <span className="inline-flex items-center gap-1 font-semibold text-[#8A4B4B]">
                                          <AlertTriangle className="h-3.5 w-3.5" /> {AUDIT_INCIDENT_LABELS[openIncident.incident_type]}
                                        </span>
                                        {openIncident.observation && <span className="text-theme-text-muted">Obs.: {openIncident.observation}</span>}
                                        <span className="inline-flex items-center gap-1">
                                          Foto: {incidentEvidence.length > 0
                                            ? `${incidentEvidence.length} evidencia${incidentEvidence.length === 1 ? '' : 's'}`
                                            : missingRequiredEvidence
                                              ? <span className="font-semibold text-[#8A4B4B]">Falta foto obligatoria</span>
                                              : 'Opcional'}
                                        </span>
                                        {!isFinalized && (
                                        <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-[#D1C7BD] bg-white px-2 py-0.5 text-[10px] font-semibold text-theme-text hover:bg-[#F8F5F1]">
                                          <ImagePlus className="h-3.5 w-3.5" />
                                          {lineUploadingId === line.id
                                            ? 'Subiendo…'
                                            : incidentEvidence.length > 0
                                              ? 'Agregar otra foto'
                                              : 'Agregar fotografía'}
                                          <input
                                            type="file"
                                            accept={AUDIT_EVIDENCE_ACCEPT}
                                            className="sr-only"
                                            disabled={!canWrite || lineUploadingId === line.id}
                                            onChange={event => {
                                              const file = event.target.files?.[0] ?? null
                                              event.currentTarget.value = ''
                                              void handleLineEvidence(line, openIncident, file)
                                            }}
                                          />
                                        </label>
                                        )}
                                        {incidentEvidence.map(evidence => (
                                          <button
                                            key={evidence.id}
                                            type="button"
                                            onClick={() => void handleOpenEvidence(evidence)}
                                            className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-100"
                                            title="Ver evidencia"
                                          >
                                            <FileImage className="h-3 w-3" /> {evidence.file_name}
                                          </button>
                                        ))}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {isFinalized && incidents.length > 0 && (
                    <div className="rounded-lg border border-[#DDD4CA] bg-white p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Incidencias históricas</p>
                      <div className="mt-2 space-y-2">
                        {incidents.map(incident => {
                          const evidence = attachments.filter(item => item.incident_id === incident.id)
                          return (
                            <div key={incident.id} className="rounded border border-[#E8DFD5] bg-[#FCFBF9] px-2.5 py-2 text-[11px]">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="font-semibold text-[#8A4B4B]">{AUDIT_INCIDENT_LABELS[incident.incident_type]}</span>
                                <span className="tabular-nums text-theme-text-muted">Preparado {incident.prepared_quantity_snapshot} · Auditado {incident.audit_quantity}</span>
                                <span className="rounded border border-[#D1C7BD] bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted">{incident.status}</span>
                              </div>
                              {incident.observation && <p className="mt-0.5 text-theme-text-muted">Obs.: {incident.observation}</p>}
                              {evidence.length > 0 && (
                                <div className="mt-1 flex flex-wrap items-center gap-1">
                                  {evidence.map(item => (
                                    <button
                                      key={item.id}
                                      type="button"
                                      onClick={() => void handleOpenEvidence(item)}
                                      className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-100"
                                      title="Ver evidencia"
                                    >
                                      <FileImage className="h-3 w-3" /> {item.file_name}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {lineError && <p className="rounded-md border border-[#8A4B4B]/30 bg-[#8A4B4B]/10 px-3 py-2 text-xs text-[#8A4B4B]">{lineError}</p>}
                </section>

                <aside className="self-start xl:sticky xl:top-4">
                  <div className="space-y-3 rounded-lg border border-[#DDD4CA] bg-white p-3 shadow-xs">
                    <div className="flex items-center gap-1.5">
                      <ClipboardCheck className="h-4 w-4 text-[#72383D]" />
                      <h3 className="text-xs font-bold uppercase tracking-wider text-theme-text">Cierre de Auditoría</h3>
                    </div>

                    <div className="space-y-1">
                      {isFinalized ? (
                        <>
                          <p className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Cantidad final de bultos</p>
                          <p className="text-lg font-bold tabular-nums text-theme-text">{packageCount == null ? '—' : packageCount}</p>
                        </>
                      ) : (
                        <>
                      <label htmlFor="audit-package-count" className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Cantidad final de bultos</label>
                      <div className="flex gap-1.5">
                        <input
                          id="audit-package-count"
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          placeholder="Sin informar"
                          value={packageDraft}
                          disabled={!canWrite || savingPackage}
                          onChange={event => setPackageDraft(event.target.value)}
                          onKeyDown={event => { if (event.key === 'Enter') void handleSavePackage() }}
                          className="w-full rounded border border-[#D1C7BD] bg-white px-2 py-1.5 text-sm font-semibold tabular-nums text-theme-text placeholder:text-theme-text-muted focus:border-[#72383D] focus:outline-none focus:ring-1 focus:ring-[#72383D]/20 disabled:bg-[#F0ECE8]"
                        />
                        <button type="button" onClick={() => void handleSavePackage()} disabled={!canWrite || savingPackage} className="rounded-md bg-[#72383D] px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-[#612F34] disabled:opacity-40">
                          {savingPackage ? 'Guardando…' : 'Guardar'}
                        </button>
                      </div>
                      <p className="text-[10px] text-theme-text-muted">Dato físico independiente de productos y unidades. 0 no es válido para el pre-cierre.</p>
                      {packageError && <p className="text-[10px] text-[#8A4B4B]">{packageError}</p>}
                        </>
                      )}
                    </div>

                    <div className="space-y-1 border-t border-[#E8DFD5] pt-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Fotografía de salida <span className="font-normal normal-case tracking-normal">(opcional)</span></p>
                      {globalPhoto ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="inline-flex min-w-0 items-center gap-1 rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Fotografía adjunta: {globalPhoto.file_name}</span>
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleOpenEvidence(globalPhoto)}
                            className="rounded border border-[#D1C7BD] bg-white px-2 py-0.5 text-[10px] font-semibold text-theme-text hover:bg-[#F8F5F1]"
                          >
                            Ver
                          </button>
                        </div>
                      ) : isFinalized ? (
                        <p className="text-[11px] text-theme-text-muted">Sin fotografía general registrada.</p>
                      ) : (
                        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[#B8ABA0] bg-[#FCFBF9] px-3 py-2 text-[11px] font-semibold text-theme-text hover:bg-[#F8F5F1]">
                          <Camera className="h-4 w-4 text-[#72383D]" />
                          {globalUploading ? 'Subiendo…' : 'Agregar fotografía'}
                          <input
                            type="file"
                            accept={AUDIT_EVIDENCE_ACCEPT}
                            className="sr-only"
                            disabled={!canWrite || globalUploading}
                            onChange={event => {
                              const file = event.target.files?.[0] ?? null
                              event.currentTarget.value = ''
                              void handleGlobalPhoto(file)
                            }}
                          />
                        </label>
                      )}
                      <p className="text-[10px] text-theme-text-muted">Evidencia de los bultos entregados al transportista.</p>
                      {globalError && <p className="text-[10px] text-[#8A4B4B]">{globalError}</p>}
                    </div>

                    <div className="border-t border-[#E8DFD5] pt-3">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-[#6B625C]">Resumen</p>
                      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1.5">
                        <SideStat label="Líneas" value={auditedLinesDisplay} />
                        <SideStat label="Conformes" value={hasSnapshot ? summary.conformingLines : '—'} />
                        <SideStat label="Incidencias" value={hasSnapshot ? summary.incidentLines : '—'} />
                        <SideStat label="Abiertas" value={hasSnapshot ? summary.openIncidents : '—'} />
                        <SideStat label="Solicitado" value={String(requestedTotal)} accent />
                        <SideStat label="Preparado" value={preparedTotal} accent />
                        <SideStat label="Auditado" value={auditedTotal} accent />
                        <SideStat label="Bultos" value={packageCount == null ? '—' : String(packageCount)} />
                      </div>
                    </div>

                    {!isFinalized && (
                      <>
                        <button type="button" onClick={() => void handleReviewClose()} disabled={!audit || precloseLoading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#72383D] px-3 py-2 text-xs font-bold text-white hover:bg-[#612F34] disabled:opacity-40">
                          {precloseLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                          REVISAR CIERRE
                        </button>
                        <p className="text-center text-[10px] text-theme-text-muted">La revisión no mueve la tarjeta ni completa la Auditoría.</p>
                      </>
                    )}
                  </div>
                </aside>
              </div>
            </>
          ) : null}
        </div>

        <div className="flex flex-none justify-end gap-2 border-t border-[#D1C7BD] bg-white px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-[#DDD4CA] bg-white px-4 py-2 text-xs font-semibold text-[#322D29]/80 hover:bg-[#F5F0EA]">
            Cerrar detalle
          </button>
        </div>
      </div>

      <AuditIncidentDialog
        open={Boolean(incidentDialog)}
        mode={incidentDialog?.mode ?? 'MANUAL'}
        line={incidentDialog?.line ?? null}
        auditQuantity={incidentDialog?.auditQuantity ?? 0}
        automaticType={incidentDialog?.automaticType ?? null}
        existingIncident={incidentDialog?.existingIncident ?? null}
        existingEvidence={incidentDialog?.existingIncident
          ? attachments.filter(item => item.incident_id === incidentDialog.existingIncident?.id)
          : []}
        onOpenChange={next => { if (!next) setIncidentDialog(null) }}
        onConfirm={handleIncidentConfirm}
        onRetryUpload={handleRetryIncidentUpload}
      />

      <AuditTakeoverDialog
        open={takeoverOpen && Boolean(audit)}
        card={card}
        audit={audit}
        currentUserName={currentUserName}
        onOpenChange={setTakeoverOpen}
        onConfirm={handleTakeoverConfirm}
      />

      <AuditCloseReviewDialog
        open={precloseOpen}
        loading={precloseLoading}
        error={precloseError}
        finalization={preclose}
        summary={summary}
        packageCount={packageCount}
        hasGlobalPhoto={Boolean(globalPhoto)}
        finalizing={finalizing}
        finalizeError={finalizeError}
        onOpenChange={setPrecloseOpen}
        onFinalize={handleFinalize}
      />

      <AuditEvidencePreviewDialog
        open={previewOpen}
        loading={previewLoading}
        error={previewError}
        evidence={previewEvidence}
        onOpenChange={setPreviewOpen}
      />
    </>
  )
}
