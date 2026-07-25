"use server";

import { revalidatePath } from "next/cache";
import { commissionDb, getAuthenticatedCompany } from "./auth";
import { isIsoDate, numberOrNull } from "./utils";
import type {
  CommissionRule,
  CommissionRuleScope,
  CommissionRuleType,
} from "./types";

export async function getCommissionRules(): Promise<CommissionRule[]> {
  const { companyId } = await getAuthenticatedCompany();
  const { data, error } = await commissionDb()
    .from("commission_rules")
    .select(
      "id,rule_scope,seller_profile_id,supplier_id,commission_group_id,product_id,rule_type,range_basis,min_amount,max_amount,min_quantity,max_quantity,commission_percent,valid_from,valid_to,priority,is_active,is_archived,archived_at,archive_reason,notes,rule_name,rule_description,rule_batch_id,selection_summary",
    )
    .eq("company_id", companyId)
    .order("is_active", { ascending: false })
    .order("rule_scope")
    .order("priority", { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => ({
    ...row,
    min_amount: numberOrNull(row.min_amount),
    max_amount: numberOrNull(row.max_amount),
    min_quantity: numberOrNull(row.min_quantity),
    max_quantity: numberOrNull(row.max_quantity),
    commission_percent: Number(row.commission_percent),
  })) as CommissionRule[];
}

export async function upsertCommissionRule(
  input: Omit<CommissionRule, "id" | "range_basis"> & { id?: string },
) {
  const { companyId, userId } = await getAuthenticatedCompany();
  const scope = input.rule_scope;
  const type = input.rule_type;
  const validFrom = input.valid_from;
  if (
    !isIsoDate(validFrom) ||
    (input.valid_to && !isIsoDate(input.valid_to)) ||
    (input.valid_to && input.valid_to < validFrom)
  )
    throw new Error("Vigencia inválida");
  const percent = Number(input.commission_percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100)
    throw new Error("El porcentaje debe estar entre 0 y 100");
  const targets = {
    supplier_id: input.supplier_id || null,
    commission_group_id: input.commission_group_id || null,
    product_id: input.product_id || null,
  };
  const validTarget =
    (scope === "GENERAL" &&
      !targets.supplier_id &&
      !targets.commission_group_id &&
      !targets.product_id) ||
    (scope === "SUPPLIER" &&
      targets.supplier_id &&
      !targets.commission_group_id &&
      !targets.product_id) ||
    (scope === "GROUP" &&
      !targets.supplier_id &&
      targets.commission_group_id &&
      !targets.product_id) ||
    (scope === "PRODUCT" &&
      !targets.supplier_id &&
      !targets.commission_group_id &&
      targets.product_id);
  if (!validTarget)
    throw new Error("El destino de la regla no corresponde al ámbito seleccionado");

  const minAmount = type === "RANGE_BY_AMOUNT" ? Number(input.min_amount) : null;
  const maxAmount =
    type === "RANGE_BY_AMOUNT" && input.max_amount !== null
      ? Number(input.max_amount)
      : null;
  const minQuantity =
    type === "RANGE_BY_QUANTITY" ? Number(input.min_quantity) : null;
  const maxQuantity =
    type === "RANGE_BY_QUANTITY" && input.max_quantity !== null
      ? Number(input.max_quantity)
      : null;
  if (
    type === "RANGE_BY_AMOUNT" &&
    (!Number.isFinite(minAmount ?? NaN) ||
      (minAmount ?? -1) < 0 ||
      (maxAmount !== null &&
        (!Number.isFinite(maxAmount) || maxAmount < (minAmount ?? 0))))
  )
    throw new Error("Rango de monto inválido");
  if (
    type === "RANGE_BY_QUANTITY" &&
    (!Number.isFinite(minQuantity ?? NaN) ||
      (minQuantity ?? -1) < 0 ||
      (maxQuantity !== null &&
        (!Number.isFinite(maxQuantity) || maxQuantity < (minQuantity ?? 0))))
  )
    throw new Error("Rango de cantidad inválido");

  const { data: existingRules, error: existingRulesError } =
    await commissionDb()
      .from("commission_rules")
      .select(
        "id,seller_profile_id,supplier_id,commission_group_id,product_id,rule_type,valid_from,valid_to,min_amount,max_amount,min_quantity,max_quantity",
      )
      .eq("company_id", companyId)
      .eq("rule_scope", scope)
      .eq("is_active", true);
  if (existingRulesError) throw existingRulesError;
  const sameTarget = (
    rule: typeof existingRules extends Array<infer Row> ? Row : never,
  ) =>
    rule.seller_profile_id === (input.seller_profile_id || null) &&
    rule.supplier_id === targets.supplier_id &&
    rule.commission_group_id === targets.commission_group_id &&
    rule.product_id === targets.product_id;
  const periodOverlaps = (
    rule: typeof existingRules extends Array<infer Row> ? Row : never,
  ) =>
    rule.valid_from <= (input.valid_to || "9999-12-31") &&
    validFrom <= (rule.valid_to || "9999-12-31");
  const rangeOverlaps = (
    rule: typeof existingRules extends Array<infer Row> ? Row : never,
  ) => {
    if (rule.rule_type !== type) return false;
    if (type === "FIXED_PERCENT") return true;
    const nextMin =
      type === "RANGE_BY_AMOUNT" ? (minAmount ?? 0) : (minQuantity ?? 0);
    const nextMax = type === "RANGE_BY_AMOUNT" ? maxAmount : maxQuantity;
    const currentMin = Number(
      type === "RANGE_BY_AMOUNT" ? rule.min_amount : rule.min_quantity,
    );
    const currentMaxValue =
      type === "RANGE_BY_AMOUNT" ? rule.max_amount : rule.max_quantity;
    const currentMax =
      currentMaxValue === null ? null : Number(currentMaxValue);
    return (
      currentMin <= (nextMax ?? Infinity) && nextMin <= (currentMax ?? Infinity)
    );
  };
  if (
    (existingRules || []).some(
      (rule) =>
        rule.id !== input.id &&
        sameTarget(rule) &&
        periodOverlaps(rule) &&
        rangeOverlaps(rule),
    )
  ) {
    throw new Error(
      "Existe una regla activa con rango y vigencia solapados para este ámbito",
    );
  }

  const payload = {
    company_id: companyId,
    rule_scope: scope,
    seller_profile_id: input.seller_profile_id || null,
    ...targets,
    rule_type: type,
    range_basis:
      type === "FIXED_PERCENT"
        ? "NONE"
        : type === "RANGE_BY_AMOUNT"
          ? "AMOUNT"
          : "QUANTITY",
    min_amount: minAmount ?? null,
    max_amount: maxAmount,
    min_quantity: minQuantity ?? null,
    max_quantity: maxQuantity,
    commission_percent: percent,
    valid_from: validFrom,
    valid_to: input.valid_to || null,
    priority: Math.max(0, Number(input.priority) || 0),
    is_active: Boolean(input.is_active),
    notes: input.notes?.trim() || null,
    updated_by: userId,
  };
  const query = input.id
    ? commissionDb()
        .from("commission_rules")
        .update(payload)
        .eq("id", input.id)
        .eq("company_id", companyId)
    : commissionDb()
        .from("commission_rules")
        .insert({ ...payload, created_by: userId });
  const { data, error } = await query.select("id").single();
  if (error) throw error;
  return data as { id: string };
}

export async function deactivateCommissionRule(ruleId: string) {
  const { companyId, userId } = await getAuthenticatedCompany();
  const { error } = await commissionDb()
    .from("commission_rules")
    .update({ is_active: false, updated_by: userId })
    .eq("id", ruleId)
    .eq("company_id", companyId);
  if (error) throw error;
}

export async function getCommissionRuleBatchDetail(ruleBatchId: string) {
  const { companyId } = await getAuthenticatedCompany();
  if (!ruleBatchId.trim()) throw new Error("Condición inválida");
  const { data: rules, error } = await commissionDb()
    .from("commission_rules")
    .select(
      "id,rule_name,rule_description,rule_batch_id,rule_scope,rule_type,seller_profile_id,supplier_id,commission_group_id,product_id,min_amount,max_amount,min_quantity,max_quantity,commission_percent,valid_from,valid_to,is_active",
    )
    .eq("company_id", companyId)
    .eq("rule_batch_id", ruleBatchId);
  if (error) throw error;
  if (!rules?.length)
    throw new Error("La condición no pertenece a la empresa activa");

  const sellerIds = Array.from(
    new Set(
      rules
        .map((rule) => rule.seller_profile_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const productIds = Array.from(
    new Set(
      rules
        .map((rule) => rule.product_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const supplierIds = Array.from(
    new Set(
      rules
        .map((rule) => rule.supplier_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const groupIds = Array.from(
    new Set(
      rules
        .map((rule) => rule.commission_group_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const [
    { data: sellers, error: sellersError },
    { data: products, error: productsError },
    { data: suppliers, error: suppliersError },
    { data: groups, error: groupsError },
  ] = await Promise.all([
    sellerIds.length
      ? commissionDb()
          .from("commission_seller_profiles")
          .select("id,seller_name,seller_bsale_id")
          .eq("company_id", companyId)
          .in("id", sellerIds)
      : Promise.resolve({ data: [], error: null }),
    productIds.length
      ? commissionDb()
          .schema("adquisiciones")
          .from("products")
          .select("id,sku,description")
          .eq("company_id", companyId)
          .in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    supplierIds.length
      ? commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select("id,business_name,fantasy_name")
          .eq("company_id", companyId)
          .in("id", supplierIds)
      : Promise.resolve({ data: [], error: null }),
    groupIds.length
      ? commissionDb()
          .from("commission_groups")
          .select("id,name")
          .eq("company_id", companyId)
          .in("id", groupIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sellersError || productsError || suppliersError || groupsError)
    throw sellersError || productsError || suppliersError || groupsError;

  const { data: productMappings, error: productMappingsError } =
    productIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("product_supplier_mappings")
          .select("product_id,supplier_id,is_preferred")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .in("product_id", productIds)
          .order("is_preferred", { ascending: false })
      : { data: [], error: null };
  if (productMappingsError) throw productMappingsError;
  const mappedSupplierIds = Array.from(
    new Set(
      (productMappings || [])
        .map((mapping) => mapping.supplier_id as string)
        .filter(Boolean),
    ),
  );
  const { data: mappedSuppliers, error: mappedSuppliersError } =
    mappedSupplierIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select("id,business_name,fantasy_name")
          .eq("company_id", companyId)
          .in("id", mappedSupplierIds)
      : { data: [], error: null };
  if (mappedSuppliersError) throw mappedSuppliersError;
  const mappedSupplierNames = new Map(
    (mappedSuppliers || []).map((supplier) => [
      supplier.id as string,
      String(
        supplier.business_name ||
          supplier.fantasy_name ||
          "Sin proveedor asociado",
      ),
    ]),
  );
  const productSupplierNames = new Map<string, string>();
  for (const mapping of productMappings || [])
    if (!productSupplierNames.has(mapping.product_id as string))
      productSupplierNames.set(
        mapping.product_id as string,
        mappedSupplierNames.get(mapping.supplier_id as string) ||
          "Sin proveedor asociado",
      );
  const first = rules[0];
  return {
    id: ruleBatchId,
    name: String(first.rule_name || "Condición de comisión"),
    description: first.rule_description as string | null,
    validFrom: first.valid_from as string,
    validTo: first.valid_to as string | null,
    isActive: Boolean(first.is_active),
    scope: first.rule_scope as CommissionRuleScope,
    type: first.rule_type as CommissionRuleType,
    commissionPercent: Number(first.commission_percent),
    minAmount: numberOrNull(first.min_amount),
    maxAmount: numberOrNull(first.max_amount),
    minQuantity: numberOrNull(first.min_quantity),
    maxQuantity: numberOrNull(first.max_quantity),
    sellers: (sellers || []).map((seller) => ({
      name: seller.seller_name as string,
      bsaleId: Number(seller.seller_bsale_id),
    })),
    products: (products || []).map((product) => ({
      id: product.id as string,
      sku: product.sku as string,
      name: product.description as string,
      supplierName:
        productSupplierNames.get(product.id as string) || "Sin proveedor asociado",
    })),
    suppliers: (suppliers || []).map((supplier) => ({
      name: String(
        supplier.business_name || supplier.fantasy_name || "Proveedor sin nombre",
      ),
    })),
    groups: (groups || []).map((group) => ({ name: group.name as string })),
  };
}

export async function deactivateCommissionRuleBatch(ruleBatchId: string) {
  const { companyId, userId } = await getAuthenticatedCompany();
  const { error } = await commissionDb()
    .from("commission_rules")
    .update({ is_active: false, updated_by: userId })
    .eq("company_id", companyId)
    .eq("rule_batch_id", ruleBatchId);
  if (error) throw error;
}

export async function setCommissionRuleBatchActive(
  ruleBatchId: string,
  isActive: boolean,
) {
  const { companyId, userId } = await getAuthenticatedCompany();
  if (!ruleBatchId.trim()) throw new Error("Condición inválida");
  let request = commissionDb()
    .from("commission_rules")
    .update({ is_active: isActive, updated_by: userId })
    .eq("company_id", companyId)
    .eq("rule_batch_id", ruleBatchId);
  if (isActive) request = request.eq("is_archived", false);
  const { error } = await request;
  if (error) throw error;
  revalidatePath("/dashboard/comercial");
}

export async function archiveCommissionRuleBatch(input: {
  ruleBatchId: string;
  archiveReason?: string;
}) {
  const { companyId, userId } = await getAuthenticatedCompany();
  if (!input.ruleBatchId.trim()) throw new Error("Condición inválida");
  const { error } = await commissionDb()
    .from("commission_rules")
    .update({
      is_archived: true,
      archived_at: new Date().toISOString(),
      archived_by: userId,
      archive_reason: input.archiveReason?.trim() || null,
      is_active: false,
      updated_by: userId,
    })
    .eq("company_id", companyId)
    .eq("rule_batch_id", input.ruleBatchId);
  if (error) throw error;
  revalidatePath("/dashboard/comercial");
}

export async function restoreCommissionRuleBatch(ruleBatchId: string) {
  const { companyId, userId } = await getAuthenticatedCompany();
  if (!ruleBatchId.trim()) throw new Error("Condición inválida");
  const { error } = await commissionDb()
    .from("commission_rules")
    .update({
      is_archived: false,
      archived_at: null,
      archived_by: null,
      archive_reason: null,
      is_active: false,
      updated_by: userId,
    })
    .eq("company_id", companyId)
    .eq("rule_batch_id", ruleBatchId);
  if (error) throw error;
  revalidatePath("/dashboard/comercial");
}

export async function getCommissionGroupProducts(groupId: string) {
  const { companyId } = await getAuthenticatedCompany();
  const { data, error } = await commissionDb()
    .from("commission_group_products")
    .select("product_id,valid_from,valid_to,is_active")
    .eq("company_id", companyId)
    .eq("commission_group_id", groupId)
    .eq("is_active", true);
  if (error) throw error;
  const ids = (data || []).map((row) => row.product_id as string);
  if (!ids.length) return [];
  const { data: products, error: productsError } = await commissionDb()
    .schema("adquisiciones")
    .from("products")
    .select("id,sku,description")
    .in("id", ids);
  if (productsError) throw productsError;
  return products || [];
}

export async function updateCommissionGroupProducts(
  groupId: string,
  productIds: string[],
) {
  const { companyId, userId } = await getAuthenticatedCompany();
  const uniqueIds = Array.from(new Set(productIds.filter(Boolean)));
  const { error: deactivateError } = await commissionDb()
    .from("commission_group_products")
    .update({ is_active: false, updated_by: userId })
    .eq("company_id", companyId)
    .eq("commission_group_id", groupId)
    .eq("is_active", true);
  if (deactivateError) throw deactivateError;
  if (!uniqueIds.length) return;
  const { error } = await commissionDb()
    .from("commission_group_products")
    .insert(
      uniqueIds.map((product_id) => ({
        company_id: companyId,
        commission_group_id: groupId,
        product_id,
        valid_from: new Date().toISOString().slice(0, 10),
        is_active: true,
        created_by: userId,
        updated_by: userId,
      })),
    );
  if (error) throw error;
}

export async function createGuidedCommissionRule(input: {
  ruleName: string;
  description?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  appliesToAllSellers: boolean;
  sellerProfileIds?: string[];
  targetMode:
    | "GENERAL"
    | "SUPPLIER_ALL_PRODUCTS"
    | "SUPPLIER_SELECTED_PRODUCTS"
    | "EXISTING_GROUP"
    | "SELECTED_PRODUCTS";
  supplierIds?: string[];
  groupIds?: string[];
  productIds?: string[];
  commissionType: CommissionRuleType;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  commissionPercent: number;
}) {
  const { companyId, userId } = await getAuthenticatedCompany();
  if (
    !input.ruleName.trim() ||
    !isIsoDate(input.effectiveFrom) ||
    (input.effectiveTo &&
      (!isIsoDate(input.effectiveTo) || input.effectiveTo < input.effectiveFrom))
  )
    throw new Error("Nombre o vigencia inválidos");
  if (
    !Number.isFinite(input.commissionPercent) ||
    input.commissionPercent < 0 ||
    input.commissionPercent > 100
  )
    throw new Error("Porcentaje inválido");
  const sellerIds = input.appliesToAllSellers
    ? [null]
    : Array.from(new Set(input.sellerProfileIds || []));
  if (!sellerIds.length) throw new Error("Selecciona al menos un vendedor");
  const batchId = crypto.randomUUID();
  let targets: Array<{ scope: CommissionRuleScope; id: string | null }> = [];
  if (input.targetMode === "GENERAL")
    targets = [{ scope: "GENERAL", id: null }];
  if (input.targetMode === "SUPPLIER_ALL_PRODUCTS") {
    const supplierIds = Array.from(new Set(input.supplierIds || []));
    if (!supplierIds.length)
      throw new Error("Selecciona al menos un proveedor");
    if (input.commissionType === "FIXED_PERCENT") {
      targets = supplierIds.map((id) => ({ scope: "SUPPLIER" as const, id }));
    } else {
      const { data: mappings, error } = await commissionDb()
        .schema("adquisiciones")
        .from("product_supplier_mappings")
        .select("product_id,supplier_id")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .in("supplier_id", supplierIds);
      if (error) throw error;
      const productIds = Array.from(
        new Set(
          (mappings || []).map((row) => row.product_id as string).filter(Boolean),
        ),
      );
      if (!productIds.length)
        throw new Error(
          "Los proveedores seleccionados no tienen productos activos para crear una regla variable por SKU",
        );
      targets = productIds.map((id) => ({ scope: "PRODUCT" as const, id }));
    }
  }
  if (input.targetMode === "EXISTING_GROUP")
    targets = (input.groupIds || []).map((id) => ({
      scope:
        input.commissionType === "FIXED_PERCENT"
          ? ("GROUP" as const)
          : ("PRODUCT" as const),
      id,
    }));
  if (
    input.targetMode === "SUPPLIER_SELECTED_PRODUCTS" ||
    input.targetMode === "SELECTED_PRODUCTS"
  )
    targets = (input.productIds || []).map((id) => ({
      scope: "PRODUCT" as const,
      id,
    }));
  if (!targets.length) throw new Error("Selecciona al menos un destino");
  if (
    input.commissionType !== "FIXED_PERCENT" &&
    ((input.commissionType === "RANGE_BY_AMOUNT" && !(Number(input.minAmount) > 0)) ||
      (input.commissionType === "RANGE_BY_QUANTITY" &&
        !(Number(input.minQuantity) > 0)))
  )
    throw new Error("Debes indicar un mínimo mayor a cero");
  if (
    input.commissionType === "RANGE_BY_AMOUNT" &&
    input.maxAmount !== null &&
    input.maxAmount !== undefined &&
    Number(input.maxAmount) < Number(input.minAmount)
  )
    throw new Error("El monto máximo no puede ser menor al mínimo");
  if (
    input.commissionType === "RANGE_BY_QUANTITY" &&
    input.maxQuantity !== null &&
    input.maxQuantity !== undefined &&
    Number(input.maxQuantity) < Number(input.minQuantity)
  )
    throw new Error("La cantidad máxima no puede ser menor a la mínima");

  if (
    input.commissionType !== "FIXED_PERCENT" &&
    input.targetMode === "EXISTING_GROUP"
  )
    throw new Error(
      "Para una regla variable de grupo, selecciona los productos incluidos para evaluar cada SKU individualmente",
    );
  const { data: activeRules, error: activeRulesError } = await commissionDb()
    .from("commission_rules")
    .select(
      "rule_name,rule_scope,seller_profile_id,supplier_id,commission_group_id,product_id,valid_from,valid_to",
    )
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("is_archived", false);
  if (activeRulesError) throw activeRulesError;
  const newPeriodEnd = input.effectiveTo || "9999-12-31";
  const conflict = (activeRules || []).find((rule) =>
    targets.some((target) => {
      const sameTarget =
        target.scope === "GENERAL" ||
        (target.scope === "SUPPLIER" && rule.supplier_id === target.id) ||
        (target.scope === "GROUP" && rule.commission_group_id === target.id) ||
        (target.scope === "PRODUCT" && rule.product_id === target.id);
      const sellersOverlap = sellerIds.some(
        (sellerId) =>
          sellerId === null ||
          rule.seller_profile_id === null ||
          rule.seller_profile_id === sellerId,
      );
      return (
        rule.rule_scope === target.scope &&
        sameTarget &&
        sellersOverlap &&
        rule.valid_from <= newPeriodEnd &&
        (rule.valid_to === null || rule.valid_to >= input.effectiveFrom)
      );
    }),
  );
  if (conflict) {
    const targetLabel =
      conflict.rule_scope === "SUPPLIER"
        ? "proveedor"
        : conflict.rule_scope === "PRODUCT"
          ? "producto"
          : conflict.rule_scope === "GROUP"
            ? "grupo/campaña"
            : "general";
    throw new Error(
      `Ya existe una condición activa para este ${targetLabel}, vendedor y período: ${conflict.rule_name || "Condición sin nombre"}. Desactívala o archívala antes de crear otra.`,
    );
  }
  const rows = targets.flatMap((target) =>
    sellerIds.map((seller_profile_id) => ({
      company_id: companyId,
      seller_profile_id,
      rule_scope: target.scope,
      supplier_id: target.scope === "SUPPLIER" ? target.id : null,
      commission_group_id: target.scope === "GROUP" ? target.id : null,
      product_id: target.scope === "PRODUCT" ? target.id : null,
      rule_type: input.commissionType,
      range_basis:
        input.commissionType === "FIXED_PERCENT"
          ? "NONE"
          : input.commissionType === "RANGE_BY_AMOUNT"
            ? "AMOUNT"
            : "QUANTITY",
      min_amount:
        input.commissionType === "RANGE_BY_AMOUNT" ? input.minAmount : null,
      max_amount:
        input.commissionType === "RANGE_BY_AMOUNT"
          ? input.maxAmount || null
          : null,
      min_quantity:
        input.commissionType === "RANGE_BY_QUANTITY" ? input.minQuantity : null,
      max_quantity:
        input.commissionType === "RANGE_BY_QUANTITY"
          ? input.maxQuantity || null
          : null,
      commission_percent: input.commissionPercent,
      valid_from: input.effectiveFrom,
      valid_to: input.effectiveTo || null,
      priority:
        target.scope === "PRODUCT"
          ? 400
          : target.scope === "GROUP"
            ? 300
            : target.scope === "SUPPLIER"
              ? 200
              : 100,
      is_active: true,
      rule_name: input.ruleName.trim(),
      rule_description: input.description?.trim() || null,
      rule_batch_id: batchId,
      source_workflow: "GUIDED_WIZARD",
      selection_summary: {
        targetMode: input.targetMode,
        suppliers: input.supplierIds || [],
        groups: input.groupIds || [],
        products: input.productIds || [],
        sellers: sellerIds,
      },
      created_by: userId,
      updated_by: userId,
    })),
  );
  const { error } = await commissionDb().from("commission_rules").insert(rows);
  if (error) throw error;
  return { ruleBatchId: batchId, technicalRulesCreated: rows.length };
}

export async function addProductsToCommissionRuleBatch(
  ruleBatchId: string,
  productIds: string[],
) {
  const { companyId, userId } = await getAuthenticatedCompany();
  if (!ruleBatchId.trim()) throw new Error("Condición inválida");
  const uniqueIds = Array.from(new Set(productIds.filter(Boolean)));
  if (!uniqueIds.length)
    throw new Error("Debes seleccionar al menos un producto");

  const { data: existing, error } = await commissionDb()
    .from("commission_rules")
    .select("*")
    .eq("company_id", companyId)
    .eq("rule_batch_id", ruleBatchId);
  if (error) throw error;
  if (!existing?.length)
    throw new Error("La condición no pertenece a la empresa activa");

  const first = existing[0];
  if (first.rule_scope !== "PRODUCT")
    throw new Error(
      "Esta operación solo aplica para condiciones basadas en productos",
    );

  const existingProductIds = new Set(
    existing
      .map((rule) => rule.product_id as string | null)
      .filter((id): id is string => Boolean(id)),
  );
  const productIdsToInsert = uniqueIds.filter(
    (productId) => !existingProductIds.has(productId),
  );
  if (!productIdsToInsert.length)
    throw new Error(
      "Todos los productos seleccionados ya están incluidos en esta condición",
    );

  const sellerIds = Array.from(
    new Set(existing.map((rule) => rule.seller_profile_id as string | null)),
  );

  const { data: activeRules, error: activeRulesError } = await commissionDb()
    .from("commission_rules")
    .select(
      "rule_name,rule_batch_id,rule_scope,seller_profile_id,product_id,valid_from,valid_to",
    )
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("is_archived", false)
    .eq("rule_scope", "PRODUCT");
  if (activeRulesError) throw activeRulesError;

  const periodFrom = String(first.valid_from);
  const periodTo = String(first.valid_to || "9999-12-31");
  const conflictingRule = (activeRules || []).find(
    (rule) =>
      rule.rule_batch_id !== ruleBatchId &&
      productIdsToInsert.includes(rule.product_id as string) &&
      sellerIds.some(
        (sellerId) =>
          sellerId === null ||
          rule.seller_profile_id === null ||
          rule.seller_profile_id === sellerId,
      ) &&
      String(rule.valid_from) <= periodTo &&
      String(rule.valid_to || "9999-12-31") >= periodFrom,
  );
  if (conflictingRule)
    throw new Error(
      `Ya existe una condición activa para este producto, vendedor y período: ${conflictingRule.rule_name || "Condición sin nombre"}. Desactívala o archívala antes de agregar productos.`,
    );

  const newRows = productIdsToInsert.flatMap((productId) =>
    sellerIds.map((sellerProfileId) => {
      const row = { ...first };
      delete row.id;
      delete row.created_at;
      delete row.updated_at;
      row.seller_profile_id = sellerProfileId;
      row.product_id = productId;
      row.created_by = userId;
      row.updated_by = userId;
      return row;
    }),
  );

  const { error: insertError } = await commissionDb()
    .from("commission_rules")
    .insert(newRows);
  if (insertError) throw insertError;
  return { technicalRulesCreated: newRows.length };
}
