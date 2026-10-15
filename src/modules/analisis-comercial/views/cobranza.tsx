'use client'

import { useEffect, useRef, useState } from 'react'
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { Check, ChevronLeft, Clipboard, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import type { FinanceReceivablesAnalysis } from '@/lib/control-financiero/finance-api'
import { formatReceivablesSnapshotAt, getReceivablesFreshness } from '@/lib/control-financiero/receivables-freshness'
import { applyCobranzaPaymentOverlay, buildCobranzaClients, buildCobranzaInvoices, calculateCobranzaClientKpis, calculateCobranzaInvoiceKpis, type CobranzaClient } from '../lib/cobranza-metrics'
import { buildCobranzaTasks, civilDate, effectivePriority, prioritizeCobranzaColumn, taskForClient, todayInChile, type CobranzaTask } from '../lib/cobranza-tasks'
import { CobranzaFreshnessNotice } from '../components/cobranza-freshness-notice'
import { CobranzaSnapshotControl } from '../components/cobranza-snapshot-control'
import type { ReceivablesSnapshotStatus } from '@/app/actions/comercial/cobranza-snapshot'
import { clearCollectionCommitment, getCollectionCustomerHistory, getCollectionPaymentBatchProgress, getCollectionPaymentOverlay, getCollectionWorkflow, getRecentClosedCollectionCustomers, getUnknownCollectionPaymentAttempts, listCollectionPaymentBatchProgress, prepareCollectionCustomerBatch, prepareCollectionPayment, registerCollectionCustomerBatch, registerCollectionInteraction, registerCollectionPayment, reopenCollectionCustomersWithDebt, resolveUnknownCollectionPayment, setCollectionCommitment, updateCollectionStage, type CollectionHistoryEvent, type CollectionInteractionType, type CollectionPaymentBatchProgress, type CollectionPaymentOverlay, type CollectionStage, type RecentClosedCollectionCustomer } from '@/app/actions/comercial/cobranza-workflow'

const stages: Array<{ key: CollectionStage; label: string }> = [
  { key: 'TO_MANAGE', label: 'Por gestionar' },
  { key: 'IN_PROGRESS', label: 'En gestión' },
  { key: 'PAYMENT_COMMITMENT', label: 'Compromiso de pago' },
  { key: 'FOLLOW_UP', label: 'Seguimiento' },
]

const kanbanStages: Array<{ key: CollectionStage; label: string }> = [...stages, { key: 'CLOSED', label: 'Cerrados recientes' }]

type WorkflowState = {
  stage: CollectionStage
  next_action_at?: string | null
  commitment_at?: string | null
  commitment_amount?: number | string | null
}

type StageChangeInput = {
  stage: CollectionStage
  note?: string
  commitmentAt?: string
  commitmentAmount?: number
  nextActionAt?: string
}

const money = (value: number | string | null) => {
  if (value === null) return '—'
  return `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Number(value))}`
}

const clpInput = (value: string) => value ? money(Number(value)) : ''

const dateLabel = (value: string | null) => {
  if (!value) return '—'
  const date = civilDate(value) ?? value.slice(0, 10)
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

const dateTimeLabel = (value: string) => new Intl.DateTimeFormat('es-CL', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(value))

const stageLabel = (stage: CollectionStage | null) => stages.find(option => option.key === stage)?.label ?? (stage === 'CLOSED' ? 'Cerrado' : null)

const historyTitle = (event: CollectionHistoryEvent) => {
  if (event.eventType === 'STAGE_CHANGED') return 'Cambio de etapa'
  if (event.eventType === 'COMMITMENT') {
    if (event.metadata.action === 'UPDATED') return 'Compromiso actualizado'
    if (event.metadata.action === 'CLEARED') return 'Compromiso eliminado'
    return 'Compromiso de pago registrado'
  }
  if (event.eventType === 'PAYMENT_CLOSED') return 'Cobranza cerrada'
  if (event.eventType === 'REOPENED_BY_NEW_DEBT') return 'Cobranza reabierta por nueva deuda'
  if (event.eventType === 'NOTE') return 'Nota de cobranza'
  if (event.eventType === 'CALL') return 'Llamada de cobranza'
  if (event.eventType === 'MESSAGE') return 'Mensaje / WhatsApp'
  if (event.eventType === 'EMAIL') return 'Correo de cobranza'
  return 'Gestión de cobranza'
}

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

export const buildCollectionMessage = (client: CobranzaClient) => {
  const allDocumentsOverdue = client.totalAmount === client.overdueAmount
  const documentSummary = client.documents.length <= 3
    ? ` Detalle: ${client.documents.map(document => `factura ${document.folio ?? document.document_id} por ${money(document.pending_amount)}`).join('; ')}.`
    : ''
  const documentLabel = `${client.pendingDocuments} documento${client.pendingDocuments === 1 ? '' : 's'}`
  const balanceMessage = allDocumentsOverdue
    ? `mantiene ${documentLabel} pendiente${client.pendingDocuments === 1 ? '' : 's'} de pago con la empresa CAYLO PREMIUM SPA por un total de ${money(client.totalAmount)}, actualmente vencido${client.pendingDocuments === 1 ? '' : 's'}.`
    : `mantiene ${documentLabel} pendiente${client.pendingDocuments === 1 ? '' : 's'} de pago con la empresa CAYLO PREMIUM SPA por un total de ${money(client.totalAmount)}, de los cuales ${money(client.overdueAmount)} se encuentra${client.overdueAmount === 1 ? '' : 'n'} vencido${client.overdueAmount === 1 ? '' : 's'}.`
  return `Hola ${client.name}, junto con saludar, según nuestros registros ${balanceMessage}${documentSummary} ¿Nos podría confirmar una fecha estimada de pago? Gracias.`
}

function MiniKpi({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'overdue' }) {
  return (
    <div className="min-w-0 bg-white px-2.5 py-1.5">
      <p className="truncate text-[8px] font-bold uppercase tracking-[0.1em] text-[#AC9C8D]">{label}</p>
      <p className={`mt-0.5 truncate text-sm font-semibold tabular-nums ${tone === 'overdue' ? 'text-[#8A4B4B]' : 'text-[#322D29]'}`}>{value}</p>
    </div>
  )
}

type CollectionPaymentProgressListing = Awaited<ReturnType<typeof listCollectionPaymentBatchProgress>>

const paymentBatchStatusLabel: Record<string, string> = {
  CREATED: 'En espera',
  PROCESSING: 'Procesando',
  UNKNOWN: 'Requiere revisión',
  COMPLETED: 'Completado',
  PARTIAL: 'Completado parcialmente',
  FAILED: 'No procesado',
}

const paymentBatchStatusTone: Record<string, string> = {
  CREATED: 'border-[#D1C7BD] bg-[#F5F0EA] text-[#6B625C]',
  PROCESSING: 'border-[#B38A55]/40 bg-[#F6EFE2] text-[#806238]',
  UNKNOWN: 'border-[#A45B58]/40 bg-[#F5E8E4] text-[#8A4B4B]',
  COMPLETED: 'border-[#66856B]/40 bg-[#EDF4EC] text-[#426247]',
  PARTIAL: 'border-[#B38A55]/40 bg-[#F6EFE2] text-[#806238]',
  FAILED: 'border-[#A45B58]/40 bg-[#F5E8E4] text-[#8A4B4B]',
}

const paymentDocumentTone: Record<string, string> = {
  PENDING: 'text-[#6B625C]',
  PROCESSING: 'text-[#806238]',
  CONFIRMED: 'text-[#426247]',
  REQUIRES_REVIEW: 'text-[#8A4B4B]',
  FAILED: 'text-[#8A4B4B]',
  CANCELLED: 'text-[#6B625C]',
}

function PaymentBatchCard({ batch, onSelect }: { batch: CollectionPaymentBatchProgress; onSelect: () => void }) {
  const progress = batch.expectedDocuments > 0 ? Math.round((batch.confirmedDocuments / batch.expectedDocuments) * 100) : 0
  return (
    <button type="button" onClick={onSelect} className="w-full border border-[#D1C7BD] bg-white p-3 text-left transition-colors hover:border-[#72383D] hover:bg-[#FCFBF9]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-[#322D29]">{batch.clientName}</p>
          <p className="mt-1 text-[10px] text-[#322D29]/55">{dateTimeLabel(batch.completedAt ?? batch.createdAt)}</p>
        </div>
        <span className={`shrink-0 border px-1.5 py-0.5 text-[9px] font-semibold ${paymentBatchStatusTone[batch.status] ?? paymentBatchStatusTone.UNKNOWN}`}>{paymentBatchStatusLabel[batch.status] ?? 'Requiere revisión'}</span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.08em] text-[#AC9C8D]">Total esperado</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-[#322D29]">{money(batch.expectedTotal)}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-[0.08em] text-[#AC9C8D]">Confirmado</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-[#322D29]">{money(batch.confirmedTotal)}</p>
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] text-[#322D29]/60"><span>{batch.confirmedDocuments} de {batch.expectedDocuments} facturas pagadas</span><strong>{progress}%</strong></div>
        <div className="mt-1 h-1.5 overflow-hidden bg-[#F0EAE3]"><div className="h-full bg-[#72383D] transition-[width]" style={{ width: `${progress}%` }} /></div>
      </div>
    </button>
  )
}

function PaymentProgressDetail({ batch, onBack }: { batch: CollectionPaymentBatchProgress; onBack: () => void }) {
  const documents = [...batch.documents].sort((left, right) => left.sequenceNumber - right.sequenceNumber)
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-semibold text-[#72383D] hover:underline"><ChevronLeft className="h-3.5 w-3.5" />Todos los pagos</button>
      <div className="border border-[#D1C7BD] bg-white p-3">
        <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold">{batch.clientName}</p><p className="mt-1 text-[10px] text-[#322D29]/55">{dateTimeLabel(batch.completedAt ?? batch.createdAt)}</p></div><span className={`border px-1.5 py-0.5 text-[9px] font-semibold ${paymentBatchStatusTone[batch.status] ?? paymentBatchStatusTone.UNKNOWN}`}>{paymentBatchStatusLabel[batch.status] ?? 'Requiere revisión'}</span></div>
        <div className="mt-3 grid grid-cols-2 gap-px border border-[#D1C7BD] bg-[#D1C7BD] sm:grid-cols-4">
          <div className="bg-white px-2 py-2"><p className="text-[9px] uppercase text-[#AC9C8D]">Esperado</p><p className="mt-1 text-xs font-semibold tabular-nums">{money(batch.expectedTotal)}</p></div>
          <div className="bg-white px-2 py-2"><p className="text-[9px] uppercase text-[#AC9C8D]">Confirmado</p><p className="mt-1 text-xs font-semibold tabular-nums">{money(batch.confirmedTotal)}</p></div>
          <div className="bg-white px-2 py-2"><p className="text-[9px] uppercase text-[#AC9C8D]">Facturas</p><p className="mt-1 text-xs font-semibold tabular-nums">{batch.confirmedDocuments} / {batch.expectedDocuments}</p></div>
          <div className="bg-white px-2 py-2"><p className="text-[9px] uppercase text-[#AC9C8D]">Fecha</p><p className="mt-1 text-xs font-semibold">{dateTimeLabel(batch.completedAt ?? batch.createdAt)}</p></div>
        </div>
        {batch.requiresReview && <div className="mt-3 border border-[#A45B58]/35 bg-[#F5E8E4] px-3 py-2 text-[11px] text-[#8A4B4B]"><p className="font-semibold">Este procesamiento requiere revisión antes de continuar.</p><p className="mt-1">Revisa el estado de la factura antes de continuar.</p></div>}
      </div>
      <section className="border border-[#D1C7BD] bg-white">
        <div className="border-b border-[#D1C7BD] bg-[#F5F0EA] px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#72383D]">Documentos</p></div>
        <div className="divide-y divide-[#D1C7BD]/70">
          {documents.map(document => <div key={document.attemptId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-3 text-xs"><div><p className="font-semibold">Factura {document.folio ?? document.documentId}</p><p className="mt-1 text-[10px] text-[#322D29]/50">Documento {document.documentId}</p></div><span className="tabular-nums">{money(document.amount)}</span><span className={`text-right text-[10px] font-semibold ${paymentDocumentTone[document.visualStatus] ?? paymentDocumentTone.REQUIRES_REVIEW}`}>{document.message}</span></div>)}
        </div>
      </section>
    </div>
  )
}

function PaymentProgressSheet({ open, onOpenChange, listing, loading, error, selectedBatch, detailLoading, onRefresh, onSelectBatch, onBack }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  listing: CollectionPaymentProgressListing | null
  loading: boolean
  error: string | null
  selectedBatch: CollectionPaymentBatchProgress | null
  detailLoading: boolean
  onRefresh: () => void
  onSelectBatch: (batchId: string) => void
  onBack: () => void
}) {
  const renderSection = (title: string, rows: CollectionPaymentBatchProgress[]) => rows.length > 0 && <section><div className="mb-2 flex items-center justify-between"><h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#72383D]">{title}</h3><span className="text-[10px] text-[#322D29]/50">{rows.length}</span></div><div className="space-y-2">{rows.map(batch => <PaymentBatchCard key={batch.batchId} batch={batch} onSelect={() => onSelectBatch(batch.batchId)} />)}</div></section>
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex h-screen w-full flex-col overflow-hidden border-[#D1C7BD] bg-[#EFE9E1] p-0 text-[#322D29] sm:!w-[560px] sm:!max-w-[560px]">
        <SheetHeader className="shrink-0 border-b border-[#D1C7BD] bg-white px-5 py-4 pr-12 text-left"><div className="flex items-start justify-between gap-3"><div><SheetTitle>Procesamiento de pagos</SheetTitle><SheetDescription>Seguimiento sólo lectura de pagos en segundo plano.</SheetDescription></div><button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-1 border border-[#D1C7BD] px-2 py-1 text-[10px] font-semibold text-[#72383D] hover:bg-[#F5EDE9] disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />Actualizar</button></div></SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="mb-3 border border-[#A45B58]/30 bg-[#F5E8E4] px-3 py-2 text-[11px] text-[#8A4B4B]">No se pudo actualizar el estado de pagos.</p>}
          {detailLoading && <p className="mb-3 text-[10px] text-[#322D29]/50">Cargando detalle…</p>}
          {selectedBatch ? <PaymentProgressDetail batch={selectedBatch} onBack={onBack} /> : listing && <div className="space-y-5">{renderSection('En proceso', listing.batches.active)}{renderSection('Requieren revisión', listing.batches.requiresReview)}{renderSection('Recientes', listing.batches.recent)}{listing.batches.active.length + listing.batches.requiresReview.length + listing.batches.recent.length === 0 && <p className="border border-[#D1C7BD] bg-white px-3 py-6 text-center text-xs text-[#322D29]/55">No hay pagos en procesamiento.</p>}</div>}
          {!listing && !loading && !error && <p className="border border-[#D1C7BD] bg-white px-3 py-6 text-center text-xs text-[#322D29]/55">No hay pagos en procesamiento.</p>}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function PaymentProgressObserver() {
  const [listing, setListing] = useState<CollectionPaymentProgressListing | null>(null)
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null)
  const [selectedBatch, setSelectedBatch] = useState<CollectionPaymentBatchProgress | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadingRef = useRef(false)

  const refreshProgress = async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const nextListing = await listCollectionPaymentBatchProgress()
      setListing(nextListing)
      setError(null)
      if (selectedBatchId) {
        setDetailLoading(true)
        try {
          setSelectedBatch(await getCollectionPaymentBatchProgress(selectedBatchId))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'No se pudo cargar el estado de pagos.')
        } finally {
          setDetailLoading(false)
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo actualizar el estado de pagos.')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }

  useEffect(() => { void refreshProgress() }, [])

  useEffect(() => {
    const detailIsActive = selectedBatch && ['CREATED', 'PROCESSING', 'UNKNOWN'].includes(selectedBatch.status)
    if (!listing || (!(listing.activeCount > 0 || listing.requiresReviewCount > 0) && !detailIsActive)) return
    const timer = window.setInterval(() => { void refreshProgress() }, 5000)
    return () => window.clearInterval(timer)
  }, [listing?.activeCount, listing?.requiresReviewCount, selectedBatchId, selectedBatch?.status])

  const openProgress = () => {
    setOpen(true)
    if (!listing || error) void refreshProgress()
  }
  const selectBatch = async (batchId: string) => {
    setSelectedBatchId(batchId)
    setSelectedBatch(null)
    setDetailLoading(true)
    setError(null)
    try {
      setSelectedBatch(await getCollectionPaymentBatchProgress(batchId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo cargar el estado de pagos.')
    } finally {
      setDetailLoading(false)
    }
  }
  const backToList = () => {
    setSelectedBatchId(null)
    setSelectedBatch(null)
    setError(null)
  }
  const activeCount = listing?.activeCount ?? 0
  const requiresReviewCount = listing?.requiresReviewCount ?? 0
  return <>
    <div className="grid grid-cols-2 gap-1.5" data-payment-progress-observer>
      <button type="button" onClick={openProgress} className={`min-w-0 border px-2 py-1 text-left ${activeCount > 0 ? 'border-[#B38A55]/50 bg-[#F6EFE2] text-[#806238] hover:border-[#72383D]' : 'border-[#D1C7BD] bg-white text-[#322D29]/65'}`}><span className="block truncate text-[10px] font-semibold">Pagos en proceso: <strong>{activeCount}</strong></span></button>
      <button type="button" onClick={openProgress} className={`min-w-0 border px-2 py-1 text-left ${requiresReviewCount > 0 ? 'border-[#A45B58]/60 bg-[#F5E8E4] text-[#8A4B4B] hover:border-[#72383D]' : 'border-[#D1C7BD] bg-white text-[#322D29]/65'}`}><span className="block truncate text-[10px] font-semibold">Requieren revisión: <strong>{requiresReviewCount}</strong></span></button>
    </div>
    <PaymentProgressSheet open={open} onOpenChange={setOpen} listing={listing} loading={loading} error={error} selectedBatch={selectedBatch} detailLoading={detailLoading} onRefresh={() => void refreshProgress()} onSelectBatch={batchId => void selectBatch(batchId)} onBack={backToList} />
  </>
}

function Priority({ value }: { value: CobranzaClient['priority'] }) {
  const styles = value === 'Alta'
    ? 'border-[#A45B58]/30 bg-[#F5E8E4] text-[#8A4B4B]'
    : value === 'Media'
      ? 'border-[#B38A55]/30 bg-[#F6EFE2] text-[#806238]'
      : 'border-[#AC9C8D]/30 bg-[#F5F0EA] text-[#6B625C]'
  return <span className={`inline-flex border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ${styles}`}>{value}</span>
}

function StagePicker({ stage, onChange }: { stage: CollectionStage; onChange: (stage: CollectionStage) => void }) {
  const [open, setOpen] = useState(false)
  const selected = stages.find(option => option.key === stage) ?? stages[0]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" className="mt-2 flex h-9 w-full items-center justify-between border border-[#D1C7BD] bg-white px-2 text-left text-xs hover:border-[#72383D]" />}>
        <span>{selected.label}</span><span className="text-[#322D29]/45">⌄</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[calc(100vw-3rem)] max-w-[500px] border border-[#D1C7BD] bg-white p-1 shadow-lg">
        {stages.map(option => <button key={option.key} type="button" onClick={() => { setOpen(false); onChange(option.key) }} className={`block w-full px-2.5 py-2 text-left text-xs hover:bg-[#F5F0EA] ${option.key === stage ? 'font-semibold text-[#72383D]' : 'text-[#322D29]'}`}>{option.label}</button>)}
      </PopoverContent>
    </Popover>
  )
}

function CollectionStageDialog({
  open,
  clientName,
  clientTotal,
  currentStage,
  nextStage,
  onOpenChange,
  onSave,
}: {
  open: boolean
  clientName: string
  clientTotal: number
  currentStage: CollectionStage
  nextStage: CollectionStage | null
  onOpenChange: (open: boolean) => void
  onSave: (input: StageChangeInput) => Promise<void>
}) {
  const [commitmentAt, setCommitmentAt] = useState('')
  const [commitmentAmount, setCommitmentAmount] = useState('')
  const [nextActionAt, setNextActionAt] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  const confirm = async () => {
    if (!nextStage || processing) return
    if (nextStage === 'PAYMENT_COMMITMENT') {
      const amount = commitmentAmount === '' ? null : Number(commitmentAmount)
      if (!commitmentAt) {
        setError('Ingresa una fecha de compromiso.')
        return
      }
      if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
        setError('El monto comprometido debe ser mayor que cero.')
        return
      }
      if (amount !== null && amount > clientTotal) {
        setError(`El monto no puede superar la deuda pendiente de ${money(clientTotal)}.`)
        return
      }
    }
    if (nextStage === 'FOLLOW_UP' && !nextActionAt) {
      setError('Ingresa la fecha próxima de seguimiento.')
      return
    }
    setProcessing(true)
    setError(null)
    try {
      await onSave({
        stage: nextStage,
        note,
        commitmentAt: nextStage === 'PAYMENT_COMMITMENT' ? commitmentAt : undefined,
        commitmentAmount: nextStage === 'PAYMENT_COMMITMENT' && commitmentAmount !== '' ? Number(commitmentAmount) : undefined,
        nextActionAt: nextStage === 'FOLLOW_UP' ? nextActionAt : undefined,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar la etapa.')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!value && !processing) onOpenChange(false) }}>
      <DialogContent className="border-[#D1C7BD] bg-[#FCFBF9] text-[#322D29]">
        <DialogHeader>
          <DialogTitle>Actualizar etapa de cobranza</DialogTitle>
          <DialogDescription>{clientName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs"><strong>Etapa actual:</strong> {stageLabel(currentStage)}</p>
          <p className="text-xs"><strong>Nueva etapa:</strong> {stageLabel(nextStage)}</p>
          {nextStage === 'PAYMENT_COMMITMENT' && <>
            <label className="block text-xs font-semibold">Fecha comprometida *<input type="date" value={commitmentAt} onChange={event => setCommitmentAt(event.target.value)} disabled={processing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs" /></label>
            <label className="block text-xs font-semibold">Monto comprometido <span className="font-normal text-[#322D29]/50">(opcional)</span><input type="number" min="1" value={commitmentAmount} onChange={event => setCommitmentAmount(event.target.value)} disabled={processing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs" /></label>
            <p className="text-[10px] text-[#322D29]/55">Máximo permitido: {money(clientTotal)}</p>
          </>}
          {nextStage === 'FOLLOW_UP' && <label className="block text-xs font-semibold">Próxima fecha de gestión *<input type="date" value={nextActionAt} onChange={event => setNextActionAt(event.target.value)} disabled={processing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs" /></label>}
          <label className="block text-xs font-semibold">Comentario / nota de gestión <span className="font-normal text-[#322D29]/50">(opcional)</span><textarea value={note} onChange={event => setNote(event.target.value)} disabled={processing} rows={3} className="mt-1 w-full resize-none border border-[#D1C7BD] bg-white p-2 text-xs" /></label>
          {error && <p className="text-xs text-[#8A4B4B]">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={processing} onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="button" disabled={processing} onClick={() => void confirm()}>{processing ? 'Guardando cambio…' : 'Guardar cambio'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CommitmentDialog({
  open,
  clientName,
  clientTotal,
  workflow,
  onOpenChange,
  onSave,
  onClear,
}: {
  open: boolean
  clientName: string
  clientTotal: number
  workflow?: WorkflowState
  onOpenChange: (open: boolean) => void
  onSave: (input: { commitmentAt: string; commitmentAmount?: number; note?: string }) => Promise<void>
  onClear: () => Promise<void>
}) {
  const [commitmentAt, setCommitmentAt] = useState(workflow?.commitment_at?.slice(0, 10) ?? '')
  const [commitmentAmount, setCommitmentAmount] = useState(workflow?.commitment_amount === null || workflow?.commitment_amount === undefined ? '' : String(workflow.commitment_amount))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const hasCommitment = Boolean(workflow?.commitment_at)

  const save = async () => {
    if (processing) return
    const amount = commitmentAmount === '' ? undefined : Number(commitmentAmount)
    if (!commitmentAt) {
      setError('Ingresa una fecha de compromiso.')
      return
    }
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
      setError('El monto comprometido debe ser mayor que cero.')
      return
    }
    if (amount !== undefined && amount > clientTotal) {
      setError(`El monto no puede superar la deuda pendiente de ${money(clientTotal)}.`)
      return
    }
    setProcessing(true)
    setError(null)
    try {
      await onSave({ commitmentAt, commitmentAmount: amount, note })
      setNote('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar el compromiso.')
    } finally {
      setProcessing(false)
    }
  }

  const clear = async () => {
    if (processing || !window.confirm('¿Quitar el compromiso vigente?')) return
    setProcessing(true)
    setError(null)
    try {
      await onClear()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo quitar el compromiso.')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!value && !processing) onOpenChange(false) }}>
      <DialogContent className="border-[#D1C7BD] bg-[#FCFBF9] text-[#322D29]">
        <DialogHeader>
          <DialogTitle>{hasCommitment ? 'Editar compromiso' : 'Fecha compromiso'}</DialogTitle>
          <DialogDescription>{clientName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-xs font-semibold">Fecha de compromiso *<input type="date" value={commitmentAt} onChange={event => setCommitmentAt(event.target.value)} disabled={processing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs" /></label>
          <label className="block text-xs font-semibold">Monto comprometido <span className="font-normal text-[#322D29]/50">(opcional)</span><input type="number" min="1" value={commitmentAmount} onChange={event => setCommitmentAmount(event.target.value)} disabled={processing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs" /></label>
          <p className="text-[10px] text-[#322D29]/55">Máximo permitido: {money(clientTotal)}</p>
          <label className="block text-xs font-semibold">Comentario / nota <span className="font-normal text-[#322D29]/50">(opcional)</span><textarea value={note} onChange={event => setNote(event.target.value)} disabled={processing} rows={3} maxLength={2000} className="mt-1 w-full resize-none border border-[#D1C7BD] bg-white p-2 text-xs" /></label>
          {error && <p className="text-xs text-[#8A4B4B]">{error}</p>}
        </div>
        <DialogFooter className="flex-wrap sm:justify-between">
          <div>{hasCommitment && <Button type="button" variant="outline" disabled={processing} onClick={() => void clear()} className="border-[#A45B58]/50 text-[#8A4B4B]">Quitar compromiso</Button>}</div>
          <div className="flex gap-2"><Button type="button" variant="outline" disabled={processing} onClick={() => onOpenChange(false)}>Cancelar</Button><Button type="button" disabled={processing} onClick={() => void save()}>{processing ? 'Guardando…' : hasCommitment ? 'Guardar cambios' : 'Guardar compromiso'}</Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function QuickInteractionDialog({
  open,
  clientName,
  onOpenChange,
  onSave,
}: {
  open: boolean
  clientName: string
  onOpenChange: (open: boolean) => void
  onSave: (input: { type: CollectionInteractionType; body: string }) => Promise<void>
}) {
  const [type, setType] = useState<CollectionInteractionType>('NOTE')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  const save = async () => {
    if (processing) return
    setProcessing(true)
    setError(null)
    try {
      await onSave({ type, body })
      setType('NOTE')
      setBody('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar la nota.')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!value && !processing) onOpenChange(false) }}>
      <DialogContent className="border-[#D1C7BD] bg-[#FCFBF9] text-[#322D29]">
        <DialogHeader>
          <DialogTitle>Agregar nota</DialogTitle>
          <DialogDescription>{clientName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-xs font-semibold">Tipo<select value={type} onChange={event => setType(event.target.value as CollectionInteractionType)} disabled={processing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs"><option value="NOTE">Nota</option><option value="CALL">Llamada</option><option value="MESSAGE">Mensaje / WhatsApp</option><option value="EMAIL">Correo</option></select></label>
          <label className="block text-xs font-semibold">Descripción<textarea required maxLength={2000} value={body} onChange={event => setBody(event.target.value)} disabled={processing} rows={4} className="mt-1 w-full resize-none border border-[#D1C7BD] bg-white p-2 text-xs" /></label>
          {error && <p className="text-xs text-[#8A4B4B]">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={processing} onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button type="button" disabled={processing} onClick={() => void save()}>{processing ? 'Guardando nota…' : 'Guardar nota'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const taskTypeLabel = (type: CobranzaTask['type']) => type === 'COMMITMENT' ? 'Compromiso' : 'Seguimiento'
const taskShortDate = (value: string) => { const [, month, day] = (civilDate(value) ?? value.slice(0, 10)).split('-'); return `${day}/${month}` }
const taskStatusLabel = (task: CobranzaTask) => task.urgency === 'OVERDUE' ? 'Vencido' : 'Hoy'
const taskMetaLabel = (task: CobranzaTask) => {
  const amount = task.amount !== null ? money(task.amount) : ''
  return task.urgency === 'OVERDUE' ? [taskShortDate(task.date), amount].filter(Boolean).join(' · ') : amount
}

function PendingTasksPanel({ tasks, selectedTaskId, onSelectTask, onOpenClient }: {
  tasks: CobranzaTask[]
  selectedTaskId: string | null
  onSelectTask: (task: CobranzaTask) => void
  onOpenClient: (clientId: number) => void
}) {
  const selected = tasks.find(task => task.id === selectedTaskId) ?? null
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-[#EAE2D9] px-3 py-1">
        <h2 className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#72383D]">Tareas pendientes</h2>
        <span className="text-[10px] font-semibold text-[#322D29]/60">{tasks.length}</span>
      </div>
      <div className="h-[130px] overflow-y-auto" role="list">
        {tasks.length === 0
          ? <p className="px-3 py-3 text-[10px] text-[#322D29]/50">No hay tareas pendientes para hoy.</p>
          : tasks.map(task => {
            const isSelected = task.id === selectedTaskId
            const overdue = task.urgency === 'OVERDUE'
            return <button key={task.id} type="button" role="listitem" onClick={() => onSelectTask(task)} className={`grid h-[26px] w-full grid-cols-[10px_minmax(0,1fr)_auto_auto] items-center gap-2 border-l-2 px-3 text-left text-[11px] leading-none ${isSelected ? 'border-l-[#72383D] bg-[#F6EFE8]' : 'border-l-transparent hover:bg-[#FCFBF9]'}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${overdue ? 'bg-[#A45B58]' : 'bg-[#B38A55]'}`} />
              <span className="truncate text-[#322D29]">{task.clientName}</span>
              <span className="whitespace-nowrap text-[10px] tabular-nums text-[#322D29]/60">{taskMetaLabel(task)}</span>
              <span className={`border px-1 py-px text-[9px] font-semibold ${overdue ? 'border-[#A45B58]/30 bg-[#F5E8E4] text-[#8A4B4B]' : 'border-[#B38A55]/30 bg-[#F6EFE2] text-[#806238]'}`}>{taskStatusLabel(task)}</span>
            </button>
          })}
      </div>
      <div className="flex min-h-[36px] items-center border-t border-[#EAE2D9] px-3 py-1">
        {selected
          ? <div className="flex w-full min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] font-semibold text-[#322D29]">{selected.clientName}</span>
            <span className="hidden min-w-0 truncate text-[10px] text-[#806238] sm:inline">{taskTypeLabel(selected.type)} {selected.urgency === 'OVERDUE' ? `vencido ${taskShortDate(selected.date)}` : 'hoy'}{selected.amount !== null ? ` · ${money(selected.amount)}` : ''}</span>
            <button type="button" onClick={() => onOpenClient(selected.clientId)} className="shrink-0 border border-[#72383D]/30 px-2 py-0.5 text-[10px] font-semibold text-[#72383D] hover:bg-[#F5EDE9]">Abrir cliente</button>
          </div>
          : <p className="text-[10px] text-[#322D29]/45">Selecciona una tarea para ver el detalle.</p>}
      </div>
    </div>
  )
}

function ClientKanbanCard({
  client,
  stage,
  workflow,
  onOpen,
  onAddNote,
  onCommitment,
  task,
  locate = false,
  isOverlay = false,
}: {
  client: CobranzaClient
  stage: CollectionStage
  workflow?: WorkflowState
  onOpen: () => void
  onAddNote: () => void
  onCommitment: () => void
  task?: CobranzaTask | null
  locate?: boolean
  isOverlay?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `collection-client-${client.clientId}`,
    data: { clientId: client.clientId, stage },
    disabled: isOverlay,
  })
  const style = transform && !isOverlay ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
  const taskTone = task?.urgency === 'OVERDUE' ? 'border-[#A45B58]/60 bg-[#FCF7F5]' : task?.urgency === 'TODAY' ? 'border-[#B38A55]/60 bg-[#FFFCF6]' : 'border-[#D1C7BD] bg-white'
  const locateTone = locate && !isOverlay ? 'ring-2 ring-[#72383D] cobranza-locate' : ''
  const className = `w-full border p-2.5 text-left transition-shadow ${taskTone} ${locateTone} ${isOverlay ? 'pointer-events-none shadow-xl ring-2 ring-[#72383D]' : isDragging ? 'cursor-grabbing opacity-45 shadow-lg' : 'cursor-grab hover:border-[#72383D] hover:shadow-sm'}`
  const copyMessage = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    await navigator.clipboard.writeText(buildCollectionMessage(client))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }
  const stopCardInteraction = (event: React.SyntheticEvent) => event.stopPropagation()
  return (
    <div id={isOverlay ? undefined : `collection-card-${client.clientId}`} ref={isOverlay ? undefined : setNodeRef} style={style} {...(!isOverlay ? listeners : {})} {...(!isOverlay ? attributes : {})} onDoubleClick={isOverlay ? undefined : onOpen} onKeyDown={isOverlay ? undefined : event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }} role="button" tabIndex={0} aria-label={`Abrir detalle de ${client.name}`} className={className}>
      <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words text-xs font-semibold">{client.name}</span><Priority value={effectivePriority(client.priority, task)} /></div>
      {task && <p className={`mt-1 text-[9px] font-semibold ${task.urgency === 'OVERDUE' ? 'text-[#8A4B4B]' : 'text-[#806238]'}`}>{taskTypeLabel(task.type)} {task.urgency === 'OVERDUE' ? 'vencido' : 'hoy'}</p>}
      <p className="mt-2 text-[10px] text-[#322D29]/55">{client.pendingDocuments} doc{client.pendingDocuments === 1 ? '' : 's'} · {client.oldestDaysOverdue} días</p>
      <p className={`mt-1 text-sm font-semibold tabular-nums ${stage === 'CLOSED' ? 'text-[#322D29]' : 'text-[#8A4B4B]'}`}>{stage === 'CLOSED' ? '$0 · Pagado' : `Vencida ${money(client.overdueAmount)}`}</p>
      {stage !== 'CLOSED' && client.totalAmount !== client.overdueAmount && <p className="mt-0.5 text-[10px] text-[#322D29]/55 tabular-nums">Total {money(client.totalAmount)}</p>}
       {workflow?.commitment_at && <p className="mt-2 text-[10px] text-[#806238]">Compromiso {dateLabel(workflow.commitment_at)}{workflow.commitment_amount !== null && workflow.commitment_amount !== undefined ? ` · ${money(workflow.commitment_amount)}` : ''}</p>}
      {stage === 'FOLLOW_UP' && workflow?.next_action_at && <p className="mt-2 text-[10px] text-[#806238]">Seguimiento {dateLabel(workflow.next_action_at)}</p>}
      {!isOverlay && <div className="mt-2 flex flex-wrap gap-1 border-t border-[#D1C7BD]/70 pt-2">
         <button type="button" onPointerDown={stopCardInteraction} onClick={copyMessage} className="min-w-[84px] flex-1 border border-[#72383D]/25 px-1.5 py-1 text-[9px] font-semibold text-[#72383D] hover:bg-[#F5EDE9]">{copied ? 'Mensaje copiado' : 'Copiar mensaje'}</button>
          <button type="button" onPointerDown={stopCardInteraction} onClick={event => { event.stopPropagation(); onAddNote() }} className="min-w-[84px] flex-1 border border-[#D1C7BD] px-1.5 py-1 text-[9px] font-semibold text-[#322D29] hover:bg-[#F5F0EA]">Agregar nota</button>
          <button type="button" onPointerDown={stopCardInteraction} onClick={event => { event.stopPropagation(); onCommitment() }} className="min-w-[84px] flex-1 border border-[#B38A55]/50 px-1.5 py-1 text-[9px] font-semibold text-[#806238] hover:bg-[#F6EFE2]">{workflow?.commitment_at ? 'Editar compromiso' : 'Fecha compromiso'}</button>
             </div>}
     </div>
  )
}

function ClientKanbanColumn({
  stage,
  clients,
  workflow,
  tasks,
  today,
  selectedClientId,
  onOpen,
  onAddNote,
  onCommitment,
  closedRecent = [],
  onOpenClosed,
}: {
  stage: { key: CollectionStage; label: string }
  clients: CobranzaClient[]
  workflow: Record<number, WorkflowState>
  tasks: CobranzaTask[]
  today: string
  selectedClientId?: number | null
  onOpen: (client: CobranzaClient) => void
  onAddNote: (client: CobranzaClient) => void
  onCommitment: (client: CobranzaClient) => void
  closedRecent?: RecentClosedCollectionCustomer[]
  onOpenClosed?: (client: RecentClosedCollectionCustomer) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `collection-stage-${stage.key}`, data: { stage: stage.key }, disabled: stage.key === 'CLOSED' })
  const orderedClients = prioritizeCobranzaColumn(clients, workflow, today)
  return (
    <section ref={setNodeRef} className={`min-w-0 border bg-[#F5F0EA] transition-colors ${isOver && stage.key !== 'CLOSED' ? 'border-[#72383D] bg-[#F1E4DD]' : 'border-[#D1C7BD]'}`}>
       <header className="border-b border-[#D1C7BD] px-3 py-2"><div className="flex items-center justify-between"><h3 className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#72383D]">{stage.label}</h3><span className="text-[10px] text-[#322D29]/50">{stage.key === 'CLOSED' ? closedRecent.length : clients.length}</span></div></header>
       <div className="space-y-2 p-2">
         {stage.key === 'CLOSED'
           ? closedRecent.map(client => <button key={client.clientId} type="button" onClick={() => onOpenClosed?.(client)} className="w-full border border-[#D1C7BD] bg-white p-2.5 text-left hover:border-[#72383D]"><span className="block break-words text-xs font-semibold">{client.name}</span><span className="mt-2 block text-[10px] text-[#322D29]/65">Saldo $0</span><span className="mt-1 block text-[10px] text-[#322D29]/55">Cerrado {dateTimeLabel(client.closedAt)}</span><span className="mt-2 block border-t border-[#D1C7BD]/70 pt-2 text-[9px] font-semibold text-[#72383D]">Ver bitácora</span></button>)
             : orderedClients.map(client => <ClientKanbanCard key={client.key} client={client} stage={stage.key} workflow={workflow[client.clientId]} task={taskForClient(client.clientId, tasks)} locate={client.clientId === selectedClientId} onOpen={() => onOpen(client)} onAddNote={() => onAddNote(client)} onCommitment={() => onCommitment(client)} />)}
         {((stage.key === 'CLOSED' ? closedRecent.length : clients.length) === 0) && <p className="px-2 py-5 text-center text-[10px] text-[#322D29]/45">Sin clientes</p>}
       </div>
    </section>
  )
}

function ClientPanel({
  client,
  cutoffDate,
  stage,
  focusedDocumentId,
  historicalClosed,
  onPaymentReconciled,
  onStageChange,
  onClose,
}: {
  client: CobranzaClient
  cutoffDate: string
  stage: CollectionStage
  focusedDocumentId?: number | null
  historicalClosed?: RecentClosedCollectionCustomer | null
  onPaymentReconciled?: (documentId: number, documentBalance: number, clientBalance: number) => void
  onStageChange: (input: StageChangeInput) => Promise<void>
  onClose: () => void
}) {
  const isHistoricalClosed = Boolean(historicalClosed)
  const [copied, setCopied] = useState(false)
  const [paymentPreview, setPaymentPreview] = useState<{ documentId: number; amount: string; liveBalance: number; snapshotBalance: number; paymentTypes: Array<{ id: number; label: string; name: string }>; paymentTypeId: number | null; recordDate: string } | null>(null)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [paymentProcessing, setPaymentProcessing] = useState(false)
  const [paymentStatus, setPaymentStatus] = useState<'IDLE' | 'SUCCESS' | 'UNKNOWN' | 'FAILED'>('IDLE')
  const [paymentResult, setPaymentResult] = useState<{ documentBalance: number; clientBalance: number } | null>(null)
  const [paymentMode, setPaymentMode] = useState<'TOTAL' | 'PARTIAL'>('TOTAL')
  const [partialAmount, setPartialAmount] = useState('')
  const [preflightDocumentId, setPreflightDocumentId] = useState<number | null>(null)
  const [batchPreview, setBatchPreview] = useState<{ documents: Array<{ documentId: number; folio: number | string | null; balance: number }>; total: number; paymentTypes: Array<{ id: number; label: string; name: string }> ; paymentTypeId: number | null } | null>(null)
  const [batchPreparing, setBatchPreparing] = useState(false)
  const [batchProcessing, setBatchProcessing] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [batchResult, setBatchResult] = useState<{ status: string; expectedTotal: number; confirmedTotal: number; failed: number; unknown: number; results: Array<{ documentId: number; folio: number | string | null; amount: number; status: 'CONFIRMED' | 'FAILED' | 'UNKNOWN'; message?: string }> } | null>(null)
  const [pendingStage, setPendingStage] = useState<CollectionStage | null>(null)
  const [interactionOpen, setInteractionOpen] = useState(false)
  const [interactionType, setInteractionType] = useState<CollectionInteractionType>('NOTE')
  const [interactionBody, setInteractionBody] = useState('')
  const [interactionError, setInteractionError] = useState<string | null>(null)
  const [interactionProcessing, setInteractionProcessing] = useState(false)
  const [history, setHistory] = useState<CollectionHistoryEvent[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [unknownAttempts, setUnknownAttempts] = useState<Array<{ id: string; documentId: number; status: string }>>([])
  const [unknownBusyId, setUnknownBusyId] = useState<string | null>(null)
  const [unknownResolution, setUnknownResolution] = useState<Record<number, { outcome: string; message: string }>>({})
  const pendingDocuments = client.documents.filter(document => Number(document.pending_amount) > 0)
  const message = buildCollectionMessage(client)

  const copyMessage = async () => {
    await navigator.clipboard.writeText(message)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  const paymentBusy = preflightDocumentId !== null || Boolean(paymentPreview) || paymentProcessing || batchPreparing || batchProcessing || unknownBusyId !== null

  useEffect(() => {
    let cancelled = false
    getCollectionCustomerHistory(client.clientId).then(result => {
      if (cancelled) return
      setHistory(result.events)
      setHistoryHasMore(result.hasMore)
    }).catch(cause => {
      if (!cancelled) setHistoryError(cause instanceof Error ? cause.message : 'No se pudo cargar la bitácora.')
    }).finally(() => {
      if (!cancelled) setHistoryLoading(false)
    })
    return () => { cancelled = true }
  }, [client.clientId])

  useEffect(() => {
    let cancelled = false
    getUnknownCollectionPaymentAttempts(client.clientId).then(result => {
      if (!cancelled) setUnknownAttempts(result)
    }).catch(() => {
      if (!cancelled) setUnknownAttempts([])
    })
    return () => { cancelled = true }
  }, [client.clientId])

  const refreshHistory = async (limit = historyExpanded ? 100 : 20) => {
    try {
      const result = await getCollectionCustomerHistory(client.clientId, limit)
      setHistory(result.events)
      setHistoryHasMore(result.hasMore)
      setHistoryError(null)
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : 'No se pudo actualizar la bitácora.')
    }
  }

  const verifyUnknown = async (attempt: { id: string; documentId: number }) => {
    if (unknownBusyId) return
    setUnknownBusyId(attempt.id)
    try {
      const result = await resolveUnknownCollectionPayment({ attemptId: attempt.id })
      setUnknownResolution(current => ({ ...current, [attempt.documentId]: { outcome: result.outcome, message: result.message ?? (result.outcome === 'CONFIRMED' ? 'Pago confirmado y reconciliado en Bsale.' : '') } }))
      if (result.outcome === 'CONFIRMED') {
        setUnknownAttempts(current => current.filter(item => item.id !== attempt.id))
        onPaymentReconciled?.(attempt.documentId, result.documentBalance, result.clientBalance)
      } else if (result.outcome === 'FAILED') {
        setUnknownAttempts(current => current.filter(item => item.id !== attempt.id))
      }
    } catch (cause) {
      setUnknownResolution(current => ({ ...current, [attempt.documentId]: { outcome: 'UNKNOWN', message: cause instanceof Error ? cause.message : 'No se pudo verificar el pago en Bsale.' } }))
    } finally {
      setUnknownBusyId(null)
    }
  }

  const previewPayment = async (documentId: number, amount: string) => {
    if (paymentBusy) return
    setPaymentError(null)
    setPaymentStatus('IDLE')
    setPaymentResult(null)
    setPaymentMode('TOTAL')
    setPartialAmount('')
    setPreflightDocumentId(documentId)
    try {
      const result = await prepareCollectionPayment({ documentId, amount: Number(amount) })
       const defaultType = result.paymentTypes.find(type => type.label.toUpperCase() === 'TRANSFERENCIA') ?? result.paymentTypes[0]
       setPaymentPreview({ documentId, amount: String(result.liveBalance), liveBalance: result.liveBalance, snapshotBalance: result.snapshotBalance, paymentTypes: result.paymentTypes, paymentTypeId: defaultType?.id ?? null, recordDate: result.recordDate })
    } catch (cause) {
      setPaymentError(cause instanceof Error ? cause.message : 'No se pudo consultar Bsale.')
    } finally {
      setPreflightDocumentId(null)
    }
  }

  const confirmPayment = async () => {
    if (!paymentPreview) return
    setPaymentProcessing(true)
    setPaymentStatus('IDLE')
    setPaymentError(null)
    try {
      const amount = paymentMode === 'TOTAL' ? paymentPreview.liveBalance : Number(partialAmount)
      if (!Number.isFinite(amount) || amount <= 0 || amount > paymentPreview.liveBalance) {
        setPaymentStatus('FAILED')
        setPaymentError(`Ingresa un monto entre ${money(1)} y ${money(paymentPreview.liveBalance)}.`)
        return
      }
       if (!paymentPreview.paymentTypeId) {
         setPaymentStatus('FAILED')
         setPaymentError('Selecciona una forma de pago para continuar.')
         return
       }
       const result = await registerCollectionPayment({ documentId: paymentPreview.documentId, amount, paymentTypeId: paymentPreview.paymentTypeId, clientId: client.clientId, recordDate: paymentPreview.recordDate })
      setPaymentResult({ documentBalance: result.documentBalance, clientBalance: result.clientBalance })
      onPaymentReconciled?.(paymentPreview.documentId, result.documentBalance, result.clientBalance)
      setPaymentStatus('SUCCESS')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'No se pudo registrar el pago.'
      const uncertain = /unknown|timeout|network|revisión|pudo haberse creado/i.test(message)
      setPaymentStatus(uncertain ? 'UNKNOWN' : 'FAILED')
      setPaymentError(uncertain ? 'El pago pudo haberse creado en Bsale y requiere revisión. No reintentes automáticamente.' : 'No fue posible completar el registro interno del pago.')
    } finally {
      setPaymentProcessing(false)
    }
  }

  const prepareBatch = async () => {
    if (paymentBusy) return
    setBatchError(null)
    setBatchResult(null)
    setBatchPreparing(true)
    try {
       const result = await prepareCollectionCustomerBatch(client.clientId)
       const defaultType = result.paymentTypes.find(type => type.label.toUpperCase() === 'TRANSFERENCIA') ?? result.paymentTypes[0]
       setBatchPreview({ ...result, paymentTypeId: defaultType?.id ?? null })
    } catch (cause) {
      setBatchError(cause instanceof Error ? cause.message : 'No se pudo preparar el pago total.')
    } finally {
      setBatchPreparing(false)
    }
  }

  const confirmBatch = async () => {
     if (!batchPreview || !batchPreview.paymentTypeId) {
       setBatchError('Selecciona una forma de pago para continuar.')
       return
     }
    setBatchProcessing(true)
    setBatchError(null)
    try {
       const result = await registerCollectionCustomerBatch({ clientId: client.clientId, paymentTypeId: batchPreview.paymentTypeId })
      setBatchResult(result)
      result.results.filter(item => item.status === 'CONFIRMED').forEach(item => onPaymentReconciled?.(item.documentId, 0, 0))
    } catch (cause) {
      setBatchError(cause instanceof Error ? cause.message : 'No se pudo procesar el batch.')
    } finally {
      setBatchProcessing(false)
    }
  }

  const requestStage = async (nextStage: CollectionStage) => {
    setPendingStage(nextStage)
  }

  const confirmInteraction = async () => {
    if (interactionProcessing) return
    setInteractionProcessing(true)
    setInteractionError(null)
    try {
      await registerCollectionInteraction({ clientId: client.clientId, type: interactionType, body: interactionBody })
      setInteractionBody('')
      setInteractionType('NOTE')
      setInteractionOpen(false)
      await refreshHistory()
    } catch (cause) {
      setInteractionError(cause instanceof Error ? cause.message : 'No se pudo guardar la gestión.')
    } finally {
      setInteractionProcessing(false)
    }
  }

  const saveStage = async (input: StageChangeInput) => {
    await onStageChange(input)
    setPendingStage(null)
    await refreshHistory()
  }

  return (
    <SheetContent side="right" className="flex h-screen w-full flex-col overflow-hidden border-[#D1C7BD] bg-[#EFE9E1] p-0 text-[#322D29] sm:!w-[560px] sm:!max-w-[560px]">
      <SheetHeader className="shrink-0 border-b border-[#D1C7BD] bg-white px-5 py-4 text-left">
        <div className="flex items-start justify-between gap-3">
          <div>
            <SheetTitle>{client.name}</SheetTitle>
            <SheetDescription>{client.code ? `RUT / código ${client.code}` : 'RUT no disponible'} · Corte {dateLabel(cutoffDate)}</SheetDescription>
          </div>
           <button type="button" disabled={paymentBusy} onClick={onClose} className="rounded p-1 text-[#322D29]/50 hover:bg-[#F5F0EA] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Cerrar panel">
            <X className="h-4 w-4" />
          </button>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!isHistoricalClosed && <div className="grid grid-cols-2 gap-px border border-[#D1C7BD] bg-[#D1C7BD] sm:grid-cols-4">
          <div className="bg-white px-2.5 py-2"><p className="text-[9px] uppercase tracking-[0.08em] text-[#AC9C8D]">Deuda total</p><p className="mt-1 text-sm font-semibold tabular-nums">{money(client.totalAmount)}</p></div>
          <div className="bg-white px-2.5 py-2"><p className="text-[9px] uppercase tracking-[0.08em] text-[#AC9C8D]">Vencida</p><p className="mt-1 text-sm font-semibold tabular-nums text-[#8A4B4B]">{money(client.overdueAmount)}</p></div>
          <div className="bg-white px-2.5 py-2"><p className="text-[9px] uppercase tracking-[0.08em] text-[#AC9C8D]">Documentos</p><p className="mt-1 text-sm font-semibold tabular-nums">{client.pendingDocuments}</p></div>
          <div className="bg-white px-2.5 py-2"><p className="text-[9px] uppercase tracking-[0.08em] text-[#AC9C8D]">Prioridad</p><div className="mt-1"><Priority value={client.priority} /></div></div>
        </div>}

        {!isHistoricalClosed && <button type="button" onClick={copyMessage} className="mt-4 flex items-center gap-2 border border-[#72383D]/30 bg-[#F5EDE9] px-3 py-2 text-xs font-semibold text-[#72383D] hover:bg-[#EDD9D3]">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
          {copied ? 'Mensaje copiado' : 'Copiar mensaje de cobranza'}
        </button>}
         {!isHistoricalClosed && pendingDocuments.length >= 2 && <button type="button" disabled={paymentBusy} onClick={() => void prepareBatch()} className="mt-2 inline-flex items-center gap-2 border border-[#72383D]/30 bg-white px-3 py-2 text-xs font-semibold text-[#72383D] hover:bg-[#F5EDE9] disabled:cursor-not-allowed disabled:opacity-50">{batchPreparing && <LoaderCircle className="h-3 w-3 animate-spin" />}{batchPreparing ? 'Consultando saldos en Bsale…' : 'Pagar todas'}</button>}
        {batchError && <p className="mt-2 text-[10px] text-[#8A4B4B]">{batchError}</p>}
        {!isHistoricalClosed && <button type="button" disabled={paymentBusy} onClick={() => { setInteractionError(null); setInteractionOpen(true) }} className="mt-2 inline-flex items-center gap-2 border border-[#72383D]/30 bg-white px-3 py-2 text-xs font-semibold text-[#72383D] hover:bg-[#F5EDE9] disabled:cursor-not-allowed disabled:opacity-50">Agregar nota</button>}

         <div className="mt-4 border border-[#D1C7BD] bg-white p-3">
           <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#72383D]">Etapa de cobranza</label>
           {isHistoricalClosed ? <p className="mt-2 text-xs font-semibold">Cerrado</p> : <StagePicker stage={stage} onChange={requestStage} />}
         </div>

         {isHistoricalClosed && <div className="mt-4 border border-[#D1C7BD] bg-white p-3 text-xs"><p><strong>Saldo:</strong> $0</p><p className="mt-1"><strong>Cerrado:</strong> {dateTimeLabel(historicalClosed?.closedAt ?? '')}</p></div>}

        <CollectionStageDialog key={`drawer-stage-${pendingStage ?? 'closed'}`} open={Boolean(pendingStage)} clientName={client.name} clientTotal={client.totalAmount} currentStage={stage} nextStage={pendingStage} onOpenChange={open => { if (!open) setPendingStage(null) }} onSave={saveStage} />

        <Dialog open={interactionOpen} onOpenChange={open => { if (!open && !interactionProcessing) setInteractionOpen(false) }}>
          <DialogContent className="border-[#D1C7BD] bg-[#FCFBF9] text-[#322D29]">
            <DialogHeader>
              <DialogTitle>Agregar nota</DialogTitle>
              <DialogDescription>Registra una interacción sin cambiar la etapa de cobranza.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <label className="block text-xs font-semibold">Tipo<select value={interactionType} onChange={event => setInteractionType(event.target.value as CollectionInteractionType)} disabled={interactionProcessing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs"><option value="NOTE">Nota</option><option value="CALL">Llamada</option><option value="MESSAGE">Mensaje / WhatsApp</option><option value="EMAIL">Correo</option></select></label>
              <label className="block text-xs font-semibold">Descripción<textarea required maxLength={2000} value={interactionBody} onChange={event => setInteractionBody(event.target.value)} disabled={interactionProcessing} rows={4} className="mt-1 w-full resize-none border border-[#D1C7BD] bg-white p-2 text-xs" /></label>
              {interactionError && <p className="text-xs text-[#8A4B4B]">{interactionError}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={interactionProcessing} onClick={() => setInteractionOpen(false)}>Cancelar</Button>
              <Button type="button" disabled={interactionProcessing} onClick={() => void confirmInteraction()}>{interactionProcessing ? 'Guardando nota…' : 'Guardar nota'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

          {!isHistoricalClosed && <Dialog open={Boolean(paymentPreview)} onOpenChange={open => { if (!open && !paymentProcessing) setPaymentPreview(null) }}>
          <DialogContent className="border-[#D1C7BD] bg-[#FCFBF9] text-[#322D29]">
            <DialogHeader>
              <DialogTitle>Confirmar pago en Bsale</DialogTitle>
             <DialogDescription>Revisa el saldo live antes de confirmar. El pago quedará registrado sólo al confirmar.</DialogDescription>
            </DialogHeader>
            {paymentPreview && <div className="space-y-2 text-xs">
              <p><strong>Cliente:</strong> {client.name}</p>
              <p><strong>Factura:</strong> {client.documents.find(document => document.document_id === paymentPreview.documentId)?.folio ?? paymentPreview.documentId}</p>
              <p><strong>Saldo Bsale actual:</strong> {money(paymentPreview.liveBalance)}</p>
               <div className="space-y-2 border-y border-[#D1C7BD] py-3">
                 <label className="flex items-center gap-2"><input type="radio" checked={paymentMode === 'TOTAL'} onChange={() => { setPaymentMode('TOTAL'); setPartialAmount('') }} disabled={paymentProcessing} /> Pago total de esta factura <strong className="ml-auto">{money(paymentPreview.liveBalance)}</strong></label>
                 <label className="flex items-center gap-2"><input type="radio" checked={paymentMode === 'PARTIAL'} onChange={() => { setPaymentMode('PARTIAL'); setPartialAmount('') }} disabled={paymentProcessing} /> Pago parcial</label>
                 {paymentMode === 'PARTIAL' && <div className="space-y-1"><label className="block text-[10px] font-semibold">Monto a registrar<input aria-label="Monto parcial" type="text" inputMode="numeric" value={clpInput(partialAmount)} onChange={event => setPartialAmount(event.target.value.replace(/\D/g, ''))} disabled={paymentProcessing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs" /></label><p className="text-[10px] text-[#322D29]/55">Saldo máximo disponible: {money(paymentPreview.liveBalance)}</p></div>}
                </div>
                <p><strong>Monto a registrar:</strong> {paymentMode === 'TOTAL' ? money(paymentPreview.liveBalance) : partialAmount ? money(Number(partialAmount)) : '—'}</p>
                {paymentMode === 'PARTIAL' && Number(partialAmount) > 0 && Number(partialAmount) <= paymentPreview.liveBalance && <p><strong>Saldo estimado posterior:</strong> {money(paymentPreview.liveBalance - Number(partialAmount))}</p>}
               <label className="block text-xs font-semibold">Forma de pago *<select value={paymentPreview.paymentTypeId ?? ''} onChange={event => setPaymentPreview(current => current ? { ...current, paymentTypeId: event.target.value ? Number(event.target.value) : null } : current)} disabled={paymentProcessing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs"><option value="">Selecciona una forma de pago</option>{paymentPreview.paymentTypes.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}</select></label>
              <p><strong>Fecha:</strong> {dateLabel(paymentPreview.recordDate)}</p>
              <p className="mt-3 border border-[#B38A55]/40 bg-[#F6EFE2] px-3 py-2 text-[11px] text-[#806238]">Esta acción registrará un pago real en Bsale.</p>
            </div>}
               {paymentStatus === 'SUCCESS' && paymentResult && <div className="border border-[#66856B]/40 bg-[#EDF4EC] px-3 py-2 text-[11px] text-[#426247]"><p className="font-semibold">Pago confirmado y reconciliado.</p><p className="mt-1">Saldo factura: <strong>{money(paymentResult.documentBalance)}</strong>. Saldo cliente: <strong>{money(paymentResult.clientBalance)}</strong>{paymentResult.clientBalance === 0 && ' · Cliente cerrado automáticamente.'}</p></div>}
              {paymentStatus === 'FAILED' && <div className="border border-[#A45B58]/40 bg-[#F5E8E4] px-3 py-2 text-[11px] text-[#8A4B4B]"><p className="font-semibold">No se pudo registrar el pago</p><p className="mt-1">El pago NO fue confirmado en Bsale.</p><p className="mt-1">Detalle: {paymentError ?? 'No fue posible completar el registro interno del pago.'}</p></div>}
              {paymentStatus === 'UNKNOWN' && <p className="border border-[#B38A55]/40 bg-[#F6EFE2] px-3 py-2 text-[11px] text-[#806238]">Estado incierto: no reintentes automáticamente. Verifica el pago en Bsale y revisa la conciliación.</p>}
               <DialogFooter>
                 {paymentStatus === 'IDLE' && <Button type="button" variant="outline" disabled={paymentProcessing} onClick={() => setPaymentPreview(null)}>Cancelar</Button>}
                 {paymentStatus === 'IDLE' && <Button type="button" disabled={paymentProcessing} onClick={() => void confirmPayment()}>{paymentProcessing ? 'Registrando y verificando…' : 'CONFIRMAR PAGO EN BSALE'}</Button>}
                 {paymentStatus !== 'IDLE' && <Button type="button" onClick={() => setPaymentPreview(null)}>Cerrar</Button>}
            </DialogFooter>
          </DialogContent>
         </Dialog>}

         {!isHistoricalClosed && <Dialog open={Boolean(batchPreview)} onOpenChange={open => { if (!open && !batchProcessing) setBatchPreview(null) }}>
          <DialogContent className="border-[#D1C7BD] bg-[#FCFBF9] text-[#322D29]">
            <DialogHeader>
              <DialogTitle>Pagar todas las facturas</DialogTitle>
              <DialogDescription>Se procesarán los documentos del cliente uno por uno.</DialogDescription>
            </DialogHeader>
               {batchPreview && <div className="space-y-2 text-xs">
              <p className="font-semibold">{client.name}</p>
              {batchPreview.documents.map(document => <div key={document.documentId} className="flex justify-between border-b border-[#D1C7BD]/70 py-1"><span>Factura {document.folio ?? document.documentId}</span><strong>{money(document.balance)}</strong></div>)}
               <div className="flex justify-between pt-1 text-sm font-bold"><span>TOTAL</span><span>{money(batchPreview.total)}</span></div>
               <label className="mt-3 block text-xs font-semibold">Forma de pago *<select value={batchPreview.paymentTypeId ?? ''} onChange={event => setBatchPreview(current => current ? { ...current, paymentTypeId: event.target.value ? Number(event.target.value) : null } : current)} disabled={batchProcessing} className="mt-1 h-9 w-full border border-[#D1C7BD] bg-white px-2 text-xs"><option value="">Selecciona una forma de pago</option>{batchPreview.paymentTypes.map(type => <option key={type.id} value={type.id}>{type.label}</option>)}</select></label>
               <p className="mt-3 border border-[#B38A55]/40 bg-[#F6EFE2] px-3 py-2 text-[11px] text-[#806238]">Se registrarán {batchPreview.documents.length} pagos reales en Bsale por un total de {money(batchPreview.total)}.</p>
            </div>}
             {batchProcessing && <p className="border border-[#B38A55]/40 bg-[#F6EFE2] px-3 py-2 text-[11px] text-[#806238]">Procesando pagos secuencialmente y verificando cada documento. No cierres esta ventana.</p>}
             {batchResult && <div className="space-y-1 border border-[#D1C7BD] bg-[#F5F0EA] px-3 py-2 text-[11px]"><p className="font-semibold">Batch {batchResult.status}: {money(batchResult.confirmedTotal)} confirmado de {money(batchResult.expectedTotal)}.</p>{batchResult.results.map(result => <p key={result.documentId} className={result.status === 'CONFIRMED' ? 'text-[#426247]' : 'text-[#8A4B4B]'}>Factura {result.folio ?? result.documentId}: {result.status === 'CONFIRMED' ? 'confirmada' : result.status === 'UNKNOWN' ? 'estado incierto' : 'fallida'}</p>)}</div>}
             <DialogFooter>
               <Button type="button" variant="outline" disabled={batchProcessing} onClick={() => setBatchPreview(null)}>Cancelar</Button>
               <Button type="button" disabled={batchProcessing || Boolean(batchResult)} onClick={() => void confirmBatch()}>{batchProcessing ? 'Registrando y verificando…' : 'CONFIRMAR PAGOS EN BSALE'}</Button>
            </DialogFooter>
          </DialogContent>
         </Dialog>}

         {!isHistoricalClosed && <div className="mt-5 border border-[#D1C7BD] bg-white">
          <div className="border-b border-[#D1C7BD] bg-[#F5F0EA] px-3 py-2">
             <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#72383D]">Documentos pendientes</p>
           </div>
          <div className="divide-y divide-[#D1C7BD]/70">
            {pendingDocuments.map((document) => {
               const dueToday = document.expiration_date === cutoffDate
               const visibleStatus = document.overdue ? 'Vencida' : dueToday ? 'Adeudada · vence hoy' : 'Adeudada'
               const unknownAttempt = unknownAttempts.find(attempt => attempt.documentId === document.document_id)
               const resolution = unknownResolution[document.document_id]
               return (
                 <div key={document.document_id} className={`px-3 py-3 text-xs ${focusedDocumentId === document.document_id ? 'bg-[#F6EFE2] ring-1 ring-inset ring-[#B38A55]' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{document.document_type_name ?? 'Documento'} #{document.folio ?? document.document_id}</p>
                      <p className="mt-1 text-[10px] text-[#322D29]/55">Emitida {dateLabel(document.emission_date)} · Vence {dateLabel(document.expiration_date)}</p>
                    </div>
                    <strong className="tabular-nums">{money(document.pending_amount)}</strong>
                  </div>
                   <p className={`mt-1 text-[10px] ${document.overdue ? 'text-[#8A4B4B]' : 'text-[#322D29]/55'}`}>{visibleStatus}</p>
                    <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-[#322D29]/55">Saldo pendiente</span><strong className="text-[11px]">{money(document.pending_amount)}</strong></div>
                     {unknownAttempt ? <button type="button" disabled={paymentBusy} onClick={() => void verifyUnknown(unknownAttempt)} className="mt-2 inline-flex items-center gap-2 border border-[#B38A55]/50 bg-[#F6EFE2] px-2 py-1 text-[10px] font-semibold text-[#806238] hover:bg-[#EDE1C9] disabled:cursor-not-allowed disabled:opacity-50">{unknownBusyId === unknownAttempt.id && <LoaderCircle className="h-3 w-3 animate-spin" />}{unknownBusyId === unknownAttempt.id ? 'Verificando en Bsale…' : 'Verificar en Bsale'}</button> : <button type="button" disabled={paymentBusy} onClick={() => void previewPayment(document.document_id, String(document.pending_amount))} className="mt-2 inline-flex items-center gap-2 border border-[#72383D]/30 px-2 py-1 text-[10px] font-semibold text-[#72383D] hover:bg-[#F5EDE9] disabled:cursor-not-allowed disabled:opacity-50">{preflightDocumentId === document.document_id && <LoaderCircle className="h-3 w-3 animate-spin" />}{preflightDocumentId === document.document_id ? 'Consultando saldo en Bsale…' : 'Registrar pago'}</button>}
                     {unknownAttempt && <p className="mt-2 border-l-2 border-[#B38A55] pl-2 text-[10px] text-[#806238]">Estado UNKNOWN: no vuelvas a intentar hasta verificarlo.</p>}
                     {resolution && <p className={`mt-2 border-l-2 pl-2 text-[10px] ${resolution.outcome === 'CONFIRMED' ? 'border-[#66856B] text-[#426247]' : resolution.outcome === 'FAILED' ? 'border-[#66856B] text-[#426247]' : 'border-[#B38A55] text-[#806238]'}`}>{resolution.message}</p>}
                    {paymentPreview?.documentId === document.document_id && paymentStatus === 'IDLE' && <p className="mt-2 border-l-2 border-[#B38A55] pl-2 text-[10px] text-[#806238]">Preflight OK. Saldo vivo Bsale: {money(paymentPreview.liveBalance)}. No se ha escrito ningún pago.</p>}
                 </div>
              )
            })}
           </div>
           </div>}
          <section className="mt-5 border border-[#D1C7BD] bg-white">
           <div className="border-b border-[#D1C7BD] bg-[#F5F0EA] px-3 py-2">
             <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#72383D]">Bitácora de cobranza</p>
           </div>
           {historyLoading && <p className="px-3 py-4 text-[10px] text-[#322D29]/50">Cargando historial…</p>}
           {!historyLoading && historyError && <p className="px-3 py-4 text-[10px] text-[#8A4B4B]">{historyError}</p>}
           {!historyLoading && !historyError && history.length === 0 && <p className="px-3 py-4 text-[10px] text-[#322D29]/50">Aún no hay gestiones registradas.</p>}
            {!historyLoading && !historyError && history.length > 0 && <div className="divide-y divide-[#D1C7BD]/70">
              {history.map(event => <article key={event.id} className="border-l-2 border-[#B38A55] px-3 py-3 text-xs">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                  <p className="font-bold uppercase tracking-[0.08em] text-[10px] text-[#72383D]">{historyTitle(event)}</p>
                  <time className="text-[10px] text-[#322D29]/50">{dateTimeLabel(event.createdAt)}</time>
                </div>
                <p className="mt-1 text-[10px] font-medium text-[#322D29]/60">{event.actorName}</p>
                {event.eventType === 'STAGE_CHANGED' && (event.fromStage || event.toStage) && <p className="mt-2 text-[11px] text-[#322D29]">{stageLabel(event.fromStage) ?? 'Inicio'} → {stageLabel(event.toStage)}</p>}
                {event.eventType === 'COMMITMENT' && (event.commitmentDate || event.commitmentAmount !== null) && <p className="mt-2 text-[10px] text-[#806238]">{event.commitmentDate && <>Fecha: {dateLabel(event.commitmentDate)}</>}{event.commitmentDate && event.commitmentAmount !== null && ' · '}{event.commitmentAmount !== null && <>Monto: {money(event.commitmentAmount)}</>}</p>}
                {event.nextActionAt && <p className="mt-2 text-[10px] text-[#806238]">Próxima gestión: {dateLabel(event.nextActionAt)}</p>}
                {event.note && <p className="mt-3 whitespace-pre-wrap border-l-2 border-[#72383D] bg-[#F5EDE9] px-3 py-2 text-[13px] leading-5 text-[#322D29]">{event.note}</p>}
               </article>)}
            </div>}
           {!historyLoading && !historyError && historyHasMore && <button type="button" onClick={() => { setHistoryExpanded(true); void refreshHistory(100) }} className="border-t border-[#D1C7BD] px-3 py-2 text-[10px] font-semibold text-[#72383D] hover:bg-[#F5F0EA]">Ver historial completo</button>}
         </section>
         {paymentError && <p className="mt-3 border border-[#A45B58]/30 bg-[#F5E8E4] px-3 py-2 text-[10px] text-[#8A4B4B]">{paymentError}</p>}

       </div>
    </SheetContent>
  )
}

export function Cobranza({ data, error, snapshotStatus }: { data?: FinanceReceivablesAnalysis; error?: string; snapshotStatus?: ReceivablesSnapshotStatus }) {
  type ViewMode = 'CLIENTS' | 'INVOICES'
  type ClientSort = 'overdue-desc' | 'age-desc' | 'total-desc' | 'total-asc' | 'name-asc'
  type InvoiceSort = 'due-asc' | 'due-desc' | 'amount-desc' | 'amount-asc' | 'name-asc'
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'overdue'>('all')
  const [age, setAge] = useState('0')
  const [viewMode, setViewMode] = useState<ViewMode>('CLIENTS')
  const [sortMode, setSortMode] = useState<ClientSort | InvoiceSort>('overdue-desc')
  const [selectedClient, setSelectedClient] = useState<CobranzaClient | null>(null)
  const [selectedClosed, setSelectedClosed] = useState<RecentClosedCollectionCustomer | null>(null)
  const [selectedDocumentId, setSelectedDocumentId] = useState<number | null>(null)
  const [settledDocumentIds, setSettledDocumentIds] = useState<number[]>([])
  const [workflow, setWorkflow] = useState<Record<number, WorkflowState>>({})
  const [paymentOverlay, setPaymentOverlay] = useState<CollectionPaymentOverlay[]>([])
  const [activeDragClientId, setActiveDragClientId] = useState<number | null>(null)
  const [pendingDrop, setPendingDrop] = useState<{ client: CobranzaClient; currentStage: CollectionStage; nextStage: CollectionStage } | null>(null)
  const [quickNoteClient, setQuickNoteClient] = useState<CobranzaClient | null>(null)
  const [commitmentClient, setCommitmentClient] = useState<CobranzaClient | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [locatedClientId, setLocatedClientId] = useState<number | null>(null)
  const [quickNoteFeedback, setQuickNoteFeedback] = useState(false)
  const [today, setToday] = useState(() => todayInChile())
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const cutoffDate = data ? data.snapshot_date ?? data.close_date : ''
  const overlayDocuments = data ? applyCobranzaPaymentOverlay(data.documents, paymentOverlay) : []
  const clients = data ? buildCobranzaClients(overlayDocuments, cutoffDate) : []
  const activeClientIds = new Set(clients.map(client => client.clientId))
  const invoices = buildCobranzaInvoices(clients, cutoffDate)
  const [closedRecent, setClosedRecent] = useState<RecentClosedCollectionCustomer[]>([])
  useEffect(() => {
    const timer = window.setInterval(() => setToday(current => {
      const next = todayInChile()
      return next === current ? current : next
    }), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (locatedClientId === null || viewMode !== 'CLIENTS') return
    const node = document.getElementById(`collection-card-${locatedClientId}`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
  }, [locatedClientId, viewMode])
  useEffect(() => {
    let cancelled = false
    const workflowClients = data ? buildCobranzaClients(data.documents, data.snapshot_date ?? data.close_date) : []
    const loadDirectedState = async () => {
      try {
        const [rows, workflowRows, closedRows] = await Promise.all([
          getCollectionPaymentOverlay(workflowClients.map(client => client.clientId), data?.snapshot_at),
          getCollectionWorkflow(workflowClients.map(client => client.clientId)),
          getRecentClosedCollectionCustomers(),
        ])
        if (cancelled) return
        setPaymentOverlay(rows)
        setWorkflow(Object.fromEntries(workflowRows.map(row => [row.client_id, { ...row, stage: row.stage as CollectionStage }])))
        setClosedRecent(closedRows)
      } catch {
        // Initial local state loading should not block the Cobranza UI.
      }
    }
    void loadDirectedState().then(async () => {
      const reopened = await reopenCollectionCustomersWithDebt(workflowClients.map(client => client.clientId), data?.snapshot_at)
      if (!cancelled && reopened.reopened > 0) setWorkflow(current => Object.fromEntries(Object.entries(current).map(([clientId, value]) => [clientId, value.stage === 'CLOSED' ? { ...value, stage: 'TO_MANAGE' } : value])))
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [data])
  if (error || !data) {
    return <main className="min-h-[430px] bg-[#EFE9E1] px-4 py-5 sm:px-5 sm:py-6 lg:px-6"><div className="flex flex-wrap items-start justify-between gap-3 border border-[#72383D]/25 bg-white/60 px-5 py-8"><div className="text-sm text-[#72383D]">{error ?? 'No hay datos de cobranza disponibles.'}</div>{snapshotStatus && <CobranzaSnapshotControl initialStatus={snapshotStatus} />}</div></main>
  }
  const freshness = data.freshness_status
    ? { status: data.freshness_status, ageMinutes: data.snapshot_age_minutes ?? null }
    : getReceivablesFreshness(data.snapshot_at)
  const snapshotLabel = formatReceivablesSnapshotAt(data.snapshot_at)
  const normalizedQuery = normalize(query.trim())
  const minimumAge = Number(age)
  const visibleClosedRecent = closedRecent.filter(client => !activeClientIds.has(client.clientId)).filter(client => !normalizedQuery || normalize(`${client.name} ${client.code ?? ''}`).includes(normalizedQuery))
  const visibleClients = clients.filter((client) => {
    const matchesQuery = !normalizedQuery || normalize(`${client.name} ${client.code ?? ''}`).includes(normalizedQuery)
    const matchesScope = scope === 'all' || client.overdueAmount > 0
    const matchesAge = minimumAge === 0 || client.oldestDaysOverdue >= minimumAge
    return matchesQuery && matchesScope && matchesAge
  })
  const visibleInvoices = invoices.filter(invoice => !settledDocumentIds.includes(invoice.document_id)).filter(invoice => {
    const matchesQuery = !normalizedQuery || normalize(`${invoice.clientName} ${invoice.clientCode ?? ''} ${invoice.folio ?? ''}`).includes(normalizedQuery)
    const matchesScope = scope === 'all' || invoice.overdue
    const matchesAge = minimumAge === 0 || invoice.daysOverdue >= minimumAge
    return matchesQuery && matchesScope && matchesAge
  })
  const sortedClients = [...visibleClients].sort((left, right) => {
    if (sortMode === 'age-desc') return right.oldestDaysOverdue - left.oldestDaysOverdue || right.overdueAmount - left.overdueAmount || left.name.localeCompare(right.name, 'es')
    if (sortMode === 'total-desc') return right.totalAmount - left.totalAmount || right.overdueAmount - left.overdueAmount || left.name.localeCompare(right.name, 'es')
    if (sortMode === 'total-asc') return left.totalAmount - right.totalAmount || left.name.localeCompare(right.name, 'es')
    if (sortMode === 'name-asc') return left.name.localeCompare(right.name, 'es') || right.overdueAmount - left.overdueAmount
    return right.overdueAmount - left.overdueAmount || right.oldestDaysOverdue - left.oldestDaysOverdue || right.totalAmount - left.totalAmount || left.name.localeCompare(right.name, 'es')
  })
  const sortedInvoices = [...visibleInvoices].sort((left, right) => {
    const leftDate = left.expiration_date ?? ''
    const rightDate = right.expiration_date ?? ''
    if (sortMode === 'due-desc') return rightDate.localeCompare(leftDate) || right.pending_amount.localeCompare(left.pending_amount) || String(right.folio ?? '').localeCompare(String(left.folio ?? ''))
    if (sortMode === 'amount-desc') return Number(right.pending_amount) - Number(left.pending_amount) || leftDate.localeCompare(rightDate) || String(left.folio ?? '').localeCompare(String(right.folio ?? ''))
    if (sortMode === 'amount-asc') return Number(left.pending_amount) - Number(right.pending_amount) || leftDate.localeCompare(rightDate) || String(left.folio ?? '').localeCompare(String(right.folio ?? ''))
    if (sortMode === 'name-asc') return left.clientName.localeCompare(right.clientName, 'es') || leftDate.localeCompare(rightDate) || String(left.folio ?? '').localeCompare(String(right.folio ?? ''))
    return leftDate.localeCompare(rightDate) || Number(right.pending_amount) - Number(left.pending_amount) || String(left.folio ?? '').localeCompare(String(right.folio ?? ''))
  })
  const pendingTasks = buildCobranzaTasks(clients, workflow, today)
  const locatedClient = locatedClientId === null ? null : clients.find(client => client.clientId === locatedClientId) ?? null
  const selectTask = (task: CobranzaTask) => {
    setSelectedTaskId(task.id)
    setLocatedClientId(task.clientId)
  }
  const selectClient = (client: CobranzaClient, documentId?: number) => {
    setSelectedClient(client)
    setSelectedClosed(null)
    setSelectedDocumentId(documentId ?? null)
  }
  const openClientFromTask = (clientId: number) => {
    const client = clients.find(candidate => candidate.clientId === clientId)
    if (client) selectClient(client)
  }
  const selectClosed = (closed: RecentClosedCollectionCustomer) => {
    setSelectedClosed(closed)
    setSelectedClient({ key: `closed-${closed.clientId}`, clientId: closed.clientId, name: closed.name, code: closed.code, totalAmount: 0, overdueAmount: 0, pendingDocuments: 0, oldestExpirationDate: null, oldestDaysOverdue: 0, documents: [], priority: 'Normal' })
    setSelectedDocumentId(null)
  }
  const saveQuickInteraction = async (input: { type: CollectionInteractionType; body: string }) => {
    if (!quickNoteClient) return
    await registerCollectionInteraction({ clientId: quickNoteClient.clientId, ...input })
    setQuickNoteClient(null)
    setQuickNoteFeedback(true)
    window.setTimeout(() => setQuickNoteFeedback(false), 1800)
  }
  const saveCommitment = async (input: { commitmentAt: string; commitmentAmount?: number; note?: string }) => {
    if (!commitmentClient) return
    const result = await setCollectionCommitment({ clientId: commitmentClient.clientId, ...input })
    setWorkflow(current => ({
      ...current,
      [commitmentClient.clientId]: {
        ...current[commitmentClient.clientId],
        stage: current[commitmentClient.clientId]?.stage ?? 'TO_MANAGE',
        commitment_at: result.commitmentAt,
        commitment_amount: result.commitmentAmount,
      },
    }))
    setCommitmentClient(null)
  }
  const removeCommitment = async () => {
    if (!commitmentClient) return
    await clearCollectionCommitment(commitmentClient.clientId)
    setWorkflow(current => ({
      ...current,
      [commitmentClient.clientId]: {
        ...current[commitmentClient.clientId],
        stage: current[commitmentClient.clientId]?.stage ?? 'TO_MANAGE',
        commitment_at: null,
        commitment_amount: null,
      },
    }))
    setCommitmentClient(null)
  }
  const handleDragStart = (event: DragStartEvent) => {
    if (viewMode !== 'CLIENTS') return
    setActiveDragClientId(Number(event.active.data.current?.clientId))
  }
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragClientId(null)
    if (viewMode !== 'CLIENTS' || !event.over) return
    const clientId = Number(event.active.data.current?.clientId)
    const nextStage = event.over.data.current?.stage as CollectionStage | undefined
    const client = clients.find(candidate => candidate.clientId === clientId)
    const currentStage = workflow[clientId]?.stage ?? 'TO_MANAGE'
    if (!client || !nextStage || nextStage === 'CLOSED' || nextStage === currentStage) return
    setPendingDrop({ client, currentStage, nextStage })
  }
  const saveDroppedStage = async (input: StageChangeInput) => {
    if (!pendingDrop) return
    await updateCollectionStage({ clientId: pendingDrop.client.clientId, ...input })
    setWorkflow(current => ({
      ...current,
      [pendingDrop.client.clientId]: {
        ...current[pendingDrop.client.clientId],
        stage: input.stage,
        commitment_at: input.commitmentAt ?? null,
        commitment_amount: input.commitmentAmount ?? null,
        next_action_at: input.nextActionAt ?? null,
      },
    }))
    setPendingDrop(null)
  }
  const changeView = (nextView: ViewMode) => {
    setViewMode(nextView)
    setSortMode(nextView === 'CLIENTS' ? 'overdue-desc' : 'due-asc')
  }
  const clearFilters = () => {
    setQuery('')
    setScope('all')
    setAge('0')
    setSortMode(viewMode === 'CLIENTS' ? 'overdue-desc' : 'due-asc')
  }
  const filtersClean = query === '' && scope === 'all' && age === '0' && sortMode === (viewMode === 'CLIENTS' ? 'overdue-desc' : 'due-asc')
  const kpis = viewMode === 'CLIENTS'
    ? calculateCobranzaClientKpis(visibleClients)
    : calculateCobranzaInvoiceKpis(visibleInvoices)

  return (
    <main className="min-h-[430px] bg-[#EFE9E1] px-4 py-5 sm:px-5 sm:py-6 lg:px-6">
      <section className="border border-[#D1C7BD] bg-[#FCFBF9] p-4 shadow-[0_8px_24px_rgba(50,45,41,0.05)] lg:p-5">
        <div className="overflow-hidden border border-[#D1C7BD] bg-white">
          <div className="grid grid-cols-1 gap-px bg-[#EAE2D9] lg:grid-cols-2 2xl:grid-cols-[minmax(190px,1.05fr)_minmax(280px,1.15fr)_minmax(330px,1.3fr)_minmax(200px,.8fr)]">
            <div className="flex flex-col justify-center gap-0.5 bg-white p-3">
              <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Cobranza</p>
              <h1 className="truncate text-base font-semibold tracking-[-0.02em] text-[#322D29]">Gestión de cartera y clientes</h1>
              <p className="truncate text-[10px] leading-4 text-[#322D29]/50">Ordenada por deuda vencida, antigüedad y saldo total.</p>
            </div>
            <div className="grid grid-cols-2 grid-rows-2 gap-px bg-[#EAE2D9]">
              <MiniKpi label="CxC total" value={money(kpis.totalAmount)} />
              <MiniKpi label="CxC vencida" value={money(kpis.overdueAmount)} tone="overdue" />
              <MiniKpi label="Clientes con saldo" value={kpis.clientsWithBalance.toLocaleString('es-CL')} />
              <MiniKpi label="Clientes con deuda vencida" value={kpis.clientsWithOverdueDebt.toLocaleString('es-CL')} tone="overdue" />
            </div>
            <div className="flex flex-col bg-white">
              <PendingTasksPanel tasks={pendingTasks} selectedTaskId={selectedTaskId} onSelectTask={selectTask} onOpenClient={openClientFromTask} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 bg-white p-3 text-[10px] text-[#322D29]/55">
              <CobranzaFreshnessNotice status={freshness.status} snapshotLabel={snapshotLabel} />
              {snapshotStatus && <CobranzaSnapshotControl initialStatus={snapshotStatus} />}
              <p className="break-words">{data.summary.pending_documents} documentos pendientes</p>
              <PaymentProgressObserver />
            </div>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-b border-[#D1C7BD] pb-3">
              <div className="flex items-center gap-1 border border-[#D1C7BD] bg-white p-0.5 text-[10px] font-semibold"><button type="button" onClick={() => changeView('CLIENTS')} className={`px-1.5 py-1 ${viewMode === 'CLIENTS' ? 'bg-[#72383D] text-white' : 'text-[#72383D]'}`}>Clientes</button><button type="button" onClick={() => changeView('INVOICES')} className={`px-1.5 py-1 ${viewMode === 'INVOICES' ? 'bg-[#72383D] text-white' : 'text-[#72383D]'}`}>Facturas</button></div>
             <label className="relative">
               <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#322D29]/40" />
                <input value={query} onChange={event => setQuery(event.target.value)} placeholder={viewMode === 'CLIENTS' ? 'Buscar cliente' : 'Buscar cliente o folio'} className="h-8 w-full min-w-[220px] border border-[#D1C7BD] bg-white pl-7 pr-2 text-xs outline-none focus:border-[#72383D] sm:w-52" />
             </label>
            <select value={scope} onChange={event => setScope(event.target.value as 'all' | 'overdue')} className="h-8 border border-[#D1C7BD] bg-white px-2 text-xs text-[#322D29]">
              <option value="overdue">Con deuda vencida</option>
              <option value="all">Todos</option>
            </select>
             <select value={age} onChange={event => setAge(event.target.value)} className="h-8 border border-[#D1C7BD] bg-white px-2 text-xs text-[#322D29]">
              <option value="0">Cualquier antigüedad</option>
              <option value="15">15+ días</option>
              <option value="30">30+ días</option>
               <option value="60">60+ días</option>
             </select>
             <label className="flex h-8 items-center gap-1 border border-[#D1C7BD] bg-white px-2 text-xs"><span className="text-[#322D29]/50">Ordenar</span><select value={sortMode} onChange={event => setSortMode(event.target.value as ClientSort | InvoiceSort)} className="bg-transparent text-xs text-[#322D29] outline-none">
               {viewMode === 'CLIENTS' ? <><option value="overdue-desc">Deuda vencida: mayor a menor</option><option value="age-desc">Antigüedad: mayor primero</option><option value="total-desc">Deuda total: mayor a menor</option><option value="total-asc">Deuda total: menor a mayor</option><option value="name-asc">Cliente: A–Z</option></> : <><option value="due-asc">Vencimiento: más antiguo primero</option><option value="due-desc">Vencimiento: más reciente primero</option><option value="amount-desc">Monto: mayor a menor</option><option value="amount-asc">Monto: menor a mayor</option><option value="name-asc">Cliente: A–Z</option></>}
              </select></label>
              <button type="button" onClick={clearFilters} disabled={filtersClean} className="h-8 border border-[#D1C7BD] px-2 text-xs text-[#72383D] hover:bg-[#F5EDE9] disabled:cursor-not-allowed disabled:opacity-40">Limpiar filtros</button>
        </div>

            {viewMode === 'CLIENTS' ? <DndContext sensors={sensors} onDragStart={handleDragStart} onDragCancel={() => setActiveDragClientId(null)} onDragEnd={handleDragEnd}>
              <div className="mt-3 overflow-x-auto pb-2">
                <div className="grid min-w-[1120px] grid-cols-[repeat(5,minmax(212px,1fr))] gap-2">
                 {kanbanStages.map(stage => {
                   const stageClients = sortedClients.filter(client => stage.key !== 'CLOSED' && (workflow[client.clientId]?.stage ?? 'TO_MANAGE') === stage.key)
                   const includeLocated = locatedClient !== null && stage.key !== 'CLOSED' && (workflow[locatedClient.clientId]?.stage ?? 'TO_MANAGE') === stage.key && !stageClients.some(client => client.clientId === locatedClient.clientId)
                   return <ClientKanbanColumn key={stage.key} stage={stage} clients={includeLocated && locatedClient ? [...stageClients, locatedClient] : stageClients} tasks={pendingTasks} today={today} selectedClientId={locatedClientId} closedRecent={stage.key === 'CLOSED' ? visibleClosedRecent : []} workflow={workflow} onOpen={selectClient} onOpenClosed={selectClosed} onAddNote={setQuickNoteClient} onCommitment={setCommitmentClient} />
                 })}
                </div>
              </div>
             <DragOverlay>
                 {activeDragClientId ? (() => { const client = clients.find(candidate => candidate.clientId === activeDragClientId); if (!client) return null; return <ClientKanbanCard client={client} stage={workflow[client.clientId]?.stage ?? 'TO_MANAGE'} workflow={workflow[client.clientId]} task={taskForClient(client.clientId, pendingTasks)} onOpen={() => undefined} onAddNote={() => undefined} onCommitment={() => undefined} isOverlay /> })() : null}
             </DragOverlay>
             </DndContext> : <div className="mt-3 overflow-x-auto pb-2"><div className="grid min-w-[1120px] grid-cols-[repeat(5,minmax(212px,1fr))] gap-2">
             {kanbanStages.map(stage => {
               const stageInvoices = sortedInvoices.filter(invoice => (workflow[invoice.client_id]?.stage ?? 'TO_MANAGE') === stage.key)
                return <section key={stage.key} className="min-w-0 border border-[#D1C7BD] bg-[#F5F0EA]">
                 <header className="border-b border-[#D1C7BD] px-3 py-2"><div className="flex items-center justify-between"><h3 className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#72383D]">{stage.label}</h3><span className="text-[10px] text-[#322D29]/50">{stageInvoices.length}</span></div></header>
                 <div className="space-y-2 p-2">
                   {stageInvoices.map(invoice => { const client = clients.find(candidate => candidate.clientId === invoice.client_id); if (!client) return null; return <div key={invoice.key} role="button" tabIndex={0} onDoubleClick={() => selectClient(client, invoice.document_id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectClient(client, invoice.document_id) } }} className="w-full cursor-pointer border border-[#D1C7BD] bg-white p-2.5 text-left hover:border-[#72383D]">
                     <div className="flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{invoice.clientName}</p><p className="mt-1 text-[10px] text-[#322D29]/60">Factura #{invoice.folio ?? invoice.document_id}</p></div><Priority value={invoice.priority} /></div>
                     <p className="mt-2 text-[10px] text-[#322D29]/55">Emitida {dateLabel(invoice.emission_date)} · Vence {dateLabel(invoice.expiration_date)}</p>
                     <p className={`mt-1 text-[10px] ${invoice.overdue ? 'text-[#8A4B4B]' : 'text-[#322D29]/55'}`}>{invoice.overdue ? `${invoice.daysOverdue} días vencida` : 'Por vencer'}</p>
                     <div className="mt-1 flex items-center justify-between gap-2"><strong className="text-sm tabular-nums">{money(invoice.pending_amount)}</strong><button type="button" onClick={event => { event.stopPropagation(); selectClient(client, invoice.document_id) }} className="border border-[#72383D]/30 px-2 py-1 text-[10px] font-semibold text-[#72383D]">Registrar pago</button></div>
                   </div> })}
                   {stageInvoices.length === 0 && <p className="px-2 py-5 text-center text-[10px] text-[#322D29]/45">Sin facturas pendientes</p>}
                 </div>
               </section>
             })}
            </div></div>}
           <CollectionStageDialog key={`drop-stage-${pendingDrop?.client.clientId ?? 'closed'}-${pendingDrop?.nextStage ?? ''}`} open={Boolean(pendingDrop)} clientName={pendingDrop?.client.name ?? ''} clientTotal={pendingDrop?.client.totalAmount ?? 0} currentStage={pendingDrop?.currentStage ?? 'TO_MANAGE'} nextStage={pendingDrop?.nextStage ?? null} onOpenChange={open => { if (!open) setPendingDrop(null) }} onSave={saveDroppedStage} />
            <QuickInteractionDialog key={`quick-note-${quickNoteClient?.clientId ?? 'closed'}`} open={Boolean(quickNoteClient)} clientName={quickNoteClient?.name ?? ''} onOpenChange={open => { if (!open) setQuickNoteClient(null) }} onSave={saveQuickInteraction} />
            <CommitmentDialog key={`commitment-${commitmentClient?.clientId ?? 'closed'}-${workflow[commitmentClient?.clientId ?? 0]?.commitment_at ?? 'new'}`} open={Boolean(commitmentClient)} clientName={commitmentClient?.name ?? ''} clientTotal={commitmentClient?.totalAmount ?? 0} workflow={commitmentClient ? workflow[commitmentClient.clientId] : undefined} onOpenChange={open => { if (!open) setCommitmentClient(null) }} onSave={saveCommitment} onClear={removeCommitment} />
           {quickNoteFeedback && <p className="fixed bottom-4 right-4 z-40 border border-[#66856B]/40 bg-[#EDF4EC] px-3 py-2 text-xs text-[#426247] shadow-sm">Nota guardada</p>}
        <p className="mt-2 text-[10px] text-[#322D29]/45">Vencida según Bsale: vencimiento anterior al corte. Una factura que vence el día del corte permanece como adeudada.</p>
      </section>

        <Sheet open={Boolean(selectedClient)} onOpenChange={open => { if (!open) { setSelectedClient(null); setSelectedClosed(null); setSelectedDocumentId(null) } }}>
         {selectedClient && <ClientPanel key={selectedClient.clientId} client={clients.find(client => client.clientId === selectedClient.clientId) ?? selectedClient} cutoffDate={cutoffDate} stage={selectedClosed ? 'CLOSED' : workflow[selectedClient.clientId]?.stage ?? 'TO_MANAGE'} historicalClosed={selectedClosed} onStageChange={async input => {
          await updateCollectionStage({ clientId: selectedClient.clientId, ...input })
          setWorkflow(current => ({
            ...current,
            [selectedClient.clientId]: {
              ...current[selectedClient.clientId],
              stage: input.stage,
              commitment_at: input.commitmentAt ?? null,
              commitment_amount: input.commitmentAmount ?? null,
              next_action_at: input.nextActionAt ?? null,
            },
          }))
          }} focusedDocumentId={selectedDocumentId} onPaymentReconciled={(documentId, documentBalance) => {
            setPaymentOverlay(current => [...current.filter(item => item.documentId !== documentId), { clientId: selectedClient.clientId, documentId, pendingAmount: documentBalance, confirmedAt: new Date().toISOString(), paymentId: 0, source: 'COLLECTION_PAYMENT' }])
            if (documentBalance === 0) setSettledDocumentIds(current => current.includes(documentId) ? current : [...current, documentId])
           }} onClose={() => { setSelectedClient(null); setSelectedClosed(null); setSelectedDocumentId(null) }} />}
      </Sheet>
    </main>
  )
}
