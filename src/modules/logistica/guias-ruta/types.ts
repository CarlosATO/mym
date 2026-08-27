export type RouteGuideStatus = 'DRAFT' | 'DISPATCHED' | 'CANCELLED';
export type RoutePersonnelType = 'DRIVER' | 'SELLER' | 'DISPATCHER' | 'OTHER';
export type PaymentMethodNormalized = 'CASH' | 'AL_DIA' | 'CHECK' | 'TRANSFER' | 'CREDIT' | 'UNKNOWN';
export type ValidationStatus = 'VALID' | 'INVALID';
export type SettlementStatus = 'PENDING' | 'NOT_REQUIRED' | 'PENDING_REVIEW';
export type RouteGuideProfitabilityStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
export type RouteGuideProfitabilityLineStatus = 'COSTED' | 'SIN_COSTO';

export interface RouteVehicle {
  id: string;
  company_id: string;
  vehicle_name: string;
  plate_number: string | null;
  description: string | null;
  is_active: boolean;
}

export interface DeliveryRoute {
  id: string;
  company_id: string;
  route_name: string;
  description: string | null;
  is_active: boolean;
}

export interface RoutePersonnel {
  id: string;
  company_id: string;
  person_name: string;
  person_type: RoutePersonnelType;
  phone: string | null;
  email: string | null;
  is_active: boolean;
}

export interface RouteGuideItem {
  id?: string;
  route_guide_id?: string;
  line_number: number;
  invoice_number: string;
  customer_name: string;
  customer_address: string;
  commune: string;
  amount: number | string; // Permitimos string crudo en frontend
  customer_bsale_id?: number | null;
  payment_method_original: string;
  payment_method_normalized: PaymentMethodNormalized;
  requires_settlement: boolean;
  validation_status: ValidationStatus;
  validation_errors: string[];
  notes: string;
  settlement_status?: SettlementStatus;
}

export interface RouteGuide {
  id: string;
  company_id: string;
  guide_number: string;
  guide_date: string; // ISO format
  
  route_id: string;
  route_name_snapshot: string;
  
  vehicle_id: string;
  vehicle_name_snapshot: string;
  
  driver_id: string;
  driver_name_snapshot: string;
  
  seller_id?: string | null;
  seller_name_snapshot?: string | null;
  
  dispatcher_id: string;
  dispatcher_name_snapshot: string;
  
  notes: string;
  status: RouteGuideStatus;
  
  total_invoices: number;
  total_amount: number;
  total_cash_expected: number;
  total_check_expected: number;
  total_credit: number;
  total_transfer: number;
  total_unknown_payment: number;
  
  error_count: number;
  duplicate_count: number;

  version_number?: number;

  items?: RouteGuideItem[]; // Cargado asíncronamente
}

export interface RouteGuideProfitabilityLine {
  document: string;
  document_date: string;
  bsale_variant_id: number | null;
  sku: string | null;
  product_name: string | null;
  quantity: number;
  net_sales: number;
  selected_reception_id: number | null;
  selected_reception_date: string | null;
  last_purchase_unit_cost: number | null;
  line_cost: number | null;
  estimated_profit: number | null;
  estimated_margin_pct: number | null;
  cost_status: RouteGuideProfitabilityLineStatus;
}

export interface RouteGuideProfitabilityV1 {
  guide_id: string;
  guide_number: string;
  sales_net_total: number;
  covered_sales_net: number;
  uncovered_sales_net: number;
  last_purchase_cost_total: number;
  estimated_gross_profit: number;
  estimated_margin_pct: number | null;
  cost_coverage_pct: number | null;
  total_lines: number;
  covered_lines: number;
  uncovered_lines: number;
  total_variants: number;
  covered_variants: number;
  uncovered_variants: number;
  cost_status: RouteGuideProfitabilityStatus;
  lines: RouteGuideProfitabilityLine[];
}

export interface CatalogOptions {
  routes: DeliveryRoute[];
  vehicles: RouteVehicle[];
  personnel: RoutePersonnel[];
}
