"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarDays,
  Loader2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createMermaRequest,
  getMermasContext,
  getMermasProductsCatalog,
  type MermaProduct,
} from "@/app/actions/logistica/mermas";

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
type IndexedProduct = {
  product: MermaProduct;
  sku: string;
  barcode: string;
  description: string;
  searchable: string;
};

const emptyLine = (): DraftLine => ({
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

export { NewMermaForm } from "./new-merma-form-with-evidence";

// Legacy form retained temporarily for the existing module bundle.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacyNewMermaForm() {
  const router = useRouter();
  const productRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [context, setContext] = useState<{
    companyName: string;
    requesterName: string;
  } | null>(null);
  const [catalog, setCatalog] = useState<MermaProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getMermasContext()
      .then(setContext)
      .catch((e) =>
        setError(
          e instanceof Error ? e.message : "No se pudo cargar el contexto",
        ),
      );
    getMermasProductsCatalog()
      .then((result) => {
        if (result.error) setError(result.error);
        else setCatalog(result.data);
        setCatalogLoading(false);
      })
      .catch(() => {
        setError("No se pudo cargar el catálogo Bsale");
        setCatalogLoading(false);
      });
  }, []);
  function update(index: number, patch: Partial<DraftLine>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }
  function addLine() {
    const index = lines.length;
    setLines((current) => [...current, emptyLine()]);
    requestAnimationFrame(() => productRefs.current[index]?.focus());
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (
      !lines.length ||
      lines.some(
        (line) =>
          !line.product ||
          Number(line.quantity) <= 0 ||
          !line.reason.trim() ||
          !line.expiration_date,
      )
    ) {
      setError(
        "Completa producto, cantidad mayor que cero, motivo y vencimiento en todas las líneas.",
      );
      return;
    }
    const requestedByVariant = new Map<string, number>();
    for (const line of lines)
      requestedByVariant.set(
        line.product!.id,
        (requestedByVariant.get(line.product!.id) ?? 0) + Number(line.quantity),
      );
    for (const line of lines) {
      const stock = line.product!.stock_available;
      const requested = requestedByVariant.get(line.product!.id) ?? 0;
      if (stock === null) {
        setError(
          `No hay información de stock Bsale para ${line.product!.sku}. No se puede solicitar.`,
        );
        return;
      }
      if (requested > stock) {
        setError(
          `La cantidad solicitada para ${line.product!.sku} supera el stock disponible en Bsale (${stock} unidades).`,
        );
        return;
      }
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
    router.push(`/dashboard/logistica/mermas/${result.request_id}`);
  }
  const totalUnits = lines.reduce(
    (total, line) => total + (Number(line.quantity) || 0),
    0,
  );
  const nearestExpiration = lines
    .map((line) => line.expiration_date)
    .filter(Boolean)
    .sort()[0];
  const indexedCatalog = useMemo(
    () =>
      catalog.map((product) => ({
        product,
        sku: normalize(product.sku),
        barcode: normalize(product.barcode ?? ""),
        description: normalize(
          `${product.product_name ?? ""} ${product.description ?? ""}`,
        ),
        searchable: normalize(
          `${product.sku} ${product.barcode ?? ""} ${product.product_name ?? ""} ${product.description ?? ""}`,
        ),
      })),
    [catalog],
  );

  return (
    <div className="bg-theme-surface">
      <div className="flex flex-col gap-3 border-b border-theme-border/60 bg-theme-text/[0.012] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-base font-semibold text-theme-text">
            Nueva solicitud de Merma
          </h1>
          <p className="mt-1 text-xs text-theme-text-muted/70">
            Documento operacional para gestión manual en Bsale
          </p>
        </div>
        <button
          onClick={() => router.push("/dashboard/logistica/mermas")}
          className="inline-flex items-center gap-2 self-start rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 sm:self-auto"
        >
          <ArrowLeft className="h-4 w-4" /> Volver
        </button>
      </div>
      <form onSubmit={submit} className="p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-theme-border/70 pb-4 text-sm sm:grid-cols-3">
          <DocumentMeta
            label="Empresa"
            value={context?.companyName ?? "Cargando..."}
          />
          <DocumentMeta
            label="Solicitante"
            value={context?.requesterName ?? "Cargando..."}
          />
          <DocumentMeta
            label="Fecha"
            value={new Date().toLocaleDateString("es-CL")}
          />
        </div>
        <div className="mt-4 flex flex-col gap-4 xl:flex-row xl:items-start">
          <section className="min-w-0 flex-1">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-theme-text-muted">
                Productos
              </h2>
              <span className="text-[11px] text-theme-text-muted">
                {catalogLoading
                  ? "Cargando productos..."
                  : `${lines.length} línea(s) · ${catalog.length.toLocaleString("es-CL")} productos disponibles`}
              </span>
            </div>
            <div className="overflow-visible rounded-xl border border-theme-border">
              <div className="hidden grid-cols-[minmax(240px,2fr)_64px_minmax(200px,1.2fr)_150px_minmax(120px,.8fr)_minmax(150px,1fr)_38px] gap-2 border-b border-theme-border bg-theme-text/[0.025] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted xl:grid">
                <span>Producto</span>
                <span>Cant.</span>
                <span>Motivo</span>
                <span>Vencimiento</span>
                <span>Lote</span>
                <span>Observación</span>
                <span />
              </div>
              {lines.map((line, index) => (
                <MermaGridRow
                  key={index}
                  line={line}
                  catalog={indexedCatalog}
                  catalogLoading={catalogLoading}
                  index={index}
                  update={update}
                  inputRef={(node) => {
                    productRefs.current[index] = node;
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
              onClick={addLine}
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-dashed border-theme-accent/50 px-3 py-2 text-xs font-semibold text-theme-text-accent hover:bg-theme-accent/5"
            >
              <Plus className="h-4 w-4" /> Agregar producto
            </button>
          </section>
          <aside className="w-full shrink-0 rounded-xl border border-theme-border bg-theme-text/[0.018] p-4 xl:w-52">
            <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-theme-text-muted">
              Resumen
            </h2>
            <div className="mt-3 space-y-2 text-xs">
              <SummaryRow label="Productos" value={String(lines.length)} />
              <SummaryRow label="Unidades" value={String(totalUnits)} />
              <div className="border-t border-theme-border/70 pt-2">
                <p className="text-theme-text-muted">Vencimiento más próximo</p>
                <p className="mt-1 font-semibold text-theme-text">
                  {nearestExpiration || "—"}
                </p>
              </div>
              <div className="border-t border-theme-border/70 pt-2">
                <p className="text-theme-text-muted">Estado al guardar</p>
                <p className="mt-1 font-semibold text-amber-700 dark:text-amber-300">
                  PENDIENTE
                </p>
              </div>
            </div>
          </aside>
        </div>
        {error && (
          <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end border-t border-theme-border pt-4">
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

function DocumentMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
        {label}
      </p>
      <p className="mt-0.5 truncate font-semibold text-theme-text">{value}</p>
    </div>
  );
}
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-theme-text-muted">{label}</span>
      <strong className="tabular-nums text-theme-text">{value}</strong>
    </div>
  );
}

function MermaGridRow({
  line,
  catalog,
  catalogLoading,
  index,
  update,
  inputRef,
  remove,
  canRemove,
}: {
  line: DraftLine;
  catalog: IndexedProduct[];
  catalogLoading: boolean;
  index: number;
  update: (index: number, patch: Partial<DraftLine>) => void;
  inputRef: (node: HTMLInputElement | null) => void;
  remove: () => void;
  canRemove: boolean;
}) {
  // Filter the shared indexed catalog locally; typing never calls the server.
  const query = normalize(line.search);
  const terms = query.split(" ").filter(Boolean);
  const results =
    line.product || catalogLoading || query.length < 2
      ? []
      : catalog
          .map((item) => ({
            product: item.product,
            score: rankProduct(item, query, terms),
          }))
          .filter((item) => item.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score || a.product.sku.localeCompare(b.product.sku),
          )
          .slice(0, 20)
          .map((item) => item.product);
  return (
    <div className="relative grid grid-cols-1 gap-2 border-b border-theme-border/70 px-3 py-2 last:border-b-0 md:grid-cols-2 xl:grid-cols-[minmax(240px,2fr)_64px_minmax(200px,1.2fr)_150px_minmax(120px,.8fr)_minmax(150px,1fr)_38px] xl:items-center xl:gap-2">
      <div className="relative min-w-0 md:col-span-2 xl:col-span-1">
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted xl:hidden">
          Producto
        </span>
        {line.product ? (
          <div className="flex h-8 items-center justify-between gap-2 rounded-md border border-theme-accent/35 bg-theme-accent/5 px-2 text-xs">
            <span className="min-w-0 truncate">
              <strong className="font-mono text-theme-text">
                {line.product.sku}
              </strong>
              <span className="ml-2 text-theme-text-muted">
                {line.product.product_name || line.product.description}
              </span>
              <span
                className={`ml-2 text-[10px] font-semibold ${line.product.stock_available === 0 ? "text-red-500" : "text-theme-text-muted"}`}
              >
                Stock Bsale:{" "}
                {line.product.stock_available === null
                  ? "Sin información"
                  : line.product.stock_available}
              </span>
            </span>
            <button
              type="button"
              onClick={() => update(index, { product: null, search: "" })}
              className="shrink-0 text-[11px] font-medium text-theme-text-accent hover:underline"
            >
              Cambiar
            </button>
          </div>
        ) : (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/50" />
            <input
              ref={inputRef}
              disabled={catalogLoading}
              value={line.search}
              onChange={(e) => update(index, { search: e.target.value })}
              placeholder={
                catalogLoading
                  ? "Cargando productos..."
                  : "Buscar por SKU, descripción o código de barras..."
              }
              className="h-8 w-full rounded-md border border-theme-border bg-theme-surface pl-8 pr-8 text-xs text-theme-text outline-none focus:border-theme-accent disabled:cursor-wait disabled:opacity-70"
            />
            {catalogLoading && (
              <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-theme-text-muted" />
            )}
          </div>
        )}
        {!line.product && results.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-auto rounded-lg border border-theme-border bg-theme-surface shadow-xl">
            {results.map((product) => {
              const selectable =
                product.stock_available !== null && product.stock_available > 0;
              return (
                <button
                  type="button"
                  key={product.id}
                  disabled={!selectable}
                  onClick={() => update(index, { product, search: "" })}
                  className="block w-full border-b border-theme-border/60 px-2.5 py-1.5 text-left text-xs hover:bg-theme-text/5 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="font-mono font-semibold text-theme-text">
                    {product.sku}
                  </span>
                  <span className="ml-2 text-theme-text-muted">
                    {product.product_name ||
                      product.description ||
                      "Sin descripción"}
                  </span>
                  {product.barcode && (
                    <span className="ml-2 text-theme-text-muted/70">
                      {product.barcode}
                    </span>
                  )}
                  <span
                    className={`ml-2 text-[10px] font-semibold ${selectable ? "text-theme-text-muted" : "text-red-500"}`}
                  >
                    {product.stock_available === null
                      ? "SIN INFORMACIÓN DE STOCK"
                      : product.stock_available === 0
                        ? "SIN STOCK"
                        : `Stock Bsale: ${product.stock_available}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <CompactField label="Cantidad">
        <input
          type="number"
          min="0.001"
          step="0.001"
          value={line.quantity}
          onChange={(e) => update(index, { quantity: e.target.value })}
          className="control w-[64px] max-w-full"
        />
      </CompactField>
      <CompactField label="Motivo">
        <input
          value={line.reason}
          onChange={(e) => update(index, { reason: e.target.value })}
          placeholder="Ej. Envase roto"
          className="control"
        />
      </CompactField>
      <CompactField label="Vencimiento">
        <div className="relative">
          <CalendarDays className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/50" />
          <input
            type="date"
            value={line.expiration_date}
            onChange={(e) => update(index, { expiration_date: e.target.value })}
            className="control pl-8"
          />
        </div>
      </CompactField>
      <CompactField label="Lote">
        <input
          value={line.lot}
          onChange={(e) => update(index, { lot: e.target.value })}
          className="control"
        />
      </CompactField>
      <CompactField label="Observación">
        <input
          value={line.observation}
          onChange={(e) => update(index, { observation: e.target.value })}
          placeholder="Opcional"
          className="control"
        />
      </CompactField>
      <div className="flex items-end justify-end pb-1">
        <button
          type="button"
          onClick={remove}
          disabled={!canRemove}
          aria-label={`Eliminar línea ${index + 1}`}
          title="Eliminar línea"
          className="rounded-md p-1.5 text-theme-text-muted hover:bg-red-500/10 hover:text-red-500 disabled:invisible"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function rankProduct(product: IndexedProduct, query: string, terms: string[]) {
  if (!terms.every((term) => product.searchable.includes(term))) return 0;
  let score = 10;
  if (product.sku === query) score += 1000;
  else if (product.barcode === query) score += 950;
  else if (product.sku.startsWith(query)) score += 800;
  else if (product.barcode.startsWith(query)) score += 750;
  else if (product.description.includes(query)) score += 500;
  score += terms.reduce(
    (total, term) => total + (product.description.includes(term) ? 35 : 0),
    0,
  );
  return score;
}

function CompactField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted xl:hidden">
        {label}
      </span>
      {children}
    </label>
  );
}
