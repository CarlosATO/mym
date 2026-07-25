const sellerTypes = [
  "FIELD",
  "ADMIN",
  "MANAGEMENT",
  "DISPATCH",
  "OTHER",
] as const;

export type CommissionSellerType = (typeof sellerTypes)[number];

export type CommissionSeller = {
  company_id: string;
  seller_bsale_id: number;
  seller_name: string | null;
  docs_count: number;
  invoices_count: number;
  paid_invoices_count: number;
  seller_profile_id: string | null;
  is_commissionable: boolean;
  seller_type: CommissionSellerType;
  profile_active: boolean | null;
  last_seen_at: string | null;
  notes: string | null;
};

export type CommissionSellerRow = Omit<
  CommissionSeller,
  | "seller_bsale_id"
  | "docs_count"
  | "invoices_count"
  | "paid_invoices_count"
  | "notes"
> & {
  seller_bsale_id: number | string;
  docs_count: number | string | null;
  invoices_count: number | string | null;
  paid_invoices_count: number | string | null;
};

export type CommissionSellerProfileInput = {
  seller_bsale_id: number;
  seller_name: string;
  is_commissionable: boolean;
  seller_type: CommissionSellerType;
  active: boolean;
  notes: string;
};

export type CommissionEligibleSummary = {
  lines_count: number;
  total_net_amount: number;
  period_from: string;
  period_to: string;
};

export type CommissionSettings = {
  default_commission_percent: number;
  base_amount: "NET";
  require_full_payment: boolean;
  historical_cutoff_date: string;
  first_eligible_date: string;
};

export type CommissionGroup = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  supplier_id: string | null;
  parent_supplier_id: string | null;
  is_active: boolean;
};

export type CommissionRuleScope = "GENERAL" | "SUPPLIER" | "GROUP" | "PRODUCT";
export type CommissionRuleType =
  | "FIXED_PERCENT"
  | "RANGE_BY_AMOUNT"
  | "RANGE_BY_QUANTITY";

export type CommissionRule = {
  id: string;
  rule_scope: CommissionRuleScope;
  seller_profile_id: string | null;
  supplier_id: string | null;
  commission_group_id: string | null;
  product_id: string | null;
  rule_type: CommissionRuleType;
  range_basis: "NONE" | "AMOUNT" | "QUANTITY";
  min_amount: number | null;
  max_amount: number | null;
  min_quantity: number | null;
  max_quantity: number | null;
  commission_percent: number;
  valid_from: string;
  valid_to: string | null;
  priority: number;
  is_active: boolean;
  is_archived?: boolean;
  archived_at?: string | null;
  archive_reason?: string | null;
  notes: string | null;
  rule_name?: string | null;
  rule_description?: string | null;
  rule_batch_id?: string | null;
  selection_summary?: Record<string, unknown> | null;
};

export type CommissionPreviewLine = {
  seller_bsale_id: number;
  seller_name: string | null;
  period_from: string;
  period_to: string;
  invoice_bsale_id: number;
  invoice_number: number | null;
  customer_name: string | null;
  payment_completed_at: string | null;
  invoice_line_id: string;
  sku: string | null;
  product_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  product_id?: string | null;
  commission_group_id: string | null;
  commission_group_name: string | null;
  quantity: number;
  net_amount: number;
  commission_base_amount: number;
  accumulated_amount: number;
  accumulated_quantity: number;
  rule_id: string | null;
  rule_scope: CommissionRuleScope;
  applied_rule_label: string;
  applied_rule_scope: CommissionRuleScope;
  applied_rule_batch_id: string | null;
  rule_type: CommissionRuleType;
  range_basis: string;
  commission_percent: number;
  commission_amount: number;
  warning_code: string | null;
  warning_message: string | null;
  commission_line_type?: string | null;
  source_document_type?: string | null;
  source_document_id?: number | null;
  source_document_number?: number | null;
  source_detail_id?: string | null;
  original_invoice_id?: number | null;
  original_invoice_number?: number | null;
  adjustment_reason?: string | null;
};

export type CommissionPreview = {
  summary: {
    invoices_count: number;
    lines_count: number;
    total_net_amount: number;
    total_commission_amount: number;
    average_commission_percent: number;
    general_rule_lines: number;
    warnings_count: number;
    period_from: string;
    period_to: string;
  };
  lines: CommissionPreviewLine[];
  warnings: Array<{ code: string; message: string; count: number }>;
};

export type CommissionSyncHealth = {
  latestRun: CommissionSyncRun | null;
  latestSuccessfulRun: CommissionSyncRun | null;
  isFresh: boolean;
  lastSuccessAgeMinutes: number | null;
};

export type CommissionSyncRun = {
  started_at: string;
  completed_at: string | null;
  status: string;
  trigger: string | null;
  documents_count: number | null;
  document_details_count: number | null;
  error_message: string | null;
};

export type CommissionRuleProductCandidate = {
  id: string;
  sku: string;
  description: string;
  real_supplier_name: string | null;
  operative_supplier_name: string | null;
  stock_available: number | null;
  already_included: boolean;
  bsale_product_id: number | null;
  bsale_variant_id: number | null;
};

export type CommissionSettlementHeader = {
  id: string;
  company_id: string;
  settlement_number: number | null;
  settlement_code: string;
  seller_bsale_id: number | null;
  seller_name: string | null;
  period_from: string;
  period_to: string;
  period_label: string;
  status: string;
  source: string;
  total_net_amount: number;
  total_commission_amount: number;
  lines_count?: number;
  issued_at?: string | null;
  created_at?: string;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
};

export type CommissionSettlementLine = {
  id: string;
  settlement_id: string;
  line_type: string;
  invoice_bsale_id?: number | null;
  invoice_number?: number | null;
  invoice_line_id?: string | null;
  sku?: string | null;
  product_name?: string | null;
  customer_name?: string | null;
  supplier_name?: string | null;
  commission_group_name?: string | null;
  quantity: number;
  net_amount: number;
  commission_percent?: number | null;
  commission_amount?: number | null;
  rule_id?: string | null;
  payment_completed_at?: string | null;
  source_document_bsale_id?: number | null;
  source_document_number?: number | null;
  source_document_type_id?: number | null;
  source_document_line_id?: string | null;
  original_invoice_bsale_id?: number | null;
  original_invoice_number?: number | null;
  eligibility_locked_at?: string | null;
  metadata: Record<string, unknown>;
};

export type RoleRelation = { name?: string | null };

export { sellerTypes };
