"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Search, Trash2 } from "lucide-react";
import {
  createMermasStockExit,
  getMermasStockExitCatalog,
  type MermaWarehouseListProduct,
} from "@/app/actions/logistica/mermas";
import { useMermasModule } from "./mermas-module-provider";

type ExitType = "SALIDA_DESTRUCCION" | "SALIDA_REGULACION";
type CartLine = { product: MermaWarehouseListProduct; quantity: number };

export function MermasStockExitPanel() {
  const { invalidateWarehouse } = useMermasModule();
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

  async function loadCatalog() {
    setLoading(true);
    const response = await getMermasStockExitCatalog();
    setCatalog(response.data);
    if (response.error) setError(response.error);
    setLoading(false);
  }

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
    setCart((current) => current.some((line) => line.product.variant_id === product.variant_id)
      ? current
      : [...current, { product, quantity: 1 }]);
  }

  function updateQuantity(variantId: number, value: string) {
    setCart((current) => current.map((line) => line.product.variant_id === variantId ? { ...line, quantity: Number(value) } : line));
  }

  async function submit() {
    setError("");
    setMessage("");
    if (!reason.trim()) { setError("El motivo de la salida es obligatorio."); return; }
    if (!cart.length || cart.some((line) => !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > line.product.available)) {
      setError("Revisa las cantidades: no pueden superar el stock disponible.");
      return;
    }
    setSubmitting(true);
    const response = await createMermasStockExit(type, reason, observation, cart.map((line) => ({ bsale_variant_id: line.product.variant_id, quantity: line.quantity })));
    if (response.success) {
      setMessage("Salida registrada correctamente.");
      setCart([]);
      setReason("");
      setObservation("");
      setType("SALIDA_DESTRUCCION");
      await invalidateWarehouse();
      await loadCatalog();
    } else setError(response.error ?? "No se pudo registrar la salida.");
    setSubmitting(false);
  }

  return (
    <div className="min-h-[calc(100vh-9.5rem)] bg-theme-bg p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">Mermas · Control de stock</p>
          <h2 className="mt-1 text-xl font-semibold text-theme-text">Salidas</h2>
          <p className="mt-1 text-sm text-theme-text-muted">Retira stock de Mermas mediante FEFO y deja trazabilidad de la operación.</p>
        </header>
        {message && <p className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" />{message}</p>}
        {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
        <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
          <section className="rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:p-5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-theme-text-muted" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar producto o SKU..." className="h-10 w-full rounded-xl border border-theme-border bg-theme-bg pl-9 pr-3 text-sm text-theme-text outline-none focus:border-theme-accent" />
            </div>
            <div className="mt-4 max-h-[28rem] space-y-2 overflow-y-auto">
              {loading ? <p className="flex items-center gap-2 py-8 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Cargando stock disponible...</p> : products.map((product) => (
                <button key={product.variant_id} type="button" onClick={() => addProduct(product)} className="flex w-full items-center justify-between rounded-xl border border-theme-border p-3 text-left hover:border-theme-accent/50 hover:bg-theme-accent/[0.04]">
                  <span><span className="block text-sm font-semibold text-theme-text">{product.product_name}</span><span className="text-xs text-theme-text-muted">{product.sku}</span></span>
                  <span className="text-right"><span className="block text-sm font-bold tabular-nums text-theme-accent">{product.available}</span><span className="text-[10px] uppercase text-theme-text-muted">disponible</span></span>
                </button>
              ))}
              {!loading && !products.length && <p className="py-8 text-center text-sm text-theme-text-muted">No hay productos con stock disponible.</p>}
            </div>
          </section>
          <section className="rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:p-5">
            <h3 className="text-sm font-semibold text-theme-text">Nueva salida</h3>
            <div className="mt-4 space-y-3">
              {cart.map((line) => <div key={line.product.variant_id} className="flex items-center gap-2 rounded-xl border border-theme-border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-theme-text">{line.product.product_name}</p><p className="text-xs text-theme-text-muted">Disponible: {line.product.available}</p></div><input type="number" min="0.001" max={line.product.available} step="0.001" value={line.quantity} onChange={(event) => updateQuantity(line.product.variant_id, event.target.value)} className="h-9 w-24 rounded-lg border border-theme-border bg-theme-bg px-2 text-right text-sm text-theme-text" /><button type="button" aria-label="Quitar producto" onClick={() => setCart((current) => current.filter((item) => item.product.variant_id !== line.product.variant_id))} className="rounded-lg p-2 text-theme-text-muted hover:bg-red-500/10 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></div>)}
              {!cart.length && <p className="rounded-xl border border-dashed border-theme-border px-3 py-8 text-center text-sm text-theme-text-muted">Agrega productos desde el buscador.</p>}
              <label className="block text-xs font-semibold text-theme-text">Tipo de salida<select value={type} onChange={(event) => setType(event.target.value as ExitType)} className="mt-1 h-10 w-full rounded-xl border border-theme-border bg-theme-bg px-3 text-sm text-theme-text"><option value="SALIDA_DESTRUCCION">DESTRUCCION</option><option value="SALIDA_REGULACION">REGULACION</option></select></label>
              <label className="block text-xs font-semibold text-theme-text">Motivo obligatorio<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" /></label>
              <label className="block text-xs font-semibold text-theme-text">Observación opcional<textarea value={observation} onChange={(event) => setObservation(event.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" /></label>
              <button type="button" onClick={() => void submit()} disabled={submitting || !cart.length} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 text-sm font-semibold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{submitting && <Loader2 className="h-4 w-4 animate-spin" />}Registrar salida</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
