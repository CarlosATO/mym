"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronRight, CircleAlert, Download, Eye, Loader2, Minus, RefreshCw, TrendingDown, TrendingUp, Users, X } from "lucide-react";
import {
  getMermasAnalytics,
  getWorkerMonthlyAccountReport,
  type MermasAnalytics,
  type WorkerMonthlyReport,
} from "@/app/actions/logistica/mermas";
import { formatInstantInSantiago } from "@/lib/datetime";
import { createWorkerDebtReportPdfBlob } from "@/lib/pdf/generate-worker-debt-report-pdf";
import { getImpactPercentage, getMonthlyDisplayState, getRecoveryRate, isFullyRecoveredProduct } from "./mermas-report-utils";

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });

function formatMoney(value: number) {
  return money.format(value);
}

function formatNumber(value: number) {
  return number.format(value);
}

function formatSignedMoney(value: number) {
  return value < 0 ? `-${formatMoney(Math.abs(value))}` : formatMoney(value);
}

function formatMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("es-CL", { month: "short", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function periodDays(from: string, to: string) {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function civilDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function shiftDate(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function defaultFrom() {
  return shiftDate(civilDate(new Date()), -180);
}

function movementLabel(type: string, sourceType = "") {
  if (type === "PAYMENT") return "Pago registrado";
  if (type === "PAYMENT_VOID") return "Anulación de pago";
  if (sourceType === "MERMA") return "Venta interna Mermas";
  if (sourceType === "BSALE_BOLETA") return "Compra / Boleta Bsale";
  if (sourceType === "BSALE_NOTA_CREDITO") return "Nota de crédito / Ajuste";
  return "Movimiento";
}

function movementClass(type: string) {
  if (type === "PAYMENT") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (type === "PAYMENT_VOID") return "bg-rose-500/10 text-rose-700 dark:text-rose-300";
  if (type === "ADJUSTMENT") return "bg-theme-text/[0.06] text-theme-text-muted";
  return "bg-theme-accent/10 text-theme-accent";
}

export function MermasReport() {
  const [tab, setTab] = useState<"analysis" | "debt">("analysis");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(() => civilDate(new Date()));
  const [analytics, setAnalytics] = useState<MermasAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState("");
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [debt, setDebt] = useState<WorkerMonthlyReport | null>(null);
  const [debtLoading, setDebtLoading] = useState(false);
  const [debtError, setDebtError] = useState("");
  const [selectedWorker, setSelectedWorker] = useState<WorkerMonthlyReport["workers"][number] | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  async function loadAnalytics() {
    setAnalyticsLoading(true);
    setAnalyticsError("");
    const result = await getMermasAnalytics(from, to);
    if (result.error) setAnalyticsError(result.error);
    setAnalytics(result.data);
    setAnalyticsLoading(false);
  }

  async function loadDebt(nextYear = year, nextMonth = month) {
    setDebtLoading(true);
    setDebtError("");
    const result = await getWorkerMonthlyAccountReport(nextYear, nextMonth);
    if (result.error) setDebtError(result.error);
    setDebt(result.data);
    setDebtLoading(false);
  }

  async function handlePreviewPdf() {
    if (!debt) return;
    setPreviewLoading(true);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    try {
      const blob = await createWorkerDebtReportPdfBlob(debt, year, month);
      setPreviewUrl(URL.createObjectURL(blob));
    } finally {
      setPreviewLoading(false);
    }
  }

  function closePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAnalytics(), 0);
    return () => window.clearTimeout(timer);
    // The initial report is intentionally loaded once for the selected default period.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    if (tab !== "debt" || debt || debtLoading) return;
    const timer = window.setTimeout(() => void loadDebt(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const [showAllProducts, setShowAllProducts] = useState(false);
  const [showAllSales, setShowAllSales] = useState(false);
  const rankedProducts = useMemo(() => [...(analytics?.products ?? [])].sort((a, b) => b.net_cost - a.net_cost || b.gross_cost - a.gross_cost), [analytics]);
  const recoveryProducts = useMemo(() => [...(analytics?.products ?? [])].filter((row) => row.returned_units > 0 || row.returned_cost > 0).sort((a, b) => b.returned_cost - a.returned_cost), [analytics]);
  const salesProducts = useMemo(() => [...(analytics?.sales.lines ?? [])].sort((a, b) => b.value - a.value), [analytics]);
  return (
    <div className="mermas-report min-h-[calc(100vh-7.5rem)] bg-theme-bg p-2 sm:p-3">
      <div className="mermas-report-screen mx-auto max-w-[1500px] overflow-hidden">
        <header className="border-b border-theme-border/70 px-1 py-2 sm:py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-theme-accent">Mermas · Reportes</p>
              <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-theme-text">Informe de Mermas</h1>
              <p className="text-[11px] text-theme-text-muted">Impacto económico, recuperación y productos con mayor pérdida.</p>
            </div>
            {tab === "debt" && debt && <button type="button" onClick={() => void handlePreviewPdf()} disabled={previewLoading} className="print-hide inline-flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5 disabled:opacity-50"><Eye className="h-4 w-4" /> {previewLoading ? "Generando PDF..." : "Vista previa PDF"}</button>}
          </div>
          <div className="print-hide mt-2 inline-flex rounded-lg border border-theme-border bg-theme-bg p-0.5" role="tablist" aria-label="Vistas del informe">
            <button type="button" role="tab" aria-selected={tab === "analysis"} onClick={() => setTab("analysis")} className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${tab === "analysis" ? "bg-theme-surface text-theme-text shadow-sm" : "text-theme-text-muted hover:text-theme-text"}`}><BarChart3 className="mr-1 inline h-3.5 w-3.5" /> Análisis de Mermas</button>
            <button type="button" role="tab" aria-selected={tab === "debt"} onClick={() => setTab("debt")} className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${tab === "debt" ? "bg-theme-surface text-theme-text shadow-sm" : "text-theme-text-muted hover:text-theme-text"}`}><Users className="mr-1 inline h-3.5 w-3.5" /> Deuda de trabajadores</button>
          </div>
        </header>

        {tab === "analysis" ? (
          <section className="space-y-2 p-3 sm:p-4" aria-label="Análisis de Mermas">
            <div className="print-hide flex flex-wrap items-end gap-2 border-b border-theme-border pb-2">
              <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Desde<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-sm font-normal normal-case tracking-normal text-theme-text" /></label>
              <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Hasta<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-sm font-normal normal-case tracking-normal text-theme-text" /></label>
              <button type="button" onClick={() => void loadAnalytics()} disabled={analyticsLoading} className="inline-flex h-9 items-center gap-2 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50"><RefreshCw className={analyticsLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} /> Actualizar</button>
              <span className="ml-auto pb-2 text-[11px] text-theme-text-muted">Período analizado: <strong className="text-theme-text">{periodDays(from, to)} días</strong></span>
            </div>
            {analyticsError && <ErrorMessage message={analyticsError} />}
            {analyticsLoading && !analytics ? <LoadingMessage text="Cargando análisis de Mermas..." /> : analytics && <>
              <div className="grid gap-2 xl:grid-cols-[1.2fr_1fr]">
                <ExecutiveKpi totals={analytics.totals} />
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4 xl:grid-cols-2"><SecondaryKpi label="Merma bruta" value={formatMoney(analytics.totals.gross_cost)} units={analytics.totals.gross_units} subtext="Consumos registrados" /><SecondaryKpi label="Reintegrado" value={formatMoney(analytics.totals.returned_cost)} units={analytics.totals.returned_units} subtext="Mercadería recuperada" /><SecondaryKpi label="Tasa de recuperación" value={getRecoveryRate(analytics.totals.gross_cost, analytics.totals.returned_cost) === null ? "Sin base" : `${getRecoveryRate(analytics.totals.gross_cost, analytics.totals.returned_cost)!.toFixed(1)}%`} subtext="Del costo bruto recuperado" /><SecondaryKpi label="Productos afectados" value={formatNumber(analytics.totals.products)} subtext="Con actividad en el período" /></div>
              </div>
              <ExecutiveEquation totals={analytics.totals} />
              <MonthlyEvolution monthly={analytics.monthly} />
              <ImpactTable rows={showAllProducts ? rankedProducts : rankedProducts.slice(0, 10)} totalNetCost={analytics.totals.net_cost} hasMore={rankedProducts.length > 10} showAll={showAllProducts} onToggle={() => setShowAllProducts((value) => !value)} />
              <RecoveryTable rows={recoveryProducts} />
              <SalesSummary sales={analytics.sales} rows={showAllSales ? salesProducts : salesProducts.slice(0, 5)} hasMore={salesProducts.length > 5} showAll={showAllSales} onToggle={() => setShowAllSales((value) => !value)} />
              {(analytics.totals.uncosted_lines > 0 || analytics.totals.inconsistencies.length > 0) && <DataQuality totals={analytics.totals} />}
            </>}
          </section>
        ) : (
          <DebtReport year={year} month={month} setYear={setYear} setMonth={setMonth} onRefresh={() => void loadDebt()} debt={debt} loading={debtLoading} error={debtError} selectedWorker={selectedWorker} onSelectWorker={setSelectedWorker} />
      )}
      {previewUrl && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-5" role="dialog" aria-modal="true" aria-label="Vista previa PDF" onClick={closePreview}>
        <div className="flex h-[92vh] w-[96vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl sm:h-[90vh] sm:w-[90vw]" onClick={(event) => event.stopPropagation()}>
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-theme-border px-4 py-3 sm:px-5">
            <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-theme-accent">DISTRIBUIDORA MYM</p><h2 className="text-sm font-semibold text-theme-text">Vista previa PDF · Deuda de trabajadores</h2></div>
            <div className="flex items-center gap-2"><a href={previewUrl} download={`reporte-deuda-trabajadores-${year}-${String(month).padStart(2, "0")}.pdf`} className="inline-flex items-center gap-2 rounded-lg bg-theme-accent px-3 py-2 text-xs font-bold text-white hover:bg-theme-accent-hover"><Download className="h-4 w-4" /> Descargar PDF</a><button type="button" onClick={closePreview} className="inline-flex items-center gap-2 rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5"><X className="h-4 w-4" /> Cerrar</button></div>
          </div>
          <iframe src={previewUrl} title="Vista previa del reporte de deuda" className="min-h-0 flex-1 bg-slate-100" />
        </div>
      </div>}
    </div>
    </div>
  );
}

function DebtReport({ year, month, setYear, setMonth, onRefresh, debt, loading, error, selectedWorker, onSelectWorker }: { year: number; month: number; setYear: (value: number) => void; setMonth: (value: number) => void; onRefresh: () => void; debt: WorkerMonthlyReport | null; loading: boolean; error: string; selectedWorker: WorkerMonthlyReport["workers"][number] | null; onSelectWorker: (worker: WorkerMonthlyReport["workers"][number] | null) => void }) {
  const summary = debt?.summary;
  return <section className="space-y-3 p-4 sm:p-5" aria-label="Deuda de trabajadores">
    <div className="print-hide flex flex-wrap items-end gap-2 rounded-xl border border-theme-border bg-theme-bg p-2.5">
      <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Mes<select value={month} onChange={(event) => setMonth(Number(event.target.value))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-sm font-normal normal-case tracking-normal text-theme-text">{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{new Intl.DateTimeFormat("es-CL", { month: "long" }).format(new Date(2020, index, 1))}</option>)}</select></label>
      <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Año<select value={year} onChange={(event) => setYear(Number(event.target.value))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-sm font-normal normal-case tracking-normal text-theme-text">{[year - 1, year, year + 1].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex h-9 items-center gap-2 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50"><RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} /> Actualizar</button>
    </div>
    {error && <ErrorMessage message={error} />}
    {loading && !debt ? <LoadingMessage text="Cargando deuda mensual..." /> : debt && summary && <>
      <div className="flex flex-wrap items-center justify-between gap-1"><div><h2 className="text-sm font-semibold text-theme-text">Trabajadores con actividad</h2><p className="mt-0.5 text-xs text-theme-text-muted">{summary.worker_count} trabajadores · {summary.workers_with_closing_debt} con saldo pendiente · Total a descontar: <strong className="text-theme-text">{formatMoney(summary.closing_balance)}</strong></p></div></div>
       <div className="flex flex-wrap overflow-hidden rounded-xl border border-theme-border bg-theme-bg"><DebtMetric label="Saldo anterior" value={formatMoney(summary.opening_balance)} /><DebtMetric label="Ventas Mermas" value={formatMoney(summary.merma_charges)} /><DebtMetric label="Boletas Bsale" value={formatMoney(summary.bsale_charges)} /><DebtMetric label="NC / Ajustes" value={formatMoney(summary.adjustments)} /><DebtMetric label="Pagos registrados" value={formatMoney(summary.payments)} /><DebtMetric label="Saldo pendiente" value={formatMoney(summary.closing_balance)} accent /></div>
       <div className="overflow-x-auto rounded-xl border border-theme-border"><table className="w-full min-w-[860px] text-xs"><thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">Trabajador</th><th className="px-3 py-2">RUT</th><th className="px-3 py-2 text-right">Saldo anterior</th><th className="px-3 py-2 text-right">Ventas Mermas</th><th className="px-3 py-2 text-right">Boletas Bsale</th><th className="px-3 py-2 text-right">Ajustes / NC</th><th className="px-3 py-2 text-right">Pagos</th><th className="px-3 py-2 text-right">Saldo pendiente</th><th className="px-3 py-2" /></tr></thead><tbody className="divide-y divide-theme-border/70">{debt.workers.map((worker) => <tr key={worker.employee_id} className="hover:bg-theme-text/[0.025]"><td className="px-3 py-2 font-semibold text-theme-text">{worker.name}</td><td className="px-3 py-2 text-theme-text-muted">{worker.rut}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(worker.opening_balance)}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(worker.merma_charges)}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(worker.bsale_charges)}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(worker.adjustments)}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(worker.payments)}</td><td className={`px-3 py-2 text-right font-bold tabular-nums ${worker.closing_balance > 0 ? "text-theme-accent" : "text-emerald-700 dark:text-emerald-300"}`}>{formatMoney(worker.closing_balance)}</td><td className="print-hide px-3 py-2 text-right"><button type="button" onClick={() => onSelectWorker(worker)} className="inline-flex items-center gap-1 text-xs font-semibold text-theme-text-accent hover:underline">Ver detalle <ChevronRight className="h-3.5 w-3.5" /></button></td></tr>)}</tbody></table></div>
    </>}
    {selectedWorker && <WorkerDrawer worker={selectedWorker} onClose={() => onSelectWorker(null)} />}
  </section>;
}

function WorkerDrawer({ worker, onClose }: { worker: WorkerMonthlyReport["workers"][number]; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/25" role="dialog" aria-modal="true" aria-label={`Detalle de ${worker.name}`}><button type="button" aria-label="Cerrar detalle" onClick={onClose} className="absolute inset-0 cursor-default" /><aside className="relative h-full w-full max-w-2xl overflow-y-auto border-l border-theme-border bg-theme-surface p-5 shadow-2xl sm:p-7"><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-theme-accent">Detalle mensual</p><h2 className="mt-1 text-xl font-semibold text-theme-text">{worker.name}</h2><p className="mt-1 text-sm text-theme-text-muted">RUT {worker.rut}</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/5"><X className="h-5 w-5" /></button></div><div className="mt-6 grid grid-cols-2 gap-3"><MiniMetric label="Saldo inicial" value={formatMoney(worker.opening_balance)} /><MiniMetric label="Saldo final" value={formatMoney(worker.closing_balance)} accent /></div><div className="mt-7"><h3 className="text-sm font-semibold text-theme-text">Movimientos del período</h3><div className="mt-3 space-y-2">{worker.movements.length === 0 ? <p className="rounded-xl border border-dashed border-theme-border p-5 text-sm text-theme-text-muted">Sin movimientos en el período.</p> : worker.movements.map((movement, index) => <div key={`${movement.date}-${index}`} className="rounded-xl border border-theme-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${movementClass(movement.type)}`}>{movementLabel(movement.type)}</span><span className="text-xs text-theme-text-muted">{formatInstantInSantiago(movement.date)}</span></div><div className="mt-2 grid grid-cols-2 gap-2 text-xs"><span className="text-theme-text-muted">Origen <b className="text-theme-text">{movement.source_type}</b></span><span className="text-theme-text-muted">Referencia <b className="text-theme-text">{movement.reference_number ?? "-"}</b></span><span className="text-theme-text-muted">Monto <b className="text-theme-text">{formatMoney(movement.amount)}</b></span><span className="text-theme-text-muted">Efecto <b className={movement.balance_effect < 0 ? "text-emerald-700 dark:text-emerald-300" : "text-theme-text"}>{formatMoney(movement.balance_effect)}</b></span></div></div>)}</div></div></aside></div>;
}

function ExecutiveKpi({ totals }: { totals: MermasAnalytics["totals"] }) {
  const variation = totals.cost_variation;
  const variationTone = variation === null ? "text-theme-text-muted" : variation > 0 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300";
  const variationLabel = variation === null ? "Sin base" : variation > 0 ? `-${variation.toFixed(1)}% vs. período anterior` : `+${Math.abs(variation).toFixed(1)}% vs. período anterior`;
  return <div className="rounded-xl border border-theme-accent/35 bg-theme-accent/[0.06] p-3 sm:p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">Merma neta</p><p className="mt-1 text-2xl font-semibold tracking-tight text-theme-text sm:text-3xl">{formatSignedMoney(totals.net_cost)}</p><p className="text-xs tabular-nums text-theme-text-muted">{formatNumber(totals.net_units)} unidades · pérdida efectiva después de reintegros</p></div><TrendingDown className="h-4 w-4 text-theme-accent" /></div><div className="mt-3 flex items-center justify-between gap-3 border-t border-theme-accent/15 pt-2 text-[11px]"><span className="text-theme-text-muted">Variación vs. período anterior</span><span className={`inline-flex items-center gap-1 font-semibold ${variationTone}`}>{variation === null ? <Minus className="h-3.5 w-3.5" /> : variation > 0 ? <TrendingDown className="h-3.5 w-3.5" /> : <TrendingUp className="h-3.5 w-3.5" />}{variationLabel}</span></div></div>;
}

function SecondaryKpi({ label, value, units, subtext }: { label: string; value: string; units?: number; subtext: string }) {
  return <div className="border-l-2 border-theme-border px-2 py-1"><p className="text-[9px] font-bold uppercase tracking-[0.14em] text-theme-text-muted">{label}</p><p className="mt-0.5 text-lg font-semibold tabular-nums text-theme-text">{value}</p>{units !== undefined && <p className="text-[11px] tabular-nums text-theme-text-muted">{formatNumber(units)} unidades</p>}<p className="mt-1 text-[10px] leading-3 text-theme-text-muted">{subtext}</p></div>;
}

function ExecutiveEquation({ totals }: { totals: MermasAnalytics["totals"] }) {
  return <section className="border-y border-theme-border py-2" aria-label="Ecuación ejecutiva"><div className="grid items-center gap-1 sm:grid-cols-[1fr_auto_1fr_auto_1fr]"><EquationValue label="Merma bruta" cost={totals.gross_cost} units={totals.gross_units} /><span className="text-center text-lg font-light text-theme-text-muted">−</span><EquationValue label="Reintegrado" cost={totals.returned_cost} units={totals.returned_units} /><span className="text-center text-lg font-light text-theme-text-muted">=</span><EquationValue label="Merma neta" cost={totals.net_cost} units={totals.net_units} accent /></div></section>;
}

function EquationValue({ label, cost, units, accent = false }: { label: string; cost: number; units: number; accent?: boolean }) {
  return <div className="rounded-lg bg-theme-surface/55 px-2 py-1.5"><p className={`text-[9px] font-bold uppercase tracking-[0.14em] ${accent ? "text-theme-accent" : "text-theme-text-muted"}`}>{label}</p><p className={`mt-0.5 text-base font-semibold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{formatSignedMoney(cost)}</p><p className="text-[11px] tabular-nums text-theme-text-muted">{formatNumber(units)} unidades</p></div>;
}

function MonthlyEvolution({ monthly }: { monthly: MermasAnalytics["monthly"] }) {
  const rows = monthly.map(getMonthlyDisplayState);
  const maximum = Math.max(...rows.flatMap((row) => [row.gross_cost, row.returned_cost]), 1);
  return <Panel title="Evolución mensual" subtitle="Bruta, reintegrado y neta; los reintegros no se convierten en merma negativa."><div className="space-y-2">{rows.length === 0 ? <p className="text-sm text-theme-text-muted">Sin movimientos mensuales en el período.</p> : rows.map((row) => <div key={row.month} className="grid gap-2 border-b border-theme-border/60 pb-2 last:border-b-0 last:pb-0 sm:grid-cols-[84px_1fr_125px] sm:items-center"><div><p className="text-xs font-semibold capitalize text-theme-text">{formatMonth(row.month)}</p><p className="text-[10px] text-theme-text-muted">{formatNumber(row.net_units)} u. netas</p></div><div className="space-y-1"><MonthlyBar label="Bruta" value={row.gross_cost} maximum={maximum} tone="bg-theme-accent" /><MonthlyBar label="Reintegrado" value={row.returned_cost} maximum={maximum} tone="bg-emerald-600/70" /></div><div className="sm:text-right"><span className="text-[9px] font-bold uppercase tracking-[0.12em] text-theme-text-muted">Neta </span><span className={`text-sm font-semibold tabular-nums ${row.net_cost < 0 ? "text-emerald-700 dark:text-emerald-300" : "text-theme-text"}`}>{formatSignedMoney(row.net_cost)}</span>{row.isCrossPeriodRecovery && <p className="text-[9px] leading-3 text-theme-text-muted">Reintegro de período anterior</p>}</div></div>)}</div><div className="mt-3 overflow-x-auto border-t border-theme-border pt-2"><table className="w-full min-w-[560px] text-[11px]"><thead className="text-left text-[9px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-2 py-1">Mes</th><th className="px-2 py-1 text-right">Merma bruta</th><th className="px-2 py-1 text-right">Reintegrado</th><th className="px-2 py-1 text-right">Merma neta</th></tr></thead><tbody className="divide-y divide-theme-border/60">{rows.map((row) => <tr key={`table-${row.month}`}><td className="px-2 py-1 font-medium capitalize text-theme-text">{formatMonth(row.month)}</td><td className="px-2 py-1 text-right tabular-nums text-theme-text">{formatMoney(row.gross_cost)}</td><td className="px-2 py-1 text-right tabular-nums text-theme-text">{formatMoney(row.returned_cost)}</td><td className={`px-2 py-1 text-right font-semibold tabular-nums ${row.net_cost < 0 ? "text-emerald-700 dark:text-emerald-300" : "text-theme-text"}`}>{formatSignedMoney(row.net_cost)}</td></tr>)}</tbody></table></div></Panel>;
}

function MonthlyBar({ label, value, maximum, tone }: { label: string; value: number; maximum: number; tone: string }) {
  return <div className="grid grid-cols-[94px_1fr_82px] items-center gap-2 text-[11px]"><span className="text-theme-text-muted">{label}</span><div className="h-2 rounded-full bg-theme-text/[0.06]"><div className={`h-2 rounded-full ${tone}`} style={{ width: value > 0 ? `${Math.max(value / maximum * 100, 2)}%` : "0%" }} /></div><span className="text-right tabular-nums text-theme-text">{formatMoney(value)}</span></div>;
}

function ImpactTable({ rows, totalNetCost, hasMore, showAll, onToggle }: { rows: MermasAnalytics["products"]; totalNetCost: number; hasMore: boolean; showAll: boolean; onToggle: () => void }) {
  return <Panel title="Productos con mayor impacto" subtitle="Ordenados por costo neto; los productos totalmente recuperados permanecen visibles."><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-xs"><thead className="border-b border-theme-border text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2 text-right">Merma bruta</th><th className="px-3 py-2 text-right">Reintegrado</th><th className="px-3 py-2 text-right">Merma neta</th><th className="px-3 py-2 text-right">Costo neto</th><th className="px-3 py-2 text-right">% costo neto</th></tr></thead><tbody className="divide-y divide-theme-border/60">{rows.map((row) => { const recovered = isFullyRecoveredProduct(row); const impact = getImpactPercentage(row.net_cost, totalNetCost); return <tr key={row.sku} className="hover:bg-theme-text/[0.025]"><td className="px-3 py-2 font-mono text-theme-text-muted">{row.sku}</td><td className="px-3 py-2 font-medium text-theme-text"><div>{row.name}</div>{recovered && <span className="mt-1 inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Recuperado</span>}</td><td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.gross_units)} / {formatMoney(row.gross_cost)}</td><td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.returned_units)} / {formatMoney(row.returned_cost)}</td><td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.net_units)} / {formatSignedMoney(row.net_cost)}</td><td className="px-3 py-2 text-right font-semibold tabular-nums text-theme-text">{formatSignedMoney(row.net_cost)}</td><td className="px-3 py-2 text-right tabular-nums text-theme-text-muted">{impact === null ? "Sin base" : `${impact.toFixed(1)}%`}</td></tr>})}</tbody></table></div>{hasMore && <button type="button" onClick={onToggle} className="print-hide mt-3 text-xs font-semibold text-theme-accent hover:underline">{showAll ? "Ver menos" : "Ver todos"}</button>}</Panel>;
}

function RecoveryTable({ rows }: { rows: MermasAnalytics["products"] }) {
  return <Panel title="Recuperaciones del período" subtitle="Mercadería reintegrada, ordenada por valor recuperado.">{rows.length === 0 ? <p className="text-sm text-theme-text-muted">Sin reintegros en el período.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-xs"><thead className="border-b border-theme-border text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2 text-right">Unidades reintegradas</th><th className="px-3 py-2 text-right">Valor recuperado</th><th className="px-3 py-2 text-right">Neto restante</th></tr></thead><tbody className="divide-y divide-theme-border/60">{rows.map((row) => <tr key={`recovery-${row.sku}`}><td className="px-3 py-2 font-mono text-theme-text-muted">{row.sku}</td><td className="px-3 py-2 font-medium text-theme-text">{row.name}</td><td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.returned_units)}</td><td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{formatMoney(row.returned_cost)}</td><td className="px-3 py-2 text-right tabular-nums text-theme-text">{formatNumber(row.net_units)} / {formatSignedMoney(row.net_cost)}</td></tr>)}</tbody></table></div>}</Panel>;
}

function DataQuality({ totals }: { totals: MermasAnalytics["totals"] }) {
  return <div className="border-l-2 border-amber-500/70 bg-amber-500/[0.06] px-4 py-3 text-xs text-amber-800 dark:text-amber-200"><div className="flex items-center gap-2 font-bold uppercase tracking-[0.14em]"><CircleAlert className="h-4 w-4" /> Calidad de datos</div><div className="mt-2 space-y-1">{totals.uncosted_lines > 0 && <p>{totals.uncosted_lines} líneas sin costo histórico ({formatNumber(totals.uncosted_units)} unidades)</p>}{totals.inconsistencies.length > 0 && <p>{totals.inconsistencies.length} {totals.inconsistencies.length === 1 ? "inconsistencia" : "inconsistencias"} en reintegros</p>}</div></div>;
}

function SalesSummary({ sales, rows, hasMore, showAll, onToggle }: { sales: MermasAnalytics["sales"]; rows: MermasAnalytics["sales"]["lines"]; hasMore: boolean; showAll: boolean; onToggle: () => void }) {
  return <Panel title="Comercialización de merma" subtitle="Venta interna de productos de merma; independiente de los reintegros Bsale."><div className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-theme-border/60 pb-3 sm:grid-cols-4"><CommercialMetric label="Venta de merma" value={formatMoney(sales.total_value)} /><CommercialMetric label="Recuperado por venta" value={formatMoney(sales.recovered_value)} /><CommercialMetric label="Unidades vendidas" value={formatNumber(sales.units)} /><CommercialMetric label="Productos vendidos" value={formatNumber(sales.products)} /></div>{rows.length === 0 ? <p className="pt-3 text-xs text-theme-text-muted">Sin ventas desde merma en el período.</p> : <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[560px] text-[11px]"><thead className="text-left text-[9px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-2 py-1">SKU</th><th className="px-2 py-1">Producto</th><th className="px-2 py-1 text-right">Unidades</th><th className="px-2 py-1 text-right">Valor vendido</th></tr></thead><tbody className="divide-y divide-theme-border/60">{rows.map((row) => <tr key={`sale-${row.sku}`}><td className="px-2 py-1 font-mono text-theme-text-muted">{row.sku}</td><td className="px-2 py-1 font-medium text-theme-text">{row.name}</td><td className="px-2 py-1 text-right tabular-nums">{formatNumber(row.units)}</td><td className="px-2 py-1 text-right font-semibold tabular-nums text-theme-text">{formatMoney(row.value)}</td></tr>)}</tbody></table></div>}{hasMore && <button type="button" onClick={onToggle} className="print-hide mt-2 text-[11px] font-semibold text-theme-accent hover:underline">{showAll ? "Ver menos" : "Ver todos"}</button>}</Panel>;
}

function CommercialMetric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[9px] font-bold uppercase tracking-[0.12em] text-theme-text-muted">{label}</p><p className="mt-0.5 text-sm font-semibold tabular-nums text-theme-text">{value}</p></div>;
}

function MiniMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="rounded-xl border border-theme-border bg-theme-bg p-3"><p className="text-[10px] uppercase tracking-wide text-theme-text-muted">{label}</p><p className={`mt-1 text-sm font-bold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{value}</p></div>;
}

function DebtMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="min-w-[145px] flex-1 border-b border-r border-theme-border px-3 py-2 last:border-r-0 sm:border-b-0"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">{label}</p><p className={`mt-0.5 text-sm font-bold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{value}</p></div>;
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <section className="border-t border-theme-border py-3"><div><h2 className="text-sm font-semibold text-theme-text">{title}</h2>{subtitle && <p className="mt-0.5 text-[11px] text-theme-text-muted">{subtitle}</p>}</div><div className="mt-2">{children}</div></section>;
}

function LoadingMessage({ text }: { text: string }) {
  return <div className="flex items-center gap-2 rounded-xl border border-dashed border-theme-border px-4 py-10 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> {text}</div>;
}

function ErrorMessage({ message }: { message: string }) {
  return <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{message}</p>;
}
