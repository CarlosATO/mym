export type DirectedBsaleDocumentStatus =
  | 'READY'
  | 'NOT_FOUND'
  | 'INVALID_DOCUMENT'
  | 'AMBIGUOUS'
  | 'DETAILS_UNAVAILABLE'
  | 'CUSTOMER_UNAVAILABLE'
  | 'ERROR'

export interface DirectedBsaleDocumentResult {
  invoice_number: string
  status: DirectedBsaleDocumentStatus
  bsale_document_id?: number
  customer_bsale_id?: number | null
  details_count?: number
  error?: string
  customer_identity_updated?: number
  settlement_identity_updated?: number
}

export interface DirectedBsaleSyncResult {
  success: boolean
  requested: number
  ready: number
  missing: number
  documents: DirectedBsaleDocumentResult[]
  error?: string
}

export type WarehouseFullRefreshResult = {
  success: boolean
  status: 'COMPLETED' | 'FAILED' | 'PARTIAL' | 'SKIPPED_LOCKED'
  runId?: string
  metrics?: Record<string, number>
  error?: string
}
