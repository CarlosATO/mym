"use client";

import { useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import {
  getMermaMovementReview,
  getMermasRejected,
  type MermaEvidence,
  type MermaRejectedRow,
} from "@/app/actions/logistica/mermas";
import { formatCivilDate } from "@/lib/datetime";

export function MermasArchivedPanel() {
  const [rows, setRows] = useState<MermaRejectedRow[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{
    movement: MermaRejectedRow;
    evidence: MermaEvidence[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<keyof MermaRejectedRow>("rejected_at");
  const [descending, setDescending] = useState(true);

  useEffect(() => {
    getMermasRejected().then((result) => {
      setRows(result.data);
      setError(result.error ?? "");
      setLoading(false);
    }).catch(() => {
      setError("No se pudieron cargar las entradas archivadas");
      setLoading(false);
    });
  }, []);

  const visible = rows
    .filter((row) => `${row.request_code ?? ""} ${row.sku} ${row.product_name}`
      .toLowerCase().includes(search.toLowerCase().trim()))
    .sort((a, b) => {
      const result = String(a[sort] ?? "").localeCompare(String(b[sort] ?? ""), "es", { numeric: true });
      return descending ? -result : result;
    });

  async function review(row: MermaRejectedRow) {
    const result = await getMermaMovementReview(row.movement_id);
    if (result.data) setSelected(result.data as { movement: MermaRejectedRow; evidence: MermaEvidence[] });
    else setError(result.error ?? "No se pudo abrir la entrada archivada");
  }

  function orderBy(column: keyof MermaRejectedRow) {
    setDescending(sort === column ? !descending : false);
    setSort(column);
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-theme-text">Archivadas</h2>
          <p className="mt-1 text-xs text-theme-text-muted">Entradas rechazadas, conservadas para trazabilidad.</p>
        </div>
        <div className="relative w-64 max-w-full">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar SKU o MER..." className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-xs text-theme-text" />
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
      {loading ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-theme-text-muted" /></div> : (
        <div className="overflow-x-auto rounded-xl border border-theme-border">
          <table className="w-full min-w-[1050px] text-sm">
            <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
              <tr>{([["MER / Origen", "request_code"], ["SKU", "sku"], ["Producto", "product_name"], ["Cantidad", "available"], ["Vencimiento", "expiration_date"], ["Resultado", "authorization_status"], ["Motivo rechazo", "rejection_reason"], ["Revisado por", "rejected_by_name"], ["Fecha revisión", "rejected_at"]] as const).map(([label, column]) => <th key={label} className="px-3 py-3"><button type="button" onClick={() => orderBy(column)}>{label}</button></th>)}</tr>
            </thead>
            <tbody>{visible.map((row) => <tr key={row.movement_id} className="border-t border-theme-border/70">
              <td className="px-3 py-3 font-mono text-theme-text"><button type="button" onClick={() => void review(row)} className="font-semibold text-theme-text-accent hover:underline">{row.request_code ?? row.origin}</button></td>
              <td className="px-3 py-3 font-mono font-semibold text-theme-text">{row.sku}</td>
              <td className="px-3 py-3 text-theme-text-muted">{row.product_name}</td>
              <td className="px-3 py-3 tabular-nums text-theme-text">{row.available}</td>
              <td className="px-3 py-3 text-theme-text-muted">{row.expiration_date ? formatCivilDate(row.expiration_date) : "Pendiente"}</td>
              <td className="px-3 py-3 font-semibold text-red-600">RECHAZADA</td>
              <td className="max-w-64 px-3 py-3 text-theme-text-muted">{row.rejection_reason}</td>
              <td className="px-3 py-3 text-theme-text-muted">{row.rejected_by_name ?? "-"}</td>
              <td className="px-3 py-3 text-theme-text-muted">{new Date(row.rejected_at).toLocaleString("es-CL")}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      {selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"><div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-theme-border bg-theme-surface p-5">
        <div className="flex items-center justify-between"><div><h3 className="text-base font-semibold text-theme-text">Entrada RECHAZADA</h3><p className="mt-1 text-xs text-theme-text-muted">{selected.movement.sku} · {selected.movement.request_code ?? selected.movement.origin}</p></div><button type="button" onClick={() => setSelected(null)} className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/5"><X className="h-4 w-4" /></button></div>
        <div className="mt-4 grid gap-3 text-xs text-theme-text-muted sm:grid-cols-2"><span>Producto: <strong className="text-theme-text">{selected.movement.product_name}</strong></span><span>Cantidad: <strong className="text-theme-text">{selected.movement.available}</strong></span><span>Solicitud: <strong className="text-theme-text">{selected.movement.request_code ?? "-"}</strong></span><span>Consumo Bsale: <strong className="text-theme-text">{selected.movement.consumption_id ?? "-"}</strong></span><span>Motivo original: <strong className="text-theme-text">{selected.movement.original_reason ?? "-"}</strong></span><span>Vencimiento: <strong className="text-theme-text">{selected.movement.expiration_date ? formatCivilDate(selected.movement.expiration_date) : "Pendiente"}</strong></span><span>Motivo rechazo: <strong className="text-theme-text">{selected.movement.rejection_reason}</strong></span><span>Rechazado por: <strong className="text-theme-text">{selected.movement.rejected_by_name ?? "-"}</strong></span><span>Fecha revisión: <strong className="text-theme-text">{new Date(selected.movement.rejected_at).toLocaleString("es-CL")}</strong></span><span>Fecha consumo: <strong className="text-theme-text">{selected.movement.consumption_date ? formatCivilDate(new Date(selected.movement.consumption_date).toISOString().slice(0, 10)) : "-"}</strong></span><span className="sm:col-span-2">Nota Bsale: <strong className="text-theme-text">{selected.movement.note ?? "-"}</strong></span></div>
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">{selected.evidence.map((photo) => <a key={photo.id} href={photo.signed_url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg border border-theme-border"><img src={photo.signed_url} alt={photo.file_name} className="aspect-square w-full object-cover" /></a>)}</div>
      </div></div>}
    </section>
  );
}
