export type PriorPaymentStatus =
  | 'UNREVIEWED'
  | 'NO_PRIOR_PAYMENTS'
  | 'PARTIAL_PRIOR_PAYMENTS'
  | 'FULLY_PAID_PRIOR'

export type DiscrepancyStatus = 'NONE' | 'UNRESOLVED' | 'RESOLVED'

export type InvoiceValidationStatus = 'PENDING' | 'VALIDATED' | 'REJECTED'

export type PurchaseType = 'PRODUCTS' | 'SERVICES'

export type ReceptionDisplayStatus = 'RECEIVED' | 'PARTIAL' | 'PENDING'

export type ServiceDeliveryStatus = 'DELIVERED' | 'PENDING'

export interface ServiceSupplierOption {
  id: string
  business_name: string
  fantasy_name: string | null
  rut: string | null
  payment_terms: string | null
  credit_days: number | null
}

export interface ServiceInvoiceRow {
  id: string
  issuer_rut: string
  supplier_id: string
  supplier_name: string
  folio: string
  issue_date: string
  due_date: string | null
  net_amount: number | null
  tax_amount: number | null
  total_amount: number | null
  service_description: string | null
  service_delivery_status: ServiceDeliveryStatus
  has_document: boolean
  validation_status: InvoiceValidationStatus
  prior_payment_status: PriorPaymentStatus
  historical_initial_balance: number | null
  discrepancy_status: DiscrepancyStatus
  validated_at: string | null
}

export interface CreateServiceInvoiceResult {
  id: string
  issuer_rut: string
  supplier_id: string
  supplier_name: string
  document_folio: string
  issue_date: string
  due_date: string
  net_amount: number
  tax_amount: number
  total_amount: number
  purchase_type: 'SERVICES'
  service_description: string
  service_delivery_status: ServiceDeliveryStatus
  validation_status: InvoiceValidationStatus
  has_document: boolean
}

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
  purchase_type?: PurchaseType
  reception_status?: ReceptionDisplayStatus
  service_description?: string | null
}

export interface InvoiceInboxSummary {
  id: string
  validation_status: InvoiceValidationStatus
  issue_date: string
  due_date: string | null
  net_amount: number | null
  tax_amount: number | null
  total_amount: number | null
  prior_payment_status: PriorPaymentStatus
  historical_initial_balance: number | null
  historical_balance_cutoff_date: string | null
  discrepancy_status: DiscrepancyStatus
  validated_at: string | null
}

export interface InvoiceReceiptDocument {
  id: string
  receipt_id: string
  receipt_number: string | null
  document_number: string | null
  file_name: string | null
  mime_type: string | null
  has_file: boolean
}

export interface InvoiceLinkedPurchaseOrder {
  id: string
  correlative: string
  issue_date: string | null
  status: string | null
  receipt_status: string | null
  payment_terms: string | null
  grand_total: number | null
}

export interface InvoiceLinkedReceipt {
  id: string
  receipt_number: string
  receiving_type: string
  status: string
  received_at: string | null
  document_type: string | null
  document_number: string | null
  document_date: string | null
  receipt_total_net: number | null
  receipt_total_tax: number | null
  receipt_total_gross: number | null
  purchase_order_id: string
  purchase_order_correlative: string
  documents: InvoiceReceiptDocument[]
}

export interface InvoiceReferenceSummary {
  linked_receipts_count: number
  cancelled_linked_receipts_count: number
  unlinked_completed_receipts_count: number
  reference_net_amount: number
  reference_tax_amount: number
  reference_gross_amount: number
  reference_gross_rounded: number
  receipt_document_dates: string[]
  missing_receipt_dates_count: number
}

export interface InvoiceDetail {
  invoice: {
    id: string
    company_id: string
    supplier_id: string
    issuer_rut: string
    document_type: string
    document_folio: string
    issue_date: string
    due_date: string | null
    net_amount: number | null
    tax_amount: number | null
    total_amount: number | null
    prior_payment_status: PriorPaymentStatus
    historical_initial_balance: number | null
    historical_balance_cutoff_date: string | null
    discrepancy_status: DiscrepancyStatus
    discrepancy_resolution_note: string | null
    origin: 'MANUAL' | 'RECEIPT' | 'HISTORICAL_IMPORT'
    purchase_type?: PurchaseType
    service_description?: string | null
    service_delivery_status?: ServiceDeliveryStatus | null
    validation_status: InvoiceValidationStatus
    validated_at: string | null
    validated_by: string | null
    validated_by_name: string | null
  }
  supplier: {
    id: string
    business_name: string
    fantasy_name: string | null
    rut: string | null
    payment_terms: string | null
    credit_days: number | null
  }
  purchase_orders: InvoiceLinkedPurchaseOrder[]
  receipts: InvoiceLinkedReceipt[]
  documents: InvoiceReceiptDocument[]
  reference: InvoiceReferenceSummary
}

export interface SaveInvoiceValidationInput {
  invoiceId: string
  issueDate: string
  dueDate: string | null
  netAmount: number | null
  taxAmount: number | null
  totalAmount: number | null
  priorPaymentStatus: PriorPaymentStatus
  historicalInitialBalance: number | null
  historicalBalanceCutoffDate: string | null
  resolveDiscrepancy: boolean
  discrepancyResolutionNote: string | null
  confirmValidation: boolean
}

export interface SaveInvoiceValidationResult {
  id: string
  validation_status: InvoiceValidationStatus
  issue_date: string
  due_date: string | null
  net_amount: number | null
  tax_amount: number | null
  total_amount: number | null
  prior_payment_status: PriorPaymentStatus
  historical_initial_balance: number | null
  historical_balance_cutoff_date: string | null
  discrepancy_status: DiscrepancyStatus
  discrepancy_resolution_note: string | null
  validated_at: string | null
  validated_by: string | null
  reference_gross_amount: number
  reference_gross_rounded: number
  amount_difference: number | null
  has_amount_discrepancy: boolean
  has_date_discrepancy: boolean
}

export interface ReceiptDocumentSignedLink {
  signedUrl: string
  downloadUrl: string
  fileName: string
  mimeType: string
  expiresIn: number
}
