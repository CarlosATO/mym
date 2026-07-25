"use server";

import { commissionDb, getAuthenticatedCompany } from "./auth";
import type { CommissionSettlementHeader, CommissionSettlementLine } from "./types";
import { previewCommissionSettlement } from "./simulation";

export async function createCommissionSettlementDraft(input: {
  seller_bsale_id: number;
  period_from: string;
  period_to: string;
}): Promise<{
  id: string;
  total_net_amount: number;
  total_commission_amount: number;
}> {
  const { companyId, userId } = await getAuthenticatedCompany();
  const sellerId = Number(input.seller_bsale_id);
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0)
    throw new Error("Vendedor inválido");

  const preview = await previewCommissionSettlement(input);
  if (!preview.lines.length) throw new Error("No hay líneas elegibles");

  const { data: seller, error: sellerError } = await commissionDb()
    .from("vw_commission_sellers")
    .select("seller_profile_id,seller_name")
    .eq("company_id", companyId)
    .eq("seller_bsale_id", sellerId)
    .maybeSingle();
  if (sellerError) throw sellerError;

  const periodLabel = `${input.period_from} al ${input.period_to}`;
  const linesJson = preview.lines.map((line) => ({
    commission_line_type: line.commission_line_type || "INVOICE_LINE",
    source_document_type: line.source_document_type || "INVOICE",
    source_document_id: line.source_document_id || line.invoice_bsale_id,
    source_document_number: line.source_document_number || line.invoice_number,
    source_detail_id: line.source_detail_id || line.invoice_line_id,
    original_invoice_id: line.original_invoice_id || line.invoice_bsale_id,
    original_invoice_number:
      line.original_invoice_number || line.invoice_number,
    invoice_bsale_id: line.invoice_bsale_id,
    invoice_number: line.invoice_number,
    invoice_line_id: line.invoice_line_id,
    customer_name: line.customer_name,
    product_id: line.product_id || null,
    sku: line.sku,
    product_name: line.product_name,
    supplier_id: line.supplier_id,
    supplier_name: line.supplier_name,
    commission_group_id: line.commission_group_id,
    commission_group_name: line.commission_group_name,
    payment_completed_at: line.payment_completed_at,
    quantity: line.quantity,
    net_amount: line.net_amount,
    commission_percent: line.commission_percent,
    commission_amount: line.commission_amount,
    rule_id: line.rule_id,
    adjustment_reason: line.adjustment_reason || null,
    warning_code: line.warning_code || null,
    warning_message: line.warning_message || null,
  }));

  const { data, error } = await commissionDb().rpc(
    "create_commission_settlement_draft",
    {
      p_company_id: companyId,
      p_user_id: userId,
      p_seller_bsale_id: sellerId,
      p_seller_profile_id: seller?.seller_profile_id || null,
      p_seller_name: seller?.seller_name || "",
      p_period_from: input.period_from,
      p_period_to: input.period_to,
      p_period_label: periodLabel,
      p_lines: linesJson,
      p_total_net_amount: preview.summary.total_net_amount,
      p_total_commission_amount: preview.summary.total_commission_amount,
    },
  );
  if (error) throw error;
  const result = data as {
    success: boolean;
    settlement_id?: string;
    error?: string;
  };
  if (!result.success) throw new Error(result.error || "Error al crear borrador");

  return {
    id: result.settlement_id!,
    total_net_amount: preview.summary.total_net_amount,
    total_commission_amount: preview.summary.total_commission_amount,
  };
}

export async function getCommissionSettlementDrafts(): Promise<
  CommissionSettlementHeader[]
> {
  const { companyId } = await getAuthenticatedCompany();
  const db = commissionDb();
  const { data, error } = await db
    .from("commission_settlements")
    .select(
      `
      id, settlement_number, settlement_code, seller_bsale_id, seller_name,
      period_from, period_to, period_label, status, source,
      total_net_amount, total_commission_amount, issued_at, created_at
    `,
      { count: "exact" },
    )
    .eq("company_id", companyId)
    .eq("status", "DRAFT")
    .eq("source", "NORMAL")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = await Promise.all(
    (data || []).map(async (row: Record<string, unknown>) => {
      const { count } = await db
        .from("commission_settlement_lines")
        .select("id", { count: "exact", head: true })
        .eq("settlement_id", row.id);
      return {
        ...row,
        lines_count: count,
        seller_bsale_id: Number(row.seller_bsale_id || 0),
        total_net_amount: Number(row.total_net_amount),
        total_commission_amount: Number(row.total_commission_amount),
      };
    }),
  );
  return rows as unknown as CommissionSettlementHeader[];
}

export async function getCommissionSettlements(params?: {
  status?: string;
  seller_bsale_id?: number;
}): Promise<CommissionSettlementHeader[]> {
  const { companyId } = await getAuthenticatedCompany();
  const db = commissionDb();
  let query = db
    .from("commission_settlements")
    .select(
      `
      id, settlement_number, settlement_code, seller_bsale_id, seller_name,
      period_from, period_to, period_label, status, source,
      total_net_amount, total_commission_amount, issued_at, created_at
    `,
    )
    .eq("company_id", companyId)
    .neq("source", "HISTORICAL")
    .order("created_at", { ascending: false });
  if (params?.status) query = query.eq("status", params.status);
  if (params?.seller_bsale_id)
    query = query.eq("seller_bsale_id", params.seller_bsale_id);
  const { data, error } = await query;
  if (error) throw error;
  const rows = await Promise.all(
    (data || []).map(async (row: Record<string, unknown>) => {
      const { count } = await db
        .from("commission_settlement_lines")
        .select("id", { count: "exact", head: true })
        .eq("settlement_id", row.id);
      return {
        ...row,
        lines_count: count,
        seller_bsale_id: Number(row.seller_bsale_id || 0),
        total_net_amount: Number(row.total_net_amount),
        total_commission_amount: Number(row.total_commission_amount),
      };
    }),
  );
  return rows as unknown as CommissionSettlementHeader[];
}

export async function getCommissionSettlementById(
  settlementId: string,
): Promise<{
  header: CommissionSettlementHeader;
  lines: CommissionSettlementLine[];
}> {
  const { companyId } = await getAuthenticatedCompany();
  const db = commissionDb();

  const { data: headerData, error: headerError } = await db
    .from("commission_settlements")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", settlementId)
    .single();
  if (headerError) throw headerError;

  const { data: linesData, error: linesError } = await db
    .from("commission_settlement_lines")
    .select("*")
    .eq("settlement_id", settlementId)
    .order("line_type", { ascending: true })
    .order("invoice_bsale_id", { ascending: true })
    .order("sku", { ascending: true });
  if (linesError) throw linesError;

  const lines: CommissionSettlementLine[] = (linesData || []).map(
    (line: Record<string, unknown>) => ({
      ...line,
      quantity: Number(line.quantity),
      net_amount: Number(line.net_amount),
      commission_amount: line.commission_amount
        ? Number(line.commission_amount)
        : null,
      commission_percent: line.commission_percent
        ? Number(line.commission_percent)
        : null,
      invoice_bsale_id: line.invoice_bsale_id
        ? Number(line.invoice_bsale_id)
        : null,
      invoice_number: line.invoice_number ? Number(line.invoice_number) : null,
      metadata: typeof line.metadata === "object" ? line.metadata : {},
    }),
  ) as CommissionSettlementLine[];

  const header: CommissionSettlementHeader = {
    ...headerData,
    lines_count: lines.length,
    seller_bsale_id: Number(headerData.seller_bsale_id || 0),
    total_net_amount: Number(headerData.total_net_amount),
    total_commission_amount: Number(headerData.total_commission_amount),
  } as CommissionSettlementHeader;

  return { header, lines };
}

export async function cancelCommissionSettlementDraft(input: {
  settlement_id: string;
  reason: string;
}) {
  const { companyId, userId } = await getAuthenticatedCompany();
  if (!input.reason.trim())
    throw new Error("Debes indicar un motivo de cancelación");

  const { data, error } = await commissionDb().rpc(
    "cancel_commission_settlement_draft",
    {
      p_company_id: companyId,
      p_user_id: userId,
      p_settlement_id: input.settlement_id,
      p_reason: input.reason,
    },
  );
  if (error) throw error;
  const result = data as { success: boolean; error?: string };
  if (!result.success)
    throw new Error(result.error || "Error al cancelar borrador");
}

export async function issueCommissionSettlement(input: { settlement_id: string }) {
  const { companyId, userId } = await getAuthenticatedCompany();
  const { data, error } = await commissionDb().rpc(
    "issue_commission_settlement",
    {
      p_company_id: companyId,
      p_user_id: userId,
      p_settlement_id: input.settlement_id,
    },
  );
  if (error) throw error;
  const result = data as {
    success: boolean;
    settlement_number?: number;
    settlement_code?: string;
    error?: string;
  };
  if (!result.success)
    throw new Error(result.error || "Error al emitir liquidación");

  return {
    settlement_number: result.settlement_number!,
    settlement_code: result.settlement_code!,
  };
}

export async function exportCommissionSettlementPdf(
  settlementId: string,
): Promise<{ base64: string; filename: string }> {
  const { companyId } = await getAuthenticatedCompany();
  const { header, lines } = await getCommissionSettlementById(settlementId);
  if (header.company_id !== companyId)
    throw new Error("No tienes acceso a esta liquidación");

  const { generateCommissionSettlementPdfBlob } =
    await import("@/lib/pdf/generate-commission-settlement-pdf");

  let logoBase64: string | undefined;
  try {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const logoPath = join(process.cwd(), "public", "logo-transparent.png");
    logoBase64 = `data:image/png;base64,${readFileSync(logoPath).toString("base64")}`;
  } catch {}

  const blob = generateCommissionSettlementPdfBlob(
    header,
    lines,
    logoBase64,
    "DISTRIBUIDORA MYM",
  );
  const buffer = Buffer.from(await blob.arrayBuffer());
  const suffix =
    header.status === "DRAFT"
      ? "borrador"
      : header.status === "ISSUED"
        ? "emitida"
        : "anulada";
  const filename = `liquidacion_comisiones_${header.settlement_code || "borrador"}_${suffix}.pdf`;

  return { base64: buffer.toString("base64"), filename };
}

export async function exportCommissionSettlementXlsx(
  settlementId: string,
): Promise<{ base64: string; filename: string }> {
  const { companyId } = await getAuthenticatedCompany();
  const { header, lines } = await getCommissionSettlementById(settlementId);
  if (header.company_id !== companyId)
    throw new Error("No tienes acceso a esta liquidación");

  const XLSX = await import("xlsx");
  const statusLabel =
    header.status === "DRAFT"
      ? "Borrador"
      : header.status === "ISSUED"
        ? "Emitida"
        : "Anulada";

  const data = lines.map((line) => ({
    Estado: statusLabel,
    Código: header.settlement_code || "",
    Vendedor: header.seller_name || "",
    Período: header.period_label || "",
    "Factura original": String(line.original_invoice_number || line.invoice_number || ""),
    Cliente: line.customer_name || "",
    Pago: line.payment_completed_at || "",
    "Tipo línea": line.line_type === "CREDIT_NOTE" ? "Nota de crédito" : "Factura",
    Origen:
      line.line_type === "CREDIT_NOTE"
        ? `NC ${line.source_document_number || ""}`
        : "Factura",
    SKU: line.sku || "",
    Producto: line.product_name || "",
    Proveedor: line.supplier_name || "",
    Cantidad: Number(line.quantity),
    Neto: Number(line.net_amount),
    Regla: line.rule_id || "General",
    "%": line.commission_percent != null ? Number(line.commission_percent) : null,
    Comisión: Number(line.commission_amount || 0),
    "Motivo NC":
      ((line.metadata as Record<string, unknown>)?.adjustment_reason as string) ||
      "",
    "Doc. origen ID":
      line.source_document_bsale_id != null
        ? Number(line.source_document_bsale_id)
        : null,
    "Detalle origen ID": line.source_document_line_id || "",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  const colWidths = Object.keys(data[0] || {}).map((k) => ({
    wch: Math.max(k.length, 20),
  }));
  ws["!cols"] = colWidths;
  XLSX.utils.book_append_sheet(wb, ws, "Detalle");

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
  const suffix =
    header.status === "DRAFT"
      ? "borrador"
      : header.status === "ISSUED"
        ? "emitida"
        : "anulada";
  const filename = `liquidacion_comisiones_${header.settlement_code || "borrador"}_${suffix}_detalle.xlsx`;

  return { base64: wbout, filename };
}

export async function getCommissionAnnulledSettlements(): Promise<
  CommissionSettlementHeader[]
> {
  const { companyId } = await getAuthenticatedCompany();
  const db = commissionDb();
  const { data, error } = await db
    .from("commission_settlements")
    .select(
      `id, settlement_number, settlement_code, seller_bsale_id, seller_name,
      period_from, period_to, period_label, status, source,
      total_net_amount, total_commission_amount, issued_at, created_at,
      cancelled_at, cancellation_reason`,
    )
    .eq("company_id", companyId)
    .eq("status", "CANCELLED")
    .neq("source", "HISTORICAL")
    .not("issued_at", "is", null)
    .order("cancelled_at", { ascending: false });
  if (error) throw error;
  const rows = await Promise.all(
    (data || []).map(async (row: Record<string, unknown>) => {
      const { count } = await db
        .from("commission_settlement_lines")
        .select("id", { count: "exact", head: true })
        .eq("settlement_id", row.id);
      return {
        ...row,
        lines_count: count,
        seller_bsale_id: Number(row.seller_bsale_id || 0),
        total_net_amount: Number(row.total_net_amount),
        total_commission_amount: Number(row.total_commission_amount),
      };
    }),
  );
  return rows as unknown as CommissionSettlementHeader[];
}

export async function annulCommissionSettlement(input: {
  settlement_id: string;
  reason: string;
}) {
  const { companyId, userId } = await getAuthenticatedCompany();
  if (!input.reason.trim())
    throw new Error("El motivo de anulación es obligatorio");

  const { data, error } = await commissionDb().rpc(
    "annul_commission_settlement",
    {
      p_company_id: companyId,
      p_settlement_id: input.settlement_id,
      p_user_id: userId,
      p_reason: input.reason,
    },
  );
  if (error) throw error;
  const result = data as {
    success: boolean;
    released_lines?: number;
    error?: string;
  };
  if (!result.success)
    throw new Error(result.error || "Error al anular liquidación");

  return { released_lines: result.released_lines || 0 };
}
