export interface ReceiptInvoiceCandidate {
  candidate_id: string
  issuer_rut: string | null
  supplier_name: string
  folio: string | null
  issue_date: string | null
  purchase_orders: string[]
  receipt_ids: string[]
  reference_amount: number | null
  has_document: boolean
  invoice_id: string | null
  invoice_status: string | null
  blocked_reason: string | null
}
