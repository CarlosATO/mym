"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { syncMermasFromBsale } from "@/app/actions/logistica/mermas";
import { useMermasModule } from "./mermas-module-provider";

export function MermasShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { bootstrap, invalidateRequests, ensureRequestsLoaded, invalidateWarehouse, ensureWarehouseLoaded } = useMermasModule();
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncError, setSyncError] = useState("");

  useEffect(() => {
    if (pathname === "/dashboard/logistica/mermas" && searchParams.get("view") === "authorization" && !bootstrap.canAuthorize) {
      router.replace("/dashboard/logistica/mermas");
    }
  }, [bootstrap.canAuthorize, pathname, router, searchParams]);

  async function sync() {
    setSyncing(true);
    setSyncMessage("");
    setSyncError("");
    try {
      const result = await syncMermasFromBsale();
      if (!result.success) {
        setSyncError(result.error ?? "No se pudo sincronizar Mermas Bsale");
        return;
      }
      setSyncMessage(`${result.newDetails} detalles Bsale ingeridos · disponibles para asociación manual`);
      await invalidateRequests();
      invalidateWarehouse();
      if (bootstrap.canViewWarehouse) await ensureWarehouseLoaded(true);
      if (pathname === "/dashboard/logistica/mermas") {
        await ensureRequestsLoaded(searchParams.get("q") ?? "", true);
      }
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "No se pudo sincronizar Mermas Bsale");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-7.5rem)] bg-theme-bg p-3 sm:p-5">
      <div className="mx-auto min-h-[calc(100vh-9.5rem)] max-w-[1600px] overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-sm">
        <header className="border-b border-theme-border/60 bg-theme-text/[0.012] px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">WMS / Operación</p>
              <h1 className="mt-1 text-lg font-semibold text-theme-text">Mermas</h1>
              <p className="mt-0.5 text-xs text-theme-text-muted">Gestión, control y disposición de productos en Merma</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {pathname === "/dashboard/logistica/mermas" && bootstrap.canCreateRequest && (
                <Link href="/dashboard/logistica/mermas/nueva" className="inline-flex items-center gap-2 rounded-xl bg-theme-accent px-3 py-2 text-xs font-semibold text-white hover:bg-theme-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/50">
                  <Plus className="h-4 w-4" /> Nueva solicitud
                </Link>
              )}
              {bootstrap.canSync && <button type="button" onClick={() => void sync()} disabled={syncing} className="inline-flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/50 disabled:opacity-50">
                <RefreshCw className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Sincronizar Bsale
              </button>}
            </div>
          </div>
        </header>
        {(syncMessage || syncError) && <div className={`px-4 pt-3 text-sm sm:px-5 ${syncError ? "text-red-600" : "text-emerald-700 dark:text-emerald-300"}`}>{syncError || syncMessage}</div>}
        {children}
      </div>
    </div>
  );
}
