import { FileUp, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CommissionPreview,
  CommissionPreviewLine,
  CommissionSeller,
} from "@/app/actions/comercial/commissions";
import { formatPercent } from "@/lib/utils";
import type { SimulationFilters } from "../../commissions-panel-types";
import { money, today } from "../../commissions-panel-utils";

export function SimulateTab({
  sellerId,
  setSellerId,
  periodFrom,
  setPeriodFrom,
  periodTo,
  setPeriodTo,
  busy,
  sellers,
  preview,
  onSimulate,
  onCreateDraft,
}: {
  sellerId: string;
  setSellerId: (v: string) => void;
  periodFrom: string;
  setPeriodFrom: (v: string) => void;
  periodTo: string;
  setPeriodTo: (v: string) => void;
  busy: boolean;
  sellers: CommissionSeller[];
  preview: CommissionPreview | null;
  onSimulate: (id?: string) => void;
  onCreateDraft: () => void;
}) {
  const [filters, setFilters] = useState<SimulationFilters>({
    invoice: "",
    supplier: "",
    product: "",
    rule: "",
    percent: "",
  });
  const normalizedInvoiceFilter = filters.invoice.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!preview) return [];
    return preview.lines.filter((l) => {
      const invoiceText = getInvoiceFilterText(l);
      if (normalizedInvoiceFilter && !invoiceText.includes(normalizedInvoiceFilter))
        return false;
      if (
        filters.supplier &&
        !`${l.supplier_name} ${l.commission_group_name}`
          .toLowerCase()
          .includes(filters.supplier.toLowerCase())
      )
        return false;
      if (
        filters.product &&
        !`${l.sku} ${l.product_name}`
          .toLowerCase()
          .includes(filters.product.toLowerCase())
      )
        return false;
      if (filters.rule && l.applied_rule_label !== filters.rule) return false;
      if (filters.percent && String(l.commission_percent) !== filters.percent)
        return false;
      return true;
    });
  }, [normalizedInvoiceFilter, preview, filters]);

  const hasFilters = Object.values(filters).some(Boolean);
  const totalNet = filtered.reduce(
    (sum, line) => sum + (line.net_amount || 0),
    0,
  );
  const totalCom = filtered.reduce(
    (sum, line) => sum + (line.commission_amount || 0),
    0,
  );

  const kpis = preview
    ? [
        {
          label: "Facturas",
          value: new Set(
            filtered.map(
              (line) => line.original_invoice_id || line.invoice_bsale_id,
            ),
          ).size.toLocaleString("es-CL"),
        },
        { label: "Líneas", value: filtered.length.toLocaleString("es-CL") },
        { label: "Neto", value: money(totalNet) },
        { label: "Comisión", value: money(totalCom) },
        {
          label: "% efectivo",
          value: `${totalNet ? ((totalCom / totalNet) * 100).toFixed(2) : "0.00"}%`,
        },
      ]
    : [];

  return (
    <div className="w-full space-y-3">
      <section className="sim-card p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[160px] flex-1">
            <Field label="Vendedor">
              <select
                value={sellerId}
                onChange={(event) => {
                  setSellerId(event.target.value);
                  if (event.target.value) onSimulate(event.target.value);
                }}
              >
                <option value="">Selecciona vendedor</option>
                {sellers.map((seller) => (
                  <option
                    key={seller.seller_bsale_id}
                    value={seller.seller_bsale_id}
                  >
                    {seller.seller_name?.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="w-[140px]">
            <Field label="Desde">
              <input
                type="date"
                value={periodFrom}
                max={periodTo}
                onChange={(event) => {
                  setPeriodFrom(event.target.value);
                }}
              />
            </Field>
          </div>
          <div className="w-[140px]">
            <Field label="Hasta">
              <input
                type="date"
                value={periodTo}
                min={periodFrom}
                max={today()}
                onChange={(event) => {
                  setPeriodTo(event.target.value);
                }}
              />
            </Field>
          </div>
          <button
            disabled={!sellerId || busy}
            onClick={() => onSimulate()}
            className="btn-primary h-[34px] self-end"
          >
            {busy ? "Simulando..." : "Simular"}
          </button>
          {preview && preview.lines.length > 0 && (
            <button
              disabled={busy}
              onClick={onCreateDraft}
              className="btn-primary h-[34px] self-end !bg-emerald-600 hover:!bg-emerald-700"
            >
              <FileUp className="h-3.5 w-3.5" />
              Crear borrador
            </button>
          )}
        </div>
        {kpis.length > 0 && (
          <div className="mt-2.5 flex items-center flex-wrap gap-1.5">
            {kpis.map((k) => (
              <div key={k.label} className="sim-kpi">
                <span className="sim-kpi-label">{k.label}</span>
                <span className="sim-kpi-value">{k.value}</span>
              </div>
            ))}
            {hasFilters && (
              <span className="ml-1 rounded bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-600">
                Filtros activos
              </span>
            )}
            {hasFilters && filtered.length > 0 && preview && (
              <span className="text-xs text-theme-text-muted">
                Mostrando {filtered.length} de {preview.lines.length} líneas
              </span>
            )}
          </div>
        )}
      </section>
      {preview && (
        <PreviewReport
          preview={preview}
          filters={filters}
          setFilters={setFilters}
          filtered={filtered}
        />
      )}
    </div>
  );
}

function PreviewReport({
  preview,
  filters,
  setFilters,
  filtered,
}: {
  preview: CommissionPreview;
  filters: SimulationFilters;
  setFilters: React.Dispatch<React.SetStateAction<SimulationFilters>>;
  filtered: CommissionPreviewLine[];
}) {
  const totalVisibleLines = filtered.length;
  const creditNoteLines = filtered.filter(
    (line) => line.commission_line_type === "CREDIT_NOTE_LINE",
  ).length;
  const saleLines = filtered.filter(
    (line) => line.commission_line_type !== "CREDIT_NOTE_LINE",
  );
  const generalCommissionLines = saleLines.filter(
    (line) => line.warning_code === "DEFAULT_RULE_USED",
  ).length;
  const specificRuleLines = saleLines.filter(
    (line) => line.warning_code !== "DEFAULT_RULE_USED" && Boolean(line.rule_id),
  ).length;
  const unclassifiedLines =
    totalVisibleLines -
    generalCommissionLines -
    specificRuleLines -
    creditNoteLines;
  const percentages = Array.from(
    new Set(preview.lines.map((line) => Number(line.commission_percent))),
  ).sort((a, b) => a - b);
  const ruleLabels = Array.from(
    new Set(preview.lines.map((line) => line.applied_rule_label)),
  ).sort((a, b) => a.localeCompare(b, "es"));

  return (
    <section className="space-y-2.5">
      <div className="sim-card overflow-hidden">
        <div className="border-b border-theme-border bg-theme-bg/40 px-3 py-1.5 text-[11px] font-semibold text-theme-text-muted flex items-center gap-1.5">
          <SlidersHorizontal className="h-3 w-3 text-theme-accent" />
          Filtros de simulación
        </div>
        <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-[170px_1fr_1fr_1fr_130px_auto]">
          <input
            value={filters.invoice}
            onChange={(e) =>
              setFilters((current) => ({
                ...current,
                invoice: e.target.value,
              }))
            }
            placeholder="Factura"
            className="h-7 text-[11px]"
          />
          <input
            value={filters.supplier}
            onChange={(e) =>
              setFilters((current) => ({
                ...current,
                supplier: e.target.value,
              }))
            }
            placeholder="Proveedor o grupo"
            className="h-7 text-[11px]"
          />
          <input
            value={filters.product}
            onChange={(e) =>
              setFilters((current) => ({
                ...current,
                product: e.target.value,
              }))
            }
            placeholder="SKU o producto"
            className="h-7 text-[11px]"
          />
          <select
            value={filters.rule}
            onChange={(e) =>
              setFilters((current) => ({
                ...current,
                rule: e.target.value,
              }))
            }
            className="h-7 text-[11px]"
          >
            <option value="">Todas las reglas</option>
            {ruleLabels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={filters.percent}
            onChange={(e) =>
              setFilters((current) => ({
                ...current,
                percent: e.target.value,
              }))
            }
            className="h-7 text-[11px]"
          >
            <option value="">Todos los %</option>
            {percentages.map((percent) => (
              <option key={percent} value={percent}>
                {percent}%
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              setFilters({
                invoice: "",
                supplier: "",
                product: "",
                rule: "",
                percent: "",
              })
            }
            className="btn-secondary h-7 text-[11px]"
          >
            <X className="h-3 w-3" />
            Limpiar
          </button>
        </div>
      </div>
      {totalVisibleLines > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-700">
          <span className="font-semibold">
            De {totalVisibleLines} líneas visibles: {generalCommissionLines} usan comisión general, {specificRuleLines} usan reglas específicas y {creditNoteLines} corresponden a notas de crédito aplicadas como descuento.
          </span>
          {unclassifiedLines > 0 && (
            <span> {unclassifiedLines} quedan sin clasificar.</span>
          )}
        </div>
      )}
      <PreviewTable lines={filtered} />
    </section>
  );
}

function PreviewTable({ lines }: { lines: CommissionPreviewLine[] }) {
  const ncCount = lines.filter(
    (line) => line.commission_line_type === "CREDIT_NOTE_LINE",
  ).length;

  return (
    <div className="overflow-auto rounded-xl border border-theme-border sim-card">
      {ncCount > 0 && (
        <div className="flex items-center gap-2 border-b border-theme-border bg-amber-500/8 px-2.5 py-1.5 text-[11px] text-amber-700">
          <span className="font-semibold">
            {ncCount} {ncCount === 1 ? "línea es" : "líneas son"} de nota de
            crédito.
          </span>
          <span>Descuentan línea por línea (matching por SKU).</span>
        </div>
      )}
      <table className="min-w-[1260px] w-full">
        <thead>
          <tr>
            <th className="w-[70px]">Factura</th>
            <th className="w-[130px]">Cliente</th>
            <th className="w-[60px]">Pago</th>
            <th className="w-[200px]">SKU / Producto</th>
            <th className="w-[140px]">Proveedor / Grupo</th>
            <th className="w-[40px] text-right">Cant.</th>
            <th className="w-[70px] text-right">Neto</th>
            <th className="w-[140px]">Regla</th>
            <th className="w-[30px] text-right">%</th>
            <th className="w-[75px] text-right">Comisión</th>
            <th className="w-[50px]">Origen</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const isNC = line.commission_line_type === "CREDIT_NOTE_LINE";
            return (
              <tr key={line.invoice_line_id} className={isNC ? "opacity-80" : ""}>
                <td className="font-medium">
                  {getDisplayedInvoiceValue(line)}
                </td>
                <td className="truncate max-w-[130px]" title={line.customer_name || ""}>
                  {line.customer_name}
                </td>
                <td>{line.payment_completed_at?.slice(0, 10)}</td>
                <td>
                  <span className="font-medium">{line.sku}</span>
                  <span className="ml-1 text-theme-text-muted">
                    {(line.product_name || "").substring(0, 40)}
                    {(line.product_name || "").length > 40 ? "…" : ""}
                  </span>
                </td>
                <td>
                  <div className="truncate">{line.supplier_name}</div>
                  {line.commission_group_name && (
                    <div className="text-[10px] text-theme-text-muted truncate">
                      {line.commission_group_name}
                    </div>
                  )}
                </td>
                <td className="text-right">
                  {isNC ? `(${Math.abs(line.quantity)})` : line.quantity}
                </td>
                <td className={`text-right ${isNC ? "text-amber-700" : ""}`}>
                  {isNC
                    ? `(${money(Math.abs(line.net_amount))})`
                    : money(line.net_amount)}
                </td>
                <td>
                  <span className={isNC ? "text-amber-700 font-medium" : "font-medium"}>
                    {isNC ? "Nota de crédito" : line.applied_rule_label}
                  </span>
                  {line.rule_id && !isNC && (
                    <div className="text-[10px] text-theme-text-muted">
                      {line.applied_rule_scope}
                    </div>
                  )}
                </td>
                <td className="text-right">
                  {formatPercent(Number(line.commission_percent))}
                </td>
                <td
                  className={`text-right font-semibold ${isNC ? "text-amber-700" : ""}`}
                >
                  {isNC
                    ? `(${money(Math.abs(line.commission_amount))})`
                    : money(line.commission_amount)}
                </td>
                <td className="text-[10px] text-theme-text-muted">
                  {isNC ? `NC ${line.source_document_number || ""}` : "Factura"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {lines.length === 0 && (
        <div className="p-6 text-center text-sm text-theme-text-muted">
          No hay líneas que coincidan con los filtros.
          <div className="mt-1">
            Revisa vendedor, rango de pago, factura, proveedor, SKU o regla.
          </div>
        </div>
      )}
    </div>
  );
}

function getDisplayedInvoiceValue(line: CommissionPreviewLine) {
  const isNC = line.commission_line_type === "CREDIT_NOTE_LINE";
  return String(
    isNC
      ? line.original_invoice_number || line.invoice_number || line.source_document_number || line.invoice_bsale_id || ""
      : line.invoice_number || line.original_invoice_number || line.source_document_number || line.invoice_bsale_id || "",
  ).trim();
}

function getInvoiceFilterText(line: CommissionPreviewLine) {
  return getDisplayedInvoiceValue(line).toLowerCase();
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
