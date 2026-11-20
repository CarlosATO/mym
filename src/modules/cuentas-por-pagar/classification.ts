import type {
  PurchaseType,
  ReceiptInvoiceCandidate,
  ReceptionDisplayStatus,
} from './types.ts'

export interface ReceiptClassificationRow {
  id: string
  purchase_order_id: string
  status: string | null
  document_type: string | null
  document_number: string | null
  receiving_type: string | null
}

export interface PurchaseOrderClassificationRow {
  id: string
  correlative: string | null
  po_type: string | null
  status: string | null
  receipt_status: string | null
  is_active: boolean | null
}

const EXCLUDED_PO_STATUSES = new Set(['CANCELADA', 'RECHAZADA', 'BORRADOR'])

export function purchaseTypeLabel(type: PurchaseType | undefined): string {
  return type === 'SERVICES' ? 'Servicio' : 'Productos'
}

export function receptionStatusLabel(
  status: ReceptionDisplayStatus | undefined,
  type: PurchaseType = 'PRODUCTS',
): string {
  if (type === 'SERVICES') {
    return status === 'RECEIVED' ? 'Prestado' : 'Pendiente'
  }
  if (status === 'RECEIVED') return 'Recibido'
  if (status === 'PARTIAL') return 'Parcial'
  return 'Pendiente'
}

function resolvePurchaseOrderReceptionStatus(po: PurchaseOrderClassificationRow): ReceptionDisplayStatus {
  const receiptStatus = (po.receipt_status || '').toUpperCase()
  const poStatus = (po.status || '').toUpperCase()

  if (receiptStatus === 'RECEPCION_TOTAL') return 'RECEIVED'
  if (receiptStatus === 'RECEPCION_PARCIAL') return 'PARTIAL'
  if (receiptStatus === 'PENDIENTE') return 'PENDING'

  if (poStatus === 'RECEPCION_TOTAL') return 'RECEIVED'
  if (poStatus === 'RECEPCION_PARCIAL') return 'PARTIAL'
  return 'PENDING'
}

export function classifyAndFilterReceiptCandidates(
  candidates: ReceiptInvoiceCandidate[],
  receiptsById: Map<string, ReceiptClassificationRow>,
  purchaseOrdersById: Map<string, PurchaseOrderClassificationRow>,
): ReceiptInvoiceCandidate[] {
  const result: ReceiptInvoiceCandidate[] = []

  for (const candidate of candidates) {
    const receiptIds = Array.isArray(candidate.receipt_ids) ? candidate.receipt_ids : []
    const validReceipts: ReceiptClassificationRow[] = []
    const linkedPos = new Map<string, PurchaseOrderClassificationRow>()

    for (const receiptId of receiptIds) {
      const receipt = receiptsById.get(receiptId)
      if (!receipt) continue
      if (receipt.status !== 'COMPLETED') continue
      if (receipt.document_type !== 'FA') continue
      if (!receipt.document_number || !receipt.document_number.trim()) continue
      if ((receipt.receiving_type || '').toUpperCase() !== 'WAREHOUSE') continue

      const po = purchaseOrdersById.get(receipt.purchase_order_id)
      if (!po) continue
      if (po.is_active === false) continue
      if ((po.po_type || '').toUpperCase() === 'SERVICIOS') continue
      if (po.status && EXCLUDED_PO_STATUSES.has(po.status.toUpperCase())) continue

      const poReception = resolvePurchaseOrderReceptionStatus(po)
      if (poReception === 'PENDING') continue

      validReceipts.push(receipt)
      linkedPos.set(po.id, po)
    }

    // Excluir filas que no tengan recepciones FA válidas de productos (p. ej. servicios, solo GD, OC canceladas o pendientes sin recepción).
    if (validReceipts.length === 0 || linkedPos.size === 0) {
      continue
    }

    const pos = Array.from(linkedPos.values())
    const purchaseType: PurchaseType = 'PRODUCTS'

    const poReceptionStates = pos.map(resolvePurchaseOrderReceptionStatus)
    let receptionStatus: ReceptionDisplayStatus
    if (poReceptionStates.every(state => state === 'RECEIVED')) {
      receptionStatus = 'RECEIVED'
    } else if (poReceptionStates.some(state => state === 'PARTIAL' || state === 'RECEIVED')) {
      receptionStatus = 'PARTIAL'
    } else {
      receptionStatus = 'PENDING'
    }

    result.push({
      ...candidate,
      purchase_type: purchaseType,
      reception_status: receptionStatus,
    })
  }

  return result
}
