import { RefreshCw, UsersRound } from "lucide-react";
import type { CommissionSyncHealth } from "@/app/actions/comercial/commissions";
import { cn } from "@/lib/utils";
import type { View } from "../../commissions-panel-types";

export function CommissionSyncStatusHeader({
  view,
  syncHealth,
  syncHealthLoading,
  syncBusy,
  onManualSync,
}: {
  view: View;
  syncHealth?: CommissionSyncHealth | null;
  syncHealthLoading?: boolean;
  syncBusy?: boolean;
  onManualSync?: () => void;
}) {
  const syncStatusLabel = getSyncStatusLabel(
    syncHealth,
    syncHealthLoading,
    syncBusy,
  );

  return (
    <header className="shrink-0 border-b border-theme-border px-4 py-3 md:px-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <UsersRound className="h-4 w-4 text-theme-accent" />
            <h2 className="font-accent text-lg font-semibold">
              Comisiones de Vendedores
            </h2>
          </div>
          <p className="mt-1 text-sm text-theme-text-muted">
            {view === "main"
              ? "Gestiona simulaciones y liquidaciones de vendedores."
              : "Configuración de vendedores, comisión general, grupos y reglas."}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="text-xs text-theme-text-muted">{syncStatusLabel}</div>
          {onManualSync && (
            <button
              onClick={onManualSync}
              disabled={syncBusy}
              className="btn-secondary"
              title="Forzar sincronización de documentos de Bsale"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", syncBusy && "animate-spin")}
              />
              {syncBusy ? "Sincronizando..." : "Sincronizar ahora"}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function formatSyncDateTime(value: string) {
  return new Date(value).toLocaleString("es-CL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getSyncStatusLabel(
  syncHealth: CommissionSyncHealth | null | undefined,
  syncHealthLoading: boolean | undefined,
  syncBusy: boolean | undefined,
) {
  const latestRun = syncHealth?.latestRun;
  const latestSuccessfulRun = syncHealth?.latestSuccessfulRun;
  const status = String(latestRun?.status || "").toUpperCase();

  if (
    syncBusy ||
    status === "RUNNING" ||
    status === "IN_PROGRESS" ||
    status === "STARTED"
  ) {
    return "Sincronización en curso...";
  }
  if (syncHealthLoading) return "Última sincronización: cargando...";
  if (!latestRun) return "Última sincronización: sin registro disponible";

  const timestamp = latestRun.completed_at || latestRun.started_at;
  if (!timestamp) return "Última sincronización: sin registro disponible";
  if (status === "COMPLETED" || status === "PARTIAL") {
    return `Última sincronización exitosa: ${formatSyncDateTime(timestamp)}`;
  }
  if (status === "ERROR" || status === "FAILED") {
    return `Última sincronización con error: ${formatSyncDateTime(timestamp)}`;
  }
  if (latestSuccessfulRun) {
    const successTimestamp =
      latestSuccessfulRun.completed_at || latestSuccessfulRun.started_at;
    if (successTimestamp) {
      return `Última sincronización exitosa: ${formatSyncDateTime(successTimestamp)}`;
    }
  }
  return `Última sincronización: ${formatSyncDateTime(timestamp)}`;
}
