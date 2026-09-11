import { createClient } from "@supabase/supabase-js";
import { bsaleFetch, bsaleFetchAll } from "@/lib/bsale/client";
import {
  releaseSyncLock,
  tryAcquireSyncLock,
  type SyncTriggerType,
} from "./sync-core";

type BsaleConsumption = {
  id: number;
  consumptionDate?: number | string | null;
  note?: string | null;
  consumptionTypeId?: number | string | null;
  office?: { id?: number | string | null } | null;
  user?: { id?: number | string | null } | null;
  details?: { href?: string | null } | null;
};

type BsaleConsumptionDetail = {
  id: number;
  quantity?: number | string | null;
  cost?: number | string | null;
  variantStock?: number | string | null;
  variant?: { id?: number | string | null } | null;
};

type SyncResult = {
  success: boolean;
  fetched: number;
  accepted: number;
  newDetails: number;
  newMovements: number;
  completedRequests: number;
  error?: string;
};

const provider = "BSALE";
const entity = "MERMAS_CONSUMPTIONS";
const overlap = 50;

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function consumptionDate(value: unknown) {
  const epoch = numberOrNull(value);
  if (epoch !== null) return new Date(epoch * 1000);
  if (typeof value === "string" && value) return new Date(value);
  return null;
}

export async function syncBsaleMermas(params: {
  companyId: string;
  userId: string;
  trigger?: SyncTriggerType;
}): Promise<SyncResult> {
  const trigger = params.trigger ?? "MANUAL";
  const locked = await tryAcquireSyncLock({
    companyId: params.companyId,
    provider,
    entity,
    ttlMinutes: 30,
    lockedBy: trigger,
  });
  if (!locked)
    return {
      success: false,
      fetched: 0,
      accepted: 0,
      newDetails: 0,
      newMovements: 0,
      completedRequests: 0,
      error: "Ya existe una sincronización de Mermas en curso.",
    };

  try {
    const database = admin();
    const { data: state, error: stateError } = await database
      .schema("mermas")
      .from("sync_state")
      .select("activation_date, high_watermark")
      .eq("company_id", params.companyId)
      .maybeSingle();
    if (stateError)
      throw new Error(
        `No se pudo leer el estado de sincronización: ${stateError.message}`,
      );

    const activation = state?.activation_date ?? "2026-09-10";
    const watermark = Number(state?.high_watermark ?? 0);
    const headers = await bsaleFetchAll<BsaleConsumption>(
      "/stocks/consumptions.json",
    );
    const eligible = headers.filter((header) => {
      const typeId = numberOrNull(header.consumptionTypeId);
      const date = consumptionDate(header.consumptionDate);
      return (
        typeId === 2 &&
        date !== null &&
        date.toISOString().slice(0, 10) >= activation &&
        header.id >= Math.max(0, watermark - overlap)
      );
    });

    let accepted = 0;
    let newDetails = 0;
    let newMovements = 0;
    let completedRequests = 0;
    let highWatermark = watermark;
    for (const summary of headers) {
      if (summary.id > highWatermark) highWatermark = summary.id;
    }

    for (const summary of eligible) {
      const headerResult = await bsaleFetch<BsaleConsumption>({
        path: `/stocks/consumptions/${summary.id}.json`,
      });
      const header = headerResult as unknown as BsaleConsumption;
      const details = await bsaleFetchAll<BsaleConsumptionDetail>(
        `/stocks/consumptions/${summary.id}/details.json`,
      );
      const { data, error } = await database
        .schema("mermas")
        .rpc("process_bsale_consumption", {
          p_company_id: params.companyId,
          p_user_id: params.userId,
          p_header: header,
          p_details: details,
        });
      if (error)
        throw new Error(
          `No se pudo procesar consumo Bsale ${summary.id}: ${error.message}`,
        );
      const result = data as {
        accepted?: boolean;
        new_details?: number;
        new_movements?: number;
        request_id?: string | null;
        request_status?: string | null;
      };
      if (result.accepted) accepted += 1;
      newDetails += Number(result.new_details ?? 0);
      newMovements += Number(result.new_movements ?? 0);
      if (result.new_details && result.request_status === "CUMPLIDA") {
        completedRequests += 1;
      }
    }

    await database.schema("mermas").from("sync_state").upsert(
      {
        company_id: params.companyId,
        activation_date: activation,
        high_watermark: highWatermark,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id" },
    );

    return {
      success: true,
      fetched: headers.length,
      accepted,
      newDetails,
      newMovements,
      completedRequests,
    };
  } catch (error) {
    return {
      success: false,
      fetched: 0,
      accepted: 0,
      newDetails: 0,
      newMovements: 0,
      completedRequests: 0,
      error:
        error instanceof Error
          ? error.message
          : "No se pudo sincronizar Mermas Bsale",
    };
  } finally {
    await releaseSyncLock(params.companyId, provider, entity);
  }
}
