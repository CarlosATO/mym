"use server";

import { commissionDb, getAuthenticatedCompany } from "./auth";
import { numberOrNull, isIsoDate } from "./utils";
import type {
  CommissionPreview,
  CommissionPreviewLine,
  CommissionRuleScope,
  CommissionRuleType,
} from "./types";

export async function previewCommissionSettlement(input: {
  seller_bsale_id: number;
  period_to: string;
  period_from?: string;
}): Promise<CommissionPreview> {
  const { companyId } = await getAuthenticatedCompany();
  const sellerId = Number(input.seller_bsale_id);
  if (
    !Number.isSafeInteger(sellerId) ||
    sellerId <= 0 ||
    !isIsoDate(input.period_to) ||
    (input.period_from && !isIsoDate(input.period_from))
  ) {
    throw new Error("Parámetros de simulación inválidos");
  }

  const { data: seller, error: sellerError } = await commissionDb()
    .from("vw_commission_sellers")
    .select("seller_profile_id,is_commissionable,profile_active")
    .eq("company_id", companyId)
    .eq("seller_bsale_id", sellerId)
    .maybeSingle();
  if (sellerError) throw sellerError;
  if (!seller?.is_commissionable || seller.profile_active !== true)
    throw new Error("El vendedor no está habilitado para comisiones");

  const { count: activeRulesCount, error: rulesError } = await commissionDb()
    .from("commission_rules")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("is_archived", false);
  if (rulesError) throw rulesError;
  const previewFunction = activeRulesCount
    ? "preview_commission_settlement"
    : "preview_default_commission_settlement";

  const pageSize = 1000;
  const rawLines: Record<string, unknown>[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await commissionDb()
      .rpc(previewFunction, {
        p_company_id: companyId,
        p_seller_bsale_id: sellerId,
        p_period_to: input.period_to,
        p_period_from: input.period_from || null,
      })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : data ? [data] : [];
    rawLines.push(...page);
    if (page.length < pageSize) break;
  }

  const previewSupplierIds = Array.from(
    new Set(rawLines.map((row) => String(row.supplier_id || "")).filter(Boolean)),
  );
  const { data: previewSuppliers, error: previewSuppliersError } =
    previewSupplierIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select("id,business_name,fantasy_name,parent_supplier_id")
          .eq("company_id", companyId)
          .in("id", previewSupplierIds)
      : { data: [], error: null };
  if (previewSuppliersError) throw previewSuppliersError;
  const previewParentIds = Array.from(
    new Set(
      (previewSuppliers || [])
        .map((supplier) => supplier.parent_supplier_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const { data: previewParents, error: previewParentsError } =
    previewParentIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select("id,business_name,fantasy_name")
          .eq("company_id", companyId)
          .in("id", previewParentIds)
      : { data: [], error: null };
  if (previewParentsError) throw previewParentsError;
  const previewParentsById = new Map(
    (previewParents || []).map((supplier) => [supplier.id as string, supplier]),
  );
  const previewSuppliersById = new Map(
    (previewSuppliers || []).map((supplier) => {
      const effective = supplier.parent_supplier_id
        ? previewParentsById.get(supplier.parent_supplier_id as string) || supplier
        : supplier;
      return [
        supplier.id as string,
        {
          id: effective.id as string,
          name: String(
            effective.business_name || effective.fantasy_name || "Proveedor sin nombre",
          ),
        },
      ];
    }),
  );
  const baseLines = rawLines.map((row) => ({
    ...row,
    supplier_id:
      previewSuppliersById.get(String(row.supplier_id || ""))?.id || row.supplier_id,
    supplier_name:
      previewSuppliersById.get(String(row.supplier_id || ""))?.name || row.supplier_name,
    seller_bsale_id: Number(row.seller_bsale_id),
    invoice_bsale_id: Number(row.invoice_bsale_id),
    invoice_number: numberOrNull(row.invoice_number),
    quantity: Number(row.quantity),
    net_amount: Number(row.net_amount),
    commission_base_amount: Number(row.commission_base_amount),
    accumulated_amount: Number(row.accumulated_amount),
    accumulated_quantity: Number(row.accumulated_quantity),
    commission_percent: Number(row.commission_percent),
    commission_amount: Number(row.commission_amount),
  })) as Omit<
    CommissionPreviewLine,
    "applied_rule_label" | "applied_rule_scope" | "applied_rule_batch_id"
  >[];

  const { data: supplierRules, error: supplierRulesError } = await commissionDb()
    .from("commission_rules")
    .select(
      "id,rule_scope,rule_type,seller_profile_id,supplier_id,commission_percent,valid_from,valid_to,rule_name,rule_batch_id",
    )
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("is_archived", false)
    .eq("rule_scope", "SUPPLIER")
    .eq("rule_type", "FIXED_PERCENT");
  if (supplierRulesError) throw supplierRulesError;
  const linesWithEffectiveSupplierRules = baseLines.map((line) => {
    if (line.rule_id) return line;
    const applicable = (supplierRules || []).find(
      (rule) =>
        rule.supplier_id === line.supplier_id &&
        (!rule.seller_profile_id ||
          rule.seller_profile_id === seller.seller_profile_id) &&
        line.payment_completed_at &&
        line.payment_completed_at.slice(0, 10) >= rule.valid_from &&
        (!rule.valid_to || line.payment_completed_at.slice(0, 10) <= rule.valid_to),
    );
    return applicable
      ? {
          ...line,
          rule_id: applicable.id as string,
          rule_scope: "SUPPLIER" as CommissionRuleScope,
          rule_type: "FIXED_PERCENT" as CommissionRuleType,
          range_basis: "NONE",
          commission_percent: Number(applicable.commission_percent),
          commission_amount: Math.round(
            (line.net_amount * Number(applicable.commission_percent)) / 100,
          ),
          warning_code: null,
          warning_message: null,
        }
      : line;
  });

  const ruleIds = Array.from(
    new Set(
      linesWithEffectiveSupplierRules
        .map((line) => line.rule_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const { data: appliedRules, error: appliedRulesError } = ruleIds.length
    ? await commissionDb()
        .from("commission_rules")
        .select("id,rule_name,rule_scope,rule_batch_id")
        .eq("company_id", companyId)
        .in("id", ruleIds)
    : { data: [], error: null };
  if (appliedRulesError) throw appliedRulesError;
  const appliedRulesById = new Map(
    (appliedRules || []).map((rule) => [rule.id as string, rule]),
  );
  const fallbackLabel = (scope: CommissionRuleScope) =>
    scope === "PRODUCT"
      ? "Regla por producto"
      : scope === "SUPPLIER"
        ? "Regla por proveedor"
        : scope === "GROUP"
          ? "Regla por grupo"
          : "Regla general específica";
  const lines = linesWithEffectiveSupplierRules.map((line) => {
    const rule = line.rule_id ? appliedRulesById.get(line.rule_id) : null;
    return {
      ...line,
      applied_rule_label:
        rule?.rule_name?.trim() ||
        (line.rule_id ? fallbackLabel(line.rule_scope) : "General"),
      applied_rule_scope:
        (rule?.rule_scope as CommissionRuleScope) || line.rule_scope,
      applied_rule_batch_id: rule?.rule_batch_id || null,
    };
  }) as CommissionPreviewLine[];
  const warnings = new Map<string, { code: string; message: string; count: number }>();
  for (const line of lines) {
    if (line.warning_code) {
      const current = warnings.get(line.warning_code) || {
        code: line.warning_code,
        message: line.warning_message || line.warning_code,
        count: 0,
      };
      current.count++;
      warnings.set(line.warning_code, current);
    }
  }
  const totalNetAmount = lines.reduce((sum, line) => sum + line.net_amount, 0);
  const totalCommissionAmount = lines.reduce(
    (sum, line) => sum + line.commission_amount,
    0,
  );
  return {
    summary: {
      invoices_count: new Set(lines.map((line) => line.invoice_bsale_id)).size,
      lines_count: lines.length,
      total_net_amount: totalNetAmount,
      total_commission_amount: totalCommissionAmount,
      average_commission_percent: totalNetAmount
        ? (totalCommissionAmount / totalNetAmount) * 100
        : 0,
      general_rule_lines: lines.filter(
        (line) => line.warning_code === "DEFAULT_RULE_USED",
      ).length,
      warnings_count: Array.from(warnings.values()).reduce(
        (sum, warning) => sum + warning.count,
        0,
      ),
      period_from: lines[0]?.period_from || input.period_from || "",
      period_to: input.period_to,
    },
    lines,
    warnings: Array.from(warnings.values()),
  };
}
