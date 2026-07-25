"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { commissionDb, getAuthenticatedCompany } from "./auth";
import type { CommissionRuleProductCandidate } from "./types";

export async function searchCommissionProducts(
  query: string,
  supplierIds?: string[],
) {
  const { companyId } = await getAuthenticatedCompany();
  const term = query.trim();
  if (term.length < 2) return [];
  const { data, error } = await commissionDb()
    .schema("adquisiciones")
    .from("products")
    .select("id,sku,description")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .or(`sku.ilike.%${term}%,description.ilike.%${term}%`)
    .order("description")
    .limit(30);
  if (error) throw error;
  const products = (data || []).map((row) => ({
    id: row.id as string,
    sku: row.sku as string,
    description: row.description as string,
  }));
  if (!products.length) return [];

  const mappingsRequest = commissionDb()
    .schema("adquisiciones")
    .from("product_supplier_mappings")
    .select("product_id,supplier_id,is_preferred,updated_at")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in(
      "product_id",
      products.map((product) => product.id),
    )
    .order("is_preferred", { ascending: false })
    .order("updated_at", { ascending: false, nullsFirst: false });
  const selectedSupplierIds = Array.from(
    new Set((supplierIds || []).filter(Boolean)),
  );
  const { data: mappings, error: mappingsError } = await mappingsRequest;
  if (mappingsError) throw mappingsError;

  const mappingSupplierIds = Array.from(
    new Set(
      (mappings || [])
        .map((mapping) => mapping.supplier_id as string)
        .filter(Boolean),
    ),
  );
  const { data: mappedSuppliers, error: mappedSuppliersError } =
    mappingSupplierIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select(
            "id,business_name,fantasy_name,supplier_kind,parent_supplier_id",
          )
          .eq("company_id", companyId)
          .eq("is_active", true)
          .in("id", mappingSupplierIds)
      : { data: [], error: null };
  if (mappedSuppliersError) throw mappedSuppliersError;
  const parentIds = Array.from(
    new Set(
      (mappedSuppliers || [])
        .map((supplier) => supplier.parent_supplier_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const { data: parentSuppliers, error: parentSuppliersError } =
    parentIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select("id,business_name,fantasy_name,supplier_kind")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .or("supplier_kind.eq.REAL,supplier_kind.is.null")
          .in("id", parentIds)
      : { data: [], error: null };
  if (parentSuppliersError) throw parentSuppliersError;

  const parentsById = new Map(
    (parentSuppliers || []).map((supplier) => [supplier.id as string, supplier]),
  );
  const suppliersById = new Map(
    (mappedSuppliers || []).map((supplier) => {
      const parent = supplier.parent_supplier_id
        ? parentsById.get(supplier.parent_supplier_id as string)
        : null;
      const effective = parent || supplier;
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
  const mappingByProduct = new Map<string, { supplier_id: string; supplier_name: string }>();
  for (const mapping of mappings || []) {
    const supplier = suppliersById.get(mapping.supplier_id as string);
    if (supplier && !mappingByProduct.has(mapping.product_id as string)) {
      mappingByProduct.set(mapping.product_id as string, {
        supplier_id: supplier.id,
        supplier_name: supplier.name,
      });
    }
  }

  return products
    .filter(
      (product) =>
        !selectedSupplierIds.length ||
        (mappingByProduct.get(product.id)?.supplier_id &&
          selectedSupplierIds.includes(mappingByProduct.get(product.id)!.supplier_id)),
    )
    .map((product) => ({
      ...product,
      supplier_id: mappingByProduct.get(product.id)?.supplier_id || null,
      supplier_name: mappingByProduct.get(product.id)?.supplier_name || null,
    }));
}

export async function searchCommissionRuleProductCandidates(
  query: string,
  ruleBatchId?: string,
): Promise<CommissionRuleProductCandidate[]> {
  const { companyId } = await getAuthenticatedCompany();
  const term = query.trim();
  if (term.length < 2) return [];

  const normalizedTerm = term.replace(/,/g, " ");
  const numericTerm = /^\d+$/.test(term) ? Number(term) : null;

  const [
    { data: directProducts, error: directProductsError },
    { data: matchedSuppliers, error: matchedSuppliersError },
    { data: includedRules, error: includedRulesError },
  ] = await Promise.all([
    commissionDb()
      .schema("adquisiciones")
      .from("products")
      .select(
        "id,sku,description,internal_code,barcode,bsale_product_id,bsale_variant_id,is_active",
      )
      .eq("company_id", companyId)
      .eq("is_active", true)
      .or(
        `sku.ilike.%${normalizedTerm}%,description.ilike.%${normalizedTerm}%,internal_code.ilike.%${normalizedTerm}%,barcode.ilike.%${normalizedTerm}%`,
      )
      .limit(40),
    commissionDb()
      .schema("adquisiciones")
      .from("suppliers")
      .select("id,business_name,fantasy_name,supplier_kind,parent_supplier_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .or(
        `business_name.ilike.%${normalizedTerm}%,fantasy_name.ilike.%${normalizedTerm}%`,
      )
      .limit(40),
    ruleBatchId?.trim()
      ? commissionDb()
          .from("commission_rules")
          .select("product_id")
          .eq("company_id", companyId)
          .eq("rule_batch_id", ruleBatchId)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (directProductsError || matchedSuppliersError || includedRulesError)
    throw (
      directProductsError ||
      matchedSuppliersError ||
      includedRulesError ||
      new Error("No se pudieron buscar productos candidatos")
    );

  const matchedSupplierRows = matchedSuppliers || [];
  const matchedSupplierIds = new Set(
    matchedSupplierRows.map((supplier) => supplier.id as string),
  );
  const matchedRealSupplierIds = Array.from(
    new Set(
      matchedSupplierRows
        .filter(
          (supplier) =>
            (supplier.supplier_kind as string | null) === "REAL" ||
            supplier.parent_supplier_id === null,
        )
        .map((supplier) => supplier.id as string),
    ),
  );

  const { data: childSuppliers, error: childSuppliersError } =
    matchedRealSupplierIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select("id,parent_supplier_id")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .in("parent_supplier_id", matchedRealSupplierIds)
      : { data: [], error: null };
  if (childSuppliersError) throw childSuppliersError;
  for (const supplier of childSuppliers || []) matchedSupplierIds.add(supplier.id as string);
  for (const supplier of matchedSupplierRows) {
    if (supplier.parent_supplier_id)
      matchedSupplierIds.add(supplier.parent_supplier_id as string);
  }

  const { data: mappingMatches, error: mappingMatchesError } =
    matchedSupplierIds.size
      ? await commissionDb()
          .schema("adquisiciones")
          .from("product_supplier_mappings")
          .select("product_id,supplier_id")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .in("supplier_id", Array.from(matchedSupplierIds))
          .limit(200)
      : { data: [], error: null };
  if (mappingMatchesError) throw mappingMatchesError;

  const candidateProductIds = new Set<string>(
    (directProducts || []).map((product) => product.id as string),
  );
  for (const mapping of mappingMatches || []) {
    if (mapping.product_id) candidateProductIds.add(mapping.product_id as string);
  }

  if (numericTerm !== null) {
    const { data: numericProducts, error: numericProductsError } =
      await commissionDb()
        .schema("adquisiciones")
        .from("products")
        .select("id")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .or(`bsale_product_id.eq.${numericTerm},bsale_variant_id.eq.${numericTerm}`)
        .limit(20);
    if (numericProductsError) throw numericProductsError;
    for (const product of numericProducts || []) {
      candidateProductIds.add(product.id as string);
    }
  }

  if (!candidateProductIds.size) return [];

  const { data: candidateProducts, error: candidateProductsError } =
    await commissionDb()
      .schema("adquisiciones")
      .from("products")
      .select("id,sku,description,bsale_product_id,bsale_variant_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("id", Array.from(candidateProductIds))
      .limit(60);
  if (candidateProductsError) throw candidateProductsError;

  const { data: candidateMappings, error: candidateMappingsError } =
    await commissionDb()
      .schema("adquisiciones")
      .from("product_supplier_mappings")
      .select("product_id,supplier_id,is_preferred,updated_at")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("product_id", Array.from(candidateProductIds))
      .order("is_preferred", { ascending: false })
      .order("updated_at", { ascending: false, nullsFirst: false });
  if (candidateMappingsError) throw candidateMappingsError;

  const candidateSupplierIds = Array.from(
    new Set(
      (candidateMappings || [])
        .map((mapping) => mapping.supplier_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const { data: candidateSuppliers, error: candidateSuppliersError } =
    candidateSupplierIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select(
            "id,business_name,fantasy_name,supplier_kind,parent_supplier_id",
          )
          .eq("company_id", companyId)
          .eq("is_active", true)
          .in("id", candidateSupplierIds)
      : { data: [], error: null };
  if (candidateSuppliersError) throw candidateSuppliersError;

  const parentSupplierIds = Array.from(
    new Set(
      (candidateSuppliers || [])
        .map((supplier) => supplier.parent_supplier_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const { data: parentSuppliers, error: parentSuppliersError } =
    parentSupplierIds.length
      ? await commissionDb()
          .schema("adquisiciones")
          .from("suppliers")
          .select("id,business_name,fantasy_name")
          .eq("company_id", companyId)
          .eq("is_active", true)
          .in("id", parentSupplierIds)
      : { data: [], error: null };
  if (parentSuppliersError) throw parentSuppliersError;

  const variantIds = Array.from(
    new Set(
      (candidateProducts || [])
        .map((product) => Number(product.bsale_variant_id || 0))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );
  const { data: stockRows, error: stockRowsError } = variantIds.length
    ? await createAdminClient()
        .schema("integraciones")
        .from("bsale_stock_current")
        .select("variant_id,quantity_available")
        .eq("company_id", companyId)
        .in("variant_id", variantIds)
    : { data: [], error: null };
  if (stockRowsError) throw stockRowsError;

  const includedProductIds = new Set(
    (includedRules || [])
      .map((rule) => rule.product_id as string | null)
      .filter((id): id is string => Boolean(id)),
  );
  const parentSuppliersById = new Map(
    (parentSuppliers || []).map((supplier) => [
      supplier.id as string,
      String(
        supplier.business_name || supplier.fantasy_name || "Proveedor sin nombre",
      ),
    ]),
  );
  const suppliersById = new Map(
    (candidateSuppliers || []).map((supplier) => [supplier.id as string, supplier]),
  );
  const preferredSupplierByProduct = new Map<
    string,
    { operative_supplier_name: string | null; real_supplier_name: string | null }
  >();
  for (const mapping of candidateMappings || []) {
    const productId = mapping.product_id as string;
    if (preferredSupplierByProduct.has(productId)) continue;
    const supplier = suppliersById.get(mapping.supplier_id as string);
    if (!supplier) continue;
    const operativeName = String(
      supplier.business_name || supplier.fantasy_name || "Proveedor sin nombre",
    );
    const realName = supplier.parent_supplier_id
      ? parentSuppliersById.get(supplier.parent_supplier_id as string) || operativeName
      : operativeName;
    preferredSupplierByProduct.set(productId, {
      operative_supplier_name: operativeName,
      real_supplier_name: realName,
    });
  }

  const stockByVariantId = new Map<number, number>();
  for (const row of stockRows || []) {
    const variantId = Number(row.variant_id || 0);
    if (!variantId) continue;
    stockByVariantId.set(
      variantId,
      (stockByVariantId.get(variantId) || 0) + Number(row.quantity_available || 0),
    );
  }

  return (candidateProducts || [])
    .map((product) => {
      const names = preferredSupplierByProduct.get(product.id as string);
      const bsaleVariantId = Number(product.bsale_variant_id || 0) || null;
      return {
        id: product.id as string,
        sku: String(product.sku || ""),
        description: String(product.description || "Sin descripción"),
        real_supplier_name: names?.real_supplier_name || null,
        operative_supplier_name: names?.operative_supplier_name || null,
        stock_available:
          bsaleVariantId && stockByVariantId.has(bsaleVariantId)
            ? Math.round(stockByVariantId.get(bsaleVariantId) || 0)
            : null,
        already_included: includedProductIds.has(product.id as string),
        bsale_product_id: Number(product.bsale_product_id || 0) || null,
        bsale_variant_id: bsaleVariantId,
      };
    })
    .sort((a, b) => {
      if (a.already_included !== b.already_included) {
        return a.already_included ? 1 : -1;
      }
      return a.description.localeCompare(b.description, "es");
    })
    .slice(0, 50);
}
