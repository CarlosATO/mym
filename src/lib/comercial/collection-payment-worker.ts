import { bsaleFetchForCompany } from '@/lib/bsale/client'
import { calendarDateToUnixSeconds, createCollectionPaymentGateway, dedupeCollectionPaymentApplications, findUnpaidDocument, type CollectionPayment } from '@/lib/bsale/collection-payments'
import { closeCollectionCustomer, resolveUnknownCollectionPaymentInternal as recoverCollectionPayment, reconcileCollectionPayment as reconcileWorkflowPayment } from '@/app/actions/comercial/cobranza-workflow'
import { createAdminClient } from '@/lib/supabase/admin'

const LEASE_SECONDS = 120
const admin = () => createAdminClient()
const comercial = () => admin().schema('comercial')

type Batch = { id: string; company_id: string; client_id: number; payment_type_id: number; record_date: string; expected_total: number; confirmed_total: number; created_by: string | null; worker_token: string; status: string; metadata?: Record<string, unknown> }
type Attempt = { id: string; batch_id: string; company_id: string; client_id: number; bsale_document_id: number; amount: number; payment_type_id: number; record_date: string; status: string; sequence_number: number; created_at: string; post_started_at: string | null; preflight_balance: number | null }

async function audit(batch: Batch, attempt: Attempt | null, eventType: string, metadata: Record<string, unknown> = {}) {
  await admin().schema('portal').from('audit_logs').insert({
    table_name: attempt ? 'collection_payment_attempts' : 'collection_payment_batches', record_id: attempt?.id ?? batch.id,
    action: 'STATUS_CHANGE', performed_by: batch.created_by, schema_name: 'comercial', module_code: 'ANALISIS_COMERCIAL_COBRANZA',
    event_type: eventType, severity: 'INFO', metadata: { batch_id: batch.id, worker_token: batch.worker_token, ...(attempt ? { attempt_id: attempt.id, sequence_number: attempt.sequence_number, document_id: attempt.bsale_document_id, amount: attempt.amount } : {}), ...metadata },
  })
}

async function updateAttempt(batch: Batch, attempt: Attempt, values: Record<string, unknown>) {
  const { data: ownedBatch, error: ownershipError } = await comercial().from('collection_payment_batches').select('id').eq('id', batch.id).eq('worker_token', batch.worker_token).maybeSingle()
  if (ownershipError || !ownedBatch) throw new Error(ownershipError?.message ?? 'El lease del batch ya no pertenece al worker.')
  const { data, error } = await comercial().from('collection_payment_attempts').update(values).eq('id', attempt.id).eq('batch_id', batch.id).eq('status', attempt.status).select('id').maybeSingle()
  if (error || !data) throw new Error(error?.message ?? 'El intento cambió mientras se procesaba.')
}

async function preflight(batch: Batch, attempt: Attempt) {
  const gateway = createCollectionPaymentGateway(batch.company_id)
  const unpaid = await gateway.getUnpaidDocuments(batch.client_id)
  const liveDocument = findUnpaidDocument(unpaid, attempt.bsale_document_id)
  const liveBalance = Number(liveDocument?.totalAmountOwed ?? 0)
  const types = await bsaleFetchForCompany<{ id: number; active?: boolean; state?: number }>({ companyId: batch.company_id, path: '/payment_types.json' })
  const configured = await comercial().from('collection_payment_type_config').select('bsale_payment_type_id').eq('company_id', batch.company_id).eq('enabled', true)
  if (configured.error) throw new Error(configured.error.message)
  const validType = (configured.data ?? []).some(row => Number(row.bsale_payment_type_id) === attempt.payment_type_id)
    && (types.items ?? []).some(type => type.id === attempt.payment_type_id && type.active !== false && type.state !== 1)
  if (!liveDocument || liveBalance <= 0 || !validType || Math.abs(liveBalance - Number(attempt.amount)) >= 0.01) {
    return { ok: false as const, liveBalance, message: 'Saldo Bsale cambió antes del pago. No se realizó POST.' }
  }
  return { ok: true as const, liveBalance, clientId: batch.client_id }
}

async function finalize(batch: Batch, attempt: Attempt, stopOnPending = false) {
  if (stopOnPending) {
    const { error: cancelError } = await comercial().from('collection_payment_attempts').update({ status: 'CANCELLED', error_message: 'Cancelado porque un intento anterior terminalizó el batch.', updated_at: new Date().toISOString() }).eq('batch_id', batch.id).eq('status', 'CREATED').gt('sequence_number', attempt.sequence_number)
    if (cancelError) throw new Error(cancelError.message)
  }
  const { data: rows, error } = await comercial().from('collection_payment_attempts').select('status,amount').eq('batch_id', batch.id)
  if (error) throw new Error(error.message)
  const confirmedTotal = (rows ?? []).filter(row => row.status === 'CONFIRMED').reduce((sum, row) => sum + Number(row.amount ?? 0), 0)
  const pending = (rows ?? []).some(row => ['CREATED', 'SUBMITTING'].includes(String(row.status)))
  const unknown = (rows ?? []).some(row => ['UNKNOWN', 'REQUIRES_REVIEW'].includes(String(row.status)))
  const failed = (rows ?? []).some(row => row.status === 'FAILED')
  const status = unknown ? 'UNKNOWN' : pending && !stopOnPending ? 'PROCESSING' : failed ? (confirmedTotal > 0 ? 'PARTIAL' : 'FAILED') : 'COMPLETED'
  const values: Record<string, unknown> = { confirmed_total: confirmedTotal, status, completed_at: status === 'PROCESSING' || status === 'UNKNOWN' ? null : new Date().toISOString(), updated_at: new Date().toISOString(), worker_token: status === 'PROCESSING' || status === 'UNKNOWN' ? null : null, lease_expires_at: null }
  const { error: updateError } = await comercial().from('collection_payment_batches').update(values).eq('id', batch.id).eq('worker_token', batch.worker_token)
  if (updateError) throw new Error(updateError.message)
  if (status === 'COMPLETED') await audit(batch, attempt, 'COLLECTION_PAYMENT_BATCH_COMPLETED', { confirmed_total: confirmedTotal })
  if (status === 'PARTIAL') await audit(batch, attempt, 'COLLECTION_PAYMENT_BATCH_PARTIAL', { confirmed_total: confirmedTotal })
  if (status === 'FAILED') await audit(batch, attempt, 'COLLECTION_PAYMENT_BATCH_FAILED', { confirmed_total: confirmedTotal })
  return { status, confirmedTotal, pending: pending || unknown, remainingDocuments: (rows ?? []).filter(row => row.status === 'CREATED').length }
}

export async function runCollectionPaymentWorker() {
  const claim = await admin().schema('comercial').rpc('claim_collection_payment_batch', { p_lease_seconds: LEASE_SECONDS })
  if (claim.error) throw new Error(claim.error.message)
  const claimed = claim.data as { processed: boolean; reason?: string; batchId?: string; workerToken?: string }
  if (!claimed.processed) return { processed: false as const, reason: claimed.reason ?? 'NO_WORK' }
  const { data: batch, error: batchError } = await comercial().from('collection_payment_batches').select('id,company_id,client_id,payment_type_id,record_date,expected_total,confirmed_total,created_by,worker_token,status,metadata').eq('id', claimed.batchId as string).eq('worker_token', claimed.workerToken as string).single()
  if (batchError || !batch) throw new Error(batchError?.message ?? 'No se pudo leer el batch reclamado.')
  const current = batch as Batch
  const { data: attempt, error: attemptError } = await comercial().from('collection_payment_attempts').select('id,batch_id,company_id,client_id,bsale_document_id,amount,payment_type_id,record_date,status,sequence_number,created_at,post_started_at,preflight_balance').eq('batch_id', current.id).order('sequence_number', { ascending: true }).in('status', ['CREATED', 'SUBMITTING', 'UNKNOWN', 'REQUIRES_REVIEW', 'FAILED']).limit(1).maybeSingle()
  if (attemptError) throw new Error(attemptError.message)
  if (!attempt) { const result = await finalize(current, null as unknown as Attempt); return { processed: true as const, batchId: current.id, batchStatus: result.status, confirmedTotal: result.confirmedTotal } }
  const row = attempt as Attempt
  await audit(current, row, 'COLLECTION_PAYMENT_ATTEMPT_PROCESSING')
  if (['UNKNOWN', 'REQUIRES_REVIEW'].includes(row.status)) {
    await comercial().from('collection_payment_batches').update({ status: 'UNKNOWN', worker_token: null, lease_expires_at: null, completed_at: null, updated_at: new Date().toISOString() }).eq('id', current.id).eq('worker_token', current.worker_token)
    await audit(current, row, 'COLLECTION_PAYMENT_UNKNOWN')
    return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: 'UNKNOWN', attemptStatus: row.status, requiresReview: true }
  }
  if (row.status === 'FAILED') { const result = await finalize(current, row, true); return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: result.status, attemptStatus: row.status, confirmedTotal: result.confirmedTotal } }
  if (row.status === 'SUBMITTING') {
    if (!row.post_started_at) {
      await updateAttempt(current, row, { status: 'REQUIRES_REVIEW', error_message: 'SUBMITTING sin post_started_at: estado inconsistente.', updated_at: new Date().toISOString() })
      await audit(current, row, 'COLLECTION_PAYMENT_UNKNOWN', { inconsistent: true })
      return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: 'UNKNOWN', attemptStatus: 'REQUIRES_REVIEW', requiresReview: true }
    }
    await updateAttempt(current, row, { status: 'UNKNOWN', updated_at: new Date().toISOString() })
    let recovery: Awaited<ReturnType<typeof recoverCollectionPayment>>
    try {
      recovery = await recoverCollectionPayment({ companyId: current.company_id, userId: current.created_by ?? '00000000-0000-0000-0000-000000000000', attempt: { ...row, status: 'UNKNOWN', execution_mode: 'ASYNC_V1', refreshBatch: false } })
    } catch (cause) {
      const { error: batchError } = await comercial().from('collection_payment_batches').update({ status: 'UNKNOWN', worker_token: null, lease_expires_at: null, completed_at: null, updated_at: new Date().toISOString() }).eq('id', current.id).eq('worker_token', current.worker_token)
      if (batchError) throw new Error(batchError.message)
      await audit(current, row, 'COLLECTION_PAYMENT_UNKNOWN', { recovery_error: cause instanceof Error ? cause.message.slice(0, 300) : 'Error de recuperación live' })
      return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: 'UNKNOWN', attemptStatus: 'UNKNOWN', requiresReview: true }
    }
    if (recovery.outcome === 'CONFIRMED') { const result = await finalize(current, row); return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: result.status, attemptStatus: 'CONFIRMED', confirmedTotal: result.confirmedTotal } }
    if (recovery.outcome === 'FAILED') { const result = await finalize(current, row, true); return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: result.status, attemptStatus: 'FAILED', confirmedTotal: result.confirmedTotal } }
    await comercial().from('collection_payment_batches').update({ status: 'UNKNOWN', worker_token: null, lease_expires_at: null, completed_at: null }).eq('id', current.id).eq('worker_token', current.worker_token)
    return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: 'UNKNOWN', attemptStatus: 'UNKNOWN', requiresReview: true }
  }
  const check = await preflight(current, row)
  if (!check.ok) { await updateAttempt(current, row, { status: 'FAILED', error_message: check.message, preflight_balance: check.liveBalance, updated_at: new Date().toISOString() }); const result = await finalize(current, row, true); return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: result.status, attemptStatus: 'FAILED', confirmedTotal: result.confirmedTotal, remainingDocuments: result.remainingDocuments } }
  const recordDateUnix = calendarDateToUnixSeconds(current.record_date)
  const requestPayload = { recordDate: current.record_date, recordDateUnix, amount: Number(row.amount), documentId: row.bsale_document_id, paymentTypeId: row.payment_type_id }
  const checkpoint = await comercial().rpc('mark_collection_payment_attempt_submitting', { p_batch_id: current.id, p_attempt_id: row.id, p_worker_token: current.worker_token, p_preflight_balance: check.liveBalance, p_request_payload: requestPayload })
  if (checkpoint.error) throw new Error(checkpoint.error.message)
  if (!(checkpoint.data as { ok?: boolean }).ok) return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: 'PROCESSING', attemptStatus: 'CREATED', requiresReview: false, reason: 'STALE_LEASE' }
  const gateway = createCollectionPaymentGateway(current.company_id)
  let response: CollectionPayment
  let paymentId: number
  let reconciled: Awaited<ReturnType<typeof reconcileWorkflowPayment>>
  try {
    response = await gateway.createPayment({ ...requestPayload, recordDate: recordDateUnix })
    paymentId = Number(response.id)
    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      const candidates = (await gateway.getDocumentPayments(row.bsale_document_id)).filter(payment => Number(payment.amount ?? 0) === Number(row.amount) && Number(payment.payment_type?.id ?? payment.paymentTypeId) === row.payment_type_id && dedupeCollectionPaymentApplications(payment, row.bsale_document_id).some(item => item.documentId === row.bsale_document_id && Math.abs(item.amount - Number(row.amount)) < 0.01))
      const ids = [...new Set(candidates.map(payment => Number(payment.id)).filter(Number.isInteger))]
      if (ids.length !== 1) {
        await updateAttempt(current, { ...row, status: 'SUBMITTING' }, { status: 'REQUIRES_REVIEW', error_message: 'Respuesta Bsale sin payment id y coincidencia no inequívoca.', payment_response: response, updated_at: new Date().toISOString() })
        await comercial().from('collection_payment_batches').update({ status: 'UNKNOWN', worker_token: null, lease_expires_at: null, completed_at: null }).eq('id', current.id).eq('worker_token', current.worker_token)
        return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: 'UNKNOWN', attemptStatus: 'REQUIRES_REVIEW', requiresReview: true }
      }
      paymentId = ids[0]
    }
    reconciled = await reconcileWorkflowPayment({ companyId: current.company_id, clientId: current.client_id, documentId: row.bsale_document_id, paymentId, gateway, recordDate: current.record_date })
    const { error: confirmedError } = await comercial().from('collection_payment_attempts').update({ status: 'CONFIRMED', bsale_payment_id: paymentId, post_balance: reconciled.postBalance, confirmed_at: new Date().toISOString(), payment_response: response, updated_at: new Date().toISOString() }).eq('id', row.id).eq('batch_id', current.id).eq('status', 'SUBMITTING')
    if (confirmedError) throw new Error(confirmedError.message)
  } catch (cause) {
    const { error: unknownError } = await comercial().from('collection_payment_attempts').update({ status: 'UNKNOWN', error_message: cause instanceof Error ? cause.message.slice(0, 500) : 'Error Bsale o reconciliación', updated_at: new Date().toISOString() }).eq('id', row.id).eq('batch_id', current.id).eq('status', 'SUBMITTING')
    if (unknownError) throw new Error(unknownError.message)
    const { error: batchError } = await comercial().from('collection_payment_batches').update({ status: 'UNKNOWN', worker_token: null, lease_expires_at: null, completed_at: null, updated_at: new Date().toISOString() }).eq('id', current.id).eq('worker_token', current.worker_token)
    if (batchError) throw new Error(batchError.message)
    await audit(current, row, 'COLLECTION_PAYMENT_UNKNOWN')
    return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: 'UNKNOWN', attemptStatus: 'UNKNOWN', requiresReview: true }
  }
  await audit(current, row, 'COLLECTION_PAYMENT_CONFIRMED', { bsale_payment_id: paymentId })
  if (reconciled.clientBalance === 0) await closeCollectionCustomer(current.company_id, current.created_by ?? '00000000-0000-0000-0000-000000000000', current.client_id, row.bsale_document_id, Number(row.amount), paymentId)
  const result = await finalize(current, row)
  return { processed: true as const, batchId: current.id, attemptId: row.id, sequenceNumber: row.sequence_number, batchStatus: result.status, attemptStatus: 'CONFIRMED', confirmedTotal: result.confirmedTotal, expectedTotal: Number(current.expected_total), remainingDocuments: result.remainingDocuments, requiresReview: false }
}
