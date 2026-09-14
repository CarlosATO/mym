"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, X } from "lucide-react";
import {
  approveWorkerPayment,
  getWorkerPaymentEvidenceUrl,
  getWorkerPaymentReviewDetail,
  rejectWorkerPayment,
  type WorkerPaymentReview,
  type WorkerPaymentReviewDetail,
} from "@/app/actions/logistica/mermas";
import { formatInstantInSantiago } from "@/lib/datetime";
import { useMermasModule } from "./mermas-module-provider";

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const date = (value: string) => formatInstantInSantiago(value);
const amount = (value: number) => money.format(value);

export function WorkerPaymentReviewPanel() {
  const { workerPayments, ensureWorkerPaymentsLoaded, invalidateWorkerPayments, invalidateWorkerAccounts } = useMermasModule();
  const payments = workerPayments.data;
  const loading = !workerPayments.loaded;
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<WorkerPaymentReviewDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  async function load() {
    setError("");
    try {
      await ensureWorkerPaymentsLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar la revisión de pagos.");
    }
  }

  useEffect(() => {
    void ensureWorkerPaymentsLoaded(true);
    // Revalidate on route revisit while retaining the previous list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openPayment(payment: WorkerPaymentReview) {
    setDetailLoading(true);
    setError("");
    const response = await getWorkerPaymentReviewDetail(payment.payment_id);
    if (response.data) setDetail(response.data);
    else setError(response.error ?? "No se pudo cargar el detalle del pago.");
    setDetailLoading(false);
  }

  async function refreshAfterReview() {
    setDetail(null);
    invalidateWorkerPayments();
    invalidateWorkerAccounts();
    await ensureWorkerPaymentsLoaded(true);
  }

  return <div className="min-h-[calc(100vh-7.5rem)] bg-theme-bg p-3 sm:p-5"><div className="mx-auto max-w-[1500px] overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-sm"><header className="border-b border-theme-border/60 bg-theme-text/[0.012] px-5 py-4"><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-theme-accent">Mermas · Revisión</p><h1 className="mt-1 text-base font-semibold text-theme-text">Revisión de pagos</h1><p className="mt-1 text-xs text-theme-text-muted">Bandeja exclusiva para SUPER_USUARIO.</p></header><div className="space-y-4 p-4 sm:p-5"><div className="flex items-center justify-between"><span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs font-bold text-amber-700 dark:text-amber-300">Pendientes ({payments.length})</span><button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted disabled:opacity-50">Actualizar</button></div>{error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>}{loading ? <div className="flex items-center gap-2 rounded-xl border border-dashed border-theme-border px-4 py-10 text-xs text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Cargando pagos pendientes...</div> : payments.length === 0 ? <p className="rounded-xl border border-dashed border-theme-border px-4 py-10 text-center text-xs text-theme-text-muted">No hay pagos pendientes de revisión.</p> : <div className="overflow-x-auto rounded-2xl border border-theme-border"><table className="w-full min-w-[950px] text-sm"><thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">PIT</th><th className="px-4 py-3">Trabajador</th><th className="px-4 py-3">RUT</th><th className="px-4 py-3 text-right">Monto</th><th className="px-4 py-3">Comprobante</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3">Acción</th></tr></thead><tbody className="divide-y divide-theme-border/70">{payments.map((payment) => <tr key={payment.payment_id} onClick={() => void openPayment(payment)} className="cursor-pointer hover:bg-theme-accent/[0.05]"><td className="px-4 py-3 text-xs text-theme-text-muted">{date(payment.submitted_at)}</td><td className="px-4 py-3 font-mono text-xs font-bold text-theme-accent">{payment.payment_number}</td><td className="px-4 py-3 font-semibold text-theme-text">{payment.employee_name}</td><td className="px-4 py-3 font-mono text-xs text-theme-text-muted">{payment.rut}</td><td className="px-4 py-3 text-right font-semibold text-theme-text">{amount(payment.amount)}</td><td className="px-4 py-3 text-xs text-theme-text-muted">{payment.original_filename}</td><td className="px-4 py-3 text-xs text-amber-700 dark:text-amber-300">Pendiente de revisión</td><td className="px-4 py-3"><button type="button" onClick={(event) => { event.stopPropagation(); void openPayment(payment); }} className="rounded-lg border border-theme-accent px-2.5 py-1.5 text-[11px] font-bold text-theme-accent">Ver detalle</button></td></tr>)}</tbody></table></div>}</div></div>{detailLoading && <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"><div className="rounded-xl bg-theme-surface px-4 py-3 text-xs text-theme-text shadow-xl"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Cargando detalle...</div></div>}{detail && <ReviewDetail detail={detail} onClose={() => setDetail(null)} onReviewed={() => void refreshAfterReview()} />}</div>;
}

function ReviewDetail({ detail, onClose, onReviewed }: { detail: WorkerPaymentReviewDetail; onClose: () => void; onReviewed: () => void }) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function viewEvidence() {
    const response = await getWorkerPaymentEvidenceUrl(detail.payment.id);
    if (response.url) window.open(response.url, "_blank", "noopener,noreferrer");
    else setError(response.error ?? "No se pudo abrir el comprobante.");
  }

  async function approve() {
    setBusy(true); setError("");
    const response = await approveWorkerPayment(detail.payment.id);
    if (response.success) onReviewed();
    else setError(response.error ?? "No se pudo aprobar el pago.");
    setBusy(false); setApproveOpen(false);
  }

  async function reject() {
    if (!reason.trim()) { setError("El motivo del rechazo es obligatorio."); return; }
    setBusy(true); setError("");
    const response = await rejectWorkerPayment(detail.payment.id, reason);
    if (response.success) onReviewed();
    else setError(response.error ?? "No se pudo rechazar el pago.");
    setBusy(false); setRejectOpen(false);
  }

  return <div className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-4" role="dialog" aria-modal="true"><section className="mx-auto mt-8 max-w-3xl rounded-2xl border border-theme-border bg-theme-surface shadow-2xl"><header className="flex items-start justify-between border-b border-theme-border px-5 py-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">Revisión de pago</p><h2 className="mt-1 text-lg font-semibold text-theme-text">{detail.payment.payment_number}</h2><p className="mt-1 text-xs text-theme-text-muted">{detail.employee.name} · {detail.employee.rut}</p></div><button type="button" onClick={onClose} disabled={busy} aria-label="Cerrar" className="rounded-lg p-1 text-theme-text-muted hover:bg-theme-text/5"><X className="h-4 w-4" /></button></header><div className="space-y-5 p-5"><div className="grid gap-2 sm:grid-cols-4"><Metric label="Monto" value={amount(detail.payment.amount)} /><Metric label="Enviado" value={date(detail.payment.submitted_at)} /><Metric label="Estado" value="Pendiente de revisión" /><Metric label="Registrado por" value={detail.payment.submitted_by} /></div><div className="grid gap-2 sm:grid-cols-5"><Metric label="Deuda" value={amount(detail.summary.total_charges)} /><Metric label="Pagado aprobado" value={amount(detail.summary.approved_payments)} /><Metric label="En revisión" value={amount(detail.summary.pending_review_payments)} /><Metric label="Saldo oficial" value={amount(detail.summary.official_balance)} /><Metric label="Saldo proyectado" value={amount(detail.summary.projected_balance)} /></div><div className="flex items-center justify-between rounded-xl border border-theme-border px-4 py-3"><div><p className="text-xs font-semibold text-theme-text">{detail.evidence.original_filename}</p><p className="mt-1 text-[11px] text-theme-text-muted">{detail.evidence.mime_type} · {(detail.evidence.size_bytes / 1024).toFixed(1)} KB</p></div><button type="button" onClick={() => void viewEvidence()} className="inline-flex items-center gap-1.5 rounded-lg border border-theme-accent px-3 py-2 text-xs font-bold text-theme-accent"><ExternalLink className="h-3.5 w-3.5" />Ver comprobante</button></div>{error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>}<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={() => setRejectOpen(true)} disabled={busy} className="rounded-xl border border-red-500/50 px-4 py-2.5 text-xs font-bold text-red-600 disabled:opacity-40">Rechazar</button><button type="button" onClick={() => setApproveOpen(true)} disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-40"><CheckCircle2 className="h-4 w-4" />Aprobar pago</button></div></div></section>{approveOpen && <ConfirmModal title="Aprobar pago" text={`Al aprobar, ${detail.payment.payment_number} por ${amount(detail.payment.amount)} será aplicado a la deuda pendiente de ${detail.employee.name} y no podrá editarse.`} confirm="Aprobar pago" busy={busy} onCancel={() => setApproveOpen(false)} onConfirm={() => void approve()} />}{rejectOpen && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4"><section className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-5 shadow-2xl"><h3 className="text-base font-semibold text-theme-text">Rechazar pago</h3><p className="mt-2 text-xs text-theme-text-muted">El pago no reducirá la deuda y el trabajador volverá a tener saldo disponible para rendir.</p><textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={4} placeholder="Motivo del rechazo" className="mt-4 w-full rounded-xl border border-theme-border bg-theme-bg px-3 py-2 text-xs text-theme-text outline-none focus:border-theme-accent" /><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setRejectOpen(false)} disabled={busy} className="rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted">Cancelar</button><button type="button" onClick={() => void reject()} disabled={busy || !reason.trim()} className="rounded-xl bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">Confirmar rechazo</button></div></section></div>}</div>;
}

function ConfirmModal({ title, text, confirm, busy, onCancel, onConfirm }: { title: string; text: string; confirm: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/45 p-4"><section className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-5 shadow-2xl"><h3 className="text-base font-semibold text-theme-text">{title}</h3><p className="mt-3 text-sm text-theme-text-muted">{text}</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onCancel} disabled={busy} className="rounded-xl border border-theme-border px-3 py-2 text-xs font-semibold text-theme-text-muted">Cancelar</button><button type="button" onClick={onConfirm} disabled={busy} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">{busy ? "Procesando..." : confirm}</button></div></section></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-theme-border bg-theme-bg px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-1 truncate text-xs font-bold text-theme-text">{value}</p></div>;
}
