'use client'

import React from 'react'
import { Edit, FileText, Image, Paperclip, X } from 'lucide-react'
import { RouteSettlementItem } from '../types'
import {
  formatCurrency,
  formatExpectedPaymentMethod,
  formatSettlementItemStatus,
} from '../utils/route-settlement-formatters'
import { SettlementItemAttachment } from '@/app/actions/adquisiciones/rendicion-rutas-adjuntos'

interface InvoicePreviewModalProps {
  item: RouteSettlementItem
  attachments: SettlementItemAttachment[]
  stagedFiles: File[]
  onOpenDocument: (attachmentId: string) => void
  onEdit: () => void
  onClose: () => void
}

function fileIcon(mime: string | null) {
  if (mime?.startsWith('image/')) return <Image className="w-3.5 h-3.5" />
  return <FileText className="w-3.5 h-3.5" />
}

function Field({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-bold uppercase tracking-wider text-theme-text-muted mb-0.5">{label}</p>
      <div className={`text-xs font-semibold truncate ${tone ?? 'text-theme-text'}`}>{value}</div>
    </div>
  )
}

export function InvoicePreviewModal({
  item,
  attachments,
  stagedFiles,
  onOpenDocument,
  onEdit,
  onClose,
}: InvoicePreviewModalProps) {
  const isTransfer = item.expected_payment_method === 'TRANSFER' || item.status === 'TRANSFER_CONFIRMED' || item.status === 'TRANSFER_PENDING'
  const isCheck = item.expected_payment_method === 'CHECK' || item.status === 'CHECK_RECEIVED'

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 lg:p-6 animate-in fade-in duration-150">
      <div className="w-full max-w-3xl rounded-xl border border-theme-border bg-theme-surface shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-theme-border/70 bg-theme-text/[0.02]">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-theme-text truncate">
              Factura <span className="font-mono text-theme-accent">{item.invoice_number}</span>
            </h3>
            <p className="text-[11px] text-theme-text-muted truncate">{item.customer_name}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-colors"
            >
              <Edit className="w-3.5 h-3.5" />
              Editar factura
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors"
              title="Cerrar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Monto esperado" value={formatCurrency(item.expected_amount)} />
            <Field label="Pago esperado" value={formatExpectedPaymentMethod(item.expected_payment_method)} />
            <Field label="Estado" value={formatSettlementItemStatus(item.status)} />
            <Field
              label="Monto recibido"
              value={item.received_amount > 0 ? formatCurrency(item.received_amount) : 'Sin registrar'}
              tone={item.received_amount > 0 ? 'text-green-600 dark:text-green-400' : 'text-theme-text-muted'}
            />
            <Field
              label="Diferencia"
              value={item.received_amount > 0 ? formatCurrency(item.difference_amount) : '—'}
              tone={item.difference_amount > 0 ? 'text-red-500' : 'text-theme-text-muted'}
            />
            {isTransfer && (
              <Field
                label="Transferencia"
                value={item.transfer_confirmed ? 'Confirmada' : 'Pendiente'}
                tone={item.transfer_confirmed ? 'text-green-600 dark:text-green-400' : 'text-orange-500'}
              />
            )}
            {isTransfer && <Field label="Referencia" value={item.transfer_reference || '—'} />}
            {isCheck && <Field label="Cheque" value={item.check_received ? 'Recibido' : 'Pendiente'} />}
            {isCheck && <Field label="Banco / N°" value={`${item.check_bank || '—'} / ${item.check_number || '—'}`} />}
            {isCheck && <Field label="Monto cheque" value={item.check_amount ? formatCurrency(item.check_amount) : '—'} />}
            <Field label="Seguimiento" value={item.requires_followup ? 'Requiere seguimiento' : 'No requerido'} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-lg border border-theme-border bg-theme-text/[0.02] p-3 min-h-[74px]">
              <p className="text-[9px] font-bold uppercase tracking-wider text-theme-text-muted mb-1.5">Observación</p>
              <p className="text-xs text-theme-text leading-relaxed line-clamp-3">{item.notes || 'Sin observaciones.'}</p>
            </div>
            <div className="rounded-lg border border-theme-border bg-theme-text/[0.02] p-3 min-h-[74px]">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[9px] font-bold uppercase tracking-wider text-theme-text-muted">Adjuntos</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {attachments.map(att => (
                  <button
                    key={att.id}
                    type="button"
                    onClick={() => onOpenDocument(att.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-theme-text/5 hover:bg-theme-accent/10 text-[11px] text-theme-text max-w-[180px] transition-colors"
                    title="Ver documento"
                  >
                    {fileIcon(att.file_mime_type)}
                    <span className="truncate">{att.file_name}</span>
                  </button>
                ))}
                {stagedFiles.map((file, index) => (
                  <span key={`${file.name}-${index}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-500/25 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300 max-w-[180px]">
                    <Paperclip className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{file.name} (pendiente)</span>
                  </span>
                ))}
                {attachments.length === 0 && stagedFiles.length === 0 && (
                  <span className="text-xs text-theme-text-muted">Sin adjuntos.</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
