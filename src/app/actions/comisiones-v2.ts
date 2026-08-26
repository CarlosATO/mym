"use server";

import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getActiveCompanyId } from "@/app/actions/companies";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

type ResolutionStatus =
  | "RESOLVED"
  | "PRODUCT_UNRESOLVED"
  | "BRAND_UNRESOLVED"
  | "BRAND_LINK_UNRESOLVED"
  | "SUPPLIER_INVALID"
  | "FAMILY_UNRESOLVED"
  | "VARIANT_MISSING";

export type SalesLineResolution = {
  company_id: string;
  document_id: string | null;
  document_bsale_id: number | null;
  document_number: number | null;
  document_type_id: number | null;
  emission_date: string | null;
  detail_id: string;
  detail_bsale_id: number;
  line_number: number | null;
  quantity: number | null;
  net_amount: number | null;
  variant_id: number | null;
  variant_code_snapshot: string | null;
  variant_description_snapshot: string | null;
  product_id: string | null;
  current_sku: string | null;
  current_product_description: string | null;
  product_is_active: boolean | null;
  bsale_brand_id: number | null;
  real_supplier_id: string | null;
  real_supplier_business_name: string | null;
  family_bsale_product_type_id: number | null;
  family_name: string | null;
  resolution_status: ResolutionStatus;
  resolution_code: ResolutionStatus | null;
  resolution_message: string;
};

export type ComisionesV2SellerProfile = {
  seller_bsale_id: number;
  seller_name: string;
  is_commissionable: boolean;
  active: boolean;
  seller_type: string;
};

export type ComisionesV2PaymentEligibility = SalesLineResolution & {
  customer_bsale_id: number | null;
  customer_name: string | null;
  seller_bsale_id: number | null;
  seller_name: string | null;
  seller_primary_count: number;
  seller_primary_ids: number[] | null;
  seller_is_commissionable: boolean | null;
  seller_is_active: boolean | null;
  receivable_status: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  pending_amount: number | null;
  full_payment_date: string | null;
};

export type ComisionesV2Supplier = {
  supplier_id: string;
  supplier_name: string;
  rut: string | null;
};

export type ComisionesV2Family = {
  supplier_id: string;
  family_bsale_product_type_id: number;
  family_name: string;
  resolved_lines: number;
};

export type ComisionesV2FamilyRate = {
  family_bsale_product_type_id: number;
  family_name_snapshot: string;
  percentage: number;
};

export type ComisionesV2FamilyConflict = {
  family_bsale_product_type_id: number;
  family_name: string;
  conflict_plan_id: string;
  conflict_plan_code: string;
  conflict_valid_from: string;
  conflict_valid_to: string | null;
};

export type ComisionesV2BasePlanConflict = {
  conflict_plan_id: string;
  conflict_plan_code: string;
  conflict_plan_type: ComisionesV2PlanType;
  conflict_valid_from: string;
  conflict_valid_to: string | null;
};

export type ComisionesV2PlanType =
  "FAMILY_FIXED_PERCENT" | "SUPPLIER_SALES_TARGET";

export type ComisionesV2Tier = {
  tier_order: number;
  lower_bound: number;
  upper_bound: number | null;
  percentage: number;
};

export type ComisionesV2FamilyPlan = {
  id: string;
  supplier_id: string;
  plan_code: string;
  version_no: number;
  plan_type: ComisionesV2PlanType;
  seller_bsale_id?: number | null;
  valid_from: string;
  valid_to: string | null;
  rates: ComisionesV2FamilyRate[];
  tiers?: ComisionesV2Tier[];
  supplier_name?: string | null;
  status?: string;
  active?: boolean;
  supersedes_plan_id?: string | null;
  has_issued_usage?: boolean;
  issued_usage_known?: boolean;
};

export type ComisionesV2FamilyPlanListItem = Omit<
  ComisionesV2FamilyPlan,
  "rates"
> & {
  rates?: never;
  supplier_name: string | null;
  status: string;
  active: boolean;
  supersedes_plan_id: string | null;
  has_issued_usage: boolean;
  family_names: string[];
  seller_bsale_id?: number | null;
  seller_name?: string | null;
};

export type ComisionesV2SimulationLine = ComisionesV2PaymentEligibility & {
  line_kind?: "INVOICE" | "CREDIT_NOTE";
  source_document_bsale_id?: number | null;
  source_document_number?: number | null;
  source_document_type_id?: number | null;
  source_document_line_id?: string | null;
  source_document_detail_bsale_id?: number | null;
  original_invoice_bsale_id?: number | null;
  original_invoice_number?: number | null;
  original_invoice_line_id?: string | null;
  original_invoice_detail_bsale_id?: number | null;
  credit_note_date?: string | null;
  plan_id: string | null;
  plan_code: string | null;
  family_percentage: number | null;
  commission_amount: number | null;
  simulation_status:
    | "RULE_APPLIED"
    | "NO_ACTIVE_PLAN"
    | "NO_FAMILY_RATE"
    | "NO_SALES_TARGET_TIER"
    | "COMMERCIAL_INCIDENT";
  simulation_message: string;
  plan_type?: ComisionesV2PlanType | null;
  supplier_total_net?: number | null;
  tier_lower_bound?: number | null;
  tier_upper_bound?: number | null;
  commission_percent?: number | null;
};

export type ComisionesV2SettlementDraftResult = {
  settlement_id: string;
  lines_count: number;
  total_net_amount: number;
  total_commission_amount: number;
};

export type ComisionesV2SettlementDraftReadiness = {
  can_create: boolean;
  total_lines: number;
  total_net_amount: number;
  total_commission_amount: number;
  no_active_plan_lines: number;
  no_active_plan_net: number;
  no_family_rate_lines: number;
  no_family_rate_net: number;
  unruled_lines: number;
  unruled_net: number;
  blocking_lines: number;
  no_sales_target_tier_lines: number;
  commercial_incident_lines: number;
  blocking_reasons: string[];
};

export type ComisionesV2SettlementDraftListItem = {
  settlement_id: string;
  seller_bsale_id: number;
  seller_name_snapshot: string;
  period_from: string;
  period_to: string;
  status: "DRAFT" | "ISSUED" | "CANCELLED";
  settlement_kind: "NORMAL" | "ADJUSTMENT";
  total_net_amount: number;
  total_commission_amount: number;
  created_at: string;
  lines_count: number;
};

export type ComisionesV2SettlementIssuedListItem = {
  settlement_id: string;
  settlement_number: number | null;
  settlement_code: string;
  seller_bsale_id: number;
  seller_name_snapshot: string;
  period_from: string;
  period_to: string;
  status: "ISSUED";
  settlement_kind: "NORMAL" | "ADJUSTMENT";
  total_net_amount: number;
  total_commission_amount: number;
  created_at: string;
  issued_at: string | null;
  lines_count: number;
};

export type ComisionesV2SettlementDetail = {
  settlement: {
    id: string;
    seller_bsale_id: number;
    seller_name_snapshot: string;
    period_from: string;
    period_to: string;
    status: "DRAFT" | "ISSUED" | "CANCELLED";
    settlement_number: number | null;
    settlement_code: string;
    issued_at: string | null;
    total_net_amount: number;
    total_commission_amount: number;
    created_at: string;
    official_pdf_storage_bucket: string | null;
    official_pdf_storage_path: string | null;
    official_pdf_sha256: string | null;
    official_pdf_stored_at: string | null;
  };
  lines: Array<{
    id?: string;
    source_document_number: number | null;
    source_document_bsale_id: number;
    source_document_type_id?: number | null;
    source_document_line_id?: number | null;
    source_document_detail_bsale_id?: number | null;
    bsale_variant_id?: number | null;
    product_id?: number | null;
    customer_name_snapshot: string | null;
    client_bsale_id?: number | null;
    full_payment_date: string | null;
    document_emission_date?: string | null;
    sku_snapshot: string | null;
    description_snapshot: string | null;
    real_supplier_name_snapshot: string | null;
    real_supplier_id?: string | number | null;
    family_name_snapshot: string | null;
    family_bsale_product_type_id?: number | null;
    quantity: number;
    net_amount: number;
    bsale_brand_id?: number | null;
    plan_code_snapshot: string | null;
    plan_id?: string | null;
    plan_version_no?: number | null;
    plan_type: ComisionesV2PlanType | null;
    family_rate_id?: string | null;
    tier_id?: string | null;
    base_amount?: number | null;
    percentage: number | null;
    commission_amount: number;
    supplier_total_net: number | null;
    tier_lower_bound: number | null;
    tier_upper_bound: number | null;
    currency_code?: string | null;
    calculated_at?: string | null;
    metadata: Record<string, unknown>;
  }>;
};

type Result = { data: SalesLineResolution[]; error?: string };

function logSupabaseError(
  context: string,
  error: { code?: string; message: string; details?: string; hint?: string },
) {
  console.error(`${context}:`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}

function portalAdmin() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    {
      db: { schema: "portal" },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

function comisionesService() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    {
      db: { schema: "comisiones" },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

export async function listComisionesV2Lines(
  from: string,
  to: string,
): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado" };

  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 permission validation error",
      permissionError,
    );
    return {
      data: [],
      error: "No se pudo validar el permiso de Comisiones V2.",
    };
  }

  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  ) {
    return {
      data: [],
      error: "No tienes permiso para consultar Comisiones V2.",
    };
  }

  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    from > to
  ) {
    return { data: [], error: "El período de emisión no es válido." };
  }

  const rows: SalesLineResolution[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .schema("comisiones")
      .from("vw_sales_line_resolution")
      .select("*")
      .eq("company_id", companyId)
      .eq("document_type_id", 5)
      .gte("emission_date", from)
      .lte("emission_date", to)
      .order("emission_date", { ascending: false })
      .order("document_number", { ascending: false })
      .order("line_number", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      logSupabaseError("Comisiones V2 read error", error);
      return {
        data: [],
        error: "No se pudieron cargar las líneas de Comisiones V2.",
      };
    }

    rows.push(...(data as SalesLineResolution[]));
    if (!data || data.length < pageSize) break;
  }

  return { data: rows };
}

export async function listComisionesV2SellerProfiles(): Promise<{
  data: ComisionesV2SellerProfile[];
  error?: string;
  canManage?: boolean;
  canIssue?: boolean;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado", canManage: false };

  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 seller permission validation error",
      permissionError,
    );
    return {
      data: [],
      error: "No se pudo validar el permiso de Comisiones V2.",
      canManage: false,
    };
  }

  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  ) {
    return {
      data: [],
      error: "No tienes permiso para consultar Comisiones V2.",
      canManage: false,
    };
  }

  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
      canManage: false,
    };

  const { data, error } = await supabase
    .schema("comisiones")
    .from("seller_profiles")
    .select("seller_bsale_id,seller_name,is_commissionable,active,seller_type")
    .eq("company_id", companyId)
    .order("seller_name", { ascending: true });

  if (error) {
    logSupabaseError("Comisiones V2 seller profiles read error", error);
    return {
      data: [],
      error: "No se pudieron cargar los vendedores V2.",
      canManage: false,
    };
  }

  return {
    data: data as ComisionesV2SellerProfile[],
    canManage:
      permissionCodes.includes("comisiones.v2.plans.manage") ||
      permissionCodes.includes("system.admin"),
    canIssue:
      permissionCodes.includes("comisiones.v2.issue") ||
      permissionCodes.includes("system.admin"),
  };
}

export async function listComisionesV2PaymentEligibility(
  from: string,
  to: string,
  sellerBsaleId: number,
): Promise<{ data: ComisionesV2PaymentEligibility[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado" };

  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 payment permission validation error",
      permissionError,
    );
    return {
      data: [],
      error: "No se pudo validar el permiso de Comisiones V2.",
    };
  }

  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  ) {
    return {
      data: [],
      error: "No tienes permiso para consultar Comisiones V2.",
    };
  }

  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    from > to ||
    !Number.isInteger(sellerBsaleId) ||
    sellerBsaleId <= 0
  ) {
    return { data: [], error: "El vendedor o período de pago no es válido." };
  }

  const rows: ComisionesV2PaymentEligibility[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .schema("comisiones")
      .rpc("get_sales_line_payment_eligibility", {
        p_company_id: companyId,
        p_seller_bsale_id: sellerBsaleId,
        p_from: from,
        p_to: to,
      })
      .range(offset, offset + pageSize - 1);

    if (error) {
      logSupabaseError("Comisiones V2 payment eligibility read error", error);
      return {
        data: [],
        error: "No se pudo cargar la elegibilidad de pago V2.",
      };
    }

    rows.push(...(data as ComisionesV2PaymentEligibility[]));
    if (!data || data.length < pageSize) break;
  }

  return { data: rows };
}

export async function listComisionesV2Suppliers(): Promise<{
  data: ComisionesV2Supplier[];
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 supplier permission validation error",
      permissionError,
    );
    return {
      data: [],
      error: "No se pudo validar el permiso de Comisiones V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: [],
      error: "No tienes permiso para consultar Comisiones V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .from("vw_real_suppliers")
    .select("supplier_id,supplier_name,rut")
    .eq("company_id", companyId)
    .order("supplier_name");
  if (error) {
    logSupabaseError("Comisiones V2 suppliers read error", error);
    return { data: [], error: "No se pudieron cargar los Suppliers REAL." };
  }
  return { data: data as ComisionesV2Supplier[] };
}

export async function listComisionesV2SupplierFamilies(
  supplierId: string,
): Promise<{ data: ComisionesV2Family[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado" };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .from("vw_real_supplier_families")
    .select(
      "supplier_id,family_bsale_product_type_id,family_name,resolved_lines",
    )
    .eq("company_id", companyId)
    .eq("supplier_id", supplierId)
    .order("family_name");
  if (error) {
    logSupabaseError("Comisiones V2 supplier families read error", error);
    return {
      data: [],
      error: "No se pudieron cargar las Familias del Supplier.",
    };
  }
  return { data: data as ComisionesV2Family[] };
}

export async function listComisionesV2FamilyPlanConflicts(input: {
  supplierId: string;
  validFrom: string;
  validTo: string | null;
  excludePlanId?: string | null;
}): Promise<{ data: ComisionesV2FamilyConflict[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado" };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("get_family_fixed_plan_conflicts", {
      p_company_id: companyId,
      p_supplier_id: input.supplierId,
      p_valid_from: input.validFrom,
      p_valid_to: input.validTo,
      p_exclude_plan_id: input.excludePlanId ?? null,
    });
  if (error) {
    logSupabaseError("Comisiones V2 family plan conflicts read error", error);
    return {
      data: [],
      error: "No se pudieron comprobar las Familias ocupadas.",
    };
  }
  return { data: (data ?? []) as ComisionesV2FamilyConflict[] };
}

export async function getComisionesV2BasePlanConflict(input: {
  supplierId: string;
  validFrom: string;
  validTo: string | null;
  excludePlanId?: string | null;
  planType?: ComisionesV2PlanType;
  sellerBsaleId?: number | null;
}): Promise<{ data: ComisionesV2BasePlanConflict | null; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("get_base_plan_conflicts", {
      p_company_id: companyId,
      p_supplier_id: input.supplierId,
      p_valid_from: input.validFrom,
      p_valid_to: input.validTo,
      p_exclude_plan_id: input.excludePlanId ?? null,
    });
  if (error) {
    logSupabaseError("Comisiones V2 base plan conflict read error", error);
    return {
      data: null,
      error: "No se pudo comprobar la vigencia del proveedor.",
    };
  }
  const candidates = (data ?? []) as ComisionesV2BasePlanConflict[];
  if (input.planType !== "SUPPLIER_SALES_TARGET") {
    return { data: candidates[0] ?? null };
  }

  const targetCandidates = candidates.filter(
    (candidate) => candidate.conflict_plan_type === "SUPPLIER_SALES_TARGET",
  );
  const { data: scopedPlans, error: scopedPlansError } =
    targetCandidates.length === 0
      ? { data: [], error: null }
      : await supabase
          .schema("comisiones")
          .from("commission_plans")
          .select("id,seller_bsale_id")
          .eq("company_id", companyId)
          .in(
            "id",
            targetCandidates.map((candidate) => candidate.conflict_plan_id),
          );
  if (scopedPlansError) {
    logSupabaseError(
      "Comisiones V2 scoped plan conflict read error",
      scopedPlansError,
    );
    return {
      data: null,
      error: "No se pudo comprobar el alcance de las reglas vigentes.",
    };
  }
  const scopedSellerIds = new Map(
    (scopedPlans ?? []).map((plan) => [plan.id, plan.seller_bsale_id as number | null]),
  );
  const matchingTarget = targetCandidates.find(
    (candidate) =>
      scopedSellerIds.get(candidate.conflict_plan_id) ===
      (input.sellerBsaleId ?? null),
  );
  const familyConflict = candidates.find(
    (candidate) => candidate.conflict_plan_type === "FAMILY_FIXED_PERCENT",
  );
  return { data: familyConflict ?? matchingTarget ?? null };
}

export async function getComisionesV2FamilyPlan(
  supplierId: string,
): Promise<{ data: ComisionesV2FamilyPlan | null; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  const { data: plans, error: planError } = await supabase
    .schema("comisiones")
    .from("commission_plans")
    .select("id,supplier_id,plan_code,version_no,plan_type,valid_from,valid_to")
    .eq("company_id", companyId)
    .eq("supplier_id", supplierId)
    .eq("plan_type", "FAMILY_FIXED_PERCENT")
    .eq("active", true)
    .order("valid_from", { ascending: false })
    .order("version_no", { ascending: false })
    .limit(1);
  if (planError) {
    logSupabaseError("Comisiones V2 family plan read error", planError);
    return { data: null, error: "No se pudo cargar el plan V2." };
  }
  const plan = plans?.[0];
  if (!plan) return { data: null };
  const { data: rates, error: rateError } = await supabase
    .schema("comisiones")
    .from("commission_plan_family_rates")
    .select("family_bsale_product_type_id,family_name_snapshot,percentage")
    .eq("company_id", companyId)
    .eq("plan_id", plan.id);
  if (rateError) {
    logSupabaseError("Comisiones V2 family rates read error", rateError);
    return {
      data: null,
      error: "No se pudieron cargar los porcentajes por Familia.",
    };
  }
  return {
    data: {
      ...plan,
      plan_type: "FAMILY_FIXED_PERCENT",
      rates: (rates ?? []) as ComisionesV2FamilyRate[],
    },
  };
}

export async function listComisionesV2FamilyPlans(options?: {
  archived?: boolean;
}): Promise<{
  data: ComisionesV2FamilyPlanListItem[];
  suppliers: ComisionesV2Supplier[];
  error?: string;
  warning?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], suppliers: [], error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 family plans permission validation error",
      permissionError,
    );
    return {
      data: [],
      suppliers: [],
      error: "No se pudo validar el permiso de Comisiones V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: [],
      suppliers: [],
      error: "No tienes permiso para consultar Comisiones V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      suppliers: [],
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  let plansQuery = supabase
    .schema("comisiones")
    .from("commission_plans")
    .select(
      "id,supplier_id,plan_code,version_no,plan_type,seller_bsale_id,valid_from,valid_to,status,active,supersedes_plan_id",
    )
    .eq("company_id", companyId)
    .in("plan_type", ["FAMILY_FIXED_PERCENT", "SUPPLIER_SALES_TARGET"]);
  plansQuery = options?.archived
    ? plansQuery.eq("status", "RETIRED").eq("active", false)
    : plansQuery.eq("status", "ACTIVE").eq("active", true);
  const { data, error } = await plansQuery
    .order("valid_from", { ascending: false })
    .order("version_no", { ascending: false });
  if (error) {
    logSupabaseError("Comisiones V2 family plans list error", error);
    return {
      data: [],
      suppliers: [],
      error: "No se pudieron cargar los planes V2.",
    };
  }
  const suppliers = await listComisionesV2Suppliers();
  const supplierNames = new Map(
    suppliers.data.map((supplier) => [
      supplier.supplier_id,
      supplier.supplier_name,
    ]),
  );
  const planIds = (data ?? []).map((plan) => plan.id);
  const warnings = [suppliers.error].filter(Boolean) as string[];
  const { data: history, error: historyError } =
    planIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .schema("comisiones")
          .rpc("get_family_fixed_plan_issued_usage", {
            p_company_id: companyId,
            p_plan_ids: planIds,
          });
  if (historyError) {
    logSupabaseError(
      "Comisiones V2 family plan issued usage read error",
      historyError,
    );
    warnings.push(
      "No se pudo comprobar el histórico emitido de los planes V2.",
    );
  }
  const historyRows = (history ?? []) as {
    plan_id: string;
    has_issued_usage: boolean;
  }[];
  const usage = new Map(
    historyRows.map((item) => [item.plan_id, item.has_issued_usage]),
  );
  const { data: familyRows, error: familyError } =
    planIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .schema("comisiones")
          .from("commission_plan_family_rates")
          .select("plan_id,family_name_snapshot")
          .eq("company_id", companyId)
          .in("plan_id", planIds);
  if (familyError) {
    logSupabaseError(
      "Comisiones V2 family plan family names read error",
      familyError,
    );
    warnings.push(
      "No se pudieron cargar las Familias configuradas de los planes V2.",
    );
  }
  const familyNames = new Map<string, string[]>();
  for (const row of (familyRows ?? []) as {
    plan_id: string;
    family_name_snapshot: string;
  }[]) {
    const names = familyNames.get(row.plan_id) ?? [];
    if (!names.includes(row.family_name_snapshot))
      names.push(row.family_name_snapshot);
    familyNames.set(row.plan_id, names);
  }
  return {
    data: (data ?? []).map((plan) => ({
      ...plan,
      supplier_name: supplierNames.get(plan.supplier_id) ?? null,
      has_issued_usage: usage.get(plan.id) ?? false,
      issued_usage_known: !historyError,
      family_names: familyNames.get(plan.id) ?? [],
    })) as ComisionesV2FamilyPlanListItem[],
    suppliers: suppliers.data,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

export async function getComisionesV2FamilyPlanById(
  planId: string,
): Promise<{ data: ComisionesV2FamilyPlan | null; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  const { data: plan, error: planError } = await supabase
    .schema("comisiones")
    .from("commission_plans")
    .select(
      "id,supplier_id,plan_code,version_no,plan_type,seller_bsale_id,valid_from,valid_to,status,active,supersedes_plan_id",
    )
    .eq("company_id", companyId)
    .eq("id", planId)
    .in("plan_type", ["FAMILY_FIXED_PERCENT", "SUPPLIER_SALES_TARGET"])
    .maybeSingle();
  if (planError) {
    logSupabaseError("Comisiones V2 family plan detail error", planError);
    return { data: null, error: "No se pudo cargar el detalle del plan V2." };
  }
  if (!plan) return { data: null };
  const { data: rates, error: rateError } =
    plan.plan_type === "FAMILY_FIXED_PERCENT"
      ? await supabase
          .schema("comisiones")
          .from("commission_plan_family_rates")
          .select(
            "family_bsale_product_type_id,family_name_snapshot,percentage",
          )
          .eq("company_id", companyId)
          .eq("plan_id", plan.id)
      : { data: [], error: null };
  const { data: tiers, error: tierError } =
    plan.plan_type === "SUPPLIER_SALES_TARGET"
      ? await supabase
          .schema("comisiones")
          .from("commission_plan_tiers")
          .select("tier_order,lower_bound,upper_bound,percentage")
          .eq("company_id", companyId)
          .eq("plan_id", plan.id)
          .order("tier_order")
      : { data: [], error: null };
  if (rateError) {
    logSupabaseError("Comisiones V2 family plan detail rates error", rateError);
    return {
      data: null,
      error: "No se pudieron cargar los porcentajes por Familia.",
    };
  }
  if (tierError) {
    logSupabaseError("Comisiones V2 sales target tier detail error", tierError);
    return { data: null, error: "No se pudieron cargar los tramos de venta." };
  }
  const suppliers = await listComisionesV2Suppliers();
  if (suppliers.error) return { data: null, error: suppliers.error };
  const { data: history, error: historyError } = await supabase
    .schema("comisiones")
    .rpc("get_family_fixed_plan_issued_usage", {
      p_company_id: companyId,
      p_plan_ids: [plan.id],
    });
  if (historyError) {
    logSupabaseError(
      "Comisiones V2 family plan detail issued history error",
      historyError,
    );
    return {
      data: {
        ...plan,
        plan_type: plan.plan_type as ComisionesV2PlanType,
        supplier_name:
          suppliers.data.find(
            (supplier) => supplier.supplier_id === plan.supplier_id,
          )?.supplier_name ?? null,
        has_issued_usage: false,
        issued_usage_known: false,
        rates: (rates ?? []) as ComisionesV2FamilyRate[],
        tiers: (tiers ?? []) as ComisionesV2Tier[],
      },
    };
  }
  const historyRows = (history ?? []) as {
    plan_id: string;
    has_issued_usage: boolean;
  }[];
  return {
    data: {
      ...plan,
      plan_type: plan.plan_type as ComisionesV2PlanType,
      supplier_name:
        suppliers.data.find(
          (supplier) => supplier.supplier_id === plan.supplier_id,
        )?.supplier_name ?? null,
      has_issued_usage: historyRows[0]?.has_issued_usage === true,
      issued_usage_known: true,
      rates: (rates ?? []) as ComisionesV2FamilyRate[],
      tiers: (tiers ?? []) as ComisionesV2Tier[],
    },
  };
}

export async function saveComisionesV2FamilyPlan(input: {
  planId: string | null;
  planCode: string;
  supplierId: string;
  validFrom: string;
  validTo: string | null;
  rates: ComisionesV2FamilyRate[];
}): Promise<{
  data: { plan_id: string; plan_code: string; version_no: number } | null;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 plan permission validation error",
      permissionError,
    );
    return {
      data: null,
      error: "No se pudo validar el permiso de configuración V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.plans.manage") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: null,
      error: "No tienes permiso para configurar planes V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para configurar Comisiones V2.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("save_family_fixed_plan", {
      p_company_id: companyId,
      p_plan_id: input.planId,
      p_plan_code: input.planCode,
      p_supplier_id: input.supplierId,
      p_valid_from: input.validFrom,
      p_valid_to: input.validTo,
      p_rates: input.rates,
    });
  if (error) {
    logSupabaseError("Comisiones V2 family plan save error", error);
    return {
      data: null,
      error: error.message || "No se pudo guardar el plan V2.",
    };
  }
  return {
    data:
      (
        data as { plan_id: string; plan_code: string; version_no: number }[]
      )[0] ?? null,
  };
}

export type ComisionesV2PlanRemovalResult = {
  result: "DELETED" | "ARCHIVED";
  plan_id: string;
  plan_code: string;
  version_no: number;
};

export async function removeComisionesV2Plan(
  planId: string,
): Promise<{ data: ComisionesV2PlanRemovalResult | null; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };

  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 plan removal permission validation error",
      permissionError,
    );
    return {
      data: null,
      error: "No se pudo validar el permiso para eliminar la regla.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.plans.manage") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: null,
      error: "No tienes permiso para eliminar reglas V2.",
    };

  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para eliminar la regla.",
    };

  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("remove_commission_plan", {
      p_company_id: companyId,
      p_plan_id: planId,
    });
  if (error) {
    logSupabaseError("Comisiones V2 plan removal error", error);
    const message = error.message.toUpperCase();
    if (message.includes("PLAN_NOT_ACTIVE"))
      return {
        data: null,
        error: "La regla ya no está vigente. Se actualizará la lista.",
      };
    if (message.includes("PLAN_NOT_FOUND"))
      return { data: null, error: "La regla ya no existe." };
    if (message.includes("PERMISSION_DENIED"))
      return { data: null, error: "No tienes permiso para eliminar reglas V2." };
    return {
      data: null,
      error: error.message || "No se pudo eliminar la regla.",
    };
  }
  return {
    data: (data as ComisionesV2PlanRemovalResult[] | null)?.[0] ?? null,
  };
}

export async function saveComisionesV2SalesTargetPlan(input: {
  planId: string | null;
  planCode: string;
  supplierId: string;
  validFrom: string;
  validTo: string | null;
  tiers: ComisionesV2Tier[];
  sellerBsaleId?: number | null;
}): Promise<{
  data: { plan_id: string; plan_code: string; version_no: number } | null;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 sales target permission validation error",
      permissionError,
    );
    return {
      data: null,
      error: "No se pudo validar el permiso de configuración V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.plans.manage") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: null,
      error: "No tienes permiso para configurar planes V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para configurar Comisiones V2.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("save_supplier_sales_target_plan", {
      p_company_id: companyId,
      p_plan_id: input.planId,
      p_plan_code: input.planCode,
      p_supplier_id: input.supplierId,
      p_valid_from: input.validFrom,
      p_valid_to: input.validTo,
      p_tiers: input.tiers,
      p_seller_bsale_id: input.sellerBsaleId ?? null,
    });
  if (error) {
    logSupabaseError("Comisiones V2 sales target save error", error);
    return {
      data: null,
      error: "No se pudo guardar el plan de meta de ventas.",
    };
  }
  return {
    data:
      (
        data as { plan_id: string; plan_code: string; version_no: number }[]
      )[0] ?? null,
  };
}

export async function listComisionesV2Simulation(
  from: string,
  to: string,
  sellerBsaleId: number,
): Promise<{ data: ComisionesV2SimulationLine[]; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 simulation permission validation error",
      permissionError,
    );
    return {
      data: [],
      error: "No se pudo validar el permiso de Comisiones V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: [],
      error: "No tienes permiso para consultar Comisiones V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  const rows: ComisionesV2SimulationLine[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .schema("comisiones")
      .rpc("get_sales_line_simulation", {
        p_company_id: companyId,
        p_seller_bsale_id: sellerBsaleId,
        p_from: from,
        p_to: to,
      })
      .range(offset, offset + pageSize - 1);
    if (error) {
      logSupabaseError("Comisiones V2 simulation read error", error);
      return { data: [], error: "No se pudo cargar la simulación V2." };
    }
    rows.push(...(data as ComisionesV2SimulationLine[]));
    if (!data || data.length < pageSize) break;
  }
  return { data: rows };
}

export async function listComisionesV2PeriodSimulation(
  from: string,
  to: string,
): Promise<{
  data: ComisionesV2SimulationLine[];
  companyId: string | null;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], companyId: null, error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 period simulation permission validation error",
      permissionError,
    );
    return {
      data: [],
      companyId: null,
      error: "No se pudo validar el permiso de Comisiones V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: [],
      companyId: null,
      error: "No tienes permiso para consultar Comisiones V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      companyId: null,
      error: "Selecciona una compañía activa para consultar Comisiones V2.",
    };
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    from > to
  )
    return { data: [], companyId, error: "El período de pago no es válido." };
  const rows: ComisionesV2SimulationLine[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .schema("comisiones")
      .rpc("get_sales_period_simulation", {
        p_company_id: companyId,
        p_period_from: from,
        p_period_to: to,
      })
      .range(offset, offset + pageSize - 1);
    if (error) {
      logSupabaseError("Comisiones V2 period simulation read error", error);
      return {
        data: [],
        companyId,
        error: "No se pudo cargar la simulación batch de Comisiones V2.",
      };
    }
    rows.push(...(data as ComisionesV2SimulationLine[]));
    if (!data || data.length < pageSize) break;
  }
  return { data: rows, companyId };
}

export async function createComisionesV2SettlementDraft(input: {
  sellerBsaleId: number;
  periodFrom: string;
  periodTo: string;
}): Promise<{
  data: ComisionesV2SettlementDraftResult | null;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 draft permission validation error",
      permissionError,
    );
    return {
      data: null,
      error: "No se pudo validar el permiso de borradores V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.draft.create") &&
    !permissionCodes.includes("system.admin")
  )
    return { data: null, error: "No tienes permiso para crear borradores V2." };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para crear el borrador V2.",
    };
  if (
    !/^[0-9]+$/.test(String(input.sellerBsaleId)) ||
    input.sellerBsaleId <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.periodFrom) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.periodTo) ||
    input.periodFrom > input.periodTo
  )
    return {
      data: null,
      error: "El vendedor o período del borrador no es válido.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("create_settlement_draft", {
      p_company_id: companyId,
      p_seller_bsale_id: input.sellerBsaleId,
      p_period_from: input.periodFrom,
      p_period_to: input.periodTo,
    });
  if (error) {
    logSupabaseError("Comisiones V2 draft creation error", error);
    if (error.message.includes("ACTIVE_NORMAL_DRAFT_EXISTS"))
      return {
        data: null,
        error:
          "Ya existe un borrador activo para este vendedor. Revísalo en la pestaña Borradores.",
      };
    if (error.message.includes("BLOCKING_NO_SALES_TARGET_TIER"))
      return {
        data: null,
        error: "Existen líneas de Meta de ventas sin un tramo aplicable.",
      };
    if (error.message.includes("BLOCKING_COMMERCIAL_INCIDENT"))
      return {
        data: null,
        error:
          "Existen incidencias comerciales que deben resolverse antes de liquidar.",
      };
    if (error.message.includes("NO_ELIGIBLE_LINES"))
      return {
        data: null,
        error: "No existen líneas elegibles para este vendedor y período.",
      };
    return { data: null, error: "No se pudo crear el borrador V2." };
  }
  return { data: (data as ComisionesV2SettlementDraftResult[])[0] ?? null };
}

export type ComisionesV2SettlementDraftCancellation = {
  settlement_id: string;
  previous_status: string;
  status: string;
  released_locks: number;
  preserved_lines: number;
  cancelled_at: string;
};

export async function cancelComisionesV2SettlementDraft(input: {
  settlementId: string;
  reason: string;
}): Promise<{
  data: ComisionesV2SettlementDraftCancellation | null;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 draft cancellation permission validation error",
      permissionError,
    );
    return {
      data: null,
      error: "No se pudo validar el permiso de cancelación V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.draft.cancel") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: null,
      error: "No tienes permiso para cancelar borradores V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para cancelar el borrador V2.",
    };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.settlementId,
    )
  )
    return { data: null, error: "El borrador V2 no es válido." };
  if (!input.reason.trim())
    return { data: null, error: "El motivo de cancelación es obligatorio." };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("cancel_settlement_draft", {
      p_company_id: companyId,
      p_settlement_id: input.settlementId,
      p_reason: input.reason.trim(),
    });
  if (error) {
    logSupabaseError("Comisiones V2 draft cancellation error", error);
    return {
      data: null,
      error: error.message || "No se pudo cancelar el borrador V2.",
    };
  }
  return {
    data: (data as ComisionesV2SettlementDraftCancellation[])[0] ?? null,
  };
}

export async function getComisionesV2SettlementDraftReadiness(input: {
  sellerBsaleId: number;
  periodFrom: string;
  periodTo: string;
}): Promise<{
  data: ComisionesV2SettlementDraftReadiness | null;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 draft readiness permission validation error",
      permissionError,
    );
    return {
      data: null,
      error: "No se pudo validar el permiso de borradores V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.draft.create") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: null,
      error: "No tienes permiso para consultar la preparación del borrador V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: null,
      error: "Selecciona una compañía activa para consultar el borrador V2.",
    };
  if (
    !/^[0-9]+$/.test(String(input.sellerBsaleId)) ||
    input.sellerBsaleId <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.periodFrom) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.periodTo) ||
    input.periodFrom > input.periodTo
  )
    return {
      data: null,
      error: "El vendedor o período del borrador no es válido.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("get_settlement_draft_readiness", {
      p_company_id: companyId,
      p_seller_bsale_id: input.sellerBsaleId,
      p_period_from: input.periodFrom,
      p_period_to: input.periodTo,
    });
  if (error) {
    logSupabaseError("Comisiones V2 draft readiness error", error);
    return {
      data: null,
      error: "No se pudo calcular la preparación del borrador V2.",
    };
  }
  return { data: (data as ComisionesV2SettlementDraftReadiness[])[0] ?? null };
}

export async function getComisionesV2SettlementDetail(
  settlementId: string,
): Promise<{ data: ComisionesV2SettlementDetail | null; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: null, error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 settlement detail permission validation error",
      permissionError,
    );
    return {
      data: null,
      error: "No se pudo validar el permiso de lectura V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: null,
      error: "No tienes permiso para consultar el detalle V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (
    !companyId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      settlementId,
    )
  )
    return { data: null, error: "El borrador V2 no es válido." };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("get_settlement_detail", {
      p_company_id: companyId,
      p_settlement_id: settlementId,
    });
  if (error) {
    logSupabaseError("Comisiones V2 settlement detail error", error);
    return {
      data: null,
      error: "No se pudo cargar el detalle del borrador V2.",
    };
  }
  return { data: data as ComisionesV2SettlementDetail };
}

export async function getComisionesV2IssuedSettlementDetail(
  settlementId: string,
): Promise<{ data: ComisionesV2SettlementDetail | null; error?: string }> {
  const result = await getComisionesV2SettlementDetail(settlementId);
  if (result.error || !result.data) return result;
  if (result.data.settlement.status !== "ISSUED")
    return { data: null, error: "La liquidación ya no está emitida." };
  return result;
}

type ComisionesV2Issuance = {
  issuance_id: string;
  settlement_id: string;
  status: "PREPARED" | "STORED" | "FINALIZED";
  issuance_year: number;
  settlement_number: number;
  settlement_code: string;
  storage_bucket: string | null;
  storage_path: string | null;
  pdf_sha256: string | null;
  stored_at: string | null;
  finalized_at: string | null;
};

async function requireComisionesV2IssueContext(
  required: "issue" | "read" = "issue",
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return {
      supabase,
      user: null,
      companyId: null,
      error: "No autorizado" as string | null,
    };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 issue permission validation error",
      permissionError,
    );
    return {
      supabase,
      user,
      companyId: null,
      error: "No se pudo validar el permiso de emisión V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  const authorized =
    required === "issue"
      ? permissionCodes.includes("comisiones.v2.issue") ||
        permissionCodes.includes("system.admin")
      : permissionCodes.includes("comisiones.v2.read") ||
        permissionCodes.includes("comisiones.v2.issue") ||
        permissionCodes.includes("system.admin");
  if (!authorized)
    return {
      supabase,
      user,
      companyId: null,
      error:
        required === "issue"
          ? "No tienes permiso para emitir liquidaciones V2."
          : "No tienes permiso para consultar liquidaciones V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      supabase,
      user,
      companyId: null,
      error: "Selecciona una compañía activa para emitir la liquidación V2.",
    };
  return { supabase, user, companyId, error: null };
}

function pdfSha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function verifyOrUploadOfficialPdf(
  bucket: string,
  path: string,
  buffer: Buffer,
  expectedHash: string,
) {
  if (bucket !== "comisiones-documentos")
    throw new Error("OFFICIAL_PDF_BUCKET_MISMATCH");
  const storage = comisionesService().storage.from(bucket);
  const existing = await storage.download(path);
  if (existing.data) {
    const existingHash = pdfSha256(
      Buffer.from(await existing.data.arrayBuffer()),
    );
    if (existingHash !== expectedHash)
      throw new Error("OFFICIAL_PDF_INTEGRITY_MISMATCH");
  } else {
    const { error } = await storage.upload(path, buffer, {
      contentType: "application/pdf",
      cacheControl: "31536000",
      upsert: false,
    });
    if (error && !error.message.toLowerCase().includes("already exists"))
      throw error;
  }
  const verified = await storage.download(path);
  if (verified.error || !verified.data)
    throw new Error("OFFICIAL_PDF_NOT_FOUND_AFTER_UPLOAD");
  const verifiedHash = pdfSha256(
    Buffer.from(await verified.data.arrayBuffer()),
  );
  if (verifiedHash !== expectedHash)
    throw new Error("OFFICIAL_PDF_INTEGRITY_MISMATCH");
}

async function verifyStoredOfficialPdf(
  bucket: string,
  path: string,
  expectedHash: string,
) {
  await downloadVerifiedOfficialPdf(bucket, path, expectedHash);
}

async function downloadVerifiedOfficialPdf(
  bucket: string,
  path: string,
  expectedHash: string,
) {
  if (bucket !== "comisiones-documentos")
    throw new Error("OFFICIAL_PDF_BUCKET_MISMATCH");
  if (!expectedHash || !/^[0-9a-f]{64}$/.test(expectedHash))
    throw new Error("OFFICIAL_PDF_HASH_MISSING");
  const downloaded = await comisionesService()
    .storage.from(bucket)
    .download(path);
  if (downloaded.error || !downloaded.data)
    throw new Error("OFFICIAL_PDF_NOT_FOUND");
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  const actualHash = pdfSha256(buffer);
  if (actualHash !== expectedHash)
    throw new Error("OFFICIAL_PDF_INTEGRITY_MISMATCH");
  return buffer;
}

export async function issueComisionesV2SettlementDraft(
  settlementId: string,
): Promise<{ data: ComisionesV2Issuance | null; error?: string }> {
  const context = await requireComisionesV2IssueContext();
  if (context.error || !context.companyId)
    return {
      data: null,
      error: context.error ?? "No se pudo validar la emisión V2.",
    };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      settlementId,
    )
  )
    return { data: null, error: "La liquidación V2 no es válida." };
  try {
    const { data: prepared, error: prepareError } = await context.supabase
      .schema("comisiones")
      .rpc("prepare_settlement_issuance", {
        p_company_id: context.companyId,
        p_settlement_id: settlementId,
      });
    if (prepareError) throw prepareError;
    let issuance = (prepared as ComisionesV2Issuance[])[0];
    if (!issuance) throw new Error("No se pudo preparar la emisión V2.");
    if (issuance.status === "FINALIZED") return { data: issuance };

    const bucket = issuance.storage_bucket ?? "comisiones-documentos";
    const path =
      issuance.storage_path ??
      `${context.companyId}/liquidaciones/${settlementId}/${issuance.settlement_code}.pdf`;
    const expectedPath = `${context.companyId}/liquidaciones/${settlementId}/${issuance.settlement_code}.pdf`;
    if (bucket !== "comisiones-documentos" || path !== expectedPath)
      throw new Error("ISSUANCE_STORAGE_REFERENCE_MISMATCH");
    if (issuance.status === "PREPARED") {
      const detailResult = await getComisionesV2SettlementDetail(settlementId);
      if (detailResult.error || !detailResult.data)
        throw new Error(
          detailResult.error ?? "No se pudo cargar el snapshot para emitir.",
        );
      const { data: preparedRow, error: preparedRowError } =
        await comisionesService()
          .from("settlement_issuances")
          .select("prepared_at")
          .eq("company_id", context.companyId)
          .eq("id", issuance.issuance_id)
          .maybeSingle();
      if (preparedRowError || !preparedRow?.prepared_at)
        throw new Error("ISSUANCE_PREPARED_TIMESTAMP_NOT_FOUND");
      const { generateComisionesV2DraftPdf } =
        await import("@/modules/comercial/comisiones-v2/comisiones-v2-exports");
      const logoBase64 = `data:image/png;base64,${readFileSync(join(process.cwd(), "public", "logo-transparent.png")).toString("base64")}`;
      const pdfBlob = generateComisionesV2DraftPdf(
        detailResult.data,
        logoBase64,
        {
          status: "ISSUED",
          settlementCode: issuance.settlement_code,
          settlementNumber: issuance.settlement_number,
          issuedAt: preparedRow.prepared_at,
        },
      );
      const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
      const hash = pdfSha256(pdfBuffer);
      await verifyOrUploadOfficialPdf(bucket, path, pdfBuffer, hash);
      const { data: stored, error: storeError } = await context.supabase
        .schema("comisiones")
        .rpc("store_settlement_issuance", {
          p_company_id: context.companyId,
          p_issuance_id: issuance.issuance_id,
          p_storage_bucket: bucket,
          p_storage_path: path,
          p_pdf_sha256: hash,
        });
      if (storeError) throw storeError;
      issuance = { ...issuance, ...(stored as ComisionesV2Issuance[])[0] };
    } else if (issuance.status === "STORED") {
      if (
        !issuance.storage_bucket ||
        !issuance.storage_path ||
        !issuance.pdf_sha256
      )
        throw new Error("ISSUANCE_STORAGE_REFERENCE_INCOMPLETE");
    }

    if (issuance.status !== "FINALIZED") {
      if (
        !issuance.storage_bucket ||
        !issuance.storage_path ||
        !issuance.pdf_sha256
      )
        throw new Error("ISSUANCE_STORAGE_REFERENCE_INCOMPLETE");
      await verifyStoredOfficialPdf(
        issuance.storage_bucket,
        issuance.storage_path,
        issuance.pdf_sha256,
      );
    }

    const { data: finalized, error: finalizeError } = await context.supabase
      .schema("comisiones")
      .rpc("finalize_settlement_issuance", {
        p_company_id: context.companyId,
        p_issuance_id: issuance.issuance_id,
      });
    if (finalizeError) throw finalizeError;
    return {
      data: {
        ...issuance,
        ...((finalized as Record<string, unknown>[])[0] ?? {}),
        status: "FINALIZED",
      } as ComisionesV2Issuance,
    };
  } catch (error) {
    logSupabaseError("Comisiones V2 definitive issuance error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      data: null,
      error:
        error instanceof Error
          ? error.message
          : "No se pudo emitir la liquidación V2.",
    };
  }
}

export async function getComisionesV2OfficialPdfUrl(
  settlementId: string,
): Promise<{
  data: { signedUrl: string; expiresIn: number } | null;
  error?: string;
}> {
  const context = await requireComisionesV2IssueContext("read");
  if (context.error || !context.companyId)
    return {
      data: null,
      error: context.error ?? "No se pudo validar el acceso al PDF oficial.",
    };
  const detailResult =
    await getComisionesV2IssuedSettlementDetail(settlementId);
  if (detailResult.error || !detailResult.data)
    return {
      data: null,
      error: detailResult.error ?? "Liquidación V2 no encontrada.",
    };
  const settlement = detailResult.data.settlement;
  const expectedPath = `${context.companyId}/liquidaciones/${settlementId}/${settlement.settlement_code}.pdf`;
  if (
    settlement.status !== "ISSUED" ||
    settlement.official_pdf_storage_bucket !== "comisiones-documentos" ||
    settlement.official_pdf_storage_path !== expectedPath ||
    !settlement.official_pdf_sha256
  )
    return {
      data: null,
      error: "La liquidación no tiene un PDF oficial almacenado.",
    };
  try {
    await verifyStoredOfficialPdf(
      settlement.official_pdf_storage_bucket,
      settlement.official_pdf_storage_path,
      settlement.official_pdf_sha256,
    );
  } catch (verificationError) {
    return {
      data: null,
      error:
        verificationError instanceof Error
          ? verificationError.message
          : "OFFICIAL_PDF_INTEGRITY_MISMATCH",
    };
  }
  const expiresIn = 300;
  const { data: signed, error: signedError } = await comisionesService()
    .storage.from(settlement.official_pdf_storage_bucket)
    .createSignedUrl(settlement.official_pdf_storage_path, expiresIn);
  if (signedError || !signed?.signedUrl)
    return {
      data: null,
      error: "No se pudo generar el acceso temporal al PDF oficial.",
    };
  return { data: { signedUrl: signed.signedUrl, expiresIn } };
}

export async function getComisionesV2OfficialPdfPreview(
  settlementId: string,
): Promise<{
  data: { base64: string; filename: string } | null;
  error?: string;
}> {
  const context = await requireComisionesV2IssueContext("read");
  if (context.error || !context.companyId)
    return {
      data: null,
      error: context.error ?? "No se pudo validar el acceso al PDF oficial.",
    };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      settlementId,
    )
  )
    return { data: null, error: "La liquidación V2 no es válida." };
  const detailResult =
    await getComisionesV2IssuedSettlementDetail(settlementId);
  if (detailResult.error || !detailResult.data)
    return {
      data: null,
      error: detailResult.error ?? "Liquidación V2 no encontrada.",
    };
  const settlement = detailResult.data.settlement;
  const expectedPath = `${context.companyId}/liquidaciones/${settlementId}/${settlement.settlement_code}.pdf`;
  if (
    settlement.status !== "ISSUED" ||
    settlement.official_pdf_storage_bucket !== "comisiones-documentos" ||
    settlement.official_pdf_storage_path !== expectedPath ||
    !settlement.official_pdf_sha256
  )
    return {
      data: null,
      error: "La liquidación no tiene un PDF oficial almacenado.",
    };
  try {
    const buffer = await downloadVerifiedOfficialPdf(
      settlement.official_pdf_storage_bucket,
      settlement.official_pdf_storage_path,
      settlement.official_pdf_sha256,
    );
    return {
      data: {
        base64: buffer.toString("base64"),
        filename: `liquidacion_comisiones_${settlement.settlement_code || settlementId}_emitida.pdf`,
      },
    };
  } catch (verificationError) {
    return {
      data: null,
      error:
        verificationError instanceof Error
          ? verificationError.message
          : "OFFICIAL_PDF_INTEGRITY_MISMATCH",
    };
  }
}

export async function listComisionesV2SettlementDrafts(): Promise<{
  data: ComisionesV2SettlementDraftListItem[];
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 draft list permission validation error",
      permissionError,
    );
    return {
      data: [],
      error: "No se pudo validar el permiso de borradores V2.",
    };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: [],
      error: "No tienes permiso para consultar borradores V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar borradores V2.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("list_settlement_drafts", { p_company_id: companyId });
  if (error) {
    logSupabaseError("Comisiones V2 draft list error", error);
    return { data: [], error: "No se pudieron cargar los borradores V2." };
  }
  return { data: (data ?? []) as ComisionesV2SettlementDraftListItem[] };
}

export async function listComisionesV2SettlementIssued(): Promise<{
  data: ComisionesV2SettlementIssuedListItem[];
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { data: [], error: "No autorizado" };
  const admin = portalAdmin();
  const { data: permissions, error: permissionError } = await admin.rpc(
    "get_user_permissions",
    { p_user_id: user.id },
  );
  if (permissionError) {
    logSupabaseError(
      "Comisiones V2 issued list permission validation error",
      permissionError,
    );
    return { data: [], error: "No se pudo validar el permiso de lectura V2." };
  }
  const permissionCodes = (permissions ?? []).map(
    (permission: { permission_code: string }) => permission.permission_code,
  );
  if (
    !permissionCodes.includes("comisiones.v2.read") &&
    !permissionCodes.includes("comisiones.v2.issue") &&
    !permissionCodes.includes("system.admin")
  )
    return {
      data: [],
      error: "No tienes permiso para consultar liquidaciones emitidas V2.",
    };
  const companyId = await getActiveCompanyId(user);
  if (!companyId)
    return {
      data: [],
      error: "Selecciona una compañía activa para consultar liquidaciones V2.",
    };
  const { data, error } = await supabase
    .schema("comisiones")
    .rpc("list_settlement_issued", { p_company_id: companyId });
  if (error) {
    logSupabaseError("Comisiones V2 issued list error", error);
    return {
      data: [],
      error: "No se pudieron cargar las liquidaciones emitidas V2.",
    };
  }
  return { data: (data ?? []) as ComisionesV2SettlementIssuedListItem[] };
}
