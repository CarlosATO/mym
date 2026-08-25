"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Download,
  Eye,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  getCommissionsSyncHealth,
  triggerManualCommissionsSync,
  type CommissionSyncHealth,
} from "@/app/actions/comercial/commissions";
import {
  cancelComisionesV2SettlementDraft,
  createComisionesV2SettlementDraft,
  getComisionesV2BasePlanConflict,
  getComisionesV2FamilyPlanById,
  getComisionesV2IssuedSettlementDetail,
  getComisionesV2OfficialPdfPreview,
  getComisionesV2SettlementDetail,
  getComisionesV2SettlementDraftReadiness,
  issueComisionesV2SettlementDraft,
  listComisionesV2FamilyPlanConflicts,
  listComisionesV2FamilyPlans,
  listComisionesV2PeriodSimulation,
  listComisionesV2SellerProfiles,
  listComisionesV2SettlementDrafts,
  listComisionesV2SettlementIssued,
  listComisionesV2SupplierFamilies,
  removeComisionesV2Plan,
  saveComisionesV2FamilyPlan,
  saveComisionesV2SalesTargetPlan,
  type ComisionesV2Family,
  type ComisionesV2BasePlanConflict,
  type ComisionesV2FamilyConflict,
  type ComisionesV2FamilyPlan,
  type ComisionesV2FamilyPlanListItem,
  type ComisionesV2PlanRemovalResult,
  type ComisionesV2FamilyRate,
  type ComisionesV2SimulationLine,
  type ComisionesV2Supplier,
  type ComisionesV2SellerProfile,
  type ComisionesV2PlanType,
  type ComisionesV2Tier,
  type ComisionesV2SettlementDraftListItem,
  type ComisionesV2SettlementIssuedListItem,
  type ComisionesV2SettlementDraftReadiness,
  type ComisionesV2SettlementDetail,
} from "@/app/actions/comisiones-v2";
import {
  OperationalTableResizeHandle,
  OperationalTableSortIndicator,
  sortOperationalRows,
  useOperationalTableSort,
  useOperationalTableWidths,
  type OperationalTableColumn,
} from "@/components/ui/operational-table";
import { LocalCombobox } from "@/components/ui/local-combobox";
import { PdfPreviewModal } from "@/modules/comercial/comisiones/components/shared/commission-modals";
import {
  generateComisionesV2DraftExcel,
  generateComisionesV2DraftPdf,
} from "./comisiones-v2-exports";
import {
  buildSupplierChartRows,
  type SupplierChartRow,
} from "./comisiones-v2-supplier-chart";

const TABLE_KEY = "mym:table:comercial:comisiones-v2-inspection";
type InspectionSection = "LINES" | "SELLERS" | "PLANS" | "DRAFTS" | "ISSUED";

function sectionFromQuery(value: string | null): InspectionSection {
  return value === "SELLERS" ||
    value === "PLANS" ||
    value === "DRAFTS" ||
    value === "ISSUED"
    ? value
    : "LINES";
}

const COLUMNS: OperationalTableColumn[] = [
  {
    id: "invoice",
    defaultWidth: 120,
    minWidth: 100,
    maxWidth: 180,
    sortable: true,
    sortKey: "document_number",
    sortType: "number",
  },
  {
    id: "customer",
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 380,
    sortable: true,
    sortKey: "customer_name",
    sortType: "text",
  },
  {
    id: "date",
    defaultWidth: 115,
    minWidth: 100,
    maxWidth: 150,
    sortable: true,
    sortKey: "emission_date",
    sortType: "date",
  },
  {
    id: "payment-date",
    defaultWidth: 135,
    minWidth: 115,
    maxWidth: 180,
    sortable: true,
    sortKey: "full_payment_date",
    sortType: "date",
  },
  {
    id: "sku",
    defaultWidth: 145,
    minWidth: 110,
    maxWidth: 240,
    sortable: true,
    sortKey: "variant_code_snapshot",
    sortType: "text",
  },
  {
    id: "product",
    defaultWidth: 300,
    minWidth: 220,
    maxWidth: 520,
    sortable: true,
    sortKey: "current_product_description",
    sortType: "text",
  },
  {
    id: "supplier",
    defaultWidth: 260,
    minWidth: 190,
    maxWidth: 450,
    sortable: true,
    sortKey: "real_supplier_business_name",
    sortType: "text",
  },
  {
    id: "family",
    defaultWidth: 190,
    minWidth: 150,
    maxWidth: 360,
    sortable: true,
    sortKey: "family_name",
    sortType: "text",
  },
  {
    id: "quantity",
    defaultWidth: 110,
    minWidth: 90,
    maxWidth: 160,
    sortable: true,
    sortKey: "quantity",
    sortType: "number",
  },
  {
    id: "net",
    defaultWidth: 135,
    minWidth: 115,
    maxWidth: 200,
    sortable: true,
    sortKey: "net_amount",
    sortType: "number",
  },
  {
    id: "plan",
    defaultWidth: 190,
    minWidth: 150,
    maxWidth: 320,
    sortable: true,
    sortKey: "plan_code",
    sortType: "text",
  },
  {
    id: "commission-type",
    defaultWidth: 150,
    minWidth: 130,
    maxWidth: 220,
    sticky: "right",
    sortable: true,
    sortKey: "plan_type",
    sortType: "text",
  },
  {
    id: "percent",
    defaultWidth: 100,
    minWidth: 85,
    maxWidth: 140,
    sticky: "right",
    sortable: true,
    sortKey: "commission_percent",
    sortType: "number",
  },
  {
    id: "commission",
    defaultWidth: 140,
    minWidth: 115,
    maxWidth: 200,
    sticky: "right",
    sortable: true,
    sortKey: "commission_amount",
    sortType: "number",
  },
];

function todayChileCivil() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

function addCivilDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const civil = new Date(Date.UTC(year, month - 1, day + days));
  return `${civil.getUTCFullYear()}-${String(civil.getUTCMonth() + 1).padStart(2, "0")}-${String(civil.getUTCDate()).padStart(2, "0")}`;
}

function chileCycleForDate(today: string) {
  if (today < "2026-07-26") return { from: "2026-07-26", to: "2026-08-25" };
  const [year, month, day] = today.split("-").map(Number);
  if (day >= 26) {
    const from = `${year}-${String(month).padStart(2, "0")}-26`;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const nextMonth = addCivilDays(
      `${year}-${String(month).padStart(2, "0")}-01`,
      daysInMonth,
    ).slice(0, 7);
    return { from, to: `${nextMonth}-25` };
  }
  const previousMonth = addCivilDays(
    `${year}-${String(month).padStart(2, "0")}-01`,
    -1,
  ).slice(0, 7);
  return {
    from: `${previousMonth}-26`,
    to: `${year}-${String(month).padStart(2, "0")}-25`,
  };
}

function initialChileCycle() {
  return chileCycleForDate(todayChileCivil());
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "short" }).format(
    new Date(year, month - 1, day, 12),
  );
}

function normalizePlanSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function formatPaymentDate(value: string | null) {
  if (!value) return "—";
  return formatDate(value.slice(0, 10));
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

function displaySku(row: ComisionesV2SimulationLine) {
  return row.variant_code_snapshot || row.current_sku || "—";
}

function isCreditNote(row: ComisionesV2SimulationLine) {
  return row.line_kind === "CREDIT_NOTE";
}

function isInvoice(row: ComisionesV2SimulationLine) {
  return !isCreditNote(row);
}

function invoiceLineKey(row: ComisionesV2SimulationLine) {
  return row.detail_id;
}

type SimulationLineGroup = {
  parent: ComisionesV2SimulationLine;
  children: ComisionesV2SimulationLine[];
};

function groupSimulationRows(rows: ComisionesV2SimulationLine[]) {
  const groups = new Map<string, SimulationLineGroup>();
  for (const row of rows) {
    if (isInvoice(row)) {
      groups.set(invoiceLineKey(row), { parent: row, children: [] });
    }
  }
  for (const row of rows) {
    if (!isCreditNote(row) || !row.original_invoice_line_id) continue;
    const group = groups.get(row.original_invoice_line_id);
    if (group) group.children.push(row);
  }
  for (const group of groups.values()) {
    group.children.sort(
      (a, b) =>
        String(a.credit_note_date ?? a.emission_date ?? "").localeCompare(
          String(b.credit_note_date ?? b.emission_date ?? ""),
        ) ||
        Number(a.source_document_number ?? a.document_number ?? 0) -
          Number(b.source_document_number ?? b.document_number ?? 0) ||
        Number(a.source_document_detail_bsale_id ?? a.detail_bsale_id ?? 0) -
          Number(b.source_document_detail_bsale_id ?? b.detail_bsale_id ?? 0),
    );
  }
  return [...groups.values()];
}

function searchValues(row: ComisionesV2SimulationLine) {
  return [
    row.document_number,
    row.document_bsale_id,
    row.source_document_number,
    row.source_document_bsale_id,
    row.original_invoice_number,
    row.original_invoice_bsale_id,
    row.customer_name,
    row.variant_code_snapshot,
    row.current_sku,
    row.current_product_description,
    row.variant_description_snapshot,
    row.variant_id,
    row.seller_bsale_id,
    row.seller_name,
    row.real_supplier_business_name,
    row.family_name,
    row.plan_code,
    row.simulation_status,
  ];
}

function statusLabel(status: string) {
  if (status === "RULE_APPLIED") return "Regla aplicada";
  if (status === "NO_ACTIVE_PLAN") return "Sin plan";
  if (status === "NO_FAMILY_RATE") return "Sin regla";
  if (status === "NO_SALES_TARGET_TIER") return "Sin tramo de meta";
  if (status === "COMMERCIAL_INCIDENT") return "Incidencia comercial";
  return "Estado no disponible";
}

function ruleLabel(value: string) {
  return value === "RULE_APPLIED" ||
    value === "NO_ACTIVE_PLAN" ||
    value === "NO_FAMILY_RATE" ||
    value === "NO_SALES_TARGET_TIER" ||
    value === "COMMERCIAL_INCIDENT"
    ? statusLabel(value)
    : value;
}

function percentLabel(value: number | null) {
  return value == null
    ? "—"
    : `${value.toLocaleString("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} %`;
}

function commissionTypeLabel(value: ComisionesV2SimulationLine["plan_type"]) {
  if (value === "FAMILY_FIXED_PERCENT") return "Por Familia";
  if (value === "SUPPLIER_SALES_TARGET") return "Meta de ventas";
  return "—";
}

function stickyRight(
  id: "commission-type" | "percent" | "commission",
  widths: Record<string, number>,
) {
  if (id === "commission") return 0;
  if (id === "percent")
    return (
      widths.commission ??
      COLUMNS.find((column) => column.id === "commission")!.defaultWidth
    );
  return (
    (widths.percent ??
      COLUMNS.find((column) => column.id === "percent")!.defaultWidth) +
    (widths.commission ??
      COLUMNS.find((column) => column.id === "commission")!.defaultWidth)
  );
}

function normalizePercentageInput(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const numeric = Number(text.replace(",", "."));
  if (!Number.isFinite(numeric)) return text;
  return numeric.toLocaleString("es-CL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function percentageNumber(value: string) {
  const numeric = Number(value.trim().replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

function amountLabel(value: number | null) {
  return value == null
    ? ""
    : value.toLocaleString("es-CL", { maximumFractionDigits: 0 });
}

function normalizeTierBounds(tiers: ComisionesV2Tier[]) {
  return tiers.map((tier, index, allTiers) => ({
    ...tier,
    lower_bound:
      index === 0
        ? 0
        : allTiers[index - 1].upper_bound == null
          ? tier.lower_bound
          : allTiers[index - 1].upper_bound! + 1,
  }));
}

function formatSyncDate(value: string | null) {
  if (!value) return "sin información";
  const parts = new Intl.DateTimeFormat("es-CL", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function blobToBase64(blob: Blob) {
  return (await blobToDataUrl(blob)).split(",")[1] ?? "";
}

function snapshotStatus(line: ComisionesV2SettlementDetail["lines"][number]) {
  return typeof line.metadata.simulation_status === "string"
    ? line.metadata.simulation_status
    : "RULE_APPLIED";
}

function snapshotTypeLabel(
  line: ComisionesV2SettlementDetail["lines"][number],
) {
  const status = snapshotStatus(line);
  if (status === "NO_ACTIVE_PLAN") return "Sin comisión";
  if (status === "NO_FAMILY_RATE") return "Por Familia · Sin regla";
  return commissionTypeLabel(line.plan_type);
}

function snapshotPlanLabel(
  line: ComisionesV2SettlementDetail["lines"][number],
) {
  return snapshotStatus(line) === "NO_ACTIVE_PLAN"
    ? "Sin plan"
    : (line.plan_code_snapshot ?? "—");
}

type ExecutiveSupplierRow = {
  key: string;
  supplierName: string;
  invoices: number;
  lines: number;
  net: number;
  commission: number;
  plan: string;
  type: string;
  rule: string;
  familyCount: number;
  effectivePercent: number;
  noCommission: number;
  noCommissionNet: number;
};

function buildExecutiveSupplierRows(rows: ComisionesV2SimulationLine[]) {
  const grouped = new Map<string, ComisionesV2SimulationLine[]>();
  for (const row of rows) {
    const key = row.real_supplier_id
      ? `id:${row.real_supplier_id}`
      : `name:${row.real_supplier_business_name ?? "Sin proveedor"}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped.entries()]
    .map(([key, supplierRows]): ExecutiveSupplierRow => {
      const net = supplierRows.reduce(
        (sum, row) => sum + Number(row.net_amount ?? 0),
        0,
      );
      const commission = supplierRows.reduce(
        (sum, row) => sum + Number(row.commission_amount ?? 0),
        0,
      );
      const noCommissionRows = supplierRows.filter(
        (row) =>
          row.simulation_status === "NO_ACTIVE_PLAN" ||
          row.simulation_status === "NO_FAMILY_RATE",
      );
      const plans = [
        ...new Set(
          supplierRows
            .filter((row) => row.simulation_status !== "NO_ACTIVE_PLAN")
            .map((row) => row.plan_code ?? "—"),
        ),
      ];
      const types = [
        ...new Set(
          supplierRows.map((row) => {
            if (row.simulation_status === "NO_ACTIVE_PLAN")
              return "Sin comisión";
            return row.plan_type === "FAMILY_FIXED_PERCENT"
              ? "Por Familia"
              : row.plan_type === "SUPPLIER_SALES_TARGET"
                ? "Meta de ventas"
                : "Inconsistente";
          }),
        ),
      ];
      const targetRows = supplierRows.filter(
        (row) => row.plan_type === "SUPPLIER_SALES_TARGET",
      );
      const targetTiers = [
        ...new Set(
          targetRows.map((row) =>
            [
              row.supplier_total_net,
              row.tier_lower_bound,
              row.tier_upper_bound,
              row.commission_percent,
            ].join("|"),
          ),
        ),
      ];
      const familyRows = supplierRows.filter(
        (row) => row.plan_type === "FAMILY_FIXED_PERCENT",
      );
      const familyAppliedRows = familyRows.filter(
        (row) => row.simulation_status === "RULE_APPLIED",
      );
      const familyCount = new Set(
        familyRows.map(
          (row) => row.family_bsale_product_type_id ?? row.family_name ?? "—",
        ),
      ).size;
      const rule =
        targetRows.length > 0 && targetTiers.length === 1
          ? (() => {
              const [total, lower, upper, percentage] =
                targetTiers[0].split("|");
              return `Venta ${total === "null" ? "—" : formatCurrency(Number(total))} · Tramo ${lower === "null" ? "—" : formatCurrency(Number(lower))} → ${upper === "null" ? "Sin límite" : formatCurrency(Number(upper))} · ${percentage === "null" ? "—" : percentLabel(Number(percentage))}`;
            })()
          : targetTiers.length > 1
            ? "Múltiples tramos"
              : familyAppliedRows.length > 0
                ? `${familyCount} familias aplicadas`
                : "—";
      return {
        key,
        supplierName:
          supplierRows[0]?.real_supplier_business_name ??
          "Proveedor sin nombre",
        invoices: new Set(
          supplierRows
            .filter(isInvoice)
            .map((row) => row.document_bsale_id),
        ).size,
        lines: supplierRows.length,
        net,
        commission,
        plan:
          plans.length === 0
            ? "Sin plan"
            : plans.length === 1
              ? plans[0]
              : "Múltiples planes",
        type: types.length === 1 ? types[0] : "Múltiples situaciones",
        rule,
        familyCount,
        effectivePercent: net ? (commission / net) * 100 : 0,
        noCommission: noCommissionRows.length,
        noCommissionNet: noCommissionRows.reduce(
          (sum, row) => sum + Number(row.net_amount ?? 0),
          0,
        ),
      };
    })
    .sort((a, b) => b.net - a.net);
}

function SupplierSalesChart({
  rows,
  supplierFilter,
}: {
  rows: ComisionesV2SimulationLine[];
  supplierFilter: string;
}) {
  const context = useMemo(() => {
    if (supplierFilter.startsWith("SUPPLIER:")) {
      const supplierId = supplierFilter.slice("SUPPLIER:".length);
      return {
        mode: "SUPPLIER" as const,
        rows: rows.filter((row) => String(row.real_supplier_id) === supplierId),
        label: undefined,
      };
    }
    if (supplierFilter.startsWith("FAMILY:")) {
      const familyId = supplierFilter.slice("FAMILY:".length);
      const familyRows = rows.filter(
        (row) => String(row.family_bsale_product_type_id ?? "") === familyId,
      );
      return {
        mode: "FAMILY" as const,
        rows: familyRows,
        label: familyRows[0]?.family_name ?? "Familia seleccionada",
      };
    }
    return { mode: "GENERAL" as const, rows, label: undefined };
  }, [rows, supplierFilter]);
  const chartRows = useMemo(
    () => buildSupplierChartRows(context.rows).slice(0, 5),
    [context.rows],
  );
  const supplierSummary = useMemo(
    () => buildExecutiveSupplierRows(context.rows)[0],
    [context.rows],
  );
  const allSupplierRows = useMemo(() => buildSupplierChartRows(rows), [rows]);
  const remaining = Math.max(0, allSupplierRows.length - 5);
  const remainingNet = allSupplierRows
    .slice(5)
    .reduce((sum, row) => sum + row.net, 0);
  const remainingCommission = allSupplierRows
    .slice(5)
    .reduce((sum, row) => sum + row.commission, 0);
  const maxNet = chartRows[0]?.net ?? 0;
  const title =
    context.mode === "GENERAL"
      ? "Top 5 proveedores por venta neta"
      : context.mode === "FAMILY"
        ? `Top proveedores para ${context.label}`
        : "Resumen del proveedor seleccionado";
  return (
    <section className="shrink-0 border-b border-theme-border/60 bg-theme-surface px-3 py-2 md:px-4">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-bold text-theme-text">{title}</h2>
        <span className="text-[10px] text-theme-text-muted">
          No cambia con los filtros de la tabla.
        </span>
      </div>
      {context.mode === "SUPPLIER" && supplierSummary ? (
        <SupplierContextSummary row={supplierSummary} />
      ) : chartRows.length === 0 ? (
        <p className="text-[11px] text-theme-text-muted">
          No hay líneas para este contexto.
        </p>
      ) : (
        <div className="space-y-0.5">
          {chartRows.map((row) => (
            <SupplierSalesChartRow key={row.key} row={row} maxNet={maxNet} />
          ))}
          {context.mode === "GENERAL" && remaining > 0 && (
            <p className="pt-0.5 text-[10px] tabular-nums text-theme-text-muted">
              {remaining.toLocaleString("es-CL")} proveedores restantes · Neto{" "}
              {formatCurrency(remainingNet)} · Comisión{" "}
              {formatCurrency(remainingCommission)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SupplierContextSummary({
  row,
}: {
  row: ExecutiveSupplierRow;
}) {
  return (
    <div className="rounded-lg border border-theme-border bg-theme-text/[0.02] px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span
          className="truncate text-xs font-bold text-theme-text"
          title={row.supplierName}
        >
          {row.supplierName}
        </span>
        <span className="rounded-full border border-theme-accent/25 bg-theme-accent/10 px-1.5 py-0.5 text-[9px] font-bold text-theme-accent">
          {row.type}
        </span>
        <span
          className="max-w-[220px] truncate rounded-full border border-theme-border bg-theme-surface px-1.5 py-0.5 text-[9px] text-theme-text-muted"
          title={row.plan}
        >
          {row.plan}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-1.5 sm:max-w-[640px]">
        <SupplierContextMetric label="Venta neta" value={formatCurrency(row.net)} />
        <SupplierContextMetric label="Comisión" value={formatCurrency(row.commission)} />
        <SupplierContextMetric label="Tasa comisión" value={percentLabel(row.effectivePercent)} />
      </div>
      <p className="mt-1.5 truncate text-[10px] text-theme-text-muted" title={row.rule}>
        <span className="font-semibold text-theme-text-muted/80">Regla / contexto:</span>{" "}
        {row.rule}
        {row.type === "Por Familia" && (
          <> · {row.familyCount.toLocaleString("es-CL")} familias · % agregado {percentLabel(row.effectivePercent)}{row.noCommission > 0 ? ` · ${formatCurrency(row.noCommissionNet)} sin regla` : ""}</>
        )}
      </p>
    </div>
  );
}

function SupplierContextMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-theme-border/70 bg-theme-surface px-2 py-1">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-theme-text-muted">
        {label}
      </p>
      <p className="truncate text-[11px] font-bold tabular-nums text-theme-text" title={value}>
        {value}
      </p>
    </div>
  );
}

function SupplierSalesChartRow({
  row,
  maxNet,
}: {
  row: SupplierChartRow;
  maxNet: number;
}) {
  const width = maxNet > 0 ? Math.max((row.net / maxNet) * 100, row.net ? 1 : 0) : 0;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(120px,0.8fr)_minmax(110px,2fr)] items-center gap-2 text-[10px]">
      <span className="truncate font-semibold text-theme-text" title={row.supplierName}>
        {row.supplierName}
      </span>
      <div className="min-w-0">
        <div className="h-1.5 overflow-hidden rounded-full bg-theme-text/10" title={row.supplierName}>
          <div className="h-full rounded-full bg-theme-accent" style={{ width: `${width}%` }} />
        </div>
        <div className="truncate tabular-nums text-theme-text-muted">
          {formatCurrency(row.net)} · Comisión {formatCurrency(row.commission)} · {percentLabel(row.effectivePercent)}
        </div>
       </div>
    </div>
  );
}

function ExecutiveSummary({
  rows,
  selectedSellerId,
  sellerProfiles,
  from,
  to,
  loading,
  onSellerChange,
  onFromChange,
  onToChange,
  onConsult,
}: {
  rows: ComisionesV2SimulationLine[];
  selectedSellerId: number | null;
  sellerProfiles: ComisionesV2SellerProfile[];
  from: string;
  to: string;
  loading: boolean;
  onSellerChange: (sellerId: number | null) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onConsult: () => void;
}) {
  const supplierRows = useMemo(() => buildExecutiveSupplierRows(rows), [rows]);
  const kpis = useMemo(
    () => ({
       invoices: new Set(
         rows.filter(isInvoice).map((row) => row.document_bsale_id),
       ).size,
      lines: rows.length,
      net: rows.reduce((sum, row) => sum + Number(row.net_amount ?? 0), 0),
      commission: rows.reduce(
        (sum, row) => sum + Number(row.commission_amount ?? 0),
        0,
      ),
      noCommission: rows.filter(
        (row) =>
          row.simulation_status === "NO_ACTIVE_PLAN" ||
          row.simulation_status === "NO_FAMILY_RATE",
      ).length,
      noCommissionNet: rows
        .filter(
          (row) =>
            row.simulation_status === "NO_ACTIVE_PLAN" ||
            row.simulation_status === "NO_FAMILY_RATE",
        )
        .reduce((sum, row) => sum + Number(row.net_amount ?? 0), 0),
      noPlanSuppliers: new Set(
        rows
          .filter((row) => row.simulation_status === "NO_ACTIVE_PLAN")
          .map(
            (row) => row.real_supplier_id ?? row.real_supplier_business_name,
          ),
      ).size,
      noFamilyRows: rows.filter(
        (row) => row.simulation_status === "NO_FAMILY_RATE",
      ).length,
      incidents: rows.filter(
        (row) => row.simulation_status === "COMMERCIAL_INCIDENT",
      ).length,
    }),
    [rows],
  );
  const targetRows = rows.filter(
    (row) => row.plan_type === "SUPPLIER_SALES_TARGET",
  );
  const familyRows = rows.filter(
    (row) => row.plan_type === "FAMILY_FIXED_PERCENT",
  );
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
      <div className="mb-3 flex flex-wrap items-end gap-3 rounded-xl border border-theme-border bg-theme-surface p-3">
        <label className="grid shrink-0 gap-1 text-[11px] font-semibold text-theme-text-muted">
          Vendedor
          <select
            value={selectedSellerId ?? ""}
            onChange={(event) =>
              onSellerChange(
                event.target.value ? Number(event.target.value) : null,
              )
            }
            className="h-9 min-w-[220px] rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text"
          >
            <option value="">Seleccionar vendedor</option>
            {sellerProfiles
              .filter((profile) => profile.active && profile.is_commissionable)
              .map((profile) => (
                <option
                  key={profile.seller_bsale_id}
                  value={profile.seller_bsale_id}
                >
                  {profile.seller_name} · {profile.seller_bsale_id}
                </option>
              ))}
          </select>
        </label>
        <label className="grid shrink-0 gap-1 text-[11px] font-semibold text-theme-text-muted">
          Pago desde
          <input
            type="date"
            value={from}
            onChange={(event) => onFromChange(event.target.value)}
            className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text"
          />
        </label>
        <label className="grid shrink-0 gap-1 text-[11px] font-semibold text-theme-text-muted">
          Pago hasta
          <input
            type="date"
            value={to}
            onChange={(event) => onToChange(event.target.value)}
            className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text"
          />
        </label>
        <button
          type="button"
          onClick={onConsult}
          disabled={loading}
          className="h-9 rounded-lg bg-theme-accent px-4 text-xs font-bold text-white disabled:opacity-60"
        >
          {loading ? "Consultando..." : "Consultar"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <Summary label="Facturas" value={kpis.invoices} />
        <Summary label="Líneas" value={kpis.lines} />
        <Summary label="Venta neta" value={formatCurrency(kpis.net)} wide />
        <Summary
          label="Comisión estimada"
          value={formatCurrency(kpis.commission)}
          wide
        />
        <Summary
          label="Tasa comisión"
          value={percentLabel(
            kpis.net ? (kpis.commission / kpis.net) * 100 : 0,
          )}
        />
        <Summary label="Proveedores" value={supplierRows.length} />
        <Summary
          label="Sin comisión"
          value={kpis.noCommission}
          tone={kpis.noCommission ? "amber" : "green"}
        />
        <Summary
          label="Neto sin comisión"
          value={formatCurrency(kpis.noCommissionNet)}
          tone={kpis.noCommissionNet ? "amber" : "green"}
          wide
        />
      </div>
      {(kpis.noPlanSuppliers || kpis.noFamilyRows || kpis.incidents) > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-700">
          <span className="font-semibold">Revisar:</span>
          {kpis.noPlanSuppliers > 0 && (
            <span>{kpis.noPlanSuppliers} proveedor(es) sin plan</span>
          )}
          {kpis.noFamilyRows > 0 && (
            <span>{kpis.noFamilyRows} familia(s) sin regla</span>
          )}
          {kpis.incidents > 0 && (
            <span>{kpis.incidents} incidencia(s) comercial(es)</span>
          )}
        </div>
      )}
      {selectedSellerId == null ? (
        <div className="mt-3 rounded-xl border border-theme-border bg-theme-surface p-6 text-center text-sm text-theme-text-muted">
          Selecciona un vendedor y consulta un período para ver el resumen.
        </div>
      ) : (
        <>
          <section className="mt-3 overflow-hidden rounded-xl border border-theme-border bg-theme-surface">
            <div className="border-b border-theme-border bg-theme-text/[0.02] px-3 py-2">
              <h2 className="text-sm font-bold text-theme-text">
                Resumen por Proveedor
              </h2>
              <p className="mt-0.5 text-[10px] text-theme-text-muted">
                Resultado vigente de la simulación.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1100px] w-full table-fixed text-xs">
                <thead className="bg-theme-text/[0.03] text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                  <tr>
                    <th className="w-[180px] px-2 py-2">Proveedor</th>
                    <th className="w-[65px] px-2 py-2 text-right">Facturas</th>
                    <th className="w-[60px] px-2 py-2 text-right">Líneas</th>
                    <th className="w-[125px] px-2 py-2 text-right">
                      Venta neta
                    </th>
                    <th className="w-[170px] px-2 py-2">Plan</th>
                    <th className="w-[115px] px-2 py-2">Tipo</th>
                    <th className="w-[260px] px-2 py-2">Regla / Tramo</th>
                    <th className="w-[85px] px-2 py-2 text-right">
                      Tasa comisión
                    </th>
                    <th className="w-[125px] px-2 py-2 text-right">Comisión</th>
                    <th className="w-[145px] px-2 py-2 text-right">
                      Sin comisión
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/50">
                  {supplierRows.map((row) => (
                    <tr key={row.key}>
                      <td
                        className="truncate px-2 py-2 font-semibold text-theme-text"
                        title={row.supplierName}
                      >
                        {row.supplierName}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {row.invoices.toLocaleString("es-CL")}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {row.lines.toLocaleString("es-CL")}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatCurrency(row.net)}
                      </td>
                      <td className="truncate px-2 py-2" title={row.plan}>
                        {row.plan}
                      </td>
                      <td
                        className="truncate px-2 py-2 text-theme-text-muted"
                        title={row.type}
                      >
                        {row.type}
                      </td>
                      <td
                        className="truncate px-2 py-2 text-theme-text-muted"
                        title={row.rule}
                      >
                        {row.rule}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {percentLabel(row.effectivePercent)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-semibold">
                        {formatCurrency(row.commission)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-amber-700">
                        {row.noCommission.toLocaleString("es-CL")} ·{" "}
                        {formatCurrency(row.noCommissionNet)}
                      </td>
                    </tr>
                  ))}
                </tbody>
               </table>
             </div>
           </section>
          {targetRows.length > 0 && (
            <div className="mt-3 rounded-xl border border-sky-500/25 bg-sky-500/5 p-3 text-xs text-sky-800">
              <p className="font-semibold">Meta de ventas</p>
              <p className="mt-1">
                Los tramos mostrados corresponden a `supplier_total_net`,
                límites y porcentaje devueltos por la simulación. El contrato
                actual no entrega el siguiente tramo, por lo que no se calcula
                faltante.
              </p>
            </div>
          )}
          {familyRows.length > 0 && (
            <div className="mt-3 rounded-xl border border-theme-border bg-theme-surface p-3 text-xs text-theme-text-muted">
              Por Familia:{" "}
              {new Set(
                familyRows
                  .filter((row) => row.simulation_status === "RULE_APPLIED")
                  .map(
                    (row) =>
                      row.family_bsale_product_type_id ?? row.family_name,
                  ),
              ).size.toLocaleString("es-CL")}{" "}
              Familias aplicadas · Tasa comisión agregada{" "}
              {percentLabel(
                (familyRows.reduce(
                  (sum, row) => sum + Number(row.commission_amount ?? 0),
                  0,
                ) /
                  Math.max(
                    1,
                    familyRows.reduce(
                      (sum, row) => sum + Number(row.net_amount ?? 0),
                      0,
                    ),
                  )) *
                  100,
              )}
              . Sin regla:{" "}
              {familyRows
                .filter((row) => row.simulation_status === "NO_FAMILY_RATE")
                .length.toLocaleString("es-CL")}{" "}
              líneas ·{" "}
              {formatCurrency(
                familyRows
                  .filter((row) => row.simulation_status === "NO_FAMILY_RATE")
                  .reduce((sum, row) => sum + Number(row.net_amount ?? 0), 0),
              )}
              .
            </div>
          )}
        </>
      )}
    </div>
  );
}

type SupplierSettlementSummaryRow = {
  key: string;
  supplierName: string;
  invoiceCount: number;
  lineCount: number;
  netAmount: number;
  commissionAmount: number;
  effectivePercent: number;
  planLabel: string;
  typeLabel: string;
  ruleLabel: string;
  noCommissionCount: number;
  noCommissionNet: number;
};

function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function supplierTierLabel(lines: ComisionesV2SettlementDetail["lines"]) {
  const tiers = uniqueValues(
    lines
      .filter((line) => line.plan_type === "SUPPLIER_SALES_TARGET")
      .map((line) =>
        [
          line.supplier_total_net == null
            ? "—"
            : formatCurrency(line.supplier_total_net),
          line.tier_lower_bound == null
            ? "—"
            : formatCurrency(line.tier_lower_bound),
          line.tier_upper_bound == null
            ? "Sin límite"
            : formatCurrency(line.tier_upper_bound),
          line.percentage == null ? "—" : percentLabel(line.percentage),
        ].join("|"),
      ),
  );
  if (tiers.length !== 1) return tiers.length > 1 ? "Múltiples tramos" : "—";
  const [supplierTotal, lower, upper, percentage] = tiers[0].split("|");
  return `Venta ${supplierTotal} · Tramo ${lower} → ${upper} · ${percentage}`;
}

function buildSupplierSettlementSummary(
  detail: ComisionesV2SettlementDetail,
): SupplierSettlementSummaryRow[] {
  const grouped = new Map<
    string,
    {
      supplierName: string;
      lines: ComisionesV2SettlementDetail["lines"];
    }
  >();
  for (const line of detail.lines) {
    const identity =
      line.real_supplier_id != null
        ? `id:${line.real_supplier_id}`
        : `name:${line.real_supplier_name_snapshot ?? "Sin proveedor"}`;
    const group = grouped.get(identity) ?? {
      supplierName: line.real_supplier_name_snapshot ?? "Proveedor sin nombre",
      lines: [],
    };
    group.lines.push(line);
    grouped.set(identity, group);
  }
  return [...grouped.entries()]
    .map(([key, group]) => {
      const lines = group.lines;
      const netAmount = lines.reduce((sum, line) => sum + line.net_amount, 0);
      const commissionAmount = lines.reduce(
        (sum, line) => sum + line.commission_amount,
        0,
      );
      const noCommissionLines = lines.filter((line) => {
        const status = snapshotStatus(line);
        return status === "NO_ACTIVE_PLAN" || status === "NO_FAMILY_RATE";
      });
      const planLabels = uniqueValues(
        lines
          .filter((line) => snapshotStatus(line) !== "NO_ACTIVE_PLAN")
          .map((line) => line.plan_code_snapshot ?? "—"),
      );
      const typeLabels = uniqueValues(
        lines.map((line) => {
          const status = snapshotStatus(line);
          if (status === "NO_ACTIVE_PLAN") return "Sin comisión";
          return line.plan_type === "FAMILY_FIXED_PERCENT"
            ? "Por Familia"
            : line.plan_type === "SUPPLIER_SALES_TARGET"
              ? "Meta de ventas"
              : "Inconsistente";
        }),
      );
      const hasTarget = lines.some(
        (line) => line.plan_type === "SUPPLIER_SALES_TARGET",
      );
      const hasFamily = lines.some(
        (line) => line.plan_type === "FAMILY_FIXED_PERCENT",
      );
      const familyCount = new Set(
        lines
          .filter((line) => line.plan_type === "FAMILY_FIXED_PERCENT")
          .map((line) =>
            line.family_bsale_product_type_id != null
              ? String(line.family_bsale_product_type_id)
              : (line.family_name_snapshot ?? "—"),
          ),
      ).size;
      const ruleLabel =
        hasTarget && hasFamily
          ? "Múltiples situaciones"
          : hasTarget
            ? supplierTierLabel(lines)
            : hasFamily
              ? familyCount > 0
                ? `${familyCount} familias`
                : "Varias familias"
              : "—";
      return {
        key,
        supplierName: group.supplierName,
        invoiceCount: new Set(
          lines.map(
            (line) =>
              `${line.source_document_type_id ?? "document"}:${line.source_document_bsale_id}`,
          ),
        ).size,
        lineCount: lines.length,
        netAmount,
        commissionAmount,
        effectivePercent: netAmount ? (commissionAmount / netAmount) * 100 : 0,
        planLabel:
          planLabels.length === 0
            ? "Sin plan"
            : planLabels.length === 1
              ? planLabels[0]
              : "Múltiples planes",
        typeLabel:
          typeLabels.length === 1 ? typeLabels[0] : "Múltiples situaciones",
        ruleLabel,
        noCommissionCount: noCommissionLines.length,
        noCommissionNet: noCommissionLines.reduce(
          (sum, line) => sum + line.net_amount,
          0,
        ),
      };
    })
    .sort((a, b) => b.netAmount - a.netAmount);
}

function SupplierSettlementSummary({
  detail,
}: {
  detail: ComisionesV2SettlementDetail;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rows = useMemo(() => buildSupplierSettlementSummary(detail), [detail]);
  const summaryNet = rows.reduce((sum, row) => sum + row.netAmount, 0);
  const summaryCommission = rows.reduce(
    (sum, row) => sum + row.commissionAmount,
    0,
  );
  if (
    process.env.NODE_ENV !== "production" &&
    (summaryNet !== detail.settlement.total_net_amount ||
      summaryCommission !== detail.settlement.total_commission_amount)
  ) {
    console.warn(
      "Comisiones V2 supplier summary totals differ from settlement",
      {
        summaryNet,
        settlementNet: detail.settlement.total_net_amount,
        summaryCommission,
        settlementCommission: detail.settlement.total_commission_amount,
      },
    );
  }
  return (
    <section className="shrink-0 border-b border-theme-border bg-theme-surface">
      <div className="flex items-center justify-between gap-2 px-3 py-2 md:px-4">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
          className="text-xs font-bold text-theme-text hover:text-theme-accent"
        >
          {isOpen ? "Ocultar resumen" : "Ver resumen por proveedor"}
        </button>
        <span className="text-[10px] text-theme-text-muted">
          {rows.length.toLocaleString("es-CL")} proveedores · Snapshot persistido
        </span>
      </div>
      {isOpen && <div className="border-t border-theme-border px-3 py-3 md:px-4 md:py-4">
        <div className="overflow-x-auto">
        <table className="min-w-[1050px] w-full table-fixed text-xs">
          <thead className="bg-theme-text/[0.03] text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
            <tr>
              <th className="w-[180px] px-2 py-2">Proveedor REAL</th>
              <th className="w-[70px] px-2 py-2 text-right">Facturas</th>
              <th className="w-[65px] px-2 py-2 text-right">Líneas</th>
              <th className="w-[125px] px-2 py-2 text-right">Venta neta</th>
              <th className="w-[170px] px-2 py-2">Plan</th>
              <th className="w-[115px] px-2 py-2">Tipo</th>
              <th className="w-[245px] px-2 py-2">Regla / Tramo</th>
              <th className="w-[85px] px-2 py-2 text-right">Tasa comisión</th>
              <th className="w-[125px] px-2 py-2 text-right">Comisión</th>
              <th className="w-[145px] px-2 py-2 text-right">Sin comisión</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/50">
            {rows.map((row) => (
              <tr key={row.key} className="hover:bg-theme-text/[0.025]">
                <td
                  className="truncate px-2 py-2 font-semibold text-theme-text"
                  title={row.supplierName}
                >
                  {row.supplierName}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-theme-text">
                  {row.invoiceCount.toLocaleString("es-CL")}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-theme-text">
                  {row.lineCount.toLocaleString("es-CL")}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-theme-text">
                  {formatCurrency(row.netAmount)}
                </td>
                <td
                  className="truncate px-2 py-2 text-theme-text"
                  title={row.planLabel}
                >
                  {row.planLabel}
                </td>
                <td
                  className="truncate px-2 py-2 text-theme-text-muted"
                  title={row.typeLabel}
                >
                  {row.typeLabel}
                </td>
                <td
                  className="truncate px-2 py-2 text-theme-text-muted"
                  title={row.ruleLabel}
                >
                  {row.ruleLabel}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-theme-text">
                  {percentLabel(row.effectivePercent)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums font-semibold text-theme-text">
                  {formatCurrency(row.commissionAmount)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-amber-700">
                  {row.noCommissionCount.toLocaleString("es-CL")} ·{" "}
                  {formatCurrency(row.noCommissionNet)}
                </td>
              </tr>
            ))}
          </tbody>
         </table>
         </div>
       </div>}
     </section>
  );
}

type DraftCancelTarget = {
  settlementId: string;
  sellerBsaleId: number;
  sellerName: string;
  periodFrom: string;
  periodTo: string;
  linesCount: number;
  totalNetAmount: number;
  totalCommissionAmount: number;
};

type IssueSuccess = {
  settlementId: string;
  settlementCode: string;
  sellerName: string;
  periodFrom: string;
  periodTo: string;
  totalCommissionAmount: number;
};

function draftCancelTargetFromList(
  draft: ComisionesV2SettlementDraftListItem,
): DraftCancelTarget {
  return {
    settlementId: draft.settlement_id,
    sellerBsaleId: draft.seller_bsale_id,
    sellerName: draft.seller_name_snapshot,
    periodFrom: draft.period_from,
    periodTo: draft.period_to,
    linesCount: draft.lines_count,
    totalNetAmount: draft.total_net_amount,
    totalCommissionAmount: draft.total_commission_amount,
  };
}

function draftCancelTargetFromDetail(
  detail: ComisionesV2SettlementDetail,
): DraftCancelTarget {
  return {
    settlementId: detail.settlement.id,
    sellerBsaleId: detail.settlement.seller_bsale_id,
    sellerName: detail.settlement.seller_name_snapshot,
    periodFrom: detail.settlement.period_from,
    periodTo: detail.settlement.period_to,
    linesCount: detail.lines.length,
    totalNetAmount: detail.settlement.total_net_amount,
    totalCommissionAmount: detail.settlement.total_commission_amount,
  };
}

export function ComisionesV2Inspection({
  isSuperUser,
}: {
  isSuperUser: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const section = sectionFromQuery(searchParams.get("section"));
  const [visitedSections, setVisitedSections] = useState<Set<InspectionSection>>(
    () => new Set(["LINES", "SELLERS", "PLANS", "DRAFTS", "ISSUED"]),
  );
  const [initialPeriod] = useState(initialChileCycle);
  const [from, setFrom] = useState(initialPeriod.from);
  const [to, setTo] = useState(initialPeriod.to);
  const [selectedSellerId, setSelectedSellerId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [allSimulationRows, setAllSimulationRows] = useState<
    ComisionesV2SimulationLine[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasQueried, setHasQueried] = useState(false);
  const [sellerProfiles, setSellerProfiles] = useState<
    ComisionesV2SellerProfile[]
  >([]);
  const [sellerLoading, setSellerLoading] = useState(false);
  const [sellerError, setSellerError] = useState<string | null>(null);
  const [planCache, setPlanCache] = useState<
    ComisionesV2FamilyPlanListItem[] | null
  >(null);
  const [planSuppliers, setPlanSuppliers] = useState<
    ComisionesV2Supplier[] | null
  >(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canIssue, setCanIssue] = useState(false);
  const [syncHealth, setSyncHealth] = useState<CommissionSyncHealth | null>(
    null,
  );
  const [syncHealthLoading, setSyncHealthLoading] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [simulationRefreshNotice, setSimulationRefreshNotice] = useState<
    string | null
  >(null);
  const [statusFilter, setStatusFilter] = useState<
    "NONE" | "SIN_REGLA" | "INCIDENCIAS"
  >("NONE");
  const [supplierFilter, setSupplierFilter] = useState("ALL");
  const [ruleFilter, setRuleFilter] = useState("ALL");
  const [percentFilter, setPercentFilter] = useState("ALL");
  const supplierFilterRef = useRef(supplierFilter);
  const ruleFilterRef = useRef(ruleFilter);
  const percentFilterRef = useRef(percentFilter);
  const batchCacheRef = useRef(
    new Map<
      string,
      {
        companyId: string;
        from: string;
        to: string;
        rows: ComisionesV2SimulationLine[];
      }
    >(),
  );
  const activeCompanyRef = useRef<string | null>(null);
  const batchRequestSequence = useRef(0);
  const selectedSellerRef = useRef<number | null>(null);
  const planRequestSequence = useRef(0);
  const [drafts, setDrafts] = useState<
    ComisionesV2SettlementDraftListItem[] | null
  >(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftDetail, setDraftDetail] =
    useState<ComisionesV2SettlementDetail | null>(null);
  const [draftDetailLoading, setDraftDetailLoading] = useState(false);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [draftModal, setDraftModal] = useState<"CONFIRM" | "BLOCKED" | null>(
    null,
  );
  const [draftReadiness, setDraftReadiness] =
    useState<ComisionesV2SettlementDraftReadiness | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [draftExportBusy, setDraftExportBusy] = useState<
    "PDF" | "EXCEL" | null
  >(null);
  const [draftPdfPreview, setDraftPdfPreview] = useState<{
    base64: string;
    filename: string;
  } | null>(null);
  const [draftCancelTarget, setDraftCancelTarget] =
    useState<DraftCancelTarget | null>(null);
  const [draftCancelReason, setDraftCancelReason] = useState("");
  const [draftCancelBusy, setDraftCancelBusy] = useState(false);
  const [issueModal, setIssueModal] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueSuccess, setIssueSuccess] = useState<IssueSuccess | null>(null);
  const [issued, setIssued] = useState<
    ComisionesV2SettlementIssuedListItem[] | null
  >(null);
  const [issuedLoading, setIssuedLoading] = useState(false);
  const [issuedError, setIssuedError] = useState<string | null>(null);
  const [selectedIssuedId, setSelectedIssuedId] = useState<string | null>(null);
  const [issuedDetail, setIssuedDetail] =
    useState<ComisionesV2SettlementDetail | null>(null);
  const [issuedDetailLoading, setIssuedDetailLoading] = useState(false);
  const [issuedDetailError, setIssuedDetailError] = useState<string | null>(
    null,
  );
  const [issuedPdfError, setIssuedPdfError] = useState<string | null>(null);
  const [issuedExportBusy, setIssuedExportBusy] = useState<
    "PDF" | "EXCEL" | null
  >(null);
  const [issuedPdfPreview, setIssuedPdfPreview] = useState<{
    base64: string;
    filename: string;
  } | null>(null);
  const issuedDetailRequestSequence = useRef(0);
  const {
    widths,
    setColumnWidth,
    persist,
    reset: resetWidths,
  } = useOperationalTableWidths(TABLE_KEY, COLUMNS);
  const { sort, cycleSort } = useOperationalTableSort(TABLE_KEY, COLUMNS);

  const loadDrafts = useCallback(
    async (force = false) => {
      if (drafts && !force) return true;
      setDraftLoading(true);
      setDraftError(null);
      const result = await listComisionesV2SettlementDrafts();
      setDraftLoading(false);
      if (result.error) {
        setDraftError(result.error);
        return false;
      }
      setDrafts(result.data);
      return true;
    },
    [drafts],
  );

  const loadIssued = useCallback(
    async (force = false) => {
      if (issued && !force) return true;
      setIssuedLoading(true);
      setIssuedError(null);
      const result = await listComisionesV2SettlementIssued();
      setIssuedLoading(false);
      if (result.error) {
        setIssuedError(result.error);
        return false;
      }
      setIssued(result.data);
      return true;
    },
    [issued],
  );

  const openDraftDetail = useCallback(async (settlementId: string) => {
    if (!settlementId) {
      setSelectedDraftId(null);
      setDraftDetail(null);
      setDraftDetailLoading(false);
      setDraftNotice(null);
      return;
    }
    setSelectedDraftId(settlementId);
    setDraftDetailLoading(true);
    setDraftNotice(null);
    const result = await getComisionesV2SettlementDetail(settlementId);
    setDraftDetailLoading(false);
    if (result.error) {
      setDraftDetail(null);
      setDraftNotice(result.error);
      return;
    }
    setDraftDetail(result.data);
  }, []);

  const openIssuedDetail = useCallback(async (settlementId: string) => {
    const requestId = ++issuedDetailRequestSequence.current;
    if (!settlementId) {
      setSelectedIssuedId(null);
      setIssuedDetail(null);
      setIssuedDetailLoading(false);
      setIssuedDetailError(null);
      setIssuedPdfError(null);
      setIssuedPdfPreview(null);
      return;
    }
    setSelectedIssuedId(settlementId);
    setIssuedDetailLoading(true);
    setIssuedDetailError(null);
    setIssuedPdfError(null);
    setIssuedPdfPreview(null);
    const result = await getComisionesV2IssuedSettlementDetail(settlementId);
    if (requestId !== issuedDetailRequestSequence.current) return;
    setIssuedDetailLoading(false);
    if (result.error) {
      setIssuedDetail(null);
      setIssuedDetailError(result.error);
      return;
    }
    setIssuedDetail(result.data);
  }, []);

  async function exportDraftPdf() {
    if (!draftDetail || draftExportBusy) return;
    setDraftExportBusy("PDF");
    setDraftNotice(null);
    try {
      const logoResponse = await fetch("/logo-transparent.png");
      const logo = logoResponse.ok
        ? await blobToDataUrl(await logoResponse.blob())
        : undefined;
      const blob = generateComisionesV2DraftPdf(draftDetail, logo);
      setDraftPdfPreview({
        base64: await blobToBase64(blob),
        filename: `liquidacion_comisiones_borrador_${draftDetail.settlement.id}.pdf`,
      });
    } catch (error) {
      setDraftNotice(
        error instanceof Error
          ? error.message
          : "No se pudo generar el PDF del borrador.",
      );
    } finally {
      setDraftExportBusy(null);
    }
  }

  async function exportDraftExcel() {
    if (!draftDetail || draftExportBusy) return;
    setDraftExportBusy("EXCEL");
    setDraftNotice(null);
    try {
      const blob = await generateComisionesV2DraftExcel(draftDetail);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `liquidacion_comisiones_borrador_${draftDetail.settlement.id}_detalle.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDraftNotice(
        error instanceof Error
          ? error.message
          : "No se pudo generar el Excel del borrador.",
      );
    } finally {
      setDraftExportBusy(null);
    }
  }

  async function exportIssuedExcel() {
    if (!issuedDetail || issuedExportBusy) return;
    setIssuedExportBusy("EXCEL");
    setIssuedError(null);
    try {
      const blob = await generateComisionesV2DraftExcel(issuedDetail);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `liquidacion_comisiones_${issuedDetail.settlement.settlement_code || issuedDetail.settlement.id}_detalle.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setIssuedError(
        error instanceof Error
          ? error.message
          : "No se pudo generar el Excel histórico.",
      );
    } finally {
      setIssuedExportBusy(null);
    }
  }

  async function openIssuedPdf() {
    if (!issuedDetail || issuedExportBusy) return;
    setIssuedExportBusy("PDF");
    setIssuedPdfError(null);
    try {
      const result = await getComisionesV2OfficialPdfPreview(
        issuedDetail.settlement.id,
      );
      if (result.error || !result.data)
        throw new Error(result.error ?? "No se pudo abrir el PDF oficial.");
      setIssuedPdfPreview({
        base64: result.data.base64,
        filename: result.data.filename,
      });
    } catch (error) {
      setIssuedPdfError(
        error instanceof Error
          ? error.message
          : "No se pudo cargar el PDF oficial.",
      );
    } finally {
      setIssuedExportBusy(null);
    }
  }

  function requestDraftCancellation(target: DraftCancelTarget) {
    if (draftCancelBusy) return;
    setDraftCancelTarget(target);
    setDraftCancelReason("");
    setDraftNotice(null);
  }

  async function confirmDraftCancellation() {
    if (!draftCancelTarget || !draftCancelReason.trim() || draftCancelBusy)
      return;
    const target = draftCancelTarget;
    setDraftCancelBusy(true);
    const result = await cancelComisionesV2SettlementDraft({
      settlementId: target.settlementId,
      reason: draftCancelReason,
    });
    if (result.error || !result.data) {
      setDraftCancelBusy(false);
      setDraftNotice(result.error ?? "No se pudo cancelar el borrador V2.");
      return;
    }
    setDraftCancelBusy(false);
    setDraftCancelTarget(null);
    setDraftCancelReason("");
    setSelectedDraftId(null);
    setDraftDetail(null);
    setDraftDetailLoading(false);
    setDrafts(
      (current) =>
        current?.filter(
          (draft) => draft.settlement_id !== target.settlementId,
        ) ?? current,
    );
    setFrom(target.periodFrom);
    setTo(target.periodTo);
    selectedSellerRef.current = target.sellerBsaleId;
    setSelectedSellerId(target.sellerBsaleId);
    batchCacheRef.current.delete(
      `${activeCompanyRef.current}:${target.periodFrom}:${target.periodTo}`,
    );
    await loadBatch(target.periodFrom, target.periodTo, {
      force: true,
      silentError: false,
    });
    selectSection("LINES");
  }

  async function requestDraftCreation() {
    if (
      !canManage ||
      selectedSellerId == null ||
      loading ||
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      from > to
    )
      return;
    setDraftBusy(true);
    setDraftNotice(null);
    const result = await getComisionesV2SettlementDraftReadiness({
      sellerBsaleId: selectedSellerId,
      periodFrom: from,
      periodTo: to,
    });
    setDraftBusy(false);
    if (result.error || !result.data) {
      setDraftNotice(result.error ?? "No se pudo preparar el borrador V2.");
      return;
    }
    setDraftReadiness(result.data);
    setDraftModal(result.data.can_create ? "CONFIRM" : "BLOCKED");
  }

  async function confirmDraftCreation() {
    if (selectedSellerId == null || !draftReadiness?.can_create) return;
    setDraftBusy(true);
    const result = await createComisionesV2SettlementDraft({
      sellerBsaleId: selectedSellerId,
      periodFrom: from,
      periodTo: to,
    });
    if (result.error || !result.data) {
      setDraftBusy(false);
      setDraftModal(null);
      setDraftNotice(result.error ?? "No se pudo crear el borrador V2.");
      return;
    }
    const settlementId = result.data.settlement_id;
    setDraftModal(null);
    setDraftReadiness(null);
    setDraftBusy(false);
    batchCacheRef.current.delete(`${activeCompanyRef.current}:${from}:${to}`);
    await loadBatch(from, to, { force: true, silentError: true });
    await loadDrafts(true);
    selectSection("DRAFTS");
    setVisitedSections((current) => new Set(current).add("DRAFTS"));
    await openDraftDetail(settlementId);
  }

  async function confirmDraftIssue() {
    if (!draftDetail || issueBusy || draftDetail.settlement.status !== "DRAFT")
      return;
    const detail = draftDetail;
    setIssueBusy(true);
    setDraftNotice(null);
    const result = await issueComisionesV2SettlementDraft(detail.settlement.id);
    if (result.error || !result.data) {
      setIssueBusy(false);
      setDraftNotice(result.error ?? "No se pudo emitir la liquidación V2.");
      return;
    }
    setIssueBusy(false);
    setIssueModal(false);
    setDrafts(
      (current) =>
        current?.filter(
          (draft) => draft.settlement_id !== detail.settlement.id,
        ) ?? current,
    );
    setSelectedDraftId(null);
    setDraftDetail(null);
    batchCacheRef.current.delete(
      `${activeCompanyRef.current}:${detail.settlement.period_from}:${detail.settlement.period_to}`,
    );
    await loadBatch(
      detail.settlement.period_from,
      detail.settlement.period_to,
      { force: true, silentError: true },
    );
    await loadIssued(true);
    setIssueSuccess({
      settlementId: detail.settlement.id,
      settlementCode: result.data.settlement_code,
      sellerName: detail.settlement.seller_name_snapshot,
      periodFrom: detail.settlement.period_from,
      periodTo: detail.settlement.period_to,
      totalCommissionAmount: detail.settlement.total_commission_amount,
    });
  }

  function selectSection(
    nextSection: InspectionSection,
  ) {
    if (nextSection !== "ISSUED") {
      issuedDetailRequestSequence.current += 1;
      setSelectedIssuedId(null);
      setIssuedDetail(null);
      setIssuedDetailLoading(false);
      setIssuedDetailError(null);
      setIssuedPdfError(null);
      setIssuedPdfPreview(null);
    }
    router.replace(`${pathname}?section=${nextSection}`, { scroll: false });
    setVisitedSections((current) =>
      current.has(nextSection) ? current : new Set(current).add(nextSection),
    );
    if (nextSection === "DRAFTS") void loadDrafts();
    if (nextSection === "ISSUED") void loadIssued();
  }

  useEffect(() => {
    supplierFilterRef.current = supplierFilter;
    ruleFilterRef.current = ruleFilter;
    percentFilterRef.current = percentFilter;
  }, [percentFilter, ruleFilter, supplierFilter]);

  function selectSeller(sellerId: number | null) {
    selectedSellerRef.current = sellerId;
    setSelectedSellerId(sellerId);
    const selectedRows =
      sellerId == null
        ? []
        : allSimulationRows.filter((row) => row.seller_bsale_id === sellerId);
    const supplierOptions = new Set(
      selectedRows.flatMap((row) =>
        [
          row.real_supplier_id ? `SUPPLIER:${row.real_supplier_id}` : null,
          row.family_bsale_product_type_id != null
            ? `FAMILY:${row.family_bsale_product_type_id}`
            : null,
        ].filter((value): value is string => value != null),
      ),
    );
    const ruleOptions = new Set(
      selectedRows.map((row) => row.plan_code ?? row.simulation_status),
    );
    const percentOptions = new Set(
      selectedRows.map((row) => String(row.commission_percent ?? "NONE")),
    );
    if (
      supplierFilterRef.current !== "ALL" &&
      !supplierOptions.has(supplierFilterRef.current)
    )
      setSupplierFilter("ALL");
    if (
      ruleFilterRef.current !== "ALL" &&
      !ruleOptions.has(ruleFilterRef.current)
    )
      setRuleFilter("ALL");
    if (
      percentFilterRef.current !== "ALL" &&
      !percentOptions.has(percentFilterRef.current)
    )
      setPercentFilter("ALL");
  }

  const loadBatch = useCallback(
    async (
      periodFrom: string,
      periodTo: string,
      options?: { force?: boolean; silentError?: boolean },
    ): Promise<boolean> => {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(periodFrom) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(periodTo) ||
        periodFrom > periodTo
      ) {
        if (!options?.silentError) setError("El período de pago no es válido.");
        return false;
      }
      const requestId = ++batchRequestSequence.current;
      const knownKey = activeCompanyRef.current
        ? `${activeCompanyRef.current}:${periodFrom}:${periodTo}`
        : null;
      if (options?.force && knownKey) batchCacheRef.current.delete(knownKey);
      const cached =
        !options?.force && knownKey
          ? batchCacheRef.current.get(knownKey)
          : undefined;
      if (cached) {
        setAllSimulationRows(cached.rows);
        setLoading(false);
        setHasQueried(true);
        return true;
      }
      setLoading(true);
      setHasQueried(false);
      if (!options?.silentError) setError(null);
      setAllSimulationRows([]);
      const result = await listComisionesV2PeriodSimulation(
        periodFrom,
        periodTo,
      );
      if (requestId !== batchRequestSequence.current) return false;
      setLoading(false);
      if (result.error || !result.companyId) {
        setHasQueried(false);
        if (!options?.silentError)
          setError(result.error ?? "No se pudo cargar la simulación batch.");
        return false;
      }
      if (
        activeCompanyRef.current &&
        activeCompanyRef.current !== result.companyId
      ) {
        batchCacheRef.current.clear();
        selectedSellerRef.current = null;
        setSelectedSellerId(null);
        setSellerProfiles([]);
        setCanManage(false);
        setCanIssue(false);
        setPlanCache(null);
        setPlanSuppliers(null);
        setPlanError(null);
        setDrafts(null);
        setDraftDetail(null);
        setSelectedDraftId(null);
        setIssued(null);
        setIssuedDetail(null);
        setSelectedIssuedId(null);
        setIssuedDetailError(null);
        setIssuedPdfError(null);
        setIssuedPdfPreview(null);
      }
      activeCompanyRef.current = result.companyId;
      batchCacheRef.current.set(
        `${result.companyId}:${periodFrom}:${periodTo}`,
        {
          companyId: result.companyId,
          from: periodFrom,
          to: periodTo,
          rows: result.data,
        },
      );
      setAllSimulationRows(result.data);
      setHasQueried(true);
      return true;
    },
    [],
  );

  const loadSellerProfiles = useCallback(async () => {
    setSellerLoading(true);
    setSellerError(null);
    const result = await listComisionesV2SellerProfiles();
    setSellerLoading(false);
    if (result.error) {
      setSellerProfiles([]);
      setSellerError(result.error);
      return;
    }
    setSellerProfiles(result.data);
    setCanManage(result.canManage === true);
    setCanIssue(result.canIssue === true);
  }, []);

  const loadPlanList = useCallback(
    async (options?: { force?: boolean }): Promise<boolean> => {
      if (planCache && planSuppliers && !options?.force) return true;
      const requestId = ++planRequestSequence.current;
      setPlanLoading(true);
      setPlanError(null);
      const result = await listComisionesV2FamilyPlans();
      if (requestId !== planRequestSequence.current) return false;
      setPlanLoading(false);
      if (result.error) {
        setPlanError(result.error);
        return false;
      }
      setPlanCache(result.data);
      setPlanSuppliers(result.suppliers);
      return true;
    },
    [planCache, planSuppliers],
  );

  const loadSyncHealth = useCallback(async () => {
    setSyncHealthLoading(true);
    try {
      setSyncHealth(await getCommissionsSyncHealth());
    } catch (syncError) {
      console.error("Failed to load Comisiones V2 sync health", syncError);
      setSyncHealth(null);
    } finally {
      setSyncHealthLoading(false);
    }
  }, []);

  const handleManualSync = useCallback(async () => {
    if (!isSuperUser || syncBusy) return;
    setSyncBusy(true);
    setSyncNotice(null);
    try {
      const result = await triggerManualCommissionsSync();
      if (!result.success)
        throw new Error(
          result.error || "La sincronización Bsale no terminó correctamente.",
        );
      await loadSyncHealth();
      setSimulationRefreshNotice(null);
      setSyncNotice(
        result.status === "PARTIAL"
          ? "Sync Bsale completada con advertencias."
          : "Sync Bsale completada.",
      );
      const refreshed = await loadBatch(from, to, {
        force: true,
        silentError: true,
      });
      if (!refreshed)
        setSimulationRefreshNotice(
          "Sync Bsale completada, pero la simulación no pudo actualizarse.",
        );
    } catch (syncError) {
      console.error("Failed to run Comisiones V2 manual sync", syncError);
      setSyncNotice(
        syncError instanceof Error
          ? syncError.message
          : "No se pudo sincronizar Bsale.",
      );
    } finally {
      setSyncBusy(false);
    }
  }, [from, isSuperUser, loadBatch, loadSyncHealth, syncBusy, to]);

  const handlePlanSaved = useCallback(
    async (savedPlan: ComisionesV2FamilyPlanListItem, previousPlanId: string | null) => {
      setPlanCache((current) => {
        if (!current) return current;
        const logicalPlan = (item: ComisionesV2FamilyPlanListItem) =>
          item.supplier_id === savedPlan.supplier_id &&
          item.plan_code === savedPlan.plan_code &&
          item.plan_type === savedPlan.plan_type;
        const next = current.filter(
          (item) =>
            item.id !== previousPlanId &&
            !(item.id !== savedPlan.id && logicalPlan(item)),
        );
        return [...next, savedPlan];
      });
      if (activeCompanyRef.current) {
        batchCacheRef.current.delete(
          `${activeCompanyRef.current}:${from}:${to}`,
        );
      }
      setSimulationRefreshNotice(
        "Regla guardada. La próxima consulta usará la versión vigente.",
      );
    },
    [from, to],
  );

  const handlePlansChanged = useCallback(async () => {
    await loadPlanList({ force: true });
  }, [loadPlanList]);

  const handlePlanRemoved = useCallback(
    async (removal: ComisionesV2PlanRemovalResult) => {
      setPlanCache((current) =>
        current
          ? current.filter((item) => item.id !== removal.plan_id)
          : current,
      );
      if (activeCompanyRef.current) {
        batchCacheRef.current.delete(
          `${activeCompanyRef.current}:${from}:${to}`,
        );
      }
      setSimulationRefreshNotice(
        removal.result === "ARCHIVED"
          ? "La regla tenía historial y fue archivada."
          : "Regla eliminada correctamente.",
      );
    },
    [from, to],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([
        loadBatch(initialPeriod.from, initialPeriod.to),
        loadSellerProfiles(),
        loadPlanList(),
      ]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialPeriod, loadBatch, loadPlanList, loadSellerProfiles]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSyncHealth();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSyncHealth]);

  const rows = useMemo(
    () =>
      selectedSellerId == null
        ? []
        : allSimulationRows.filter(
            (row) => row.seller_bsale_id === selectedSellerId,
          ),
    [allSimulationRows, selectedSellerId],
  );
  const inspectionResult = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matchesRow = (row: ComisionesV2SimulationLine) => {
      if (
        statusFilter === "SIN_REGLA" &&
        row.simulation_status !== "NO_ACTIVE_PLAN" &&
        row.simulation_status !== "NO_FAMILY_RATE"
      )
        return false;
      if (
        statusFilter === "INCIDENCIAS" &&
        row.simulation_status !== "COMMERCIAL_INCIDENT"
      )
        return false;
      if (
        supplierFilter.startsWith("SUPPLIER:") &&
        row.real_supplier_id !== supplierFilter.slice(9)
      )
        return false;
      if (
        supplierFilter.startsWith("FAMILY:") &&
        String(row.family_bsale_product_type_id ?? "") !==
          supplierFilter.slice(7)
      )
        return false;
      if (
        ruleFilter !== "ALL" &&
        (row.plan_code ?? row.simulation_status) !== ruleFilter
      )
        return false;
      if (
        percentFilter !== "ALL" &&
        String(row.commission_percent ?? "NONE") !== percentFilter
      )
        return false;
      if (!term) return true;
      return searchValues(row).some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(term),
      );
    };
    const groups = groupSimulationRows(rows).filter((group) =>
      [group.parent, ...group.children].some(matchesRow),
    );
    const sortedParents = sortOperationalRows(
      groups.map((group) => group.parent),
      sort,
      COLUMNS,
      (row, key) => row[key as keyof ComisionesV2SimulationLine],
    );
    const groupsByParent = new Map(
      groups.map((group) => [invoiceLineKey(group.parent), group]),
    );
    const visibleRows = sortedParents.flatMap((parent) => {
      const group = groupsByParent.get(invoiceLineKey(parent));
      return group ? [group.parent, ...group.children] : [parent];
    });
    return {
      rows: visibleRows,
      summary: {
        invoices: new Set(
          visibleRows
            .filter(isInvoice)
            .map((row) => row.document_bsale_id)
            .filter((value) => value != null),
        ).size,
        creditNotes: new Set(
          visibleRows
            .filter(isCreditNote)
            .map((row) => row.source_document_bsale_id)
            .filter((value) => value != null),
        ).size,
        lines: visibleRows.length,
        net: visibleRows.reduce(
          (total, row) => total + Number(row.net_amount ?? 0),
          0,
        ),
        commission: visibleRows.reduce(
          (total, row) => total + Number(row.commission_amount ?? 0),
          0,
        ),
        creditNotesNet: visibleRows
          .filter(isCreditNote)
          .reduce((total, row) => total + Number(row.net_amount ?? 0), 0),
        creditNotesCommission: visibleRows
          .filter(isCreditNote)
          .reduce(
            (total, row) => total + Number(row.commission_amount ?? 0),
            0,
          ),
        noRule: visibleRows.filter(
          (row) =>
            row.simulation_status === "NO_ACTIVE_PLAN" ||
            row.simulation_status === "NO_FAMILY_RATE",
        ).length,
        commercialIncidents: visibleRows.filter(
          (row) => row.simulation_status === "COMMERCIAL_INCIDENT",
        ).length,
      },
    };
  }, [
    percentFilter,
    ruleFilter,
    rows,
    search,
    sort,
    statusFilter,
    supplierFilter,
  ]);
  const { rows: visibleRows, summary } = inspectionResult;

  function column(id: string) {
    return COLUMNS.find((item) => item.id === id)!;
  }
  function header(id: string, label: string) {
    const item = column(id);
    const active = sort?.column === id;
    return (
      <button
        type="button"
        onClick={() => cycleSort(item)}
        className="group flex min-w-0 items-center gap-1 text-left hover:text-theme-text"
      >
        <span className="truncate">{label}</span>
        <OperationalTableSortIndicator
          active={active}
          direction={active ? sort?.direction : undefined}
        />
      </button>
    );
  }
  function resize(id: string) {
    const item = column(id);
    return (
      <OperationalTableResizeHandle
        column={item}
        width={widths[id] ?? item.defaultWidth}
        onResize={(width) => setColumnWidth(item, width)}
        onResizeEnd={persist}
      />
    );
  }
  function stickyStyle(id: string) {
    if (id === "commission" || id === "percent" || id === "commission-type")
      return { right: stickyRight(id, widths) };
    return undefined;
  }
  function stickyClass(id: string, header = false) {
    if (!column(id).sticky) return "";
    const resultBackground = header
      ? "bg-theme-surface-hover"
      : "bg-theme-surface group-hover:bg-theme-surface-hover";
    const resultSeparator =
      id === "commission-type"
        ? "border-l border-theme-border/70 shadow-[-6px_0_12px_-10px_rgba(0,0,0,0.5)]"
        : "";
    return `sticky ${header ? "z-20" : "z-10"} ${resultBackground} ${resultSeparator}`;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-theme-surface">
      <div className="shrink-0 border-b border-theme-border/70 bg-theme-text/[0.02] px-3 py-3 md:px-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold text-theme-text">
                Comisiones
              </h1>
            </div>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-theme-text-muted/75">
              Inspección de líneas reales y gestión documental de liquidaciones
              desde el contrato V2.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-theme-text-muted">
              <span>
                {syncHealthLoading
                  ? "Última sync: consultando..."
                  : `Última sync: ${formatSyncDate(syncHealth?.latestSuccessfulRun?.completed_at || syncHealth?.latestSuccessfulRun?.started_at || null)}`}
              </span>
              {syncHealth?.latestRun?.status === "FAILED" &&
                syncHealth.latestSuccessfulRun && (
                  <span className="text-amber-600">
                    (última ejecución fallida)
                  </span>
                )}
              {isSuperUser && (
                <button
                  type="button"
                  onClick={() => void handleManualSync()}
                  disabled={syncBusy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-theme-border bg-theme-surface px-2.5 text-[11px] font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-wait disabled:opacity-60"
                >
                  {syncBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : null}
                  {syncBusy ? "Sincronizando..." : "Sincronizar ahora"}
                </button>
              )}
              {syncNotice && (
                <span
                  className={
                    syncNotice.includes("completada")
                      ? "text-emerald-600"
                      : "text-red-600"
                  }
                >
                  {syncNotice}
                </span>
              )}
              {simulationRefreshNotice && (
                <span className="text-amber-600">
                  {simulationRefreshNotice}
                </span>
              )}
            </div>
            <div
              className="mt-2 inline-flex rounded-lg border border-theme-border bg-theme-surface p-1"
              role="tablist"
               aria-label="Secciones de Comisiones"
            >
              <button
                type="button"
                role="tab"
                aria-selected={section === "LINES"}
                onClick={() => selectSection("LINES")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${section === "LINES" ? "bg-theme-accent text-white" : "text-theme-text-muted hover:text-theme-text"}`}
              >
                  Emisión E.P.
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={section === "SELLERS"}
                onClick={() => selectSection("SELLERS")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${section === "SELLERS" ? "bg-theme-accent text-white" : "text-theme-text-muted hover:text-theme-text"}`}
              >
                Vendedores
              </button>
              {canManage && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={section === "PLANS"}
                  onClick={() => selectSection("PLANS")}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold ${section === "PLANS" ? "bg-theme-accent text-white" : "text-theme-text-muted hover:text-theme-text"}`}
                >
                  Reglas
                </button>
              )}
              {canManage && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={section === "DRAFTS"}
                  onClick={() => selectSection("DRAFTS")}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold ${section === "DRAFTS" ? "bg-theme-accent text-white" : "text-theme-text-muted hover:text-theme-text"}`}
                >
                  Borradores
                </button>
              )}
              {canIssue && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={section === "ISSUED"}
                  onClick={() => selectSection("ISSUED")}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold ${section === "ISSUED" ? "bg-theme-accent text-white" : "text-theme-text-muted hover:text-theme-text"}`}
                >
                  Emitidas
                </button>
              )}
            </div>
          </div>
          {section === "LINES" && (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:grid-cols-8 xl:gap-1.5">
              <Summary
                label="Facturas"
                value={selectedSellerId == null ? "—" : summary.invoices}
              />
              <Summary
                label="Líneas"
                value={selectedSellerId == null ? "—" : summary.lines}
              />
              <Summary
                label="Notas de crédito"
                value={selectedSellerId == null ? "—" : summary.creditNotes}
                secondary={
                  selectedSellerId == null
                    ? undefined
                    : `Neto ${formatCurrency(summary.creditNotesNet)} · Comisión ${formatCurrency(summary.creditNotesCommission)}`
                }
              />
              <Summary
                label="Neto"
                value={
                  selectedSellerId == null ? "—" : formatCurrency(summary.net)
                }
                wide
              />
              <Summary
                label="Comisión"
                value={
                  selectedSellerId == null
                    ? "—"
                    : formatCurrency(summary.commission)
                }
                wide
              />
              <Summary
                label="Tasa comisión"
                value={
                  selectedSellerId == null
                    ? "—"
                    : percentLabel(
                        summary.net
                          ? (summary.commission / summary.net) * 100
                          : 0,
                      )
                }
              />
              <Summary
                label="Sin regla"
                value={selectedSellerId == null ? "—" : summary.noRule}
                tone={
                  selectedSellerId != null && summary.noRule ? "amber" : "green"
                }
                active={statusFilter === "SIN_REGLA"}
                onClick={() =>
                  setStatusFilter((current) =>
                    current === "SIN_REGLA" ? "NONE" : "SIN_REGLA",
                  )
                }
              />
              <Summary
                label="Incidencias"
                value={
                  selectedSellerId == null ? "—" : summary.commercialIncidents
                }
                tone={
                  selectedSellerId != null && summary.commercialIncidents
                    ? "red"
                    : "green"
                }
                active={statusFilter === "INCIDENCIAS"}
                onClick={() =>
                  setStatusFilter((current) =>
                    current === "INCIDENCIAS" ? "NONE" : "INCIDENCIAS",
                  )
                }
              />
            </div>
          )}
        </div>
      </div>

      {section === "LINES" && selectedSellerId != null && hasQueried && (
        <SupplierSalesChart rows={rows} supplierFilter={supplierFilter} />
      )}
      {section === "LINES" ? (
        <div className="shrink-0 flex flex-wrap items-end gap-3 border-b border-theme-border/60 p-3 md:p-4">
          <label className="grid shrink-0 gap-1 text-[11px] font-semibold text-theme-text-muted">
            Vendedor
            <select
              value={selectedSellerId ?? ""}
              onChange={(event) =>
                selectSeller(
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              className="h-9 min-w-[220px] rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text outline-none focus:border-theme-accent"
            >
              <option value="">Seleccionar vendedor</option>
              {sellerProfiles
                .filter(
                  (profile) => profile.active && profile.is_commissionable,
                )
                .map((profile) => (
                  <option
                    key={profile.seller_bsale_id}
                    value={profile.seller_bsale_id}
                  >
                    {profile.seller_name} · {profile.seller_bsale_id}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid shrink-0 gap-1 text-[11px] font-semibold text-theme-text-muted">
            Pago desde
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text outline-none focus:border-theme-accent"
            />
          </label>
          <label className="grid shrink-0 gap-1 text-[11px] font-semibold text-theme-text-muted">
            Pago hasta
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text outline-none focus:border-theme-accent"
            />
          </label>
          <label className="grid min-w-[190px] flex-[1_1_230px] gap-1 text-[11px] font-semibold text-theme-text-muted">
            Proveedor o familia
            <select
              value={supplierFilter}
              onChange={(event) => setSupplierFilter(event.target.value)}
              className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text"
            >
              <option value="ALL">Todos</option>
              {Array.from(
                new Map(
                  rows
                    .filter((row) => row.real_supplier_id)
                    .map((row) => [
                      `SUPPLIER:${row.real_supplier_id}`,
                      row.real_supplier_business_name ?? "Sin proveedor",
                    ]),
                ).entries(),
              )
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              {Array.from(
                new Map(
                  rows
                    .filter((row) => row.family_bsale_product_type_id != null)
                    .map((row) => [
                      `FAMILY:${row.family_bsale_product_type_id}`,
                      row.family_name ?? "Sin Familia",
                    ]),
                ).entries(),
              )
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    Familia: {label}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid shrink-0 gap-1 text-[11px] font-semibold text-theme-text-muted">
            Regla
            <select
              value={ruleFilter}
              onChange={(event) => setRuleFilter(event.target.value)}
              className="h-9 min-w-[150px] rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text"
            >
              <option value="ALL">Todas</option>
              {Array.from(
                new Set(
                  rows.map((row) => row.plan_code ?? row.simulation_status),
                ),
              )
                .sort()
                .map((value) => (
                  <option key={value} value={value}>
                    {ruleLabel(value)}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid shrink-0 gap-1 text-[11px] font-semibold text-theme-text-muted">
            %
            <select
              value={percentFilter}
              onChange={(event) => setPercentFilter(event.target.value)}
              className="h-9 min-w-[110px] rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text"
            >
              <option value="ALL">Todos</option>
              {Array.from(
                new Set(
                  rows.map((row) => String(row.commission_percent ?? "NONE")),
                ),
              )
                .sort()
                .map((value) => (
                  <option key={value} value={value}>
                    {value === "NONE"
                      ? "Sin regla"
                      : percentLabel(Number(value))}
                  </option>
                ))}
            </select>
          </label>
          <label className="relative grid min-w-0 flex-[2_1_320px] gap-1 text-[11px] font-semibold text-theme-text-muted md:min-w-[320px] md:whitespace-nowrap">
            Buscar factura, SKU, producto, proveedor o familia
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Ej. 23452, alimento, proveedor..."
                className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-xs font-normal text-theme-text outline-none focus:border-theme-accent"
              />
            </div>
          </label>
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setSupplierFilter("ALL");
              setRuleFilter("ALL");
              setPercentFilter("ALL");
              setStatusFilter("NONE");
            }}
            className="h-9 shrink-0 whitespace-nowrap rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
          >
            Limpiar
          </button>
          <button
            type="button"
            onClick={() => void loadBatch(from, to)}
            disabled={loading}
            className="h-9 shrink-0 whitespace-nowrap rounded-lg bg-theme-accent px-4 text-xs font-bold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Preparando información..." : "Consultar"}
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => void requestDraftCreation()}
              disabled={
                draftBusy || loading || selectedSellerId == null || from > to
              }
              className="h-9 shrink-0 whitespace-nowrap rounded-lg border border-theme-accent/40 bg-theme-surface px-3 text-xs font-bold text-theme-accent hover:bg-theme-accent/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {draftBusy ? "Preparando borrador..." : "Crear borrador"}
            </button>
          )}
          <button
            type="button"
            onClick={resetWidths}
            className="h-9 shrink-0 whitespace-nowrap rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
          >
            Restablecer anchos
          </button>
        </div>
      ) : section === "SELLERS" ? (
        <div className="shrink-0 flex items-center justify-between gap-3 border-b border-theme-border/60 p-3 md:p-4">
          <div>
            <p className="text-xs font-semibold text-theme-text">
              Vendedores V2
            </p>
            <p className="mt-1 text-xs text-theme-text-muted/70">
              Perfiles replicados desde la configuración validada de V1. Esta
              sección es sólo lectura.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadSellerProfiles()}
            disabled={sellerLoading}
            className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-60"
          >
            Actualizar
          </button>
        </div>
      ) : null}

      {visitedSections.has("PLANS") && (
        <div className={section === "PLANS" ? "flex min-h-0 flex-1" : "hidden"}>
          <FamilyPlanConfigurator
            onPlanSaved={handlePlanSaved}
            onPlanRemoved={handlePlanRemoved}
            onPlansChanged={handlePlansChanged}
            initialPlans={planCache}
            initialSuppliers={planSuppliers}
            bootstrapLoading={planLoading}
            bootstrapError={planError}
          />
        </div>
      )}
      {visitedSections.has("SELLERS") && (
        <div
          className={section === "SELLERS" ? "flex min-h-0 flex-1" : "hidden"}
        >
          <SellerProfilesTable
            profiles={sellerProfiles}
            loading={sellerLoading}
            error={sellerError}
          />
        </div>
      )}
      {visitedSections.has("DRAFTS") && (
        <div
          className={section === "DRAFTS" ? "flex min-h-0 flex-1" : "hidden"}
        >
          <SettlementDraftsSection
            drafts={drafts ?? []}
            loading={draftLoading}
            error={draftError}
            selectedDraftId={selectedDraftId}
            detail={draftDetail}
            detailLoading={draftDetailLoading}
            notice={draftNotice}
            canIssue={canIssue}
            issueBusy={issueBusy}
            onRefresh={() => void loadDrafts(true)}
            onOpen={(settlementId) => void openDraftDetail(settlementId)}
            onCancel={requestDraftCancellation}
            onIssue={() => setIssueModal(true)}
            onExportPdf={() => void exportDraftPdf()}
            onExportExcel={() => void exportDraftExcel()}
            exportBusy={draftExportBusy}
          />
        </div>
      )}
      {visitedSections.has("ISSUED") && (
        <div
          className={section === "ISSUED" ? "flex min-h-0 flex-1" : "hidden"}
        >
          <SettlementIssuedSection
            issued={issued ?? []}
            loading={issuedLoading}
            error={issuedError}
            detailError={issuedDetailError}
            pdfError={issuedPdfError}
            selectedIssuedId={selectedIssuedId}
            detail={issuedDetail}
            detailLoading={issuedDetailLoading}
            exportBusy={issuedExportBusy}
            onRefresh={() => void loadIssued(true)}
            onOpen={(settlementId) => void openIssuedDetail(settlementId)}
            onPdf={() => void openIssuedPdf()}
            onExcel={() => void exportIssuedExcel()}
          />
        </div>
      )}
      {section === "LINES" &&
        (error ? (
          <div className="m-4 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">
                 No se pudo consultar Comisiones
              </p>
              <p className="mt-1 text-xs">{error}</p>
            </div>
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-theme-text-muted">
            Preparando información...
          </div>
        ) : !hasQueried ? (
          <LoadingState />
        ) : selectedSellerId == null ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-theme-text-muted">
            Selecciona un vendedor para revisar sus líneas.
          </div>
        ) : visibleRows.length === 0 ? (
          <EmptyState hasQuery={hasQueried} />
        ) : (
          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
            <table className="min-w-[1940px] w-full table-fixed whitespace-nowrap text-xs">
              <colgroup>
                {COLUMNS.map((item) => (
                  <col
                    key={item.id}
                    style={{ width: widths[item.id] ?? item.defaultWidth }}
                  />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-10 bg-theme-surface shadow-[0_1px_0_var(--theme-border)]">
                <tr className="h-10 text-[11px] font-bold uppercase tracking-wide text-theme-text-muted">
                  {[
                    ["invoice", "Factura"],
                    ["customer", "Cliente"],
                    ["date", "Fecha emisión"],
                    ["payment-date", "Pago completo"],
                    ["sku", "SKU"],
                    ["product", "Producto"],
                    ["supplier", "Proveedor REAL"],
                    ["family", "Familia"],
                    ["quantity", "Cantidad"],
                    ["net", "Neto"],
                    ["plan", "Plan / Regla"],
                    ["commission-type", "Tipo de comisión"],
                    ["percent", "%"],
                    ["commission", "Comisión"],
                  ].map(([id, label]) => (
                    <th
                      key={id}
                      style={stickyStyle(id)}
                      className={`relative px-3 text-left ${stickyClass(id, true)}`}
                    >
                      {header(id, label)}
                      {resize(id)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border/50">
                {visibleRows.map((row) => (
                  <InspectionRow
                    key={row.detail_id}
                    row={row}
                    widths={widths}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {draftModal && draftReadiness && (
        <DraftCreationModal
          readiness={draftReadiness}
          sellerName={
            sellerProfiles.find(
              (profile) => profile.seller_bsale_id === selectedSellerId,
            )?.seller_name ?? String(selectedSellerId ?? "—")
          }
          periodFrom={from}
          periodTo={to}
          mode={draftModal}
          busy={draftBusy}
          onClose={() => {
            if (!draftBusy) setDraftModal(null);
          }}
          onConfirm={() => void confirmDraftCreation()}
        />
      )}
      {issueModal && draftDetail && (
        <IssueConfirmationModal
          detail={draftDetail}
          busy={issueBusy}
          onClose={() => {
            if (!issueBusy) setIssueModal(false);
          }}
          onConfirm={() => void confirmDraftIssue()}
        />
      )}
      {issueSuccess && (
        <IssueSuccessModal
          result={issueSuccess}
          onClose={() => setIssueSuccess(null)}
          onView={() => {
            const id = issueSuccess.settlementId;
            setIssueSuccess(null);
            selectSection("ISSUED");
            void openIssuedDetail(id);
          }}
          onIssued={() => {
            setIssueSuccess(null);
            selectSection("ISSUED");
          }}
        />
      )}
      {draftCancelTarget && (
        <DraftCancellationModal
          target={draftCancelTarget}
          reason={draftCancelReason}
          busy={draftCancelBusy}
          onReason={setDraftCancelReason}
          onClose={() => {
            if (!draftCancelBusy) setDraftCancelTarget(null);
          }}
          onConfirm={() => void confirmDraftCancellation()}
        />
      )}
      {draftNotice && !draftModal && (
        <div className="fixed bottom-4 right-4 z-[1200] flex max-w-sm items-start gap-2 rounded-xl border border-red-500/20 bg-theme-surface p-3 text-xs text-red-600 shadow-xl">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{draftNotice}</span>
          <button
            type="button"
            onClick={() => setDraftNotice(null)}
            className="ml-auto rounded p-0.5 hover:bg-theme-text/5"
            aria-label="Cerrar aviso"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {draftPdfPreview && (
        <PdfPreviewModal
          base64={draftPdfPreview.base64}
          filename={draftPdfPreview.filename}
          onClose={() => setDraftPdfPreview(null)}
          onDownload={() => {
            const anchor = document.createElement("a");
            anchor.href = `data:application/pdf;base64,${draftPdfPreview.base64}`;
            anchor.download = draftPdfPreview.filename;
            anchor.click();
          }}
        />
      )}
      {issuedPdfPreview && (
        <PdfPreviewModal
          base64={issuedPdfPreview.base64}
          filename={issuedPdfPreview.filename}
          onClose={() => {
            setIssuedPdfPreview(null);
            setIssuedPdfError(null);
          }}
          onDownload={() => {
            const anchor = document.createElement("a");
            anchor.href = `data:application/pdf;base64,${issuedPdfPreview.base64}`;
            anchor.download = issuedPdfPreview.filename;
            anchor.click();
          }}
        />
      )}
    </div>
  );
}

function InspectionRow({
  row,
  widths,
}: {
  row: ComisionesV2SimulationLine;
  widths: Record<string, number>;
}) {
  const resultCell = (id: "commission-type" | "percent" | "commission") => {
    const right = stickyRight(id, widths);
    const alignment =
      id === "commission-type" ? "text-left" : "text-right tabular-nums";
    const separator =
      id === "commission-type"
        ? "border-l border-theme-border/70 shadow-[-6px_0_12px_-10px_rgba(0,0,0,0.5)]"
        : "";
    return {
      className: `sticky z-10 ${isCreditNote(row) ? "" : "bg-theme-surface group-hover:bg-theme-surface-hover"} ${separator} px-3 py-3 ${alignment}`,
      style: {
        right,
        ...(isCreditNote(row)
          ? {
              backgroundColor: "var(--theme-surface)",
              backgroundImage:
                "linear-gradient(color-mix(in srgb, var(--theme-text) 2%, transparent), color-mix(in srgb, var(--theme-text) 2%, transparent))",
            }
          : {}),
      },
    };
  };
  return (
    <tr className={`group align-top hover:bg-theme-text/[0.025] ${isCreditNote(row) ? "bg-theme-text/[0.018]" : ""}`}>
      <td className="px-3 py-3 font-semibold text-theme-text">
        {isCreditNote(row) ? (
          <div className="pl-3">
            <div>↳ NC {row.source_document_number ?? row.document_number ?? row.document_bsale_id ?? "—"}</div>
            <div className="mt-0.5 text-[10px] font-normal text-theme-text-muted">
              Factura {row.original_invoice_number ?? row.original_invoice_bsale_id ?? "—"}
            </div>
          </div>
        ) : (
          row.document_number ?? row.document_bsale_id ?? "—"
        )}
      </td>
      <td className="px-3 py-3">
        <span
          className="block truncate text-theme-text"
          title={row.customer_name ?? undefined}
        >
          {row.customer_name ?? "—"}
        </span>
      </td>
      <td className="px-3 py-3 text-theme-text-muted">
        {formatDate(row.emission_date)}
      </td>
      <td className="px-3 py-3 text-theme-text-muted">
        {formatPaymentDate(row.full_payment_date)}
      </td>
      <td className="px-3 py-3 text-theme-text">
        <div>{displaySku(row)}</div>
        {row.current_sku && row.current_sku !== displaySku(row) && (
          <div className="mt-1 text-[10px] text-theme-text-muted/65">
            Actual: {row.current_sku}
          </div>
        )}
      </td>
      <td className="px-3 py-3">
        <div
          className="truncate font-medium text-theme-text"
          title={
            row.current_product_description ??
            row.variant_description_snapshot ??
            undefined
          }
        >
          {row.current_product_description ??
            row.variant_description_snapshot ??
            "Producto no resuelto"}
        </div>
        <div className="mt-1 text-[10px] text-theme-text-muted/65">
          {row.product_is_active == null
            ? "Producto no resuelto"
            : row.product_is_active
              ? "Activo"
              : "Inactivo"}
          {row.bsale_brand_id == null
            ? " · Brand no resuelto"
            : ` · Brand #${row.bsale_brand_id}`}
        </div>
      </td>
      <td className="px-3 py-3">
        <span
          className="block truncate text-theme-text"
          title={row.real_supplier_business_name ?? undefined}
        >
          {row.real_supplier_business_name ?? "—"}
        </span>
      </td>
      <td className="px-3 py-3">
        <span
          className="block truncate text-theme-text"
          title={row.family_name ?? undefined}
        >
          {row.family_name ?? "—"}
        </span>
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-theme-text">
        {row.quantity ?? "—"}
      </td>
      <td className="px-3 py-3 text-right tabular-nums font-medium text-theme-text">
        {formatCurrency(row.net_amount)}
      </td>
      <td className="px-3 py-3 text-theme-text">
        <span className="block truncate" title={row.plan_code ?? undefined}>
          {row.plan_code ?? "—"}
        </span>
      </td>
      <td {...resultCell("commission-type")}>
        <span className="text-theme-text">
          {commissionTypeLabel(row.plan_type)}
        </span>
      </td>
      <td {...resultCell("percent")}>
        <span className="text-theme-text">
          {percentLabel(row.commission_percent ?? null)}
        </span>
      </td>
      <td {...resultCell("commission")}>
        <span className="font-medium text-theme-text">
          {formatCurrency(row.commission_amount)}
        </span>
      </td>
    </tr>
  );
}

function DraftCreationModal({
  readiness,
  sellerName,
  periodFrom,
  periodTo,
  mode,
  busy,
  onClose,
  onConfirm,
}: {
  readiness: ComisionesV2SettlementDraftReadiness;
  sellerName: string;
  periodFrom: string;
  periodTo: string;
  mode: "CONFIRM" | "BLOCKED";
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const hasWarnings = readiness.unruled_lines > 0;
  const hasBlocking = readiness.blocking_lines > 0;
  const title =
    mode === "BLOCKED"
      ? "No se puede crear el borrador"
      : "Crear borrador de liquidación";
  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="draft-modal-title"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-theme-border px-5 py-4">
          <div>
            <h2
              id="draft-modal-title"
              className="text-base font-bold text-theme-text"
            >
              {title}
            </h2>
            <p className="mt-1 text-xs text-theme-text-muted">
              {sellerName} · {formatDate(periodFrom)} al {formatDate(periodTo)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          {mode === "BLOCKED" ? (
            <div className="rounded-xl border border-red-500/25 bg-red-500/5 p-3 text-xs text-red-700 dark:text-red-300">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  {readiness.no_sales_target_tier_lines > 0 && (
                    <p>
                      Existen{" "}
                      {readiness.no_sales_target_tier_lines.toLocaleString(
                        "es-CL",
                      )}{" "}
                      líneas de Meta de ventas sin un tramo aplicable.
                    </p>
                  )}
                  {readiness.commercial_incident_lines > 0 && (
                    <p>
                      Existen{" "}
                      {readiness.commercial_incident_lines.toLocaleString(
                        "es-CL",
                      )}{" "}
                      incidencias comerciales que deben resolverse antes de
                      liquidar.
                    </p>
                  )}
                  {!hasBlocking && readiness.total_lines === 0 && (
                    <p>
                      No existen líneas elegibles para este vendedor y período.
                    </p>
                  )}
                  {!hasBlocking && readiness.total_lines > 0 && (
                    <p>
                      Ya existe un borrador activo para este vendedor. Revísalo
                      en la pestaña Borradores.
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              {hasWarnings && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-semibold">
                        Hay líneas sin comisión aplicable
                      </p>
                      <p className="mt-1">
                        {readiness.unruled_lines.toLocaleString("es-CL")} líneas
                        por {formatCurrency(readiness.unruled_net)} se incluirán
                        con comisión $0.
                      </p>
                      <p className="mt-1 font-medium">
                        Estas líneas sí formarán parte de la liquidación y
                        quedarán marcadas con comisión $0.
                      </p>
                      {readiness.no_active_plan_lines > 0 && (
                        <p className="mt-1">
                          Sin plan:{" "}
                          {readiness.no_active_plan_lines.toLocaleString(
                            "es-CL",
                          )}{" "}
                          líneas ·{" "}
                          {formatCurrency(readiness.no_active_plan_net)}
                        </p>
                      )}
                      {readiness.no_family_rate_lines > 0 && (
                        <p>
                          Sin regla de familia:{" "}
                          {readiness.no_family_rate_lines.toLocaleString(
                            "es-CL",
                          )}{" "}
                          líneas ·{" "}
                          {formatCurrency(readiness.no_family_rate_net)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {!hasWarnings && (
                <div className="flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Todas las líneas elegibles tienen una regla de comisión
                    aplicable.
                  </span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <DraftMetric
                  label="Líneas"
                  value={readiness.total_lines.toLocaleString("es-CL")}
                />
                <DraftMetric
                  label="Neto elegible"
                  value={formatCurrency(readiness.total_net_amount)}
                />
                <DraftMetric
                  label="Comisión"
                  value={formatCurrency(readiness.total_commission_amount)}
                />
                <DraftMetric
                  label="Sin comisión"
                  value={readiness.unruled_lines.toLocaleString("es-CL")}
                />
              </div>
              <p className="text-xs leading-5 text-theme-text-muted">
                Al continuar, todas las líneas elegibles del período quedarán
                reservadas hasta cancelar o emitir el borrador.
              </p>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-theme-border bg-theme-text/[0.015] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
          >
            Volver
          </button>
          {mode === "CONFIRM" && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-theme-accent px-3 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {hasWarnings
                ? "Crear borrador de todas formas"
                : "Crear borrador"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function IssueConfirmationModal({
  detail,
  busy,
  onClose,
  onConfirm,
}: {
  detail: ComisionesV2SettlementDetail;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const noCommissionLines = detail.lines.filter(
    (line) =>
      snapshotStatus(line) === "NO_ACTIVE_PLAN" ||
      snapshotStatus(line) === "NO_FAMILY_RATE",
  );
  const noCommissionNet = noCommissionLines.reduce(
    (total, line) => total + line.net_amount,
    0,
  );
  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="issue-modal-title"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-theme-border px-5 py-4">
          <div>
            <h2
              id="issue-modal-title"
              className="text-base font-bold text-theme-text"
            >
              Emitir liquidación
            </h2>
            <p className="mt-1 text-xs text-theme-text-muted">
              {detail.settlement.seller_name_snapshot} ·{" "}
              {formatDate(detail.settlement.period_from)} al{" "}
              {formatDate(detail.settlement.period_to)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-theme-text-muted hover:bg-theme-text/5 disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <DraftMetric
              label="Líneas"
              value={detail.lines.length.toLocaleString("es-CL")}
            />
            <DraftMetric
              label="Neto elegible"
              value={formatCurrency(detail.settlement.total_net_amount)}
            />
            <DraftMetric
              label="Comisión total"
              value={formatCurrency(detail.settlement.total_commission_amount)}
            />
            <DraftMetric
              label="Sin comisión"
              value={noCommissionLines.length.toLocaleString("es-CL")}
            />
          </div>
          {noCommissionLines.length > 0 && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-700">
              Líneas sin comisión:{" "}
              {noCommissionLines.length.toLocaleString("es-CL")} · Neto sin
              comisión: {formatCurrency(noCommissionNet)}
            </div>
          )}
          <p className="text-sm leading-6 text-theme-text">
            Al emitir, esta liquidación quedará guardada definitivamente. Sus
            líneas no podrán volver a utilizarse en otra liquidación y los
            cambios posteriores de reglas no modificarán estos valores.
          </p>
          <p className="rounded-lg border border-theme-border bg-theme-text/[0.03] p-3 text-xs text-theme-text-muted">
            Verifica el PDF y Excel antes de continuar.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-theme-border bg-theme-text/[0.015] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
          >
            Volver
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-theme-accent px-3 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? "Emitiendo..." : "Emitir liquidación"}
          </button>
        </div>
      </div>
    </div>
  );
}

function IssueSuccessModal({
  result,
  onClose,
  onView,
  onIssued,
}: {
  result: IssueSuccess;
  onClose: () => void;
  onView: () => void;
  onIssued: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="issue-success-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="p-6 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
          <h2
            id="issue-success-title"
            className="mt-3 text-lg font-bold text-theme-text"
          >
            Liquidación emitida correctamente
          </h2>
          <p className="mt-1 font-mono text-sm font-bold text-theme-accent">
            {result.settlementCode}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2 text-left">
            <DraftMetric label="Vendedor" value={result.sellerName} />
            <DraftMetric
              label="Período"
              value={`${formatDate(result.periodFrom)}–${formatDate(result.periodTo)}`}
            />
            <DraftMetric
              label="Comisión total"
              value={formatCurrency(result.totalCommissionAmount)}
            />
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-theme-border bg-theme-text/[0.015] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text-muted"
          >
            Cerrar
          </button>
          <button
            type="button"
            onClick={onIssued}
            className="h-9 rounded-lg border border-theme-accent/40 px-3 text-xs font-semibold text-theme-accent"
          >
            Ir a Emitidas
          </button>
          <button
            type="button"
            onClick={onView}
            className="h-9 rounded-lg bg-theme-accent px-3 text-xs font-bold text-white"
          >
            Ver liquidación
          </button>
        </div>
      </div>
    </div>
  );
}

function DraftMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-theme-border bg-theme-text/[0.02] px-2.5 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted">
        {label}
      </p>
      <p className="mt-1 text-sm font-bold text-theme-text">{value}</p>
    </div>
  );
}

function DraftCancellationModal({
  target,
  reason,
  busy,
  onReason,
  onClose,
  onConfirm,
}: {
  target: DraftCancelTarget;
  reason: string;
  busy: boolean;
  onReason: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="draft-cancel-title"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-theme-border px-5 py-4">
          <div>
            <h2
              id="draft-cancel-title"
              className="text-base font-bold text-theme-text"
            >
              Cancelar borrador
            </h2>
            <p className="mt-1 text-xs text-theme-text-muted">
              {target.sellerName} · {formatDate(target.periodFrom)} al{" "}
              {formatDate(target.periodTo)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <DraftMetric
              label="Líneas"
              value={target.linesCount.toLocaleString("es-CL")}
            />
            <DraftMetric
              label="Neto"
              value={formatCurrency(target.totalNetAmount)}
            />
            <DraftMetric
              label="Comisión"
              value={formatCurrency(target.totalCommissionAmount)}
            />
          </div>
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
            Las líneas reservadas volverán a quedar disponibles para cálculo. Si
            alguna regla cambió desde la creación de este borrador, la próxima
            consulta utilizará las reglas vigentes.
          </p>
          <label className="grid gap-1.5 text-xs font-semibold text-theme-text">
            Motivo de cancelación
            <textarea
              value={reason}
              onChange={(event) => onReason(event.target.value)}
              disabled={busy}
              required
              rows={4}
              placeholder="Ingresa el motivo de cancelación"
              className="w-full resize-none rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-xs font-normal text-theme-text outline-none focus:border-theme-accent disabled:opacity-60"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-theme-border bg-theme-text/[0.015] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
          >
            Volver
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || !reason.trim()}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-red-600 px-3 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Cancelar
            borrador
          </button>
        </div>
      </div>
    </div>
  );
}

function SettlementDraftsSection({
  drafts,
  loading,
  error,
  selectedDraftId,
  detail,
  detailLoading,
  notice,
  canIssue,
  issueBusy,
  onRefresh,
  onOpen,
  onCancel,
  onIssue,
  onExportPdf,
  onExportExcel,
  exportBusy,
}: {
  drafts: ComisionesV2SettlementDraftListItem[];
  loading: boolean;
  error: string | null;
  selectedDraftId: string | null;
  detail: ComisionesV2SettlementDetail | null;
  detailLoading: boolean;
  notice: string | null;
  canIssue: boolean;
  issueBusy: boolean;
  onRefresh: () => void;
  onOpen: (settlementId: string) => void;
  onCancel: (target: DraftCancelTarget) => void;
  onIssue: () => void;
  onExportPdf: () => void;
  onExportExcel: () => void;
  exportBusy: "PDF" | "EXCEL" | null;
}) {
  if (selectedDraftId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SettlementDraftDetailLayout
          detail={detail}
          loading={detailLoading}
          onBack={() => onOpen("")}
          onCancel={(target) => onCancel(target)}
          onIssue={onIssue}
          canIssue={canIssue}
          issueBusy={issueBusy}
          onExportPdf={onExportPdf}
          onExportExcel={onExportExcel}
          exportBusy={exportBusy}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-theme-text">
            Borradores de liquidación
          </h2>
          <p className="mt-1 text-xs text-theme-text-muted">
            Snapshot V2 persistido, sin recalcular reglas actuales.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Actualizar
        </button>
      </div>
      {error && (
        <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600">
          {error}
        </div>
      )}
      {loading && drafts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-theme-text-muted">
          Cargando borradores...
        </div>
      ) : drafts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="rounded-xl border border-dashed border-theme-border px-6 py-5 text-center">
            <ClipboardList className="mx-auto h-6 w-6 text-theme-text-muted/50" />
            <p className="mt-2 text-sm font-semibold text-theme-text">
              No hay borradores de liquidación.
            </p>
            <p className="mt-1 text-xs text-theme-text-muted">
              Crea uno desde la pestaña Emisión E.P.
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-theme-border">
          <table className="w-full min-w-[980px] table-fixed text-xs">
            <thead className="sticky top-0 z-10 bg-theme-surface-hover text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
              <tr>
                <th className="px-3 py-2.5">Vendedor</th>
                <th className="px-3 py-2.5">Período</th>
                <th className="px-3 py-2.5 text-right">Líneas</th>
                <th className="px-3 py-2.5 text-right">Neto</th>
                <th className="px-3 py-2.5 text-right">Comisión</th>
                <th className="px-3 py-2.5">Creado</th>
                <th className="px-3 py-2.5">Estado</th>
                <th className="px-3 py-2.5 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {drafts.map((draft) => (
                <tr
                  key={draft.settlement_id}
                  className="hover:bg-theme-text/[0.025]"
                >
                  <td className="px-3 py-3 font-semibold text-theme-text">
                    {draft.seller_name_snapshot}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {formatDate(draft.period_from)}–
                    {formatDate(draft.period_to)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {draft.lines_count.toLocaleString("es-CL")}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {formatCurrency(draft.total_net_amount)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {formatCurrency(draft.total_commission_amount)}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {formatSyncDate(draft.created_at)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-600">
                      Borrador
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onOpen(draft.settlement_id)}
                        className="inline-flex items-center gap-1 rounded-md border border-theme-border px-2 py-1.5 text-[11px] font-semibold text-theme-text-muted hover:text-theme-text"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Ver
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onCancel(draftCancelTargetFromList(draft))
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-red-500/25 px-2 py-1.5 text-[11px] font-semibold text-red-600 hover:bg-red-500/5"
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancelar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notice && <p className="mt-2 shrink-0 text-xs text-red-600">{notice}</p>}
    </div>
  );
}

function SettlementIssuedSection({
  issued,
  loading,
  error,
  detailError,
  pdfError,
  selectedIssuedId,
  detail,
  detailLoading,
  exportBusy,
  onRefresh,
  onOpen,
  onPdf,
  onExcel,
}: {
  issued: ComisionesV2SettlementIssuedListItem[];
  loading: boolean;
  error: string | null;
  detailError: string | null;
  pdfError: string | null;
  selectedIssuedId: string | null;
  detail: ComisionesV2SettlementDetail | null;
  detailLoading: boolean;
  exportBusy: "PDF" | "EXCEL" | null;
  onRefresh: () => void;
  onOpen: (settlementId: string) => void;
  onPdf: () => void;
  onExcel: () => void;
}) {
  if (selectedIssuedId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {detailError && (
          <div className="m-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600">
            {detailError}
          </div>
        )}
        {pdfError && (
          <div className="m-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600">
            PDF oficial: {pdfError}
          </div>
        )}
        <SettlementDraftDetailLayout
          detail={detail}
          loading={detailLoading}
          onBack={() => onOpen("")}
          onCancel={() => {}}
          onIssue={() => {}}
          canIssue={false}
          issueBusy={false}
          onExportPdf={() => {}}
          onExportExcel={onExcel}
          onOfficialPdf={onPdf}
          mode="ISSUED"
          exportBusy={exportBusy}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-theme-text">
            Liquidaciones emitidas
          </h2>
          <p className="mt-1 text-xs text-theme-text-muted">
            Historial de documentos oficiales desde el snapshot persistido.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Actualizar
        </button>
      </div>
      {error && (
        <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600">
          {error}
        </div>
      )}
      {loading && issued.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-theme-text-muted">
          Cargando emitidas...
        </div>
      ) : issued.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="rounded-xl border border-dashed border-theme-border px-6 py-5 text-center">
            <CheckCircle2 className="mx-auto h-6 w-6 text-theme-text-muted/50" />
            <p className="mt-2 text-sm font-semibold text-theme-text">
              No hay liquidaciones emitidas.
            </p>
            <p className="mt-1 text-xs text-theme-text-muted">
              Las liquidaciones finalizadas aparecerán aquí.
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-theme-border">
          <table className="w-full min-w-[1040px] table-fixed text-xs">
            <thead className="sticky top-0 z-10 bg-theme-surface-hover text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
              <tr>
                <th className="w-44 px-3 py-2.5">Código</th>
                <th className="px-3 py-2.5">Vendedor</th>
                <th className="w-44 px-3 py-2.5">Período</th>
                <th className="w-20 px-3 py-2.5 text-right">Líneas</th>
                <th className="w-36 px-3 py-2.5 text-right">Neto</th>
                <th className="w-36 px-3 py-2.5 text-right">Comisión</th>
                <th className="w-40 px-3 py-2.5">Emisión</th>
                <th className="w-28 px-3 py-2.5">Estado</th>
                <th className="w-20 px-3 py-2.5 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {issued.map((item) => (
                <tr
                  key={item.settlement_id}
                  className="hover:bg-theme-text/[0.025]"
                >
                  <td className="px-3 py-3 font-mono font-semibold text-theme-text">
                    {item.settlement_code}
                  </td>
                  <td className="px-3 py-3 font-semibold text-theme-text">
                    {item.seller_name_snapshot}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {formatDate(item.period_from)}–{formatDate(item.period_to)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {item.lines_count.toLocaleString("es-CL")}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {formatCurrency(item.total_net_amount)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {formatCurrency(item.total_commission_amount)}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {formatSyncDate(item.issued_at)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="inline-flex rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-600">
                      EMITIDA
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onOpen(item.settlement_id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-theme-border px-2.5 py-1.5 text-xs font-semibold text-theme-text-muted hover:text-theme-text"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Ver
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LegacySettlementDraftsSection({
  drafts,
  loading,
  error,
  selectedDraftId,
  detail,
  detailLoading,
  notice,
  onRefresh,
  onOpen,
  onExportPdf,
  onExportExcel,
  exportBusy,
}: {
  drafts: ComisionesV2SettlementDraftListItem[];
  loading: boolean;
  error: string | null;
  selectedDraftId: string | null;
  detail: ComisionesV2SettlementDetail | null;
  detailLoading: boolean;
  notice: string | null;
  onRefresh: () => void;
  onOpen: (settlementId: string) => void;
  onExportPdf: () => void;
  onExportExcel: () => void;
  exportBusy: "PDF" | "EXCEL" | null;
}) {
  if (selectedDraftId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SettlementDraftDetailLayout
          detail={detail}
          loading={detailLoading}
          onBack={() => onOpen("")}
          onCancel={() => {}}
          onIssue={() => {}}
          canIssue={false}
          issueBusy={false}
          onExportPdf={onExportPdf}
          onExportExcel={onExportExcel}
          exportBusy={exportBusy}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-theme-text">
            Borradores de liquidación
          </h2>
          <p className="mt-1 text-xs text-theme-text-muted">
            Snapshot V2 persistido, sin recalcular reglas actuales.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Actualizar
        </button>
      </div>
      {error && (
        <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600">
          {error}
        </div>
      )}
      {loading && drafts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-theme-text-muted">
          Cargando borradores...
        </div>
      ) : drafts.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="rounded-xl border border-dashed border-theme-border px-6 py-5 text-center">
            <ClipboardList className="mx-auto h-6 w-6 text-theme-text-muted/50" />
            <p className="mt-2 text-sm font-semibold text-theme-text">
              No hay borradores de liquidación.
            </p>
            <p className="mt-1 text-xs text-theme-text-muted">
              Crea uno desde la pestaña Emisión E.P.
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-theme-border">
          <table className="w-full min-w-[850px] table-fixed text-xs">
            <thead className="sticky top-0 z-10 bg-theme-surface-hover text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
              <tr>
                <th className="px-3 py-2.5">Vendedor</th>
                <th className="px-3 py-2.5">Período</th>
                <th className="px-3 py-2.5 text-right">Líneas</th>
                <th className="px-3 py-2.5 text-right">Neto</th>
                <th className="px-3 py-2.5 text-right">Comisión</th>
                <th className="px-3 py-2.5">Creado</th>
                <th className="px-3 py-2.5">Estado</th>
                <th className="px-3 py-2.5 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
              {drafts.map((draft) => (
                <tr
                  key={draft.settlement_id}
                  className={`hover:bg-theme-text/[0.025] ${selectedDraftId === draft.settlement_id ? "bg-theme-accent/5" : ""}`}
                >
                  <td className="px-3 py-3 font-semibold text-theme-text">
                    {draft.seller_name_snapshot}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {formatDate(draft.period_from)}–
                    {formatDate(draft.period_to)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {draft.lines_count.toLocaleString("es-CL")}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {formatCurrency(draft.total_net_amount)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                    {formatCurrency(draft.total_commission_amount)}
                  </td>
                  <td className="px-3 py-3 text-theme-text-muted">
                    {formatSyncDate(draft.created_at)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">
                      BORRADOR
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onOpen(draft.settlement_id)}
                      className="inline-flex items-center gap-1 rounded-lg border border-theme-border px-2.5 py-1.5 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Ver
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notice && <p className="mt-2 shrink-0 text-xs text-red-600">{notice}</p>}
      {selectedDraftId && (
        <SettlementDraftDetail detail={detail} loading={detailLoading} />
      )}
    </div>
  );
}

void LegacySettlementDraftsSection;
void ExecutiveSummary;

type DraftSettlementLine = ComisionesV2SettlementDetail["lines"][number] & {
  line_kind?: "INVOICE" | "CREDIT_NOTE";
  original_invoice_line_id?: string | null;
  original_invoice_number?: number | null;
  original_invoice_bsale_id?: number | null;
};

function draftLineSearchValues(line: DraftSettlementLine) {
  return [
    line.source_document_number,
    line.source_document_bsale_id,
    line.customer_name_snapshot,
    line.sku_snapshot,
    line.description_snapshot,
    line.real_supplier_name_snapshot,
    line.family_name_snapshot,
    line.original_invoice_number,
    line.original_invoice_bsale_id,
  ];
}

function draftLineIsCreditNote(line: DraftSettlementLine) {
  return line.line_kind === "CREDIT_NOTE";
}

function draftLineGroups(detail: ComisionesV2SettlementDetail) {
  const lines = detail.lines as DraftSettlementLine[];
  const parentKey = (line: DraftSettlementLine) =>
    line.source_document_line_id != null
      ? String(line.source_document_line_id)
      : line.id;
  const byId = new Map(
    lines
      .map((line) => [parentKey(line), line] as const)
      .filter(([key]) => key != null),
  );
  const groups = new Map<string, DraftSettlementLine[]>();

  for (const line of lines) {
    if (draftLineIsCreditNote(line) && line.original_invoice_line_id) {
      const parent = byId.get(String(line.original_invoice_line_id));
      if (parent && !draftLineIsCreditNote(parent)) {
        const children = groups.get(line.original_invoice_line_id) ?? [];
        children.push(line);
        groups.set(line.original_invoice_line_id, children);
      }
    } else if (!draftLineIsCreditNote(line) && parentKey(line)) {
      groups.set(parentKey(line)!, []);
    }
  }

  return lines
    .filter((line) => !draftLineIsCreditNote(line) && parentKey(line))
    .map((parent) => ({
      parent,
      children: groups.get(parentKey(parent)!) ?? [],
    }));
}

function draftLineRows(
  detail: ComisionesV2SettlementDetail,
  query: string,
) {
  const normalizedQuery = normalizePlanSearch(query);
  return draftLineGroups(detail).flatMap(({ parent, children }) => {
    const group = [parent, ...children];
    if (!normalizedQuery) return group;
    const matches = group.some((line) =>
      draftLineSearchValues(line).some((value) =>
        normalizePlanSearch(String(value ?? "")).includes(normalizedQuery),
      ),
    );
    return matches ? group : [];
  });
}

function SettlementDraftDetailLayout({
  detail,
  loading,
  onBack,
  onCancel,
  onIssue,
  canIssue,
  issueBusy,
  onExportPdf,
  onExportExcel,
  onOfficialPdf,
  mode = "DRAFT",
  exportBusy,
}: {
  detail: ComisionesV2SettlementDetail | null;
  loading: boolean;
  onBack: () => void;
  onCancel: (target: DraftCancelTarget) => void;
  onIssue: () => void;
  canIssue: boolean;
  issueBusy: boolean;
  onExportPdf: () => void;
  onExportExcel: () => void;
  onOfficialPdf?: () => void;
  mode?: "DRAFT" | "ISSUED";
  exportBusy: "PDF" | "EXCEL" | null;
}) {
  const [lineSearch, setLineSearch] = useState("");
  if (loading)
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-theme-text-muted">
        Cargando snapshot...
      </div>
    );
  if (!detail)
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-theme-text-muted">
        No se pudo cargar el snapshot.
      </div>
    );

  const isIssued = mode === "ISSUED";
  const effectivePercent = detail.settlement.total_net_amount
    ? (detail.settlement.total_commission_amount /
        detail.settlement.total_net_amount) *
      100
    : 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface">
        <div className="shrink-0 border-b border-theme-border bg-theme-text/[0.02] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={onBack}
                disabled={Boolean(exportBusy)}
                className="mt-0.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 py-1.5 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
              >
                Volver
              </button>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-bold text-theme-text">
                    {detail.settlement.seller_name_snapshot}
                  </h3>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${isIssued ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600" : "border-sky-500/25 bg-sky-500/10 text-sky-600"}`}
                  >
                    {isIssued ? "EMITIDA" : "Borrador"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-theme-text-muted">
                  {isIssued && detail.settlement.settlement_code
                    ? `${detail.settlement.settlement_code} · `
                    : ""}
                  Período: {formatDate(detail.settlement.period_from)} al{" "}
                  {formatDate(detail.settlement.period_to)}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {isIssued ? (
                <>
                  <button
                    type="button"
                    onClick={onOfficialPdf}
                    disabled={Boolean(exportBusy)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-2.5 py-1.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {exportBusy === "PDF" ? "Abriendo..." : "PDF oficial"}
                  </button>
                  <button
                    type="button"
                    onClick={onExportExcel}
                    disabled={Boolean(exportBusy)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 py-1.5 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    {exportBusy === "EXCEL" ? "Generando..." : "Excel"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onExportPdf()}
                    disabled={Boolean(exportBusy) || issueBusy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 py-1.5 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {exportBusy === "PDF" ? "Generando..." : "PDF"}
                  </button>
                  <button
                    type="button"
                    onClick={onExportExcel}
                    disabled={Boolean(exportBusy) || issueBusy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2.5 py-1.5 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    {exportBusy === "EXCEL" ? "Generando..." : "Excel"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onCancel(draftCancelTargetFromDetail(detail))
                    }
                    disabled={Boolean(exportBusy) || issueBusy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-500/25 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-500/5 disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    Cancelar borrador
                  </button>
                  {canIssue && (
                    <button
                      type="button"
                      onClick={onIssue}
                      disabled={
                        Boolean(exportBusy) ||
                        issueBusy ||
                        detail.settlement.status !== "DRAFT"
                      }
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
                    >
                      {issueBusy && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      {issueBusy ? "Emitiendo..." : "Emitir"}
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-right sm:grid-cols-4 xl:grid-cols-6">
              <DraftMetric
                label="Líneas"
                value={detail.lines.length.toLocaleString("es-CL")}
              />
              <DraftMetric
                label="Neto"
                value={formatCurrency(detail.settlement.total_net_amount)}
              />
              <DraftMetric
                label="Tasa comisión"
                value={percentLabel(effectivePercent)}
              />
              <DraftMetric
                label="Comisión"
                value={formatCurrency(
                  detail.settlement.total_commission_amount,
                )}
              />
              <DraftMetric
                label="Creación"
                value={formatSyncDate(detail.settlement.created_at)}
              />
              <DraftMetric
                label="Emisión"
                value={formatSyncDate(detail.settlement.issued_at)}
              />
            </div>
          </div>
         </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b border-theme-border bg-theme-surface px-3 py-2 md:px-4">
            <label className="relative flex min-w-[240px] flex-1 items-center sm:max-w-xl">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-theme-text-muted" />
              <input
                type="search"
                value={lineSearch}
                onChange={(event) => setLineSearch(event.target.value)}
                placeholder="Buscar factura, NC, SKU, producto, cliente, proveedor o familia"
                aria-label="Buscar líneas del snapshot"
                className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface pl-8 pr-3 text-xs text-theme-text outline-none placeholder:text-theme-text-muted/70 focus:border-theme-accent"
              />
            </label>
            <span className="text-[10px] text-theme-text-muted">
              {draftLineRows(detail, lineSearch).length.toLocaleString("es-CL")} líneas visibles
            </span>
          </div>
          <SupplierSettlementSummary detail={detail} />
          <table className="min-w-[1650px] w-full table-fixed whitespace-nowrap text-xs">
            <colgroup>
              <col className="w-[105px]" />
              <col className="w-[190px]" />
              <col className="w-[125px]" />
              <col className="w-[130px]" />
              <col className="w-[260px]" />
              <col className="w-[210px]" />
              <col className="w-[170px]" />
              <col className="w-[90px]" />
              <col className="w-[125px]" />
              <col className="w-[210px]" />
              <col className="w-[175px]" />
              <col className="w-[100px]" />
              <col className="w-[135px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-theme-surface-hover text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
              <tr>
                <th className="px-3 py-2.5">Factura</th>
                <th className="px-3 py-2.5">Cliente</th>
                <th className="px-3 py-2.5">Pago completo</th>
                <th className="px-3 py-2.5">SKU</th>
                <th className="px-3 py-2.5">Producto</th>
                <th className="px-3 py-2.5">Proveedor REAL</th>
                <th className="px-3 py-2.5">Familia</th>
                <th className="px-3 py-2.5 text-right">Cantidad</th>
                <th className="px-3 py-2.5 text-right">Neto</th>
                <th className="px-4 py-2.5">Plan / Regla</th>
                <th className="border-l border-theme-border/70 px-4 py-2.5">
                  Tipo de comisión
                </th>
                <th className="px-3 py-2.5 text-right">%</th>
                <th className="px-3 py-2.5 text-right">Comisión</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/60">
             {draftLineRows(detail, lineSearch).map((line, index) => {
                const status = snapshotStatus(line);
                const isCreditNote = draftLineIsCreditNote(line);
                return (
                  <tr
                    key={`${line.id ?? line.source_document_bsale_id}-${index}`}
                    className={`${isCreditNote ? "bg-rose-500/[0.045]" : ""} ${status === "NO_ACTIVE_PLAN" || status === "NO_FAMILY_RATE" ? "bg-amber-500/[0.035]" : ""}`}
                  >
                    <td className="px-3 py-3 font-semibold text-theme-text">
                      {isCreditNote ? (
                        <div className="pl-3">
                          <div>↳ NC {line.source_document_number ?? line.source_document_bsale_id}</div>
                          <div className="mt-0.5 text-[10px] font-normal text-theme-text-muted">
                            Factura {line.original_invoice_number ?? line.original_invoice_bsale_id ?? "—"}
                          </div>
                        </div>
                      ) : (
                        line.source_document_number ?? line.source_document_bsale_id
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className="block truncate text-theme-text"
                        title={line.customer_name_snapshot ?? undefined}
                      >
                        {line.customer_name_snapshot ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-theme-text-muted">
                      {formatPaymentDate(line.full_payment_date)}
                    </td>
                    <td className="px-3 py-3 text-theme-text">
                      {line.sku_snapshot ?? "—"}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className="block truncate text-theme-text"
                        title={line.description_snapshot ?? undefined}
                      >
                        {line.description_snapshot ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className="block truncate text-theme-text"
                        title={line.real_supplier_name_snapshot ?? undefined}
                      >
                        {line.real_supplier_name_snapshot ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className="block truncate text-theme-text"
                        title={line.family_name_snapshot ?? undefined}
                      >
                        {line.family_name_snapshot ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                      {line.quantity}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                      {formatCurrency(line.net_amount)}
                    </td>
                    <td className="max-w-0 px-4 py-3">
                      <span
                        className="block truncate text-theme-text"
                        title={snapshotPlanLabel(line)}
                      >
                        {snapshotPlanLabel(line)}
                      </span>
                    </td>
                    <td className="border-l border-theme-border/70 px-4 py-3">
                      <span
                        className="block truncate text-theme-text"
                        title={snapshotTypeLabel(line)}
                      >
                        {snapshotTypeLabel(line)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-theme-text">
                      {status === "NO_ACTIVE_PLAN" ||
                      status === "NO_FAMILY_RATE"
                        ? "0,00 %"
                        : percentLabel(line.percentage)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-medium text-theme-text">
                      {formatCurrency(line.commission_amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SettlementDraftDetail({
  detail,
  loading,
}: {
  detail: ComisionesV2SettlementDetail | null;
  loading: boolean;
}) {
  if (loading)
    return (
      <div className="mt-3 rounded-xl border border-theme-border p-4 text-sm text-theme-text-muted">
        Cargando snapshot...
      </div>
    );
  if (!detail) return null;
  const effectivePercent = detail.settlement.total_net_amount
    ? (detail.settlement.total_commission_amount /
        detail.settlement.total_net_amount) *
      100
    : 0;
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface">
      <div className="shrink-0 border-b border-theme-border bg-theme-text/[0.02] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-theme-text">
              {detail.settlement.seller_name_snapshot}
            </h3>
            <p className="mt-1 text-xs text-theme-text-muted">
              {formatDate(detail.settlement.period_from)} al{" "}
              {formatDate(detail.settlement.period_to)} · Borrador
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-right">
            <DraftMetric
              label="Líneas"
              value={detail.lines.length.toLocaleString("es-CL")}
            />
            <DraftMetric
              label="Neto"
              value={formatCurrency(detail.settlement.total_net_amount)}
            />
            <DraftMetric
              label="Tasa comisión"
              value={percentLabel(effectivePercent)}
            />
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-[1450px] w-full table-fixed whitespace-nowrap text-xs">
          <thead className="sticky top-0 z-10 bg-theme-surface-hover text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
            <tr>
              <th className="px-3 py-2.5">Factura</th>
              <th className="px-3 py-2.5">Cliente</th>
              <th className="px-3 py-2.5">Pago completo</th>
              <th className="px-3 py-2.5">SKU</th>
              <th className="px-3 py-2.5">Producto</th>
              <th className="px-3 py-2.5">Proveedor REAL</th>
              <th className="px-3 py-2.5">Familia</th>
              <th className="px-3 py-2.5 text-right">Cantidad</th>
              <th className="px-3 py-2.5 text-right">Neto</th>
              <th className="px-3 py-2.5">Plan / Regla</th>
              <th className="px-3 py-2.5">Tipo de comisión</th>
              <th className="px-3 py-2.5 text-right">%</th>
              <th className="px-3 py-2.5 text-right">Comisión</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/60">
            {detail.lines.map((line, index) => {
              const status = snapshotStatus(line);
              return (
                <tr
                  key={`${line.source_document_bsale_id}-${line.source_document_number ?? "line"}-${index}`}
                  className={
                    status === "NO_ACTIVE_PLAN" || status === "NO_FAMILY_RATE"
                      ? "bg-amber-500/[0.035]"
                      : ""
                  }
                >
                  <td className="px-3 py-2.5 font-semibold text-theme-text">
                    {line.source_document_number ??
                      line.source_document_bsale_id}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className="block max-w-[220px] truncate"
                      title={line.customer_name_snapshot ?? undefined}
                    >
                      {line.customer_name_snapshot ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-theme-text-muted">
                    {formatDate(line.full_payment_date)}
                  </td>
                  <td className="px-3 py-2.5">{line.sku_snapshot ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className="block max-w-[260px] truncate"
                      title={line.description_snapshot ?? undefined}
                    >
                      {line.description_snapshot ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className="block max-w-[220px] truncate"
                      title={line.real_supplier_name_snapshot ?? undefined}
                    >
                      {line.real_supplier_name_snapshot ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {line.family_name_snapshot ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {line.quantity}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatCurrency(line.net_amount)}
                  </td>
                  <td className="px-3 py-2.5">{snapshotPlanLabel(line)}</td>
                  <td className="px-3 py-2.5">{snapshotTypeLabel(line)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {percentLabel(line.percentage ?? 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                    {formatCurrency(line.commission_amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FamilyPlanConfigurator({
  onPlanSaved,
  onPlanRemoved,
  onPlansChanged,
  initialPlans,
  initialSuppliers,
  bootstrapLoading,
  bootstrapError,
}: {
  onPlanSaved: (
    savedPlan: ComisionesV2FamilyPlanListItem,
    previousPlanId: string | null,
  ) => Promise<void>;
  onPlanRemoved: (removal: ComisionesV2PlanRemovalResult) => Promise<void>;
  onPlansChanged: () => Promise<void>;
  initialPlans: ComisionesV2FamilyPlanListItem[] | null;
  initialSuppliers: ComisionesV2Supplier[] | null;
  bootstrapLoading: boolean;
  bootstrapError: string | null;
}) {
  const suppliers = initialSuppliers ?? [];
  const [families, setFamilies] = useState<ComisionesV2Family[]>([]);
  const [conflicts, setConflicts] = useState<
    Record<number, ComisionesV2FamilyConflict>
  >({});
  const [baseConflict, setBaseConflict] =
    useState<ComisionesV2BasePlanConflict | null>(null);
  const [conflictsRefresh, setConflictsRefresh] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedPlans, setArchivedPlans] = useState<
    ComisionesV2FamilyPlanListItem[] | null
  >(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const plans = showArchived
    ? (archivedPlans ?? []).filter(
        (item) => item.status === "RETIRED" && item.active === false,
      )
    : (initialPlans ?? []).filter(
        (item) => item.status === "ACTIVE" && item.active === true,
      );
  const [plan, setPlan] = useState<ComisionesV2FamilyPlan | null>(null);
  const [planType, setPlanType] = useState<ComisionesV2PlanType>(
    "FAMILY_FIXED_PERCENT",
  );
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(true);
  const [supplierId, setSupplierId] = useState("");
  const [planCode, setPlanCode] = useState("");
  const [validFrom, setValidFrom] = useState(() => initialChileCycle().from);
  const [validTo, setValidTo] = useState(() => initialChileCycle().to);
  const [rates, setRates] = useState<Record<number, string>>({});
  const [tiers, setTiers] = useState<ComisionesV2Tier[]>([
    { tier_order: 1, lower_bound: 0, upper_bound: null, percentage: 0 },
  ]);
  const [selectedFamilyIds, setSelectedFamilyIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [bulkPercentage, setBulkPercentage] = useState("");
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [confirmVersioning, setConfirmVersioning] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [planSearch, setPlanSearch] = useState("");

  useEffect(() => {
    if (!supplierId) return;
    let current = true;
    void listComisionesV2SupplierFamilies(supplierId).then((familyResult) => {
      if (!current) return;
      if (familyResult.error) {
        setError(familyResult.error);
        return;
      }
      setFamilies(familyResult.data);
      setSelectedFamilyIds(new Set());
    });
    return () => {
      current = false;
    };
  }, [supplierId]);

  useEffect(() => {
    if (!supplierId || !validFrom) {
      return;
    }
    let current = true;
    const input = {
      supplierId,
      validFrom,
      validTo: validTo || null,
      excludePlanId: plan?.id,
    };
    void Promise.all([
      getComisionesV2BasePlanConflict(input),
      planType === "FAMILY_FIXED_PERCENT"
        ? listComisionesV2FamilyPlanConflicts(input)
        : Promise.resolve({
            data: [] as ComisionesV2FamilyConflict[],
            error: undefined as string | undefined,
          }),
    ]).then(([baseResult, familyResult]) => {
      if (!current) return;
      setBaseConflict(baseResult.data);
      setConflicts(
        Object.fromEntries(
          familyResult.data.map((conflict) => [
            conflict.family_bsale_product_type_id,
            conflict,
          ]),
        ),
      );
      if (baseResult.error) setError(baseResult.error);
      if (familyResult.error) setError(familyResult.error);
    });
    return () => {
      current = false;
    };
  }, [supplierId, validFrom, validTo, plan?.id, planType, conflictsRefresh]);

  function selectSupplier(value: string) {
    setSupplierId(value);
    setConflicts({});
    setBaseConflict(null);
    if (!value) {
      setFamilies([]);
      setRates({});
      setSelectedFamilyIds(new Set());
    }
  }

  function resetNewPlan() {
    setIsReadOnly(false);
    setConfirmVersioning(false);
    setConfirmRemoval(false);
    setIsNew(true);
    setSelectedPlanId(null);
    setPlan(null);
    setBaseConflict(null);
    setNotice(null);
    setError(null);
    setPlanType("FAMILY_FIXED_PERCENT");
    setSupplierId("");
    const cycle = initialChileCycle();
    setPlanCode("");
    setValidFrom(cycle.from);
    setValidTo(cycle.to);
    setRates({});
    setFamilies([]);
    setConflicts({});
    setTiers([
      { tier_order: 1, lower_bound: 0, upper_bound: null, percentage: 0 },
    ]);
    setSelectedFamilyIds(new Set());
    setBulkPercentage("");
  }

  async function openPlan(id: string) {
    setSelectedPlanId(id);
    setIsNew(false);
    setIsReadOnly(showArchived);
    setConfirmVersioning(false);
    setNotice(null);
    setError(null);
    setLoadingPlanId(id);
    setPlan(null);
    setBaseConflict(null);
    setSupplierId("");
    setPlanCode("");
    setValidFrom("");
    setValidTo("");
    setRates({});
    setTiers([]);
    setFamilies([]);
    setConflicts({});
    setSelectedFamilyIds(new Set());
    setBulkPercentage("");
    try {
      const result = await getComisionesV2FamilyPlanById(id);
      if (result.error || !result.data) {
        setError(result.error ?? "No se pudo cargar el plan.");
        return;
      }
      const loaded = result.data;
      setPlan(loaded);
      setPlanType(loaded.plan_type);
      setSupplierId(loaded.supplier_id);
      setPlanCode(loaded.plan_code);
      setValidFrom(loaded.valid_from);
      setValidTo(loaded.valid_to ?? "");
      setRates(
        Object.fromEntries(
          (loaded.rates ?? []).map((rate) => [
            rate.family_bsale_product_type_id,
            normalizePercentageInput(rate.percentage),
          ]),
        ),
      );
      setTiers(normalizeTierBounds(loaded.tiers ?? []));
    } finally {
      setLoadingPlanId(null);
    }
  }

  function toggleAllFamilies(checked: boolean) {
    setSelectedFamilyIds(
      checked
        ? new Set(
            families
              .filter(
                (family) => !conflicts[family.family_bsale_product_type_id],
              )
              .map((family) => family.family_bsale_product_type_id),
          )
        : new Set(),
    );
  }

  function applyBulkPercentage() {
    if (selectedFamilyIds.size === 0) {
      setError("Selecciona al menos una Familia.");
      return;
    }
    const numeric = percentageNumber(bulkPercentage);
    if (
      bulkPercentage.trim() === "" ||
      numeric == null ||
      numeric < 0 ||
      numeric > 100
    ) {
      setError("Ingresa un porcentaje válido entre 0 y 100.");
      return;
    }
    const value = normalizePercentageInput(bulkPercentage);
    setBulkPercentage(value);
    setRates((current) =>
      Object.fromEntries(
        families.map((family) => [
          family.family_bsale_product_type_id,
          selectedFamilyIds.has(family.family_bsale_product_type_id) &&
          !conflicts[family.family_bsale_product_type_id]
            ? value
            : (current[family.family_bsale_product_type_id] ?? ""),
        ]),
      ),
    );
    setError(null);
  }

  function clearSelectedRates() {
    if (selectedFamilyIds.size === 0) {
      setError("Selecciona al menos una Familia.");
      return;
    }
    setRates((current) =>
      Object.fromEntries(
        families.map((family) => [
          family.family_bsale_product_type_id,
          selectedFamilyIds.has(family.family_bsale_product_type_id)
            ? ""
            : (current[family.family_bsale_product_type_id] ?? ""),
        ]),
      ),
    );
    setError(null);
  }

  async function save() {
    if (isReadOnly) return;
    if (!isNew && plan?.issued_usage_known !== false && plan?.has_issued_usage) {
      setConfirmVersioning(true);
      return;
    }
    await executeSave();
  }

  async function executeSave() {
    setSaving(true);
    setError(null);
    setNotice(null);
    const parsedRates: ComisionesV2FamilyRate[] = Object.entries(rates)
      .filter(([, value]) => value.trim() !== "")
      .map(([familyId, value]) => ({
        family_bsale_product_type_id: Number(familyId),
        family_name_snapshot:
          families.find(
            (family) =>
              family.family_bsale_product_type_id === Number(familyId),
          )?.family_name ?? "",
        percentage: Number(value.replace(",", ".")),
      }));
    const result =
      planType === "SUPPLIER_SALES_TARGET"
        ? await saveComisionesV2SalesTargetPlan({
            planId: plan?.id ?? null,
            planCode,
            supplierId,
            validFrom,
            validTo: validTo || null,
            tiers,
          })
        : await saveComisionesV2FamilyPlan({
            planId: plan?.id ?? null,
            planCode,
            supplierId,
            validFrom,
            validTo: validTo || null,
            rates: parsedRates,
          });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      setConflictsRefresh((value) => value + 1);
      return;
    }
    if (!result.data) {
      setError("El backend no devolvió la regla guardada.");
      return;
    }
    const previousPlanId = plan?.id ?? null;
    const savedPlan: ComisionesV2FamilyPlanListItem = {
      id: result.data.plan_id,
      supplier_id: supplierId,
      plan_code: planCode.trim(),
      version_no: result.data.version_no,
      plan_type: planType,
      valid_from: validFrom,
      valid_to: validTo || null,
      supplier_name:
        suppliers.find((supplier) => supplier.supplier_id === supplierId)
          ?.supplier_name ??
        plan?.supplier_name ??
        null,
      status: "ACTIVE",
      active: true,
      supersedes_plan_id:
        result.data.plan_id !== previousPlanId ? previousPlanId : plan?.supersedes_plan_id ?? null,
      has_issued_usage: false,
      issued_usage_known: true,
      family_names: parsedRates.map((rate) => rate.family_name_snapshot),
    };
    const savedDetail: ComisionesV2FamilyPlan = {
      ...savedPlan,
      rates: parsedRates,
      tiers,
    };
    setPlan(savedDetail);
    setPlanType(savedDetail.plan_type);
    setSelectedPlanId(savedDetail.id);
    setIsNew(false);
    setRates(
      Object.fromEntries(
        parsedRates.map((rate) => [
          rate.family_bsale_product_type_id,
          normalizePercentageInput(rate.percentage),
        ]),
      ),
    );
    setTiers(normalizeTierBounds(tiers));
    setNotice(
      result.data.plan_id !== previousPlanId
        ? "Se creó una nueva versión. Las comisiones anteriores no fueron modificadas."
        : "Cambios guardados correctamente.",
    );
    setSelectedFamilyIds(new Set());
    setBulkPercentage("");
    setConfirmVersioning(false);
    await onPlanSaved(savedPlan, previousPlanId);
  }

  async function executeRemoval() {
    if (isNew || isReadOnly || !plan?.id || removing || saving) return;
    setRemoving(true);
    setError(null);
    const result = await removeComisionesV2Plan(plan.id);
    setRemoving(false);
    if (result.error) {
      const concurrent = result.error.includes("ya no está vigente");
      if (concurrent) {
        await onPlansChanged();
        resetNewPlan();
      }
      setError(result.error);
      return;
    }
    if (!result.data) {
      setError("El backend no devolvió el resultado de la eliminación.");
      return;
    }
    const removal = result.data;
    resetNewPlan();
    setNotice(
      removal.result === "ARCHIVED"
        ? "La regla tenía historial y fue archivada."
        : "Regla eliminada correctamente.",
    );
    await onPlanRemoved(removal);
  }

  async function showArchivedPlans() {
    if (showArchived) return;
    setArchivedLoading(true);
    const result = await listComisionesV2FamilyPlans({ archived: true });
    setArchivedLoading(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setArchivedPlans(result.data);
    setShowArchived(true);
    setConfirmVersioning(false);
    setIsReadOnly(true);
    setIsNew(false);
    setSelectedPlanId(null);
    setPlan(null);
    setSupplierId("");
    setPlanCode("");
  }

  function showCurrentPlans() {
    setShowArchived(false);
    resetNewPlan();
  }

  const loading = bootstrapLoading || !initialPlans || !initialSuppliers;
  if (loading) return <LoadingState />;
  if (bootstrapError && !initialPlans)
    return (
      <div className="flex flex-1 items-center justify-center gap-3 p-6 text-xs text-red-600">
        <span>{bootstrapError}</span>
        <button
          type="button"
          onClick={() => void onPlansChanged()}
          className="rounded-md border border-theme-border px-2.5 py-1.5 font-semibold text-theme-text"
        >
          Reintentar
        </button>
      </div>
    );
  const today = todayChileCivil();
  const orderedPlans = [...plans].sort(
    (a, b) =>
      planState(a, today).order - planState(b, today).order ||
      b.valid_from.localeCompare(a.valid_from) ||
      b.version_no - a.version_no,
  );
  const normalizedPlanSearch = normalizePlanSearch(planSearch);
  const filteredPlans = orderedPlans.flatMap((item) => {
    const planAndSupplierMatch = normalizePlanSearch(
      `${item.plan_code} ${item.supplier_name ?? ""}`,
    ).includes(normalizedPlanSearch);
    const matchingFamilies =
      normalizedPlanSearch && item.plan_type === "FAMILY_FIXED_PERCENT"
        ? item.family_names.filter((familyName) =>
            normalizePlanSearch(familyName).includes(normalizedPlanSearch),
          )
        : [];
    if (
      !normalizedPlanSearch ||
      planAndSupplierMatch ||
      matchingFamilies.length > 0
    ) {
      return [{ item, matchingFamilies }];
    }
    return [];
  });
  const availableFamilies = families.filter(
    (family) => !conflicts[family.family_bsale_product_type_id],
  );
  const allFamiliesSelected =
    availableFamilies.length > 0 &&
    selectedFamilyIds.size === availableFamilies.length;
  const someFamiliesSelected =
    selectedFamilyIds.size > 0 && !allFamiliesSelected;
  const supplierOptions = suppliers.map((supplier) => ({
    value: supplier.supplier_id,
    label: supplier.supplier_name,
  }));
  const saveLabel = isNew
    ? "Guardar plan"
    : plan?.has_issued_usage
      ? "Guardar nueva versión"
      : "Guardar cambios";
  return (
    <div className="h-full min-h-0 flex-1 overflow-hidden p-3 md:p-4">
      <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-theme-text">
              {showArchived ? "Reglas archivadas" : "Reglas existentes"}
            </h2>
            {!showArchived ? (
              <button
                type="button"
                onClick={resetNewPlan}
                className="rounded-md bg-theme-accent px-2 py-1.5 text-[10px] font-bold text-white"
              >
                Nuevo plan
              </button>
            ) : (
              <button
                type="button"
                onClick={showCurrentPlans}
                className="rounded-md border border-theme-border px-2 py-1.5 text-[10px] font-bold text-theme-text-muted hover:text-theme-text"
              >
                Volver a vigentes
              </button>
            )}
          </div>
          {!showArchived && (
            <button
              type="button"
              onClick={() => void showArchivedPlans()}
              disabled={archivedLoading}
              className="mt-2 w-full rounded-md border border-theme-border px-2 py-1.5 text-[10px] font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-60"
            >
              {archivedLoading ? "Cargando archivadas..." : "Ver reglas archivadas"}
            </button>
          )}
          <label className="relative mt-3 block">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-theme-text-muted" />
            <input
              value={planSearch}
              onChange={(event) => setPlanSearch(event.target.value)}
              placeholder="Buscar plan, proveedor o familia..."
              className="h-8 w-full rounded-md border border-theme-border bg-theme-surface pl-7 pr-2 text-xs text-theme-text"
            />
          </label>
          <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1">
            {filteredPlans.length === 0 ? (
              <p className="p-2 text-xs text-theme-text-muted">
                {planSearch
                  ? "No hay resultados."
                  : "No hay planes disponibles."}
              </p>
            ) : (
              filteredPlans.map(({ item, matchingFamilies }) => {
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void openPlan(item.id)}
                    className={`block w-full rounded-md border px-2 py-1.5 text-left transition-colors ${selectedPlanId === item.id ? "border-theme-accent bg-theme-accent/5" : "border-transparent hover:border-theme-border hover:bg-theme-text/[0.03]"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold text-theme-text">
                        {item.plan_code}
                      </span>
                      <Badge
                        value={showArchived ? "ARCHIVADA" : "VIGENTE"}
                        tone={showArchived ? "muted" : "green"}
                      />
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-theme-text-muted">
                      <span className="truncate">
                        {item.supplier_name ?? "Proveedor sin nombre"} ·{" "}
                        {item.plan_type === "FAMILY_FIXED_PERCENT"
                          ? "Por Familia"
                          : "Meta de ventas"} · v{item.version_no} ·{" "}
                        {formatDate(item.valid_from)}–
                        {formatDate(item.valid_to)}
                      </span>
                      {item.has_issued_usage && (
                        <span className="shrink-0 text-amber-600">Usada</span>
                      )}
                    </div>
                    {matchingFamilies.length > 0 && (
                      <div className="mt-1 truncate text-[10px] text-theme-accent">
                        Familia: {matchingFamilies.slice(0, 2).join(", ")}
                        {matchingFamilies.length > 2
                          ? ` +${matchingFamilies.length - 2}`
                          : ""}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </aside>
        <section className="min-h-0 overflow-y-auto rounded-xl border border-theme-border bg-theme-surface p-4 md:p-5">
          <div className="mb-5">
            <h2 className="text-base font-bold text-theme-text">
              {planType === "SUPPLIER_SALES_TARGET"
                ? "Meta de ventas"
                : "Plan por Familia"}
            </h2>
            <p className="mt-1 text-xs text-theme-text-muted">
              {planType === "SUPPLIER_SALES_TARGET"
                ? "Configura tramos de venta neta y su porcentaje único."
                : "Configura un porcentaje para cada Familia. Vacío significa Sin regla."}
            </p>
          </div>
          {loadingPlanId && (
            <div
              className="mb-4 rounded-lg border border-theme-accent/25 bg-theme-accent/5 p-3 text-xs font-semibold text-theme-accent"
              aria-live="polite"
            >
              Cargando plan...
            </div>
          )}
          {error && (
            <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600">
              {error}
            </div>
          )}
          {notice && (
            <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-600">
              {notice}
            </div>
          )}
          {isReadOnly && (
            <div className="mb-4 rounded-lg border border-theme-border bg-theme-text/[0.03] p-3 text-xs text-theme-text-muted">
              Esta regla está archivada y sólo está disponible para consulta.
            </div>
          )}
          {baseConflict && (
            <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-700">
              Este proveedor ya tiene un plan vigente para este período:{" "}
              {baseConflict.conflict_plan_code} ·{" "}
              {baseConflict.conflict_plan_type === "FAMILY_FIXED_PERCENT"
                ? "Por Familia"
                : "Meta de ventas"}{" "}
              · Vigencia: {formatDate(baseConflict.conflict_valid_from)}–
              {formatDate(baseConflict.conflict_valid_to)}
            </div>
          )}
          {!isNew && plan && (
            <div
              className={`mb-4 rounded-lg border p-3 text-xs ${plan.issued_usage_known === false ? "border-amber-500/25 bg-amber-500/5 text-amber-700" : plan.has_issued_usage ? "border-amber-500/25 bg-amber-500/5 text-amber-700" : "border-emerald-500/20 bg-emerald-500/5 text-emerald-700"}`}
            >
              {plan.issued_usage_known === false
                ? "No se pudo verificar el uso anterior. El guardado queda bloqueado hasta poder comprobarlo."
                : plan.has_issued_usage
                   ? "Esta versión ya fue utilizada en una liquidación. Los cambios se guardarán como una nueva versión y no modificarán comisiones anteriores."
                   : "Esta versión aún no ha sido utilizada en una liquidación y puede editarse directamente."}
            </div>
          )}
          {isNew ? (
            <div
              className="mb-4 inline-flex rounded-lg border border-theme-border bg-theme-text/[0.03] p-1"
              role="tablist"
              aria-label="Tipo de plan"
            >
              <button
                type="button"
                role="tab"
                aria-selected={planType === "FAMILY_FIXED_PERCENT"}
                onClick={() => setPlanType("FAMILY_FIXED_PERCENT")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${planType === "FAMILY_FIXED_PERCENT" ? "bg-theme-accent text-white" : "text-theme-text-muted hover:text-theme-text"}`}
              >
                Por Familia
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={planType === "SUPPLIER_SALES_TARGET"}
                onClick={() => setPlanType("SUPPLIER_SALES_TARGET")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${planType === "SUPPLIER_SALES_TARGET" ? "bg-theme-accent text-white" : "text-theme-text-muted hover:text-theme-text"}`}
              >
                Meta de ventas
              </button>
            </div>
          ) : (
            <div className="mb-4 rounded-lg border border-theme-border bg-theme-text/[0.03] px-3 py-2 text-xs font-semibold text-theme-text">
              Tipo de plan:{" "}
              {planType === "SUPPLIER_SALES_TARGET"
                ? "Meta de ventas"
                : "Por Familia"}
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="grid gap-1 text-[11px] font-semibold text-theme-text-muted md:col-span-2">
              Proveedor REAL
              <div className="relative">
                <LocalCombobox
                  value={supplierId}
                  onChange={selectSupplier}
                  options={supplierOptions}
                  disabled={!isNew || Boolean(loadingPlanId)}
                  placeholder="Buscar proveedor por nombre..."
                  emptyText="No se encontraron proveedores"
                  clearable
                  className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs disabled:opacity-60"
                />
              </div>
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-theme-text-muted md:col-span-2">
              Nombre del plan
              <input
                value={planCode}
                disabled={Boolean(loadingPlanId) || isReadOnly}
                onChange={(event) => setPlanCode(event.target.value)}
                placeholder="Ej. Plan alimento agosto"
                className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text disabled:opacity-60"
              />
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-theme-text-muted">
              Vigencia desde
              <input
                type="date"
                value={validFrom}
                disabled={Boolean(loadingPlanId) || isReadOnly}
                onChange={(event) => setValidFrom(event.target.value)}
                className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text disabled:opacity-60"
              />
            </label>
            <label className="grid gap-1 text-[11px] font-semibold text-theme-text-muted">
              Vigencia hasta
              <input
                type="date"
                value={validTo}
                disabled={Boolean(loadingPlanId) || isReadOnly}
                onChange={(event) => setValidTo(event.target.value)}
                className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs font-normal text-theme-text disabled:opacity-60"
              />
            </label>
          </div>
          {planType === "SUPPLIER_SALES_TARGET" && (
            <TargetTierEditorUx
              tiers={tiers}
              disabled={Boolean(loadingPlanId) || isReadOnly}
              onChange={setTiers}
            />
          )}
          <div className={planType === "SUPPLIER_SALES_TARGET" ? "hidden" : ""}>
            <div className="mt-6 overflow-hidden rounded-lg border border-theme-border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-theme-border bg-theme-text/[0.03] px-3 py-2">
                <label className="flex items-center gap-2 text-[11px] font-semibold text-theme-text">
                  <input
                    type="checkbox"
                    disabled={Boolean(loadingPlanId) || isReadOnly}
                    checked={allFamiliesSelected}
                    ref={(input) => {
                      if (input) input.indeterminate = someFamiliesSelected;
                    }}
                    onChange={(event) =>
                      toggleAllFamilies(event.target.checked)
                    }
                  />
                  Seleccionar todas
                </label>
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[10px] text-theme-text-muted">
                    <span>Porcentaje para seleccionadas</span>
                    <input
                      value={bulkPercentage}
                      disabled={Boolean(loadingPlanId) || isReadOnly}
                      onChange={(event) =>
                        setBulkPercentage(event.target.value)
                      }
                      onBlur={(event) =>
                        setBulkPercentage(
                          normalizePercentageInput(event.target.value),
                        )
                      }
                      placeholder="1,20"
                      inputMode="decimal"
                      className="h-8 w-20 rounded-md border border-theme-border bg-theme-surface px-2 text-right text-xs text-theme-text disabled:opacity-60"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={Boolean(loadingPlanId) || isReadOnly}
                    onClick={applyBulkPercentage}
                    className="h-8 rounded-md border border-theme-border bg-theme-surface px-2.5 text-[10px] font-semibold text-theme-text hover:bg-theme-text/5 disabled:opacity-60"
                  >
                    Aplicar
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(loadingPlanId) || isReadOnly}
                    onClick={clearSelectedRates}
                    className="h-8 rounded-md border border-theme-border bg-theme-surface px-2.5 text-[10px] font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text disabled:opacity-60"
                  >
                    Dejar sin regla
                  </button>
                </div>
              </div>
              {Object.keys(conflicts).length > 0 && (
                <div className="border-b border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700">
                  <p className="font-semibold">
                    Familias ocupadas por otro plan en esta vigencia
                  </p>
                  {Object.values(conflicts).map((conflict) => (
                    <p
                      key={conflict.family_bsale_product_type_id}
                      className="mt-1"
                    >
                      {conflict.family_name}: Ya configurada en:{" "}
                      {conflict.conflict_plan_code} · Vigencia:{" "}
                      {formatDate(conflict.conflict_valid_from)}–
                      {formatDate(conflict.conflict_valid_to)}
                    </p>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-[28px_1fr_150px] border-b border-theme-border bg-theme-text/[0.02] px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                <span />
                <span>Familia</span>
                <span>Porcentaje</span>
              </div>
              {families.length === 0 ? (
                <p className="p-4 text-xs text-theme-text-muted">
                  Este Supplier no tiene Familias disponibles.
                </p>
              ) : (
                families.map((family) => (
                  <div
                    key={family.family_bsale_product_type_id}
                    className="grid grid-cols-[28px_1fr_150px] items-center gap-3 border-b border-theme-border/60 px-3 py-2 last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      disabled={
                        Boolean(loadingPlanId) ||
                        isReadOnly ||
                        Boolean(conflicts[family.family_bsale_product_type_id])
                      }
                      checked={selectedFamilyIds.has(
                        family.family_bsale_product_type_id,
                      )}
                      onChange={(event) =>
                        setSelectedFamilyIds((current) => {
                          const next = new Set(current);
                          if (event.target.checked)
                            next.add(family.family_bsale_product_type_id);
                          else next.delete(family.family_bsale_product_type_id);
                          return next;
                        })
                      }
                    />
                    <div>
                      <p className="text-xs font-semibold text-theme-text">
                        {family.family_name}
                      </p>
                      <p className="text-[10px] text-theme-text-muted">
                        {conflicts[family.family_bsale_product_type_id]
                          ? `Ya configurada en: ${conflicts[family.family_bsale_product_type_id].conflict_plan_code}`
                          : plan?.rates.some(
                                (rate) =>
                                  rate.family_bsale_product_type_id ===
                                  family.family_bsale_product_type_id,
                              )
                            ? "En este plan"
                            : `${family.resolved_lines} líneas disponibles`}
                      </p>
                    </div>
                    <div className="relative">
                      <input
                        value={rates[family.family_bsale_product_type_id] ?? ""}
                        disabled={
                          Boolean(loadingPlanId) ||
                          isReadOnly ||
                          Boolean(
                            conflicts[family.family_bsale_product_type_id],
                          )
                        }
                        onChange={(event) =>
                          setRates((current) => ({
                            ...current,
                            [family.family_bsale_product_type_id]:
                              event.target.value,
                          }))
                        }
                        onBlur={(event) =>
                          setRates((current) => ({
                            ...current,
                            [family.family_bsale_product_type_id]:
                              normalizePercentageInput(event.target.value),
                          }))
                        }
                        placeholder="Sin regla"
                        inputMode="decimal"
                        className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-2 pr-7 text-right text-xs text-theme-text disabled:opacity-60"
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-theme-text-muted">
                        %
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="mt-5 flex items-center justify-between gap-3">
            {!isNew && !isReadOnly && plan?.active === true && plan.status === "ACTIVE" ? (
              <button
                type="button"
                onClick={() => setConfirmRemoval(true)}
                disabled={saving || removing || Boolean(loadingPlanId)}
                className="h-8 rounded-lg border border-red-500/30 px-3 text-xs font-semibold text-red-600 hover:bg-red-500/5 disabled:cursor-wait disabled:opacity-60"
              >
                {removing ? "Eliminando..." : "Eliminar regla"}
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                saving ||
                removing ||
                Boolean(loadingPlanId) ||
                !supplierId ||
                !planCode.trim() ||
                Boolean(baseConflict) ||
                isReadOnly ||
                (!isNew && plan?.issued_usage_known === false)
              }
              className="h-9 rounded-lg bg-theme-accent px-4 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? "Guardando..." : saveLabel}
            </button>
          </div>
          {confirmRemoval && plan && !isReadOnly && !isNew && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="remove-plan-dialog-title"
                className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl"
              >
                <h3
                  id="remove-plan-dialog-title"
                  className="text-sm font-bold text-theme-text"
                >
                  Eliminar regla
                </h3>
                <p className="mt-2 text-xs leading-5 text-theme-text-muted">
                  ¿Seguro que deseas eliminar esta regla? Si nunca ha sido
                  utilizada se eliminará definitivamente. Si tiene historial,
                  será archivada para conservar las liquidaciones anteriores.
                </p>
                <div className="mt-4 rounded-lg border border-theme-border bg-theme-text/[0.03] p-3 text-xs text-theme-text">
                  <p className="font-semibold">{plan.plan_code}</p>
                  <p className="mt-1 text-theme-text-muted">
                    {plan.supplier_name ?? "Proveedor REAL sin nombre"} ·{" "}
                    {plan.plan_type === "FAMILY_FIXED_PERCENT"
                      ? "Por Familia"
                      : "Meta de ventas"}
                  </p>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmRemoval(false)}
                    disabled={removing}
                    className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-60"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => void executeRemoval()}
                    disabled={removing}
                    className="rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-60"
                  >
                    {removing ? "Eliminando..." : "Eliminar regla"}
                  </button>
                </div>
              </div>
            </div>
          )}
          {confirmVersioning && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="versioning-dialog-title"
                className="w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                  <div>
                    <h3
                      id="versioning-dialog-title"
                      className="text-sm font-bold text-theme-text"
                    >
                      Actualizar regla utilizada
                    </h3>
                    <p className="mt-2 text-xs leading-5 text-theme-text-muted">
                      Esta regla ya fue utilizada en una liquidación anterior.
                      Al guardar los cambios, la configuración actual será
                      archivada y la nueva versión quedará vigente. Los
                      borradores y pagos anteriores conservarán su regla
                      original.
                    </p>
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmVersioning(false)}
                    className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted hover:text-theme-text"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => void executeSave()}
                    disabled={saving}
                    className="rounded-lg bg-theme-accent px-3 py-2 text-xs font-bold text-white disabled:opacity-60"
                  >
                    {saving ? "Guardando..." : "Archivar y actualizar"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TargetTierEditorUx({
  tiers,
  disabled,
  onChange,
}: {
  tiers: ComisionesV2Tier[];
  disabled: boolean;
  onChange: (tiers: ComisionesV2Tier[]) => void;
}) {
  void TargetTierEditor;
  const [percentageInputs, setPercentageInputs] = useState<
    Record<number, string>
  >(() =>
    Object.fromEntries(
      tiers.map((tier) => [
        tier.tier_order,
        normalizePercentageInput(tier.percentage),
      ]),
    ),
  );

  function commitPercentage(tierOrder: number) {
    const text = percentageInputs[tierOrder] ?? "";
    const numeric = percentageNumber(text);
    if (numeric == null) return;
    onChange(
      tiers.map((tier) =>
        tier.tier_order === tierOrder ? { ...tier, percentage: numeric } : tier,
      ),
    );
    setPercentageInputs((current) => ({
      ...current,
      [tierOrder]: normalizePercentageInput(numeric),
    }));
  }

  function addTier() {
    const lastTier = tiers.at(-1);
    if (!lastTier || lastTier.upper_bound == null) return;
    const nextTier = {
      tier_order: tiers.length + 1,
      lower_bound: lastTier.upper_bound + 1,
      upper_bound: null,
      percentage: 0,
    };
    setPercentageInputs((current) => ({
      ...current,
      [nextTier.tier_order]: normalizePercentageInput(nextTier.percentage),
    }));
    onChange([...tiers, nextTier]);
  }

  function updateUpper(index: number, value: string) {
    const upperBound =
      value.trim() === "" ? null : Number(value.replace(/\D/g, "")) || 0;
    onChange(
      normalizeTierBounds(
        tiers.map((tier, tierIndex) =>
          tierIndex === index ? { ...tier, upper_bound: upperBound } : tier,
        ),
      ),
    );
  }

  function removeTier(index: number) {
    const nextTiers = normalizeTierBounds(
      tiers
        .filter((_, itemIndex) => itemIndex !== index)
        .map((item, itemIndex) => ({ ...item, tier_order: itemIndex + 1 })),
    );
    setPercentageInputs(
      Object.fromEntries(
        nextTiers.map((tier) => [
          tier.tier_order,
          normalizePercentageInput(tier.percentage),
        ]),
      ),
    );
    onChange(nextTiers);
  }

  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-theme-border">
      <div className="flex items-center justify-between border-b border-theme-border bg-theme-text/[0.03] px-3 py-2">
        <div>
          <p className="text-xs font-bold text-theme-text">
            Tramos de meta de ventas
          </p>
          <p className="text-[10px] text-theme-text-muted">
            Venta neta acumulada por Proveedor y período.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || tiers.at(-1)?.upper_bound == null}
          onClick={addTier}
          className="rounded-md border border-theme-border px-2 py-1 text-[10px] font-semibold text-theme-text disabled:opacity-60"
        >
          Agregar tramo
        </button>
      </div>
      <div className="grid grid-cols-[1fr_1fr_120px_32px] gap-2 border-b border-theme-border px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
        <span>Desde (CLP)</span>
        <span>Hasta (CLP)</span>
        <span>%</span>
        <span />
      </div>
      {tiers.map((tier, index) => (
        <div
          key={tier.tier_order}
          className="grid grid-cols-[1fr_1fr_120px_32px] items-center gap-2 border-b border-theme-border/50 px-3 py-2 last:border-0"
        >
          <input
            value={amountLabel(index === 0 ? 0 : tier.lower_bound)}
            disabled
            className="h-8 rounded-md border border-theme-border bg-theme-surface px-2 text-right text-xs text-theme-text disabled:opacity-60"
            inputMode="numeric"
            aria-label={`Desde tramo ${index + 1}`}
          />
          <input
            value={amountLabel(tier.upper_bound)}
            disabled={disabled}
            placeholder="Sin límite"
            onChange={(event) => updateUpper(index, event.target.value)}
            className="h-8 rounded-md border border-theme-border bg-theme-surface px-2 text-right text-xs text-theme-text disabled:opacity-60"
            inputMode="numeric"
            aria-label={`Hasta tramo ${index + 1}`}
          />
          <input
            value={
              percentageInputs[tier.tier_order] ??
              normalizePercentageInput(tier.percentage)
            }
            disabled={disabled}
            onChange={(event) =>
              setPercentageInputs((current) => ({
                ...current,
                [tier.tier_order]: event.target.value,
              }))
            }
            onBlur={() => commitPercentage(tier.tier_order)}
            className="h-8 rounded-md border border-theme-border bg-theme-surface px-2 text-right text-xs text-theme-text disabled:opacity-60"
            inputMode="decimal"
          />
          <button
            type="button"
            disabled={disabled || tiers.length === 1}
            onClick={() => removeTier(index)}
            className="text-xs text-red-600 disabled:opacity-30"
            aria-label="Eliminar tramo"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function TargetTierEditor({
  tiers,
  disabled,
  onChange,
}: {
  tiers: ComisionesV2Tier[];
  disabled: boolean;
  onChange: (tiers: ComisionesV2Tier[]) => void;
}) {
  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-theme-border">
      <div className="flex items-center justify-between border-b border-theme-border bg-theme-text/[0.03] px-3 py-2">
        <div>
          <p className="text-xs font-bold text-theme-text">
            Tramos de meta de ventas
          </p>
          <p className="text-[10px] text-theme-text-muted">
            Venta neta acumulada por Supplier y período.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...tiers,
              {
                tier_order: tiers.length + 1,
                lower_bound: tiers.at(-1)?.upper_bound ?? 0,
                upper_bound: null,
                percentage: 0,
              },
            ])
          }
          className="rounded-md border border-theme-border px-2 py-1 text-[10px] font-semibold text-theme-text disabled:opacity-60"
        >
          Agregar tramo
        </button>
      </div>
      <div className="grid grid-cols-[1fr_1fr_120px_32px] gap-2 border-b border-theme-border px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
        <span>Desde (CLP)</span>
        <span>Hasta (CLP)</span>
        <span>%</span>
        <span />
      </div>
      {tiers.map((tier, index) => (
        <div
          key={tier.tier_order}
          className="grid grid-cols-[1fr_1fr_120px_32px] items-center gap-2 border-b border-theme-border/50 px-3 py-2 last:border-0"
        >
          <input
            value={amountLabel(tier.lower_bound)}
            disabled={disabled || index !== 0}
            onChange={(event) =>
              onChange(
                tiers.map((item, itemIndex) =>
                  itemIndex === index
                    ? {
                        ...item,
                        lower_bound:
                          Number(event.target.value.replace(/\D/g, "")) || 0,
                      }
                    : item,
                ),
              )
            }
            className="h-8 rounded-md border border-theme-border bg-theme-surface px-2 text-right text-xs text-theme-text disabled:opacity-60"
            inputMode="numeric"
          />
          <input
            value={amountLabel(tier.upper_bound)}
            disabled={disabled}
            placeholder="Sin límite"
            onChange={(event) =>
              onChange(
                tiers.map((item, itemIndex) =>
                  itemIndex === index
                    ? {
                        ...item,
                        upper_bound:
                          event.target.value.trim() === ""
                            ? null
                            : Number(event.target.value.replace(/\D/g, "")) ||
                              0,
                      }
                    : item,
                ),
              )
            }
            className="h-8 rounded-md border border-theme-border bg-theme-surface px-2 text-right text-xs text-theme-text disabled:opacity-60"
            inputMode="numeric"
          />
          <input
            value={normalizePercentageInput(String(tier.percentage))}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                tiers.map((item, itemIndex) =>
                  itemIndex === index
                    ? {
                        ...item,
                        percentage:
                          Number(event.target.value.replace(",", ".")) || 0,
                      }
                    : item,
                ),
              )
            }
            className="h-8 rounded-md border border-theme-border bg-theme-surface px-2 text-right text-xs text-theme-text disabled:opacity-60"
            inputMode="decimal"
          />
          <button
            type="button"
            disabled={disabled || tiers.length === 1}
            onClick={() =>
              onChange(
                tiers
                  .filter((_, itemIndex) => itemIndex !== index)
                  .map((item, itemIndex) => ({
                    ...item,
                    tier_order: itemIndex + 1,
                  })),
              )
            }
            className="text-xs text-red-600 disabled:opacity-30"
            aria-label="Eliminar tramo"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function planState(plan: ComisionesV2FamilyPlanListItem, today: string) {
  if (today < plan.valid_from) return { label: "Programado", order: 1 };
  if (!plan.valid_to || today <= plan.valid_to)
    return { label: "Vigente", order: 0 };
  return { label: "Finalizado", order: 2 };
}

function Summary({
  label,
  value,
  secondary,
  tone,
  wide = false,
  active = false,
  onClick,
}: {
  label: string;
  value: string | number;
  secondary?: string;
  tone?: "green" | "amber" | "red";
  wide?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const className = `min-w-0 rounded-lg border px-2.5 py-1.5 text-left ${wide ? "xl:px-3" : ""} ${active ? "ring-2 ring-theme-accent/35" : ""} ${tone === "green" ? "border-emerald-500/20 bg-emerald-500/5" : tone === "amber" ? "border-amber-500/20 bg-amber-500/5" : tone === "red" ? "border-red-500/20 bg-red-500/5" : "border-theme-border/70 bg-theme-surface"} ${onClick ? "cursor-pointer transition-colors hover:bg-theme-text/5" : ""}`;
  const content = (
    <>
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted/65">
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-bold tabular-nums text-theme-text">
        {value}
      </div>
      {secondary && (
        <div className="mt-0.5 truncate text-[10px] tabular-nums text-theme-text-muted">
          {secondary}
        </div>
      )}
    </>
  );
  return onClick ? (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={className}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function SellerProfilesTable({
  profiles,
  loading,
  error,
}: {
  profiles: ComisionesV2SellerProfile[];
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <LoadingState />;
  if (error)
    return (
      <div className="m-4 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-semibold">
            No se pudieron cargar los vendedores V2
          </p>
          <p className="mt-1 text-xs">{error}</p>
        </div>
      </div>
    );
  if (profiles.length === 0) return <EmptyState hasQuery />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full min-w-[620px] table-fixed text-xs">
        <thead className="sticky top-0 z-10 bg-theme-surface shadow-[0_1px_0_var(--theme-border)]">
          <tr className="h-10 text-left text-[11px] font-bold uppercase tracking-wide text-theme-text-muted">
            <th className="px-4">Vendedor</th>
            <th className="w-36 px-4">ID Bsale</th>
            <th className="w-40 px-4">Comisionable</th>
            <th className="w-36 px-4">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-theme-border/50">
          {profiles.map((profile) => (
            <tr
              key={profile.seller_bsale_id}
              className="hover:bg-theme-text/[0.025]"
            >
              <td className="px-4 py-3 font-semibold text-theme-text">
                {profile.seller_name}
              </td>
              <td className="px-4 py-3 font-mono text-theme-text-muted">
                {profile.seller_bsale_id}
              </td>
              <td className="px-4 py-3">
                <Badge
                  value={profile.is_commissionable ? "Sí" : "No"}
                  tone={profile.is_commissionable ? "green" : "muted"}
                />
              </td>
              <td className="px-4 py-3">
                <Badge
                  value={profile.active ? "Activo" : "Inactivo"}
                  tone={profile.active ? "green" : "muted"}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({ value, tone }: { value: string; tone: "green" | "muted" }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${tone === "green" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-500" : "border-theme-border bg-theme-text/[0.04] text-theme-text-muted"}`}
    >
      {value}
    </span>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-theme-text-muted">
      <Loader2 className="h-4 w-4 animate-spin" /> Consultando líneas V2...
    </div>
  );
}

function EmptyState({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-theme-text-muted">
      <ClipboardList className="h-8 w-8 opacity-40" />
      <p className="text-sm font-semibold">
        {hasQuery
          ? "No hay líneas para estos filtros."
          : "Consulta un período de emisión."}
      </p>
      <p className="max-w-md text-xs">
        Las líneas no resueltas permanecen visibles cuando existen en el período
        seleccionado.
      </p>
    </div>
  );
}
