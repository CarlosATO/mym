"use server";

import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getActiveCompany, getActiveCompanyId } from "@/app/actions/companies";
import { requireWmsPermission } from "./authorization";
import { syncBsaleMermas } from "@/lib/integraciones/bsale-mermas-sync";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import {
  calculateCostWithVat,
  calculateWorkerPrice,
} from "@/modules/logistica/mermas/worker-pricing";
import { todayInSantiago } from "@/lib/datetime";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const MERMA_WORKER_PAYMENT_BUCKET = "mermas-worker-payments";
const MERMA_WORKER_PAYMENT_MAX_SIZE = 10 * 1024 * 1024;
const MERMA_WORKER_PAYMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

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
  is_pack: boolean;
  stock_available: number | null;
  stock_last_synced_at: string | null;
};

export type MermaPricingSettings = {
  id: string | null;
  worker_markup_percent: number | null;
  worker_monthly_limit_amount: number | null;
  updated_at: string | null;
  updated_by: string | null;
  can_edit: boolean;
};

export type MermasBootstrap = {
  userId: string;
  companyId: string;
  companyName: string;
  canView: boolean;
  canCreate: boolean;
  canCreateRequest: boolean;
  canAuthorize: boolean;
  canSync: boolean;
  canUseInternalSale: boolean;
  isSuperUser: boolean;
  canReviewPayments: boolean;
  canViewAccounts: boolean;
  canEditSettings: boolean;
  canViewWarehouse: boolean;
  canViewPendingCount: boolean;
  pricingSettings: MermaPricingSettings;
  pendingCount: number;
};

export type InternalSaleEmployee = {
  id: string;
  rut: string;
  display_name: string;
  cargo: string | null;
};

export type InternalSaleWorkerContext = {
  employee: InternalSaleEmployee;
  monthly_limit: number | null;
  monthly_used: number;
  monthly_available: number | null;
};

export type InternalSaleProduct = {
  bsale_variant_id: number;
  sku: string;
  product_name: string;
  average_cost: number;
  cost_with_vat: number;
  default_markup_percent: number;
  eligible_stock: number;
  worker_unit_price: number;
  next_eligible_expiration: string;
};

export type InternalSalePrintData = {
  id: string;
  sale_number: string;
  employee_name_snapshot: string;
  employee_rut_snapshot: string;
  status: string;
  total_amount: number;
  created_at: string;
  responsible_user_id: string;
  lines: Array<{
    id: string;
    sku_snapshot: string;
    product_name_snapshot: string;
    quantity: number;
    worker_unit_price_snapshot: number;
    line_total: number;
    lots: Array<{
      quantity: number;
      expiration_date: string | null;
      lot: string | null;
    }>;
  }>;
};

export type WorkerAccount = {
  employee_id: string;
  employee_name: string;
  rut: string;
  employee_status: "ACTIVO" | "INACTIVO";
  total_charges: number;
  approved_payments: number;
  pending_review_payments: number;
  official_balance: number;
  projected_balance: number;
  last_sale_at: string | null;
  last_payment_at: string | null;
};

export type WorkerAccountDetail = {
  employee: {
    id: string;
    name: string;
    rut: string;
    status: "ACTIVO" | "INACTIVO";
  };
  summary: {
    total_charges: number;
    approved_payments: number;
    pending_review_payments: number;
    official_balance: number;
    projected_balance: number;
  };
  movements: Array<{
    movement_type: "CHARGE" | "PAYMENT";
    label: string;
    reference_number: string;
    amount: number;
    status: string;
    occurred_at: string;
    source_type?: string | null;
    charge_id?: string | null;
  }>;
};

export type WorkerAccountV2 = {
  employee_id: string;
  employee_name: string;
  rut: string;
  employee_status: "ACTIVO" | "INACTIVO";
  approved_payments: number;
  official_balance: number;
  projected_balance: number;
  pending_review_payments: number;
  merma_balance: number;
  bsale_boleta_balance: number;
  active_charge_count: number;
  open_charge_count: number;
  last_charge_at: string | null;
  last_payment_at: string | null;
};

export type WorkerBsaleBoletaCandidate = {
  bsale_id: number;
  document_number: number;
  emission_date: string | null;
  total_amount: number;
  client_id: number | null;
};

export type WorkerRegularizationEmployee = {
  id: string;
  display_name: string;
  rut: string;
  cargo: string | null;
};

export type WorkerAccountChargeItemV2 = {
  bsale_variant_id: number | null;
  variant_id?: number | null;
  sku: string | null;
  variant_code?: string | null;
  product_name: string | null;
  variant_description?: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
};

export type WorkerAccountAllocationV2 = {
  payment_id: string;
  payment_number: string | null;
  payment_date: string;
  amount: number;
};

export type WorkerAccountChargeV2 = {
  charge_id: string;
  source_type: "MERMA" | "BSALE_BOLETA";
  source_label: string;
  source_id: string;
  document_type: string | null;
  document_number: string | null;
  document_date: string | null;
  original_amount: number;
  credit_note_amount: number;
  approved_paid_amount: number;
  outstanding_amount: number;
  status: "ACTIVE" | "REVERSED";
  items: WorkerAccountChargeItemV2[];
  allocations: WorkerAccountAllocationV2[];
};

export type WorkerAccountPaymentV2 = {
  payment_id: string;
  payment_number: string | null;
  amount: number;
  status: "ACTIVE" | "VOIDED";
  submitted_at: string;
  reviewed_at: string | null;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  allocations: Array<{
    charge_id: string;
    source_type: WorkerAccountChargeV2["source_type"];
    document_number: string | null;
    amount: number;
  }>;
};

export type WorkerAccountDetailV2 = {
  employee: { id: string; name: string; rut: string; status: "ACTIVO" | "INACTIVO" };
  summary: {
    total_original_charges: number;
    approved_payments: number;
    pending_review_payments: number;
    official_balance: number;
    projected_balance: number;
    merma_original: number;
    merma_balance: number;
    bsale_boleta_original: number;
    bsale_boleta_balance: number;
    charge_count: number;
    open_charge_count: number;
    paid_charge_count: number;
  };
  charges: WorkerAccountChargeV2[];
  payments: WorkerAccountPaymentV2[];
  movements: Array<{
    movement_type: "CHARGE" | "PAYMENT" | "ADJUSTMENT";
    charge_id: string | null;
    reversal_of_charge_id: string | null;
    payment_id: string | null;
    source_type: WorkerAccountChargeV2["source_type"] | "BSALE_NOTA_CREDITO" | null;
    reference_number: string;
    amount: number;
    status: string;
    occurred_at: string;
  }>;
};

export type WorkerPaymentUpload = {
  upload_id: string;
  upload_token: string;
  validation_token: string;
  storage_path: string;
  signed_upload_url: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
};

export type WorkerPaymentReview = {
  payment_id: string;
  payment_number: string;
  employee_id: string;
  employee_name: string;
  rut: string;
  amount: number;
  submitted_at: string;
  submitted_by: string;
  status: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
};

export type WorkerPaymentReviewDetail = {
  payment: {
    id: string;
    payment_number: string;
    amount: number;
    status: string;
    submitted_at: string;
    submitted_by: string;
  };
  employee: { id: string; name: string; rut: string };
  summary: WorkerAccountDetail["summary"];
  evidence: { original_filename: string; mime_type: string; size_bytes: number };
};

type InternalSaleEmployeeRpcRow = {
  employee_id: string;
  rut: string;
  nombres: string;
  apellido_paterno: string;
  apellido_materno: string | null;
  cargo: string | null;
};

function addCivilDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
}

function monthKeyInSantiago(value: string) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function internalSaleErrorMessage(message: string) {
  const normalized = message.toLocaleLowerCase("es-CL");
  if (normalized.includes("no autorizado") || normalized.includes("usuario inválido")) {
    return "No estás autorizado para realizar ventas internas de Mermas.";
  }
  if (normalized.includes("trabajador no está activo")) return "El trabajador seleccionado no está ACTIVO.";
  if (normalized.includes("trabajador no encontrado")) return "El trabajador seleccionado ya no está disponible.";
  if (normalized.includes("sin costo") || normalized.includes("costo promedio")) {
    return "Uno de los productos no tiene un costo Bsale válido.";
  }
  if (normalized.includes("stock elegible insuficiente")) {
    return "El stock elegible cambió y ya no alcanza para la cantidad solicitada. Actualiza la disponibilidad.";
  }
  if (normalized.includes("tope mensual excedido")) {
    return "El tope mensual del trabajador sería excedido con esta venta.";
  }
  if (normalized.includes("configurar porcentaje") || normalized.includes("configuración")) {
    return "La configuración de venta a trabajadores está incompleta.";
  }
  if (normalized.includes("producto") && normalized.includes("catálogo")) {
    return "Uno de los productos ya no está disponible en el catálogo.";
  }
  return "No se pudo registrar la venta. Actualiza la disponibilidad e inténtalo nuevamente.";
}

export async function getMermasInternalSaleAccess() {
  const authorization = await requireWmsPermission("logistica.mermas.internal_sale.create");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_permission", {
    p_permission_code: "logistica.mermas.internal_sale.create",
  });
  return {
    canCreate: !error && data === true,
    companyId: authorization.companyId,
  };
}

export async function searchInternalSaleEmployees(search: string): Promise<{
  data: InternalSaleEmployee[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.internal_sale.create");
  const { data, error } = await db("mermas").rpc("search_active_employees_for_internal_sale", {
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_search: search.trim() || null,
    p_limit: 20,
    p_employee_id: null,
  });
  if (error) {
    console.error("[MERMAS] search_active_employees_for_internal_sale failed", error);
    return { data: [], error: "No se pudo cargar trabajadores activos." };
  }

  const employees = (data as InternalSaleEmployeeRpcRow[] | null ?? []).map((employee) => ({
      id: employee.employee_id as string,
      rut: employee.rut as string,
      display_name: [employee.nombres, employee.apellido_paterno, employee.apellido_materno]
        .filter(Boolean)
        .join(" ")
        .trim()
        .toLocaleUpperCase("es-CL"),
      cargo: (employee.cargo as string | null) ?? null,
    }));
  return { data: employees };
}

export async function getInternalSaleWorkerContext(employeeId: string): Promise<{
  data: InternalSaleWorkerContext | null;
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.internal_sale.create");
  if (!/^[0-9a-f-]{36}$/i.test(employeeId)) return { data: null, error: "Trabajador inválido." };

  const [employeeResult, settingsResult, salesResult] = await Promise.all([
    db("mermas").rpc("search_active_employees_for_internal_sale", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_search: null,
      p_limit: 1,
      p_employee_id: employeeId,
    }),
    db("mermas")
      .from("internal_sale_settings")
      .select("worker_monthly_limit_amount")
      .eq("company_id", authorization.companyId)
      .maybeSingle(),
    db("mermas")
      .from("internal_sales")
      .select("total_amount, status, created_at")
      .eq("company_id", authorization.companyId)
      .eq("employee_id", employeeId)
      .neq("status", "REVERSED")
      .limit(10000),
  ]);
  if (employeeResult.error || !employeeResult.data?.[0]) {
    return { data: null, error: "El trabajador seleccionado no está ACTIVO." };
  }
  if (settingsResult.error || salesResult.error) {
    return { data: null, error: "No se pudo cargar el cupo mensual." };
  }

  const employee = employeeResult.data[0];
  const displayName = [employee.nombres, employee.apellido_paterno, employee.apellido_materno]
    .filter(Boolean)
    .join(" ")
    .trim()
    .toLocaleUpperCase("es-CL");
  const currentMonth = todayInSantiago().slice(0, 7);
  const used = (salesResult.data ?? [])
    .filter((sale) => monthKeyInSantiago(sale.created_at as string) === currentMonth)
    .reduce((sum, sale) => sum + Number(sale.total_amount ?? 0), 0);
  const limit = settingsResult.data?.worker_monthly_limit_amount == null
    ? null
    : Number(settingsResult.data.worker_monthly_limit_amount);
  return {
    data: {
      employee: { id: employee.employee_id, rut: employee.rut, display_name: displayName, cargo: employee.cargo },
      monthly_limit: limit,
      monthly_used: used,
      monthly_available: limit === null ? null : Math.max(limit - used, 0),
    },
  };
}

export async function getInternalSaleCatalog(): Promise<{
  data: InternalSaleProduct[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.internal_sale.create");
  const todayPlusFive = addCivilDays(todayInSantiago(), 5);
  const { data, error } = await db("mermas").rpc("get_internal_sale_catalog", {
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_today_plus_five: todayPlusFive,
  });
  if (error) return { data: [], error: "No se pudo cargar el catálogo elegible para venta." };
  return {
    data: (data as Array<{
      bsale_variant_id: number;
      sku: string | null;
      product_name: string | null;
      average_cost: number;
      cost_with_vat: number;
      default_markup_percent: number;
      eligible_stock: number;
      worker_unit_price: number;
      next_eligible_expiration: string;
    }> | null ?? []).map((product) => ({
      bsale_variant_id: Number(product.bsale_variant_id),
      sku: String(product.sku ?? product.bsale_variant_id),
      product_name: String(product.product_name ?? "Producto Bsale"),
      average_cost: Number(product.average_cost),
      cost_with_vat: Number(product.cost_with_vat),
      default_markup_percent: Number(product.default_markup_percent),
      eligible_stock: Number(product.eligible_stock),
      worker_unit_price: Number(product.worker_unit_price),
      next_eligible_expiration: String(product.next_eligible_expiration),
    } satisfies InternalSaleProduct)),
  };
}

export async function getWorkerAccounts(search = ""): Promise<{
  data: WorkerAccount[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.account.view");
  const { data, error } = await db("mermas").rpc("get_worker_accounts", {
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_search: search.trim() || null,
  });
  if (error) {
    console.error("[MERMAS] get_worker_accounts failed", error);
    return { data: [], error: "No se pudo cargar la cuenta corriente." };
  }
  return {
    data: (data as Array<WorkerAccount> | null ?? []).map((row: WorkerAccount) => ({
      ...row,
      total_charges: Number(row.total_charges ?? 0),
      approved_payments: Number(row.approved_payments ?? 0),
      pending_review_payments: Number(row.pending_review_payments ?? 0),
      official_balance: Number(row.official_balance ?? 0),
      projected_balance: Number(row.projected_balance ?? 0),
    })) as WorkerAccount[],
  };
}

export async function getWorkerAccountDetail(employeeId: string): Promise<{
  data: WorkerAccountDetail | null;
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.account.view");
  if (!/^[0-9a-f-]{36}$/i.test(employeeId)) return { data: null, error: "Trabajador inválido." };
  const { data, error } = await db("mermas").rpc("get_worker_account_detail", {
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_employee_id: employeeId,
  });
  if (error) {
    console.error("[MERMAS] get_worker_account_detail failed", error);
    return { data: null, error: "No se pudo cargar el detalle de la cuenta corriente." };
  }
  return { data: data as WorkerAccountDetail | null };
}

export async function getWorkerAccountsV2(search = ""): Promise<{
  data: WorkerAccountV2[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.account.view");
  const { data, error } = await db("mermas").rpc("get_worker_accounts_v2", {
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_search: search.trim() || null,
  });
  if (error) {
    console.error("[MERMAS] get_worker_accounts_v2 failed", error);
    return { data: [], error: "No se pudo cargar la cuenta corriente V2." };
  }
  return {
    data: (data as Array<WorkerAccountV2> | null ?? []).map((row) => ({
      ...row,
      approved_payments: Number(row.approved_payments ?? 0),
      official_balance: Number(row.official_balance ?? 0),
      projected_balance: Number(row.projected_balance ?? 0),
      pending_review_payments: Number(row.pending_review_payments ?? 0),
      merma_balance: Number(row.merma_balance ?? 0),
      bsale_boleta_balance: Number(row.bsale_boleta_balance ?? 0),
      active_charge_count: Number(row.active_charge_count ?? 0),
      open_charge_count: Number(row.open_charge_count ?? 0),
    })),
  };
}

export async function getWorkerBsaleBoletaForRegularization(folio: string): Promise<{
  data: WorkerBsaleBoletaCandidate | null;
  error?: string;
}> {
  try {
    const authorization = await requireMermasSuperUser();
    const documentNumber = Number(folio.trim());
    if (!Number.isInteger(documentNumber) || documentNumber <= 0) {
      return { data: null, error: "Ingresa un folio válido." };
    }
    const { data: documents, error } = await db("integraciones")
      .from("bsale_documents")
      .select("bsale_id, number, emission_date, total_amount, client_id, document_type_id")
      .eq("company_id", authorization.companyId)
      .eq("number", documentNumber)
      .limit(2);
    if (error) throw error;
    if (!documents || documents.length !== 1) return { data: null, error: "No se encontró una Boleta única para ese folio." };
    const document = documents[0] as {
      bsale_id: number;
      number: number;
      emission_date: string | null;
      total_amount: number | string | null;
      client_id: number | null;
      document_type_id: number;
    };
    if (Number(document.document_type_id) !== 1) return { data: null, error: "El documento no es una Boleta." };
    if (document.client_id !== null) return { data: null, error: "La Boleta ya tiene cliente identificado." };
    if (document.total_amount == null || Number(document.total_amount) <= 0) return { data: null, error: "La Boleta no tiene un monto válido." };
    const { count, error: chargeError } = await db("rrhh")
      .from("worker_account_charges")
      .select("id", { count: "exact", head: true })
      .eq("company_id", authorization.companyId)
      .eq("source_type", "BSALE_BOLETA")
      .eq("source_id", String(document.bsale_id));
    if (chargeError) throw chargeError;
    if ((count ?? 0) > 0) return { data: null, error: "La Boleta ya tiene un cargo de cuenta corriente." };
    return {
      data: {
        bsale_id: Number(document.bsale_id),
        document_number: Number(document.number),
        emission_date: document.emission_date,
        total_amount: Number(document.total_amount),
        client_id: document.client_id,
      },
    };
  } catch (error) {
    console.error("[MERMAS] getWorkerBsaleBoletaForRegularization failed", error);
    return { data: null, error: error instanceof Error ? error.message : "No se pudo validar la Boleta." };
  }
}

export async function searchWorkerRegularizationEmployees(search: string): Promise<{
  data: WorkerRegularizationEmployee[];
  error?: string;
}> {
  try {
    await requireMermasSuperUser();
    const { data, error } = await db("rrhh")
      .from("employees")
      .select("id, nombres, apellido_paterno, apellido_materno, rut, cargo")
      .eq("estado", "ACTIVO")
      .order("nombres")
      .limit(200);
    if (error) throw error;
    const normalized = search.trim().toLocaleLowerCase("es-CL").normalize("NFD").replace(/[\u0300-\u036f.\- ]/g, "");
    const employees = (data ?? []).map((employee) => {
      const displayName = [employee.nombres, employee.apellido_paterno, employee.apellido_materno].filter(Boolean).join(" ").trim();
      return {
        id: employee.id as string,
        display_name: displayName.toLocaleUpperCase("es-CL"),
        rut: String(employee.rut ?? ""),
        cargo: (employee.cargo as string | null) ?? null,
        search_value: `${displayName} ${employee.rut ?? ""}`.toLocaleLowerCase("es-CL").normalize("NFD").replace(/[\u0300-\u036f.\- ]/g, ""),
      };
    }).filter((employee) => !normalized || employee.search_value.includes(normalized)).slice(0, 20);
    return {
      data: employees.slice(0, 20).map((employee) => ({
        id: employee.id,
        display_name: employee.display_name,
        rut: employee.rut,
        cargo: employee.cargo,
      })),
    };
  } catch (error) {
    console.error("[MERMAS] searchWorkerRegularizationEmployees failed", error);
    return { data: [], error: error instanceof Error ? error.message : "No se pudo cargar trabajadores activos." };
  }
}

export async function regularizeWorkerBsaleBoleta(input: {
  document_number: number;
  employee_id: string;
  reason: string;
}): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const authorization = await requireMermasSuperUser();
    if (!Number.isInteger(input.document_number) || input.document_number <= 0) return { success: false, error: "El folio es inválido." };
    if (!/^[0-9a-f-]{36}$/i.test(input.employee_id)) return { success: false, error: "El trabajador es inválido." };
    if (!input.reason.trim()) return { success: false, error: "El motivo es obligatorio." };
    const { data, error } = await db("mermas").rpc("regularize_worker_bsale_boleta", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_document_number: input.document_number,
      p_employee_id: input.employee_id,
      p_reason: input.reason.trim(),
    });
    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error("[MERMAS] regularizeWorkerBsaleBoleta failed", error);
    return { success: false, error: error instanceof Error ? error.message : "No se pudo regularizar la Boleta." };
  }
}

export async function getWorkerAccountRegularizationAccess() {
  try {
    await requireMermasSuperUser();
    return true;
  } catch {
    return false;
  }
}

export async function getWorkerAccountDetailV2(employeeId: string): Promise<{
  data: WorkerAccountDetailV2 | null;
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.account.view");
  if (!/^[0-9a-f-]{36}$/i.test(employeeId)) return { data: null, error: "Trabajador inválido." };
  const { data, error } = await db("mermas").rpc("get_worker_account_detail_v2", {
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_employee_id: employeeId,
  });
  if (error) {
    console.error("[MERMAS] get_worker_account_detail_v2 failed", error);
    return { data: null, error: "No se pudo cargar el detalle V2 de la cuenta corriente." };
  }
  return { data: data as WorkerAccountDetailV2 | null };
}

export async function prepareWorkerPaymentUpload(file: {
  employee_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
}): Promise<{ data?: WorkerPaymentUpload; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.create");
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return { error: "No autorizado" };
    if (!/^[0-9a-f-]{36}$/i.test(file.employee_id)) return { error: "Trabajador inválido." };
    if (!MERMA_WORKER_PAYMENT_MIME_TYPES.has(file.mime_type)) return { error: "El comprobante debe ser PDF, JPG o PNG." };
    if (!Number.isInteger(file.size_bytes) || file.size_bytes <= 0 || file.size_bytes > MERMA_WORKER_PAYMENT_MAX_SIZE) return { error: "El comprobante debe pesar entre 1 byte y 10 MB." };
    const safeName = file.file_name.replace(/[^a-zA-Z0-9._-]/g, "_") || "comprobante";
    const uploadId = randomUUID();
    const storagePath = `${authorization.companyId}/${file.employee_id}/pending/${uploadId}/${safeName}`;
    const { data, error } = await db("mermas").storage.from(MERMA_WORKER_PAYMENT_BUCKET).createSignedUploadUrl(storagePath);
    if (error || !data?.signedUrl || !data.token) throw new Error("No se pudo preparar una carga segura.");
    return {
      data: {
        upload_id: uploadId,
        upload_token: data.token,
        validation_token: signMermaEvidenceSession(authorization.companyId, auth.user.id, uploadId, [storagePath]),
        storage_path: storagePath,
        signed_upload_url: data.signedUrl,
        original_filename: safeName,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo preparar el comprobante." };
  }
}

export async function cleanupWorkerPaymentUpload(upload: {
  upload_id: string;
  validation_token: string;
  storage_path: string;
}): Promise<{ success?: boolean; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.create");
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    const expected = signMermaEvidenceSession(authorization.companyId, auth.user?.id ?? "", upload.upload_id, [upload.storage_path]);
    if (!auth.user || !hasValidMermaEvidenceSignature(upload.validation_token, expected) || !upload.storage_path.startsWith(`${authorization.companyId}/`)) return { error: "No autorizado" };
    await db("mermas").storage.from(MERMA_WORKER_PAYMENT_BUCKET).remove([upload.storage_path]);
    return { success: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo limpiar el comprobante." };
  }
}

export async function submitWorkerPayment(input: {
  employee_id: string;
  amount: number;
  upload_id: string;
  validation_token: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
}): Promise<{ success: boolean; data?: { payment_id: string; payment_number: string; amount: number; status: string }; error?: string }> {
  let uploadedPath: string | null = null;
  try {
    const authorization = await requireWmsPermission("logistica.mermas.create");
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return { success: false, error: "No autorizado" };
    if (!/^[0-9a-f-]{36}$/i.test(input.employee_id) || !/^[0-9a-f-]{36}$/i.test(input.upload_id)) return { success: false, error: "Datos del pago inválidos." };
    const expectedToken = signMermaEvidenceSession(authorization.companyId, auth.user.id, input.upload_id, [input.storage_path]);
    const expectedPrefix = `${authorization.companyId}/${input.employee_id}/pending/${input.upload_id}/`;
    if (!hasValidMermaEvidenceSignature(input.validation_token, expectedToken) || !input.storage_path.startsWith(expectedPrefix)) return { success: false, error: "El comprobante no es válido para esta operación." };
    uploadedPath = input.storage_path;
    const cleanup = async () => { await db("mermas").storage.from(MERMA_WORKER_PAYMENT_BUCKET).remove([input.storage_path]); };
    if (!MERMA_WORKER_PAYMENT_MIME_TYPES.has(input.mime_type) || !Number.isInteger(input.size_bytes) || input.size_bytes <= 0 || input.size_bytes > MERMA_WORKER_PAYMENT_MAX_SIZE) { await cleanup(); return { success: false, error: "El comprobante no cumple los requisitos." }; }
    const object = await db("mermas").storage.from(MERMA_WORKER_PAYMENT_BUCKET).info(input.storage_path);
    const metadata = object.data as { size?: number | string; contentType?: string } | null;
    if (object.error || !metadata || Number(metadata.size) !== input.size_bytes || metadata.contentType !== input.mime_type) { await cleanup(); return { success: false, error: "No se pudo validar el comprobante subido." }; }
    const { data, error } = await db("mermas").rpc("submit_worker_payment", {
      p_company_id: authorization.companyId,
      p_user_id: auth.user.id,
      p_employee_id: input.employee_id,
      p_amount: input.amount,
      p_upload_id: input.upload_id,
      p_storage_path: input.storage_path,
      p_original_filename: input.original_filename,
      p_mime_type: input.mime_type,
      p_size_bytes: input.size_bytes,
    });
    if (error) { await cleanup(); return { success: false, error: error.message.includes("saldo disponible") ? "El saldo disponible cambió. Actualiza la cuenta e inténtalo nuevamente." : error.message }; }
    return { success: true, data: data as { payment_id: string; payment_number: string; amount: number; status: string } };
  } catch (error) {
    if (uploadedPath) await db("mermas").storage.from(MERMA_WORKER_PAYMENT_BUCKET).remove([uploadedPath]);
    return { success: false, error: error instanceof Error ? error.message : "No se pudo registrar el pago." };
  }
}

export async function voidWorkerPayment(paymentId: string, reason: string): Promise<{ success: boolean; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.authorize");
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return { success: false, error: "Pago inválido." };
    const cleanReason = reason.trim();
    if (!cleanReason) return { success: false, error: "El motivo de anulación es obligatorio." };
    const { error } = await db("mermas").rpc("void_worker_payment", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_payment_id: paymentId,
      p_reason: cleanReason,
    });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "No se pudo anular el pago." };
  }
}

async function requireWorkerPaymentReviewer() {
  return requireMermasSuperUser();
}

async function requireMermasSuperUser() {
  const authorization = await requireWmsPermission("logistica.mermas.view");
  const { data, error } = await db("portal").rpc("is_super_usuario", { p_user_id: authorization.user.id });
  if (error || data !== true) throw new Error("Se requiere rol SUPER_USUARIO.");
  return authorization;
}

export async function getWorkerPaymentReviewAccess() {
  try {
    await requireWorkerPaymentReviewer();
    return true;
  } catch {
    return false;
  }
}

export async function getMermasBootstrap(): Promise<MermasBootstrap> {
  const authorization = await requireWmsPermission("logistica.mermas.view");
  const supabase = await createClient();
  const permissionCodes = [
    "logistica.mermas.create",
    "logistica.mermas.request.create",
    "logistica.mermas.account.view",
    "logistica.mermas.internal_sale.create",
    "logistica.mermas.authorize",
    "logistica.mermas.sync",
    "logistica.mermas.warehouse.view",
    "logistica.mermas.pending.view",
  ] as const;
  const permissionResults = await Promise.all(
    permissionCodes.map(async (permissionCode) => {
      const { data, error } = await supabase.rpc("has_permission", {
        p_permission_code: permissionCode,
      });
      return [permissionCode, !error && data === true] as const;
    }),
  );
  const permissions = Object.fromEntries(permissionResults) as Record<
    (typeof permissionCodes)[number],
    boolean
  >;
  const [{ data: isSuperUser, error: superUserError }, { data: setting, error: settingError }] =
    await Promise.all([
      db("portal").rpc("is_super_usuario", { p_user_id: authorization.user.id }),
      db("mermas")
        .from("internal_sale_settings")
        .select("id, worker_markup_percent, worker_monthly_limit_amount, updated_at, updated_by")
        .eq("company_id", authorization.companyId)
        .maybeSingle(),
    ]);
  const superUser = !superUserError && isSuperUser === true;
  const canViewPendingCount = permissions["logistica.mermas.pending.view"];
  const { count: pendingCount } = canViewPendingCount
    ? await db("mermas")
        .from("requests")
        .select("id", { count: "exact", head: true })
        .eq("company_id", authorization.companyId)
        .eq("status", "PENDIENTE")
    : { count: 0 };
  const pricingSettings: MermaPricingSettings = {
    id: setting?.id ?? null,
    worker_markup_percent: setting?.worker_markup_percent == null ? null : Number(setting.worker_markup_percent),
    worker_monthly_limit_amount: setting?.worker_monthly_limit_amount == null ? null : Number(setting.worker_monthly_limit_amount),
    updated_at: setting?.updated_at ?? null,
    updated_by: setting?.updated_by ?? null,
    can_edit: superUser && !settingError,
  };
  return {
    userId: authorization.user.id,
    companyId: authorization.companyId,
    companyName: authorization.companyName,
    canView: true,
    canCreate: permissions["logistica.mermas.create"],
    canCreateRequest: permissions["logistica.mermas.request.create"],
    canAuthorize: permissions["logistica.mermas.authorize"],
    canSync: permissions["logistica.mermas.sync"],
    canUseInternalSale: permissions["logistica.mermas.internal_sale.create"],
    isSuperUser: superUser,
    canReviewPayments: superUser,
    canViewAccounts: permissions["logistica.mermas.account.view"],
    canEditSettings: superUser && !settingError,
    canViewWarehouse: permissions["logistica.mermas.warehouse.view"],
    canViewPendingCount,
    pricingSettings,
    pendingCount: pendingCount ?? 0,
  };
}

export async function getWorkerPaymentsForReview(): Promise<{ data: WorkerPaymentReview[]; error?: string }> {
  try {
    const authorization = await requireWorkerPaymentReviewer();
    const { data, error } = await db("mermas").rpc("get_worker_payments_for_review", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_status: "PENDING_REVIEW",
    });
    if (error) throw error;
    return { data: (data ?? []).map((row: WorkerPaymentReview) => ({ ...row, amount: Number(row.amount), size_bytes: Number(row.size_bytes) })) };
  } catch (error) {
    console.error("[MERMAS] get_worker_payments_for_review failed", error);
    return { data: [], error: error instanceof Error ? error.message : "No se pudo cargar la revisión de pagos." };
  }
}

export async function getWorkerPaymentReviewDetail(paymentId: string): Promise<{ data: WorkerPaymentReviewDetail | null; error?: string }> {
  try {
    const authorization = await requireWorkerPaymentReviewer();
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return { data: null, error: "Pago inválido." };
    const { data, error } = await db("mermas").rpc("get_worker_payment_review_detail", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_payment_id: paymentId,
    });
    if (error) throw error;
    return { data: data as WorkerPaymentReviewDetail | null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "No se pudo cargar el detalle del pago." };
  }
}

export async function getWorkerPaymentEvidenceUrl(paymentId: string): Promise<{ url?: string; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.account.view");
    if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return { error: "Pago inválido." };
    const { data: payment, error: paymentError } = await db("mermas").from("worker_payments")
      .select("id").eq("id", paymentId).eq("company_id", authorization.companyId).maybeSingle();
    if (paymentError || !payment) return { error: "Pago no encontrado." };
    const { data: evidence, error } = await db("mermas").from("worker_payment_evidence")
      .select("storage_path").eq("company_id", authorization.companyId).eq("payment_id", paymentId).maybeSingle();
    if (error || !evidence) return { error: "Comprobante no encontrado." };
    const { data: signed, error: signedError } = await db("mermas").storage.from(MERMA_WORKER_PAYMENT_BUCKET).createSignedUrl(evidence.storage_path, 300);
    if (signedError || !signed?.signedUrl) return { error: "No se pudo generar el acceso temporal al comprobante." };
    return { url: signed.signedUrl };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "No se pudo abrir el comprobante." };
  }
}

export async function approveWorkerPayment(paymentId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const authorization = await requireWorkerPaymentReviewer();
    const { error } = await db("mermas").rpc("approve_worker_payment", {
      p_company_id: authorization.companyId, p_user_id: authorization.user.id, p_payment_id: paymentId,
    });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "No se pudo aprobar el pago." };
  }
}

export async function rejectWorkerPayment(paymentId: string, reason: string): Promise<{ success: boolean; error?: string }> {
  try {
    const authorization = await requireWorkerPaymentReviewer();
    const cleanReason = reason.trim();
    if (!cleanReason) return { success: false, error: "El motivo del rechazo es obligatorio." };
    const { error } = await db("mermas").rpc("reject_worker_payment", {
      p_company_id: authorization.companyId, p_user_id: authorization.user.id, p_payment_id: paymentId, p_reason: cleanReason,
    });
    if (error) throw error;
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "No se pudo rechazar el pago." };
  }
}

export async function createInternalSale(
  employeeId: string,
  items: Array<{ bsale_variant_id: number; quantity: number; unit_price?: number | null }>,
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.internal_sale.create");
    if (!/^[0-9a-f-]{36}$/i.test(employeeId) || !Array.isArray(items) || items.length === 0) {
      return { success: false, error: "Selecciona un trabajador y al menos un producto." };
    }
    const cleanItems = items.map((item) => ({
      bsale_variant_id: Number(item.bsale_variant_id),
      quantity: Number(item.quantity),
      unit_price: item.unit_price == null ? null : Number(item.unit_price),
    }));
    if (cleanItems.some((item) => !Number.isInteger(item.bsale_variant_id) || item.bsale_variant_id <= 0 || !Number.isFinite(item.quantity) || item.quantity <= 0 || (item.unit_price !== null && (!Number.isInteger(item.unit_price) || item.unit_price <= 0)))) {
      return { success: false, error: "Revisa las cantidades y precios unitarios ingresados." };
    }
    const { data, error } = await db("mermas").rpc("create_internal_sale", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_employee_id: employeeId,
      p_items: cleanItems,
    });
    if (error) return { success: false, error: internalSaleErrorMessage(error.message) };
    return { success: true, data: (data ?? {}) as Record<string, unknown> };
  } catch (error) {
    return { success: false, error: internalSaleErrorMessage(error instanceof Error ? error.message : "") };
  }
}

export async function getInternalSaleForPrint(saleId: string): Promise<{
  data: InternalSalePrintData | null;
  error?: string;
}> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.internal_sale.create");
    if (!/^[0-9a-f-]{36}$/i.test(saleId)) {
      return { data: null, error: "La venta solicitada no es válida." };
    }

    const { data: sale, error: saleError } = await db("mermas")
      .from("internal_sales")
      .select("id, sale_number, employee_name_snapshot, employee_rut_snapshot, status, total_amount, created_at, responsible_user_id")
      .eq("company_id", authorization.companyId)
      .eq("id", saleId)
      .maybeSingle();
    if (saleError) throw saleError;
    if (!sale || sale.status === "REVERSED") {
      return { data: null, error: "La venta no existe o no está disponible para impresión." };
    }

    const { data: lines, error: linesError } = await db("mermas")
      .from("internal_sale_lines")
      .select("id, sku_snapshot, product_name_snapshot, quantity, worker_unit_price_snapshot, line_total")
      .eq("company_id", authorization.companyId)
      .eq("sale_id", saleId)
      .order("created_at", { ascending: true });
    if (linesError) throw linesError;

    const lineIds = (lines ?? []).map((line) => line.id as string);
    const { data: lots, error: lotsError } = lineIds.length
      ? await db("mermas")
          .from("internal_sale_lot_allocations")
          .select("sale_line_id, quantity, expiration_date, lot")
          .eq("company_id", authorization.companyId)
          .eq("sale_id", saleId)
          .in("sale_line_id", lineIds)
          .order("created_at", { ascending: true })
      : { data: [], error: null };
    if (lotsError) throw lotsError;

    return {
      data: {
        id: sale.id as string,
        sale_number: sale.sale_number as string,
        employee_name_snapshot: sale.employee_name_snapshot as string,
        employee_rut_snapshot: sale.employee_rut_snapshot as string,
        status: sale.status as string,
        total_amount: Number(sale.total_amount),
        created_at: sale.created_at as string,
        responsible_user_id: sale.responsible_user_id as string,
        lines: (lines ?? []).map((line) => ({
          id: line.id as string,
          sku_snapshot: line.sku_snapshot as string,
          product_name_snapshot: line.product_name_snapshot as string,
          quantity: Number(line.quantity),
          worker_unit_price_snapshot: Number(line.worker_unit_price_snapshot),
          line_total: Number(line.line_total),
          lots: (lots ?? [])
            .filter((lot) => lot.sale_line_id === line.id)
            .map((lot) => ({
              quantity: Number(lot.quantity),
              expiration_date: lot.expiration_date as string | null,
              lot: lot.lot as string | null,
            })),
        })),
      },
    };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "No se pudo cargar la venta registrada.",
    };
  }
}

export async function getMermasPricingSettings(): Promise<{
  data: MermaPricingSettings;
  error?: string;
}> {
  const authorization = await requireMermasSuperUser();
  const { data: setting, error } = await db("mermas")
    .from("internal_sale_settings")
    .select("id, worker_markup_percent, worker_monthly_limit_amount, updated_at, updated_by")
    .eq("company_id", authorization.companyId)
    .maybeSingle();
  if (error) {
    return {
      data: { id: null, worker_markup_percent: null, worker_monthly_limit_amount: null, updated_at: null, updated_by: null, can_edit: false },
      error: "No se pudo cargar la configuración de precio",
    };
  }
  return {
    data: {
      id: setting?.id ?? null,
      worker_markup_percent: setting?.worker_markup_percent === null || setting?.worker_markup_percent === undefined ? null : Number(setting.worker_markup_percent),
      worker_monthly_limit_amount: setting?.worker_monthly_limit_amount === null || setting?.worker_monthly_limit_amount === undefined ? null : Number(setting.worker_monthly_limit_amount),
      updated_at: setting?.updated_at ?? null,
      updated_by: setting?.updated_by ?? null,
       can_edit: true,
    },
  };
}

export async function saveMermasPricingSettings(
  value: number | string | null,
  monthlyLimit: number | string | null,
): Promise<{
  success: boolean;
  data?: MermaPricingSettings;
  error?: string;
}> {
  const authorization = await requireMermasSuperUser();
  const markup = value === null || value === "" ? null : Number(value);
  const limit = monthlyLimit === null || monthlyLimit === "" ? null : Number(monthlyLimit);
  if (markup !== null && (!Number.isFinite(markup) || markup < 0)) {
    return { success: false, error: "Ingresa un porcentaje válido igual o mayor que 0." };
  }
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    return { success: false, error: "El tope mensual debe ser un monto entero mayor que 0." };
  }
  const { data, error } = await db("mermas").rpc("save_internal_sale_settings", {
    p_company_id: authorization.companyId,
    p_user_id: authorization.user.id,
    p_worker_markup_percent: markup,
    p_worker_monthly_limit_amount: limit,
  });
  if (error) return { success: false, error: error.message };
  return {
    success: true,
    data: {
      id: data.id,
      worker_markup_percent: data.worker_markup_percent === null ? null : Number(data.worker_markup_percent),
      worker_monthly_limit_amount: data.worker_monthly_limit_amount === null ? null : Number(data.worker_monthly_limit_amount),
      updated_at: data.updated_at,
      updated_by: data.updated_by,
      can_edit: true,
    },
  };
}

export async function getMermasProductsCatalog(): Promise<{
  data: MermaProduct[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.request.create");
  const productsDb = db("adquisiciones");
  const integrationDb = db("integraciones");
  const products: Array<{
    id: string;
    sku: string;
    barcode: string | null;
    description: string | null;
    bsale_variant_id: number;
    bsale_product_classification: number | null;
  }> = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await productsDb
      .from("products")
      .select("id, sku, barcode, description, bsale_variant_id, bsale_product_classification")
      .eq("company_id", authorization.companyId)
      .eq("is_active", true)
      .eq("status", "ACTIVE")
      .eq("bsale_variant_state", 0)
      .not("bsale_variant_id", "is", null)
      .order("sku")
      .range(offset, offset + pageSize - 1);
    if (error)
      return { data: [], error: "No se pudo cargar el catálogo operativo" };
    products.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
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
    data: products.map((product) => ({
      id: product.id,
      bsale_id: product.bsale_variant_id,
      sku: product.sku,
      barcode: product.barcode,
      description: product.description,
      product_name: product.description,
      is_pack: product.bsale_product_classification === 3,
      stock_available: stockByVariant.get(product.bsale_variant_id)?.validRows
        ? stockByVariant.get(product.bsale_variant_id)!.total
        : null,
      stock_last_synced_at:
        stockByVariant.get(product.bsale_variant_id)?.lastSyncedAt ?? null,
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
  const authorization = await requireWmsPermission("logistica.mermas.request.create");
  const term = search.trim();
  if (term.length < 2) return { data: [] };
  const query = db("adquisiciones")
    .from("products")
    .select("id, sku, barcode, description, bsale_variant_id, bsale_product_classification")
    .eq("company_id", authorization.companyId)
    .eq("is_active", true)
    .eq("status", "ACTIVE")
    .eq("bsale_variant_state", 0)
    .not("bsale_variant_id", "is", null)
    .or(
      `sku.ilike.%${term}%,barcode.ilike.%${term}%,description.ilike.%${term}%`,
    )
    .order("sku")
    .limit(20);
  const { data: products, error } = await query;
  if (error)
    return { data: [], error: "No se pudo consultar el catálogo operativo" };
  return {
    data: (products ?? []).map((product) => ({
      id: product.id,
      bsale_id: product.bsale_variant_id,
      sku: product.sku,
      barcode: product.barcode,
      description: product.description,
      product_name: product.description,
      is_pack: product.bsale_product_classification === 3,
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
  const authorization = await requireWmsPermission("logistica.mermas.create");
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
  average_cost: number | null;
  cost_with_vat: number | null;
  worker_price: number | null;
  next_expiration: string | null;
  expiration_status: "VENCIDO" | "POR VENCER" | "VIGENTE";
  lot_count: number;
  last_entry_at: string | null;
  lots: MermaWarehouseLot[];
  history: MermaWarehouseHistoryEntry[];
};

export type MermaWarehouseListProduct = Omit<MermaWarehouseProduct, "lots" | "history">;

export type MermaStockExitItem = {
  bsale_variant_id: number;
  quantity: number;
};

export type MermaStockExitOperation = {
  operation_id: string;
  created_at: string;
  operation_type: "DESTRUCCION" | "REGULACION" | "REVERSA";
  status: "VIGENTE" | "CORREGIDA";
  reason: string;
  observation: string | null;
  created_by: string;
  created_by_name: string;
  total_units: number;
  product_count: number;
  corrects_operation_id: string | null;
  reverses_operation_id: string | null;
};

export type MermaStockExitOperationProduct = {
  variant_id: number;
  sku: string;
  product_name: string;
  quantity: number;
  movement_count: number;
};

export type MermaStockExitOperationMovement = {
  movement_id: string;
  movement_type: string;
  variant_id: number;
  quantity: number;
  quantity_absolute: number;
  expiration_date: string | null;
  lot: string | null;
  request_id: string | null;
  source: string;
  authorization_status: string;
  created_by: string | null;
  created_at: string;
};

export type MermaStockExitOperationDetail = Omit<
  MermaStockExitOperation,
  "total_units" | "product_count"
> & {
  company_id: string;
  corrected_by: string | null;
  corrected_at: string | null;
  correction_reason: string | null;
  products: MermaStockExitOperationProduct[];
  movements: MermaStockExitOperationMovement[];
};

export async function getMermaWarehouseEvidence(variantId: number): Promise<{
  data: Array<{ movement_id: string; evidence: MermaEvidence[] }>;
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.warehouse.view");
  if (!Number.isInteger(variantId) || variantId <= 0) return { data: [], error: "Producto inválido" };
  const database = db("mermas");
  const { data: movements, error: movementsError } = await database
    .from("movements")
    .select("id, request_line_id")
    .eq("company_id", authorization.companyId)
    .eq("variant_id", variantId)
    .not("request_line_id", "is", null);
  if (movementsError) return { data: [], error: "No se pudo cargar la evidencia de Bodega" };
  const lineIds = [...new Set((movements ?? []).map((movement) => movement.request_line_id).filter(Boolean))];
  if (!lineIds.length) return { data: [] };
  const { data: evidenceRows, error: evidenceError } = await database
    .from("evidence")
    .select("id, request_line_id, file_name, mime_type, storage_path")
    .eq("company_id", authorization.companyId)
    .in("request_line_id", lineIds);
  if (evidenceError) return { data: [], error: "No se pudo cargar la evidencia de Bodega" };
  const evidenceByLine = new Map<string, MermaEvidence[]>();
  for (const row of evidenceRows ?? []) {
    const { data: signed } = await database.storage
      .from("mermas-evidence")
      .createSignedUrl(row.storage_path, 300);
    if (!signed?.signedUrl) continue;
    const current = evidenceByLine.get(row.request_line_id) ?? [];
    current.push({ id: row.id, file_name: row.file_name, mime_type: row.mime_type, signed_url: signed.signedUrl });
    evidenceByLine.set(row.request_line_id, current);
  }
  return {
    data: (movements ?? []).map((movement) => ({
      movement_id: movement.id,
      evidence: evidenceByLine.get(movement.request_line_id) ?? [],
    })),
  };
}

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
  const authorization = await requireWmsPermission("logistica.mermas.authorize");
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
  const variants = [
    ...new Set((movements ?? []).map((item) => Number(item.variant_id))),
  ];
  const [{ data: lines }, { data: requests }, { data: evidence }, { data: variantRows }] = await Promise.all([
    lineIds.length
      ? database.from("request_lines").select("id, reason").in("id", lineIds)
      : Promise.resolve({ data: [] as { id: string; reason: string }[] }),
    requestIds.length
      ? database.from("requests").select("id, request_code, created_at, created_by").in("id", requestIds)
      : Promise.resolve({ data: [] as { id: string; request_code: string; created_at: string; created_by: string }[] }),
    lineIds.length
      ? database.from("evidence").select("request_line_id").in("request_line_id", lineIds)
      : Promise.resolve({ data: [] as { request_line_id: string }[] }),
    variants.length
      ? db("integraciones").from("bsale_variants").select("bsale_id, code, bsale_product_id").eq("company_id", authorization.companyId).in("bsale_id", variants)
      : Promise.resolve({ data: [] as { bsale_id: number; code: string; bsale_product_id: number }[] }),
  ]);
  const userIds = [...new Set((requests ?? []).map((item) => item.created_by))];
  const productIds = [...new Set((variantRows ?? []).map((item) => item.bsale_product_id))];
  const [{ data: users }, { data: products }] = await Promise.all([
    userIds.length
      ? db("portal").from("users").select("id, nombre, apellido").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; nombre: string; apellido: string }[] }),
    productIds.length
      ? db("integraciones").from("bsale_products").select("bsale_id, name").eq("company_id", authorization.companyId).in("bsale_id", productIds)
      : Promise.resolve({ data: [] as { bsale_id: number; name: string }[] }),
  ]);
  const lineMap = new Map((lines ?? []).map((item) => [item.id, item]));
  const requestMap = new Map((requests ?? []).map((item) => [item.id, item]));
  const userMap = new Map(
    (users ?? []).map((item) => [
      item.id,
      `${item.nombre ?? ""} ${item.apellido ?? ""}`.trim(),
    ]),
  );
  const evidenceCount = new Map<string, number>();
  for (const item of evidence ?? [])
    evidenceCount.set(
      item.request_line_id,
      (evidenceCount.get(item.request_line_id) ?? 0) + 1,
    );
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
  const authorization = await requireWmsPermission("logistica.mermas.view");
  const database = db("mermas");
  const { data: rawMovement, error: movementError } = await database
    .from("movements")
    .select("id, variant_id, quantity, expiration_date, lot, source, request_id, request_line_id, consumption_id, created_at, authorization_status, rejected_by, rejected_at, rejection_reason")
    .eq("company_id", authorization.companyId)
    .eq("id", movementId)
    .maybeSingle();
  if (movementError || !rawMovement)
    return { data: null, error: "Entrada no encontrada o ya autorizada" };
  if (rawMovement.authorization_status === "PENDIENTE_AUTORIZACION") {
    await requireWmsPermission("logistica.mermas.authorize");
  }

  const [{ data: line }, { data: request }, { data: variant }, { data: evidenceRows }, { data: consumption }] = await Promise.all([
    rawMovement.request_line_id
      ? database.from("request_lines").select("id, reason").eq("id", rawMovement.request_line_id).maybeSingle()
      : Promise.resolve({ data: null as { id: string; reason: string | null } | null }),
    rawMovement.request_id
      ? database.from("requests").select("id, request_code, created_at, created_by").eq("id", rawMovement.request_id).maybeSingle()
      : Promise.resolve({ data: null as { id: string; request_code: string | null; created_at: string | null; created_by: string } | null }),
    db("integraciones").from("bsale_variants").select("bsale_id, code, bsale_product_id").eq("company_id", authorization.companyId).eq("bsale_id", Number(rawMovement.variant_id)).maybeSingle(),
    rawMovement.request_line_id
      ? database.from("evidence").select("id, storage_path, file_name, mime_type").eq("company_id", authorization.companyId).eq("request_line_id", rawMovement.request_line_id)
      : Promise.resolve({ data: [] as { id: string; storage_path: string; file_name: string; mime_type: string }[] }),
    rawMovement.consumption_id
      ? database.from("bsale_consumptions").select("consumption_id, consumption_date, note").eq("consumption_id", rawMovement.consumption_id).maybeSingle()
      : Promise.resolve({ data: null as { consumption_id: number; consumption_date: string | null; note: string | null } | null }),
  ]);
  const [{ data: product }, { data: users }] = await Promise.all([
    variant?.bsale_product_id
      ? db("integraciones").from("bsale_products").select("bsale_id, name").eq("company_id", authorization.companyId).eq("bsale_id", variant.bsale_product_id).maybeSingle()
      : Promise.resolve({ data: null as { bsale_id: number; name: string | null } | null }),
    request || rawMovement.rejected_by
      ? db("portal").from("users").select("id, nombre, apellido").in("id", [request?.created_by, rawMovement.rejected_by].filter(Boolean))
      : Promise.resolve({ data: [] as { id: string; nombre: string | null; apellido: string | null }[] }),
  ]);
  const userMap = new Map((users ?? []).map((item) => [item.id, `${item.nombre ?? ""} ${item.apellido ?? ""}`.trim()]));
  const evidence = (await Promise.all((evidenceRows ?? []).map(async (row) => {
    const { data: signed } = await database.storage.from("mermas-evidence").createSignedUrl(row.storage_path, 300);
    return signed?.signedUrl
      ? { id: row.id, file_name: row.file_name, mime_type: row.mime_type, signed_url: signed.signedUrl }
      : null;
  }))).filter((item): item is MermaEvidence => item !== null);
  const movement = {
    movement_id: rawMovement.id,
    id: rawMovement.id,
    request_line_id: rawMovement.request_line_id,
    consumption_id: rawMovement.consumption_id,
    sku: variant?.code ?? `BS-${rawMovement.variant_id}`,
    product_name: product?.name ?? "Producto Bsale",
    available: Number(rawMovement.quantity),
    expiration_date: rawMovement.expiration_date,
    lot: rawMovement.lot,
    origin: rawMovement.source,
    request_code: request?.request_code ?? null,
    entered_at: rawMovement.created_at,
    reason: line?.reason ?? null,
    requester_name: request ? (userMap.get(request.created_by) ?? "Usuario") : null,
    request_date: request?.created_at ?? null,
    evidence_count: evidence.length,
    authorization_status: rawMovement.authorization_status,
    rejection_reason: rawMovement.rejection_reason ?? "",
    rejected_by_name: rawMovement.rejected_by ? userMap.get(rawMovement.rejected_by) ?? null : null,
    rejected_at: rawMovement.rejected_at ?? "",
    consumption_date: consumption?.consumption_date ?? null,
    note: consumption?.note ?? null,
    original_reason: line?.reason ?? null,
  } as MermaAuthorizationRow;
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
  const requestIds = [...new Set((movements ?? []).map((item) => item.request_id).filter(Boolean))];
  const variantIds = [...new Set((movements ?? []).map((item) => Number(item.variant_id)))];
  const [{ data: requests }, { data: variantRows }] = await Promise.all([
    requestIds.length ? database.from("requests").select("id, request_code, created_at, created_by").in("id", requestIds) : Promise.resolve({ data: [] as { id: string; request_code: string; created_at: string; created_by: string }[] }),
    variantIds.length ? db("integraciones").from("bsale_variants").select("bsale_id, code, bsale_product_id").eq("company_id", authorization.companyId).in("bsale_id", variantIds) : Promise.resolve({ data: [] as { bsale_id: number; code: string | null; bsale_product_id: number }[] }),
  ]);
  const userIds = [...new Set((requests ?? []).map((item) => item.created_by).concat((movements ?? []).map((item) => item.rejected_by).filter(Boolean)))];
  const productIds = [...new Set((variantRows ?? []).map((item) => item.bsale_product_id))];
  const [{ data: users }, { data: products }] = await Promise.all([
    userIds.length
      ? db("portal").from("users").select("id, nombre, apellido").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; nombre: string | null; apellido: string | null }[] }),
    productIds.length
      ? db("integraciones").from("bsale_products").select("bsale_id, name").eq("company_id", authorization.companyId).in("bsale_id", productIds)
      : Promise.resolve({ data: [] as { bsale_id: number; name: string | null }[] }),
  ]);
  const requestMap = new Map((requests ?? []).map((item) => [item.id, item]));
  const userMap = new Map((users ?? []).map((item) => [item.id, `${item.nombre ?? ""} ${item.apellido ?? ""}`.trim()]));
  const variantMap = new Map((variantRows ?? []).map((item) => [item.bsale_id, item]));
  const productMap = new Map((products ?? []).map((item) => [item.bsale_id, item.name]));
  return {
    data: (movements ?? []).map((item) => {
       const request = requestMap.get(item.request_id);
       const variant = variantMap.get(Number(item.variant_id));
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
         reason: null,
        requester_name: request ? (userMap.get(request.created_by) ?? "Usuario") : null,
        request_date: request?.created_at ?? null,
         evidence_count: 0,
        rejection_reason: item.rejection_reason,
        rejected_by_name: item.rejected_by ? userMap.get(item.rejected_by) ?? null : null,
        rejected_at: item.rejected_at,
         consumption_date: null,
         note: null,
         original_reason: null,
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
  data: MermaWarehouseListProduct[];
  error?: string;
}> {
  const authorization = await requireWmsPermission("logistica.mermas.warehouse.view");
  const database = db("mermas");
  const { data: stockRows, error } = await database
    .from("stock_current")
    .select("variant_id, available, expiration_date, entered_at")
    .eq("company_id", authorization.companyId)
    .order("entered_at", { ascending: false });
  if (error) return { data: [], error: "No se pudo cargar la Bodega de Mermas" };
  const variantIds = [...new Set((stockRows ?? []).map((row) => Number(row.variant_id)))];
  const productsDb = db("adquisiciones");
  const [{ data: productRows }, costResult, { data: setting }] = await Promise.all([
    variantIds.length
      ? productsDb.from("products").select("bsale_variant_id, sku, description").eq("company_id", authorization.companyId).eq("is_active", true).eq("status", "ACTIVE").in("bsale_variant_id", variantIds)
      : Promise.resolve({ data: [] as { bsale_variant_id: number; sku: string | null; description: string | null }[] }),
    variantIds.length
      ? database.rpc("get_internal_sale_costs", { p_company_id: authorization.companyId, p_variant_ids: variantIds })
      : Promise.resolve({ data: [] as { variant_id: number; average_cost: number | null }[] }),
    database.from("internal_sale_settings").select("worker_markup_percent").eq("company_id", authorization.companyId).maybeSingle(),
  ]);
  const costRows = (costResult.data as Array<{ variant_id: number; average_cost: number | null }> | null) ?? [];
  const productMap = new Map((productRows ?? []).map((product) => [Number(product.bsale_variant_id), product]));
  const costMap = new Map((costRows ?? []).map((row) => {
    const cost = Number(row.average_cost);
    return [Number(row.variant_id), Number.isFinite(cost) && cost > 0 ? cost : null] as const;
  }));
  const today = new Date().toISOString().slice(0, 10);
  const warningDate = new Date(`${today}T00:00:00Z`);
  warningDate.setUTCDate(warningDate.getUTCDate() + 30);
  const getExpirationStatus = (date: string | null): MermaWarehouseListProduct["expiration_status"] => {
    if (date && date < today) return "VENCIDO";
    if (date && date <= warningDate.toISOString().slice(0, 10)) return "POR VENCER";
    return "VIGENTE";
  };
  const products = new Map<number, MermaWarehouseListProduct>();
  for (const stock of stockRows ?? []) {
    if (Number(stock.available) <= 0) continue;
    const variantId = Number(stock.variant_id);
    const product = productMap.get(variantId);
    const current = products.get(variantId) ?? {
      variant_id: variantId,
      sku: product?.sku ?? `BS-${variantId}`,
      product_name: product?.description ?? "Producto Bsale",
      available: 0,
      average_cost: costMap.get(variantId) ?? null,
      cost_with_vat: calculateCostWithVat(costMap.get(variantId)),
      worker_price: calculateWorkerPrice(costMap.get(variantId), setting?.worker_markup_percent == null ? null : Number(setting.worker_markup_percent)),
      next_expiration: null,
      expiration_status: "VIGENTE" as const,
      lot_count: 0,
      last_entry_at: null,
    };
    current.available += Number(stock.available);
    current.lot_count += 1;
    if (stock.expiration_date && (!current.next_expiration || stock.expiration_date < current.next_expiration)) current.next_expiration = stock.expiration_date;
    if (!current.last_entry_at || stock.entered_at > current.last_entry_at) current.last_entry_at = stock.entered_at;
    current.expiration_status = getExpirationStatus(current.next_expiration);
    products.set(variantId, current);
  }
  return { data: [...products.values()] };
}

export async function getMermasStockExitAccess() {
  try {
    await requireMermasSuperUser();
    return true;
  } catch {
    return false;
  }
}

export async function getMermasStockExitCatalog(): Promise<{
  data: MermaWarehouseListProduct[];
  error?: string;
}> {
  try {
    await requireMermasSuperUser();
    return getMermasWarehouse();
  } catch (error) {
    return { data: [], error: error instanceof Error ? error.message : "No se pudo cargar el stock de Mermas." };
  }
}

export async function createMermasStockExit(
  movementType: "SALIDA_DESTRUCCION" | "SALIDA_REGULACION",
  reason: string,
  observation: string,
  items: MermaStockExitItem[],
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    const authorization = await requireMermasSuperUser();
    const cleanReason = reason.trim();
    if (!cleanReason) return { success: false, error: "El motivo de la salida es obligatorio." };
    if (!Array.isArray(items) || items.length === 0) return { success: false, error: "Agrega al menos un producto." };
    const cleanItems = items.map((item) => ({
      bsale_variant_id: Number(item.bsale_variant_id),
      quantity: Number(item.quantity),
    }));
    if (cleanItems.some((item) => !Number.isInteger(item.bsale_variant_id) || item.bsale_variant_id <= 0 || !Number.isFinite(item.quantity) || item.quantity <= 0)) {
      return { success: false, error: "Revisa las cantidades ingresadas." };
    }
    const { data, error } = await db("mermas").rpc("create_stock_exit", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_movement_type: movementType,
      p_reason: cleanReason,
      p_observation: observation.trim() || null,
      p_items: cleanItems,
    });
    if (error) {
      if (error.message.toLocaleLowerCase("es-CL").includes("stock insuficiente")) {
        return { success: false, error: "El stock disponible cambió y no alcanza para la salida. Actualiza la disponibilidad." };
      }
      return { success: false, error: error.message };
    }
    return { success: true, data: (data ?? {}) as Record<string, unknown> };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "No se pudo registrar la salida." };
  }
}

export async function getMermasStockExitOperations(): Promise<{
  data: MermaStockExitOperation[];
  error?: string;
}> {
  try {
    const authorization = await requireMermasSuperUser();
    const { data, error } = await db("mermas").rpc("get_stock_exit_operations", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_limit: 500,
      p_offset: 0,
    });
    if (error) return { data: [], error: error.message };
    return {
      data: (data ?? []).map((row: MermaStockExitOperation) => ({
        ...row,
        total_units: Number(row.total_units),
        product_count: Number(row.product_count),
      })),
    };
  } catch (error) {
    return { data: [], error: error instanceof Error ? error.message : "No se pudo cargar el historial de salidas." };
  }
}

export async function getMermasStockExitOperationDetail(
  operationId: string,
): Promise<{ data: MermaStockExitOperationDetail | null; error?: string }> {
  try {
    const authorization = await requireMermasSuperUser();
    const { data, error } = await db("mermas").rpc("get_stock_exit_operation_detail", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_operation_id: operationId,
    });
    if (error) return { data: null, error: error.message };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { data: null, error: "No se encontró la operación." };
    return {
      data: {
        ...row,
        products: (row.products ?? []).map((product: MermaStockExitOperationProduct) => ({
          ...product,
          variant_id: Number(product.variant_id),
          quantity: Number(product.quantity),
          movement_count: Number(product.movement_count),
        })),
        movements: (row.movements ?? []).map((movement: MermaStockExitOperationMovement) => ({
          ...movement,
          variant_id: Number(movement.variant_id),
          quantity: Number(movement.quantity),
          quantity_absolute: Number(movement.quantity_absolute),
        })),
      } as MermaStockExitOperationDetail,
    };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "No se pudo cargar el detalle de la salida." };
  }
}

export async function correctMermasStockExit(
  originalOperationId: string,
  correctionReason: string,
  operationType: "DESTRUCCION" | "REGULACION",
  reason: string,
  observation: string,
  items: MermaStockExitItem[],
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    const authorization = await requireMermasSuperUser();
    const cleanCorrectionReason = correctionReason.trim();
    const cleanReason = reason.trim();
    if (!cleanCorrectionReason) return { success: false, error: "El motivo de la corrección es obligatorio." };
    if (!cleanReason) return { success: false, error: "El motivo de la salida corregida es obligatorio." };
    if (!Array.isArray(items) || items.length === 0) return { success: false, error: "Agrega al menos un producto." };
    const cleanItems = items.map((item) => ({
      bsale_variant_id: Number(item.bsale_variant_id),
      quantity: Number(item.quantity),
    }));
    if (cleanItems.some((item) => !Number.isInteger(item.bsale_variant_id) || item.bsale_variant_id <= 0 || !Number.isFinite(item.quantity) || item.quantity <= 0)) {
      return { success: false, error: "Revisa las cantidades ingresadas." };
    }
    const { data, error } = await db("mermas").rpc("correct_stock_exit", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_original_operation_id: originalOperationId,
      p_correction_reason: cleanCorrectionReason,
      p_new_operation_type: operationType,
      p_new_reason: cleanReason,
      p_new_observation: observation.trim() || null,
      p_items: cleanItems,
    });
    if (error) {
      if (error.message.toLocaleLowerCase("es-CL").includes("stock insuficiente")) {
        return { success: false, error: "El stock disponible cambió y no alcanza para la corrección." };
      }
      return { success: false, error: error.message };
    }
    return { success: true, data: (data ?? {}) as Record<string, unknown> };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "No se pudo corregir la salida." };
  }
}

async function getMermasWarehouseTraceData(variantId: number): Promise<{
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
    .eq("variant_id", variantId)
    .order("entered_at", { ascending: false });
  if (error)
    return { data: [], error: "No se pudo cargar la Bodega de Mermas" };

  const { data: movementRows, error: movementError } = await database
    .from("movements")
    .select(
      "id, movement_type, variant_id, quantity, expiration_date, lot, consumption_id, detail_id, request_id, request_line_id, source, authorization_status, authorized_by, authorized_at, created_at",
    )
    .eq("company_id", authorization.companyId)
    .eq("variant_id", variantId)
    .eq("authorization_status", "AUTORIZADA")
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
  const [{ data: variants }, { data: costRows }, { data: setting }] = await Promise.all([
    variantIds.length
      ? integrationDb.from("bsale_variants").select("bsale_id, code, bsale_product_id").eq("company_id", authorization.companyId).in("bsale_id", variantIds)
      : Promise.resolve({ data: [] as { bsale_id: number; code: string | null; bsale_product_id: number }[] }),
    variantIds.length
      ? integrationDb.from("bsale_variant_costs").select("variant_id, average_cost").eq("company_id", authorization.companyId).in("variant_id", variantIds)
      : Promise.resolve({ data: [] as { variant_id: number; average_cost: number | null }[] }),
    database.from("internal_sale_settings").select("worker_markup_percent").eq("company_id", authorization.companyId).maybeSingle(),
  ]);
  const markupPercent = setting?.worker_markup_percent === null || setting?.worker_markup_percent === undefined ? null : Number(setting.worker_markup_percent);
  const costMap = new Map((costRows ?? []).map((row) => {
    const cost = Number(row.average_cost);
    return [Number(row.variant_id), Number.isFinite(cost) && cost > 0 ? cost : null] as const;
  }));
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
  const [{ data: requests }, { data: lines }] = await Promise.all([
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
      average_cost: costMap.get(variantId) ?? null,
      cost_with_vat: calculateCostWithVat(costMap.get(variantId)),
      worker_price: calculateWorkerPrice(costMap.get(variantId), markupPercent),
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
      movement_type:
        movement.movement_type === "ENTRADA_BSALE"
          ? "INGRESO A BODEGA"
          : movement.movement_type === "STOCK_INICIAL"
            ? "STOCK INICIAL / APERTURA"
            : movement.movement_type,
      quantity,
      balance,
      origin:
        movement.consumption_id
          ? `Bsale #${movement.consumption_id}`
          : movement.source === "APERTURA"
            ? "Apertura de Bodega"
            : movement.source,
      reference: request?.request_code ?? null,
      user_name: userMap.get(movement.authorized_by) ?? userMap.get(request?.created_by ?? "") ?? "Usuario",
      consumption_id: movement.consumption_id,
      detail_id: movement.detail_id,
      request_code: request?.request_code ?? null,
      reason: line?.reason ?? null,
      expiration_date: movement.expiration_date,
      lot: movement.lot,
        evidence: [],
    });
  }
  return { data: [...products.values()] };
}

export async function getMermasWarehouseTrace(variantId: number): Promise<{
  data: MermaWarehouseProduct | null;
  error?: string;
}> {
  if (!Number.isInteger(variantId) || variantId <= 0) return { data: null, error: "Producto inválido" };
  const result = await getMermasWarehouseTraceData(variantId);
  return { data: result.data[0] ?? null, error: result.error };
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

  const productsDb = db("adquisiciones");
  const integrationDb = db("integraciones");
  const variantIds = [...requestedByVariant.keys()];
  const { data: products, error: productsError } = await productsDb
    .from("products")
    .select("id, bsale_variant_id, bsale_product_classification")
    .eq("company_id", authorization.companyId)
    .eq("is_active", true)
    .eq("status", "ACTIVE")
    .eq("bsale_variant_state", 0)
    .not("bsale_variant_id", "is", null)
    .in("id", variantIds);
  if (productsError) throw new Error("No se pudo validar el catálogo operativo");
  const productMap = new Map((products ?? []).map((product) => [product.id, product]));
  if (variantIds.some((variantId) => !productMap.has(variantId))) {
    throw new Error("Producto no encontrado en el catálogo operativo");
  }
  if ([...productMap.values()].some((product) => product.bsale_product_classification === 3)) {
    throw new Error("Los Packs deben registrarse por cada artículo físico que los compone.");
  }
  const bsaleVariantIds = [...productMap.values()].map((product) => product.bsale_variant_id);
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
    const stock = stockByVariant.get(productMap.get(variantId)!.bsale_variant_id);
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
    const authorization = await requireWmsPermission("logistica.mermas.request.create");
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
    const authorization = await requireWmsPermission("logistica.mermas.request.create");
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
  const authorization = await requireWmsPermission("logistica.mermas.request.create");
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

export type WorkerMonthlyMovement = {
  type: "CHARGE" | "ADJUSTMENT" | "PAYMENT" | "PAYMENT_VOID";
  source_type: string;
  reference_number: string | null;
  date: string;
  amount: number;
  balance_effect: number;
  charge_id: string | null;
  payment_id: string | null;
  items: Array<{
    sku?: string | null;
    product_name: string | null;
    quantity: number | null;
  }>;
};

export type WorkerMonthlyReport = {
  period: { year: number; month: number; timezone: string; start: string; end: string };
  summary: {
    opening_balance: number;
    merma_charges: number;
    bsale_charges: number;
    adjustments: number;
    payments: number;
    voided_payments: number;
    closing_balance: number;
    worker_count: number;
    workers_with_closing_debt: number;
  };
  workers: Array<{
    employee_id: string;
    name: string;
    rut: string;
    opening_balance: number;
    merma_charges: number;
    bsale_charges: number;
    adjustments: number;
    payments: number;
    voided_payments: number;
    closing_balance: number;
    movement_count: number;
    has_activity: boolean;
    movements: WorkerMonthlyMovement[];
  }>;
};

export type MermasAnalytics = {
  from: string;
  to: string;
  totals: {
    cost: number;
    units: number;
    products: number;
    uncosted_lines: number;
    uncosted_units: number;
    previous_cost: number;
    cost_variation: number | null;
  };
  monthly: Array<{ month: string; cost: number; units: number }>;
  products: Array<{ sku: string; name: string; units: number; cost: number }>;
};

function santiagoCivilDate(value: string | null) {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function getWorkerMonthlyAccountReport(year: number, month: number): Promise<{ data: WorkerMonthlyReport | null; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.account.view");
    const { data, error } = await db("mermas").rpc("get_worker_monthly_account_report", {
      p_company_id: authorization.companyId,
      p_user_id: authorization.user.id,
      p_year: year,
      p_month: month,
    });
    if (error) return { data: null, error: error.message };
    const report = data as WorkerMonthlyReport;
    return {
      data: {
        ...report,
        summary: Object.fromEntries(Object.entries(report.summary).map(([key, value]) => [key, typeof value === "number" ? value : Number(value)])) as WorkerMonthlyReport["summary"],
        workers: report.workers.map((worker) => ({
          ...worker,
          opening_balance: Number(worker.opening_balance),
          merma_charges: Number(worker.merma_charges),
          bsale_charges: Number(worker.bsale_charges),
          adjustments: Number(worker.adjustments),
          payments: Number(worker.payments),
          voided_payments: Number(worker.voided_payments),
          closing_balance: Number(worker.closing_balance),
          movement_count: Number(worker.movement_count),
          movements: worker.movements.map((movement) => ({
            ...movement,
            amount: Number(movement.amount),
            balance_effect: Number(movement.balance_effect),
          })),
        })),
      },
    };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "No se pudo cargar el reporte mensual." };
  }
}

export async function getMermasAnalytics(from: string, to: string): Promise<{ data: MermasAnalytics | null; error?: string }> {
  try {
    const authorization = await requireWmsPermission("logistica.mermas.view");
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${addCivilDays(to, 1)}T00:00:00Z`);
    const periodDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000));
    const previousTo = addCivilDays(from, -1);
    const previousFrom = addCivilDays(previousTo, -(periodDays - 1));
    const database = db("mermas");
    const { data: consumptions, error: consumptionError } = await database
      .from("bsale_consumptions")
      .select("consumption_id, consumption_date, consumption_type_id")
      .eq("company_id", authorization.companyId)
      .eq("consumption_type_id", 2)
      .gte("consumption_date", `${previousFrom}T00:00:00Z`)
      .lt("consumption_date", `${addCivilDays(to, 2)}T00:00:00Z`);
    if (consumptionError) return { data: null, error: "No se pudo cargar la analítica de Mermas." };

    const selectedConsumptions = (consumptions ?? []).filter((row) => {
      const date = santiagoCivilDate(row.consumption_date);
      return date !== null && date >= previousFrom && date <= to;
    });
    const consumptionIds = selectedConsumptions.map((row) => Number(row.consumption_id));
    const { data: details, error: detailsError } = consumptionIds.length
      ? await database.from("bsale_consumption_details").select("consumption_id, variant_id, quantity, cost").eq("company_id", authorization.companyId).in("consumption_id", consumptionIds)
      : { data: [], error: null };
    if (detailsError) return { data: null, error: "No se pudieron cargar los costos históricos de Mermas." };

    const variantIds = [...new Set((details ?? []).map((detail) => Number(detail.variant_id)))];
    const { data: products } = variantIds.length
      ? await db("adquisiciones").from("products").select("bsale_variant_id, sku, description").eq("company_id", authorization.companyId).eq("is_active", true).eq("status", "ACTIVE").in("bsale_variant_id", variantIds)
      : { data: [] as { bsale_variant_id: number; sku: string | null; description: string | null }[] };
    const productMap = new Map((products ?? []).map((product) => [Number(product.bsale_variant_id), product]));
    const consumptionDateMap = new Map(selectedConsumptions.map((row) => [Number(row.consumption_id), santiagoCivilDate(row.consumption_date)]));
    const currentProducts = new Map<number, { units: number; cost: number }>();
    const monthly = new Map<string, { cost: number; units: number }>();
    let currentCost = 0;
    let currentUnits = 0;
    let previousCost = 0;
    let uncostedLines = 0;
    let uncostedUnits = 0;
    for (const detail of details ?? []) {
      const quantity = Number(detail.quantity) || 0;
      const cost = detail.cost === null || detail.cost === undefined ? null : Number(detail.cost);
      const date = consumptionDateMap.get(Number(detail.consumption_id));
      if (!date) continue;
      const isCurrent = date >= from && date <= to;
      if (cost === null || !Number.isFinite(cost)) {
        if (isCurrent) {
          uncostedLines += 1;
          uncostedUnits += quantity;
        }
        continue;
      }
      const lineCost = quantity * cost;
      if (!isCurrent) {
        previousCost += lineCost;
        continue;
      }
      currentUnits += quantity;
      currentCost += lineCost;
      const month = date.slice(0, 7);
      const monthValue = monthly.get(month) ?? { cost: 0, units: 0 };
      monthValue.cost += lineCost;
      monthValue.units += quantity;
      monthly.set(month, monthValue);
      const product = currentProducts.get(Number(detail.variant_id)) ?? { units: 0, cost: 0 };
      product.units += quantity;
      product.cost += lineCost;
      currentProducts.set(Number(detail.variant_id), product);
    }
    return {
      data: {
        from,
        to,
        totals: {
          cost: currentCost,
          units: currentUnits,
          products: currentProducts.size,
          uncosted_lines: uncostedLines,
          uncosted_units: uncostedUnits,
          previous_cost: previousCost,
          cost_variation: previousCost === 0 ? null : ((currentCost - previousCost) / previousCost) * 100,
        },
        monthly: [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, value]) => ({ month, ...value })),
        products: [...currentProducts.entries()]
          .map(([variantId, value]) => ({
            sku: productMap.get(variantId)?.sku ?? `BS-${variantId}`,
            name: productMap.get(variantId)?.description ?? "Producto Bsale",
            ...value,
          }))
          .sort((a, b) => b.cost - a.cost),
      },
    };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : "No se pudo cargar la analítica de Mermas." };
  }
}
