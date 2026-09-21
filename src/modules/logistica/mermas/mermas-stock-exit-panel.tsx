"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  correctMermasStockExit,
  createMermasStockExit,
  getMermasStockExitCatalog,
  getMermasStockExitOperationDetail,
  getMermasStockExitOperations,
  type MermaStockExitItem,
  type MermaStockExitOperation,
  type MermaStockExitOperationDetail,
  type MermaWarehouseListProduct,
} from "@/app/actions/logistica/mermas";
import { useMermasModule } from "./mermas-module-provider";

type ExitType = "SALIDA_DESTRUCCION" | "SALIDA_REGULACION";
type OperationType = "DESTRUCCION" | "REGULACION";
type PanelView = "history" | "new";
type CartLine = { product: MermaWarehouseListProduct; quantity: number };
type CorrectionLine = {
  variant_id: number;
  sku: string;
  product_name: string;
  quantity: number;
};

function operationTypeLabel(type: MermaStockExitOperation["operation_type"] | OperationType) {
  if (type === "DESTRUCCION") return "Destrucción";
  if (type === "REGULACION") return "Regularización";
  return "Reversa";
}

function operationStatusLabel(status: MermaStockExitOperation["status"]) {
  return status === "CORREGIDA" ? "Corregida" : "Vigente";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatQuantity(value: number) {
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 }).format(value);
}

export function MermasStockExitPanel() {
  const { bootstrap, invalidateWarehouse, ensureWarehouseLoaded } = useMermasModule();
  const [view, setView] = useState<PanelView>("history");
  const [operations, setOperations] = useState<MermaStockExitOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<MermaStockExitOperationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [correctionOpen, setCorrectionOpen] = useState(false);

  async function loadHistory(showLoading = true) {
    if (showLoading) setRefreshing(true);
    setError("");
    const response = await getMermasStockExitOperations();
    if (response.error) setError(response.error);
    setOperations(response.data);
    setLoading(false);
    setRefreshing(false);
  }

  useEffect(() => {
    let active = true;
    getMermasStockExitOperations().then((response) => {
      if (!active) return;
      if (response.error) setError(response.error);
      setOperations(response.data);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const visibleOperations = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase("es-CL");
    return operations
      .filter((operation) => operation.operation_type !== "REVERSA")
      .filter((operation) => !normalized || `${operation.reason} ${operation.created_by_name}`.toLocaleLowerCase("es-CL").includes(normalized));
  }, [operations, search]);

  async function openDetail(operationId: string) {
    setDetailLoading(true);
    setDetailError("");
    setCorrectionOpen(false);
    const response = await getMermasStockExitOperationDetail(operationId);
    if (response.error || !response.data) setDetailError(response.error ?? "No se pudo cargar el detalle.");
    setDetail(response.data);
    setDetailLoading(false);
  }

  async function refreshAfterMutation(successMessage: string) {
    setMessage(successMessage);
    setCorrectionOpen(false);
    await loadHistory(false);
    invalidateWarehouse();
    await ensureWarehouseLoaded(true);
    if (detail) await openDetail(detail.operation_id);
  }

  function startNewExit() {
    setMessage("");
    setError("");
    setView("new");
  }

  function showHistory() {
    setView("history");
    setCorrectionOpen(false);
    setMessage("");
  }

  return (
    <div className="min-h-[calc(100vh-9.5rem)] bg-theme-bg p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        {view === "new" ? (
          <MermasStockExitCreateForm
            onBack={showHistory}
            onCreated={() => {
              setView("history");
              void refreshAfterMutation("Salida registrada correctamente.");
            }}
          />
        ) : (
          <>
            <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">Mermas · Control de stock</p>
                <h2 className="mt-1 text-xl font-semibold text-theme-text">Historial de salidas</h2>
                <p className="mt-1 text-sm text-theme-text-muted">Consulta las salidas realizadas y su trazabilidad por lote.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void loadHistory()} disabled={refreshing} className="inline-flex h-10 items-center gap-2 rounded-xl border border-theme-border px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 disabled:opacity-50">
                  <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Actualizar
                </button>
                <button type="button" onClick={startNewExit} className="inline-flex h-10 items-center gap-2 rounded-xl bg-theme-accent px-4 text-xs font-semibold text-white hover:bg-theme-accent-hover">
                  <Plus className="h-4 w-4" /> Nueva salida
                </button>
              </div>
            </header>
            {message && <Notice tone="success">{message}</Notice>}
            {error && <Notice tone="error">{error}</Notice>}
            <section className="rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-theme-text">Salidas realizadas</h3>
                  <p className="mt-1 text-xs text-theme-text-muted">Las reversas se muestran sólo dentro de la trazabilidad de una corrección.</p>
                </div>
                <div className="relative w-full sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-theme-text-muted" />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar motivo o usuario..." className="h-9 w-full rounded-xl border border-theme-border bg-theme-bg pl-9 pr-3 text-xs text-theme-text outline-none focus:border-theme-accent" />
                </div>
              </div>
              {loading ? (
                <Loading label="Cargando historial..." />
              ) : visibleOperations.length ? (
                <div className="mt-4 overflow-x-auto rounded-xl border border-theme-border">
                  <table className="w-full min-w-[860px] text-xs">
                    <thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                      <tr>
                        <th className="px-3 py-3">Fecha</th>
                        <th className="px-3 py-3">Tipo</th>
                        <th className="px-3 py-3 text-right">Productos</th>
                        <th className="px-3 py-3 text-right">Unidades</th>
                        <th className="px-3 py-3">Motivo</th>
                        <th className="px-3 py-3">Usuario</th>
                        <th className="px-3 py-3">Estado</th>
                        <th className="px-3 py-3 text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleOperations.map((operation) => (
                        <tr key={operation.operation_id} className="border-t border-theme-border/70 align-top hover:bg-theme-accent/[0.035]">
                          <td className="whitespace-nowrap px-3 py-3 text-theme-text-muted">{formatDate(operation.created_at)}</td>
                          <td className="whitespace-nowrap px-3 py-3 font-semibold text-theme-text">{operationTypeLabel(operation.operation_type)}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-theme-text-muted">{operation.product_count}</td>
                          <td className="px-3 py-3 text-right tabular-nums font-semibold text-theme-text">{formatQuantity(operation.total_units)}</td>
                          <td className="max-w-[220px] px-3 py-3 text-theme-text">{operation.reason}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-theme-text-muted">{operation.created_by_name}</td>
                          <td className="px-3 py-3"><StatusBadge status={operation.status} /></td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-2">
                              <button type="button" onClick={() => void openDetail(operation.operation_id)} className="inline-flex items-center gap-1 rounded-lg border border-theme-border px-2.5 py-1.5 font-semibold text-theme-text-muted hover:border-theme-accent/50 hover:text-theme-text"><Eye className="h-3.5 w-3.5" /> Ver detalle</button>
                              {bootstrap.isSuperUser && operation.status === "VIGENTE" && operation.operation_type !== "REVERSA" && (
                                <button type="button" onClick={() => void openDetail(operation.operation_id).then(() => setCorrectionOpen(true))} className="inline-flex items-center gap-1 rounded-lg border border-theme-accent/40 bg-theme-accent/10 px-2.5 py-1.5 font-semibold text-theme-text-accent hover:bg-theme-accent/15"><Pencil className="h-3.5 w-3.5" /> Corregir</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-4 rounded-xl border border-dashed border-theme-border px-3 py-10 text-center text-xs text-theme-text-muted">No hay salidas que coincidan con la búsqueda.</p>
              )}
            </section>
            {detailLoading && <Loading label="Cargando detalle..." />}
            {detailError && <Notice tone="error">{detailError}</Notice>}
            {detail && !detailLoading && (
              <MermasStockExitDetail
                detail={detail}
                replacement={operations.find((operation) => operation.corrects_operation_id === detail.operation_id) ?? null}
                canCorrect={bootstrap.isSuperUser && detail.status === "VIGENTE" && detail.operation_type !== "REVERSA"}
                correctionOpen={correctionOpen}
                onClose={() => { setDetail(null); setCorrectionOpen(false); }}
                onCorrect={() => setCorrectionOpen(true)}
                onCancelCorrection={() => setCorrectionOpen(false)}
                onCorrected={() => void refreshAfterMutation("Salida corregida correctamente.")}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MermasStockExitDetail({
  detail,
  replacement,
  canCorrect,
  correctionOpen,
  onClose,
  onCorrect,
  onCancelCorrection,
  onCorrected,
}: {
  detail: MermaStockExitOperationDetail;
  replacement: MermaStockExitOperation | null;
  canCorrect: boolean;
  correctionOpen: boolean;
  onClose: () => void;
  onCorrect: () => void;
  onCancelCorrection: () => void;
  onCorrected: () => void;
}) {
  return (
    <section className="rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 border-b border-theme-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-theme-text">Detalle de salida</h3>
            <StatusBadge status={detail.status} />
          </div>
          <p className="mt-1 text-xs text-theme-text-muted">{formatDate(detail.created_at)} · {operationTypeLabel(detail.operation_type)}</p>
        </div>
        <div className="flex gap-2">
          {canCorrect && !correctionOpen && <button type="button" onClick={onCorrect} className="inline-flex items-center gap-1 rounded-lg bg-theme-accent px-3 py-2 text-xs font-semibold text-white hover:bg-theme-accent-hover"><Pencil className="h-3.5 w-3.5" /> Corregir</button>}
          <button type="button" onClick={onClose} aria-label="Cerrar detalle" className="rounded-lg border border-theme-border p-2 text-theme-text-muted hover:bg-theme-text/5"><X className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="mt-4 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Info label="Motivo" value={detail.reason} />
        <Info label="Usuario" value={detail.created_by_name} />
        <Info label="Observación" value={detail.observation || "-"} />
        <Info label="Estado" value={operationStatusLabel(detail.status)} />
      </div>
      {detail.status === "CORREGIDA" && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Esta salida fue corregida{replacement ? ` y reemplazada por una salida ${operationTypeLabel(replacement.operation_type)} del ${formatDate(replacement.created_at)}.` : "."}
        </div>
      )}
      <div className="mt-5">
        <h4 className="text-xs font-bold uppercase tracking-wide text-theme-text-muted">Productos</h4>
        <div className="mt-2 overflow-x-auto rounded-xl border border-theme-border">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2 text-right">Cantidad</th></tr></thead>
            <tbody>{detail.products.map((product) => <tr key={product.variant_id} className="border-t border-theme-border/70"><td className="px-3 py-2 font-mono text-theme-text">{product.sku}</td><td className="px-3 py-2 text-theme-text">{product.product_name}</td><td className="px-3 py-2 text-right tabular-nums font-semibold text-theme-text">{formatQuantity(product.quantity)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      <div className="mt-5">
        <h4 className="text-xs font-bold uppercase tracking-wide text-theme-text-muted">Trazabilidad por movimiento</h4>
        <div className="mt-2 overflow-x-auto rounded-xl border border-theme-border">
          <table className="w-full min-w-[820px] text-xs">
            <thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">Movimiento</th><th className="px-3 py-2">SKU</th><th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2">Lote</th><th className="px-3 py-2">Vencimiento</th><th className="px-3 py-2">Request</th></tr></thead>
            <tbody>{detail.movements.map((movement) => <tr key={movement.movement_id} className="border-t border-theme-border/70"><td className="px-3 py-2 font-semibold text-theme-text">{movement.movement_type === "REVERSA" ? "Reversa" : "Salida"}</td><td className="px-3 py-2 font-mono text-theme-text">{detail.products.find((product) => product.variant_id === movement.variant_id)?.sku ?? `BS-${movement.variant_id}`}</td><td className="px-3 py-2 text-right tabular-nums text-theme-text">{formatQuantity(movement.quantity_absolute)}</td><td className="px-3 py-2 text-theme-text-muted">{movement.lot || "-"}</td><td className="px-3 py-2 text-theme-text-muted">{movement.expiration_date || "-"}</td><td className="px-3 py-2 font-mono text-[11px] text-theme-text-muted">{movement.request_id || "-"}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      {correctionOpen && <MermasStockExitCorrectionForm detail={detail} onCancel={onCancelCorrection} onCorrected={onCorrected} />}
    </section>
  );
}

function MermasStockExitCorrectionForm({
  detail,
  onCancel,
  onCorrected,
}: {
  detail: MermaStockExitOperationDetail;
  onCancel: () => void;
  onCorrected: () => void;
}) {
  const [type, setType] = useState<OperationType>(detail.operation_type === "REGULACION" ? "REGULACION" : "DESTRUCCION");
  const [reason, setReason] = useState(detail.reason);
  const [observation, setObservation] = useState(detail.observation ?? "");
  const [correctionReason, setCorrectionReason] = useState("");
  const [lines, setLines] = useState<CorrectionLine[]>(() => detail.products.map((product) => ({ variant_id: product.variant_id, sku: product.sku, product_name: product.product_name, quantity: product.quantity })));
  const [catalog, setCatalog] = useState<MermaWarehouseListProduct[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getMermasStockExitCatalog().then((response) => {
      if (active) {
        setCatalog(response.data);
        setCatalogLoading(false);
      }
    });
    return () => { active = false; };
  }, []);

  const availableProducts = useMemo(() => {
    const normalized = productSearch.trim().toLocaleLowerCase("es-CL");
    return catalog.filter((product) => !lines.some((line) => line.variant_id === product.variant_id) && (!normalized || `${product.sku} ${product.product_name}`.toLocaleLowerCase("es-CL").includes(normalized))).slice(0, 8);
  }, [catalog, lines, productSearch]);

  function addProduct(product: MermaWarehouseListProduct) {
    setLines((current) => [...current, { variant_id: product.variant_id, sku: product.sku, product_name: product.product_name, quantity: 1 }]);
    setProductSearch("");
  }

  async function submit() {
    setError("");
    if (!correctionReason.trim()) { setError("El motivo de la corrección es obligatorio."); return; }
    if (!reason.trim()) { setError("El motivo de la salida corregida es obligatorio."); return; }
    if (!lines.length || lines.some((line) => !Number.isFinite(line.quantity) || line.quantity <= 0)) { setError("Revisa las cantidades ingresadas."); return; }
    setSaving(true);
    const items: MermaStockExitItem[] = lines.map((line) => ({ bsale_variant_id: line.variant_id, quantity: line.quantity }));
    const response = await correctMermasStockExit(detail.operation_id, correctionReason, type, reason, observation, items);
    if (response.success) onCorrected();
    else setError(response.error ?? "No se pudo corregir la salida.");
    setSaving(false);
  }

  return (
    <div className="mt-5 rounded-xl border border-theme-accent/35 bg-theme-accent/[0.045] p-4">
      <div className="flex items-start justify-between gap-3"><div><h4 className="text-sm font-semibold text-theme-text">Corregir salida</h4><p className="mt-1 text-xs text-theme-text-muted">La corrección conservará la salida original y será procesada transaccionalmente.</p></div><button type="button" onClick={onCancel} aria-label="Cerrar corrección" className="rounded-lg p-1 text-theme-text-muted hover:bg-theme-text/5"><X className="h-4 w-4" /></button></div>
      {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <label className="text-xs font-semibold text-theme-text">Tipo de salida<select value={type} onChange={(event) => setType(event.target.value as OperationType)} className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-bg px-2 text-xs text-theme-text"><option value="DESTRUCCION">Destrucción</option><option value="REGULACION">Regularización</option></select></label>
        <label className="text-xs font-semibold text-theme-text">Motivo de la corrección *<input value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} placeholder="Ej.: Cantidad ingresada incorrectamente" className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-bg px-2 text-xs text-theme-text outline-none focus:border-theme-accent" /></label>
        <label className="text-xs font-semibold text-theme-text">Motivo de la salida corregida *<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-theme-border bg-theme-bg px-2 py-2 text-xs text-theme-text outline-none focus:border-theme-accent" /></label>
        <label className="text-xs font-semibold text-theme-text">Observación<textarea value={observation} onChange={(event) => setObservation(event.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-theme-border bg-theme-bg px-2 py-2 text-xs text-theme-text outline-none focus:border-theme-accent" /></label>
      </div>
      <div className="mt-4 rounded-lg border border-theme-border bg-theme-surface p-3">
        <div className="flex items-center justify-between gap-2"><h5 className="text-xs font-semibold text-theme-text">Productos corregidos</h5><span className="text-[11px] text-theme-text-muted">Puedes agregar o quitar productos</span></div>
        <div className="mt-2 space-y-2">{lines.map((line) => <div key={line.variant_id} className="flex items-center gap-2 rounded-lg border border-theme-border/70 px-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-theme-text">{line.product_name}</p><p className="font-mono text-[10px] text-theme-text-muted">{line.sku}</p></div><input type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => setLines((current) => current.map((item) => item.variant_id === line.variant_id ? { ...item, quantity: Number(event.target.value) } : item))} className="h-8 w-24 rounded-lg border border-theme-border bg-theme-bg px-2 text-right text-xs text-theme-text" /><button type="button" aria-label={`Quitar ${line.product_name}`} onClick={() => setLines((current) => current.filter((item) => item.variant_id !== line.variant_id))} className="rounded-lg p-1.5 text-theme-text-muted hover:bg-red-500/10 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div>
        <div className="relative mt-3"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-theme-text-muted" /><input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder={catalogLoading ? "Cargando productos..." : "Buscar producto para agregar..."} disabled={catalogLoading} className="h-8 w-full rounded-lg border border-theme-border bg-theme-bg pl-8 pr-2 text-xs text-theme-text outline-none focus:border-theme-accent" />{productSearch && availableProducts.length > 0 && <div className="absolute z-10 mt-1 max-h-40 w-full overflow-auto rounded-lg border border-theme-border bg-theme-surface p-1 shadow-lg">{availableProducts.map((product) => <button key={product.variant_id} type="button" onClick={() => addProduct(product)} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-xs hover:bg-theme-accent/10"><span><strong className="block text-theme-text">{product.product_name}</strong><span className="font-mono text-[10px] text-theme-text-muted">{product.sku}</span></span><span className="text-theme-text-muted">{formatQuantity(product.available)}</span></button>)}</div>}</div>
      </div>
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={onCancel} disabled={saving} className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 disabled:opacity-50">Cancelar</button><button type="button" onClick={() => void submit()} disabled={saving || !lines.length} className="inline-flex items-center justify-center gap-2 rounded-lg bg-theme-accent px-3 py-2 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Confirmar corrección</button></div>
    </div>
  );
}

function MermasStockExitCreateForm({ onBack, onCreated }: { onBack: () => void; onCreated: () => void }) {
  const { invalidateWarehouse, ensureWarehouseLoaded } = useMermasModule();
  const [catalog, setCatalog] = useState<MermaWarehouseListProduct[]>([]);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<ExitType>("SALIDA_DESTRUCCION");
  const [reason, setReason] = useState("");
  const [observation, setObservation] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getMermasStockExitCatalog().then((response) => {
      if (cancelled) return;
      setCatalog(response.data);
      if (response.error) setError(response.error);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const products = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase("es-CL");
    return catalog.filter((product) => `${product.sku} ${product.product_name}`.toLocaleLowerCase("es-CL").includes(normalized));
  }, [catalog, search]);

  function addProduct(product: MermaWarehouseListProduct) {
    setError("");
    setCart((current) => current.some((line) => line.product.variant_id === product.variant_id) ? current : [...current, { product, quantity: 1 }]);
  }

  async function submit() {
    setError("");
    setMessage("");
    if (!reason.trim()) { setError("El motivo de la salida es obligatorio."); return; }
    if (!cart.length || cart.some((line) => !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > line.product.available)) { setError("Revisa las cantidades: no pueden superar el stock disponible."); return; }
    setSubmitting(true);
    const response = await createMermasStockExit(type, reason, observation, cart.map((line) => ({ bsale_variant_id: line.product.variant_id, quantity: line.quantity })));
    if (response.success) {
      setMessage("Salida registrada correctamente.");
      setCart([]);
      setReason("");
      setObservation("");
      setType("SALIDA_DESTRUCCION");
      invalidateWarehouse();
      await ensureWarehouseLoaded(true);
      onCreated();
    } else setError(response.error ?? "No se pudo registrar la salida.");
    setSubmitting(false);
  }

  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-semibold text-theme-text-accent hover:underline"><ArrowLeft className="h-3.5 w-3.5" /> Historial de salidas</button><p className="mt-3 text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">Mermas · Control de stock</p><h2 className="mt-1 text-xl font-semibold text-theme-text">Nueva salida</h2><p className="mt-1 text-sm text-theme-text-muted">Retira stock de Mermas mediante FEFO y deja trazabilidad de la operación.</p></div></header>
      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]"><section className="rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:p-5"><div className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-theme-text-muted" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar producto o SKU..." className="h-10 w-full rounded-xl border border-theme-border bg-theme-bg pl-9 pr-3 text-sm text-theme-text outline-none focus:border-theme-accent" /></div><div className="mt-4 max-h-[28rem] space-y-2 overflow-y-auto">{loading ? <Loading label="Cargando stock disponible..." /> : products.map((product) => <button key={product.variant_id} type="button" onClick={() => addProduct(product)} className="flex w-full items-center justify-between rounded-xl border border-theme-border p-3 text-left hover:border-theme-accent/50 hover:bg-theme-accent/[0.04]"><span><span className="block text-sm font-semibold text-theme-text">{product.product_name}</span><span className="text-xs text-theme-text-muted">{product.sku}</span></span><span className="text-right"><span className="block text-sm font-bold tabular-nums text-theme-accent">{product.available}</span><span className="text-[10px] uppercase text-theme-text-muted">disponible</span></span></button>)}{!loading && !products.length && <p className="py-8 text-center text-sm text-theme-text-muted">No hay productos con stock disponible.</p>}</div></section><section className="rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:p-5"><h3 className="text-sm font-semibold text-theme-text">Detalles de la salida</h3><div className="mt-4 space-y-3">{cart.map((line) => <div key={line.product.variant_id} className="flex items-center gap-2 rounded-xl border border-theme-border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-theme-text">{line.product.product_name}</p><p className="text-xs text-theme-text-muted">Disponible: {line.product.available}</p></div><input type="number" min="0.001" max={line.product.available} step="0.001" value={line.quantity} onChange={(event) => setCart((current) => current.map((item) => item.product.variant_id === line.product.variant_id ? { ...item, quantity: Number(event.target.value) } : item))} className="h-9 w-24 rounded-lg border border-theme-border bg-theme-bg px-2 text-right text-sm text-theme-text" /><button type="button" aria-label="Quitar producto" onClick={() => setCart((current) => current.filter((item) => item.product.variant_id !== line.product.variant_id))} className="rounded-lg p-2 text-theme-text-muted hover:bg-red-500/10 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></div>)}{!cart.length && <p className="rounded-xl border border-dashed border-theme-border px-3 py-8 text-center text-sm text-theme-text-muted">Agrega productos desde el buscador.</p>}<label className="block text-xs font-semibold text-theme-text">Tipo de salida<select value={type} onChange={(event) => setType(event.target.value as ExitType)} className="mt-1 h-10 w-full rounded-xl border border-theme-border bg-theme-bg px-3 text-sm text-theme-text"><option value="SALIDA_DESTRUCCION">Destrucción</option><option value="SALIDA_REGULACION">Regularización</option></select></label><label className="block text-xs font-semibold text-theme-text">Motivo obligatorio<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" /></label><label className="block text-xs font-semibold text-theme-text">Observación opcional<textarea value={observation} onChange={(event) => setObservation(event.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" /></label><button type="button" onClick={() => void submit()} disabled={submitting || !cart.length} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 text-sm font-semibold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{submitting && <Loader2 className="h-4 w-4 animate-spin" />}Registrar salida</button></div></section></div>
    </>
  );
}

function StatusBadge({ status }: { status: "VIGENTE" | "CORREGIDA" }) {
  return <span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-semibold ${status === "CORREGIDA" ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{operationStatusLabel(status)}</span>;
}

function Loading({ label }: { label: string }) {
  return <div className="flex items-center justify-center gap-2 py-10 text-xs text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{label}</div>;
}

function Notice({ tone, children }: { tone: "success" | "error"; children: React.ReactNode }) {
  return <p className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${tone === "success" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-red-500/10 text-red-700 dark:text-red-300"}`}>{tone === "success" && <CheckCircle2 className="h-4 w-4" />}{children}</p>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-theme-border bg-theme-bg px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-1 break-words text-xs font-semibold text-theme-text">{value}</p></div>;
}
