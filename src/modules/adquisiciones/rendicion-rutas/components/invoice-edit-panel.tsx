'use client'

import React, { useState, useEffect, useRef } from 'react'
import { X, Save, Paperclip, Upload, Loader2, Trash2, FileText, Image, Download } from 'lucide-react'
import { toast } from 'sonner'
import { RouteSettlementItem } from '../types'
import {
  formatCurrency,
  formatExpectedPaymentMethod,
} from '../utils/route-settlement-formatters'
import {
  getSettlementItemAttachments,
  getSettlementAttachmentSignedUrl,
  deleteSettlementItemAttachment,
  SettlementItemAttachment,
} from '@/app/actions/adquisiciones/rendicion-rutas-adjuntos'
import {
  SETTLEMENT_ATTACHMENT_ALLOWED_MIMES,
  SETTLEMENT_ATTACHMENT_MAX_SIZE,
} from '../utils/settlement-attachment-config'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface EditedItemFields {
  received_amount: number | ''
  status: RouteSettlementItem['status']
  notes: string
  transfer_confirmed: boolean
  transfer_reference: string
  check_received: boolean
  check_bank: string
  check_number: string
  check_amount: number | ''
  requires_followup: boolean
  stagedFiles: File[]
}

interface InvoiceEditPanelProps {
  item: RouteSettlementItem
  /** ID real del settlement_item en BD (null si la RR aún no se guardó) */
  persistedSettlementItemId: string | null
  onApply: (itemId: string, fields: EditedItemFields) => void
  onSave?: (itemId: string, fields: EditedItemFields) => Promise<{ error?: string; stagedFiles?: File[] }>
  onClose: () => void
  initialStagedFiles?: File[]
}

// ─── Opciones de estado ───────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: RouteSettlementItem['status']; label: string }[] = [
  { value: 'PENDING_PAYMENT', label: 'Pendiente' },
  { value: 'PAID_CASH', label: 'Pagada (Efectivo)' },
  { value: 'TRANSFER_CONFIRMED', label: 'Transferencia Confirmada' },
  { value: 'TRANSFER_PENDING', label: 'Transferencia Pendiente' },
  { value: 'CHECK_RECEIVED', label: 'Cheque Recibido' },
  { value: 'CREDIT_REGISTERED', label: 'Crédito pendiente' },
  { value: 'PARTIAL_PAYMENT', label: 'Pago Parcial' },
  { value: 'DIFFERENCE', label: 'Con Diferencia' },
  { value: 'NOT_DELIVERED', label: 'No Entregada' },
  { value: 'REVIEW_REQUIRED', label: 'Requiere Revisión' },
]

function sameFiles(a: File[], b: File[]) {
  if (a.length !== b.length) return false
  return a.every((file, index) => {
    const other = b[index]
    return other && file.name === other.name && file.size === other.size && file.lastModified === other.lastModified
  })
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function InvoiceEditPanel({
  item,
  persistedSettlementItemId,
  onApply,
  onSave,
  onClose,
  initialStagedFiles = [],
}: InvoiceEditPanelProps) {
  const [fields, setFields] = useState<EditedItemFields>({
    received_amount: item.received_amount ?? 0,
    status: item.status,
    notes: item.notes ?? '',
    transfer_confirmed: item.transfer_confirmed ?? false,
    transfer_reference: item.transfer_reference ?? '',
    check_received: item.check_received ?? false,
    check_bank: item.check_bank ?? '',
    check_number: item.check_number ?? '',
    check_amount: item.check_amount ?? '',
    requires_followup: item.requires_followup ?? false,
    stagedFiles: initialStagedFiles,
  })

  // Bloqueo de solo lectura para facturas ya rendidas
  const [isLocked, setIsLocked] = useState(!!persistedSettlementItemId && !item.is_pending)

  // Adjuntos
  const [attachments, setAttachments] = useState<SettlementItemAttachment[]>([])
  const [loadingAttachments, setLoadingAttachments] = useState(false)
  const [savingInvoice, setSavingInvoice] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<{ url: string, mime: string | null, name: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Reset al cambiar de factura
  useEffect(() => {
    setFields({
      received_amount: item.received_amount ?? 0,
      status: item.status,
      notes: item.notes ?? '',
      transfer_confirmed: item.transfer_confirmed ?? false,
      transfer_reference: item.transfer_reference ?? '',
      check_received: item.check_received ?? false,
      check_bank: item.check_bank ?? '',
      check_number: item.check_number ?? '',
      check_amount: item.check_amount ?? '',
      requires_followup: item.requires_followup ?? false,
      stagedFiles: initialStagedFiles,
    })
    setIsLocked(!!persistedSettlementItemId && !item.is_pending)
    setUploadError(null)

    // Cargar adjuntos existentes solo si la RR ya existe
    if (persistedSettlementItemId) {
      setLoadingAttachments(true)
      getSettlementItemAttachments(persistedSettlementItemId).then(({ data }) => {
        setAttachments(data || [])
        setLoadingAttachments(false)
      })
    } else {
      setAttachments([])
    }
  }, [item.id, persistedSettlementItemId])

  const diff =
    (typeof fields.received_amount === 'number' ? fields.received_amount : 0) - item.expected_amount

  const isTransfer = fields.status === 'TRANSFER_CONFIRMED' || fields.status === 'TRANSFER_PENDING'
  const isCheck = fields.status === 'CHECK_RECEIVED'
  const hasUnappliedChanges =
    fields.received_amount !== (item.received_amount ?? 0) ||
    fields.status !== item.status ||
    fields.notes !== (item.notes ?? '') ||
    fields.transfer_confirmed !== (item.transfer_confirmed ?? false) ||
    fields.transfer_reference !== (item.transfer_reference ?? '') ||
    fields.check_received !== (item.check_received ?? false) ||
    fields.check_bank !== (item.check_bank ?? '') ||
    fields.check_number !== (item.check_number ?? '') ||
    fields.check_amount !== (item.check_amount ?? '') ||
    fields.requires_followup !== (item.requires_followup ?? false) ||
    !sameFiles(fields.stagedFiles, initialStagedFiles)

  const handleRequestClose = () => {
    if (hasUnappliedChanges && !confirm('Hay cambios sin aplicar en esta factura. ¿Cerrar y descartarlos?')) return
    onClose()
  }

  // ── Subir comprobante ────────────────────────────────────────────────────
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploadError(null)

    if (file.size > SETTLEMENT_ATTACHMENT_MAX_SIZE) {
      setUploadError('El archivo supera el límite de 10 MB.')
      return
    }
    if (!(SETTLEMENT_ATTACHMENT_ALLOWED_MIMES as readonly string[]).includes(file.type)) {
      setUploadError('Tipo de archivo no permitido. Solo PDF, PNG, JPG o WebP.')
      return
    }
    
    // Dejar el archivo en memoria (staged) hasta que se guarde la RR
    setFields(prev => ({
      ...prev,
      stagedFiles: [...prev.stagedFiles, file]
    }))
    
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // ── Quitar comprobante staged ────────────────────────────────────────────
  const handleRemoveStagedFile = (index: number) => {
    setFields(prev => {
      const newStaged = [...prev.stagedFiles]
      newStaged.splice(index, 1)
      return { ...prev, stagedFiles: newStaged }
    })
  }

  // ── Abrir comprobante ────────────────────────────────────────────────────
  const handleOpenAttachment = async (attachment: SettlementItemAttachment) => {
    const { data, error } = await getSettlementAttachmentSignedUrl(attachment.id)
    if (error || !data) {
      setUploadError(`No se pudo abrir el archivo: ${error}`)
      return
    }
    setPreviewUrl({ url: data.signedUrl, mime: attachment.file_mime_type, name: attachment.file_name })
  }

  // ── Eliminar comprobante ─────────────────────────────────────────────────
  const handleDeleteAttachment = async (attachment: SettlementItemAttachment) => {
    if (!confirm(`¿Eliminar "${attachment.file_name}"?`)) return
    const { error } = await deleteSettlementItemAttachment(attachment.id)
    if (error) {
      setUploadError(`Error al eliminar: ${error}`)
      return
    }
    setAttachments(prev => prev.filter(a => a.id !== attachment.id))
  }

  const handleApply = async () => {
    if (onSave) {
      setSavingInvoice(true)
      setUploadError(null)
      const result = await onSave(item.route_guide_item_id, fields)
      setSavingInvoice(false)
      if (result.stagedFiles) {
        setFields(prev => ({ ...prev, stagedFiles: result.stagedFiles || [] }))
      }
      if (result.error) {
        setUploadError(result.error)
        return
      }
      toast.success('Factura guardada correctamente.')
      onClose()
      return
    }

    onApply(item.route_guide_item_id, fields)
    toast.success('Borrador actualizado localmente.')
    onClose()
  }

  const fileIcon = (mime: string | null) => {
    if (!mime) return <FileText className="w-4 h-4" />
    if (mime.startsWith('image/')) return <Image className="w-4 h-4" />
    return <FileText className="w-4 h-4" />
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYOUT: flex column con altura máxima, header fijo, cuerpo con overflow-y-auto, footer fijo
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col border border-theme-border rounded-xl bg-theme-surface overflow-hidden w-full max-h-[calc(100vh-80px)]">

      {/* ── Header fijo ── */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-theme-border/60 bg-theme-text/[0.02]">
        <div>
          <h3 className="text-sm font-bold text-theme-text flex items-center gap-2">
            Factura <span className="font-mono text-theme-accent">{item.invoice_number}</span>
            {isLocked && <span className="text-[10px] bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded-full border border-amber-500/20">Solo Lectura</span>}
          </h3>
          <p className="text-[11px] text-theme-text-muted mt-0.5 truncate max-w-[220px]">{item.customer_name}</p>
        </div>
        <button
          onClick={handleRequestClose}
          className="p-1.5 rounded-lg hover:bg-theme-text/5 text-theme-text-muted transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* ── Info inmutable ── */}
      <div className="shrink-0 px-4 py-2 bg-theme-text/[0.01] border-b border-theme-border/40 flex flex-wrap gap-4 text-[11px]">
        <span>
          <span className="text-theme-text-muted font-bold uppercase tracking-wider">Esp: </span>
          <span className="font-bold text-theme-text">{formatCurrency(item.expected_amount)}</span>
        </span>
        <span>
          <span className="text-theme-text-muted font-bold uppercase tracking-wider">Pago: </span>
          <span className="font-semibold text-theme-text">{formatExpectedPaymentMethod(item.expected_payment_method)}</span>
        </span>
      </div>

      {/* ── Aviso de bloqueo ── */}
      {isLocked && (
        <div className="shrink-0 px-5 py-2.5 bg-amber-500/5 border-b border-amber-500/10 flex items-center justify-between text-[11px]">
          <span className="text-amber-700 dark:text-amber-400 font-medium">Factura ya rendida. Edición bloqueada.</span>
          <button
            type="button"
            onClick={() => setIsLocked(false)}
            className="text-amber-600 dark:text-amber-300 font-bold hover:underline transition-all"
          >
            Desbloquear (Admin)
          </button>
        </div>
      )}

      {/* ── Cuerpo con scroll ── */}
      <div className={`flex-1 min-h-0 overflow-y-auto px-4 py-4 grid grid-cols-2 gap-4 ${isLocked ? 'opacity-90' : ''}`}>

        {/* Estado de pago */}
        <div>
          <label className="block text-[10px] font-bold text-theme-text-muted uppercase tracking-wider mb-1.5">
            Estado de pago
          </label>
          <select
            value={fields.status}
            disabled={isLocked}
            onChange={(e) => {
              const status = e.target.value as RouteSettlementItem['status']
              setFields(f => ({
                ...f,
                status,
                received_amount: ['PAID_CASH', 'TRANSFER_CONFIRMED', 'CHECK_RECEIVED'].includes(status) && (f.received_amount === '' || f.received_amount === 0) ? item.expected_amount : f.received_amount,
                transfer_confirmed: status === 'TRANSFER_CONFIRMED' ? true : f.transfer_confirmed,
                check_received: status === 'CHECK_RECEIVED' ? true : f.check_received,
              }))
            }}
            className="w-full text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2.5 text-theme-text focus:outline-none focus:border-theme-accent transition-colors"
          >
            {STATUS_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Monto recibido */}
        <div>
          <label className="block text-[10px] font-bold text-theme-text-muted uppercase tracking-wider mb-1.5">
            Monto recibido
          </label>
          <input
            type="number"
            min={0}
            step={1}
            value={fields.received_amount}
            disabled={isLocked}
            onWheel={(e) => (e.target as HTMLInputElement).blur()}
            onChange={(e) => {
              const val = e.target.value === '' ? '' : Number(e.target.value)
              setFields(f => {
                let newStatus = f.status
                if (val === item.expected_amount) {
                  if (item.expected_payment_method === 'CASH') newStatus = 'PAID_CASH'
                  else if (item.expected_payment_method === 'TRANSFER') newStatus = 'TRANSFER_CONFIRMED'
                  else if (item.expected_payment_method === 'CHECK') newStatus = 'CHECK_RECEIVED'
                  else if (item.expected_payment_method === 'CREDIT') newStatus = 'CREDIT_REGISTERED'
                }
                return {
                  ...f,
                  received_amount: val,
                  status: newStatus
                }
              })
            }}
            placeholder="0"
            className="w-full text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2.5 text-theme-text focus:outline-none focus:border-theme-accent transition-colors font-mono"
          />
          {typeof fields.received_amount === 'number' && fields.received_amount > 0 && (
            <p className={`text-[11px] mt-1.5 font-semibold ${diff < 0 ? 'text-red-500' : diff > 0 ? 'text-green-500' : 'text-theme-text-muted'}`}>
              Diferencia: {formatCurrency(Math.abs(diff))} {diff < 0 ? '(falta)' : diff > 0 ? '(exceso)' : '(cuadrado)'}
            </p>
          )}
        </div>

        {/* Transferencia */}
        {isTransfer && (
          <div className="col-span-2 space-y-3 p-3 rounded-xl bg-blue-500/5 border border-blue-500/20">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-bold text-theme-text-muted uppercase tracking-wider mb-1.5">
                  Referencia / N° comprobante
                </label>
                <input
                  type="text"
                  value={fields.transfer_reference}
                  disabled={isLocked}
                  onChange={(e) => setFields(f => ({ ...f, transfer_reference: e.target.value }))}
                  placeholder="Ej: 123456789"
                  className="w-full text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2.5 text-theme-text focus:outline-none focus:border-theme-accent"
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input
                  id={`tf-${item.id}`}
                  type="checkbox"
                  checked={fields.transfer_confirmed}
                  disabled={isLocked}
                  onChange={(e) => setFields(f => ({ ...f, transfer_confirmed: e.target.checked }))}
                  className="w-4 h-4 accent-theme-accent"
                />
                <label htmlFor={`tf-${item.id}`} className="text-xs text-theme-text font-medium">
                  Transferencia confirmada
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Cheque */}
        {isCheck && (
          <div className="col-span-2 space-y-3 p-3 rounded-xl bg-purple-500/5 border border-purple-500/20">
            <p className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider">Datos del cheque</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[10px] text-theme-text-muted mb-1">Banco</label>
                <input type="text" value={fields.check_bank}
                  onChange={(e) => setFields(f => ({ ...f, check_bank: e.target.value }))}
                  placeholder="Banco"
                  className="w-full text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2 text-theme-text focus:outline-none focus:border-theme-accent"
                />
              </div>
              <div>
                <label className="block text-[10px] text-theme-text-muted mb-1">N° Cheque</label>
                <input type="text" value={fields.check_number}
                  onChange={(e) => setFields(f => ({ ...f, check_number: e.target.value }))}
                  placeholder="Número"
                  className="w-full text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2 text-theme-text focus:outline-none focus:border-theme-accent"
                />
              </div>
              <div>
                <label className="block text-[10px] text-theme-text-muted mb-1">Monto cheque</label>
                <input type="number" min={0} step={1} value={fields.check_amount}
                  onChange={(e) => setFields(f => ({ ...f, check_amount: e.target.value === '' ? '' : Number(e.target.value) }))}
                  placeholder="0"
                  className="w-full text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2 text-theme-text focus:outline-none focus:border-theme-accent font-mono"
                />
              </div>
            </div>
            <p className="text-[10px] text-theme-text-muted italic">
              Fecha de pago: pendiente de soporte en BD (próxima fase).
            </p>
          </div>
        )}

        {/* Observación */}
        <div className="col-span-2">
          <label className="block text-[10px] font-bold text-theme-text-muted uppercase tracking-wider mb-1.5">
            Observación
          </label>
          <textarea
            value={fields.notes}
            disabled={isLocked}
            onChange={(e) => setFields(f => ({ ...f, notes: e.target.value }))}
            placeholder="Observaciones opcionales..."
            rows={2}
            className="w-full text-sm bg-theme-surface border border-theme-border rounded-xl px-3 py-2.5 text-theme-text focus:outline-none focus:border-theme-accent transition-colors resize-none"
          />
        </div>

        {/* Seguimiento */}
        <div className="col-span-2 flex items-center gap-2">
          <input
            id={`rf-${item.id}`}
            type="checkbox"
            checked={fields.requires_followup}
            disabled={isLocked}
            onChange={(e) => setFields(f => ({ ...f, requires_followup: e.target.checked }))}
            className="w-4 h-4 accent-theme-accent"
          />
          <label htmlFor={`rf-${item.id}`} className="text-xs text-theme-text">
            Requiere seguimiento posterior
          </label>
        </div>

        {/* ── Sección Comprobantes ── */}
        <div className="col-span-2 pt-3 border-t border-theme-border/40">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 mb-2">
              <label className={`text-[11px] font-bold uppercase tracking-wider ${
                fields.stagedFiles.length > 0 ? 'text-amber-500' : 'text-theme-text-muted'
              }`}>
                Comprobantes
              </label>
              {loadingAttachments && <Loader2 className="w-3 h-3 animate-spin text-theme-text-muted" />}
            </div>
            {!isLocked && (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  onChange={handleFileUpload}
                  className="hidden"
                  id={`file-upload-${item.id}`}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-theme-border bg-theme-text/5 hover:bg-theme-text/10 text-xs font-semibold text-theme-text transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" /> Subir archivo
                </button>
              </div>
            )}
          </div>

          {/* Listado de adjuntos ya subidos */}
          {attachments.length > 0 && (
            <ul className="space-y-1 mb-2">
              {attachments.map(att => (
                <li key={att.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-theme-surface border border-theme-border text-xs group pointer-events-auto">
                  <button
                    onClick={() => handleOpenAttachment(att)}
                    className="flex items-center gap-2 flex-1 text-left truncate text-theme-text hover:text-theme-accent transition-colors"
                    title="Ver archivo"
                  >
                    {fileIcon(att.file_mime_type)}
                    <span className="truncate">{att.file_name}</span>
                  </button>
                  {!isLocked && (
                    <button
                      onClick={() => handleDeleteAttachment(att)}
                      className="p-1 rounded bg-red-500/10 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Eliminar"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Listado de archivos staged */}
          {fields.stagedFiles.length > 0 && (
            <ul className="space-y-1 mb-2">
              {fields.stagedFiles.map((f, idx) => (
                <li key={idx} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-amber-500/30 bg-amber-50/50 dark:bg-amber-900/10 text-xs pointer-events-auto">
                  <div className="flex items-center gap-2 truncate text-amber-800 dark:text-amber-200">
                    <Paperclip className="w-4 h-4 shrink-0" />
                    <span className="truncate">{f.name} (Pendiente)</span>
                  </div>
                  {!isLocked && (
                    <button
                      onClick={() => handleRemoveStagedFile(idx)}
                      className="p-1 rounded text-red-500 hover:bg-red-500/10 transition-colors"
                      title="Quitar"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {uploadError && <p className="text-[10px] text-red-500 mb-2">{uploadError}</p>}
        </div>

      </div>{/* fin cuerpo scroll */}

      {/* ── Footer de acciones ── */}
      {!isLocked && (
        <div className="shrink-0 p-4 border-t border-theme-border bg-theme-surface mt-auto flex justify-end gap-2">
          <button
            onClick={handleRequestClose}
            className="px-4 py-2 rounded-lg border border-theme-border text-xs font-bold text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleApply}
            disabled={savingInvoice}
            className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-theme-accent hover:bg-theme-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold transition-all shadow-lg shadow-theme-accent/20"
          >
            {savingInvoice ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Guardar factura
          </button>
        </div>
      )}

      {/* ── Modal de Previsualización ── */}
      {previewUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 lg:p-8 animate-in fade-in duration-200">
          <div className="bg-theme-surface rounded-2xl border border-theme-border flex flex-col w-full max-w-5xl h-full max-h-[90vh] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-theme-border bg-theme-surface">
              <h3 className="font-bold text-theme-text text-sm truncate">{previewUrl.name}</h3>
              <div className="flex items-center gap-2">
                <a
                  href={previewUrl.url}
                  download={previewUrl.name}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-text/5 hover:bg-theme-text/10 text-xs font-semibold text-theme-text transition-colors"
                >
                  <Download className="w-4 h-4" /> Descargar
                </a>
                <button
                  onClick={() => setPreviewUrl(null)}
                  className="p-2 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 bg-theme-surface-sunken flex items-center justify-center overflow-hidden relative">
              {previewUrl.mime?.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl.url} alt="Comprobante" className="max-w-full max-h-full object-contain p-4" />
              ) : (
                <iframe src={previewUrl.url} className="w-full h-full border-none bg-white" title="Comprobante" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
