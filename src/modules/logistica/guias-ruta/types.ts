export type RouteGuideStatus = 'DRAFT' | 'DISPATCHED' | 'CANCELLED';
export type RoutePersonnelType = 'DRIVER' | 'SELLER' | 'DISPATCHER' | 'OTHER';
export type PaymentMethodNormalized = 'CASH' | 'CHECK' | 'TRANSFER' | 'CREDIT' | 'UNKNOWN';
export type ValidationStatus = 'VALID' | 'INVALID';
export type SettlementStatus = 'PENDING' | 'NOT_REQUIRED' | 'PENDING_REVIEW';

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
  
  items?: RouteGuideItem[]; // Cargado asíncronamente
}

export interface CatalogOptions {
  routes: DeliveryRoute[];
  vehicles: RouteVehicle[];
  personnel: RoutePersonnel[];
}
