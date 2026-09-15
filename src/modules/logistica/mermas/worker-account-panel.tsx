"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Search, Upload, X } from "lucide-react";
import {
  getWorkerAccountDetail,
  type WorkerPaymentUpload,
  prepareWorkerPaymentUpload,
  cleanupWorkerPaymentUpload,
  submitWorkerPayment,
  type WorkerAccount,
  type WorkerAccountDetail,
} from "@/app/actions/logistica/mermas";
import { formatInstantInSantiago } from "@/lib/datetime";
import { createClient as createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useMermasModule } from "./mermas-module-provider";

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

function formatMoney(value: number) {
  return money.format(value);
}

function formatDate(value: string | null) {
  return value ? formatInstantInSantiago(value) : "Sin pagos";
}

function displayStatus(status: string, movementType: "CHARGE" | "PAYMENT") {
  if (status === "PENDING_RENDITION" && movementType === "CHARGE") return "Pendiente de rendición";
  if (status === "PENDING_REVIEW" && movementType === "PAYMENT") return "Pendiente de revisión";
  if (status === "APPROVED") return "Aprobado";
  if (status === "REJECTED") return "Rechazado";
  if (status === "REVERSED") return "Reversado";
  return status;
}

function lastMovementAt(account: WorkerAccount) {
  if (!account.last_sale_at) return account.last_payment_at;
  if (!account.last_payment_at) return account.last_sale_at;
  return new Date(account.last_sale_at) >= new Date(account.last_payment_at)
    ? account.last_sale_at
    : account.last_payment_at;
}

export function WorkerAccountPanel() {
  const { workerAccounts, ensureWorkerAccountsLoaded, invalidateWorkerAccounts, invalidateWorkerPayments } = useMermasModule();
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<WorkerAccountDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setError("");
      try {
        await ensureWorkerAccountsLoaded(search, true);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "No se pudo cargar la cuenta corriente.");
      }
    }, 180);
    return () => window.clearTimeout(timer);
    // A route revisit revalidates in the background while preserving cached data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function openDetail(account: WorkerAccount) {
    setDetailLoading(true);
    setError("");
    try {
      const response = await getWorkerAccountDetail(account.employee_id);
      if (response.data) setDetail(response.data);
      else setError(response.error ?? "No se pudo cargar el detalle.");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar el detalle.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function refreshAfterPayment() {
    if (!detail) return;
    invalidateWorkerAccounts();
    invalidateWorkerPayments();
    const [, detailResponse] = await Promise.all([
      ensureWorkerAccountsLoaded(search, true),
      getWorkerAccountDetail(detail.employee.id),
    ]);
    if (detailResponse.data) setDetail(detailResponse.data);
  }

  return (
    <div className="min-h-[calc(100vh-7.5rem)] bg-theme-bg p-3 sm:p-5">
      <div className="mx-auto max-w-[1500px] overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-sm">
        <header className="border-b border-theme-border/60 bg-theme-text/[0.012] px-5 py-4">
          <Link href="/dashboard/logistica/mermas" className="text-xs font-semibold text-theme-text-accent hover:underline">← Volver a Mermas</Link>
          <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.22em] text-theme-accent">Mermas · Cuenta corriente</p>
          <h1 className="mt-1 text-base font-semibold text-theme-text">Cuenta corriente de trabajadores</h1>
          <p className="mt-1 text-xs text-theme-text-muted">Cargos de distintas fuentes y pagos aprobados.</p>
        </header>
        <div className="space-y-4 p-4 sm:p-5">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-theme-text-muted" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar por nombre o RUT..."
              className="h-9 w-full rounded-xl border border-theme-border bg-theme-bg pl-9 pr-3 text-xs text-theme-text outline-none focus:border-theme-accent"
            />
          </div>
          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>}
          {!workerAccounts.loaded ? (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-theme-border px-4 py-10 text-xs text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" />Cargando cuentas corrientes...</div>
          ) : workerAccounts.data.length === 0 ? (
            <p className="rounded-xl border border-dashed border-theme-border px-4 py-10 text-center text-xs text-theme-text-muted">No hay trabajadores con movimientos de cuenta corriente.</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-theme-border">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                  <tr>
                    <th className="px-4 py-3">Trabajador</th>
                    <th className="px-4 py-3">RUT</th>
                    <th className="px-4 py-3 text-right">Deuda generada</th>
                    <th className="px-4 py-3 text-right">Pagado</th>
                    <th className="px-4 py-3 text-right">En revisión</th>
                    <th className="px-4 py-3 text-right">Saldo</th>
                    <th className="px-4 py-3">Último movimiento</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/70">
                  {workerAccounts.data.map((account) => (
                    <tr key={account.employee_id} onClick={() => void openDetail(account)} className="cursor-pointer hover:bg-theme-accent/[0.05]">
                      <td className="px-4 py-3"><span className="font-semibold text-theme-text">{account.employee_name}</span><span className="ml-2 rounded-full bg-theme-text/[0.06] px-2 py-0.5 text-[10px] text-theme-text-muted">{account.employee_status}</span></td>
                      <td className="px-4 py-3 font-mono text-xs text-theme-text-muted">{account.rut}</td>
                      <td className="px-4 py-3 text-right text-theme-text">{formatMoney(account.total_charges)}</td>
                      <td className="px-4 py-3 text-right text-theme-text">{formatMoney(account.approved_payments)}</td>
                      <td className="px-4 py-3 text-right text-amber-700 dark:text-amber-300">{formatMoney(account.pending_review_payments)}</td>
                      <td className="px-4 py-3 text-right font-bold text-theme-accent">{formatMoney(account.official_balance)}</td>
                      <td className="px-4 py-3 text-xs text-theme-text-muted">{formatDate(lastMovementAt(account))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {detailLoading && <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"><div className="rounded-xl bg-theme-surface px-4 py-3 text-xs text-theme-text shadow-xl"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Cargando detalle...</div></div>}
      {detail && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="worker-account-detail">
          <section className="mx-auto mt-8 max-w-4xl rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
            <header className="flex items-start justify-between border-b border-theme-border px-5 py-4">
              <div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">Cuenta corriente</p><h2 id="worker-account-detail" className="mt-1 text-lg font-semibold text-theme-text">{detail.employee.name}</h2><p className="mt-1 text-xs text-theme-text-muted">{detail.employee.rut} · {detail.employee.status}</p></div>
              <button type="button" onClick={() => setPaymentOpen(true)} disabled={detail.summary.projected_balance <= 0} className="mr-2 rounded-xl bg-theme-accent px-3 py-2 text-xs font-bold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40">Registrar pago</button>
              <button type="button" onClick={() => setDetail(null)} aria-label="Cerrar detalle" className="rounded-lg p-1 text-theme-text-muted hover:bg-theme-text/5"><X className="h-4 w-4" /></button>
            </header>
            <div className="space-y-5 p-5">
              <div className="grid gap-2 sm:grid-cols-5">
                <Metric label="Deuda generada" value={formatMoney(detail.summary.total_charges)} />
                <Metric label="Pagado aprobado" value={formatMoney(detail.summary.approved_payments)} />
                <Metric label="En revisión" value={formatMoney(detail.summary.pending_review_payments)} />
                <Metric label="Saldo oficial" value={formatMoney(detail.summary.official_balance)} />
                <Metric label="Saldo proyectado" value={formatMoney(detail.summary.projected_balance)} />
              </div>
              {detail.summary.projected_balance <= 0 && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">El saldo pendiente ya está cubierto por uno o más pagos en revisión.</p>}
              <div className="overflow-x-auto rounded-xl border border-theme-border">
                <table className="w-full min-w-[650px] text-sm"><thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Movimiento</th><th className="px-4 py-3">Referencia</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3 text-right">Monto</th></tr></thead><tbody className="divide-y divide-theme-border/70">{detail.movements.map((movement, index) => <tr key={`${movement.reference_number}-${movement.occurred_at}-${index}`}><td className="px-4 py-3 text-xs text-theme-text-muted">{formatDate(movement.occurred_at)}</td><td className="px-4 py-3 font-semibold text-theme-text">{movement.label}</td><td className="px-4 py-3 font-mono text-xs text-theme-accent">{movement.reference_number}</td><td className="px-4 py-3 text-xs text-theme-text-muted">{displayStatus(movement.status, movement.movement_type)}</td><td className="px-4 py-3 text-right font-semibold text-theme-text">{formatMoney(movement.amount)}</td></tr>)}</tbody></table>
              </div>
            </div>
          </section>
        </div>
      )}
      {paymentOpen && detail && <WorkerPaymentModal detail={detail} onClose={() => setPaymentOpen(false)} onSubmitted={() => void refreshAfterPayment()} />}
    </div>
  );
}

async function uploadWorkerPaymentEvidence(upload: WorkerPaymentUpload, file: File) {
  const client = createBrowserSupabaseClient();
  const { error } = await client.storage.from("mermas-worker-payments").uploadToSignedUrl(upload.storage_path, upload.upload_token, file, { contentType: upload.mime_type });
  if (error) {
    console.error("[MERMAS] worker payment signed upload failed", {
      message: error.message,
      status: error.status,
      statusCode: error.statusCode,
      storageError: error,
    });
    throw new Error("No se pudo subir el comprobante.");
  }
}

function WorkerPaymentModal({ detail, onClose, onSubmitted }: { detail: WorkerAccountDetail; onClose: () => void; onSubmitted: () => void }) {
  const available = detail.summary.projected_balance;
  const [mode, setMode] = useState<"total" | "partial">("total");
  const [amount, setAmount] = useState(String(available));
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [paymentNumber, setPaymentNumber] = useState("");
  const numericAmount = Number(amount);
  const validAmount = Number.isInteger(numericAmount) && numericAmount > 0 && numericAmount <= available;
  const validFile = Boolean(file);

  function chooseMode(nextMode: "total" | "partial") {
    setMode(nextMode);
    setAmount(nextMode === "total" ? String(available) : "");
    setError("");
  }

  function selectFile(nextFile: File | null) {
    setError("");
    if (!nextFile) return;
    if (!["application/pdf", "image/jpeg", "image/png"].includes(nextFile.type)) {
      setFile(null);
      setError("El comprobante debe ser PDF, JPG o PNG.");
      return;
    }
    if (nextFile.size <= 0 || nextFile.size > 10 * 1024 * 1024) {
      setFile(null);
      setError("El comprobante debe pesar entre 1 byte y 10 MB.");
      return;
    }
    setFile(nextFile);
  }

  async function submit() {
    if (!file || !validAmount || uploading || submitting) return;
    setError("");
    setSubmitting(true);
    let upload: WorkerPaymentUpload | null = null;
    try {
      const prepared = await prepareWorkerPaymentUpload({ employee_id: detail.employee.id, file_name: file.name, mime_type: file.type, size_bytes: file.size });
      if (!prepared.data) throw new Error(prepared.error ?? "No se pudo preparar el comprobante.");
      upload = prepared.data;
      setUploading(true);
      await uploadWorkerPaymentEvidence(upload, file);
      setUploading(false);
      const response = await submitWorkerPayment({
        employee_id: detail.employee.id,
        amount: numericAmount,
        upload_id: upload.upload_id,
        validation_token: upload.validation_token,
        storage_path: upload.storage_path,
        original_filename: upload.original_filename,
        mime_type: upload.mime_type,
        size_bytes: upload.size_bytes,
      });
      if (!response.success) throw new Error(response.error ?? "No se pudo enviar el pago a revisión.");
      setPaymentNumber(response.data?.payment_number ?? "");
      onSubmitted();
    } catch (submitError) {
      if (upload) await cleanupWorkerPaymentUpload(upload);
      setError(submitError instanceof Error ? submitError.message : "No se pudo enviar el pago a revisión.");
    } finally {
      setUploading(false);
      setSubmitting(false);
    }
  }

  if (paymentNumber) {
    return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"><section className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-6 text-center shadow-2xl"><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-600">Pago enviado</p><h2 className="mt-2 text-xl font-bold text-theme-text">{paymentNumber}</h2><p className="mt-3 text-sm text-theme-text-muted">El pago quedó pendiente de revisión. El saldo oficial aún no cambia.</p><button type="button" onClick={onClose} className="mt-6 rounded-xl bg-theme-accent px-4 py-2.5 text-xs font-semibold text-white">Cerrar</button></section></div>;
  }

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"><section className="w-full max-w-lg rounded-2xl border border-theme-border bg-theme-surface shadow-2xl"><header className="flex items-start justify-between border-b border-theme-border px-5 py-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">Cuenta corriente</p><h2 className="mt-1 text-lg font-semibold text-theme-text">Registrar pago</h2><p className="mt-1 text-xs text-theme-text-muted">{detail.employee.name} · {detail.employee.rut}</p></div><button type="button" onClick={onClose} disabled={submitting} aria-label="Cerrar" className="rounded-lg p-1 text-theme-text-muted hover:bg-theme-text/5"><X className="h-4 w-4" /></button></header><div className="space-y-4 p-5"><div className="grid grid-cols-3 gap-2"><Metric label="Saldo oficial" value={formatMoney(detail.summary.official_balance)} /><Metric label="En revisión" value={formatMoney(detail.summary.pending_review_payments)} /><Metric label="Disponible" value={formatMoney(available)} /></div><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => chooseMode("total")} className={`rounded-xl border px-3 py-2.5 text-xs font-bold ${mode === "total" ? "border-theme-accent bg-theme-accent/10 text-theme-accent" : "border-theme-border text-theme-text-muted"}`}>Pagar total</button><button type="button" onClick={() => chooseMode("partial")} className={`rounded-xl border px-3 py-2.5 text-xs font-bold ${mode === "partial" ? "border-theme-accent bg-theme-accent/10 text-theme-accent" : "border-theme-border text-theme-text-muted"}`}>Abono</button></div><label className="block text-xs font-semibold text-theme-text">Monto del abono<input type="number" min="1" max={available} step="1" value={amount} readOnly={mode === "total"} onChange={(event) => setAmount(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-theme-border bg-theme-bg px-3 font-mono text-sm text-theme-text outline-none focus:border-theme-accent read-only:opacity-70" />{validAmount && <span className="mt-1 block font-normal text-theme-text-muted">Saldo proyectado después del envío: <strong>{formatMoney(available - numericAmount)}</strong></span>}</label><label className="block text-xs font-semibold text-theme-text"><span className="inline-flex items-center gap-1"><Upload className="h-3.5 w-3.5" />Comprobante obligatorio</span><input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => selectFile(event.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs text-theme-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-theme-text/5 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-theme-text" /><span className="mt-1 block font-normal text-theme-text-muted">PDF, JPG o PNG · máximo 10 MB.</span>{file && <span className="mt-1 flex items-center justify-between gap-2 font-normal text-theme-text"><span className="truncate">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</span><button type="button" onClick={() => setFile(null)} disabled={submitting} className="font-semibold text-red-600">Quitar</button></span>}</label>{error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>}<button type="button" onClick={() => void submit()} disabled={!validAmount || !validFile || uploading || submitting} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 py-3 text-xs font-bold uppercase tracking-wide text-white disabled:cursor-not-allowed disabled:opacity-40">{(uploading || submitting) && <Loader2 className="h-4 w-4 animate-spin" />}{uploading ? "Subiendo comprobante..." : submitting ? "Enviando a revisión..." : "Enviar a revisión"}</button></div></section></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-theme-border bg-theme-bg px-3 py-2"><p className="text-[10px] uppercase tracking-wide text-theme-text-muted">{label}</p><p className="mt-1 text-xs font-bold text-theme-text">{value}</p></div>;
}
