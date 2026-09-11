"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Search, X, XCircle } from "lucide-react";
import {
  authorizeMermaMovement,
  rejectMermaMovement,
  getMermaMovementReview,
  getMermasAuthorizationPending,
  type MermaAuthorizationRow,
  type MermaEvidence,
} from "@/app/actions/logistica/mermas";
import { formatCivilDate } from "@/lib/datetime";
import { MermaEvidenceViewer } from "./mermas-evidence-viewer";

export function MermasAuthorizationPanel() {
  const [rows, setRows] = useState<MermaAuthorizationRow[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{
    movement: MermaAuthorizationRow;
    evidence: MermaEvidence[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");

  async function load() {
    setLoading(true);
    try {
      const result = await getMermasAuthorizationPending();
      setRows(result.data);
      setError(result.error ?? "");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "No autorizado para revisar entradas",
      );
    }
    setLoading(false);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function review(id: string) {
    setBusy(true);
    try {
    const result = await getMermaMovementReview(id);
      setSelected(result.data);
      setRejectionReason("");
      setError(result.error ?? "");
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : "No se pudo abrir la entrada",
      );
    }
    setBusy(false);
  }
  async function reject() {
    if (!selected) return;
    if (!rejectionReason.trim()) {
      setError("El motivo del rechazo es obligatorio");
      return;
    }
    setBusy(true);
    const result = await rejectMermaMovement(
      selected.movement.movement_id,
      rejectionReason,
    );
    if ("error" in result && result.error) setError(result.error);
    else {
      setSelected(null);
      setRejectionReason("");
      await load();
    }
    setBusy(false);
  }
  async function authorize() {
    if (!selected) return;
    setBusy(true);
    const result = await authorizeMermaMovement(selected.movement.movement_id);
    if ("error" in result && result.error) setError(result.error);
    else {
      setSelected(null);
      await load();
    }
    setBusy(false);
  }
  const visible = rows.filter((row) =>
    `${row.request_code ?? ""} ${row.sku} ${row.product_name}`
      .toLowerCase()
      .includes(search.toLowerCase().trim()),
  );
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-theme-text">
            Pendientes de autorización
          </h2>
          <p className="mt-1 text-xs text-theme-text-muted">
            Las entradas físicas no están disponibles hasta ser autorizadas.
          </p>
        </div>
        <div className="relative w-64 max-w-full">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar SKU o MER..."
            className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-xs text-theme-text"
          />
        </div>
      </div>
      {error && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-theme-text-muted" />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-theme-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
              <tr>
                {[
                  "MER/origen",
                  "SKU",
                  "Producto",
                  "Cantidad",
                  "Motivo",
                  "Vencimiento",
                  "Solicitante",
                  "Evidencias",
                  "",
                ].map((head) => (
                  <th key={head} className="px-3 py-3">
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.movement_id}
                  className="border-t border-theme-border/70"
                >
                  <td className="px-3 py-3 font-mono text-theme-text">
                    {row.request_code ?? row.origin}
                  </td>
                  <td className="px-3 py-3 font-mono font-semibold text-theme-text">
                    {row.sku}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {row.product_name}
                  </td>
                  <td className="px-3 py-3 tabular-nums text-theme-text">
                    {row.available}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {row.reason ?? "-"}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {row.expiration_date ?? "Pendiente"}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {row.requester_name ?? "-"}
                  </td>
                  <td className="px-3 py-3 tabular-nums text-theme-text">
                     {row.evidence_count > 0
                       ? `${row.evidence_count} foto${row.evidence_count === 1 ? "" : "s"}`
                       : "SIN EVIDENCIA"}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void review(row.movement_id)}
                      className="text-xs font-semibold text-theme-text-accent hover:underline"
                    >
                      Revisar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-theme-border bg-theme-surface p-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-theme-text">
                  Revisar entrada
                </h3>
                <p className="mt-1 text-xs text-theme-text-muted">
                  {selected.movement.sku} ·{" "}
                  {selected.movement.request_code ?? "Sin solicitud asociada"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/5"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-3 text-xs text-theme-text-muted sm:grid-cols-2">
              <span>
                Producto:{" "}
                <strong className="text-theme-text">
                  {selected.movement.product_name}
                </strong>
              </span>
              <span>
                Cantidad:{" "}
                <strong className="text-theme-text">
                  {selected.movement.available}
                </strong>
              </span>
              <span>
                Motivo:{" "}
                <strong className="text-theme-text">
                  {selected.movement.reason ?? "-"}
                </strong>
              </span>
              <span>
                Vencimiento:{" "}
                <strong className="text-theme-text">
                  {selected.movement.expiration_date
                    ? formatCivilDate(selected.movement.expiration_date)
                    : "Pendiente"}
                </strong>
              </span>
              <span>
                Solicitante:{" "}
                <strong className="text-theme-text">
                  {selected.movement.requester_name ?? "-"}
                </strong>
              </span>
              <span>
                Fecha solicitud:{" "}
                <strong className="text-theme-text">
                  {selected.movement.request_date
                    ? new Date(selected.movement.request_date).toLocaleString(
                        "es-CL",
                      )
                    : "-"}
                </strong>
              </span>
            </div>
            <div className="mt-5">
              <MermaEvidenceViewer evidence={selected.evidence} />
            </div>
             {selected.movement.authorization_status !== "RECHAZADA" && (
               <div className="mt-5 space-y-3">
                 <label className="block text-xs font-semibold text-theme-text">
                   Motivo del rechazo *
                   <textarea
                     value={rejectionReason}
                     onChange={(event) => setRejectionReason(event.target.value)}
                     rows={2}
                     placeholder="Ej. Falta evidencia fotográfica válida."
                     className="mt-1 min-h-16 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm font-normal text-theme-text"
                   />
                 </label>
                 <div className="flex justify-end gap-2">
                   <button
                     type="button"
                     disabled={busy}
                     onClick={() => void reject()}
                     className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                   >
                     <XCircle className="h-4 w-4" /> Rechazar
                   </button>
                   <button
                     type="button"
                     disabled={busy || selected.evidence.length === 0}
                     onClick={() => void authorize()}
                     className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                   >
                     <CheckCircle2 className="h-4 w-4" /> Autorizar
                   </button>
                 </div>
               </div>
             )}
          </div>
        </div>
      )}
    </section>
  );
}
