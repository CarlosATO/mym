export type FundClosureStatus = 'OPEN' | 'PARTIAL' | 'CLOSED' | 'WITH_DIFFERENCE' | 'CANCELLED';

export interface RouteFundClosure {
  id: string;
  company_id: string;
  closure_number: string;
  closure_year: number;
  closure_sequence: number;
  status: FundClosureStatus;
  
  total_cash_received: number;
  total_check_received: number;
  total_expenses: number;
  total_deposits: number;
  total_pending: number;
  difference_amount: number;
  
  notes: string | null;
  
  created_by: string;
  updated_by: string | null;
  closed_by: string | null;
  cancelled_by: string | null;
  
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  cancelled_at: string | null;
}

export interface RouteFundClosureItem {
  id: string;
  company_id: string;
  fund_closure_id: string;
  route_settlement_item_id: string;
  route_settlement_id: string;
  route_guide_id: string;
  
  invoice_number: string;
  customer_name: string;
  payment_method: 'CASH' | 'CHECK';
  amount: number;
  
  released_at: string | null;
  released_by: string | null;
  release_reason: string | null;
  
  created_at: string;
}

export interface RouteFundClosureExpense {
  id: string;
  company_id: string;
  fund_closure_id: string;
  route_guide_id: string;
  expense_scope: 'GUIDE' | 'ITEMS';
  expense_type: string;
  amount: number;
  expense_date: string;
  notes: string | null;
  
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RouteFundClosureDeposit {
  id: string;
  company_id: string;
  fund_closure_id: string;
  deposit_method: 'DEPOSIT' | 'CASH_DELIVERY' | 'TRANSFER' | 'OTHER';
  amount: number;
  deposit_date: string;
  reference_number: string | null;
  notes: string | null;
  attachment_required: boolean;
  
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PendingRouteFund {
  route_settlement_item_id: string;
  route_settlement_id: string;
  route_guide_id: string;
  invoice_number: string;
  customer_name: string;
  payment_method: string;
  amount: number;
  guide_number: string | null;
  settlement_number: string | null;
}
