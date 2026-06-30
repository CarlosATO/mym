export interface RouteSettlement {
  id: string
  company_id: string
  route_guide_id: string
  settlement_number: string
  settlement_year: number
  settlement_sequence: number
  settlement_date: string
  status: 'IN_REVIEW' | 'SETTLED' | 'SETTLED_WITH_DIFFERENCE' | 'CLOSED' | 'CANCELLED'
  received_by: string
  reviewed_by?: string
  closed_by?: string
  notes?: string

  total_route_amount: number
  total_cash_expected: number
  total_check_expected: number
  total_transfer_expected: number
  total_credit_amount: number

  total_cash_received: number
  total_check_received: number
  total_transfer_confirmed: number

  total_cash_difference: number
  total_check_difference: number
  total_transfer_pending: number

  total_pending: number
  total_difference: number

  total_invoices: number
  paid_count: number
  pending_count: number
  difference_count: number
  transfer_pending_count: number
  check_count: number

  created_by: string
  created_at: string
  updated_at: string
  closed_at?: string

  // joined from guides
  guide_number?: string
  route_name?: string
  driver_name?: string
  seller_name?: string
}

export interface RouteSettlementItem {
  id: string
  company_id: string
  settlement_id: string
  route_guide_item_id: string
  invoice_number: string
  customer_name: string
  expected_payment_method: string
  expected_amount: number
  received_payment_method?: string
  received_amount: number
  difference_amount: number
  status: 'PENDING_PAYMENT' | 'PAID_CASH' | 'TRANSFER_CONFIRMED' | 'TRANSFER_PENDING' | 'CHECK_RECEIVED' | 'CREDIT_REGISTERED' | 'PARTIAL_PAYMENT' | 'DIFFERENCE' | 'NOT_DELIVERED' | 'REVIEW_REQUIRED'
  notes?: string
  transfer_confirmed: boolean
  transfer_confirmed_at?: string
  transfer_reference?: string
  check_received: boolean
  check_bank?: string
  check_number?: string
  check_date?: string
  check_amount?: number
  is_pending: boolean
  requires_followup: boolean
  created_at: string
  updated_at: string
}

export interface PendingRouteGuide {
  id: string
  guide_number: string
  guide_date: string
  route_name_snapshot: string
  vehicle_name_snapshot: string
  driver_name_snapshot: string
  seller_name_snapshot: string
  dispatcher_name_snapshot: string
  total_amount: number
  total_cash_expected: number
  total_check_expected: number
  total_transfer: number
  total_credit: number
  total_invoices: number
}
