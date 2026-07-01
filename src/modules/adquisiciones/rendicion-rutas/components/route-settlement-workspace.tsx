'use client'

import React, { useState, useMemo, useCallback, useEffect } from 'react'
import {
  ArrowLeft,
  Save,
  AlertTriangle,
  Eye,
  Info,
  Loader2,
  Paperclip,
} from 'lucide-react'
import {
  RouteGuideWorkspaceData,
  RouteGuideWorkspaceItem,
  SettlementItemUpdate,
  SaveRouteSettlementResult,
  saveRouteSettlementChanges,
} from '@/app/actions/adquisiciones/rendicion-rutas'
import { RouteSettlement, RouteSettlementItem } from '../types'
import {
  formatCurrency,
  formatDate,
  formatExpectedPaymentMethod,
  formatSettlementItemStatus,
} from '../utils/route-settlement-formatters'
import { SettlementStatusBadge } from './route-settlement-badges'
import { InvoiceEditPanel, EditedItemFields } from './invoice-edit-panel'
import { InvoicePreviewModal } from './invoice-preview-modal'
import { SettlementDocumentViewerModal } from './settlement-document-viewer-modal'
import {
  getSettlementAttachmentsBySettlement,
  saveSettlementItemAttachment,
  SettlementItemAttachment,
} from '@/app/actions/adquisiciones/rendicion-rutas-adjuntos'
import { SETTLEMENT_ATTACHMENT_BUCKET } from '../utils/settlement-attachment-config'
import { toast } from 'sonner'

// ─── Tipos locales ────────────────────────────────────────────────────────────

type WorkspaceMode = 'no-rr' | 'has-rr'

interface WorkspaceRow {
  guideItemId: string
  /** ID de route_settlement_items en BD — null si la RR aún no existe o no se guardó */
  settlementItemId: string | null
  invoice_number: string
  customer_name: string
  expected_payment_method: string
  expected_amount: number
  status: RouteSettlementItem['status']
  received_amount: number
  difference_amount: number
  notes: string
  transfer_confirmed: boolean
  transfer_reference: string
  check_received: boolean
  check_bank: string
  check_number: string
  check_amount: number | null
  is_pending: boolean
  requires_followup: boolean
  isDirty: boolean
  stagedFiles: File[]
}

interface RouteSettlementWorkspaceProps {
  mode: WorkspaceMode
  guideData: RouteGuideWorkspaceData
  settlement?: RouteSettlement | null
  settlementItems?: RouteSettlementItem[] | null
  onClose: (savedResult?: SaveRouteSettlementResult) => void
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultStatusForMethod(method: string): RouteSettlementItem['status'] {
  switch (method) {
    case 'CASH':
    case 'CHECK':
      return 'PENDING_PAYMENT'
    case 'TRANSFER':
      return 'TRANSFER_PENDING'
    case 'CREDIT':
      return 'CREDIT_REGISTERED'
    default:
      return 'REVIEW_REQUIRED'
  }
}

function buildInitialRows(
  guideItems: RouteGuideWorkspaceItem[],
  settlementItems: RouteSettlementItem[] | null | undefined
): WorkspaceRow[] {
  const siByGuideItemId = new Map<string, RouteSettlementItem>(
    (settlementItems ?? []).map(si => [si.route_guide_item_id, si])
  )

  return guideItems.map(gi => {
    const si = siByGuideItemId.get(gi.id)
    return {
      guideItemId: gi.id,
      settlementItemId: si?.id ?? null,
      invoice_number: gi.invoice_number,
      customer_name: gi.customer_name,
      expected_payment_method: gi.payment_method_normalized,
      expected_amount: Number(gi.amount),
      status: si?.status ?? defaultStatusForMethod(gi.payment_method_normalized),
      received_amount: Number(si?.received_amount ?? 0),
      difference_amount: Number(si?.difference_amount ?? 0),
      notes: si?.notes ?? '',
      transfer_confirmed: si?.transfer_confirmed ?? false,
      transfer_reference: si?.transfer_reference ?? '',
      check_received: si?.check_received ?? false,
      check_bank: si?.check_bank ?? '',
      check_number: si?.check_number ?? '',
      check_amount: si?.check_amount ?? null,
      is_pending: si?.is_pending ?? true,
      requires_followup: si?.requires_followup ?? false,
      isDirty: false,
      stagedFiles: [],
    }
  })
}

function isRealChange(row: WorkspaceRow): boolean {
  if (row.received_amount > 0) return true
  if (row.notes.trim() !== '') return true
  if (row.transfer_reference.trim() !== '') return true
  if (row.transfer_confirmed) return true
  if (row.check_received) return true
  if (row.requires_followup) return true
  if (row.stagedFiles.length > 0) return true
  const defaultStatus = defaultStatusForMethod(row.expected_payment_method)
  if (row.status !== defaultStatus) return true
  return false
}

function getItemStatusStyle(status: string): string {
  switch (status) {
    case 'PAID_CASH':
    case 'TRANSFER_CONFIRMED':
    case 'CHECK_RECEIVED':
      return 'bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20'
    case 'TRANSFER_PENDING':
    case 'CREDIT_REGISTERED':
      return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'
    case 'PENDING_PAYMENT':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
    case 'PARTIAL_PAYMENT':
    case 'DIFFERENCE':
      return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20'
    case 'NOT_DELIVERED':
    case 'REVIEW_REQUIRED':
      return 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20'
    default:
      return 'bg-theme-text/5 text-theme-text-muted border border-theme-border'
  }
}

// ─── Componente Principal ─────────────────────────────────────────────────────

export function RouteSettlementWorkspace({
  mode,
  guideData,
  settlement: initialSettlement,
  settlementItems,
  onClose,
}: RouteSettlementWorkspaceProps) {
  const [rows, setRows] = useState<WorkspaceRow[]>(() =>
    buildInitialRows(guideData.items, settlementItems)
  )
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null)
  const [previewRowId, setPreviewRowId] = useState<string | null>(null)
  const [editingRowId, setEditingRowId] = useState<string | null>(null)
  const [documentViewer, setDocumentViewer] = useState<{ rowId: string; attachmentId?: string } | null>(null)
  const [invoiceFilter, setInvoiceFilter] = useState<'CASH_ONLY' | 'ALL'>('CASH_ONLY')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [attachmentLoadError, setAttachmentLoadError] = useState<string | null>(null)
  const [lastSavedResult, setLastSavedResult] = useState<SaveRouteSettlementResult | null>(null)
  const [notes, setNotes] = useState(initialSettlement?.notes ?? '')
  const [savedNotes, setSavedNotes] = useState(initialSettlement?.notes ?? '')

  // settlement_id real — se actualiza tras el primer guardado si mode era 'no-rr'
  const [persistedSettlementId, setPersistedSettlementId] = useState<string | null>(
    initialSettlement?.id ?? null
  )
  const [persistedStatus, setPersistedStatus] = useState<RouteSettlement['status'] | 'PENDING_SETTLEMENT'>(
    initialSettlement?.status ?? 'PENDING_SETTLEMENT'
  )
  // Mapa de guideItemId → settlementItemId real (se actualiza tras primer guardado)
  const [settlementItemIdMap, setSettlementItemIdMap] = useState<Map<string, string>>(
    () => new Map((settlementItems ?? []).map(si => [si.route_guide_item_id, si.id]))
  )
  const [attachmentsByItemId, setAttachmentsByItemId] = useState<Record<string, SettlementItemAttachment[]>>({})

  const guide = guideData.guide

  // ── Estado derivado ──────────────────────────────────────────────────────
  const dirtyRows = useMemo(() => rows.filter(r => r.isDirty), [rows])
  const hasDirtyChanges = dirtyRows.length > 0
  const notesDirty = notes !== savedNotes
  const hasSaveableChanges = hasDirtyChanges || notesDirty
  const editingRow = rows.find(r => r.guideItemId === editingRowId) ?? null
  const previewRow = rows.find(r => r.guideItemId === previewRowId) ?? null
  const isCountedPayment = (method: string) => ['CASH', 'TRANSFER', 'CHECK'].includes(method)
  const visibleRows = invoiceFilter === 'CASH_ONLY' ? rows.filter(r => isCountedPayment(r.expected_payment_method)) : rows
  const hiddenCreditCount = rows.filter(r => !isCountedPayment(r.expected_payment_method)).length

  const summary = useMemo(() => {
    const getEffectiveMethod = (r: WorkspaceRow) => {
      if (r.status === 'PAID_CASH') return 'CASH'
      if (r.status === 'TRANSFER_CONFIRMED') return 'TRANSFER'
      if (r.status === 'CHECK_RECEIVED') return 'CHECK'
      return r.expected_payment_method
    }

    const countedRows = rows.filter(r => isCountedPayment(getEffectiveMethod(r)))
    const countedTotal = countedRows.reduce((a, r) => a + r.expected_amount, 0)
    
    const cashRows = rows.filter(r => getEffectiveMethod(r) === 'CASH')
    const cashExpected = cashRows.reduce((a, r) => a + r.expected_amount, 0)
    const cashReceived = cashRows.reduce((a, r) => a + (r.status === 'PAID_CASH' ? r.received_amount : 0), 0)
    const cashDiff = cashExpected - cashReceived
    
    const transferRows = rows.filter(r => getEffectiveMethod(r) === 'TRANSFER')
    const transferExpected = transferRows.reduce((a, r) => a + r.expected_amount, 0)
    const transferConfirmed = transferRows
      .filter(r => r.status === 'TRANSFER_CONFIRMED' || r.transfer_confirmed)
      .reduce((a, r) => a + r.expected_amount, 0)
    const transferPending = transferRows
      .filter(r => r.status !== 'TRANSFER_CONFIRMED' && !r.transfer_confirmed)
      .reduce((a, r) => a + r.expected_amount, 0)
      
    const checkRows = rows.filter(r => getEffectiveMethod(r) === 'CHECK')
    const checkExpected = checkRows.reduce((a, r) => a + r.expected_amount, 0)
    const checkReceived = checkRows.reduce((a, r) => a + (r.status === 'CHECK_RECEIVED' ? r.received_amount : 0), 0)
    
    const paid = countedRows.filter(r => ['PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED'].includes(r.status) && (r.status !== 'PAID_CASH' || r.received_amount === r.expected_amount)).length
    return { countedTotal, cashExpected, cashReceived, cashDiff, transferExpected, transferConfirmed, transferPending, checkExpected, checkReceived, paid, countedCount: countedRows.length }
  }, [rows])

  const currentStatus = useMemo(() => {
    if (!persistedSettlementId) return 'PENDING_SETTLEMENT'
    if (mode === 'no-rr' && !persistedSettlementId) return 'PENDING_SETTLEMENT'
    return persistedStatus
  }, [persistedSettlementId, mode, persistedStatus])

  // ── Aplicar edición en memoria ───────────────────────────────────────────
  const handleApplyEdit = useCallback((guideItemId: string, fields: EditedItemFields) => {
    setRows(prev => prev.map(r => {
      if (r.guideItemId !== guideItemId) return r
      const isTransferConfirmed = fields.status === 'TRANSFER_CONFIRMED'
      const isCheckReceived = fields.status === 'CHECK_RECEIVED'
      const receivedAmt = typeof fields.received_amount === 'number'
        ? fields.received_amount
        : isTransferConfirmed || isCheckReceived
          ? r.expected_amount
          : 0
      const diff = r.expected_payment_method === 'TRANSFER' && isTransferConfirmed ? 0 : r.expected_amount - receivedAmt
      return {
        ...r,
        status: fields.status,
        received_amount: receivedAmt,
        difference_amount: diff,
        notes: fields.notes,
        transfer_confirmed: isTransferConfirmed || fields.transfer_confirmed,
        transfer_reference: fields.transfer_reference,
        check_received: isCheckReceived || fields.check_received,
        check_bank: fields.check_bank,
        check_number: fields.check_number,
        check_amount: typeof fields.check_amount === 'number' ? fields.check_amount : null,
        is_pending: !['PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED'].includes(fields.status),
        requires_followup: fields.requires_followup,
        isDirty: true,
        stagedFiles: fields.stagedFiles,
      }
    }))
  }, [])

  const buildRowFromFields = (row: WorkspaceRow, fields: EditedItemFields): WorkspaceRow => {
    const isTransferConfirmed = fields.status === 'TRANSFER_CONFIRMED'
    const isCheckReceived = fields.status === 'CHECK_RECEIVED'
    const receivedAmt = typeof fields.received_amount === 'number'
      ? fields.received_amount
      : isTransferConfirmed || isCheckReceived
        ? row.expected_amount
        : 0
    const differenceAmount = row.expected_payment_method === 'TRANSFER' && isTransferConfirmed
      ? 0
      : row.expected_amount - receivedAmt
    return {
      ...row,
      status: fields.status,
      received_amount: receivedAmt,
      difference_amount: differenceAmount,
      notes: fields.notes,
      transfer_confirmed: isTransferConfirmed || fields.transfer_confirmed,
      transfer_reference: fields.transfer_reference,
      check_received: isCheckReceived || fields.check_received,
      check_bank: fields.check_bank,
      check_number: fields.check_number,
      check_amount: typeof fields.check_amount === 'number' ? fields.check_amount : null,
      is_pending: !['PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED'].includes(fields.status),
      requires_followup: fields.requires_followup,
      isDirty: true,
      stagedFiles: fields.stagedFiles,
    }
  }

  const rowToUpdate = (row: WorkspaceRow): SettlementItemUpdate => ({
    id: row.settlementItemId ?? row.guideItemId,
    received_amount: row.received_amount,
    status: row.status,
    notes: row.notes || null,
    transfer_confirmed: row.transfer_confirmed,
    transfer_reference: row.transfer_reference || null,
    check_received: row.check_received,
    check_bank: row.check_bank || null,
    check_number: row.check_number || null,
    check_amount: row.check_amount,
    is_pending: row.is_pending,
    requires_followup: row.requires_followup,
  })

  // ── Guardar cambios en BD ────────────────────────────────────────────────
  const handleSave = async () => {
    if (!hasSaveableChanges) return
    setIsSaving(true)
    setSaveError(null)

    const itemsToSave: SettlementItemUpdate[] = dirtyRows
      .map(r => ({
        // Si ya hay settlement_item en BD, usamos ese ID.
        // Si aún no existe (modo no-rr, primera vez), usamos guideItemId —
        // la server action lo remapiará tras crear la RR.
        id: r.settlementItemId ?? r.guideItemId,
        received_amount: r.received_amount,
        status: r.status,
        notes: r.notes || null,
        transfer_confirmed: r.transfer_confirmed,
        transfer_reference: r.transfer_reference || null,
        check_received: r.check_received,
        check_bank: r.check_bank || null,
        check_number: r.check_number || null,
        check_amount: r.check_amount,
        is_pending: r.is_pending,
        requires_followup: r.requires_followup,
      }))

    if (!persistedSettlementId && itemsToSave.length === 0) {
      setSaveError('No se puede crear una rendición sin cambios reales en facturas o adjuntos.')
      setIsSaving(false)
      return
    }

    if (!persistedSettlementId && !dirtyRows.some(r => isRealChange(r))) {
      setSaveError('No se puede crear una rendición sin cambios reales en facturas o adjuntos.')
      setIsSaving(false)
      return
    }

    const { data, error } = await saveRouteSettlementChanges(
      guide.id,
      itemsToSave,
      notes || null
    )

    if (error || !data) {
      setSaveError(error ?? 'Error desconocido al guardar')
      setIsSaving(false)
      return
    }

    const newSettlementId = data.settlement_id
    const currentMap = new Map(Object.entries(data.item_id_map || {}))
    const failedAttachmentFiles = new Map<string, File[]>()
    const attachmentFailures: string[] = []

    const keepFailedFile = (guideItemId: string, file: File) => {
      const current = failedAttachmentFiles.get(guideItemId) ?? []
      failedAttachmentFiles.set(guideItemId, [...current, file])
    }
    
    // Subir stagedFiles si existen
    if (newSettlementId) {
      const { createClient } = await import('@/lib/supabase/client')
      const sb = createClient()

      // Procesar uploads
      for (const row of dirtyRows.filter(r => r.stagedFiles.length > 0)) {
        const actualItemId = currentMap.get(row.guideItemId) ?? row.settlementItemId
        if (!actualItemId) {
          attachmentFailures.push(`Factura ${row.invoice_number}: no se encontró el ID real del ítem.`)
          row.stagedFiles.forEach(file => keepFailedFile(row.guideItemId, file))
          continue
        }

        for (const file of row.stagedFiles) {
          const safeName = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9.-]/g, '_')
          const filePath = `${guide.company_id}/rendicion-rutas/${newSettlementId}/${Date.now()}-${safeName}`

          const { error: uploadErr } = await sb.storage
            .from(SETTLEMENT_ATTACHMENT_BUCKET)
            .upload(filePath, file, { cacheControl: '3600', upsert: false })

          if (uploadErr) {
            attachmentFailures.push(`Factura ${row.invoice_number}, archivo ${file.name}: ${uploadErr.message}`)
            keepFailedFile(row.guideItemId, file)
            if (process.env.NODE_ENV === 'development') {
              console.error('[RendicionRutas:UI] attachment upload error', uploadErr)
            }
            continue
          }

          const { data: savedAttachment, error: metadataErr } = await saveSettlementItemAttachment({
            settlementItemId: actualItemId,
            settlementId: newSettlementId,
            filePath,
            fileName: file.name,
            fileMimeType: file.type,
            fileSize: file.size,
          })

          if (metadataErr) {
            attachmentFailures.push(`Factura ${row.invoice_number}, archivo ${file.name}: ${metadataErr}`)
            keepFailedFile(row.guideItemId, file)
            const { error: cleanupErr } = await sb.storage
              .from(SETTLEMENT_ATTACHMENT_BUCKET)
              .remove([filePath])

            if (cleanupErr && process.env.NODE_ENV === 'development') {
              console.error('[RendicionRutas:UI] attachment cleanup error', cleanupErr)
            }
            if (process.env.NODE_ENV === 'development') {
              console.error('[RendicionRutas:UI] attachment metadata error', metadataErr)
            }
          } else if (savedAttachment) {
            setAttachmentsByItemId(prev => ({
              ...prev,
              [actualItemId]: [...(prev[actualItemId] || []), savedAttachment],
            }))
          }
        }
      }
    }

    setSavedNotes(notes)
    setLastSavedResult(data)
    setSettlementItemIdMap(currentMap)

    // Actualizar persistedSettlementId si se creó la RR ahora
    if (!persistedSettlementId && newSettlementId) {
      setPersistedSettlementId(newSettlementId)
    }
    setPersistedStatus(data.settlement_status as RouteSettlement['status'])

    setRows(prev => prev.map(r => ({
      ...r,
      settlementItemId: currentMap.get(r.guideItemId) ?? r.settlementItemId,
      isDirty: failedAttachmentFiles.has(r.guideItemId),
      stagedFiles: failedAttachmentFiles.get(r.guideItemId) ?? [],
    })))

    setIsSaving(false)
    if (attachmentFailures.length > 0) {
      const message = `Cambios guardados, pero fallaron ${attachmentFailures.length} adjunto(s). Revise e intente nuevamente.`
      setSaveError(`${message}\n${attachmentFailures.join('\n')}`)
      toast.warning(message)
      return
    }

    toast.success('Cambios guardados correctamente.')
    // Notificar al panel padre para actualizar la fila en la bandeja
    onClose(data)
  }

  const handleSaveInvoice = async (guideItemId: string, fields: EditedItemFields): Promise<{ error?: string; stagedFiles?: File[] }> => {
    const currentRow = rows.find(r => r.guideItemId === guideItemId)
    if (!currentRow) return { error: 'Factura no encontrada en la guía.' }

    const nextRow = buildRowFromFields(currentRow, fields)
    if (!persistedSettlementId && !isRealChange(nextRow)) {
      return { error: 'No se puede crear una rendición sin cambios reales en la factura o adjuntos.' }
    }

    const { data, error } = await saveRouteSettlementChanges(guide.id, [rowToUpdate(nextRow)], notes || null)
    if (error || !data) return { error: error ?? 'Error desconocido al guardar factura.' }

    const newSettlementId = data.settlement_id
    const currentMap = new Map(Object.entries(data.item_id_map || {}))
    const actualItemId = currentMap.get(guideItemId) ?? currentRow.settlementItemId
    if (!actualItemId) return { error: 'No se encontró el ID real del ítem guardado.', stagedFiles: fields.stagedFiles }

    const failedFiles: File[] = []
    const attachmentFailures: string[] = []

    if (fields.stagedFiles.length > 0) {
      const { createClient } = await import('@/lib/supabase/client')
      const sb = createClient()

      for (const file of fields.stagedFiles) {
        const safeName = file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9.-]/g, '_')
        const filePath = `${guide.company_id}/rendicion-rutas/${newSettlementId}/${Date.now()}-${safeName}`

        const { error: uploadErr } = await sb.storage
          .from(SETTLEMENT_ATTACHMENT_BUCKET)
          .upload(filePath, file, { cacheControl: '3600', upsert: false })

        if (uploadErr) {
          failedFiles.push(file)
          attachmentFailures.push(`${file.name}: ${uploadErr.message}`)
          if (process.env.NODE_ENV === 'development') console.error('[RendicionRutas:UI] invoice attachment upload error', uploadErr)
          continue
        }

        const { data: savedAttachment, error: metadataErr } = await saveSettlementItemAttachment({
          settlementItemId: actualItemId,
          settlementId: newSettlementId,
          filePath,
          fileName: file.name,
          fileMimeType: file.type,
          fileSize: file.size,
        })

        if (metadataErr) {
          failedFiles.push(file)
          attachmentFailures.push(`${file.name}: ${metadataErr}`)
          const { error: cleanupErr } = await sb.storage.from(SETTLEMENT_ATTACHMENT_BUCKET).remove([filePath])
          if (cleanupErr && process.env.NODE_ENV === 'development') console.error('[RendicionRutas:UI] invoice attachment cleanup error', cleanupErr)
          if (process.env.NODE_ENV === 'development') console.error('[RendicionRutas:UI] invoice attachment metadata error', metadataErr)
        } else if (savedAttachment) {
          setAttachmentsByItemId(prev => ({
            ...prev,
            [actualItemId]: [...(prev[actualItemId] || []), savedAttachment],
          }))
        }
      }
    }

    setPersistedSettlementId(newSettlementId)
    setPersistedStatus(data.settlement_status as RouteSettlement['status'])
    setLastSavedResult(data)
    setSettlementItemIdMap(currentMap)
    setRows(prev => prev.map(row => {
      if (row.guideItemId !== guideItemId) {
        return {
          ...row,
          settlementItemId: currentMap.get(row.guideItemId) ?? row.settlementItemId,
        }
      }

      return {
        ...nextRow,
        settlementItemId: actualItemId,
        isDirty: failedFiles.length > 0,
        stagedFiles: failedFiles,
      }
    }))

    if (attachmentFailures.length > 0) {
      return {
        error: `Factura guardada, pero fallaron ${attachmentFailures.length} adjunto(s): ${attachmentFailures.join('; ')}`,
        stagedFiles: failedFiles,
      }
    }

    return {}
  }

  const rowToSettlementItem = (row: WorkspaceRow): RouteSettlementItem => ({
    id: row.settlementItemId ?? row.guideItemId,
    company_id: guide.company_id,
    settlement_id: persistedSettlementId ?? '',
    route_guide_item_id: row.guideItemId,
    invoice_number: row.invoice_number,
    customer_name: row.customer_name,
    expected_payment_method: row.expected_payment_method,
    expected_amount: row.expected_amount,
    received_amount: row.received_amount,
    difference_amount: row.difference_amount,
    status: row.status,
    notes: row.notes || undefined,
    transfer_confirmed: row.transfer_confirmed,
    transfer_reference: row.transfer_reference || undefined,
    check_received: row.check_received,
    check_bank: row.check_bank || undefined,
    check_number: row.check_number || undefined,
    check_amount: row.check_amount ?? undefined,
    is_pending: row.is_pending,
    requires_followup: row.requires_followup,
    created_at: '',
    updated_at: '',
  })

  const selectedAsSettlementItem = editingRow ? rowToSettlementItem(editingRow) : null
  const previewAsSettlementItem = previewRow ? rowToSettlementItem(previewRow) : null
  const documentRow = documentViewer ? rows.find(r => r.guideItemId === documentViewer.rowId) ?? null : null
  const documentAttachments = documentRow?.settlementItemId ? attachmentsByItemId[documentRow.settlementItemId] ?? [] : []

  useEffect(() => {
    let mounted = true
    if (!persistedSettlementId) {
      setAttachmentsByItemId({})
      setAttachmentLoadError(null)
      return
    }

    getSettlementAttachmentsBySettlement(persistedSettlementId).then(({ data, error }) => {
      if (!mounted) return
      if (error) {
        setAttachmentLoadError(error)
        return
      }

      const grouped: Record<string, SettlementItemAttachment[]> = {}
      for (const attachment of data || []) {
        grouped[attachment.settlement_item_id] = [...(grouped[attachment.settlement_item_id] || []), attachment]
      }
      setAttachmentsByItemId(grouped)
      setAttachmentLoadError(null)
    })

    return () => {
      mounted = false
    }
  }, [persistedSettlementId])

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="h-full min-h-0 overflow-hidden p-3 lg:p-4 flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">

      {/* ── Cabecera compacta ── */}
      <div className="shrink-0 flex flex-col lg:flex-row lg:items-center justify-between gap-2 rounded-xl border border-theme-border bg-theme-surface/80 px-3 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => onClose(lastSavedResult ?? undefined)}
            className="p-1.5 rounded-lg hover:bg-theme-text/5 text-theme-text-muted transition-colors shrink-0"
            title="Volver a la lista"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-theme-text leading-tight">
              <span>Guía {guide.guide_number}</span>
              </h2>
              {persistedSettlementId && initialSettlement && (
                <span className="text-[11px] font-mono text-theme-text-muted">{initialSettlement.settlement_number}</span>
              )}
              <SettlementStatusBadge status={currentStatus} />
            </div>
            <p className="text-[11px] text-theme-text-muted mt-0.5 truncate">
              {formatDate(guide.guide_date)} · {guide.route_name_snapshot} · {guide.driver_name_snapshot ?? '—'} · {guide.seller_name_snapshot ?? '—'}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 shrink-0">
          {hasDirtyChanges && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold">
              {dirtyRows.length} factura{dirtyRows.length !== 1 ? 's' : ''} modificada{dirtyRows.length !== 1 ? 's' : ''}
            </span>
          )}
          {notesDirty && !hasDirtyChanges && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold">
              Observaciones modificadas
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!hasSaveableChanges || isSaving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold transition-all shadow-lg shadow-theme-accent/20"
          >
            {isSaving ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Guardando...</>
            ) : (
              <><Save className="w-3.5 h-3.5" /> Guardar cambios</>
            )}
          </button>
        </div>
      </div>

      {/* ── Aviso sin RR ── */}
      {mode === 'no-rr' && !persistedSettlementId && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-400/30 bg-amber-50/50 dark:bg-amber-900/10">
          <Info className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Esta guía aún no tiene rendición creada. La rendición se generará automáticamente al guardar cambios reales.
          </p>
        </div>
      )}

      {/* ── Error de guardado ── */}
      {saveError && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-2 rounded-lg border border-red-400/30 bg-red-50/50 dark:bg-red-900/10">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-xs text-red-800 dark:text-red-200 whitespace-pre-line">{saveError}</p>
        </div>
      )}

      {attachmentLoadError && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-2 rounded-lg border border-orange-400/30 bg-orange-50/50 dark:bg-orange-900/10">
          <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
          <p className="text-xs text-orange-800 dark:text-orange-200">No se pudieron cargar los comprobantes guardados: {attachmentLoadError}</p>
        </div>
      )}

      {/* ── Resumen financiero compacto ── */}
      <div className="shrink-0 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-8 rounded-lg border border-theme-border bg-theme-surface/70 overflow-hidden">
        {[
          ['Total ruta', formatCurrency(guide.total_amount), 'text-theme-text'],
          ['Total rendible', formatCurrency(summary.countedTotal), 'text-theme-text'],
          ['Efectivo esp.', formatCurrency(summary.cashExpected), 'text-theme-text'],
          ['Efectivo rec.', formatCurrency(summary.cashReceived), 'text-green-600 dark:text-green-400'],
          ['Dif. efectivo', formatCurrency(summary.cashDiff), summary.cashDiff > 0 ? 'text-red-500' : 'text-theme-text-muted'],
          ['Transf. esp/conf', `${formatCurrency(summary.transferExpected)} / ${formatCurrency(summary.transferConfirmed)}`, 'text-theme-text'],
          ['Transf. pendiente', formatCurrency(summary.transferPending), summary.transferPending > 0 ? 'text-orange-500' : 'text-theme-text-muted'],
          ['Fact. rendibles', `${summary.paid} / ${summary.countedCount}`, 'text-theme-text'],
        ].map(([label, value, color]) => (
          <div key={label} className="px-3 py-2 border-b md:border-b-0 xl:border-r border-theme-border/50 last:border-r-0">
            <p className="text-[9px] font-bold uppercase tracking-wider text-theme-text-muted leading-tight">{label}</p>
            <p className={`text-xs font-bold leading-tight mt-0.5 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* ── Tabla de facturas ── */}
      <div className="flex-1 min-h-0 rounded-xl border border-theme-border bg-theme-surface overflow-hidden flex flex-col">
        <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-theme-border/70 bg-theme-surface/95">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setInvoiceFilter('CASH_ONLY')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition-colors ${invoiceFilter === 'CASH_ONLY' ? 'border-theme-accent/50 bg-theme-accent/15 text-theme-text' : 'border-theme-border bg-theme-text/5 text-theme-text-muted hover:text-theme-text'}`}
            >
              Solo rendibles
            </button>
            <button
              type="button"
              onClick={() => setInvoiceFilter('ALL')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition-colors ${invoiceFilter === 'ALL' ? 'border-theme-accent/50 bg-theme-accent/15 text-theme-text' : 'border-theme-border bg-theme-text/5 text-theme-text-muted hover:text-theme-text'}`}
            >
              Mostrar todas
            </button>
          </div>
          {invoiceFilter === 'CASH_ONLY' && hiddenCreditCount > 0 && (
            <span className="text-[11px] text-theme-text-muted">{hiddenCreditCount} factura{hiddenCreditCount !== 1 ? 's' : ''} de crédito ocultas</span>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead>
              <tr className="sticky top-0 z-10 border-b border-theme-border/70 bg-theme-surface/95 backdrop-blur-sm shadow-sm">
                <th className="px-3 py-2 font-bold text-theme-text-muted">Factura</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted">Cliente</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Monto esp.</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted">Pago esp.</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted text-center">Estado</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Recibido</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted text-right">Diferencia</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted">Obs.</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted text-center">Doc.</th>
                <th className="px-3 py-2 font-bold text-theme-text-muted text-center">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/50">
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-theme-text-muted">
                    No se encontraron facturas en esta guía.
                  </td>
                </tr>
              ) : (
                visibleRows.map(row => {
                  const isHighlighted = highlightedRowId === row.guideItemId
                  const savedAttachments = row.settlementItemId ? attachmentsByItemId[row.settlementItemId] || [] : []
                  return (
                    <tr
                      key={row.guideItemId}
                      onClick={() => setHighlightedRowId(isHighlighted ? null : row.guideItemId)}
                      onDoubleClick={() => setPreviewRowId(row.guideItemId)}
                      className={`
                        cursor-pointer transition-colors select-none
                        ${isHighlighted ? 'bg-theme-accent/10 ring-1 ring-inset ring-theme-accent/30' : 'hover:bg-theme-text/[0.03]'}
                        ${row.isDirty ? 'border-l-2 border-l-amber-400' : ''}
                      `}
                    >
                      <td className="px-3 py-2 font-bold text-theme-text flex items-center gap-2">
                        {row.invoice_number}
                        {row.isDirty && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Con cambios sin guardar" />
                        )}
                        {row.stagedFiles.length > 0 && (
                          <span title="Contiene documentos adjuntos">
                            <Paperclip className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-theme-text max-w-[220px] truncate" title={row.customer_name}>{row.customer_name}</td>
                      <td className="px-3 py-2 text-theme-text text-right font-semibold">{formatCurrency(row.expected_amount)}</td>
                      <td className="px-3 py-2 text-theme-text-muted">{formatExpectedPaymentMethod(row.expected_payment_method)}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-2 py-0.5 rounded-lg text-[10px] uppercase font-bold tracking-wider ${getItemStatusStyle(row.status)}`}>
                          {formatSettlementItemStatus(row.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-green-600 dark:text-green-400">
                        {row.received_amount > 0 ? formatCurrency(row.received_amount) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={`font-bold ${row.difference_amount > 0 ? 'text-red-500' : 'text-theme-text-muted'}`}>
                          {row.received_amount > 0 ? formatCurrency(row.difference_amount) : '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-theme-text-muted max-w-[160px] truncate" title={row.notes || undefined}>{row.notes || '—'}</td>
                      <td className="px-3 py-2 text-center">
                        {savedAttachments.length > 0 ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setHighlightedRowId(row.guideItemId)
                              setDocumentViewer({ rowId: row.guideItemId, attachmentId: savedAttachments[0].id })
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-theme-accent/10 hover:bg-theme-accent/15 text-[11px] font-bold text-theme-accent transition-colors"
                            title="Ver comprobante guardado"
                          >
                            <Paperclip className="w-3 h-3" />
                            {savedAttachments.length > 1 ? `Ver ${savedAttachments.length}` : 'Ver'}
                          </button>
                        ) : row.stagedFiles.length > 0 ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-500/25 bg-amber-500/10 text-[11px] font-bold text-amber-700 dark:text-amber-300">
                            <Paperclip className="w-3 h-3" /> Pendiente
                          </span>
                        ) : (
                          <span className="text-theme-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setHighlightedRowId(row.guideItemId)
                            setPreviewRowId(row.guideItemId)
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-theme-border bg-theme-text/5 hover:bg-theme-accent/10 hover:border-theme-accent/40 text-[11px] font-bold text-theme-text-muted hover:text-theme-text transition-colors"
                        >
                          <Eye className="w-3 h-3" />
                          Ver
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Observaciones generales compactas ── */}
      <div className="shrink-0 rounded-lg border border-theme-border bg-theme-surface/70 px-3 py-2">
        <label className="block text-[9px] font-bold text-theme-text-muted uppercase tracking-wider mb-1">
          Observaciones generales de la rendición
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={1}
          placeholder="Notas opcionales para la rendición completa..."
          className="w-full text-xs bg-transparent border-none p-0 text-theme-text focus:outline-none resize-none placeholder-theme-text-muted"
        />
      </div>

      {previewRow && previewAsSettlementItem && (
        <InvoicePreviewModal
          item={previewAsSettlementItem}
          attachments={previewRow.settlementItemId ? attachmentsByItemId[previewRow.settlementItemId] || [] : []}
          stagedFiles={previewRow.stagedFiles}
          onOpenDocument={(attachmentId) => {
            setDocumentViewer({ rowId: previewRow.guideItemId, attachmentId })
          }}
          onClose={() => setPreviewRowId(null)}
          onEdit={() => {
            setEditingRowId(previewRow.guideItemId)
            setPreviewRowId(null)
          }}
        />
      )}

      {documentViewer && documentRow && documentAttachments.length > 0 && (
        <SettlementDocumentViewerModal
          invoiceNumber={documentRow.invoice_number}
          attachments={documentAttachments}
          initialAttachmentId={documentViewer.attachmentId}
          onClose={() => setDocumentViewer(null)}
        />
      )}

      {editingRowId && selectedAsSettlementItem && editingRow && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-sm p-3 lg:p-6 animate-in fade-in duration-150">
          <div className="w-full max-w-3xl">
            <InvoiceEditPanel
              key={editingRowId}
              item={selectedAsSettlementItem}
              persistedSettlementItemId={
                settlementItemIdMap.get(editingRowId) ?? editingRow?.settlementItemId ?? null
              }
              initialStagedFiles={editingRow?.stagedFiles}
              onApply={handleApplyEdit}
              onSave={handleSaveInvoice}
              onClose={() => setEditingRowId(null)}
            />
          </div>
        </div>
      )}

    </div>
  )
}
