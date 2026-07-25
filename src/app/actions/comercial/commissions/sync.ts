"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedCompany } from "./auth";
import type { CommissionSyncHealth, CommissionSyncRun, RoleRelation } from "./types";

export async function getCommissionsSyncHealth(): Promise<CommissionSyncHealth> {
  const { companyId } = await getAuthenticatedCompany();
  const admin = createAdminClient();
  const runs = admin.schema("integraciones").from("bsale_sync_runs");
  const columns =
    "started_at,completed_at,status,trigger,documents_count,document_details_count,error_message";

  const [latestResult, latestSuccessfulResult] = await Promise.all([
    runs
      .select(columns)
      .eq("company_id", companyId)
      .not("documents_count", "is", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    runs
      .select(columns)
      .eq("company_id", companyId)
      .in("status", ["COMPLETED", "PARTIAL"])
      .not("documents_count", "is", null)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const firstError = latestResult.error || latestSuccessfulResult.error;
  if (firstError) {
    throw new Error(`Error leyendo sync health de comisiones: ${firstError.message}`);
  }

  const latestRun = (latestResult.data as CommissionSyncRun | null) || null;
  const latestSuccessfulRun =
    (latestSuccessfulResult.data as CommissionSyncRun | null) || null;
  const lastCompletedAt =
    latestSuccessfulRun?.completed_at || latestSuccessfulRun?.started_at || null;
  const lastSuccessAgeMinutes = lastCompletedAt
    ? Math.round((Date.now() - new Date(lastCompletedAt).getTime()) / 60000)
    : null;

  return {
    latestRun,
    latestSuccessfulRun,
    isFresh: lastSuccessAgeMinutes !== null && lastSuccessAgeMinutes <= 180,
    lastSuccessAgeMinutes,
  };
}

export async function triggerManualCommissionsSync() {
  const { companyId, userId } = await getAuthenticatedCompany();
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("users")
    .select("role_id, roles:role_id(name)")
    .eq("id", userId)
    .single();
  const roleName = String(
    (profile?.roles as RoleRelation | null)?.name || "",
  ).toUpperCase();

  if (roleName !== "SUPER_USUARIO") {
    throw new Error("Solo SUPER_USUARIO puede ejecutar sincronización manual.");
  }

  const { runReplenishmentBsaleSync } =
    await import("@/app/actions/integraciones/bsale-sync");
  return runReplenishmentBsaleSync(companyId, "MANUAL");
}
