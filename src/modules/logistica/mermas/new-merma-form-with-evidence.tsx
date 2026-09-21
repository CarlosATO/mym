"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ImagePlus,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  cleanupMermaEvidenceUploads,
  createMermaRequest,
  getMermasContext,
  getMermasProductsCatalog,
  prepareMermaEvidenceUploads,
  type MermaEvidenceMetadata,
  type MermaEvidenceUpload,
  type MermaProduct,
} from "@/app/actions/logistica/mermas";
import { createClient as createBrowserSupabaseClient } from "@/lib/supabase/client";

type Line = {
  product: MermaProduct | null;
  quantity: string;
  reason: string;
  expiration_date: string;
  lot: string;
  observation: string;
  evidence: File[];
  search: string;
};
type LineErrors = Partial<
  Record<"product" | "quantity" | "reason" | "expiration_date" | "evidence", string>
>;
const emptyLine = (): Line => ({
  product: null,
  quantity: "1",
  reason: "",
  expiration_date: "",
  lot: "",
  observation: "",
  evidence: [],
  search: "",
});

export function NewMermaForm() {
  const router = useRouter();
  const [context, setContext] = useState<{
    companyName: string;
    requesterName: string;
  } | null>(null);
  const [catalog, setCatalog] = useState<MermaProduct[]>([]);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const productInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [error, setError] = useState("");
  const [lineErrors, setLineErrors] = useState<LineErrors[]>([]);

  useEffect(() => {
    Promise.all([getMermasContext(), getMermasProductsCatalog()])
      .then(([nextContext, result]) => {
        setContext(nextContext);
        if (result.error) setError(result.error);
        setCatalog(result.data);
        setLoading(false);
      })
      .catch(() => {
        setError("No se pudo cargar el catálogo Bsale");
        setLoading(false);
      });
  }, []);

  function update(index: number, patch: Partial<Line>) {
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
    const fields = ["product", "quantity", "reason", "expiration_date", "evidence"] as const;
    const changedField = fields.find((field) => field in patch);
    if (changedField) {
      setLineErrors((current) =>
        current.map((line, i) => {
          if (i !== index || !line[changedField]) return line;
          const next = { ...line };
          delete next[changedField];
          return next;
        }),
      );
    }
  }
  function addLine() {
    const index = lines.length;
    setLines((current) => [...current, emptyLine()]);
    requestAnimationFrame(() => productInputRefs.current[index]?.focus());
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const errors = lines.map((line) => {
      const next: LineErrors = {};
      if (!line.product) next.product = "Debes seleccionar un producto.";
      else if (line.product.is_pack) {
        next.product = "Este código corresponde a un Pack. Registra la merma por cada artículo físico que lo compone.";
      }
      else if (line.product.stock_available === null) {
        next.product = "No hay información confiable de stock Bsale.";
      } else if (line.product.stock_available <= 0) {
        next.product = "El producto no tiene stock disponible en Bsale.";
      }
      if (Number(line.quantity) <= 0 || !Number.isFinite(Number(line.quantity))) {
        next.quantity = "Ingresa una cantidad válida.";
      }
      if (!line.reason.trim()) next.reason = "Debes ingresar un motivo.";
      if (!line.expiration_date) {
        next.expiration_date = "Debes ingresar una fecha de vencimiento.";
      }
      if (!line.evidence.length) {
        next.evidence = "Debes adjuntar al menos una fotografía.";
      }
      return next;
    });
    const requestedByVariant = new Map<string, number>();
    lines.forEach((line) => {
      if (line.product) {
        requestedByVariant.set(
          line.product.id,
          (requestedByVariant.get(line.product.id) ?? 0) + Number(line.quantity),
        );
      }
    });
    errors.forEach((next, index) => {
      const product = lines[index].product;
      if (
        product &&
        product.stock_available !== null &&
        product.stock_available > 0 &&
        (requestedByVariant.get(product.id) ?? 0) > product.stock_available
      ) {
        next.quantity = "La cantidad acumulada supera el stock disponible en Bsale.";
      }
    });
    setLineErrors(errors);
    if (errors.some((line) => Object.keys(line).length > 0)) {
      setError("Revisa las líneas indicadas antes de guardar.");
      return;
    }
    setSaving(true);
    void (async () => {
      let session: { session_id: string; session_token: string; finalize_token: string } | null = null;
      const uploadedPaths: string[] = [];
      try {
        const requestLines = lines.map((line) => ({
          variant_id: line.product!.id,
          quantity: line.quantity,
          reason: line.reason,
          expiration_date: line.expiration_date,
          lot: line.lot,
          observation: line.observation,
        }));
        const sourceFiles = lines.flatMap((line, lineIndex) =>
          line.evidence.map((file) => ({ file, lineIndex })),
        );
        const fileMetadata = sourceFiles.map(({ file, lineIndex }) => ({
            line_index: lineIndex,
            file_name: file.name,
            mime_type: file.type,
            file_size: file.size,
        }));
        setUploadStatus("Validando evidencia...");
        const prepared = await prepareMermaEvidenceUploads(requestLines, fileMetadata);
        if (prepared.error || !prepared.data) throw new Error(prepared.error ?? "No se pudo preparar la evidencia");
        session = prepared.data;
        const evidence: MermaEvidenceMetadata[] = [];
        for (const [index, upload] of prepared.data.uploads.entries()) {
          setUploadStatus(`Subiendo evidencia ${index + 1} de ${prepared.data.uploads.length}...`);
          await uploadMermaEvidence(upload, sourceFiles[index].file);
          uploadedPaths.push(upload.storage_path);
          evidence.push({
            line_index: upload.line_index,
            storage_path: upload.storage_path,
            file_name: upload.file_name,
            mime_type: upload.mime_type,
            file_size: upload.file_size,
          });
        }
        setUploadStatus("Guardando solicitud...");
        const result = await createMermaRequest(
          requestLines,
          evidence,
          prepared.data.session_id,
          prepared.data.session_token,
          prepared.data.finalize_token,
        );
        if (result.error) throw new Error(result.error);
        router.push("/dashboard/logistica/mermas");
      } catch (saveError) {
        if (session && uploadedPaths.length) {
          await cleanupMermaEvidenceUploads(
            session.session_id,
            session.session_token,
            uploadedPaths,
          );
        }
        setError(
          saveError instanceof Error
            ? saveError.message
            : "No se pudo guardar la solicitud",
        );
      } finally {
        setUploadStatus("");
        setSaving(false);
      }
    })();
  }

  return (
    <div className="bg-theme-surface">
      <div className="flex items-center justify-between border-b border-theme-border/60 bg-theme-text/[0.012] px-5 py-4">
        <div>
          <h1 className="text-base font-semibold text-theme-text">
            Nueva solicitud de Merma
          </h1>
          <p className="mt-1 text-xs text-theme-text-muted/70">
            Cada línea requiere evidencia fotográfica
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/dashboard/logistica/mermas")}
          className="inline-flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted"
        >
          <ArrowLeft className="h-4 w-4" /> Volver
        </button>
      </div>
      <form onSubmit={submit} className="p-4 sm:p-5">
        <div className="grid gap-2 border-b border-theme-border/70 pb-4 text-sm sm:grid-cols-3">
          <Meta label="Empresa" value={context?.companyName ?? "Cargando..."} />
          <Meta
            label="Solicitante"
            value={context?.requesterName ?? "Cargando..."}
          />
          <Meta label="Fecha" value={new Date().toLocaleDateString("es-CL")} />
        </div>
        <div className="mt-4 overflow-x-auto rounded-xl border border-theme-border">
          <div className="hidden min-w-[1080px] grid-cols-[minmax(230px,2fr)_64px_minmax(180px,1.3fr)_145px_110px_minmax(140px,1fr)_145px_38px] gap-2 border-b border-theme-border bg-theme-text/[0.025] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted xl:grid">
            <span>Producto</span>
            <span>Cant.</span>
            <span>Motivo</span>
            <span>Vencimiento</span>
            <span>Lote</span>
            <span>Observación</span>
            <span>Evidencia</span>
            <span />
          </div>
          {loading ? (
            <div className="flex justify-center p-10">
              <Loader2 className="h-5 w-5 animate-spin text-theme-text-muted" />
            </div>
          ) : (
            lines.map((line, index) => (
              <EvidenceLine
                key={index}
                line={line}
                index={index}
                 catalog={catalog}
                 errors={lineErrors[index] ?? {}}
                 inputRef={(node) => {
                   productInputRefs.current[index] = node;
                 }}
                update={update}
                remove={() =>
                  setLines((current) => current.filter((_, i) => i !== index))
                }
                canRemove={lines.length > 1}
              />
            ))
          )}
        </div>
        <button
          type="button"
           onClick={addLine}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-dashed border-theme-accent/50 px-3 py-2 text-xs font-semibold text-theme-text-accent"
        >
          <Plus className="h-4 w-4" /> Agregar producto
        </button>
        {error && (
          <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end border-t border-theme-border pt-4">
          <button
            disabled={saving || loading}
            className="inline-flex items-center gap-2 rounded-xl bg-theme-accent px-5 py-2.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {saving ? uploadStatus || "Guardando..." : "Guardar solicitud"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
        {label}
      </p>
      <p className="mt-0.5 truncate font-semibold text-theme-text">{value}</p>
    </div>
  );
}

export async function uploadMermaEvidence(upload: MermaEvidenceUpload, file: File) {
  const client = createBrowserSupabaseClient();
  const storage = client.storage.from("mermas-evidence") as unknown as {
    uploadToSignedUrl?: (
      path: string,
      token: string,
      file: Blob,
      options?: { contentType?: string },
    ) => Promise<{ error: { message?: string } | null }>;
  };
  if (typeof storage.uploadToSignedUrl === "function") {
    const { error } = await storage.uploadToSignedUrl(
      upload.storage_path,
      upload.upload_token,
      file,
      { contentType: upload.mime_type },
    );
    if (error) throw new Error(`No se pudo subir la evidencia de la línea ${upload.line_index + 1}.`);
    return;
  }
  const response = await fetch(upload.signed_upload_url, {
    method: "PUT",
    headers: { "Content-Type": upload.mime_type },
    body: file,
  });
  if (!response.ok) throw new Error(`No se pudo subir la evidencia de la línea ${upload.line_index + 1}.`);
}

function EvidenceLine({
  line,
  index,
  catalog,
  errors,
  inputRef: setInputRef,
  update,
  remove,
  canRemove,
}: {
  line: Line;
  index: number;
  catalog: MermaProduct[];
  errors: LineErrors;
  inputRef: (node: HTMLInputElement | null) => void;
  update: (index: number, patch: Partial<Line>) => void;
  remove: () => void;
  canRemove: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownRect, setDropdownRect] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const query = line.search.trim().toLowerCase();
  const results = useMemo(
    () =>
      query.length < 2
        ? []
        : catalog
            .filter((product) =>
              `${product.sku} ${product.barcode ?? ""} ${product.product_name ?? ""} ${product.description ?? ""}`
                .toLowerCase()
                .includes(query),
            )
            .slice(0, 12),
    [catalog, query],
  );
  useEffect(() => {
    if (!results.length) {
      return;
    }
    const updatePosition = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 4;
      const padding = 12;
      const preferredHeight = 240;
      const below = window.innerHeight - rect.bottom - padding;
      const above = rect.top - padding;
      const openUp = below < preferredHeight && above > below;
      const maxHeight = Math.max(
        48,
        Math.min(preferredHeight, Math.max(48, (openUp ? above : below) - gap)),
      );
      const width = Math.max(rect.width, 320);
      setDropdownRect({
        top: openUp ? rect.top - maxHeight - gap : rect.bottom + gap,
        left: Math.max(
          padding,
          Math.min(rect.left, window.innerWidth - width - padding),
        ),
        width,
        maxHeight,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [line.search, results.length]);
  useEffect(() => {
    if (!results.length) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !inputRef.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        update(index, { search: "" });
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [index, results.length, update]);
  return (
    <div className="relative grid gap-2 border-b border-theme-border/70 px-3 py-2 last:border-0 md:grid-cols-2 xl:min-w-[1080px] xl:grid-cols-[minmax(230px,2fr)_64px_minmax(180px,1.3fr)_145px_110px_minmax(140px,1fr)_145px_38px] xl:items-center">
      <div className="relative">
        <span className="mb-1 block text-[10px] font-semibold text-theme-text-muted xl:hidden">
          Producto
        </span>
        {line.product ? (
          <>
            <div className={`flex min-h-8 items-center justify-between rounded-md border px-2 text-xs ${errors.product ? "border-red-500 bg-red-500/5" : "border-theme-accent/35 bg-theme-accent/5"}`}>
              <span className="truncate">
                <strong className="font-mono text-theme-text">
                  {line.product.sku}
                </strong>
                {line.product.is_pack && (
                  <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                    PACK
                  </span>
                )}
                <span className="ml-2 text-theme-text-muted">
                  {line.product.product_name || line.product.description}
                </span>
                <span className={`ml-2 text-[10px] font-semibold ${line.product.stock_available !== null && line.product.stock_available > 0 ? "text-theme-text-muted" : "text-red-500"}`}>
                  {line.product.is_pack
                    ? "PACK · Sin stock físico propio"
                    : line.product.stock_available === null
                    ? "SIN INFORMACIÓN DE STOCK"
                    : line.product.stock_available <= 0
                      ? "SIN STOCK"
                      : `Stock Bsale: ${line.product.stock_available}`}
                </span>
              </span>
              <button
                type="button"
                onClick={() => update(index, { product: null, search: "" })}
                className="ml-2 shrink-0 text-theme-text-accent"
              >
                Cambiar
              </button>
            </div>
            <FieldError message={errors.product} />
          </>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/50" />
              <input
                ref={(node) => {
                  inputRef.current = node;
                  setInputRef(node);
                }}
                value={line.search}
                onChange={(event) => {
                  setActiveIndex(0);
                  update(index, { search: event.target.value });
                }}
                onKeyDown={(event) => {
                  if (!results.length) return;
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((current) =>
                      Math.min(current + 1, results.length - 1),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((current) => Math.max(current - 1, 0));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const selected = results[Math.min(activeIndex, results.length - 1)];
                    if (!selected.is_pack) update(index, { product: selected, search: "" });
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    update(index, { search: "" });
                  }
                }}
                aria-autocomplete="list"
                aria-activedescendant={
                  results.length ? `merma-product-${index}-${activeIndex}` : undefined
                }
                placeholder="Buscar SKU o producto"
                className={`h-8 w-full rounded-md border bg-theme-surface pl-8 text-xs text-theme-text outline-none focus:border-theme-accent ${errors.product ? "border-red-500" : "border-theme-border"}`}
              />
              <FieldError message={errors.product} />
            </div>
            {results.length > 0 && dropdownRect && typeof document !== "undefined" && (
              createPortal(
              <div
                ref={dropdownRef}
                role="listbox"
                className="fixed z-[9999] overflow-y-auto rounded-lg border border-theme-border bg-theme-surface shadow-2xl"
                style={dropdownRect}
              >
                {results.map((product, resultIndex) => (
                  (() => {
                    const selectable =
                      !product.is_pack &&
                      product.stock_available !== null &&
                      product.stock_available > 0;
                    return <button
                    type="button"
                    key={product.id}
                    disabled={!selectable}
                    id={`merma-product-${index}-${resultIndex}`}
                    role="option"
                    aria-selected={resultIndex === activeIndex}
                    onClick={() => update(index, { product, search: "" })}
                    className={`block w-full border-b border-theme-border/60 px-3 py-2 text-left text-xs last:border-0 hover:bg-theme-text/5 ${resultIndex === activeIndex ? "bg-theme-text/5" : ""}`}
                  >
                    <strong className="font-mono">{product.sku}</strong>
                    {product.is_pack && (
                      <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                        PACK
                      </span>
                    )}
                    <span className="ml-2 text-theme-text-muted">
                      {product.product_name || product.description}
                    </span>
                    <span className={`ml-2 text-[10px] font-semibold ${selectable ? "text-theme-text-muted" : "text-red-500"}`}>
                      {product.is_pack
                        ? "PACK · Sin stock físico propio"
                        : product.stock_available === null
                          ? "SIN INFORMACIÓN DE STOCK"
                        : product.stock_available <= 0
                          ? "SIN STOCK"
                          : `Stock Bsale: ${product.stock_available}`}
                    </span>
                    {product.is_pack && (
                      <span className="mt-1 block text-[10px] text-amber-700">
                        Este código corresponde a un Pack y no posee stock físico propio. Registra la merma individualmente sobre los productos que lo componen.
                      </span>
                    )}
                  </button>;
                  })()
                ))}
              </div>,
              document.body,
              )
            )}
          </>
        )}
      </div>
      <Field label="Cant." error={errors.quantity}>
        <input
          type="number"
          min="1"
          step="1"
          value={line.quantity}
          onChange={(event) => update(index, { quantity: event.target.value })}
          className={`h-8 w-full rounded-md border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-accent ${errors.quantity ? "border-red-500" : "border-theme-border"}`}
        />
      </Field>
      <Field label="Motivo" error={errors.reason}>
        <input
          value={line.reason}
          onChange={(event) => update(index, { reason: event.target.value })}
          className={`h-8 w-full rounded-md border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-accent ${errors.reason ? "border-red-500" : "border-theme-border"}`}
        />
      </Field>
      <Field label="Vencimiento" error={errors.expiration_date}>
        <input
          type="date"
          value={line.expiration_date}
          onChange={(event) =>
            update(index, { expiration_date: event.target.value })
          }
          className={`h-8 w-full rounded-md border bg-theme-surface px-2 text-xs text-theme-text outline-none focus:border-theme-accent ${errors.expiration_date ? "border-red-500" : "border-theme-border"}`}
        />
      </Field>
      <Field label="Lote">
        <input
          value={line.lot}
          onChange={(event) => update(index, { lot: event.target.value })}
          className="h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text"
        />
      </Field>
      <Field label="Observación">
        <input
          value={line.observation}
          onChange={(event) =>
            update(index, { observation: event.target.value })
          }
          className="h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text"
        />
      </Field>
      <EvidencePicker
        files={line.evidence}
        invalid={Boolean(errors.evidence)}
        onChange={(files) => update(index, { evidence: files })}
      />
      {canRemove && (
        <button
          type="button"
          onClick={remove}
          className="text-red-500"
          aria-label={`Eliminar línea ${index + 1}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold text-theme-text-muted xl:hidden">
        {label}
      </span>
      {children}
      <FieldError message={error} />
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-[10px] font-medium text-red-600">{message}</p>;
}

function EvidencePicker({
  files,
  invalid,
  onChange,
}: {
  files: File[];
  invalid: boolean;
  onChange: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );
  useEffect(
    () => () => previews.forEach((item) => URL.revokeObjectURL(item.url)),
    [previews],
  );
  return (
    <div className="min-w-0">
      <span className="mb-1 block text-[10px] font-semibold text-theme-text-muted xl:hidden">
        Evidencia
      </span>
      <div
        className={`flex min-h-8 items-center gap-1 rounded-md border px-1.5 py-1 ${invalid ? "border-red-500 bg-red-500/5" : "border-theme-border bg-theme-surface"}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(event) => {
            onChange([...files, ...Array.from(event.target.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
        {previews.map((item, index) => (
          <div key={item.url} className="relative h-7 w-7">
            <button
              type="button"
              onClick={() => setPreviewIndex(index)}
              className="h-full w-full overflow-hidden rounded border border-theme-border"
            >
              <img
                src={item.url}
                alt="Vista previa de evidencia"
                className="h-full w-full object-cover"
              />
            </button>
            <button
              type="button"
              onClick={() =>
                onChange(files.filter((_, fileIndex) => fileIndex !== index))
              }
              className="absolute -right-1 -top-1 rounded-full bg-red-600 p-0.5 text-white"
              aria-label="Eliminar fotografía"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1 px-1 text-[10px] font-semibold text-theme-text-accent"
        >
          <ImagePlus className="h-4 w-4" />
          {files.length ? "+" : "Foto"}
        </button>
      </div>
      {invalid && (
        <p className="mt-1 text-[10px] font-medium text-red-600">
          Debes adjuntar al menos una fotografía.
        </p>
      )}
      {previewIndex !== null && previews[previewIndex] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreviewIndex(null)}
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw]"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={previews[previewIndex].url}
              alt="Evidencia ampliada"
              className="max-h-[85vh] max-w-full rounded-lg object-contain"
            />
            <button
              type="button"
              onClick={() => setPreviewIndex(null)}
              className="absolute -right-3 -top-3 rounded-full bg-theme-surface p-1 text-theme-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Legacy picker retained temporarily for compatibility with the previous form bundle.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function EvidencePickerLegacy({
  files,
  invalid,
  onChange,
}: {
  files: File[];
  invalid: boolean;
  onChange: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );
  useEffect(
    () => () => previews.forEach((item) => URL.revokeObjectURL(item.url)),
    [previews],
  );
  return (
    <div className="min-w-0">
      <span className="mb-1 block text-[10px] font-semibold text-theme-text-muted xl:hidden">
        Evidencia
      </span>
      <div
        className={`flex min-h-8 items-center gap-1 rounded-md border px-1.5 py-1 ${invalid ? "border-red-500 bg-red-500/5" : "border-theme-border bg-theme-surface"}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(event) => {
            onChange([...files, ...Array.from(event.target.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
        {previews.map((item) => (
          <button
            type="button"
            key={item.url}
            onClick={() => setPreview(item.url)}
            className="relative h-7 w-7 overflow-hidden rounded border border-theme-border"
          >
            <img
              src={item.url}
              alt="Vista previa de evidencia"
              className="h-full w-full object-cover"
            />
            <span className="sr-only">Ampliar fotografía</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1 px-1 text-[10px] font-semibold text-theme-text-accent"
        >
          <ImagePlus className="h-4 w-4" />
          {files.length ? "+" : "Foto"}
        </button>
      </div>
      {invalid && (
        <p className="mt-1 text-[10px] font-medium text-red-600">
          Debes adjuntar al menos una fotografía.
        </p>
      )}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw]"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={preview}
              alt="Evidencia ampliada"
              className="max-h-[85vh] max-w-full rounded-lg object-contain"
            />
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="absolute -right-3 -top-3 rounded-full bg-theme-surface p-1 text-theme-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
