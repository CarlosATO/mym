"use server";

import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getActiveCompany, getActiveCompanyId } from "@/app/actions/companies";
import { requireWmsPermission } from "./authorization";
import { syncBsaleMermas } from "@/lib/integraciones/bsale-mermas-sync";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function db(schema: string) {
  return createSupabaseClient(url, serviceKey, {
    db: { schema },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type MermaProduct = {
  id: string;
  bsale_id: number;
  sku: string;
  barcode: string | null;
  description: string | null;
  product_name: string | null;
  stock_available: number | null;
  stock_last_synced_at: string | null;
};

export async function getMermasProductsCatalog(): Promise<{
  data: MermaProduct[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.create");
  const integrationDb = db("integraciones");
  const variants: Array<{
    id: string;
    bsale_id: number;
    code: string | null;
    bar_code: string | null;
    description: string | null;
    bsale_product_id: number;
  }> = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await integrationDb
      .from("bsale_variants")
      .select("id, bsale_id, code, bar_code, description, bsale_product_id")
      .eq("company_id", authorization.companyId)
      .eq("state", 0)
      .order("code")
      .range(offset, offset + pageSize - 1);
    if (error)
      return { data: [], error: "No se pudo cargar el catálogo Bsale" };
    variants.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  const productIds = [
    ...new Set(variants.map((variant) => variant.bsale_product_id)),
  ];
  const { data: products, error: productsError } = productIds.length
    ? await integrationDb
        .from("bsale_products")
        .select("bsale_id, name")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", productIds)
    : { data: [] as { bsale_id: number; name: string | null }[], error: null };
  if (productsError)
    return { data: [], error: "No se pudo cargar el catálogo Bsale" };
  const productNames = new Map(
    (products ?? []).map((product) => [product.bsale_id, product.name]),
  );
  const stockRows: Array<{
    variant_id: number;
    quantity_available: number | null;
    synced_at: string | null;
    office_id: number | null;
    raw_json: { office?: { name?: string } } | null;
  }> = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await integrationDb
      .from("bsale_stock_current")
      .select("variant_id, quantity_available, synced_at, office_id, raw_json")
      .eq("company_id", authorization.companyId)
      .range(offset, offset + pageSize - 1);
    if (error) return { data: [], error: "No se pudo cargar el stock Bsale" };
    stockRows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  const { data: offices } = await integrationDb
    .from("bsale_offices")
    .select("bsale_id, name")
    .eq("company_id", authorization.companyId);
  const normalizedOfficeName = (name: string | null | undefined) =>
    (name ?? "").trim().toUpperCase();
  let casaMatrizOfficeId = (offices ?? []).find((office) =>
    normalizedOfficeName(office.name).includes("CASA MATRIZ") ||
    normalizedOfficeName(office.name).includes("MATRIZ"),
  )?.bsale_id ?? null;
  if (casaMatrizOfficeId === null) {
    casaMatrizOfficeId = stockRows.find((row) => {
      const name = normalizedOfficeName(row.raw_json?.office?.name);
      return name.includes("CASA MATRIZ") || name.includes("MATRIZ");
    })?.office_id ?? null;
  }
  if (casaMatrizOfficeId === null) {
    const officeIds = new Set(
      stockRows
        .map((row) => row.office_id)
        .filter((officeId): officeId is number => officeId !== null),
    );
    if (officeIds.size === 1) casaMatrizOfficeId = [...officeIds][0];
  }
  const casaMatrizStockRows = stockRows.filter(
    (row) => row.office_id === casaMatrizOfficeId,
  );
  const stockByVariant = new Map<
    number,
    { total: number; validRows: number; lastSyncedAt: string | null }
  >();
  for (const row of casaMatrizStockRows) {
    const current = stockByVariant.get(row.variant_id) ?? {
      total: 0,
      validRows: 0,
      lastSyncedAt: null,
    };
    if (
      row.quantity_available !== null &&
      Number.isFinite(Number(row.quantity_available)) &&
      Number(row.quantity_available) >= 0
    ) {
      current.total += Number(row.quantity_available);
      current.validRows += 1;
    }
    if (
      row.synced_at &&
      (!current.lastSyncedAt || row.synced_at > current.lastSyncedAt)
    )
      current.lastSyncedAt = row.synced_at;
    stockByVariant.set(row.variant_id, current);
  }
  return {
    data: variants.map((variant) => ({
      id: variant.id,
      bsale_id: variant.bsale_id,
      sku: variant.code ?? "",
      barcode: variant.bar_code,
      description: variant.description,
      product_name: productNames.get(variant.bsale_product_id) ?? null,
      stock_available: stockByVariant.get(variant.bsale_id)?.validRows
        ? stockByVariant.get(variant.bsale_id)!.total
        : null,
      stock_last_synced_at:
        stockByVariant.get(variant.bsale_id)?.lastSyncedAt ?? null,
    })),
  };
}

export type MermaLine = {
  id: string;
  bsale_variant_id: number;
  sku: string;
  product_name: string;
  variant_description: string | null;
  quantity: number;
  reason: string;
  expiration_date: string;
  lot: string | null;
  observation: string | null;
};

const MERMA_EVIDENCE_BUCKET = "mermas-evidence";
const MERMA_EVIDENCE_MAX_SIZE = 10 * 1024 * 1024;
const MERMA_EVIDENCE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

export type MermaEvidenceMetadata = {
  line_index: number;
  storage_path: string;
  file_name: string;
  mime_type: string;
  file_size: number;
};

export type MermaEvidenceUpload = MermaEvidenceMetadata & {
  signed_upload_url: string;
  upload_token: string;
};

function signMermaEvidenceSession(
  companyId: string,
  userId: string,
  sessionId: string,
  paths: string[] = [],
) {
  return createHmac("sha256", serviceKey)
    .update(`${companyId}:${userId}:${sessionId}:${canonicalMermaEvidencePaths(paths)}`)
    .digest("hex");
}

function canonicalMermaEvidencePaths(paths: string[]) {
  return JSON.stringify(paths);
}

function hasValidMermaEvidenceSignature(
  expected: string,
  received: string,
) {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

type MermaEvidenceValidationCode =
  | "EVIDENCE_TOKEN_INVALID"
  | "EVIDENCE_PATH_INVALID"
  | "EVIDENCE_OBJECT_NOT_FOUND"
  | "EVIDENCE_MIME_INVALID"
  | "EVIDENCE_SIZE_INVALID"
  | "EVIDENCE_SESSION_INVALID"
  | "EVIDENCE_LINE_INVALID";

class MermaEvidenceValidationError extends Error {
  constructor(
    readonly code: MermaEvidenceValidationCode,
    readonly lineIndex?: number,
  ) {
    super(code);
  }
}

function evidenceValidationMessage(error: MermaEvidenceValidationError) {
  const line = error.lineIndex === undefined ? "" : ` de la línea ${error.lineIndex + 1}`;
  if (error.code === "EVIDENCE_OBJECT_NOT_FOUND") {
    return `No se pudo validar la evidencia${line}: el archivo subido no existe.`;
  }
  if (error.code === "EVIDENCE_MIME_INVALID") {
    return `No se pudo validar la evidencia${line}: el MIME del archivo no coincide.`;
  }
  if (error.code === "EVIDENCE_SIZE_INVALID") {
    return `No se pudo validar la evidencia${line}: el tamaño del archivo no coincide.`;
  }
  if (error.code === "EVIDENCE_PATH_INVALID") {
    return "No se pudo validar la evidencia: la ruta no pertenece a esta sesión.";
  }
  if (error.code === "EVIDENCE_TOKEN_INVALID") {
    return "No se pudo validar la evidencia: el token no es válido.";
  }
  if (error.code === "EVIDENCE_LINE_INVALID") {
    return `No se pudo validar la evidencia${line}: la línea no es válida.`;
  }
  return "No se pudo validar la evidencia: la sesión no es válida.";
}

function reportEvidenceValidation(error: MermaEvidenceValidationError) {
  console.warn("[MERMAS evidence validation]", {
    code: error.code,
    lineIndex: error.lineIndex,
  });
  return { error: evidenceValidationMessage(error) };
}

export type MermaRequest = {
  id: string;
  request_code: string;
  company_id: string;
  status: "PENDIENTE" | "PARCIAL" | "CUMPLIDA" | "FINALIZADA" | "CANCELADA";
  created_by: string;
  created_at: string;
  line_count: number;
  total_quantity: number;
  requester_name?: string;
  company_name?: string;
  cancellation_reason?: string | null;
  cancelled_by?: string | null;
  cancelled_at?: string | null;
  lines?: MermaLine[];
  evidence?: MermaRequestEvidence[];
  bsale_association?: MermaBsaleAssociation | null;
  authorization_ready?: boolean;
  can_cancel?: boolean;
};

export type MermaRequestEvidence = {
  id: string;
  request_line_id: string;
  file_name: string;
  mime_type: string;
  signed_url: string;
};

export type MermaBsaleAssociation = {
  consumption_id: number;
  consumption_date: string | null;
  note: string | null;
  match_method: string | null;
  line_count: number;
  processed_at: string | null;
};

export async function getMermasContext() {
  const authorization = await requireWmsPermission("logistica.mermas.view");
  const company = await getActiveCompany();
  const supabase = await createClient();
  const { data: user } = await supabase.auth.getUser();
  const { data: profile } = user.user
    ? await supabase
        .from("users")
        .select("nombre, apellido")
        .eq("id", user.user.id)
        .maybeSingle()
    : { data: null };
  return {
    companyId: authorization.companyId,
    companyName:
      company?.trade_name || company?.business_name || "Empresa activa",
    requesterName:
      `${profile?.nombre ?? ""} ${profile?.apellido ?? ""}`.trim() ||
      user.user?.email ||
      "Usuario actual",
  };
}

export async function searchMermasProducts(
  search: string,
): Promise<{ data: MermaProduct[]; error?: string }> {
  const authorization = await requireWmsPermission("logistica.mermas.create");
  const term = search.trim();
  if (term.length < 2) return { data: [] };
  const query = db("integraciones")
    .from("bsale_variants")
    .select("id, bsale_id, code, bar_code, description, bsale_product_id")
    .eq("company_id", authorization.companyId)
    .or(
      `code.ilike.%${term}%,bar_code.ilike.%${term}%,description.ilike.%${term}%`,
    )
    .eq("state", 0)
    .order("code")
    .limit(20);
  const { data: variants, error } = await query;
  if (error)
    return { data: [], error: "No se pudo consultar el catálogo Bsale" };
  const productIds = [
    ...new Set((variants ?? []).map((v) => v.bsale_product_id)),
  ];
  const { data: products } = productIds.length
    ? await db("integraciones")
        .from("bsale_products")
        .select("bsale_id, name")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", productIds)
    : { data: [] as { bsale_id: number; name: string | null }[] };
   const names = new Map((products ?? []).map((p) => [p.bsale_id, p.name]));
  return {
    data: (variants ?? []).map((v) => ({
      id: v.id,
      bsale_id: v.bsale_id,
      sku: v.code ?? "",
      barcode: v.bar_code,
      description: v.description,
      product_name: names.get(v.bsale_product_id) ?? null,
      stock_available: null,
      stock_last_synced_at: null,
    })),
  };
}

export async function getMermasRequests(
  search = "",
): Promise<{ data: MermaRequest[]; error?: string }> {
  const authorization = await requireWmsPermission("logistica.mermas.view");
  const requestDb = db("mermas");
  let query = requestDb
    .from("requests")
    .select(
      "id, request_code, company_id, status, created_by, created_at, cancellation_reason, cancelled_by, cancelled_at",
    )
    .eq("company_id", authorization.companyId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (search.trim()) query = query.ilike("request_code", `%${search.trim()}%`);
  const { data, error } = await query;
  if (error)
    return { data: [], error: "No se pudieron cargar las solicitudes" };
  const ids = (data ?? []).map((row) => row.id);
  const { data: lines } = ids.length
    ? await requestDb
        .from("request_lines")
        .select("request_id, quantity")
        .in("request_id", ids)
    : { data: [] as { request_id: string; quantity: number }[] };
  const aggregates = new Map<string, { count: number; total: number }>();
  for (const line of lines ?? []) {
    const current = aggregates.get(line.request_id) ?? { count: 0, total: 0 };
    current.count += 1;
    current.total += Number(line.quantity) || 0;
    aggregates.set(line.request_id, current);
  }
  const userIds = [...new Set((data ?? []).map((row) => row.created_by))];
  const { data: users } = userIds.length
    ? await db("portal")
        .from("users")
        .select("id, nombre, apellido")
        .in("id", userIds)
    : {
        data: [] as {
          id: string;
          nombre: string | null;
          apellido: string | null;
        }[],
      };
  const names = new Map(
    (users ?? []).map((user) => [
      user.id,
      `${user.nombre ?? ""} ${user.apellido ?? ""}`.trim(),
    ]),
  );
  return {
    data: (data ?? []).map((row) => ({
      ...row,
      line_count: aggregates.get(row.id)?.count ?? 0,
      total_quantity: aggregates.get(row.id)?.total ?? 0,
      requester_name: names.get(row.created_by) ?? "Usuario",
    })) as MermaRequest[],
  };
}

export async function getMermasRequest(
  id: string,
): Promise<{ data: MermaRequest | null; error?: string }> {
  const authorization = await requireWmsPermission("logistica.mermas.view");
  let canAuthorize = false;
  try {
    await requireWmsPermission("logistica.mermas.authorize");
    canAuthorize = true;
  } catch {
    // Detail remains visible to users who cannot authorize.
  }
  const company = await getActiveCompany();
  const requestDb = db("mermas");
  const { data: request, error } = await requestDb
    .from("requests")
    .select(
      "id, request_code, company_id, status, created_by, created_at, cancellation_reason, cancelled_by, cancelled_at",
    )
    .eq("id", id)
    .eq("company_id", authorization.companyId)
    .maybeSingle();
  if (error || !request)
    return { data: null, error: "Solicitud no encontrada" };
  const { data: lines, error: linesError } = await requestDb
    .from("request_lines")
    .select(
      "id, bsale_variant_id, sku, product_name, variant_description, quantity, reason, expiration_date, lot, observation",
    )
    .eq("request_id", id)
    .eq("company_id", authorization.companyId)
    .order("created_at");
  if (linesError)
    return { data: null, error: "No se pudieron cargar las líneas" };
  const lineIds = (lines ?? []).map((line) => line.id);
  const { data: evidenceRows } = lineIds.length
    ? await requestDb
        .from("evidence")
        .select("id, request_line_id, file_name, mime_type, storage_path")
        .eq("company_id", authorization.companyId)
        .in("request_line_id", lineIds)
        .order("uploaded_at")
    : { data: [] as { id: string; request_line_id: string; file_name: string; mime_type: string; storage_path: string }[] };
  const requestEvidence: MermaRequestEvidence[] = [];
  for (const evidence of evidenceRows ?? []) {
    const { data: signed } = await requestDb.storage
      .from("mermas-evidence")
      .createSignedUrl(evidence.storage_path, 300);
    if (signed?.signedUrl) {
      requestEvidence.push({
        id: evidence.id,
        request_line_id: evidence.request_line_id,
        file_name: evidence.file_name,
        mime_type: evidence.mime_type,
        signed_url: signed.signedUrl,
      });
    }
  }
  const { data: user } = await db("portal")
    .from("users")
    .select("nombre, apellido")
    .eq("id", request.created_by)
    .maybeSingle();
  const { data: bsaleConsumption } = await requestDb
    .from("bsale_consumptions")
    .select(
      "consumption_id, consumption_date, note, match_method, processed_at",
    )
    .eq("company_id", authorization.companyId)
    .eq("request_id", id)
    .order("processed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { count: associationLineCount } = bsaleConsumption
    ? await requestDb
        .from("bsale_consumption_details")
        .select("id", { count: "exact", head: true })
        .eq("company_id", authorization.companyId)
        .eq("consumption_id", bsaleConsumption.consumption_id)
    : { count: 0 };
  const { count: allocationCount, error: allocationError } = await requestDb
    .from("bsale_detail_allocations")
    .select("id", { count: "exact", head: true })
    .eq("company_id", authorization.companyId)
    .eq("request_id", id);
  let authorizationReady = false;
  if (bsaleConsumption && request.status === "PENDIENTE" && canAuthorize) {
    const [{ data: consumptionDetails }, { data: allocations }, { count: movementCount }] = await Promise.all([
      requestDb
        .from("bsale_consumption_details")
        .select("id, quantity")
        .eq("company_id", authorization.companyId)
        .eq("consumption_id", bsaleConsumption.consumption_id),
      requestDb
        .from("bsale_detail_allocations")
        .select("consumption_detail_id, request_id, quantity")
        .eq("company_id", authorization.companyId)
        .eq("request_id", id),
      requestDb
        .from("movements")
        .select("id", { count: "exact", head: true })
        .eq("company_id", authorization.companyId)
        .eq("request_id", id),
    ]);
    const allocationTotals = new Map<number, number>();
    for (const allocation of allocations ?? []) {
      const detailId = Number(allocation.consumption_detail_id);
      allocationTotals.set(detailId, (allocationTotals.get(detailId) ?? 0) + Number(allocation.quantity));
    }
    const completeAllocations = Boolean(consumptionDetails?.length) && (consumptionDetails ?? []).every((detail) => (
      (allocationTotals.get(Number(detail.id)) ?? 0) >= Number(detail.quantity)
    ));
    const completeLines = (lines ?? []).length > 0 && (lines ?? []).every((line) => (
      Boolean(line.expiration_date) && (evidenceRows ?? []).some((evidence) => evidence.request_line_id === line.id)
    ));
    authorizationReady = completeAllocations && completeLines && !movementCount;
  }
  return {
    data: {
      ...request,
      line_count: lines?.length ?? 0,
      total_quantity: (lines ?? []).reduce(
        (sum, line) => sum + Number(line.quantity || 0),
        0,
      ),
      requester_name:
        `${user?.nombre ?? ""} ${user?.apellido ?? ""}`.trim() || "Usuario",
      company_name:
        company?.trade_name || company?.business_name || "Empresa activa",
       lines: (lines ?? []) as MermaLine[],
       evidence: requestEvidence,
        bsale_association: bsaleConsumption
          ? { ...bsaleConsumption, line_count: associationLineCount ?? 0 }
          : null,
        authorization_ready: authorizationReady,
        can_cancel: request.status === "PENDIENTE" && !bsaleConsumption && !allocationError && (allocationCount ?? 0) === 0,
    } as MermaRequest,
  };
}

export async function getPendingMermasCount(): Promise<number> {
  try {
    const authorization = await requireWmsPermission(
      "logistica.mermas.pending.view",
    );
    const { count } = await db("mermas")
      .from("requests")
      .select("id", { count: "exact", head: true })
      .eq("company_id", authorization.companyId)
      .eq("status", "PENDIENTE");
    return count ?? 0;
  } catch {
    // The list is available to Bodega; only Bsale managers see this counter.
    return 0;
  }
}

export type MermaBsaleCandidateDetail = {
  detail_id: number;
  variant_id: number;
  sku: string;
  quantity: number;
};

export type MermaBsaleCandidate = {
  consumption_id: number;
  consumption_date: string | null;
  note: string | null;
  details: MermaBsaleCandidateDetail[];
};

export type MermaBsaleIncidentDetail = {
  detail_id: number;
  variant_id: number;
  sku: string;
  product_name: string;
  quantity: number;
};

export type MermaBsaleIncident = {
  consumption_id: number;
  consumption_date: string | null;
  note: string | null;
  product_count: number;
  total_quantity: number;
  status: "SIN SOLICITUD" | "ASOCIACIÓN INCONSISTENTE";
  details: MermaBsaleIncidentDetail[];
};

export type MermaIncidentLineInput = {
  detail_id: number;
  variant_id: number;
  quantity: number;
  reason: string;
  expiration_date: string;
  lot?: string;
  observation?: string;
};

export async function getMermasBsaleIncidents(): Promise<{
  data: MermaBsaleIncident[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.view");
  const database = db("mermas");
  const { data: syncState, error: syncStateError } = await database
    .from("sync_state")
    .select("activation_date")
    .eq("company_id", authorization.companyId)
    .maybeSingle();
  if (syncStateError) return { data: [], error: "No se pudo leer la activación de Mermas" };
  const activationDate = syncState?.activation_date ?? "2026-09-10";
  const [{ data: consumptions, error: consumptionsError }, { data: details, error: detailsError }] = await Promise.all([
    database
      .from("bsale_consumptions")
      .select("consumption_id, consumption_date, note, request_id")
      .eq("company_id", authorization.companyId)
      .eq("consumption_type_id", 2)
      .gte("consumption_date", activationDate)
      .order("consumption_date", { ascending: false }),
    database
      .from("bsale_consumption_details")
      .select("id, consumption_id, detail_id, variant_id, quantity")
      .eq("company_id", authorization.companyId),
  ]);
  if (consumptionsError || detailsError) {
    return { data: [], error: "No se pudieron consultar incidencias Bsale" };
  }
  const consumptionIds = (consumptions ?? []).map((consumption) => consumption.consumption_id);
  if (!consumptionIds.length) return { data: [] };
  const [{ data: allocations }, { data: requests }] = await Promise.all([
    database
      .from("bsale_detail_allocations")
      .select("consumption_detail_id, request_id, quantity")
      .eq("company_id", authorization.companyId),
    database
      .from("requests")
      .select("id")
      .eq("company_id", authorization.companyId),
  ]);
  const requestIds = new Set((requests ?? []).map((request) => request.id));
  const allocationMap = new Map<string, { request_id: string | null; quantity: number }[]>();
  for (const allocation of allocations ?? []) {
    const current = allocationMap.get(allocation.consumption_detail_id) ?? [];
    current.push({ request_id: allocation.request_id, quantity: Number(allocation.quantity) });
    allocationMap.set(allocation.consumption_detail_id, current);
  }
  const variantIds = [...new Set((details ?? []).map((detail) => Number(detail.variant_id)))];
  const integrationDb = db("integraciones");
  const { data: variants } = variantIds.length
    ? await integrationDb
        .from("bsale_variants")
        .select("bsale_id, code, bsale_product_id")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", variantIds)
    : { data: [] as { bsale_id: number; code: string | null; bsale_product_id: number }[] };
  const productIds = [...new Set((variants ?? []).map((variant) => variant.bsale_product_id))];
  const { data: products } = productIds.length
    ? await integrationDb
        .from("bsale_products")
        .select("bsale_id, name")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", productIds)
    : { data: [] as { bsale_id: number; name: string | null }[] };
  const variantMap = new Map((variants ?? []).map((variant) => [variant.bsale_id, variant]));
  const productMap = new Map((products ?? []).map((product) => [product.bsale_id, product.name]));
  const detailsByConsumption = new Map<number, typeof details>();
  for (const detail of details ?? []) {
    const current = detailsByConsumption.get(detail.consumption_id) ?? [];
    current.push(detail);
    detailsByConsumption.set(detail.consumption_id, current);
  }
  const incidents: MermaBsaleIncident[] = [];
  for (const consumption of consumptions ?? []) {
    const consumptionDetails = detailsByConsumption.get(consumption.consumption_id) ?? [];
    const detailAllocations = consumptionDetails.map((detail) => allocationMap.get(detail.id) ?? []);
    const allocationRequestIds = new Set(
      detailAllocations.flat().map((allocation) => allocation.request_id).filter(Boolean),
    );
    const associatedRequestId = allocationRequestIds.size === 1 ? [...allocationRequestIds][0] : null;
    const completeAssociation = Boolean(associatedRequestId && requestIds.has(associatedRequestId)) &&
      (!consumption.request_id || consumption.request_id === associatedRequestId) &&
      consumptionDetails.length > 0 &&
      consumptionDetails.every((detail, index) => {
        const allocationsForDetail = detailAllocations[index];
        return allocationsForDetail.length > 0 &&
          allocationsForDetail.every((allocation) => allocation.request_id === associatedRequestId) &&
          allocationsForDetail.reduce((sum, allocation) => sum + allocation.quantity, 0) >= Number(detail.quantity);
      });
    if (completeAssociation) continue;
    const incidentDetails = consumptionDetails.map((detail) => {
      const variant = variantMap.get(Number(detail.variant_id));
      return {
        detail_id: Number(detail.detail_id),
        variant_id: Number(detail.variant_id),
        sku: variant?.code ?? `BS-${detail.variant_id}`,
        product_name: productMap.get(variant?.bsale_product_id ?? 0) ?? "Producto Bsale",
        quantity: Number(detail.quantity),
      };
    });
    incidents.push({
      consumption_id: consumption.consumption_id,
      consumption_date: consumption.consumption_date,
      note: consumption.note,
      product_count: incidentDetails.length,
      total_quantity: incidentDetails.reduce((sum, detail) => sum + detail.quantity, 0),
      status: allocationRequestIds.size > 0 || consumption.request_id ? "ASOCIACIÓN INCONSISTENTE" : "SIN SOLICITUD",
      details: incidentDetails,
    });
  }
  return { data: incidents };
}

export async function prepareMermaIncidentEvidenceUploads(
  consumptionId: number,
  lines: MermaIncidentLineInput[],
  files: Array<Omit<MermaEvidenceMetadata, "storage_path">>,
): Promise<{ data?: { session_id: string; session_token: string; finalize_token: string; uploads: MermaEvidenceUpload[] }; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.create");
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return { error: "No autorizado" };
    const database = db("mermas");
    const { data: consumption } = await database
      .from("bsale_consumptions")
      .select("consumption_id, consumption_type_id, request_id")
      .eq("company_id", authorization.companyId)
      .eq("consumption_id", consumptionId)
      .maybeSingle();
    const { data: details } = await database
      .from("bsale_consumption_details")
      .select("detail_id, variant_id, quantity")
      .eq("company_id", authorization.companyId)
      .eq("consumption_id", consumptionId);
    if (!consumption || consumption.consumption_type_id !== 2 || consumption.request_id || !details?.length) {
      return { error: "Este consumo Bsale ya fue regularizado o no es válido." };
    }
    if (lines.length !== details.length || lines.some((line) => !line.reason.trim() || !line.expiration_date || line.quantity <= 0)) {
      return { error: "Completa motivo, vencimiento y cantidades válidas en todas las líneas." };
    }
    const detailMap = new Map(details.map((detail) => [Number(detail.detail_id), detail]));
    if (lines.some((line) => {
      const detail = detailMap.get(line.detail_id);
      return !detail || detail.variant_id !== line.variant_id || Number(detail.quantity) !== line.quantity;
    })) return { error: "Las líneas no coinciden exactamente con el consumo Bsale." };
    if (files.length < lines.length || files.some((file) => !MERMA_EVIDENCE_MIME_TYPES.has(file.mime_type) || file.file_size <= 0 || file.file_size > MERMA_EVIDENCE_MAX_SIZE)) {
      return { error: "Cada línea requiere al menos una imagen válida de hasta 10 MB." };
    }
    const evidenceByLine = new Set(files.map((file) => file.line_index));
    if (lines.some((_, index) => !evidenceByLine.has(index))) return { error: "Cada línea requiere al menos una fotografía." };
    const sessionId = randomUUID();
    const metadata = files.map((file) => ({ ...file, storage_path: "" }));
    const uploads = metadata.map((file) => {
      const safeName = file.file_name.replace(/[^a-zA-Z0-9._-]/g, "_") || "evidencia.jpg";
      return { ...file, storage_path: `${authorization.companyId}/${sessionId}/${file.line_index}/${randomUUID()}-${safeName}` };
    });
    const sessionToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId);
    const finalizeToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId, uploads.map((file) => file.storage_path));
    const storage = database.storage.from(MERMA_EVIDENCE_BUCKET);
    const signedUploads: MermaEvidenceUpload[] = [];
    for (const upload of uploads) {
      const { data, error } = await storage.createSignedUploadUrl(upload.storage_path);
      if (error || !data?.signedUrl || !data.token) throw new Error("No se pudo preparar una carga segura.");
      signedUploads.push({ ...upload, signed_upload_url: data.signedUrl, upload_token: data.token });
    }
    return { data: { session_id: sessionId, session_token: sessionToken, finalize_token: finalizeToken, uploads: signedUploads } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo preparar la evidencia" };
  }
}

export async function regularizeMermaBsaleIncident(
  consumptionId: number,
  lines: MermaIncidentLineInput[],
  evidence: MermaEvidenceMetadata[],
  sessionId: string,
  sessionToken: string,
  finalizeToken: string,
): Promise<{ success?: boolean; request_id?: string; request_code?: string; status?: string; error?: string }> {
  const authorization = await requireWmsPermission("logistica.mermas.create");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { error: "No autorizado" };
  const expectedSessionToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId);
  const expectedFinalizeToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId, evidence.map((file) => file.storage_path));
  if (!hasValidMermaEvidenceSignature(sessionToken, expectedSessionToken) || !hasValidMermaEvidenceSignature(finalizeToken, expectedFinalizeToken)) return { error: "La sesión de evidencia no es válida" };
  const paths = evidence.map((file) => file.storage_path);
  try {
    const result = await db("mermas").rpc("regularize_bsale_incident", {
      p_consumption_id: consumptionId,
      p_company_id: authorization.companyId,
      p_user_id: auth.user.id,
      p_lines: lines,
      p_evidence: evidence,
    });
    if (result.error) throw new Error(result.error.message);
    return result.data as { success: boolean; request_id: string; request_code: string; status: string };
  } catch (error) {
    if (paths.length) await db("mermas").storage.from(MERMA_EVIDENCE_BUCKET).remove(paths);
    return { error: error instanceof Error ? error.message : "No se pudo regularizar el consumo Bsale" };
  }
}

export async function getMermasBsaleCandidates(
  requestId: string,
): Promise<{ data: MermaBsaleCandidate[]; error?: string }> {
  const authorization = await requireWmsPermission("logistica.mermas.authorize");
  const database = db("mermas");
  const { data: request, error: requestError } = await database
    .from("requests")
    .select("id, status")
    .eq("id", requestId)
    .eq("company_id", authorization.companyId)
    .maybeSingle();
  if (requestError || !request) return { data: [], error: "Solicitud no encontrada" };
  if (request.status !== "PENDIENTE") return { data: [] };
  const { data: requestLines, error: linesError } = await database
    .from("request_lines")
    .select("bsale_variant_id, quantity")
    .eq("company_id", authorization.companyId)
    .eq("request_id", requestId);
  if (linesError) return { data: [], error: "No se pudieron cargar las líneas" };
  const { data: consumptions, error: consumptionsError } = await database
    .from("bsale_consumptions")
    .select("consumption_id, consumption_date, note")
    .eq("company_id", authorization.companyId)
    .eq("consumption_type_id", 2)
    .is("request_id", null)
    .order("consumption_date", { ascending: false });
  if (consumptionsError) return { data: [], error: "No se pudieron cargar consumos Bsale" };
  const consumptionIds = (consumptions ?? []).map((item) => item.consumption_id);
  if (!consumptionIds.length) return { data: [] };
  const [{ data: details }, { data: allocations }] = await Promise.all([
    database
      .from("bsale_consumption_details")
      .select("id, consumption_id, detail_id, variant_id, quantity")
      .eq("company_id", authorization.companyId)
      .in("consumption_id", consumptionIds),
    database
      .from("bsale_detail_allocations")
      .select("consumption_detail_id")
      .eq("company_id", authorization.companyId),
  ]);
  const allocatedDetailIds = new Set((allocations ?? []).map((item) => item.consumption_detail_id));
  const detailRows = (details ?? []).filter((detail) => !allocatedDetailIds.has(detail.id));
  const requestTotals = new Map<number, number>();
  for (const line of requestLines ?? []) {
    requestTotals.set(Number(line.bsale_variant_id), (requestTotals.get(Number(line.bsale_variant_id)) ?? 0) + Number(line.quantity));
  }
  const variantIds = [...new Set(detailRows.map((detail) => Number(detail.variant_id)))];
  const { data: variants } = variantIds.length
    ? await db("integraciones")
        .from("bsale_variants")
        .select("bsale_id, code")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", variantIds)
    : { data: [] as { bsale_id: number; code: string | null }[] };
  const skuMap = new Map((variants ?? []).map((variant) => [variant.bsale_id, variant.code ?? `BS-${variant.bsale_id}`]));
  const candidates: MermaBsaleCandidate[] = [];
  for (const consumption of consumptions ?? []) {
    const rows = detailRows.filter((detail) => detail.consumption_id === consumption.consumption_id);
    const totals = new Map<number, number>();
    for (const detail of rows) totals.set(Number(detail.variant_id), (totals.get(Number(detail.variant_id)) ?? 0) + Number(detail.quantity));
    const compatible = totals.size === requestTotals.size && [...requestTotals].every(([variantId, quantity]) => totals.get(variantId) === quantity);
    if (!compatible) continue;
    candidates.push({
      consumption_id: consumption.consumption_id,
      consumption_date: consumption.consumption_date,
      note: consumption.note,
      details: rows.map((detail) => ({
        detail_id: detail.detail_id,
        variant_id: Number(detail.variant_id),
        sku: skuMap.get(Number(detail.variant_id)) ?? `BS-${detail.variant_id}`,
        quantity: Number(detail.quantity),
      })),
    });
  }
  return { data: candidates };
}

export async function authorizeMermaRequestWithConsumption(
  requestId: string,
  consumptionId: number,
): Promise<{ success?: boolean; status?: string; error?: string }> {
  const authorization = await requireWmsPermission("logistica.mermas.authorize");
  const { data, error } = await db("mermas").rpc("authorize_request_with_consumption", {
    p_request_id: requestId,
    p_consumption_id: consumptionId,
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
  });
  if (error) return { error: error.message };
  return data as { success: boolean; status: string };
}

export type MermaWarehouseRow = {
  id: string;
  request_line_id?: string | null;
  sku: string;
  product_name: string;
  available: number;
  expiration_date: string | null;
  lot: string | null;
  origin: string;
  request_code: string | null;
  entered_at: string;
};

export type MermaWarehouseLot = {
  id: string;
  available: number;
  expiration_date: string | null;
  lot: string | null;
  request_code: string | null;
  entered_at: string;
};

export type MermaWarehouseHistoryEntry = {
  id: string;
  occurred_at: string;
  movement_type: string;
  quantity: number;
  balance: number;
  origin: string;
  reference: string | null;
  user_name: string;
  consumption_id: number | null;
  detail_id: number | null;
  request_code: string | null;
  reason: string | null;
  expiration_date: string | null;
  lot: string | null;
  evidence: MermaEvidence[];
};

export type MermaWarehouseProduct = {
  variant_id: number;
  sku: string;
  product_name: string;
  available: number;
  next_expiration: string | null;
  expiration_status: "VENCIDO" | "POR VENCER" | "VIGENTE";
  lot_count: number;
  last_entry_at: string | null;
  lots: MermaWarehouseLot[];
  history: MermaWarehouseHistoryEntry[];
};

export type MermaAuthorizationRow = MermaWarehouseRow & {
  movement_id: string;
  consumption_id: number | null;
  reason: string | null;
  requester_name: string | null;
  request_date: string | null;
  evidence_count: number;
  authorization_status: "PENDIENTE_AUTORIZACION" | "AUTORIZADA" | "RECHAZADA";
};

export type MermaRejectedRow = MermaAuthorizationRow & {
  rejection_reason: string;
  rejected_by_name: string | null;
  rejected_at: string;
  consumption_date: string | null;
  note: string | null;
  original_reason: string | null;
};

export type MermaEvidence = {
  id: string;
  file_name: string;
  mime_type: string;
  signed_url: string;
};

export async function getMermasAuthorizationPending(): Promise<{
  data: MermaAuthorizationRow[];
  error?: string;
}> {
  const authorization = await requireWmsPermission(
    "logistica.mermas.authorize",
  );
  const database = db("mermas");
  const { data: movements, error } = await database
    .from("movements")
    .select(
      "id, variant_id, quantity, expiration_date, lot, source, request_id, request_line_id, consumption_id, created_at, authorization_status",
    )
    .eq("company_id", authorization.companyId)
    .eq("authorization_status", "PENDIENTE_AUTORIZACION")
    .order("created_at", { ascending: false });
  if (error)
    return { data: [], error: "No se pudieron cargar las entradas pendientes" };
  const lineIds = [
    ...new Set(
      (movements ?? []).map((item) => item.request_line_id).filter(Boolean),
    ),
  ];
  const requestIds = [
    ...new Set(
      (movements ?? []).map((item) => item.request_id).filter(Boolean),
    ),
  ];
  const { data: lines } = lineIds.length
    ? await database
        .from("request_lines")
        .select("id, reason, request_id")
        .in("id", lineIds)
    : { data: [] as { id: string; reason: string; request_id: string }[] };
  const { data: requests } = requestIds.length
    ? await database
        .from("requests")
        .select("id, request_code, created_at, created_by")
        .in("id", requestIds)
    : {
        data: [] as {
          id: string;
          request_code: string;
          created_at: string;
          created_by: string;
        }[],
      };
  const userIds = [...new Set((requests ?? []).map((item) => item.created_by))];
  const { data: users } = userIds.length
    ? await db("portal")
        .from("users")
        .select("id, nombre, apellido")
        .in("id", userIds)
    : { data: [] as { id: string; nombre: string; apellido: string }[] };
  const evidence = lineIds.length
    ? await database
        .from("evidence")
        .select("request_line_id")
        .in("request_line_id", lineIds)
    : { data: [] as { request_line_id: string }[] };
  const lineMap = new Map((lines ?? []).map((item) => [item.id, item]));
  const requestMap = new Map((requests ?? []).map((item) => [item.id, item]));
  const userMap = new Map(
    (users ?? []).map((item) => [
      item.id,
      `${item.nombre ?? ""} ${item.apellido ?? ""}`.trim(),
    ]),
  );
  const evidenceCount = new Map<string, number>();
  for (const item of evidence.data ?? [])
    evidenceCount.set(
      item.request_line_id,
      (evidenceCount.get(item.request_line_id) ?? 0) + 1,
    );
  const variants = [
    ...new Set((movements ?? []).map((item) => Number(item.variant_id))),
  ];
  const { data: variantRows } = variants.length
    ? await db("integraciones")
        .from("bsale_variants")
        .select("bsale_id, code, bsale_product_id")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", variants)
    : {
        data: [] as {
          bsale_id: number;
          code: string;
          bsale_product_id: number;
        }[],
      };
  const productIds = [
    ...new Set((variantRows ?? []).map((item) => item.bsale_product_id)),
  ];
  const { data: products } = productIds.length
    ? await db("integraciones")
        .from("bsale_products")
        .select("bsale_id, name")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", productIds)
    : { data: [] as { bsale_id: number; name: string }[] };
  const variantMap = new Map(
    (variantRows ?? []).map((item) => [item.bsale_id, item]),
  );
  const productMap = new Map(
    (products ?? []).map((item) => [item.bsale_id, item.name]),
  );
  return {
    data: (movements ?? []).map((item) => {
      const line = lineMap.get(item.request_line_id);
      const request = requestMap.get(item.request_id);
      const variant = variantMap.get(Number(item.variant_id));
      return {
        movement_id: item.id,
        id: item.id,
        request_line_id: item.request_line_id,
        consumption_id: item.consumption_id,
        sku: variant?.code ?? `BS-${item.variant_id}`,
        product_name:
          productMap.get(variant?.bsale_product_id ?? 0) ?? "Producto Bsale",
        available: Number(item.quantity),
        expiration_date: item.expiration_date,
        lot: item.lot,
        origin: item.source,
        request_code: request?.request_code ?? null,
        entered_at: item.created_at,
        reason: line?.reason ?? null,
        requester_name: request
          ? (userMap.get(request.created_by) ?? "Usuario")
          : null,
        request_date: request?.created_at ?? null,
        evidence_count: evidenceCount.get(item.request_line_id) ?? 0,
        authorization_status: item.authorization_status,
      };
    }),
  };
}

export async function getMermaMovementReview(movementId: string): Promise<{
  data: { movement: MermaAuthorizationRow; evidence: MermaEvidence[] } | null;
  error?: string;
}> {
  const authorization = await requireWmsPermission(
    "logistica.mermas.authorize",
  );
  const pending = await getMermasAuthorizationPending();
  const movement = pending.data.find((item) => item.movement_id === movementId)
    ?? (await getMermasRejected()).data.find((item) => item.movement_id === movementId);
  if (!movement)
    return { data: null, error: "Entrada no encontrada o ya autorizada" };
  const rows = movement.request_line_id
    ? await db("mermas")
        .from("evidence")
        .select("id, storage_path, file_name, mime_type")
        .eq("company_id", authorization.companyId)
        .eq("request_line_id", movement.request_line_id)
    : {
        data: [] as {
          id: string;
          storage_path: string;
          file_name: string;
          mime_type: string;
        }[],
      };
  const evidence: MermaEvidence[] = [];
  for (const row of rows.data ?? []) {
    const signed = await db("mermas")
      .storage.from("mermas-evidence")
      .createSignedUrl(row.storage_path, 300);
    if (signed.data?.signedUrl)
      evidence.push({
        id: row.id,
        file_name: row.file_name,
        mime_type: row.mime_type,
        signed_url: signed.data.signedUrl,
      });
  }
  return { data: { movement, evidence } };
}

export async function authorizeMermaMovement(movementId: string) {
  const authorization = await requireWmsPermission(
    "logistica.mermas.authorize",
  );
  const { data, error } = await db("mermas").rpc("authorize_movement", {
    p_movement_id: movementId,
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
  });
  if (error) return { error: error.message };
  return data as {
    success: boolean;
    already_authorized?: boolean;
    status?: string;
  };
}

export async function rejectMermaMovement(movementId: string, reason: string) {
  const authorization = await requireWmsPermission(
    "logistica.mermas.authorize",
  );
  const cleanReason = reason.trim();
  if (!cleanReason) return { error: "El motivo del rechazo es obligatorio" };
  const { data, error } = await db("mermas").rpc("reject_movement", {
    p_movement_id: movementId,
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_reason: cleanReason,
  });
  if (error) return { error: error.message };
  return data as { success: boolean; status?: string };
}

export async function getMermasRejected(): Promise<{
  data: MermaRejectedRow[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.view");
  const database = db("mermas");
  const { data: movements, error } = await database
    .from("movements")
    .select(
      "id, variant_id, quantity, expiration_date, lot, source, request_id, request_line_id, consumption_id, created_at, rejected_by, rejected_at, rejection_reason",
    )
    .eq("company_id", authorization.companyId)
    .eq("authorization_status", "RECHAZADA")
    .order("rejected_at", { ascending: false });
  if (error)
    return { data: [], error: "No se pudieron cargar las entradas archivadas" };
  const lineIds = [...new Set((movements ?? []).map((item) => item.request_line_id).filter(Boolean))];
  const requestIds = [...new Set((movements ?? []).map((item) => item.request_id).filter(Boolean))];
  const consumptionIds = [...new Set((movements ?? []).map((item) => item.consumption_id).filter(Boolean))];
  const variantIds = [...new Set((movements ?? []).map((item) => Number(item.variant_id)))];
  const [{ data: lines }, { data: requests }, { data: consumptions }, { data: evidence }] = await Promise.all([
    lineIds.length ? database.from("request_lines").select("id, reason").in("id", lineIds) : Promise.resolve({ data: [] as { id: string; reason: string }[] }),
    requestIds.length ? database.from("requests").select("id, request_code, created_at, created_by").in("id", requestIds) : Promise.resolve({ data: [] as { id: string; request_code: string; created_at: string; created_by: string }[] }),
    consumptionIds.length ? database.from("bsale_consumptions").select("consumption_id, consumption_date, note").in("consumption_id", consumptionIds) : Promise.resolve({ data: [] as { consumption_id: number; consumption_date: string | null; note: string | null }[] }),
    lineIds.length ? database.from("evidence").select("request_line_id").in("request_line_id", lineIds) : Promise.resolve({ data: [] as { request_line_id: string }[] }),
  ]);
  const userIds = [...new Set((requests ?? []).map((item) => item.created_by).concat((movements ?? []).map((item) => item.rejected_by).filter(Boolean)))];
  const { data: users } = userIds.length
    ? await db("portal").from("users").select("id, nombre, apellido").in("id", userIds)
    : { data: [] as { id: string; nombre: string | null; apellido: string | null }[] };
  const integrationDb = db("integraciones");
  const { data: variantRows } = variantIds.length
    ? await integrationDb.from("bsale_variants").select("bsale_id, code, bsale_product_id").eq("company_id", authorization.companyId).in("bsale_id", variantIds)
    : { data: [] as { bsale_id: number; code: string | null; bsale_product_id: number }[] };
  const productIds = [...new Set((variantRows ?? []).map((item) => item.bsale_product_id))];
  const { data: products } = productIds.length
    ? await integrationDb.from("bsale_products").select("bsale_id, name").eq("company_id", authorization.companyId).in("bsale_id", productIds)
    : { data: [] as { bsale_id: number; name: string | null }[] };
  const lineMap = new Map((lines ?? []).map((item) => [item.id, item]));
  const requestMap = new Map((requests ?? []).map((item) => [item.id, item]));
  const consumptionMap = new Map((consumptions ?? []).map((item) => [item.consumption_id, item]));
  const userMap = new Map((users ?? []).map((item) => [item.id, `${item.nombre ?? ""} ${item.apellido ?? ""}`.trim()]));
  const variantMap = new Map((variantRows ?? []).map((item) => [item.bsale_id, item]));
  const productMap = new Map((products ?? []).map((item) => [item.bsale_id, item.name]));
  const evidenceCount = new Map<string, number>();
  for (const item of evidence ?? []) evidenceCount.set(item.request_line_id, (evidenceCount.get(item.request_line_id) ?? 0) + 1);
  return {
    data: (movements ?? []).map((item) => {
      const line = lineMap.get(item.request_line_id);
      const request = requestMap.get(item.request_id);
      const variant = variantMap.get(Number(item.variant_id));
      const consumption = consumptionMap.get(Number(item.consumption_id));
      return {
        movement_id: item.id,
        id: item.id,
        request_line_id: item.request_line_id,
        consumption_id: item.consumption_id,
        sku: variant?.code ?? `BS-${item.variant_id}`,
        product_name: productMap.get(variant?.bsale_product_id ?? 0) ?? "Producto Bsale",
        available: Number(item.quantity),
        expiration_date: item.expiration_date,
        lot: item.lot,
        origin: item.source,
        request_code: request?.request_code ?? null,
        entered_at: item.created_at,
        reason: line?.reason ?? null,
        requester_name: request ? (userMap.get(request.created_by) ?? "Usuario") : null,
        request_date: request?.created_at ?? null,
        evidence_count: evidenceCount.get(item.request_line_id) ?? 0,
        rejection_reason: item.rejection_reason,
        rejected_by_name: item.rejected_by ? userMap.get(item.rejected_by) ?? null : null,
        rejected_at: item.rejected_at,
        consumption_date: consumption?.consumption_date ?? null,
        note: consumption?.note ?? null,
        original_reason: line?.reason ?? null,
      };
    }) as MermaRejectedRow[],
  };
}

export async function syncMermasFromBsale() {
  const authorization = await requireWmsPermission("logistica.mermas.sync");
  return syncBsaleMermas({
    companyId: authorization.companyId,
    userId: authorization.user.id,
    trigger: "MANUAL",
  });
}

export async function getMermasWarehouse(): Promise<{
  data: MermaWarehouseProduct[];
  error?: string;
}> {
  const authorization = await requireWmsPermission(
    "logistica.mermas.warehouse.view",
  );
  const database = db("mermas");
  const { data: stockRows, error } = await database
    .from("stock_current")
    .select(
      "variant_id, available, expiration_date, lot, request_id, entered_at, source",
    )
    .eq("company_id", authorization.companyId)
    .order("entered_at", { ascending: false });
  if (error)
    return { data: [], error: "No se pudo cargar la Bodega de Mermas" };

  const { data: movementRows, error: movementError } = await database
    .from("movements")
    .select(
      "id, movement_type, variant_id, quantity, expiration_date, lot, consumption_id, detail_id, request_id, request_line_id, source, authorization_status, authorized_by, authorized_at, created_at",
    )
    .eq("company_id", authorization.companyId)
    .order("created_at", { ascending: true });
  if (movementError)
    return { data: [], error: "No se pudo cargar la trazabilidad de Bodega" };

  const variantIds = [
    ...new Set(
      [...(stockRows ?? []), ...(movementRows ?? [])].map((movement) =>
        Number(movement.variant_id),
      ),
    ),
  ];
  const requestIds = [
    ...new Set(
      [...(stockRows ?? []), ...(movementRows ?? [])]
        .map((movement) => movement.request_id)
        .filter(Boolean),
    ),
  ];
  const lineIds = [
    ...new Set(
      (movementRows ?? []).map((movement) => movement.request_line_id).filter(Boolean),
    ),
  ];
  const integrationDb = db("integraciones");
  const { data: variants } = variantIds.length
    ? await integrationDb
        .from("bsale_variants")
        .select("bsale_id, code, bsale_product_id")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", variantIds)
    : {
        data: [] as {
          bsale_id: number;
          code: string | null;
          bsale_product_id: number;
        }[],
      };
  const productIds = [
    ...new Set((variants ?? []).map((variant) => variant.bsale_product_id)),
  ];
  const { data: productRows } = productIds.length
    ? await integrationDb
        .from("bsale_products")
        .select("bsale_id, name")
        .eq("company_id", authorization.companyId)
        .in("bsale_id", productIds)
    : { data: [] as { bsale_id: number; name: string | null }[] };
  const [{ data: requests }, { data: lines }, { data: evidenceRows }] = await Promise.all([
    requestIds.length
    ? database
        .from("requests")
        .select("id, request_code, created_at, created_by")
        .eq("company_id", authorization.companyId)
        .in("id", requestIds)
    : Promise.resolve({ data: [] as { id: string; request_code: string; created_at: string; created_by: string }[] }),
    lineIds.length
      ? database
          .from("request_lines")
          .select("id, request_id, reason")
          .eq("company_id", authorization.companyId)
          .in("id", lineIds)
      : Promise.resolve({ data: [] as { id: string; request_id: string; reason: string | null }[] }),
    lineIds.length
      ? database
          .from("evidence")
          .select("id, request_line_id, file_name, mime_type, storage_path")
          .eq("company_id", authorization.companyId)
          .in("request_line_id", lineIds)
      : Promise.resolve({ data: [] as { id: string; request_line_id: string; file_name: string; mime_type: string; storage_path: string }[] }),
  ]);
  const userIds = [
    ...new Set(
      (requests ?? [])
        .map((request) => request.created_by)
        .concat((movementRows ?? []).map((movement) => movement.authorized_by).filter(Boolean)),
    ),
  ];
  const { data: users } = userIds.length
    ? await db("portal")
        .from("users")
        .select("id, nombre, apellido")
        .in("id", userIds)
    : { data: [] as { id: string; nombre: string | null; apellido: string | null }[] };
  const signedEvidence = new Map<string, MermaEvidence>();
  for (const evidence of evidenceRows ?? []) {
    const { data: signed } = await database.storage
      .from("mermas-evidence")
      .createSignedUrl(evidence.storage_path, 300);
    if (signed?.signedUrl) {
      signedEvidence.set(evidence.id, {
        id: evidence.id,
        file_name: evidence.file_name,
        mime_type: evidence.mime_type,
        signed_url: signed.signedUrl,
      });
    }
  }
  const variantMap = new Map(
    (variants ?? []).map((variant) => [variant.bsale_id, variant]),
  );
  const productMap = new Map(
    (productRows ?? []).map((product) => [product.bsale_id, product.name]),
  );
  const requestMap = new Map(
    (requests ?? []).map((request) => [request.id, request]),
  );
  const lineMap = new Map((lines ?? []).map((line) => [line.id, line]));
  const userMap = new Map(
    (users ?? []).map((user) => [
      user.id,
      `${user.nombre ?? ""} ${user.apellido ?? ""}`.trim() || "Usuario",
    ]),
  );
  const evidenceByLine = new Map<string, MermaEvidence[]>();
  for (const evidence of evidenceRows ?? []) {
    const signed = signedEvidence.get(evidence.id);
    if (signed) {
      const current = evidenceByLine.get(evidence.request_line_id) ?? [];
      current.push(signed);
      evidenceByLine.set(evidence.request_line_id, current);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const warningDate = new Date(`${today}T00:00:00Z`);
  warningDate.setUTCDate(warningDate.getUTCDate() + 30);
  const getExpirationStatus = (date: string | null): MermaWarehouseProduct["expiration_status"] => {
    if (date && date < today) return "VENCIDO";
    if (date && date <= warningDate.toISOString().slice(0, 10)) return "POR VENCER";
    return "VIGENTE";
  };
  const products = new Map<number, MermaWarehouseProduct>();
  for (const stock of stockRows ?? []) {
    if (Number(stock.available) <= 0) continue;
    const variantId = Number(stock.variant_id);
    const variant = variantMap.get(variantId);
    const current: MermaWarehouseProduct = products.get(variantId) ?? {
      variant_id: variantId,
      sku: variant?.code ?? `BS-${variantId}`,
      product_name: productMap.get(variant?.bsale_product_id ?? 0) ?? "Producto Bsale",
      available: 0,
      next_expiration: null,
      expiration_status: "VIGENTE" as const,
      lot_count: 0,
      last_entry_at: null,
      lots: [],
      history: [],
    };
    const request = stock.request_id ? requestMap.get(stock.request_id) : null;
    current.available += Number(stock.available);
    current.lots.push({
      id: `${variantId}-${stock.expiration_date ?? "pending"}-${stock.lot ?? "none"}-${stock.request_id ?? "direct"}`,
      available: Number(stock.available),
      expiration_date: stock.expiration_date,
      lot: stock.lot,
      request_code: request?.request_code ?? null,
      entered_at: stock.entered_at,
    });
    products.set(variantId, current);
  }
  for (const product of products.values()) {
    product.lots.sort((a, b) => (a.expiration_date ?? "9999").localeCompare(b.expiration_date ?? "9999"));
    product.next_expiration = product.lots.find((lot) => lot.expiration_date)?.expiration_date ?? null;
    product.expiration_status = getExpirationStatus(product.next_expiration);
    product.lot_count = product.lots.length;
    product.last_entry_at = product.lots.reduce<string | null>(
      (latest, lot) => (!latest || lot.entered_at > latest ? lot.entered_at : latest),
      null,
    );
  }
  const balances = new Map<number, number>();
  for (const movement of movementRows ?? []) {
    const variantId = Number(movement.variant_id);
    const product = products.get(variantId);
    if (!product) continue;
    const quantity = Number(movement.quantity);
    const balance = (balances.get(variantId) ?? 0) + quantity;
    balances.set(variantId, balance);
    const request = movement.request_id ? requestMap.get(movement.request_id) : null;
    const line = movement.request_line_id ? lineMap.get(movement.request_line_id) : null;
    product.history.push({
      id: movement.id,
      occurred_at: movement.authorized_at ?? movement.created_at,
      movement_type: movement.movement_type === "ENTRADA_BSALE" ? "INGRESO A BODEGA" : movement.movement_type,
      quantity,
      balance,
      origin: movement.consumption_id ? `Bsale #${movement.consumption_id}` : movement.source,
      reference: request?.request_code ?? null,
      user_name: userMap.get(movement.authorized_by) ?? userMap.get(request?.created_by ?? "") ?? "Usuario",
      consumption_id: movement.consumption_id,
      detail_id: movement.detail_id,
      request_code: request?.request_code ?? null,
      reason: line?.reason ?? null,
      expiration_date: movement.expiration_date,
      lot: movement.lot,
      evidence: line ? evidenceByLine.get(line.id) ?? [] : [],
    });
  }
  return { data: [...products.values()] };
}

type MermaRequestLineInput = {
  variant_id: string;
  quantity: string | number;
  reason: string;
  expiration_date: string;
  lot?: string;
  observation?: string;
};

async function validateMermaRequest(
  authorization: { companyId: string },
  lines: MermaRequestLineInput[],
  evidence: MermaEvidenceMetadata[],
) {
  if (!lines.length) throw new Error("Agrega al menos un producto");
  if (!evidence.length) {
    throw new Error("Debes adjuntar al menos una fotografía en cada línea.");
  }
  const evidenceByLine = new Map<number, MermaEvidenceMetadata[]>();
  for (const item of evidence) {
    if (
      !Number.isInteger(item.line_index) ||
      item.line_index < 0 ||
      item.line_index >= lines.length ||
      !MERMA_EVIDENCE_MIME_TYPES.has(item.mime_type) ||
      !Number.isInteger(item.file_size) ||
      item.file_size <= 0 ||
      item.file_size > MERMA_EVIDENCE_MAX_SIZE
    ) {
      throw new Error("Cada evidencia debe ser una imagen válida de hasta 10 MB.");
    }
    const current = evidenceByLine.get(item.line_index) ?? [];
    current.push(item);
    evidenceByLine.set(item.line_index, current);
  }
  if (lines.some((_, index) => !evidenceByLine.has(index))) {
    throw new Error("Debes adjuntar al menos una fotografía en cada línea.");
  }

  const requestedByVariant = new Map<string, number>();
  for (const line of lines) {
    if (!line.variant_id) throw new Error("Debes seleccionar un producto.");
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("Ingresa una cantidad válida.");
    }
    if (!line.reason.trim()) throw new Error("Debes ingresar un motivo.");
    const expirationMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(line.expiration_date);
    const expirationDate = expirationMatch
      ? new Date(Date.UTC(Number(expirationMatch[1]), Number(expirationMatch[2]) - 1, Number(expirationMatch[3])))
      : null;
    if (
      !expirationDate ||
      expirationDate.getUTCFullYear() !== Number(expirationMatch?.[1]) ||
      expirationDate.getUTCMonth() !== Number(expirationMatch?.[2]) - 1 ||
      expirationDate.getUTCDate() !== Number(expirationMatch?.[3])
    ) {
      throw new Error("Debes ingresar una fecha de vencimiento.");
    }
    requestedByVariant.set(
      line.variant_id,
      (requestedByVariant.get(line.variant_id) ?? 0) + quantity,
    );
  }

  const integrationDb = db("integraciones");
  const variantIds = [...requestedByVariant.keys()];
  const { data: variants, error: variantsError } = await integrationDb
    .from("bsale_variants")
    .select("id, bsale_id")
    .eq("company_id", authorization.companyId)
    .in("id", variantIds);
  if (variantsError) throw new Error("No se pudo validar el catálogo Bsale");
  const variantMap = new Map((variants ?? []).map((variant) => [variant.id, variant]));
  if (variantIds.some((variantId) => !variantMap.has(variantId))) {
    throw new Error("Producto no encontrado en el catálogo Bsale");
  }
  const bsaleVariantIds = [...variantMap.values()].map((variant) => variant.bsale_id);
  const { data: offices } = await integrationDb
    .from("bsale_offices")
    .select("bsale_id, name")
    .eq("company_id", authorization.companyId);
  const { data: stockRows, error: stockError } = await integrationDb
    .from("bsale_stock_current")
    .select("variant_id, quantity_available, office_id, raw_json")
    .eq("company_id", authorization.companyId)
    .in("variant_id", bsaleVariantIds);
  if (stockError) throw new Error("No se pudo validar el stock Bsale");
  const normalizedOfficeName = (name: string | null | undefined) => (name ?? "").trim().toUpperCase();
  let casaMatrizOfficeId = (offices ?? []).find((office) =>
    normalizedOfficeName(office.name).includes("CASA MATRIZ") || normalizedOfficeName(office.name).includes("MATRIZ"),
  )?.bsale_id ?? null;
  if (casaMatrizOfficeId === null) {
    casaMatrizOfficeId = (stockRows ?? []).find((row) => {
      const name = normalizedOfficeName(row.raw_json?.office?.name);
      return name.includes("CASA MATRIZ") || name.includes("MATRIZ");
    })?.office_id ?? null;
  }
  if (casaMatrizOfficeId === null) {
    const officeIds = new Set((stockRows ?? []).map((row) => row.office_id).filter((officeId): officeId is number => officeId !== null));
    if (officeIds.size === 1) casaMatrizOfficeId = [...officeIds][0];
  }
  if (casaMatrizOfficeId === null) throw new Error("No se pudo identificar la oficina CASA MATRIZ en el stock Bsale");
  const stockByVariant = new Map<number, number>();
  for (const row of stockRows ?? []) {
    if (row.office_id === casaMatrizOfficeId && row.quantity_available !== null && Number.isFinite(Number(row.quantity_available)) && Number(row.quantity_available) >= 0) {
      stockByVariant.set(row.variant_id, (stockByVariant.get(row.variant_id) ?? 0) + Number(row.quantity_available));
    }
  }
  for (const [variantId, requested] of requestedByVariant) {
    const stock = stockByVariant.get(variantMap.get(variantId)!.bsale_id);
    if (stock === undefined) throw new Error("Sin información de stock Bsale para el producto");
    if (stock <= 0) throw new Error("El producto no tiene stock disponible en Bsale.");
    if (requested > stock) throw new Error("La cantidad solicitada supera el stock disponible en Bsale.");
  }
}

export async function prepareMermaEvidenceUploads(
  lines: MermaRequestLineInput[],
  files: Array<Omit<MermaEvidenceMetadata, "storage_path">>,
): Promise<{ data?: { session_id: string; session_token: string; finalize_token: string; uploads: MermaEvidenceUpload[] }; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.create");
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return { error: "No autorizado" };
    const sessionId = randomUUID();
    const metadata = files.map((file) => ({ ...file, storage_path: "" }));
    await validateMermaRequest(authorization, lines, metadata);
    const uploads = metadata.map((file) => {
      const safeName = file.file_name.replace(/[^a-zA-Z0-9._-]/g, "_") || "evidencia.jpg";
      return { ...file, storage_path: `${authorization.companyId}/${sessionId}/${file.line_index}/${randomUUID()}-${safeName}` };
    });
    const sessionToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId);
    const finalizeToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId, uploads.map((file) => file.storage_path));
    const storage = db("mermas").storage.from(MERMA_EVIDENCE_BUCKET);
    const signedUploads: MermaEvidenceUpload[] = [];
    for (const upload of uploads) {
      const { data, error } = await storage.createSignedUploadUrl(upload.storage_path);
      if (error || !data?.signedUrl || !data.token) throw new Error("No se pudo preparar una carga segura.");
      signedUploads.push({ ...upload, signed_upload_url: data.signedUrl, upload_token: data.token });
    }
    return { data: { session_id: sessionId, session_token: sessionToken, finalize_token: finalizeToken, uploads: signedUploads } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo preparar la evidencia" };
  }
}

export async function cleanupMermaEvidenceUploads(
  sessionId: string,
  sessionToken: string,
  paths: string[],
): Promise<{ success?: boolean; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.create");
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user || !hasValidMermaEvidenceSignature(sessionToken, signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId))) return { error: "No autorizado" };
    const prefix = `${authorization.companyId}/${sessionId}/`;
    if (paths.some((path) => !path.startsWith(prefix))) return { error: "Ruta de evidencia inválida" };
    if (paths.length) await db("mermas").storage.from(MERMA_EVIDENCE_BUCKET).remove(paths);
    return { success: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo limpiar la evidencia" };
  }
}

export async function createMermaRequest(
  lines: MermaRequestLineInput[],
  evidence: MermaEvidenceMetadata[] = [],
  sessionId = "",
  sessionToken = "",
  finalizeToken = "",
): Promise<{ success?: boolean; request_id?: string; request_code?: string; status?: string; error?: string }> {
  const authorization = await requireWmsPermission("logistica.mermas.create");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { error: "No autorizado" };
  if (!sessionId || !sessionToken || !finalizeToken) {
    return reportEvidenceValidation(new MermaEvidenceValidationError("EVIDENCE_SESSION_INVALID"));
  }
  const expectedSessionToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId);
  const expectedFinalizeToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, sessionId, evidence.map((file) => file.storage_path));
  if (!hasValidMermaEvidenceSignature(sessionToken, expectedSessionToken)) {
    return reportEvidenceValidation(new MermaEvidenceValidationError("EVIDENCE_SESSION_INVALID"));
  }
  if (!hasValidMermaEvidenceSignature(finalizeToken, expectedFinalizeToken)) {
    return reportEvidenceValidation(new MermaEvidenceValidationError("EVIDENCE_TOKEN_INVALID"));
  }
  const prefix = `${authorization.companyId}/${sessionId}/`;
  const invalidPath = evidence.find((file) => !file.storage_path.startsWith(prefix));
  if (invalidPath) {
    return reportEvidenceValidation(new MermaEvidenceValidationError("EVIDENCE_PATH_INVALID", invalidPath.line_index));
  }
  const uploadedPaths = evidence.map((file) => file.storage_path);
  try {
    await validateMermaRequest(authorization, lines, evidence);
    const storage = db("mermas").storage.from(MERMA_EVIDENCE_BUCKET);
    for (const file of evidence) {
      const { data: object } = await storage.info(file.storage_path);
      const objectMetadata = object as
        | { size?: number | string; contentType?: string }
        | null;
      if (!objectMetadata) throw new MermaEvidenceValidationError("EVIDENCE_OBJECT_NOT_FOUND", file.line_index);
      if (Number(objectMetadata.size) !== file.file_size) throw new MermaEvidenceValidationError("EVIDENCE_SIZE_INVALID", file.line_index);
      if (objectMetadata.contentType !== file.mime_type) throw new MermaEvidenceValidationError("EVIDENCE_MIME_INVALID", file.line_index);
    }
    const requestId = randomUUID();
    const { data, error } = await db("mermas").rpc("create_request", {
      p_request_id: requestId,
      p_company_id: authorization.companyId,
      p_user_id: auth.user.id,
      p_lines: lines,
      p_evidence: evidence,
    });
    if (error) throw new Error(error.message);
    return data as { success: boolean; request_id: string; request_code: string; status: string };
  } catch (error) {
    if (uploadedPaths.length) await db("mermas").storage.from(MERMA_EVIDENCE_BUCKET).remove(uploadedPaths);
    if (error instanceof MermaEvidenceValidationError) return reportEvidenceValidation(error);
    return { error: error instanceof Error ? error.message : "No se pudo guardar la solicitud" };
  }
}

export async function cancelMermaRequest(
  requestId: string,
  reason: string,
): Promise<{ success?: boolean; error?: string }> {
  const authorization = await requireWmsPermission("logistica.mermas.cancel");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const cleanReason = reason.trim();
  if (!auth.user) return { error: "No autorizado" };
  if (!cleanReason) return { error: "El motivo de cancelación es obligatorio" };
  const { data, error } = await db("mermas").rpc("cancel_request", {
    p_request_id: requestId,
    p_company_id: authorization.companyId,
    p_user_id: auth.user.id,
    p_reason: cleanReason,
  });
  if (error) return { error: error.message };
  const result = data as { success?: boolean; error?: string };
  return result.success
    ? { success: true }
    : { error: result.error || "No se pudo cancelar la solicitud" };
}

export async function getActiveMermasCompanyId() {
  return getActiveCompanyId();
}
