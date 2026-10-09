"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, FileText, Info } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  FinanceReceivablesAnalysis,
  FinanceReceivablesEvent,
  FinanceReceivablesResponse,
} from "@/lib/control-financiero/finance-api";
import { FINANCE_RECEIVABLES_SNAPSHOT_SOURCE } from "@/lib/control-financiero/types";
import { ReceivablesAnalysisCache } from "@/lib/control-financiero/receivables-analysis-cache";
import {
  findPreviousClosedOverdue,
  receivablesEvolutionRate,
} from "@/lib/control-financiero/receivables-metrics";

// ─── Constantes ──────────────────────────────────────────────────────────────

const MONTHS = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

const MONTHS_FULL = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// ─── Formatters ───────────────────────────────────────────────────────────────

const money = (value: string | null) =>
  value === null
    ? "—"
    : `$${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(
        Number(value),
      )}`;

const moneyCompact = (value: number): string => {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1).replace(".", ",")}B`;
  if (value >= 1_000_000) return `$${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${value}`;
};

const dateLabel = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("es-CL", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(new Date(`${value}T12:00:00`))
    : "—";

const dateLabelLong = (value: string | null): string => {
  if (!value) return "—";
  const d = new Date(`${value}T12:00:00`);
  const day = d.getDate();
  const month = MONTHS_FULL[d.getMonth()];
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
};

const snapshotDateTimeLabel = (value: string | undefined): string | null => {
  if (!value) return null;
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Santiago",
  }).format(new Date(value));
};

// ─── Gráfico profesional ──────────────────────────────────────────────────────

const CHART_PADDING = { top: 16, right: 12, bottom: 36, left: 58 };
const CHART_HEIGHT_INNER = 200; // px del área de datos
const Y_TICKS = 5;

function computeYTicks(maxVal: number): number[] {
  if (maxVal === 0) return [0];
  // Encontrar una escala limpia (múltiplos de 5M, 10M, 1M, 500K…)
  const raw = maxVal / (Y_TICKS - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 2.5, 5, 10].map((f) => f * magnitude);
  const step = candidates.find((c) => c >= raw) ?? candidates[candidates.length - 1];
  const ticks: number[] = [];
  for (let i = 0; i < Y_TICKS; i++) ticks.push(i * step);
  return ticks;
}

function LineChart({ data }: { data: FinanceReceivablesAnalysis["daily"] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [svgWidth, setSvgWidth] = useState(600);

  // Ancho responsive
  useEffect(() => {
    if (!svgRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setSvgWidth(w);
    });
    obs.observe(svgRef.current);
    return () => obs.disconnect();
  }, []);

  const n = data.length;
  if (n === 0) return null;

  const innerW = svgWidth - CHART_PADDING.left - CHART_PADDING.right;
  const innerH = CHART_HEIGHT_INNER;
  const totalH = innerH + CHART_PADDING.top + CHART_PADDING.bottom;

  const maxVal = Math.max(
    ...data.flatMap((d) => [Number(d.receivable_amount), Number(d.overdue_amount)]),
    1,
  );
  const yTicks = computeYTicks(maxVal);
  const yMax = yTicks[yTicks.length - 1];

  // Coordenadas de puntos
  const xOf = (i: number) =>
    n === 1 ? innerW / 2 : (i / (n - 1)) * innerW;
  const yOf = (val: number) =>
    innerH - (val / yMax) * innerH;

  const polylinePoints = (key: "receivable_amount" | "overdue_amount") =>
    data.map((d, i) => `${xOf(i).toFixed(2)},${yOf(Number(d[key])).toFixed(2)}`).join(" ");

  const hovered = hoveredIndex === null ? null : data[hoveredIndex];
  const hoveredX = hoveredIndex === null ? 0 : xOf(hoveredIndex);

  // Labels del eje X: mostrar el número del día
  // Para > 20 días mostramos cada 5; para <= 20 mostramos todos
  const xLabelStep = n > 20 ? 5 : 1;

  return (
    <div className="border-b border-[#D1C7BD] px-4 py-4 pb-2">
      {/* Leyenda */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex gap-5 text-[11px]">
          <span className="flex items-center gap-1.5 text-[#322D29]">
            <svg width="22" height="3" aria-hidden>
              <line x1="0" y1="1.5" x2="22" y2="1.5" stroke="#72383D" strokeWidth="2" strokeLinecap="round" />
              <circle cx="11" cy="1.5" r="2.5" fill="#72383D" />
            </svg>
            CxC pendiente
          </span>
          <span className="flex items-center gap-1.5 text-[#322D29]/65">
            <svg width="22" height="3" aria-hidden>
              <line x1="0" y1="1.5" x2="22" y2="1.5" stroke="#C45C5C" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="3 2" />
              <circle cx="11" cy="1.5" r="2" fill="#C45C5C" />
            </svg>
            CxC vencida
          </span>
        </div>
        <span className="text-[10px] text-[#322D29]/40">{n} días</span>
      </div>

      {/* SVG del gráfico */}
      <div className="relative">
        <svg
          ref={svgRef}
          width="100%"
          height={totalH}
          style={{ display: "block", overflow: "visible" }}
          role="img"
          aria-label="Evolución diaria de cuentas por cobrar"
          onMouseLeave={() => setHoveredIndex(null)}
        >
          <g transform={`translate(${CHART_PADDING.left},${CHART_PADDING.top})`}>
            {/* Grid horizontal */}
            {yTicks.map((tick) => {
              const y = yOf(tick);
              return (
                <g key={tick}>
                  <line
                    x1={0}
                    y1={y}
                    x2={innerW}
                    y2={y}
                    stroke="#E5DDD5"
                    strokeWidth={tick === 0 ? 1 : 0.6}
                  />
                  {/* Label eje Y */}
                  <text
                    x={-8}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={9}
                    fill="#322D29"
                    opacity={0.45}
                    fontFamily="inherit"
                  >
                    {moneyCompact(tick)}
                  </text>
                </g>
              );
            })}

            {/* Línea vertical en hover */}
            {hoveredIndex !== null && (
              <line
                x1={hoveredX}
                y1={0}
                x2={hoveredX}
                y2={innerH}
                stroke="#AC9C8D"
                strokeWidth={0.8}
                strokeDasharray="3 2"
              />
            )}

            {/* Serie CxC — principal */}
            <polyline
              points={polylinePoints("receivable_amount")}
              fill="none"
              stroke="#72383D"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Serie Vencida — secundaria */}
            <polyline
              points={polylinePoints("overdue_amount")}
              fill="none"
              stroke="#C45C5C"
              strokeWidth={1.1}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="3 2"
            />

            {/* Puntos permanentes + zonas de hover */}
            {data.map((item, index) => {
              const x = xOf(index);
              const yRec = yOf(Number(item.receivable_amount));
              const yOvd = yOf(Number(item.overdue_amount));
              const active = hoveredIndex === index;
              return (
                <g
                  key={item.date}
                  onMouseEnter={() => setHoveredIndex(index)}
                  style={{ cursor: "crosshair" }}
                >
                  {/* Zona de hit */}
                  <rect
                    x={x - (n > 1 ? innerW / (2 * (n - 1)) : innerW / 2)}
                    y={0}
                    width={n > 1 ? innerW / (n - 1) : innerW}
                    height={innerH}
                    fill="transparent"
                  />
                  {/* Punto CxC */}
                  <circle
                    cx={x}
                    cy={yRec}
                    r={active ? 3.5 : 2.2}
                    fill="#72383D"
                    stroke="#FCFBF9"
                    strokeWidth={active ? 1.2 : 0.8}
                    style={{ transition: "r 80ms ease" }}
                  />
                  {/* Punto Vencida */}
                  <circle
                    cx={x}
                    cy={yOvd}
                    r={active ? 3 : 1.8}
                    fill="#C45C5C"
                    stroke="#FCFBF9"
                    strokeWidth={active ? 1 : 0.7}
                    style={{ transition: "r 80ms ease" }}
                  />
                </g>
              );
            })}

            {/* Labels eje X */}
            {data.map((item, index) => {
              if (index % xLabelStep !== 0 && index !== n - 1) return null;
              const x = xOf(index);
              const day = item.date.slice(8, 10);
              return (
                <text
                  key={item.date}
                  x={x}
                  y={innerH + 14}
                  textAnchor="middle"
                  fontSize={8.5}
                  fill="#322D29"
                  opacity={0.45}
                  fontFamily="inherit"
                >
                  {day}
                </text>
              );
            })}
          </g>
        </svg>

        {/* Tooltip */}
        {hovered && (
          <div
            className="pointer-events-none absolute z-20 min-w-[210px] rounded-lg border border-[#D1C7BD] bg-white/96 px-3.5 py-2.5 text-[11px] shadow-xl backdrop-blur-sm"
            style={{
              top: CHART_PADDING.top,
              left: CHART_PADDING.left + hoveredX,
              transform:
                hoveredX > innerW * 0.72
                  ? "translateX(-100%) translateX(-8px)"
                  : hoveredX < innerW * 0.28
                    ? "translateX(8px)"
                    : "translateX(-50%)",
            }}
          >
            <p className="mb-2 font-semibold text-[#322D29]">
              {dateLabelLong(hovered.date)}
            </p>
            <div className="space-y-1.5">
              <div className="flex justify-between gap-6">
                <span className="flex items-center gap-1.5 text-[#322D29]/60">
                  <span className="inline-block h-2 w-2 rounded-full bg-[#72383D]" />
                  CxC pendiente
                </span>
                <strong className="tabular-nums text-[#72383D]">
                  {money(hovered.receivable_amount)}
                </strong>
              </div>
              <div className="flex justify-between gap-6">
                <span className="flex items-center gap-1.5 text-[#322D29]/60">
                  <span className="inline-block h-2 w-2 rounded-full bg-[#C45C5C]" />
                  CxC vencida
                </span>
                <strong className="tabular-nums text-[#C45C5C]">
                  {money(hovered.overdue_amount)}
                </strong>
              </div>
              {hovered.pending_documents > 0 && (
                <div className="flex justify-between gap-6 border-t border-[#E5DDD5] pt-1.5">
                  <span className="text-[#322D29]/50">Documentos pend.</span>
                  <span className="tabular-nums text-[#322D29]/70">
                    {hovered.pending_documents.toLocaleString("es-CL")}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Conciliación ─────────────────────────────────────────────────────────────

function EventList({ events }: { events: FinanceReceivablesEvent[] }) {
  return (
    <div className="mt-4 border-t border-[#D1C7BD] pt-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#AC9C8D]">
        Conciliación
      </p>
      {events.length === 0 ? (
        <p className="mt-2 text-xs text-[#322D29]/55">
          Sin pagos ni notas de crédito aplicados al cierre.
        </p>
      ) : (
        <div className="mt-2 divide-y divide-[#D1C7BD]/70">
          {events.map((event, index) => (
            <div
              key={`${event.type}-${event.date}-${index}`}
              className="flex items-center justify-between gap-3 py-2 text-xs"
            >
              <span>
                {event.type === "PAYMENT" ? "Pago" : "Nota de crédito"} ·{" "}
                {dateLabel(event.date)}
                {event.payment_type ? ` · ${event.payment_type}` : ""}
              </span>
              <strong className="tabular-nums">{money(event.amount)}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Vista previa PDF ─────────────────────────────────────────────────────────

type PdfViewState =
  | { state: "loading" }
  | { state: "ready"; proxyUrl: string; downloadUrl: string }
  | { state: "error"; message: string }
  | { state: "unavailable" };

function PdfViewer({
  document,
  companyId,
  onBack,
}: {
  document: FinanceReceivablesAnalysis["documents"][number];
  companyId: string;
  onBack: () => void;
}) {
  /**
   * Lógica de estados:
   *
   * - Sin url_pdf → "unavailable" inmediatamente.
   * - Con url_pdf → validamos el GET real del proxy antes de montar el iframe.
   *   Así una respuesta de error no se entrega al visor nativo de Chrome.
   *
    * No usamos HEAD: validamos el GET real y sus primeros bytes.
   */

  // Construir URLs de proxy de forma determinista — sin efecto asíncrono
  const proxyData = (() => {
    if (!document.url_pdf) return null;
    const params = new URLSearchParams({
      url: document.url_pdf,
      company: companyId,
      folio: String(document.folio ?? document.document_id),
      type: document.document_type_name ?? "documento",
    });
    const proxyUrl = `/api/control-financiero/receivables-pdf?${params.toString()}`;
    const downloadUrl = `${proxyUrl}&download=1`;
    return { proxyUrl, downloadUrl };
  })();

  const [iframeState, setIframeState] = useState<"loading" | "ready" | "error">("loading");
  const [validatedProxyUrl, setValidatedProxyUrl] = useState<string | null>(null);
  const proxyUrl = proxyData?.proxyUrl;

  useEffect(() => {
    if (!proxyUrl) return;

    const controller = new AbortController();
    void fetch(proxyUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf")) {
          throw new Error("La respuesta no es un PDF.");
        }
        const bytes = await response.arrayBuffer();
        if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
          throw new Error("El contenido no comienza con %PDF-.");
        }
        setValidatedProxyUrl(proxyUrl);
        setIframeState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setIframeState("error");
      });

    return () => controller.abort();
  }, [proxyUrl]);

  const docLabel = `${document.document_type_name ?? "Documento"} #${document.folio ?? document.document_id}`;

  // Estado efectivo del visor
  const viewState: PdfViewState = !proxyData
    ? { state: "unavailable" }
    : iframeState === "error"
      ? { state: "error", message: "No fue posible cargar la vista previa del documento." }
       : iframeState === "ready" && validatedProxyUrl === proxyUrl
        ? { state: "ready", proxyUrl: proxyData.proxyUrl, downloadUrl: proxyData.downloadUrl }
        : { state: "loading" };

  const handleDownload = () => {
    if (!proxyData) return;
    const a = window.document.createElement("a");
    a.href = proxyData.downloadUrl;
    const safeFolio = String(document.folio ?? document.document_id).replace(/[^a-zA-Z0-9\-_]/g, "");
    const rawType = (document.document_type_name ?? "documento").toLowerCase();
    const safeType = (rawType.includes("factura") ? "factura" : rawType)
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9\-]/g, "")
      .slice(0, 32);
    a.download = `${safeType}-${safeFolio}.pdf`;
    a.click();
  };

  return (
    <div className="flex h-full flex-col">
      {/* Encabezado */}
      <div className="shrink-0 border-b border-[#D1C7BD] px-5 py-3">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 flex items-center gap-1 text-xs font-semibold text-[#72383D] hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Volver al detalle de factura
        </button>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-[#72383D]" />
            <h3 className="text-sm font-semibold text-[#322D29]">{docLabel}</h3>
          </div>
          {/* Descargar disponible en cuanto tengamos URL proxy (sin esperar onLoad) */}
          {proxyData && (
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded border border-[#D1C7BD] bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#322D29] hover:bg-[#F5F0EA] active:bg-[#EDE5DB]"
            >
              <Download className="h-3.5 w-3.5" />
              Descargar PDF
            </button>
          )}
        </div>
      </div>

      {/* Contenido */}
      <div className="relative min-h-0 flex-1 bg-[#F5F0EA]">
        {/* Estado "sin pdf" */}
        {viewState.state === "unavailable" && (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <div>
              <FileText className="mx-auto mb-3 h-8 w-8 text-[#AC9C8D]" />
              <p className="text-sm font-semibold text-[#322D29]">PDF no disponible</p>
              <p className="mt-1 text-xs text-[#322D29]/55">
                Este documento no tiene un PDF asociado.
              </p>
            </div>
          </div>
        )}

        {/* Estado "error" */}
        {viewState.state === "error" && (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <div>
              <FileText className="mx-auto mb-3 h-8 w-8 text-[#AC9C8D]" />
              <p className="text-sm font-semibold text-[#72383D]">
                No fue posible cargar la vista previa del documento.
              </p>
              <p className="mt-1 text-xs text-[#322D29]/55">
                Puedes intentar descargar el PDF directamente.
              </p>
              <button
                type="button"
                onClick={onBack}
                className="mt-4 text-xs font-semibold text-[#72383D] hover:underline"
              >
                ← Volver al detalle
              </button>
            </div>
          </div>
        )}

        {/* iframe: visible siempre que tengamos URL (overlay de loading encima mientras carga) */}
        {proxyData && viewState.state !== "error" && (
          <>
            {/* Overlay loading — se oculta cuando iframe dispara onLoad */}
            {iframeState === "loading" && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#F5F0EA]">
                <p className="text-sm text-[#322D29]/55">Cargando documento…</p>
              </div>
            )}
            <iframe
              key={proxyData.proxyUrl}
              src={proxyData.proxyUrl}
              title={docLabel}
              className="h-full w-full border-0"
              style={{ minHeight: 480 }}
              onLoad={() => setIframeState("ready")}
              onError={() => setIframeState("error")}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ─── Métricas resumen ─────────────────────────────────────────────────────────

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#EFE9E1] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#AC9C8D]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}

// ─── Row de tabla ─────────────────────────────────────────────────────────────

function Row({
  label,
  values,
  actual,
  onOpen,
}: {
  label: string;
  values: Array<string | null>;
  actual: string;
  onOpen: (period: number) => void;
}) {
  return (
    <tr>
      <th className="bg-white px-4 py-2 text-left font-semibold">{label}</th>
      {values.map((value, index) => (
        <td
          key={`${label}-${index}`}
          onDoubleClick={() => value !== null && onOpen(index + 1)}
          title={
            value !== null ? "Doble clic para analizar composición" : undefined
          }
          className={`px-2.5 py-2 text-right tabular-nums ${value !== null ? "cursor-pointer hover:bg-[#F5F0EA]" : ""}`}
        >
          {money(value)}
        </td>
      ))}
      <td
        onDoubleClick={() => onOpen(0)}
        title="Doble clic para analizar composición"
        className="cursor-pointer border-l-2 border-[#AC9C8D] bg-[#FAF7F3] px-2.5 py-2 text-right font-semibold tabular-nums hover:bg-[#F1E4DE]"
      >
        {money(actual)}
      </td>
    </tr>
  );
}

function formatEvolution(value: number | null): string {
  if (value === null) return "—";
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  const formatted = new Intl.NumberFormat("es-CL", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(normalized);
  return `${normalized > 0 ? "+" : ""}${formatted}%`;
}

function EvolutionRow({
  values,
  actual,
}: {
  values: Array<number | null>;
  actual: number | null;
}) {
  const colorFor = (value: number | null) =>
    value === null ? "text-[#322D29]/45" : value >= 0 ? "text-[#55705B]" : "text-[#8A4B4B]";

  return (
    <tr className="text-[11px]">
      <th className="bg-white px-4 py-2 text-left font-medium text-[#322D29]/65">
        Evolución cartera vencida vs mes anterior
      </th>
      {values.map((value, index) => (
        <td key={`evolution-${index}`} className={`px-2.5 py-2 text-right tabular-nums ${colorFor(value)}`}>
          {formatEvolution(value)}
        </td>
      ))}
      <td className={`border-l-2 border-[#AC9C8D] bg-[#FAF7F3] px-2.5 py-2 text-right font-medium tabular-nums ${colorFor(actual)}`}>
        {formatEvolution(actual)}
      </td>
    </tr>
  );
}

// ─── Singleton cache de sesión ────────────────────────────────────────────────
// Un único cache por sesión de navegador (vive mientras el componente esté montado).
const sessionCache = new ReceivablesAnalysisCache();

// ─── Sección principal ────────────────────────────────────────────────────────

export function ReceivablesSection({
  data,
  year,
}: {
  data: FinanceReceivablesResponse;
  year: number;
}) {
  const [open, setOpen] = useState(false);
  const [analysis, setAnalysis] = useState<FinanceReceivablesAnalysis | null>(null);
  const [analysisKey, setAnalysisKey] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<number | null>(null);
  const [selectionContextKey, setSelectionContextKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  // Vistas internas del Sheet: "list" | "document" | "pdf"
  type SheetView = "list" | "document" | "pdf";
  const [view, setView] = useState<SheetView>("list");
  const [selectedDocument, setSelectedDocument] = useState<
    FinanceReceivablesAnalysis["documents"][number] | null
  >(null);

  // company_id viene del payload que ya tenemos
  const companyId = data.company_id;
  const currentContextKey = `${companyId}|${year}`;
  const isSnapshot = data.actual.receivables_source === FINANCE_RECEIVABLES_SNAPSHOT_SOURCE;
  const snapshotDateTime = isSnapshot ? snapshotDateTimeLabel(data.actual.snapshot_at) : null;
  const overdueEvolution = data.months.map((month, index) =>
    index === 0
      ? null
      : receivablesEvolutionRate(data.months[index - 1].overdue_amount, month.overdue_amount),
  );
  // ACTUAL is provisional: compare it with the latest available closed month,
  // never with the open month reconstructed from the current effective date.
  const actualCutoff = data.actual.snapshot_date ?? data.effective_date;
  const previousClosedOverdue = findPreviousClosedOverdue(data.months, actualCutoff);
  const actualEvolution = receivablesEvolutionRate(
    previousClosedOverdue,
    data.actual.overdue_amount,
  );

  // ── Carga de análisis con cache ─────────────────────────────────────────────
  const loadAnalysis = useCallback(
    async (period: number): Promise<FinanceReceivablesAnalysis> => {
      const cacheKey = { companyId, year, period };
      return sessionCache.load(cacheKey, async () => {
        const response = await fetch(
          `/api/control-financiero/receivables-analysis?year=${year}&period=${period}`,
        );
        const payload = (await response.json()) as
          | FinanceReceivablesAnalysis
          | { detail?: string };
        if (!response.ok) {
          throw new Error(
            "detail" in payload
              ? (payload.detail ?? "No se pudo cargar el análisis.")
              : "No se pudo cargar el análisis.",
          );
        }
        return payload as FinanceReceivablesAnalysis;
      });
    },
    [companyId, year],
  );

  // ── Abrir análisis desde doble clic ────────────────────────────────────────
  const openAnalysis = async (period: number) => {
    const selectedKey = `${companyId}|${year}|${period}`;
    const currentRequestId = ++requestId.current;

    setSelectedPeriod(period);
    setSelectionContextKey(currentContextKey);
    setOpen(true);
    setView("list");
    setSelectedDocument(null);
    setError(null);

    // Si ya está en cache → instantáneo
    const cacheKey = { companyId, year, period };
    if (sessionCache.has(cacheKey)) {
      setAnalysis(sessionCache.get(cacheKey)!);
      setAnalysisKey(selectedKey);
      setLoading(false);
      return;
    }

    // Nunca conservar visualmente el payload del período anterior.
    setAnalysis(null);
    setAnalysisKey(null);
    setLoading(true);
    try {
      const result = await loadAnalysis(period);
      if (requestId.current === currentRequestId) {
        setAnalysis(result);
        setAnalysisKey(selectedKey);
      }
    } catch (err) {
      if (requestId.current === currentRequestId) {
        setError(
          err instanceof Error ? err.message : "No se pudo cargar el análisis de cobranza.",
        );
      }
    } finally {
      if (requestId.current === currentRequestId) setLoading(false);
    }
  };

  // ── Precarga secuencial en segundo plano ────────────────────────────────────
  // Se activa una vez al montar el componente, sin bloquear el render principal.
  const prefetchStarted = useRef(false);
  useEffect(() => {
    if (prefetchStarted.current) return;
    prefetchStarted.current = true;

    // Determinar períodos que tienen información real
    const periodsWithData = data.months
      .map((m, idx) => ({ period: idx + 1, hasData: m.receivable_amount !== null }))
      .filter((p) => p.hasData)
      .map((p) => p.period);

    // Siempre incluir ACTUAL (period = 0)
    const periodsToPreload = [...periodsWithData, 0];

    if (periodsToPreload.length === 0) return;

    // Precarga secuencial: espera que cada request termine antes del siguiente
    let cancelled = false;
    (async () => {
      // Pequeño delay inicial para no competir con el render principal
      await new Promise((r) => setTimeout(r, 800));
      for (const period of periodsToPreload) {
        if (cancelled) break;
        const cacheKey = { companyId, year, period };
        if (sessionCache.has(cacheKey) || sessionCache.isLoading(cacheKey)) continue;
        try {
          await loadAnalysis(period);
        } catch {
          // Silencioso: fallos de precarga no deben afectar la UX
        }
        // Pausa entre requests para no saturar
        if (!cancelled) await new Promise((r) => setTimeout(r, 300));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Limpiar cache si cambia empresa/año ─────────────────────────────────────
  const prevKey = useRef(`${companyId}|${year}`);
  useEffect(() => {
    const currentKey = `${companyId}|${year}`;
    if (prevKey.current !== currentKey) {
      sessionCache.clear();
      prevKey.current = currentKey;
      requestId.current += 1;
      setAnalysis(null);
      setAnalysisKey(null);
      setSelectedPeriod(null);
      setSelectionContextKey(null);
      setSelectedDocument(null);
      setError(null);
      setLoading(false);
      setView("list");
    }
  }, [companyId, year]);

  // ── Títulos del Sheet ───────────────────────────────────────────────────────
  const selectedKey = selectedPeriod === null
    ? null
    : `${companyId}|${year}|${selectedPeriod}`;
  const visibleAnalysis =
    selectedKey && analysisKey === selectedKey && analysisKey.startsWith(`${currentContextKey}|`)
      ? analysis
      : null;
  const periodTitle = selectedPeriod === null || selectionContextKey !== currentContextKey
    ? "Análisis de cobranza"
    : selectedPeriod === 0
      ? `ACTUAL ${year}`
      : `${MONTHS[selectedPeriod - 1]} ${year}`;

  const sheetTitle =
    view === "pdf"
      ? `${selectedDocument?.document_type_name ?? "Documento"} #${selectedDocument?.folio ?? selectedDocument?.document_id}`
      : view === "document"
        ? "Detalle de factura"
        : periodTitle;

  const sheetDescription =
    view === "pdf"
      ? "Vista previa del documento electrónico."
      : view === "document"
        ? "Composición del saldo al cierre. Solo lectura."
        : visibleAnalysis
          ? `Cierre ${dateLabel(visibleAnalysis.close_date)} · documentos emitidos en ${year}`
          : "Composición diaria y documentos reconciliados.";

  return (
    <section
      className="mt-6 border-t-2 border-[#AC9C8D] pt-4"
      aria-label="Posición de cobranza"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">
          Posición de cobranza
        </h3>
        {snapshotDateTime && (
          <span className="text-[10px] text-[#322D29]/50">
            Actualizado {snapshotDateTime}
          </span>
        )}
      </div>
      <div className="overflow-x-auto border border-[#D1C7BD] bg-white">
        <table className="min-w-[920px] w-full border-collapse text-[12px]">
          <thead className="bg-[#F5F0EA] text-[10px] uppercase tracking-[0.1em] text-[#322D29]/70">
            <tr>
              <th className="px-4 py-2 text-left">Concepto</th>
              {MONTHS.map((month) => (
                <th key={month} className="px-2.5 py-2 text-right">
                  {month}
                </th>
              ))}
              <th className="border-l-2 border-[#AC9C8D] bg-[#EEE8E1] px-2.5 py-2 text-right">
                ACTUAL
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#D1C7BD]/70">
            <Row
              label="CxC pendientes al cierre"
              values={data.months.map((item) => item.receivable_amount)}
              actual={data.actual.receivable_amount}
              onOpen={openAnalysis}
            />
            <Row
              label="CxC vencidas al cierre"
              values={data.months.map((item) => item.overdue_amount)}
              actual={data.actual.overdue_amount}
              onOpen={openAnalysis}
            />
            <EvolutionRow values={overdueEvolution} actual={actualEvolution} />
          </tbody>
        </table>
      </div>
      {isSnapshot && (data.actual.clients_unqueryable ?? 0) > 0 && (
        <p className="mt-2 flex items-center gap-1 text-[10px] text-[#322D29]/55" title="Clientes incluidos en el universo, pero sin consulta disponible en este snapshot.">
          <Info className="h-3 w-3 shrink-0" aria-hidden="true" />
          {data.actual.clients_unqueryable} clientes no consultables en este snapshot.
        </p>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex h-screen w-full flex-col overflow-hidden border-[#D1C7BD] bg-[#EFE9E1] p-0 text-[#322D29] sm:!w-[62vw] sm:!max-w-[1180px]"
        >
          <SheetHeader className="shrink-0 border-b border-[#D1C7BD] bg-white px-5 py-4 text-left">
            <SheetTitle>{sheetTitle}</SheetTitle>
            <SheetDescription>{sheetDescription}</SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Estado de carga */}
            {loading && (
              <p className="px-5 py-8 text-sm text-[#322D29]/60">
                Cargando análisis…
              </p>
            )}
            {error && (
              <p className="px-5 py-8 text-sm text-[#72383D]">{error}</p>
            )}

            {/* Vista PDF */}
            {visibleAnalysis && view === "pdf" && selectedDocument && (
              <div className="flex h-full flex-col">
                <PdfViewer
                  document={selectedDocument}
                  companyId={companyId}
                  onBack={() => setView("document")}
                />
              </div>
            )}

            {/* Vista Detalle de factura */}
            {visibleAnalysis && view === "document" && selectedDocument && (
              <div className="px-5 py-4">
                <button
                  type="button"
                  onClick={() => { setSelectedDocument(null); setView("list"); }}
                  className="mb-5 flex items-center gap-1 text-xs font-semibold text-[#72383D] hover:underline"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Volver al análisis
                </button>
                <div className="border border-[#D1C7BD] bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-[#AC9C8D]">
                        {selectedDocument.document_type_name ?? "Documento"}
                      </p>
                      <h3 className="mt-1 text-lg font-semibold">
                        #{selectedDocument.folio ?? selectedDocument.document_id}
                      </h3>
                    </div>
                    <strong className="text-lg tabular-nums">
                      {money(selectedDocument.pending_amount)}
                    </strong>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <dt className="text-[#322D29]/55">Cliente</dt>
                      <dd className="font-semibold">
                        {selectedDocument.client_name ??
                          selectedDocument.client_code ??
                          "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[#322D29]/55">Emitida</dt>
                      <dd>{dateLabel(selectedDocument.emission_date)}</dd>
                    </div>
                    <div>
                      <dt className="text-[#322D29]/55">Vencimiento</dt>
                      <dd>{dateLabel(selectedDocument.expiration_date)}</dd>
                    </div>
                    <div>
                      <dt className="text-[#322D29]/55">Total IVA incluido</dt>
                      <dd>{money(selectedDocument.total_amount)}</dd>
                    </div>
                  </dl>

                  {/* Acción principal: Ver factura → Vista PDF integrada */}
                  {selectedDocument.url_pdf && (
                    <button
                      type="button"
                      onClick={() => setView("pdf")}
                      className="mt-4 flex items-center gap-1.5 rounded border border-[#72383D]/30 bg-[#F5EDE9] px-3 py-1.5 text-xs font-semibold text-[#72383D] hover:bg-[#EDD9D3] active:bg-[#E4C9C1]"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Ver factura
                    </button>
                  )}

                  <EventList events={selectedDocument.events} />
                </div>
              </div>
            )}

            {/* Vista Lista de documentos */}
            {visibleAnalysis && view === "list" && (
              <>
                  <LineChart data={visibleAnalysis.daily} />
                <div className="grid grid-cols-3 gap-px border-b border-[#D1C7BD] bg-[#D1C7BD]">
                  <Metric
                    label="CxC al cierre"
                    value={money(visibleAnalysis.summary.closing_receivable_amount)}
                  />
                  <Metric
                    label="Vencida"
                    value={money(visibleAnalysis.summary.closing_overdue_amount)}
                  />
                  <Metric
                    label="Documentos"
                    value={visibleAnalysis.summary.pending_documents.toLocaleString("es-CL")}
                  />
                </div>
                <div className="divide-y divide-[#D1C7BD]/70">
                  {visibleAnalysis.documents.map((document) => (
                    <button
                      type="button"
                      key={document.document_id}
                      onClick={() => {
                        setSelectedDocument(document);
                        setView("document");
                      }}
                      className="block w-full px-5 py-3 text-left hover:bg-white/60"
                    >
                      <div className="flex justify-between gap-3">
                        <span className="text-sm font-semibold">
                          {document.document_type_name ?? "Documento"} #
                          {document.folio ?? document.document_id}
                        </span>
                        <strong className="tabular-nums">
                          {money(document.pending_amount)}
                        </strong>
                      </div>
                      <p className="mt-1 text-xs text-[#322D29]/60">
                        {document.client_name ??
                          document.client_code ??
                          "Cliente sin nombre"}{" "}
                        · Emitida {dateLabel(document.emission_date)} · Vence{" "}
                        {dateLabel(document.expiration_date)}
                        {document.overdue ? " · Vencida" : ""}
                      </p>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
