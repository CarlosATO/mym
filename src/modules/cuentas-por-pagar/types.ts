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
  due_date?: string | null
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

export interface InboxDocument {
  id: string
  document_number: string | null
  file_name: string | null
  mime_type: string | null
  has_file: boolean
}

export type InvoicePaymentStatus = 'ACTIVE' | 'REVERSED'

export interface InvoicePaymentReversal {
  id: string
  company_id?: string
  invoice_id?: string
  payment_id?: string
  reason: string
  operation_id: string
  created_at: string
  created_by: string
  created_by_name?: string | null
}

export interface InvoicePaymentRecord {
  id: string
  company_id: string
  invoice_id: string
  payment_date: string
  amount: number
  reference: string | null
  operation_id: string
  created_at: string
  created_by: string
  created_by_name?: string | null
  is_reversed: boolean
  status: InvoicePaymentStatus
  reversal: InvoicePaymentReversal | null
}

export interface InvoicePaymentBalanceSummary {
  invoice_id: string
  company_id: string
  validation_status: InvoiceValidationStatus
  total_amount: number | null
  credit_note_amount_clp?: number
  net_payable_amount?: number | null
  prior_payment_status: PriorPaymentStatus
  historical_initial_balance: number | null
  historical_balance_cutoff_date: string | null
  initial_balance: number | null
  prior_paid_amount: number | null
  module_paid_amount: number
  total_paid_amount: number | null
  current_balance: number | null
  payment_count: number
  reversed_payment_count: number
  reversed_amount: number
  is_fully_paid: boolean
  can_register_payment: boolean
}

export interface InvoicePaymentsHistory extends InvoicePaymentBalanceSummary {
  payments: InvoicePaymentRecord[]
}

export interface RegisterInvoicePaymentInput {
  invoiceId: string
  paymentDate: string
  amount: number
  reference?: string | null
  operationId: string
}

export interface ReverseInvoicePaymentInput {
  paymentId: string
  operationId: string
  reason: string
}

export interface ReopenInvoiceValidationInput {
  invoiceId: string
  operationId: string
  reason: string
}

export interface InvoiceValidationReopeningRecord {
  id: string
  company_id: string
  invoice_id: string
  reason: string
  operation_id: string
  previous_validation_status: InvoiceValidationStatus
  previous_prior_payment_status: PriorPaymentStatus
  previous_total_amount: number | null
  previous_validated_at: string | null
  previous_validated_by: string | null
  created_at: string
  created_by: string
}

export type PaymentActionErrorCode =
  | 'OVERPAYMENT'
  | 'INVOICE_NOT_VALIDATED'
  | 'ALREADY_REVERSED'
  | 'HAS_ACTIVE_PAYMENTS'
  | 'ACCESS_DENIED'
  | 'INVALID_DATE'
  | 'VALIDATION_ERROR'
  | 'CONNECTION_OR_UNKNOWN_ERROR'

export type GetInvoicePaymentsResult =
  | {
      ok: true
      data: InvoicePaymentsHistory
    }
  | {
      ok: false
      code: PaymentActionErrorCode
      error: string
      uncertainOutcome: boolean
    }

export type RegisterInvoicePaymentResult =
  | {
      ok: true
      code: 'PAYMENT_REGISTERED' | 'IDEMPOTENT_REPLAY'
      idempotentReplay: boolean
      operationId: string
      payment: InvoicePaymentRecord
      balance: InvoicePaymentBalanceSummary
    }
  | {
      ok: false
      code: PaymentActionErrorCode
      error: string
      uncertainOutcome: boolean
      operationId: string
    }

export type ReverseInvoicePaymentResult =
  | {
      ok: true
      code: 'REVERSAL_REGISTERED' | 'IDEMPOTENT_REPLAY'
      idempotentReplay: boolean
      operationId: string
      reversal: InvoicePaymentReversal
      payment: InvoicePaymentRecord
      balance: InvoicePaymentBalanceSummary
    }
  | {
      ok: false
      code: PaymentActionErrorCode
      error: string
      uncertainOutcome: boolean
      operationId: string
    }

export type ReopenInvoiceValidationResult =
  | {
      ok: true
      code: 'VALIDATION_REOPENED' | 'IDEMPOTENT_REPLAY'
      idempotentReplay: boolean
      operationId: string
      reopening: InvoiceValidationReopeningRecord
      balance: InvoicePaymentBalanceSummary
    }
  | {
      ok: false
      code: PaymentActionErrorCode
      error: string
      uncertainOutcome: boolean
      operationId: string
    }
