"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  createMermaRequest,
  cancelMermaRequest,
  authorizeMermaRequestWithConsumption,
  getMermasBsaleCandidates,
  getMermasBsaleIncidents,
  getMermasContext,
  getMermasRequest,
  getMermasRequests,
  getMermasWarehouse,
  getPendingMermasCount,
  searchMermasProducts,
  syncMermasFromBsale,
  cleanupMermaEvidenceUploads,
  prepareMermaIncidentEvidenceUploads,
  regularizeMermaBsaleIncident,
  type MermaEvidenceMetadata,
  type MermaLine,
  type MermaProduct,
  type MermaRequest,
  type MermaBsaleIncident,
  type MermaWarehouseProduct,
} from "@/app/actions/logistica/mermas";
import { NewMermaForm } from "./new-merma-form";
import { uploadMermaEvidence } from "./new-merma-form-with-evidence";
import { MermasAuthorizationPanel } from "./mermas-authorization-panel";
import { MermasArchivedPanel } from "./mermas-archived-panel";
import { MermaEvidenceViewer } from "./mermas-evidence-viewer";
import { formatCivilDate, formatInstantInSantiago } from "@/lib/datetime";

type Mode = "list" | "new" | "detail";
type DraftLine = {
  product: MermaProduct | null;
  quantity: string;
  reason: string;
  expiration_date: string;
  lot: string;
  observation: string;
  search: string;
  results: MermaProduct[];
  searching: boolean;
};

const blankLine = (): DraftLine => ({
  product: null,
  quantity: "1",
  reason: "",
  expiration_date: "",
  lot: "",
  observation: "",
  search: "",
  results: [],
  searching: false,
});

function formatBsaleConsumptionDate(value: string | null | undefined) {
  if (!value) return "";
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  return formatCivilDate(instant.toISOString().slice(0, 10));
}

function displayMermaStatus(status: string) {
  return status === "FINALIZADA" ? "INGRESADO A BODEGA" : status;
}

function formatStoredDate(value: string | null | undefined) {
  return value ? formatCivilDate(value.slice(0, 10)) : "";
}

export function MermasPanel({
  mode,
  requestId,
}: {
  mode: Mode;
  requestId?: string;
}) {
  if (mode === "new") return <NewMermaForm />;
  if (mode === "detail") return <MermaDetail requestId={requestId!} />;
  return <MermaOperations />;
}

function PanelHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-theme-border/60 bg-theme-text/[0.012] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-base font-semibold text-theme-text">{title}</h1>
        <p className="mt-1 text-xs text-theme-text-muted/70">{description}</p>
      </div>
      {action}
    </div>
  );
}

function MermaOperations() {
  const router = useRouter();
  const [tab, setTab] = useState<"requests" | "warehouse" | "authorization" | "archived">(
    "requests",
  );
  const [requests, setRequests] = useState<MermaRequest[]>([]);
  const [warehouse, setWarehouse] = useState<
    Awaited<ReturnType<typeof getMermasWarehouse>>["data"]
  >([]);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [requestSort, setRequestSort] = useState("created_at");
  const [warehouseSort, setWarehouseSort] = useState("entered_at");
  const [descending, setDescending] = useState(true);
  const [warehouseDescending, setWarehouseDescending] = useState(false);
  const [warehouseSearch, setWarehouseSearch] = useState("");
  const [selectedWarehouseProduct, setSelectedWarehouseProduct] = useState<MermaWarehouseProduct | null>(null);
  const [bsaleIncidents, setBsaleIncidents] = useState<MermaBsaleIncident[]>([]);
  const [incidentsOpen, setIncidentsOpen] = useState(false);
  const sortedRequests = [...requests].sort(
    (a, b) =>
      (descending ? -1 : 1) *
      String(a[requestSort as keyof MermaRequest] ?? "").localeCompare(
        String(b[requestSort as keyof MermaRequest] ?? ""),
        "es",
        { numeric: true },
      ),
  );
  const normalizedWarehouseSearch = warehouseSearch.trim().toLocaleLowerCase("es-CL");
  const filteredWarehouse = warehouse.filter((row) =>
    `${row.sku} ${row.product_name}`.toLocaleLowerCase("es-CL").includes(normalizedWarehouseSearch),
  );
  const sortedWarehouse = [...filteredWarehouse].sort((a, b) => {
    const values: Record<string, [string | number, string | number]> = {
      sku: [a.sku, b.sku],
      product_name: [a.product_name, b.product_name],
      available: [a.available, b.available],
      next_expiration: [a.next_expiration ?? "9999-12-31", b.next_expiration ?? "9999-12-31"],
      expiration_status: [a.expiration_status, b.expiration_status],
      lot_count: [a.lot_count, b.lot_count],
      last_entry_at: [a.last_entry_at ?? "", b.last_entry_at ?? ""],
    };
    const [left, right] = values[warehouseSort] ?? values.sku;
    const comparison = typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), "es", { numeric: true, sensitivity: "base" });
    return (warehouseDescending ? -1 : 1) * comparison;
  });

  async function load() {
    setLoading(true);
    setError("");
    const incidentsResult = await getMermasBsaleIncidents();
    setBsaleIncidents(incidentsResult.data);
    if (incidentsResult.error) setError(incidentsResult.error);
    if (tab === "requests") {
      const [result, count] = await Promise.all([
        getMermasRequests(search),
        getPendingMermasCount(),
      ]);
      setRequests(result.data);
      setPending(count);
      setError(result.error ?? incidentsResult.error ?? "");
    } else if (tab === "warehouse") {
      const result = await getMermasWarehouse();
      setWarehouse(result.data);
      setError(result.error ?? incidentsResult.error ?? "");
    }
    setLoading(false);
  }

  // The effect refreshes the server-backed operational view when filters change.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, search]);

  async function sync() {
    setSyncing(true);
    setMessage("");
    setError("");
    try {
      const result = await syncMermasFromBsale();
      if (!result.success)
        setError(result.error ?? "No se pudo sincronizar Mermas Bsale");
      else {
        setMessage(
          `${result.newDetails} detalles Bsale ingeridos · disponibles para asociación manual`,
        );
        await load();
      }
    } catch (syncError) {
      setError(
        syncError instanceof Error
          ? syncError.message
          : "No se pudo sincronizar Mermas Bsale",
      );
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-7.5rem)] bg-theme-surface">
      <PanelHeader
        title="Mermas"
        description="Solicitudes y Bodega de Mermas"
        action={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void sync()}
              disabled={syncing}
              className="inline-flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2.5 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 disabled:opacity-50"
            >
              <RefreshCw
                className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
              />{" "}
              Sincronizar Bsale
            </button>
            {tab === "requests" && (
              <button
                onClick={() => router.push("/dashboard/logistica/mermas/nueva")}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 py-2.5 text-xs font-semibold text-white hover:bg-theme-accent-hover"
              >
                <Plus className="h-4 w-4" /> Nueva solicitud
              </button>
            )}
          </div>
        }
      />
      <div className="space-y-4 p-5">
        <nav
          className="flex border-b border-theme-border"
          aria-label="Vistas de Mermas"
        >
          {(
            [
              ["requests", "Solicitudes"],
              ["warehouse", "Bodega de Mermas"],
              ["authorization", "Pendientes de autorización"],
              ["archived", "Archivadas"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`border-b-2 px-4 py-2.5 text-xs font-semibold ${tab === value ? "border-theme-accent text-theme-text-accent" : "border-transparent text-theme-text-muted hover:text-theme-text"}`}
            >
              {label}
            </button>
          ))}
        </nav>
        {message && (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {message}
          </p>
        )}
        {error && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
        {bsaleIncidents.length > 0 && (
          <button
            type="button"
            onClick={() => setIncidentsOpen(true)}
            className="flex w-full items-start gap-3 rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-left text-red-800 transition-colors hover:bg-red-500/15 dark:text-red-200"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <span>
              <strong className="block text-sm uppercase tracking-wide">
                {bsaleIncidents.length} consumo{bsaleIncidents.length === 1 ? "" : "s"} de merma en Bsale sin solicitud Petgroup
              </strong>
              <span className="mt-0.5 block text-xs opacity-85">
                Requieren regularización antes de ingresar a Bodega de Mermas.
              </span>
            </span>
          </button>
        )}
        {tab === "requests" && (
          <>
            {pending > 0 && (
              <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
                  {pending}
                </span>
                <p>
                  <strong>
                    {pending} solicitudes pendientes de gestionar en Bsale
                  </strong>
                  <span className="mt-0.5 block text-xs opacity-80">
                    El sincronizador las actualizará cuando exista un consumo
                    real.
                  </span>
                </p>
              </div>
            )}
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por correlativo MER..."
                className="h-10 w-full rounded-xl border border-theme-border bg-theme-surface pl-10 pr-3 text-sm text-theme-text outline-none focus:border-theme-accent"
              />
            </div>
            {loading ? (
              <Loading />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-theme-border">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                    <tr>
                      {(
                        [
                          ["MER", "request_code"],
                          ["Fecha", "created_at"],
                          ["Solicitante", "requester_name"],
                          ["Líneas", "line_count"],
                          ["Unidades", "total_quantity"],
                          ["Estado", "status"],
                        ] as const
                      ).map(([head, key]) => (
                        <th key={head} className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => {
                              setDescending(
                                requestSort === key ? !descending : false,
                              );
                              setRequestSort(key);
                            }}
                            className="hover:text-theme-text"
                          >
                            {head}
                          </button>
                        </th>
                      ))}
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRequests.map((request) => (
                      <tr
                        key={request.id}
                        className={`border-t border-theme-border/70 ${request.status === "CANCELADA" ? "bg-red-500/[0.035]" : ""}`}
                      >
                        <td className="px-4 py-3 font-mono font-semibold text-theme-text">
                          {request.request_code}
                        </td>
                        <td className="px-4 py-3 text-theme-text-muted">
                          {new Date(request.created_at).toLocaleString("es-CL")}
                        </td>
                        <td className="px-4 py-3 text-theme-text-muted">
                          {request.requester_name}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-theme-text-muted">
                          {request.line_count}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-theme-text-muted">
                          {request.total_quantity}
                        </td>
                        <td className="px-4 py-3">
                           <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${request.status === "CANCELADA" ? "border-red-500/25 bg-red-500/10 text-red-600" : request.status === "FINALIZADA" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-theme-border text-theme-text-muted"}`}>
                             {displayMermaStatus(request.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() =>
                              router.push(
                                `/dashboard/logistica/mermas/${request.id}`,
                              )
                            }
                            className="text-xs font-semibold text-theme-text-accent hover:underline"
                          >
                            Abrir detalle
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {tab === "authorization" ? (
          <MermasAuthorizationPanel />
        ) : tab === "archived" ? (
          <MermasArchivedPanel />
        ) : (
          tab === "warehouse" &&
          (loading ? (
            <Loading />
          ) : (
            <section className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-theme-text-muted">
                  Stock consolidado por producto · doble clic para ver trazabilidad
                </p>
                <div className="relative w-full sm:w-72">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
                  <input
                    value={warehouseSearch}
                    onChange={(event) => setWarehouseSearch(event.target.value)}
                    placeholder="Buscar SKU o producto..."
                    className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-xs text-theme-text outline-none focus:border-theme-accent"
                  />
                </div>
              </div>
              <div className="overflow-x-auto rounded-xl border border-theme-border">
                <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                  <tr>
                    {(
                      [
                        ["SKU", "sku"],
                        ["Producto", "product_name"],
                        ["Disponible", "available"],
                        ["Próx. vencimiento", "next_expiration"],
                        ["Estado vencimiento", "expiration_status"],
                        ["Partidas", "lot_count"],
                        ["Último ingreso", "last_entry_at"],
                      ] as const
                    ).map(([head, key]) => (
                      <th key={head} className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() => {
                            setWarehouseDescending(
                              warehouseSort === key
                                ? !warehouseDescending
                                : false,
                            );
                            setWarehouseSort(key);
                          }}
                           className="inline-flex items-center gap-1 hover:text-theme-text"
                        >
                          {head}
                          {warehouseSort === key ? (
                            warehouseDescending ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />
                          ) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                        </button>
                      </th>
                    ))}
                    <th className="px-3 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {sortedWarehouse.map((row) => {
                    const statusClass = row.expiration_status === "VENCIDO"
                      ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300"
                      : row.expiration_status === "POR VENCER"
                        ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
                    return (
                      <tr
                        key={row.variant_id}
                        onDoubleClick={() => setSelectedWarehouseProduct(row)}
                        className="cursor-pointer border-t border-theme-border/70 transition-colors hover:bg-theme-text/[0.025]"
                      >
                        <td className="px-3 py-2 font-mono font-semibold text-theme-text">
                          {row.sku}
                        </td>
                        <td className="px-3 py-2 text-theme-text-muted">
                          {row.product_name}
                        </td>
                        <td className="px-3 py-2 tabular-nums font-semibold text-theme-text">
                          {row.available}
                        </td>
                        <td className="px-3 py-2 text-theme-text-muted">
                          {row.next_expiration ? formatCivilDate(row.next_expiration) : "-"}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${statusClass}`}>
                            {row.expiration_status}
                          </span>
                        </td>
                        <td className="px-3 py-2 tabular-nums text-theme-text-muted">
                          {row.lot_count}
                        </td>
                        <td className="px-3 py-2 text-theme-text-muted">
                          {formatStoredDate(row.last_entry_at) || "-"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedWarehouseProduct(row)}
                            className="text-[11px] font-semibold text-theme-text-accent hover:underline"
                          >
                            Trazabilidad
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                </table>
              </div>
              {!sortedWarehouse.length && (
                <p className="rounded-lg border border-dashed border-theme-border px-3 py-8 text-center text-xs text-theme-text-muted">
                  No hay productos que coincidan con la búsqueda.
                </p>
              )}
            </section>
          ))
        )}
      </div>
      {selectedWarehouseProduct && (
        <MermaWarehouseTraceabilityDialog
          product={selectedWarehouseProduct}
          onClose={() => setSelectedWarehouseProduct(null)}
        />
      )}
        {incidentsOpen && (
          <MermaBsaleIncidentsDialog
            incidents={bsaleIncidents}
            onClose={() => setIncidentsOpen(false)}
            onCreated={(requestCode) => {
              setIncidentsOpen(false);
              setMessage(`${requestCode} creada correctamente.`);
              void load();
              router.push("/dashboard/logistica/mermas");
              router.refresh();
            }}
          />
        )}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-16 text-sm text-theme-text-muted">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Cargando...
    </div>
  );
}

function MermaBsaleIncidentsDialog({
  incidents,
  onClose,
  onCreated,
}: {
  incidents: MermaBsaleIncident[];
  onClose: () => void;
  onCreated: (requestCode: string) => void;
}) {
  type DraftIncidentLine = MermaBsaleIncident["details"][number] & {
    reason: string;
    expiration_date: string;
    lot: string;
    observation: string;
    evidence: File[];
  };
  const [selectedId, setSelectedId] = useState<number | null>(incidents[0]?.consumption_id ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const [draftLines, setDraftLines] = useState<DraftIncidentLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const selected = incidents.find((incident) => incident.consumption_id === selectedId) ?? null;
  function draftLinesFor(incident: MermaBsaleIncident | null) {
    return incident?.details.map((detail) => ({
      ...detail,
      reason: "",
      expiration_date: "",
      lot: "",
      observation: "",
      evidence: [],
    })) ?? [];
  }
  function selectIncident(incident: MermaBsaleIncident) {
    setSelectedId(incident.consumption_id);
    setFormOpen(false);
    setSaveError("");
    setDraftLines(draftLinesFor(incident));
  }
  function updateDraftLine(index: number, patch: Partial<DraftIncidentLine>) {
    setSaveError("");
    setDraftLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line));
  }
  function isValidExpirationDate(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  const allLinesComplete = draftLines.length > 0 && draftLines.every((line) => (
    line.reason.trim().length > 0
    && isValidExpirationDate(line.expiration_date)
    && line.evidence.length > 0
  ));
  const saveDisabled = saving || Boolean(uploadStatus) || Boolean(saveError) || !allLinesComplete;
  async function saveIncident() {
    if (!selected) return;
    setSaveError("");
    if (draftLines.some((line) => !line.reason.trim() || !line.expiration_date || !line.evidence.length)) {
      setSaveError("Completa motivo, vencimiento y al menos una evidencia en cada línea.");
      return;
    }
    setSaving(true);
    let session: { session_id: string; session_token: string; finalize_token: string } | null = null;
    const uploadedPaths: string[] = [];
    try {
      const sourceFiles = draftLines.flatMap((line, lineIndex) => line.evidence.map((file) => ({ file, lineIndex })));
      const fileMetadata = sourceFiles.map(({ file, lineIndex }) => ({ line_index: lineIndex, file_name: file.name, mime_type: file.type, file_size: file.size }));
      const prepared = await prepareMermaIncidentEvidenceUploads(selected.consumption_id, draftLines.map((line) => ({ detail_id: line.detail_id, variant_id: line.variant_id, quantity: line.quantity, reason: line.reason, expiration_date: line.expiration_date, lot: line.lot, observation: line.observation })), fileMetadata);
      if (prepared.error || !prepared.data) throw new Error(prepared.error ?? "No se pudo preparar la evidencia");
      session = prepared.data;
      const evidence: MermaEvidenceMetadata[] = [];
      for (const [index, upload] of prepared.data.uploads.entries()) {
        setUploadStatus(`Subiendo evidencia ${index + 1} de ${prepared.data.uploads.length}...`);
        await uploadMermaEvidence(upload, sourceFiles[index].file);
        uploadedPaths.push(upload.storage_path);
        evidence.push({ line_index: upload.line_index, storage_path: upload.storage_path, file_name: upload.file_name, mime_type: upload.mime_type, file_size: upload.file_size });
      }
      setUploadStatus("Guardando solicitud...");
      const result = await regularizeMermaBsaleIncident(selected.consumption_id, draftLines.map((line) => ({ detail_id: line.detail_id, variant_id: line.variant_id, quantity: line.quantity, reason: line.reason, expiration_date: line.expiration_date, lot: line.lot, observation: line.observation })), evidence, session.session_id, session.session_token, session.finalize_token);
      if (result.error) throw new Error(result.error);
      onCreated(result.request_code ?? "Nueva solicitud");
    } catch (error) {
      if (session && uploadedPaths.length) await cleanupMermaEvidenceUploads(session.session_id, session.session_token, uploadedPaths);
      setSaveError(error instanceof Error ? error.message : "No se pudo regularizar el consumo Bsale");
    } finally {
      setUploadStatus("");
      setSaving(false);
    }
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merma-bsale-incidents-title"
      onClick={onClose}
    >
      <div
        className="flex h-[min(760px,calc(100vh-3rem))] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-theme-border px-4 py-3">
          <div>
            <h2 id="merma-bsale-incidents-title" className="text-base font-semibold text-theme-text">
              Consumos Bsale pendientes de regularización
            </h2>
            <p className="mt-1 text-xs text-theme-text-muted">
              Una incidencia corresponde a un consumo Bsale completo, independiente de la cantidad de líneas.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-theme-text-muted hover:bg-theme-text/5" aria-label="Cerrar incidencias">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,0.48fr)_minmax(0,0.52fr)]">
          <div className="min-h-0 overflow-auto border-b border-theme-border lg:border-b-0 lg:border-r">
            <table className="w-full table-fixed text-xs">
              <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                <tr>
                  <th className="w-[22%] whitespace-nowrap px-3 py-2">Consumo</th>
                  <th className="w-[20%] whitespace-nowrap px-3 py-2">Fecha</th>
                  <th className="w-[16%] whitespace-nowrap px-3 py-2">Productos</th>
                  <th className="w-[16%] whitespace-nowrap px-3 py-2">Unidades</th>
                  <th className="w-[26%] whitespace-nowrap px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => (
                  <tr
                    key={incident.consumption_id}
                    onClick={() => selectIncident(incident)}
                    className={`cursor-pointer border-t border-theme-border/70 ${selectedId === incident.consumption_id ? "bg-theme-accent/10" : "hover:bg-theme-text/[0.025]"}`}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono font-semibold text-theme-text">#{incident.consumption_id}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-theme-text-muted">{formatStoredDate(incident.consumption_date) || "-"}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-theme-text-muted">{incident.product_count}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-theme-text-muted">{incident.total_quantity} un.</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex max-w-full rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-700 dark:text-red-300">{incident.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex min-h-0 min-w-0 flex-col p-4">
            {selected ? (formOpen ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="shrink-0 border-b border-theme-border pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Regularización consumo Bsale #{selected.consumption_id}</p>
                      <p className="mt-1 text-xs text-theme-text-muted">{formatStoredDate(selected.consumption_date)} · {selected.product_count} productos · {selected.total_quantity} unidades</p>
                    </div>
                    <button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border border-theme-border px-2.5 py-1.5 text-[10px] font-semibold text-theme-text-muted hover:bg-theme-text/5">Volver al detalle</button>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-theme-text-muted"><span className="font-semibold text-theme-text">Nota Bsale:</span> {selected.note || "Sin nota"}</p>
                </div>
                <div className="min-h-0 flex-1 overflow-auto py-3">
                  <div className="space-y-3">
                    {draftLines.map((line, index) => (
                      <div key={line.detail_id} className="rounded-lg border border-theme-border p-3">
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_80px]">
                          <div>
                            <p className="font-mono text-xs font-semibold text-theme-text">{line.sku}</p>
                            <p className="mt-0.5 text-xs text-theme-text-muted">{line.product_name}</p>
                          </div>
                          <label className="text-xs text-theme-text-muted">Cantidad<input value={line.quantity} disabled className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-text/[0.025] px-2 text-xs font-semibold text-theme-text" /></label>
                        </div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          <label className="text-xs text-theme-text-muted">Motivo *<input value={line.reason} onChange={(event) => updateDraftLine(index, { reason: event.target.value })} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-accent" /></label>
                          <label className="text-xs text-theme-text-muted">Vencimiento *<input type="date" value={line.expiration_date} onChange={(event) => updateDraftLine(index, { expiration_date: event.target.value })} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-accent" /></label>
                          <label className="text-xs text-theme-text-muted">Lote opcional<input value={line.lot} onChange={(event) => updateDraftLine(index, { lot: event.target.value })} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-accent" /></label>
                          <label className="text-xs text-theme-text-muted">Observación opcional<input value={line.observation} onChange={(event) => updateDraftLine(index, { observation: event.target.value })} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-accent" /></label>
                        </div>
                        <label className="mt-2 block text-xs text-theme-text-muted">Evidencia fotográfica *<input type="file" accept="image/jpeg,image/png,image/webp,image/heic" multiple onChange={(event) => updateDraftLine(index, { evidence: Array.from(event.target.files ?? []) })} className="mt-1 block w-full text-xs text-theme-text file:mr-2 file:rounded-md file:border-0 file:bg-theme-text/5 file:px-2 file:py-1 file:text-xs file:font-semibold file:text-theme-text" /></label>
                        <p className="mt-1 text-[11px] text-theme-text-muted">{line.evidence.length ? `${line.evidence.length} archivo(s) seleccionado(s)` : "Debes adjuntar al menos una fotografía."}</p>
                      </div>
                    ))}
                  </div>
                  {saveError && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-600">{saveError}</p>}
                </div>
                <div className="flex shrink-0 items-center justify-between gap-3 border-t border-theme-border pt-3">
                  <span className="text-xs text-theme-text-muted">{uploadStatus || "Producto y cantidad provienen de Bsale y no se pueden editar."}</span>
                   <div className="flex flex-col items-end gap-1">
                     {saveDisabled && !saving && !saveError && <span className="text-[11px] text-theme-text-muted">Completa los campos obligatorios de todas las líneas.</span>}
                     <button type="button" disabled={saveDisabled} onClick={() => void saveIncident()} className="rounded-lg bg-theme-accent px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? "Guardando..." : "GUARDAR SOLICITUD"}</button>
                   </div>
                </div>
              </div>
            ) : (
              <>
                <div className="shrink-0 border-b border-theme-border pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-mono text-sm font-semibold text-theme-text">Consumo Bsale #{selected.consumption_id}</h3>
                    <span className="rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-700 dark:text-red-300">{selected.status}</span>
                  </div>
                  <div className="mt-2 grid gap-2 text-xs text-theme-text-muted sm:grid-cols-3">
                    <span>Fecha: <strong className="text-theme-text">{formatStoredDate(selected.consumption_date) || "-"}</strong></span>
                    <span>Productos: <strong className="text-theme-text">{selected.product_count}</strong></span>
                    <span>Unidades: <strong className="text-theme-text">{selected.total_quantity}</strong></span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-theme-text-muted">
                    <span className="font-semibold text-theme-text">Nota Bsale:</span> {selected.note || "Sin nota"}
                  </p>
                </div>
                <h4 className="mt-4 shrink-0 text-xs font-bold uppercase tracking-wide text-theme-text-muted">Detalles del consumo</h4>
                <div className="mt-2 min-h-0 flex-1 overflow-auto rounded-lg border border-theme-border">
                  <table className="w-full min-w-[420px] text-xs">
                    <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                      <tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2">Cantidad</th></tr>
                    </thead>
                    <tbody>
                      {selected.details.map((detail) => (
                        <tr key={detail.detail_id} className="border-t border-theme-border/70">
                          <td className="px-3 py-2 font-mono text-theme-text">{detail.sku}</td>
                          <td className="px-3 py-2 text-theme-text-muted">{detail.product_name}</td>
                          <td className="px-3 py-2 tabular-nums text-theme-text">{detail.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex shrink-0 items-center justify-between gap-3 border-t border-theme-border pt-3">
                  <span className="text-xs text-theme-text-muted">{selected.status === "SIN SOLICITUD" ? "Consumo listo para regularización." : "Requiere revisión por asociación inconsistente."}</span>
                  <button type="button" disabled={selected.status !== "SIN SOLICITUD"} onClick={() => { setDraftLines(draftLinesFor(selected)); setFormOpen(true); }} className="rounded-lg border border-theme-accent bg-theme-accent/10 px-3 py-2 text-[10px] font-semibold text-theme-text-accent disabled:cursor-not-allowed disabled:border-theme-border disabled:bg-transparent disabled:text-theme-text-muted disabled:opacity-60">CREAR SOLICITUD</button>
                </div>
              </>
            )) : <p className="text-xs text-theme-text-muted">Selecciona un consumo para revisar sus detalles.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function MermaWarehouseTraceabilityDialog({
  product,
  onClose,
}: {
  product: MermaWarehouseProduct;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merma-traceability-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-theme-border px-4 py-3">
          <div className="min-w-0">
            <h2 id="merma-traceability-title" className="text-base font-semibold text-theme-text">
              Trazabilidad de producto
            </h2>
            <p className="mt-1 truncate text-sm text-theme-text">
              <span className="font-mono font-semibold">{product.sku}</span> · {product.product_name}
            </p>
            <p className="mt-0.5 text-xs text-theme-text-muted">
              Disponible: <strong className="text-theme-text">{product.available}</strong> · Próximo vencimiento: <strong className="text-theme-text">{product.next_expiration ? formatCivilDate(product.next_expiration) : "-"}</strong>
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-theme-text-muted hover:bg-theme-text/5" aria-label="Cerrar trazabilidad">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-theme-text-muted">Partidas disponibles</h3>
            <div className="mt-2 overflow-x-auto rounded-lg border border-theme-border">
              <table className="w-full min-w-[680px] text-xs">
                <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                  <tr>
                    <th className="px-3 py-2">Disponible</th>
                    <th className="px-3 py-2">Vencimiento</th>
                    <th className="px-3 py-2">Estado</th>
                    <th className="px-3 py-2">Lote</th>
                    <th className="px-3 py-2">Solicitud origen</th>
                    <th className="px-3 py-2">Fecha ingreso</th>
                  </tr>
                </thead>
                <tbody>
                  {product.lots.map((lot) => (
                    <tr key={lot.id} className="border-t border-theme-border/70">
                      <td className="px-3 py-2 tabular-nums font-semibold text-theme-text">{lot.available}</td>
                      <td className="px-3 py-2 text-theme-text-muted">{lot.expiration_date ? formatCivilDate(lot.expiration_date) : "-"}</td>
                      <td className="px-3 py-2 text-theme-text-muted">{getWarehouseExpirationStatus(lot.expiration_date)}</td>
                      <td className="px-3 py-2 text-theme-text-muted">{lot.lot || "-"}</td>
                      <td className="px-3 py-2 font-mono text-theme-text">{lot.request_code || "-"}</td>
                      <td className="px-3 py-2 text-theme-text-muted">{formatStoredDate(lot.entered_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="mt-5">
            <h3 className="text-xs font-bold uppercase tracking-wide text-theme-text-muted">Historial de movimientos</h3>
            <div className="mt-2 overflow-x-auto rounded-lg border border-theme-border">
              <table className="w-full min-w-[1050px] text-xs">
                <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                  <tr>
                    <th className="px-3 py-2">Fecha</th>
                    <th className="px-3 py-2">Movimiento</th>
                    <th className="px-3 py-2">Cantidad</th>
                    <th className="px-3 py-2">Saldo</th>
                    <th className="px-3 py-2">Origen / destino</th>
                    <th className="px-3 py-2">Referencia</th>
                    <th className="px-3 py-2">Usuario</th>
                    <th className="px-3 py-2">Evidencia</th>
                  </tr>
                </thead>
                <tbody>
                  {product.history.map((entry) => (
                    <tr key={entry.id} className="border-t border-theme-border/70 align-top">
                      <td className="whitespace-nowrap px-3 py-2 text-theme-text-muted">{formatStoredDate(entry.occurred_at)}</td>
                      <td className="px-3 py-2 font-semibold text-theme-text">{entry.movement_type}</td>
                      <td className="px-3 py-2 tabular-nums text-theme-text">{entry.quantity > 0 ? "+" : ""}{entry.quantity}</td>
                      <td className="px-3 py-2 tabular-nums font-semibold text-theme-text">{entry.balance}</td>
                      <td className="px-3 py-2 text-theme-text-muted">{entry.origin}</td>
                      <td className="px-3 py-2 text-theme-text-muted">{entry.reference || "-"}{entry.consumption_id ? <span className="block font-mono">Bsale #{entry.consumption_id} · detalle {entry.detail_id}</span> : null}</td>
                      <td className="px-3 py-2 text-theme-text-muted">{entry.user_name}</td>
                      <td className="px-3 py-2"><MermaEvidenceViewer evidence={entry.evidence} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function getWarehouseExpirationStatus(date: string | null) {
  if (!date) return "VIGENTE";
  const today = new Date().toISOString().slice(0, 10);
  const warning = new Date(`${today}T00:00:00Z`);
  warning.setUTCDate(warning.getUTCDate() + 30);
  if (date < today) return "VENCIDO";
  if (date <= warning.toISOString().slice(0, 10)) return "POR VENCER";
  return "VIGENTE";
}

// Legacy list kept temporarily for compatibility with the existing module bundle.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MermaList() {
  const router = useRouter();
  const [requests, setRequests] = useState<MermaRequest[]>([]);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([getMermasRequests(search), getPendingMermasCount()]).then(
      ([result, count]) => {
        if (!active) return;
        setRequests(result.data);
        setPending(count);
        setError(result.error ?? "");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [search]);

  return (
    <div className="min-h-[calc(100vh-7.5rem)] bg-theme-surface">
      <PanelHeader
        title="Mermas"
        description="Solicitudes pendientes de gestión Bsale"
        action={
          <button
            onClick={() => router.push("/dashboard/logistica/mermas/nueva")}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 py-2.5 text-xs font-semibold text-white hover:bg-theme-accent-hover"
          >
            <Plus className="h-4 w-4" /> Nueva solicitud
          </button>
        }
      />
      <div className="space-y-4 p-5">
        {pending > 0 && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            <span className="mt-0.5 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white">
              {pending}
            </span>
            <div>
              <p className="font-semibold">
                Solicitudes pendientes de gestionar en Bsale
              </p>
              <p className="mt-0.5 text-xs opacity-80">
                Estas solicitudes están listas para ser revisadas y replicadas
                manualmente en Bsale.
              </p>
            </div>
          </div>
        )}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por correlativo MER..."
            className="h-10 w-full rounded-xl border border-theme-border bg-theme-surface pl-10 pr-3 text-sm text-theme-text outline-none focus:border-theme-accent"
          />
        </div>
        {error && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm text-theme-text-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Cargando solicitudes...
          </div>
        ) : requests.length === 0 ? (
          <div className="rounded-xl border border-dashed border-theme-border p-12 text-center text-sm text-theme-text-muted">
            No hay solicitudes registradas para la empresa activa.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-theme-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                <tr>
                  <th className="px-4 py-3">MER</th>
                  <th className="px-4 py-3">Fecha</th>
                  <th className="px-4 py-3">Solicitante</th>
                  <th className="px-4 py-3">Líneas</th>
                  <th className="px-4 py-3">Unidades</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr
                    key={request.id}
                    className="border-t border-theme-border/70"
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-theme-text">
                      {request.request_code}
                    </td>
                    <td className="px-4 py-3 text-theme-text-muted">
                      {new Date(request.created_at).toLocaleString("es-CL")}
                    </td>
                    <td className="px-4 py-3 text-theme-text-muted">
                      {request.requester_name}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-theme-text-muted">
                      {request.line_count}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-theme-text-muted">
                      {request.total_quantity}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          request.status === "CANCELADA"
                            ? "rounded-md border border-slate-500/30 bg-slate-500/10 px-2 py-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300"
                            : "rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                        }
                      >
                        {request.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() =>
                          router.push(
                            `/dashboard/logistica/mermas/${request.id}`,
                          )
                        }
                        className="text-xs font-semibold text-theme-text-accent hover:underline"
                      >
                        Abrir detalle
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Legacy inline form kept temporarily for compatibility with the existing module bundle.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function NewMerma() {
  const router = useRouter();
  const productInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [context, setContext] = useState<{
    companyName: string;
    requesterName: string;
  } | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  useEffect(() => {
    getMermasContext()
      .then(setContext)
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : "No se pudo cargar el contexto",
        ),
      );
  }, []);

  function update(index: number, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    const invalid = lines.some(
      (line) =>
        !line.product ||
        Number(line.quantity) <= 0 ||
        !line.reason.trim() ||
        !line.expiration_date,
    );
    if (!lines.length || invalid) {
      setError(
        "Completa producto, cantidad mayor que cero, motivo y vencimiento en todas las líneas.",
      );
      return;
    }
    setSaving(true);
    const result = await createMermaRequest(
      lines.map((line) => ({
        variant_id: line.product!.id,
        quantity: line.quantity,
        reason: line.reason,
        expiration_date: line.expiration_date,
        lot: line.lot,
        observation: line.observation,
      })),
    );
    setSaving(false);
    if (result.error) {
      setError("No se pudo guardar la solicitud: " + result.error);
      return;
    }
    setSuccess(
      `Solicitud ${result.request_code} creada correctamente. Estado: PENDIENTE`,
    );
        router.push("/dashboard/logistica/mermas");
  }

  return (
    <div className="bg-theme-surface">
      <PanelHeader
        title="Nueva solicitud de Merma"
        description="Registra los productos que Bsale debe gestionar manualmente"
        action={
          <button
            onClick={() => router.push("/dashboard/logistica/mermas")}
            className="inline-flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5"
          >
            <ArrowLeft className="h-4 w-4" /> Volver
          </button>
        }
      />
      <form onSubmit={submit} className="space-y-5 p-5">
        <div className="grid gap-3 rounded-xl border border-theme-border bg-theme-text/[0.018] p-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-theme-text-muted">
              Empresa activa
            </p>
            <p className="mt-1 font-semibold text-theme-text">
              {context?.companyName ?? "Cargando..."}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-theme-text-muted">
              Solicitante
            </p>
            <p className="mt-1 font-semibold text-theme-text">
              {context?.requesterName ?? "Cargando..."}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-theme-text-muted">
              Fecha de solicitud
            </p>
            <p className="mt-1 font-semibold text-theme-text">
              {new Date().toLocaleDateString("es-CL")}
            </p>
          </div>
        </div>
        {success && (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
            {success}
          </p>
        )}
        {error && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="space-y-2">
          {lines.map((line, index) => (
            <MermaLineEditor
              key={index}
              line={line}
              index={index}
              update={update}
              inputRef={(node) => {
                productInputRefs.current[index] = node;
              }}
              remove={() =>
                setLines((current) => current.filter((_, i) => i !== index))
              }
              canRemove={lines.length > 1}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            const nextIndex = lines.length;
            setLines((current) => [...current, blankLine()]);
            requestAnimationFrame(() =>
              productInputRefs.current[nextIndex]?.focus(),
            );
          }}
          className="inline-flex items-center gap-2 rounded-xl border border-dashed border-theme-accent/50 px-4 py-2 text-xs font-semibold text-theme-text-accent hover:bg-theme-accent/5"
        >
          <Plus className="h-4 w-4" /> Agregar producto
        </button>
        <div className="flex justify-end border-t border-theme-border pt-4">
          <button
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-theme-accent px-5 py-2.5 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Guardar
            solicitud
          </button>
        </div>
      </form>
    </div>
  );
}

function MermaLineEditor({
  line,
  index,
  update,
  inputRef,
  remove,
  canRemove,
}: {
  line: DraftLine;
  index: number;
  update: (index: number, patch: Partial<DraftLine>) => void;
  inputRef: (node: HTMLInputElement | null) => void;
  remove: () => void;
  canRemove: boolean;
}) {
  // Debounce only when the user changes the search text; parent callbacks are intentionally transient.
  useEffect(() => {
    if (line.product || line.search.trim().length < 2) {
      update(index, { results: [] });
      return;
    }
    const timer = setTimeout(async () => {
      update(index, { searching: true });
      const result = await searchMermasProducts(line.search);
      update(index, { results: result.data, searching: false });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.search]);
  return (
    <div className="rounded-xl border border-theme-border px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">
          Línea {index + 1}
        </p>
        {canRemove && (
          <button
            type="button"
            onClick={remove}
            className="inline-flex items-center gap-1 text-xs text-red-500/80 hover:text-red-500 hover:underline"
          >
            <Trash2 className="h-3.5 w-3.5" /> Eliminar
          </button>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(90px,0.35fr)_minmax(220px,1.8fr)_minmax(160px,1fr)_minmax(120px,0.8fr)]">
        <div className="relative md:col-span-2 xl:col-span-4">
          <label className="mb-1 block text-[11px] font-medium text-theme-text-muted">
            Producto Bsale *
          </label>
          {line.product ? (
            <div className="flex min-h-9 items-center justify-between gap-3 rounded-lg border border-theme-accent/40 bg-theme-accent/5 px-3 py-1.5 text-sm">
              <span className="min-w-0 truncate">
                <strong className="font-mono font-semibold text-theme-text">
                  {line.product.sku}
                </strong>
                <span className="ml-3 text-theme-text-muted">
                  {line.product.product_name || line.product.description}
                </span>
              </span>
              <button
                type="button"
                onClick={() => update(index, { product: null, search: "" })}
                className="shrink-0 text-xs font-medium text-theme-text-accent hover:underline"
              >
                Cambiar
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
                <input
                  ref={inputRef}
                  value={line.search}
                  onChange={(e) => update(index, { search: e.target.value })}
                  placeholder="Buscar por SKU, descripción o código de barras..."
                  className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-10 pr-3 text-sm text-theme-text outline-none focus:border-theme-accent"
                />
                {line.searching && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-theme-text-muted" />
                )}
              </div>
              {line.results.length > 0 && (
                <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-theme-border bg-theme-surface shadow-xl">
                  {line.results.map((product) => (
                    <button
                      type="button"
                      key={product.id}
                      onClick={() =>
                        update(index, { product, results: [], search: "" })
                      }
                      className="block w-full border-b border-theme-border/60 px-3 py-1.5 text-left text-xs hover:bg-theme-text/5"
                    >
                      <span className="font-mono font-semibold text-theme-text">
                        {product.sku}
                      </span>
                      <span className="ml-3 text-theme-text-muted">
                        {product.product_name ||
                          product.description ||
                          "Sin descripción"}
                      </span>
                      {product.barcode && (
                        <span className="ml-3 text-theme-text-muted/70">
                          {product.barcode}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <Field label="Cantidad *">
          <input
            type="number"
            min="0.001"
            step="0.001"
            value={line.quantity}
            onChange={(e) => update(index, { quantity: e.target.value })}
            className="control"
          />
        </Field>
        <Field label="Motivo *">
          <input
            value={line.reason}
            onChange={(e) => update(index, { reason: e.target.value })}
            placeholder="Ej. Envase roto"
            className="control"
          />
        </Field>
        <Field label="Fecha de vencimiento *">
          <div className="relative">
            <CalendarDays className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
            <input
              type="date"
              value={line.expiration_date}
              onChange={(e) =>
                update(index, { expiration_date: e.target.value })
              }
              className="control pl-10"
            />
          </div>
        </Field>
        <Field label="Lote opcional">
          <input
            value={line.lot}
            onChange={(e) => update(index, { lot: e.target.value })}
            className="control"
          />
        </Field>
        <div className="md:col-span-2 xl:col-span-4">
          <Field label="Observación opcional">
            <input
              value={line.observation}
              onChange={(e) => update(index, { observation: e.target.value })}
              className="control"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-theme-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function MermaDetail({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [request, setRequest] = useState<MermaRequest | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [candidates, setCandidates] = useState<Awaited<ReturnType<typeof getMermasBsaleCandidates>>["data"]>([]);
  const [selectedConsumption, setSelectedConsumption] = useState<number | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizationError, setAuthorizationError] = useState("");
  useEffect(() => {
    getMermasRequest(requestId).then((result) => {
      setRequest(result.data);
      setError(result.error ?? "");
      if (result.data?.status === "PENDIENTE" && !result.data.bsale_association) {
        getMermasBsaleCandidates(requestId).then((candidateResult) => {
          setCandidates(candidateResult.data);
          setAuthorizationError(candidateResult.error ?? "");
        }).catch((candidateError) => {
          setAuthorizationError(candidateError instanceof Error ? candidateError.message : "No se pudieron cargar consumos Bsale");
        });
      } else {
        setCandidates([]);
        setSelectedConsumption(null);
      }
    });
  }, [requestId]);
  async function authorizeSelectedConsumption() {
    const consumptionId = request?.bsale_association?.consumption_id ?? selectedConsumption;
    if (consumptionId === null || consumptionId === undefined) return;
    setAuthorizing(true);
    setAuthorizationError("");
    const result = await authorizeMermaRequestWithConsumption(requestId, consumptionId);
    setAuthorizing(false);
    if (result.error) {
      setAuthorizationError(result.error);
      return;
    }
    router.push("/dashboard/logistica/mermas");
  }
  async function cancel() {
    setCancelError("");
    if (!reason.trim()) {
      setCancelError("Debes ingresar un motivo de cancelación.");
      return;
    }
    setCancelling(true);
    let result: { success?: boolean; error?: string };
    try {
      result = await cancelMermaRequest(requestId, reason);
    } catch {
      setCancelling(false);
      setCancelError("No tienes permiso para cancelar solicitudes de Merma");
      return;
    }
    setCancelling(false);
    if (result.error) {
      setCancelError(result.error);
      return;
    }
    setRequest((current) =>
      current
        ? {
            ...current,
            status: "CANCELADA",
            cancellation_reason: reason.trim(),
            cancelled_at: new Date().toISOString(),
          }
        : current,
    );
    setCancelDialogOpen(false);
    setReason("");
  }
  if (error)
    return (
      <div className="bg-theme-surface">
        <PanelHeader
          title="Detalle de solicitud"
          description="Solicitud de merma"
          action={
            <button
              onClick={() => router.push("/dashboard/logistica/mermas")}
              className="inline-flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted"
            >
              <ArrowLeft className="h-4 w-4" /> Volver a solicitudes
            </button>
          }
        />
        <p className="m-5 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      </div>
    );
  if (!request)
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-theme-text-muted" />
      </div>
    );
  return (
    <div className="bg-theme-surface">
      <PanelHeader
        title={request.request_code}
        description={`${request.status} · ${request.requester_name} · ${request.company_name} · ${formatInstantInSantiago(request.created_at)}`}
        action={
          <div className="flex shrink-0 flex-wrap gap-2">
            {request.status === "PENDIENTE" && request.can_cancel && (
              <button
                type="button"
                onClick={() => {
                  setCancelError("");
                  setCancelDialogOpen(true);
                }}
                className="rounded-lg border border-red-500/30 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-500/5 dark:text-red-300"
              >
                Cancelar solicitud
              </button>
            )}
            <button
              type="button"
              onClick={() => router.push("/dashboard/logistica/mermas")}
              className="inline-flex items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5"
            >
              <ArrowLeft className="h-4 w-4" /> Volver a solicitudes
            </button>
          </div>
        }
      />
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        {request.status === "PENDIENTE" && (
          <div className="hidden rounded-xl border border-red-500/25 bg-red-500/5 p-4">
            <p className="text-sm font-semibold text-theme-text">
              Cancelar solicitud
            </p>
            <p className="mt-1 text-xs text-theme-text-muted">
              La cancelación es irreversible y quedará registrada en auditoría.
            </p>
            <div className="mt-3 space-y-2">
              <label
                htmlFor="merma-cancellation-reason"
                className="block text-xs font-semibold text-theme-text"
              >
                Motivo de cancelación *
              </label>
              <textarea
                id="merma-cancellation-reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (cancelError) setCancelError("");
                }}
                placeholder="Ej. Producto sin stock disponible en Bsale"
                rows={2}
                aria-invalid={Boolean(cancelError)}
                aria-describedby={
                  cancelError ? "merma-cancellation-error" : undefined
                }
                className="min-h-20 w-full cursor-text resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2.5 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/60 focus:border-red-500 focus:ring-2 focus:ring-red-500/20"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={cancel}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cancelling && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
                  Cancelar solicitud
                </button>
              </div>
            </div>
            {cancelError && (
              <p
                id="merma-cancellation-error"
                className="mt-2 text-xs font-medium text-red-600"
              >
                {cancelError}
              </p>
            )}
          </div>
        )}
        {request.bsale_association && (
          <div className="rounded-xl border border-theme-border bg-theme-text/[0.018] p-4">
            <p className="text-sm font-semibold uppercase text-theme-text">MOVIMIENTO BSALE ASOCIADO</p>
            <div className="mt-3 grid gap-3 text-xs text-theme-text-muted sm:grid-cols-2 lg:grid-cols-3">
              <span>
                Consumo {" "}
                <strong className="font-mono text-theme-text">
                  #{request.bsale_association.consumption_id}
                </strong>
              </span>
              <span>
                Fecha:{" "}
                <strong className="text-theme-text">
                  {formatBsaleConsumptionDate(
                    request.bsale_association.consumption_date,
                  ) || "-"}
                </strong>
              </span>
              <span>
                Líneas:{" "}
                <strong className="text-theme-text">
                  {request.bsale_association.line_count}
                </strong>
              </span>
              <span className="sm:col-span-2">
                Nota:{" "}
                <strong className="text-theme-text">
                  {request.bsale_association.note || "Sin nota"}
                </strong>
              </span>
            </div>
            {request.status === "PENDIENTE" && (
              <div className="mt-3 flex flex-col items-end gap-2 border-t border-theme-border pt-3">
                {authorizationError && <p className="w-full rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{authorizationError}</p>}
                <button
                  type="button"
                  disabled={authorizing || !request.authorization_ready}
                  onClick={() => void authorizeSelectedConsumption()}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {authorizing ? "Autorizando..." : "AUTORIZAR INGRESO"}
                </button>
              </div>
            )}
          </div>
        )}
        {request.status === "PENDIENTE" && !request.bsale_association && (
          <div className="order-2 rounded-xl border border-theme-accent/30 bg-theme-accent/5 p-3">
            <p className="text-sm font-semibold text-theme-text">Movimiento Bsale</p>
            <p className="mt-1 text-xs text-theme-text-muted">
               Selecciona el consumo realizado en Bsale que corresponde a esta solicitud.
            </p>
            {authorizationError && (
              <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{authorizationError}</p>
            )}
            {!candidates.length ? (
              <p className="mt-3 text-xs text-theme-text-muted">No hay consumos Bsale compatibles disponibles.</p>
            ) : (
              <div className="mt-2 space-y-1">
                {candidates.map((candidate) => (
                  <label key={candidate.consumption_id} className={`block cursor-pointer rounded-md border px-2.5 py-2 ${selectedConsumption === candidate.consumption_id ? "border-theme-accent bg-theme-accent/10" : "border-theme-border bg-theme-surface"}`}>
                    <span className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="merma-bsale-consumption"
                        checked={selectedConsumption === candidate.consumption_id}
                        onChange={() => setSelectedConsumption(candidate.consumption_id)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 text-xs text-theme-text">
                        <strong className="font-mono">#{candidate.consumption_id}</strong>
                        <span className="ml-2 text-theme-text-muted">
                           {formatStoredDate(candidate.consumption_date) || "Fecha no informada"}
                        </span>
                        <span className="ml-2 text-theme-text-muted">
                          {candidate.details.map((detail) => {
                            const line = request.lines?.find((requestLine) => requestLine.sku === detail.sku);
                            return `${detail.sku}${line?.product_name ? ` · ${line.product_name}` : ""} · ${detail.quantity} un.`;
                          }).join(" · ")}
                        </span>
                        {candidate.note && <span className="mt-0.5 block text-[11px] text-theme-text-muted">Nota Bsale: {candidate.note}</span>}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                disabled={authorizing || selectedConsumption === null || !candidates.length}
                onClick={() => void authorizeSelectedConsumption()}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {authorizing ? "Autorizando..." : "AUTORIZAR INGRESO"}
              </button>
            </div>
          </div>
        )}
        <div className="order-1 overflow-x-auto rounded-xl border border-theme-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
              <tr>
                <th className="px-3 py-2">Producto / SKU</th>
                <th className="px-3 py-2">Cant.</th>
                <th className="px-3 py-2">Motivo</th>
                <th className="px-3 py-2">Vencimiento</th>
                <th className="px-3 py-2">Lote</th>
                <th className="px-3 py-2">Observación</th>
                <th className="px-3 py-2">Evidencia</th>
              </tr>
            </thead>
            <tbody>
              {request.lines?.map((line) => (
                <tr key={line.id} className="border-t border-theme-border/70">
                  <td className="px-3 py-2">
                    <strong className="font-mono text-theme-text">
                      {line.sku}
                    </strong>
                    <span className="ml-3 text-theme-text-muted">
                      {line.product_name}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-theme-text-muted">
                    {line.quantity}
                  </td>
                  <td className="px-3 py-2 text-theme-text-muted">
                    {line.reason}
                  </td>
                  <td className="px-3 py-2 text-theme-text-muted">
                    {formatCivilDate(line.expiration_date)}
                  </td>
                  <td className="px-3 py-2 text-theme-text-muted">
                    {line.lot || "-"}
                  </td>
                  <td className="px-3 py-2 text-theme-text-muted">
                    {line.observation || "-"}
                  </td>
                  <td className="px-3 py-2">
                    <MermaEvidenceViewer
                      evidence={(request.evidence ?? []).filter(
                        (photo) => photo.request_line_id === line.id,
                      )}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {cancelDialogOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="merma-cancel-title"
          >
            <div className="w-full max-w-md rounded-xl border border-red-500/25 bg-theme-surface p-4 shadow-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="merma-cancel-title" className="text-sm font-semibold text-theme-text">
                    Cancelar solicitud
                  </h2>
                  <p className="mt-1 text-xs text-theme-text-muted">
                    La cancelación es irreversible y quedará registrada en auditoría.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCancelDialogOpen(false)}
                  className="rounded-md p-1 text-theme-text-muted hover:bg-theme-text/5"
                  aria-label="Cerrar diálogo"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <label htmlFor="merma-cancellation-reason" className="mt-4 block text-xs font-semibold text-theme-text">
                Motivo de cancelación *
              </label>
              <textarea
                id="merma-cancellation-reason"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (cancelError) setCancelError("");
                }}
                placeholder="Indica el motivo"
                rows={3}
                aria-invalid={Boolean(cancelError)}
                aria-describedby={cancelError ? "merma-cancellation-error" : undefined}
                className="mt-1.5 min-h-20 w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/60 focus:border-red-500 focus:ring-2 focus:ring-red-500/20"
              />
              {cancelError && (
                <p id="merma-cancellation-error" className="mt-2 text-xs font-medium text-red-600">
                  {cancelError}
                </p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCancelDialogOpen(false)}
                  className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5"
                >
                  Volver
                </button>
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={() => void cancel()}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cancelling && <Loader2 className="h-4 w-4 animate-spin" />}
                  Confirmar cancelación
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Legacy detail kept temporarily for compatibility with the existing module bundle.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MermaDetailLegacy({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [request, setRequest] = useState<MermaRequest | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getMermasRequest(requestId).then((result) => {
      setRequest(result.data);
      setError(result.error ?? "");
    });
  }, [requestId]);
  return (
    <div className="bg-theme-surface">
      <PanelHeader
        title={request?.request_code ?? "Detalle de solicitud"}
         description="Solicitud de merma"
        action={
          <button
            onClick={() => router.push("/dashboard/logistica/mermas")}
            className="inline-flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5"
          >
            <ArrowLeft className="h-4 w-4" /> Volver a solicitudes
          </button>
        }
      />
      {error ? (
        <p className="m-5 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      ) : !request ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-theme-text-muted" />
        </div>
      ) : (
        <div className="space-y-5 p-5">
          <div className="rounded-xl border border-theme-accent/30 bg-theme-accent/5 p-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-text-muted">
               Detalle de solicitud
            </p>
            <p className="mt-2 font-mono text-2xl font-bold text-theme-text">
              {request.request_code}
            </p>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-theme-text-muted">
              <span>
                Estado:{" "}
                <strong className="text-amber-700 dark:text-amber-300">
                  {request.status}
                </strong>
              </span>
              <span>Empresa: {request.company_name}</span>
              <span>Solicitante: {request.requester_name}</span>
              <span>
                Creada: {new Date(request.created_at).toLocaleString("es-CL")}
              </span>
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border border-theme-border">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                <tr>
                  <th className="px-4 py-3">Producto / SKU</th>
                  <th className="px-4 py-3">Cantidad</th>
                  <th className="px-4 py-3">Motivo</th>
                  <th className="px-4 py-3">Vencimiento</th>
                  <th className="px-4 py-3">Lote</th>
                  <th className="px-4 py-3">Observación</th>
                </tr>
              </thead>
              <tbody>
                {request.lines?.map((line: MermaLine) => (
                  <tr key={line.id} className="border-t border-theme-border/70">
                    <td className="px-4 py-3">
                      <p className="font-medium text-theme-text">
                        {line.product_name}
                      </p>
                      <p className="font-mono text-xs text-theme-text-muted">
                        {line.sku}
                      </p>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-theme-text">
                      {line.quantity}
                    </td>
                    <td className="px-4 py-3 text-theme-text-muted">
                      {line.reason}
                    </td>
                    <td className="px-4 py-3 text-theme-text-muted">
                      {formatCivilDate(line.expiration_date)}
                    </td>
                    <td className="px-4 py-3 text-theme-text-muted">
                      {line.lot || "—"}
                    </td>
                    <td className="px-4 py-3 text-theme-text-muted">
                      {line.observation || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 text-xs text-theme-text-muted">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />{" "}
            {request.line_count} línea(s), {request.total_quantity} unidad(es)
            registradas.
          </div>
        </div>
      )}
    </div>
  );
}
