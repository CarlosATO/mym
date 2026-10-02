"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronRight, CircleAlert, Download, Eye, Loader2, RefreshCw, Users, X } from "lucide-react";
import {
  getMermasAnalytics,
  getWorkerMonthlyAccountReport,
  type MermasAnalytics,
  type WorkerMonthlyReport,
} from "@/app/actions/logistica/mermas";
import { formatInstantInSantiago } from "@/lib/datetime";
import { createWorkerDebtReportPdfBlob } from "@/lib/pdf/generate-worker-debt-report-pdf";
import { getAverageDaysBetweenEntries, getImpactPercentage, getLastEntryDate, getMonthlyDisplayState, isFullyRecoveredProduct } from "./mermas-report-utils";

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

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
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
  const from = useMemo(() => defaultFrom(), []);
  const to = useMemo(() => civilDate(new Date()), []);
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
  const [selectedProduct, setSelectedProduct] = useState<MermasAnalytics["products"][number] | null>(null);
  const rankedProducts = useMemo(() => [...(analytics?.products ?? [])].sort((a, b) => b.net_cost - a.net_cost || b.gross_cost - a.gross_cost), [analytics]);
  const recoveryProducts = useMemo(() => [...(analytics?.products ?? [])].filter((row) => row.returned_units > 0 || row.returned_cost > 0).sort((a, b) => b.returned_cost - a.returned_cost), [analytics]);
  const salesProducts = useMemo(() => [...(analytics?.sales.lines ?? [])].sort((a, b) => b.value - a.value), [analytics]);
  const salesBySku = useMemo(() => new Map(salesProducts.map((row) => [row.sku, row])), [salesProducts]);
  return (
    <div className="mermas-report min-h-[calc(100vh-7.5rem)] bg-theme-bg p-2 sm:p-3">
      <div className="mermas-report-screen mx-auto max-w-[1500px] overflow-hidden">
        <header className="flex min-h-12 flex-wrap items-center gap-2 border-b border-theme-border/70 px-1 py-1">
          <h1 className="shrink-0 text-sm font-semibold tracking-tight text-theme-text">Informe de Mermas</h1>
          <div className="print-hide inline-flex rounded-lg border border-theme-border bg-theme-bg p-0.5" role="tablist" aria-label="Vistas del informe">
            <button type="button" role="tab" aria-selected={tab === "analysis"} onClick={() => setTab("analysis")} className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${tab === "analysis" ? "bg-theme-surface text-theme-text shadow-sm" : "text-theme-text-muted hover:text-theme-text"}`}><BarChart3 className="mr-1 inline h-3 w-3" /> Análisis de Mermas</button>
            <button type="button" role="tab" aria-selected={tab === "debt"} onClick={() => setTab("debt")} className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${tab === "debt" ? "bg-theme-surface text-theme-text shadow-sm" : "text-theme-text-muted hover:text-theme-text"}`}><Users className="mr-1 inline h-3 w-3" /> Deuda trabajadores</button>
          </div>
          {tab === "analysis" ? <div className="print-hide ml-auto flex items-center gap-2"><span className="text-[10px] text-theme-text-muted">Últimos 180 días</span><button type="button" onClick={() => void loadAnalytics()} disabled={analyticsLoading} className="inline-flex h-7 items-center gap-1 rounded-lg bg-theme-accent px-2 text-[10px] font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-50"><RefreshCw className={analyticsLoading ? "h-3 w-3 animate-spin" : "h-3 w-3"} /> Actualizar</button></div> : debt && <button type="button" onClick={() => void handlePreviewPdf()} disabled={previewLoading} className="print-hide ml-auto inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border px-2 text-[10px] font-semibold text-theme-text hover:bg-theme-text/5 disabled:opacity-50"><Eye className="h-3 w-3" /> {previewLoading ? "Generando..." : "Vista previa PDF"}</button>}
        </header>

        {tab === "analysis" ? (
          <section className="space-y-1 p-2 sm:p-3" aria-label="Análisis de Mermas">
            {analyticsError && <ErrorMessage message={analyticsError} />}
            {analyticsLoading && !analytics ? <LoadingMessage text="Cargando análisis de Mermas..." /> : analytics && <>
              <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-theme-border bg-theme-surface/45 sm:grid-cols-5"><CompactMetric label="Merma neta" value={formatSignedMoney(analytics.totals.net_cost)} detail={`${formatNumber(analytics.totals.net_units)} u. · Reintegro Bsale: ${formatMoney(analytics.totals.returned_cost)} · ${formatNumber(analytics.totals.returned_units)} u.`} featured /><CompactMetric label="Merma bruta" value={formatMoney(analytics.totals.gross_cost)} detail={`${formatNumber(analytics.totals.gross_units)} unidades`} /><CompactMetric label="Venta de merma" value={formatMoney(analytics.sales.total_value)} detail={`${formatNumber(analytics.sales.units)} unidades`} /><CompactMetric label="Productos afectados" value={formatNumber(analytics.totals.products)} detail="En el período" /><CompactMetric label="Recuperado por venta" value={formatMoney(analytics.sales.recovered_value)} detail="Valor comercializado" /></div>
              <MonthlyEvolution monthly={analytics.monthly} />
              <ImpactTable rows={showAllProducts ? rankedProducts : rankedProducts.slice(0, 10)} totalNetCost={analytics.totals.net_cost} salesBySku={salesBySku} hasMore={rankedProducts.length > 10} showAll={showAllProducts} onToggle={() => setShowAllProducts((value) => !value)} onSelectProduct={setSelectedProduct} />
              <RecoveryTable rows={recoveryProducts} />
              {selectedProduct && <ProductDetailDrawer product={selectedProduct} sale={salesBySku.get(selectedProduct.sku)} onClose={() => setSelectedProduct(null)} />}
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

function CompactMetric({ label, value, detail, featured = false }: { label: string; value: string; detail: string; featured?: boolean }) {
  return <div className={`min-h-[68px] border-b border-r border-theme-border px-2 py-2 last:border-r-0 sm:border-b-0 ${featured ? "bg-theme-accent/[0.06]" : ""}`}><p className={`text-[9px] font-bold uppercase tracking-[0.13em] ${featured ? "text-theme-accent" : "text-theme-text-muted"}`}>{label}</p><p className={`mt-0.5 tabular-nums ${featured ? "text-lg font-bold text-theme-accent" : "text-base font-semibold text-theme-text"}`}>{value}</p><p className="truncate text-[10px] tabular-nums text-theme-text-muted">{detail}</p></div>;
}

function MonthlyEvolution({ monthly }: { monthly: MermasAnalytics["monthly"] }) {
  const rows = monthly.map(getMonthlyDisplayState);
  const maximum = Math.max(...rows.map((row) => Math.abs(row.net_cost)), 1);
  return <Panel title="Merma mensual"><div className="space-y-1">{rows.length === 0 ? <p className="text-sm text-theme-text-muted">Sin movimientos mensuales en el período.</p> : rows.map((row) => <div key={row.month} className="grid grid-cols-[72px_1fr_auto] items-center gap-2 border-b border-theme-border/60 pb-1 last:border-b-0 last:pb-0"><div><p className="text-xs font-semibold capitalize text-theme-text">{formatMonth(row.month)}</p><p className="text-[10px] text-theme-text-muted">{formatNumber(row.net_units)} u.</p></div><div className="h-2 rounded-full bg-theme-text/[0.06]" title={`${formatSignedMoney(row.net_cost)} · ${formatNumber(row.net_units)} unidades`}><div className={`h-2 rounded-full ${row.net_cost < 0 ? "bg-emerald-600/70" : "bg-theme-accent"}`} style={{ width: row.net_cost === 0 ? "0%" : `${Math.max(Math.abs(row.net_cost) / maximum * 100, 3)}%` }} /></div><div className={`text-right text-sm font-semibold tabular-nums ${row.net_cost < 0 ? "text-emerald-700 dark:text-emerald-300" : "text-theme-text"}`}>{formatSignedMoney(row.net_cost)}{row.isCrossPeriodRecovery && <span className="ml-1 text-[9px] font-normal text-theme-text-muted">reintegro anterior</span>}</div></div>)}</div></Panel>;
}

function ImpactTable({ rows, totalNetCost, salesBySku, hasMore, showAll, onToggle, onSelectProduct }: { rows: MermasAnalytics["products"]; totalNetCost: number; salesBySku: Map<string, MermasAnalytics["sales"]["lines"][number]>; hasMore: boolean; showAll: boolean; onToggle: () => void; onSelectProduct: (product: MermasAnalytics["products"][number]) => void }) {
  return <Panel title="Productos con mayor impacto" subtitle="Doble clic en una fila para revisar comportamiento, ventas e ingresos."><div className="overflow-x-auto"><table className="w-full min-w-[1180px] text-[11px]"><thead className="border-b border-theme-border text-left text-[9px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-2 py-1.5">SKU</th><th className="px-2 py-1.5">Producto</th><th className="px-2 py-1.5 text-right">Nº ingresos</th><th className="px-2 py-1.5 text-right">Unidades mermadas</th><th className="px-2 py-1.5 text-right">Costo neto</th><th className="px-2 py-1.5 text-right">Venta (u.)</th><th className="px-2 py-1.5 text-right">Venta ($)</th><th className="px-2 py-1.5 text-right">Prom. días</th><th className="px-2 py-1.5 text-right">Último ingreso</th><th className="px-2 py-1.5 text-right">% impacto</th></tr></thead><tbody className="divide-y divide-theme-border/60">{rows.map((row) => { const recovered = isFullyRecoveredProduct(row); const impact = getImpactPercentage(row.net_cost, totalNetCost); const sale = salesBySku.get(row.sku); const averageDays = getAverageDaysBetweenEntries(row.entries); const lastEntry = getLastEntryDate(row.entries); return <tr key={row.sku} tabIndex={0} onDoubleClick={() => onSelectProduct(row)} title="Doble clic para ver detalle" className="cursor-pointer hover:bg-theme-text/[0.025] focus:bg-theme-text/[0.025]"><td className="px-2 py-1.5 font-mono text-theme-text-muted">{row.sku}</td><td className="px-2 py-1.5 font-medium text-theme-text"><div>{row.name}</div>{recovered && <span className="mt-0.5 inline-flex rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Recuperado</span>}</td><td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(row.entries.length)}</td><td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(row.gross_units)}</td><td className="px-2 py-1.5 text-right font-semibold tabular-nums text-theme-text">{formatSignedMoney(row.net_cost)}</td><td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(sale?.units ?? 0)}</td><td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(sale?.value ?? 0)}</td><td className="px-2 py-1.5 text-right tabular-nums text-theme-text-muted">{averageDays === null ? "—" : `${averageDays.toFixed(1)} d`}</td><td className="px-2 py-1.5 text-right tabular-nums text-theme-text-muted">{lastEntry ? formatShortDate(lastEntry) : "—"}</td><td className="px-2 py-1.5 text-right tabular-nums text-theme-text-muted">{impact === null ? "—" : `${impact.toFixed(1)}%`}</td></tr>})}</tbody></table></div>{hasMore && <button type="button" onClick={onToggle} className="print-hide mt-2 text-[11px] font-semibold text-theme-accent hover:underline">{showAll ? "Ver menos" : "Ver todos"}</button>}</Panel>;
}

function RecoveryTable({ rows }: { rows: MermasAnalytics["products"] }) {
  return <Panel title="Recuperaciones del período" subtitle="Mercadería reintegrada, ordenada por valor recuperado.">{rows.length === 0 ? <p className="text-sm text-theme-text-muted">Sin reintegros en el período.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-xs"><thead className="border-b border-theme-border text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2 text-right">Unidades reintegradas</th><th className="px-3 py-2 text-right">Valor recuperado</th><th className="px-3 py-2 text-right">Neto restante</th></tr></thead><tbody className="divide-y divide-theme-border/60">{rows.map((row) => <tr key={`recovery-${row.sku}`}><td className="px-3 py-2 font-mono text-theme-text-muted">{row.sku}</td><td className="px-3 py-2 font-medium text-theme-text">{row.name}</td><td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.returned_units)}</td><td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{formatMoney(row.returned_cost)}</td><td className="px-3 py-2 text-right tabular-nums text-theme-text">{formatNumber(row.net_units)} / {formatSignedMoney(row.net_cost)}</td></tr>)}</tbody></table></div>}</Panel>;
}

function DataQuality({ totals }: { totals: MermasAnalytics["totals"] }) {
  return <div className="border-l-2 border-amber-500/70 bg-amber-500/[0.06] px-4 py-3 text-xs text-amber-800 dark:text-amber-200"><div className="flex items-center gap-2 font-bold uppercase tracking-[0.14em]"><CircleAlert className="h-4 w-4" /> Calidad de datos</div><div className="mt-2 space-y-1">{totals.uncosted_lines > 0 && <p>{totals.uncosted_lines} líneas sin costo histórico ({formatNumber(totals.uncosted_units)} unidades)</p>}{totals.inconsistencies.length > 0 && <p>{totals.inconsistencies.length} {totals.inconsistencies.length === 1 ? "inconsistencia" : "inconsistencias"} en reintegros</p>}</div></div>;
}

function ProductDetailDrawer({ product, sale, onClose }: { product: MermasAnalytics["products"][number]; sale?: MermasAnalytics["sales"]["lines"][number]; onClose: () => void }) {
  const averageDays = getAverageDaysBetweenEntries(product.entries);
  const lastEntry = getLastEntryDate(product.entries);
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/25" role="dialog" aria-modal="true" aria-label={`Detalle de ${product.name}`}><button type="button" aria-label="Cerrar detalle" onClick={onClose} className="absolute inset-0 cursor-default" /><aside className="relative h-full w-full max-w-2xl overflow-y-auto border-l border-theme-border bg-theme-surface p-4 shadow-2xl sm:p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-[9px] font-bold uppercase tracking-[0.18em] text-theme-accent">Comportamiento del producto</p><h2 className="mt-1 text-lg font-semibold text-theme-text">{product.name}</h2><p className="text-xs text-theme-text-muted">SKU {product.sku}</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 text-theme-text-muted hover:bg-theme-text/5"><X className="h-5 w-5" /></button></div><div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><MiniMetric label="Total ingresado" value={`${formatNumber(product.gross_units)} u.`} /><MiniMetric label="Nº ingresos" value={formatNumber(product.entries.length)} /><MiniMetric label="Promedio días" value={averageDays === null ? "—" : `${averageDays.toFixed(1)} d`} /><MiniMetric label="Último ingreso" value={lastEntry ? formatShortDate(lastEntry) : "—"} accent /></div><DetailList title="Ingresos a merma" empty="Sin ingresos registrados.">{product.entries.slice().sort((a, b) => b.date.localeCompare(a.date)).map((entry, index) => <DetailRow key={`${entry.date}-${index}`} date={entry.date} quantity={entry.units} value={entry.cost} />)}</DetailList><DetailList title="Ventas desde merma" empty="Sin ventas desde merma en el período.">{(sale?.entries ?? []).slice().sort((a, b) => b.date.localeCompare(a.date)).map((entry, index) => <DetailRow key={`${entry.date}-${index}`} date={entry.date} quantity={entry.units} value={entry.value} />)}</DetailList><DetailList title="Reintegros Bsale" empty="Sin reintegros para este producto.">{product.returns.slice().sort((a, b) => b.date.localeCompare(a.date)).map((entry, index) => <DetailRow key={`${entry.date}-${index}`} date={entry.date} quantity={entry.units} value={entry.value} />)}</DetailList></aside></div>;
}

function DetailList({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <section className="mt-5"><h3 className="text-xs font-semibold text-theme-text">{title}</h3>{hasChildren ? <div className="mt-2 divide-y divide-theme-border/60 border-y border-theme-border/60">{children}</div> : <p className="mt-2 text-xs text-theme-text-muted">{empty}</p>}</section>;
}

function DetailRow({ date, quantity, value }: { date: string; quantity: number; value: number }) {
  return <div className="flex items-center justify-between gap-3 py-1.5 text-xs"><span className="text-theme-text-muted">{formatShortDate(date)}</span><span className="tabular-nums text-theme-text">{formatNumber(quantity)} u.</span><strong className="tabular-nums text-theme-text">{formatMoney(value)}</strong></div>;
}

function MiniMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="rounded-xl border border-theme-border bg-theme-bg p-3"><p className="text-[10px] uppercase tracking-wide text-theme-text-muted">{label}</p><p className={`mt-1 text-sm font-bold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{value}</p></div>;
}

function DebtMetric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return <div className="min-w-[145px] flex-1 border-b border-r border-theme-border px-3 py-2 last:border-r-0 sm:border-b-0"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-theme-text-muted">{label}</p><p className={`mt-0.5 text-sm font-bold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{value}</p></div>;
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <section className="border-t border-theme-border py-2"><div><h2 className="text-sm font-semibold text-theme-text">{title}</h2>{subtitle && <p className="mt-0.5 text-[11px] text-theme-text-muted">{subtitle}</p>}</div><div className="mt-1">{children}</div></section>;
}

function LoadingMessage({ text }: { text: string }) {
  return <div className="flex items-center gap-2 rounded-xl border border-dashed border-theme-border px-4 py-10 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> {text}</div>;
}

function ErrorMessage({ message }: { message: string }) {
  return <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{message}</p>;
}
