"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronRight, CircleAlert, Download, Eye, FileBarChart, Loader2, RefreshCw, TrendingDown, TrendingUp, Users, X } from "lucide-react";
import {
  getMermasAnalytics,
  getWorkerMonthlyAccountReport,
  type MermasAnalytics,
  type WorkerMonthlyReport,
} from "@/app/actions/logistica/mermas";
import { formatInstantInSantiago } from "@/lib/datetime";
import { createWorkerDebtReportPdfBlob } from "@/lib/pdf/generate-worker-debt-report-pdf";

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });

function formatMoney(value: number) {
  return money.format(value);
}

function formatNumber(value: number) {
  return number.format(value);
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
  if (type === "ADJUSTMENT") return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "bg-theme-accent/10 text-theme-accent";
}

export function MermasReport() {
  const [tab, setTab] = useState<"analysis" | "debt">("analysis");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(() => civilDate(new Date()));
  const [analytics, setAnalytics] = useState<MermasAnalytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState("");
  const [metric, setMetric] = useState<"cost" | "units">("cost");
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

  const monthMaximum = useMemo(() => Math.max(...(analytics?.monthly ?? []).map((item) => item[metric]), 1), [analytics, metric]);
  const rankedProducts = useMemo(() => [...(analytics?.products ?? [])].sort((a, b) => b[metric] - a[metric]).slice(0, 10), [analytics, metric]);
  return (
    <div className="mermas-report min-h-[calc(100vh-7.5rem)] bg-theme-bg p-3 sm:p-5">
      <div className="mermas-report-screen mx-auto max-w-[1500px] overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-sm">
        <header className="border-b border-theme-border/60 bg-theme-text/[0.012] px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-theme-accent">Mermas · Reportes</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-theme-text">Informe de Mermas</h1>
              <p className="mt-0.5 text-xs text-theme-text-muted">Análisis económico, operacional y cuentas de trabajadores.</p>
            </div>
            {tab === "debt" && debt && <button type="button" onClick={() => void handlePreviewPdf()} disabled={previewLoading} className="print-hide inline-flex items-center gap-2 rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text hover:bg-theme-text/5 disabled:opacity-50"><Eye className="h-4 w-4" /> {previewLoading ? "Generando PDF..." : "Vista previa PDF"}</button>}
          </div>
          <div className="print-hide mt-3 inline-flex rounded-lg border border-theme-border bg-theme-bg p-0.5" role="tablist" aria-label="Vistas del informe">
            <button type="button" role="tab" aria-selected={tab === "analysis"} onClick={() => setTab("analysis")} className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${tab === "analysis" ? "bg-theme-surface text-theme-text shadow-sm" : "text-theme-text-muted hover:text-theme-text"}`}><BarChart3 className="mr-1 inline h-3.5 w-3.5" /> Análisis de Mermas</button>
            <button type="button" role="tab" aria-selected={tab === "debt"} onClick={() => setTab("debt")} className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${tab === "debt" ? "bg-theme-surface text-theme-text shadow-sm" : "text-theme-text-muted hover:text-theme-text"}`}><Users className="mr-1 inline h-3.5 w-3.5" /> Deuda de trabajadores</button>
          </div>
        </header>

        {tab === "analysis" ? (
          <section className="space-y-3 p-4 sm:p-5" aria-label="Análisis de Mermas">
            <div className="print-hide flex flex-wrap items-end gap-2 rounded-xl border border-theme-border bg-theme-bg p-2.5">
              <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Desde<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-sm font-normal normal-case tracking-normal text-theme-text" /></label>
              <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">Hasta<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-sm font-normal normal-case tracking-normal text-theme-text" /></label>
              <button type="button" onClick={() => void loadAnalytics()} disabled={analyticsLoading} className="inline-flex h-9 items-center gap-2 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50"><RefreshCw className={analyticsLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} /> Actualizar</button>
            </div>
            {analyticsError && <ErrorMessage message={analyticsError} />}
            {analyticsLoading && !analytics ? <LoadingMessage text="Cargando análisis de Mermas..." /> : analytics && <>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi label="Costo total de mermas" value={formatMoney(analytics.totals.cost)} icon={<TrendingDown className="h-4 w-4" />} accent />
                <Kpi label="Unidades en merma" value={formatNumber(analytics.totals.units)} icon={<PackageIcon />} />
                <Kpi label="Productos afectados" value={formatNumber(analytics.totals.products)} icon={<FileBarChart className="h-4 w-4" />} />
                <Kpi label="Variación vs período anterior" value={analytics.totals.cost_variation === null ? "Sin base" : `${analytics.totals.cost_variation >= 0 ? "+" : ""}${analytics.totals.cost_variation.toFixed(1)}%`} icon={analytics.totals.cost_variation !== null && analytics.totals.cost_variation >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />} />
              </div>
              {analytics.totals.uncosted_lines > 0 && <p className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300"><CircleAlert className="h-4 w-4" /> {analytics.totals.uncosted_lines} registros sin costo histórico ({formatNumber(analytics.totals.uncosted_units)} unidades), excluidos del costo económico.</p>}
              <div className="grid gap-3 xl:grid-cols-[1.35fr_1fr]">
                <Panel title="Evolución mensual" action={<div className="print-hide inline-flex rounded-lg border border-theme-border p-0.5"><button type="button" onClick={() => setMetric("cost")} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${metric === "cost" ? "bg-theme-text text-theme-surface" : "text-theme-text-muted"}`}>Costo $</button><button type="button" onClick={() => setMetric("units")} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${metric === "units" ? "bg-theme-text text-theme-surface" : "text-theme-text-muted"}`}>Unidades</button></div>}>
                  <div className="flex h-[230px] items-end justify-center gap-2 overflow-x-auto pt-3">{analytics.monthly.map((item) => { const value = item[metric]; return <div key={item.month} className={`${analytics.monthly.length === 1 ? "w-28 flex-none" : "min-w-12 flex-1"} flex max-w-24 flex-col items-center gap-1.5`}><span className="text-[10px] tabular-nums text-theme-text-muted">{metric === "cost" ? formatMoney(value).replace(/\s/g, "") : formatNumber(value)}</span><div className="flex h-32 w-full items-end rounded-t-md bg-theme-accent/10"><div className="w-full rounded-t-md bg-theme-accent transition-all" style={{ height: `${Math.max((value / monthMaximum) * 100, 3)}%` }} /></div><span className="text-[10px] text-theme-text-muted">{item.month.slice(5)}</span></div>; })}</div>
                </Panel>
              </div>
              <Ranking title={metric === "cost" ? "Productos con mayor costo económico" : "Productos con mayor cantidad de unidades"} rows={rankedProducts} value={metric} action={<div className="print-hide inline-flex rounded-lg border border-theme-border p-0.5"><button type="button" onClick={() => setMetric("cost")} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${metric === "cost" ? "bg-theme-text text-theme-surface" : "text-theme-text-muted"}`}>Mayor costo</button><button type="button" onClick={() => setMetric("units")} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${metric === "units" ? "bg-theme-text text-theme-surface" : "text-theme-text-muted"}`}>Mayor cantidad</button></div>} />
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

function Kpi({ label, value, icon, accent = false }: { label: string; value: string; icon?: React.ReactNode; accent?: boolean }) {
  return <div className="rounded-xl border border-theme-border bg-theme-bg p-4"><div className="flex items-center justify-between text-theme-text-muted"><span className="text-[10px] font-semibold uppercase tracking-[0.12em]">{label}</span>{icon}</div><p className={`mt-2 text-lg font-bold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{value}</p></div>;
}

function MiniMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="rounded-xl border border-theme-border bg-theme-bg p-3"><p className="text-[10px] uppercase tracking-wide text-theme-text-muted">{label}</p><p className={`mt-1 text-sm font-bold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{value}</p></div>;
}

function DebtMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="min-w-[145px] flex-1 border-b border-r border-theme-border px-3 py-2 last:border-r-0 sm:border-b-0"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">{label}</p><p className={`mt-0.5 text-sm font-bold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{value}</p></div>;
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <div className="rounded-2xl border border-theme-border bg-theme-surface p-4 sm:p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-theme-text">{title}</h2>{action}</div><div className="mt-4">{children}</div></div>;
}

function Ranking({ title, rows, value, action }: { title: string; rows: MermasAnalytics["products"]; value: "cost" | "units"; action?: React.ReactNode }) {
  return <Panel title={title} action={action}><div className="overflow-hidden rounded-xl border border-theme-border"><table className="w-full text-xs"><thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2 text-right">Unidades</th><th className="px-3 py-2 text-right">Costo</th></tr></thead><tbody className="divide-y divide-theme-border/70">{rows.map((row) => <tr key={row.sku}><td className="px-3 py-2 font-mono text-theme-text-muted">{row.sku}</td><td className="px-3 py-2 font-medium text-theme-text">{row.name}</td><td className={`px-3 py-2 text-right tabular-nums ${value === "units" ? "font-bold text-theme-text" : "text-theme-text-muted"}`}>{formatNumber(row.units)}</td><td className={`px-3 py-2 text-right tabular-nums ${value === "cost" ? "font-bold text-theme-text" : "text-theme-text-muted"}`}>{formatMoney(row.cost)}</td></tr>)}</tbody></table></div></Panel>;
}

function LoadingMessage({ text }: { text: string }) {
  return <div className="flex items-center gap-2 rounded-xl border border-dashed border-theme-border px-4 py-10 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> {text}</div>;
}

function ErrorMessage({ message }: { message: string }) {
  return <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{message}</p>;
}

function PackageIcon() {
  return <span className="text-sm font-bold">u.</span>;
}
