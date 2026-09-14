"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { syncMermasFromBsale } from "@/app/actions/logistica/mermas";
import { useMermasModule } from "./mermas-module-provider";

type NavigationItem = {
  href: string;
  label: string;
  permission?: boolean;
  view?: string;
  badge?: number;
};

function isActive(pathname: string, searchParams: URLSearchParams, item: NavigationItem) {
  if (item.href === "/dashboard/logistica/mermas") {
    return pathname === item.href && (searchParams.get("view") ?? "requests") === (item.view ?? "requests");
  }
  return pathname === item.href;
}

export function MermasShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { bootstrap, pendingCount, invalidateRequests, ensureRequestsLoaded } = useMermasModule();
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
      if (pathname === "/dashboard/logistica/mermas") {
        await ensureRequestsLoaded(searchParams.get("q") ?? "", true);
      }
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "No se pudo sincronizar Mermas Bsale");
    } finally {
      setSyncing(false);
    }
  }

  const operationItems: NavigationItem[] = [
    { href: "/dashboard/logistica/mermas", label: "Solicitudes de traspaso a Mermas", view: "requests" },
    { href: "/dashboard/logistica/mermas", label: "Bodega de Mermas", view: "warehouse", permission: bootstrap.canViewWarehouse },
    { href: "/dashboard/logistica/mermas/venta-trabajadores", label: "Venta a trabajadores", permission: bootstrap.canUseInternalSale },
  ];
  const controlItems: NavigationItem[] = [
    { href: "/dashboard/logistica/mermas", label: "Pendientes de autorización", view: "authorization", permission: bootstrap.canAuthorize, badge: pendingCount },
    { href: "/dashboard/logistica/mermas/cuenta-corriente", label: "Cuenta corriente", permission: bootstrap.canViewAccounts },
    { href: "/dashboard/logistica/mermas/revision-pagos", label: "Revisión de pagos", permission: bootstrap.canReviewPayments },
  ];
  const historyItems: NavigationItem[] = [
    { href: "/dashboard/logistica/mermas", label: "Archivadas", view: "archived", permission: bootstrap.canView },
    { href: "/dashboard/logistica/mermas", label: "Configuración", view: "configuration", permission: bootstrap.canEditSettings },
  ];

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
          <nav aria-label="Navegación de Mermas" className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-theme-border/60 pt-3">
            {[operationItems, controlItems, historyItems].map((group, groupIndex) => (
              <div key={groupIndex} className={`flex flex-wrap items-center gap-1 ${groupIndex > 0 ? "border-l border-theme-border pl-3" : ""}`}>
                {group.filter((item) => item.permission !== false).map((item) => {
                  const active = isActive(pathname, searchParams, item);
                  const href = item.href === "/dashboard/logistica/mermas" && item.view && item.view !== "requests"
                    ? `${item.href}?view=${item.view}`
                    : item.href;
                  return (
                    <Link key={`${item.href}-${item.view ?? item.label}`} href={href} aria-current={active ? "page" : undefined} className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/50 ${active ? "border-theme-accent/35 bg-theme-accent/10 font-semibold text-theme-text-accent" : "border-transparent font-medium text-theme-text-muted hover:border-theme-border hover:bg-theme-text/[0.035] hover:text-theme-text"}`}>
                      {item.view === "configuration" && <Settings2 className="h-3.5 w-3.5" />}
                      {item.label}
                      {item.badge !== undefined && item.badge > 0 && <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{item.badge}</span>}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
        </header>
        {pathname !== "/dashboard/logistica/mermas" && (
          <div className="border-b border-theme-border/60 px-4 py-2 sm:px-5">
            <Link href="/dashboard/logistica/mermas" className="text-xs font-semibold text-theme-text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-accent/50">← Volver a Mermas</Link>
          </div>
        )}
        {(syncMessage || syncError) && <div className={`px-4 pt-3 text-sm sm:px-5 ${syncError ? "text-red-600" : "text-emerald-700 dark:text-emerald-300"}`}>{syncError || syncMessage}</div>}
        {children}
      </div>
    </div>
  );
}
