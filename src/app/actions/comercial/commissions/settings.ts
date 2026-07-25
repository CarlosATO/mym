"use server";

import { revalidatePath } from "next/cache";
import { commissionDb, getAuthenticatedCompany } from "./auth";
import { mapSeller, isIsoDate } from "./utils";
import type {
  CommissionEligibleSummary,
  CommissionGroup,
  CommissionSeller,
  CommissionSellerProfileInput,
  CommissionSellerRow,
  CommissionSettings,
} from "./types";

export async function getCommissionSellers(): Promise<CommissionSeller[]> {
  const { companyId } = await getAuthenticatedCompany();
  const db = commissionDb();
  const [{ data, error }, { data: profiles, error: profilesError }] =
    await Promise.all([
      db
        .from("vw_commission_sellers")
        .select(
          "company_id,seller_bsale_id,seller_name,docs_count,invoices_count,paid_invoices_count,seller_profile_id,is_commissionable,seller_type,profile_active,last_seen_at",
        )
        .eq("company_id", companyId)
        .order("paid_invoices_count", { ascending: false, nullsFirst: false })
        .order("seller_name", { ascending: true }),
      db
        .from("commission_seller_profiles")
        .select("seller_bsale_id,notes")
        .eq("company_id", companyId),
    ]);

  if (error) throw error;
  if (profilesError) throw profilesError;

  const notesBySeller = new Map(
    (profiles || []).map((profile) => [
      Number(profile.seller_bsale_id),
      profile.notes as string | null,
    ]),
  );
  return ((data || []) as CommissionSellerRow[]).map((row) => ({
    ...mapSeller(row),
    notes: notesBySeller.get(Number(row.seller_bsale_id)) || null,
  }));
}

export async function upsertCommissionSellerProfile(
  input: CommissionSellerProfileInput,
) {
  const { companyId, userId } = await getAuthenticatedCompany();
  const sellerId = Number(input.seller_bsale_id);
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0)
    throw new Error("Vendedor inválido");

  const db = commissionDb();
  const { data: seller, error: sellerError } = await db
    .from("vw_commission_sellers")
    .select("seller_name")
    .eq("company_id", companyId)
    .eq("seller_bsale_id", sellerId)
    .maybeSingle();

  if (sellerError) throw sellerError;
  if (!seller) throw new Error("El vendedor no pertenece a la empresa activa");

  const sellerName = String(seller.seller_name || input.seller_name).trim();
  if (!sellerName) throw new Error("El vendedor no tiene nombre disponible");

  const { data, error } = await db
    .from("commission_seller_profiles")
    .upsert(
      {
        company_id: companyId,
        seller_bsale_id: sellerId,
        seller_name: sellerName,
        is_commissionable: Boolean(input.is_commissionable),
        seller_type: input.seller_type,
        active: Boolean(input.active),
        notes: input.notes.trim() || null,
        updated_by: userId,
      },
      { onConflict: "company_id,seller_bsale_id" },
    )
    .select(
      "id,company_id,seller_bsale_id,seller_name,is_commissionable,seller_type,active,notes,created_at,updated_at",
    )
    .single();

  if (error) throw error;
  revalidatePath("/dashboard/comercial");
  return data;
}

export async function getCommissionEligibleSummary(params: {
  seller_bsale_id: number;
  period_to: string;
  period_from?: string;
}): Promise<CommissionEligibleSummary> {
  const { companyId } = await getAuthenticatedCompany();
  const sellerId = Number(params.seller_bsale_id);
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0)
    throw new Error("Vendedor inválido");
  if (!isIsoDate(params.period_to)) throw new Error("Fecha hasta inválida");
  if (params.period_from && !isIsoDate(params.period_from))
    throw new Error("Fecha desde inválida");
  if (params.period_from && params.period_from > params.period_to)
    throw new Error("El período desde no puede ser posterior al hasta");

  const db = commissionDb();
  const [
    { data: settings, error: settingsError },
    { data: lastSettlement, error: settlementError },
  ] = await Promise.all([
    db
      .from("commission_settings")
      .select("first_eligible_date")
      .eq("company_id", companyId)
      .eq("active", true)
      .maybeSingle(),
    db
      .from("commission_settlements")
      .select("period_to")
      .eq("company_id", companyId)
      .eq("seller_bsale_id", sellerId)
      .eq("status", "ISSUED")
      .in("source", ["NORMAL", "ADJUSTMENT"])
      .order("period_to", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (settingsError) throw settingsError;
  if (settlementError) throw settlementError;
  if (!settings)
    throw new Error("Falta la configuración de comisiones de la empresa");

  const nextSettlementDate = lastSettlement?.period_to
    ? new Date(`${lastSettlement.period_to}T00:00:00Z`)
    : null;
  if (nextSettlementDate)
    nextSettlementDate.setUTCDate(nextSettlementDate.getUTCDate() + 1);
  const periodFrom =
    params.period_from ||
    nextSettlementDate?.toISOString().slice(0, 10) ||
    settings.first_eligible_date;

  const { data, error } = await db
    .rpc("get_commission_eligible_invoice_lines", {
      p_company_id: companyId,
      p_seller_bsale_id: sellerId,
      p_period_to: params.period_to,
      p_period_from: periodFrom,
    })
    .select("net_amount");

  if (error) throw error;
  const lines = Array.isArray(data) ? data : data ? [data] : [];
  const totalNetAmount = lines.reduce(
    (total, line) => total + Number(line.net_amount || 0),
    0,
  );

  return {
    lines_count: lines.length,
    total_net_amount: totalNetAmount,
    period_from: periodFrom,
    period_to: params.period_to,
  };
}

export async function getCommissionSettings(): Promise<CommissionSettings> {
  const { companyId } = await getAuthenticatedCompany();
  const { data, error } = await commissionDb()
    .from("commission_settings")
    .select(
      "default_commission_percent,base_amount,require_full_payment,historical_cutoff_date,first_eligible_date",
    )
    .eq("company_id", companyId)
    .eq("active", true)
    .single();
  if (error) throw error;
  return {
    ...data,
    default_commission_percent: Number(data.default_commission_percent),
  } as CommissionSettings;
}

export async function updateCommissionSettings(input: {
  default_commission_percent: number;
}) {
  const { companyId, userId } = await getAuthenticatedCompany();
  const percent = Number(input.default_commission_percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100)
    throw new Error("El porcentaje debe estar entre 0 y 100");

  const { data, error } = await commissionDb()
    .from("commission_settings")
    .update({ default_commission_percent: percent, updated_by: userId })
    .eq("company_id", companyId)
    .select(
      "default_commission_percent,base_amount,require_full_payment,historical_cutoff_date,first_eligible_date",
    )
    .single();
  if (error) throw error;
  return {
    ...data,
    default_commission_percent: Number(data.default_commission_percent),
  } as CommissionSettings;
}

export async function getCommissionGroups(): Promise<CommissionGroup[]> {
  const { companyId } = await getAuthenticatedCompany();
  const { data, error } = await commissionDb()
    .from("commission_groups")
    .select("id,code,name,description,supplier_id,parent_supplier_id,is_active")
    .eq("company_id", companyId)
    .order("is_active", { ascending: false })
    .order("name");
  if (error) throw error;
  return (data || []) as CommissionGroup[];
}

export async function upsertCommissionGroup(
  input: Omit<CommissionGroup, "id"> & { id?: string },
) {
  const { companyId, userId } = await getAuthenticatedCompany();
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!code || !name) throw new Error("Código y nombre son obligatorios");

  const payload = {
    company_id: companyId,
    code,
    name,
    description: input.description?.trim() || null,
    supplier_id: input.supplier_id || null,
    parent_supplier_id: input.parent_supplier_id || null,
    is_active: Boolean(input.is_active),
    updated_by: userId,
  };
  const query = input.id
    ? commissionDb()
        .from("commission_groups")
        .update(payload)
        .eq("id", input.id)
        .eq("company_id", companyId)
    : commissionDb()
        .from("commission_groups")
        .insert({ ...payload, created_by: userId });
  const { data, error } = await query
    .select("id,code,name,description,supplier_id,parent_supplier_id,is_active")
    .single();
  if (error) throw error;
  return data as CommissionGroup;
}

export async function searchCommissionSuppliers(query: string) {
  const { companyId } = await getAuthenticatedCompany();
  const term = query.trim();
  let request = commissionDb()
    .schema("adquisiciones")
    .from("suppliers")
    .select(
      "id,business_name,fantasy_name,rut,parent_supplier_id,supplier_kind",
    )
    .eq("company_id", companyId)
    .eq("is_active", true)
    .or("supplier_kind.eq.REAL,supplier_kind.is.null")
    .order("business_name")
    .limit(30);
  if (term)
    request = request.or(
      `business_name.ilike.%${term}%,fantasy_name.ilike.%${term}%`,
    );
  const { data, error } = await request;
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id as string,
    name: String(
      row.business_name || row.fantasy_name || "Proveedor sin nombre",
    ),
    rut: row.rut as string | null,
    parent_supplier_id: row.parent_supplier_id as string | null,
    supplier_kind: row.supplier_kind as string | null,
    type_label: "Proveedor real",
  }));
}
