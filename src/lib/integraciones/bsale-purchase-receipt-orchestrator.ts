import { createAdminClient } from '@/lib/supabase/admin'
import { createBsalePurchaseReceiptDependencies } from './bsale-purchase-receipt-adapter'
import { chooseUniqueReconciliationCandidate, reconcilePurchaseReceipt, sendPurchaseReceipt, type PurchaseReceiptPayload } from './bsale-purchase-receipt-core'

type Operation = { operation_id: string; status: 'PREPARED' | 'SENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILIATION_REQUIRED'; reception_id: number | null; error: string | null; payload: PurchaseReceiptPayload | null }
function parse(value: unknown): Operation { return value as Operation }

async function finish(db: ReturnType<typeof createAdminClient>, id: string, result: { status: string; receptionId: number | null; error: string | null }) {
  const { data, error } = await db.schema('integraciones').rpc('finish_bsale_purchase_receipt_operation', { p_operation_id: id, p_status: result.status, p_reception_id: result.receptionId, p_error: result.error })
  if (error) throw new Error(error.message)
  return parse(data)
}

export async function syncPurchaseReceipt(companyId: string, userId: string, receiptId: string) {
  const db = createAdminClient()
  const { data: prepared, error: prepareError } = await db.schema('integraciones').rpc('prepare_bsale_purchase_receipt_operation', { p_purchase_receipt_id: receiptId, p_user_id: userId })
  if (prepareError) return { status: 'FAILED' as const, operationId: '', receptionId: null, error: prepareError.message, payload: null }
  const operation = parse(prepared)
  if (operation.status === 'CONFIRMED') return { status: 'CONFIRMED' as const, operationId: operation.operation_id, receptionId: operation.reception_id, error: null, payload: operation.payload }
  if (operation.status === 'FAILED') {
    const { error } = await db.schema('integraciones').rpc('retry_failed_bsale_purchase_receipt_operation', { p_operation_id: operation.operation_id, p_user_id: userId })
    if (error) return { status: 'FAILED' as const, operationId: operation.operation_id, receptionId: null, error: error.message, payload: operation.payload }
    return syncPurchaseReceipt(companyId, userId, receiptId)
  }
  if (operation.status === 'RECONCILIATION_REQUIRED') return reconcilePurchaseReceiptOperation(companyId, userId, operation.operation_id)
  if (operation.status === 'SENDING') return { status: 'SENDING' as const, operationId: operation.operation_id, receptionId: operation.reception_id, error: operation.error, payload: operation.payload }
  const { data: claim, error: claimError } = await db.schema('integraciones').rpc('claim_bsale_purchase_receipt_operation', { p_operation_id: operation.operation_id })
  if (claimError) return { status: 'RECONCILIATION_REQUIRED' as const, operationId: operation.operation_id, receptionId: null, error: claimError.message, payload: operation.payload }
  if (!(claim as { claimed?: boolean }).claimed) return { status: 'SENDING' as const, operationId: operation.operation_id, receptionId: operation.reception_id, error: 'Otra solicitud está enviando esta recepción.', payload: operation.payload }
  const result = await sendPurchaseReceipt(operation.payload as PurchaseReceiptPayload, createBsalePurchaseReceiptDependencies(companyId))
  const completed = await finish(db, operation.operation_id, result)
  return { status: completed.status === 'CONFIRMED' ? 'CONFIRMED' as const : completed.status === 'FAILED' ? 'FAILED' as const : 'RECONCILIATION_REQUIRED' as const, operationId: completed.operation_id, receptionId: completed.reception_id, error: completed.error, payload: completed.payload }
}

export async function reconcilePurchaseReceiptOperation(companyId: string, userId: string, operationId: string) {
  const db = createAdminClient()
  const { data: row, error } = await db.schema('integraciones').from('bsale_purchase_receipt_operations').select('id,status,bsale_reception_id,payload_snapshot,purchase_receipt_id,company_id').eq('id', operationId).eq('company_id', companyId).single()
  if (error || !row) return { status: 'RECONCILIATION_REQUIRED' as const, operationId, receptionId: null, error: error?.message ?? 'Operación no encontrada.', payload: null }
  const snapshot = row.payload_snapshot as PurchaseReceiptPayload
  const remote = createBsalePurchaseReceiptDependencies(companyId)
  let result
  if (row.bsale_reception_id != null) {
    result = await reconcilePurchaseReceipt(snapshot, remote, Number(row.bsale_reception_id))
  } else {
    const candidates = await remote.findReceptions(snapshot.documentNumber, snapshot.officeId)
    const compatible: number[] = []
    for (const candidate of candidates) {
      const id = Number(candidate.id)
      if (!Number.isSafeInteger(id)) continue
      const checked = await reconcilePurchaseReceipt(snapshot, remote, id)
      if (checked.status === 'CONFIRMED') compatible.push(id)
    }
    const uniqueCandidate = chooseUniqueReconciliationCandidate(compatible)
    result = uniqueCandidate !== null
      ? { status: 'CONFIRMED' as const, receptionId: uniqueCandidate, error: null }
      : { status: 'RECONCILIATION_REQUIRED' as const, receptionId: null, error: compatible.length > 1 ? 'Existen múltiples candidatos BSale compatibles.' : 'No existe un candidato BSale compatible; se requiere reintento explícito.', }
  }
  if (result.status !== 'CONFIRMED') return { status: 'RECONCILIATION_REQUIRED' as const, operationId, receptionId: result.receptionId, error: result.error, payload: snapshot }
  const completed = await finish(db, operationId, result)
  return { status: 'CONFIRMED' as const, operationId, receptionId: completed.reception_id, error: null, payload: snapshot }
}

export async function getPurchaseReceiptOperation(companyId: string, receiptId: string, userId?: string) {
  const db = createAdminClient()
  const { data } = await db.schema('integraciones').from('bsale_purchase_receipt_operations').select('id,status,bsale_reception_id,error_message,payload_snapshot').eq('company_id', companyId).eq('purchase_receipt_id', receiptId).maybeSingle()
  if (!data && userId) {
    const { data: prepared } = await db.schema('integraciones').rpc('prepare_bsale_purchase_receipt_operation', { p_purchase_receipt_id: receiptId, p_user_id: userId })
    if (prepared) {
      const operation = parse(prepared)
      return { status: operation.status, operationId: operation.operation_id, receptionId: operation.reception_id, error: operation.error, payload: operation.payload }
    }
  }
  if (!data) return { status: 'PENDING' as const, operationId: null, receptionId: null, error: null, payload: null }
  return { status: data.status, operationId: data.id, receptionId: data.bsale_reception_id, error: data.error_message, payload: data.payload_snapshot }
}
