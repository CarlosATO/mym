"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  FileText,
  Loader2,
  Search,
  Upload,
  X,
  Ban,
  TrendingDown,
  TrendingUp,
  ClipboardList,
} from "lucide-react";
import {
  cleanupWorkerPaymentUpload,
  getWorkerPaymentEvidenceUrl,
  getWorkerBsaleBoletaForRegularization,
  getWorkerAccountRegularizationAccess,
  getWorkerAccountDetailV2,
  getWorkerAccountsV2,
  regularizeWorkerBsaleBoleta,
  searchWorkerRegularizationEmployees,
  prepareWorkerPaymentUpload,
  submitWorkerPayment,
  voidWorkerPayment,
  type WorkerAccountChargeV2,
  type WorkerAccountDetailV2,
  type WorkerAccountV2,
  type WorkerBsaleBoletaCandidate,
  type WorkerPaymentUpload,
  type WorkerRegularizationEmployee,
} from "@/app/actions/logistica/mermas";
import { formatInstantInSantiago } from "@/lib/datetime";
import { createClient as createBrowserSupabaseClient } from "@/lib/supabase/client";

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

function formatMoney(value: number) {
  return money.format(value);
}

function formatDate(value: string | null) {
  return value ? formatInstantInSantiago(value) : "Sin registro";
}

function lastMovementAt(account: WorkerAccountV2) {
  if (!account.last_charge_at) return account.last_payment_at;
  if (!account.last_payment_at) return account.last_charge_at;
  return new Date(account.last_charge_at) >= new Date(account.last_payment_at)
    ? account.last_charge_at
    : account.last_payment_at;
}

function paymentStatus(status: string) {
  return (
    {
      ACTIVE: "Vigente",
      VOIDED: "Anulado",
    }[status] ?? status
  );
}

function paymentStatusClass(status: string) {
  if (status === "ACTIVE") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "VOIDED") return "bg-red-500/10 text-red-700 dark:text-red-300";
  return "bg-theme-text/[0.06] text-theme-text-muted";
}

function chargeStatus(charge: WorkerAccountChargeV2) {
  if (charge.status === "REVERSED") return "REVERSADO";
  if (charge.outstanding_amount === 0 && charge.credit_note_amount > 0 && charge.approved_paid_amount === 0) return "SALDADO POR NC";
  if (charge.outstanding_amount === 0 && charge.credit_note_amount > 0) return "SALDADO";
  if (charge.outstanding_amount === 0) return "PAGADO";
  return charge.approved_paid_amount > 0 ? "PAGO PARCIAL" : "PENDIENTE";
}

function chargeStatusClass(status: string) {
  if (status === "PAGADO" || status === "SALDADO" || status === "SALDADO POR NC") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "PAGO PARCIAL") return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (status === "REVERSADO") return "bg-theme-text/[0.06] text-theme-text-muted";
  return "bg-red-500/10 text-red-700 dark:text-red-300";
}

function sourceClass(sourceType: string) {
  return sourceType === "MERMA"
    ? "bg-theme-accent/10 text-theme-accent"
    : "bg-sky-500/10 text-sky-700 dark:text-sky-300";
}

function sourceLabel(sourceType: string) {
  if (sourceType === "MERMA") return "Venta Mermas";
  if (sourceType === "BSALE_BOLETA") return "Boleta Bsale";
  return sourceType;
}

// ─── Componentes atómicos ────────────────────────────────────────────────────

function StatStrip({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border-l border-theme-border/60 px-4 first:border-l-0 first:pl-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-theme-text-muted">{label}</p>
      <p className={`text-sm font-bold tabular-nums tracking-tight ${accent ? "text-theme-accent" : "text-theme-text"}`}>
        {value}
      </p>
    </div>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[10px] uppercase tracking-wide text-theme-text-muted">{label}</p>
      <p className={`text-xs font-bold tabular-nums ${accent ? "text-theme-accent" : "text-theme-text"}`}>{value}</p>
    </div>
  );
}

function MoneyStat({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-theme-text-muted">{label}</p>
      <p className={`mt-0.5 tabular-nums ${strong ? "text-sm font-bold text-theme-accent" : "text-xs font-semibold text-theme-text"}`}>
        {formatMoney(value)}
      </p>
    </div>
  );
}

// ─── Panel principal ─────────────────────────────────────────────────────────

export function WorkerAccountPanel() {
  const [accounts, setAccounts] = useState<WorkerAccountV2[]>([]);
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<WorkerAccountDetailV2 | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [voidPayment, setVoidPayment] = useState<WorkerAccountDetailV2["payments"][number] | null>(null);
  const [regularizationOpen, setRegularizationOpen] = useState(false);
  const [canRegularize, setCanRegularize] = useState(false);

  async function loadAccounts(query: string) {
    setLoading(true);
    setError("");
    try {
      const response = await getWorkerAccountsV2(query);
      if (response.error) setError(response.error);
      setAccounts(response.data);
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "No se pudo cargar la cuenta corriente.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAccounts(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    void getWorkerAccountRegularizationAccess().then(setCanRegularize);
  }, []);

  async function openDetail(account: WorkerAccountV2) {
    setDetailLoading(true);
    setError("");
    try {
      const response = await getWorkerAccountDetailV2(account.employee_id);
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
    const [accountsResponse, detailResponse] = await Promise.all([
      getWorkerAccountsV2(search.trim()),
      getWorkerAccountDetailV2(detail.employee.id),
    ]);
    setAccounts(accountsResponse.data);
    if (detailResponse.data) setDetail(detailResponse.data);
  }

  const totals = accounts.reduce(
    (sum, account) => ({
      official: sum.official + account.official_balance,
      merma: sum.merma + account.merma_balance,
      bsale: sum.bsale + account.bsale_boleta_balance,
      pending: sum.pending + account.approved_payments,
    }),
    { official: 0, merma: 0, bsale: 0, pending: 0 },
  );

  return (
    <div className="min-h-[calc(100vh-7.5rem)] bg-theme-bg p-3 sm:p-5">
      <div className="mx-auto max-w-[1500px] overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-sm">
        <header className="border-b border-theme-border/60 bg-theme-text/[0.012] px-5 py-4 sm:px-6">
          <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.22em] text-theme-accent">
            Mermas · Cuenta corriente
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-theme-text">
            Cuenta corriente de trabajadores
          </h1>
          <p className="mt-0.5 text-sm text-theme-text-muted">
            Deudas por ventas Mermas y Boletas Bsale, pagos y saldos pendientes.
          </p>
        </header>

        <div className="space-y-4 p-4 sm:p-6">
          <div className="flex flex-wrap items-center gap-y-3 rounded-xl border border-theme-border bg-theme-bg px-4 py-3">
            <StatStrip label="Saldo total" value={formatMoney(totals.official)} accent />
            <StatStrip label="Mermas" value={formatMoney(totals.merma)} />
            <StatStrip label="Boletas Bsale" value={formatMoney(totals.bsale)} />
            <StatStrip label="Pagos vigentes" value={formatMoney(totals.pending)} />
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-theme-text-muted" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar por nombre o RUT..."
                className="h-9 w-full rounded-xl border border-theme-border bg-theme-bg pl-9 pr-3 text-sm text-theme-text outline-none focus:border-theme-accent"
              />
            </div>
            <div className="flex items-center gap-2">
              {canRegularize && (
                <button
                  type="button"
                  onClick={() => setRegularizationOpen(true)}
                  className="rounded-lg border border-theme-accent bg-theme-accent/10 px-3 py-2 text-xs font-bold text-theme-accent hover:bg-theme-accent/15"
                >
                  Regularizar boleta sin cliente
                </button>
              )}
              {loading && (
                <span className="flex items-center gap-2 text-xs text-theme-text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Actualizando
                </span>
              )}
            </div>
          </div>

          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>}

          {!loaded ? (
            <div className="flex items-center gap-2 rounded-xl border border-dashed border-theme-border px-4 py-10 text-sm text-theme-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Cargando cuentas corrientes...
            </div>
          ) : accounts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-theme-border px-4 py-10 text-center">
              <ClipboardList className="h-8 w-8 text-theme-text-muted/40" />
              <p className="text-sm text-theme-text-muted">No hay trabajadores con movimientos de cuenta corriente.</p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border border-theme-border md:block">
                <table className="w-full text-sm">
                  <thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                    <tr>
                      <th className="px-4 py-2.5">Trabajador</th>
                      <th className="px-4 py-2.5">RUT</th>
                      <th className="px-4 py-2.5 text-right">Mermas</th>
                      <th className="px-4 py-2.5 text-right">Boletas Bsale</th>
                      <th className="px-4 py-2.5 text-right">Saldo total</th>
                      <th className="px-4 py-2.5 text-right">Docs. pend.</th>
                      <th className="px-4 py-2.5">Último mov.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-theme-border/70">
                    {accounts.map((account) => (
                      <AccountRow key={account.employee_id} account={account} onClick={() => void openDetail(account)} />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2 md:hidden">
                {accounts.map((account) => (
                  <AccountMobileRow key={account.employee_id} account={account} onClick={() => void openDetail(account)} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {detailLoading && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20">
          <div className="rounded-xl bg-theme-surface px-4 py-3 text-sm text-theme-text shadow-xl">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            Cargando detalle...
          </div>
        </div>
      )}
      {detail && (
        <WorkerAccountDetailPanel
          detail={detail}
          onClose={() => setDetail(null)}
          onPayment={() => setPaymentOpen(true)}
          onVoidPayment={setVoidPayment}
        />
      )}
      {paymentOpen && detail && (
        <WorkerPaymentModal
          detail={detail}
          onClose={() => setPaymentOpen(false)}
          onSubmitted={() => void refreshAfterPayment()}
        />
      )}
      {voidPayment && detail && (
        <VoidWorkerPaymentModal
          payment={voidPayment}
          employeeName={detail.employee.name}
          onClose={() => setVoidPayment(null)}
          onCompleted={async () => {
            setVoidPayment(null);
            await refreshAfterPayment();
          }}
        />
      )}
      {regularizationOpen && (
        <WorkerBsaleBoletaRegularizationModal
          onClose={() => setRegularizationOpen(false)}
          onCompleted={() => void loadAccounts(search.trim())}
        />
      )}
    </div>
  );
}

function WorkerBsaleBoletaRegularizationModal({
  onClose,
  onCompleted,
}: {
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [folio, setFolio] = useState("");
  const [candidate, setCandidate] = useState<WorkerBsaleBoletaCandidate | null>(null);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employees, setEmployees] = useState<WorkerRegularizationEmployee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<WorkerRegularizationEmployee | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setLoadingEmployees(true);
      const response = await searchWorkerRegularizationEmployees(employeeSearch);
      setEmployees(response.data);
      if (response.error) setError(response.error);
      setLoadingEmployees(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [employeeSearch]);

  async function lookup() {
    setBusy(true);
    setError("");
    setCandidate(null);
    const response = await getWorkerBsaleBoletaForRegularization(folio);
    if (response.data) setCandidate(response.data);
    else setError(response.error ?? "No se pudo validar la Boleta.");
    setBusy(false);
  }

  async function submit() {
    if (!candidate || !selectedEmployee || !reason.trim() || busy) return;
    setBusy(true);
    setError("");
    const response = await regularizeWorkerBsaleBoleta({
      document_number: candidate.document_number,
      employee_id: selectedEmployee.id,
      reason,
    });
    if (response.success) {
      setSuccess(true);
      onCompleted();
    } else {
      setError(response.error ?? "No se pudo regularizar la Boleta.");
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true">
      <section className="w-full max-w-lg rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <header className="flex items-start justify-between border-b border-theme-border px-5 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">SUPER_USUARIO</p>
            <h2 className="mt-1 text-base font-semibold text-theme-text">Regularizar boleta sin cliente</h2>
            <p className="mt-0.5 text-xs text-theme-text-muted">Asigna una Boleta Bsale real a un trabajador activo.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Cerrar" className="rounded-lg p-1 text-theme-text-muted hover:bg-theme-text/5">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          {success ? (
            <div className="space-y-4">
              <p className="rounded-lg bg-emerald-500/10 px-3 py-3 text-sm text-emerald-700 dark:text-emerald-300">Boleta regularizada correctamente.</p>
              <button type="button" onClick={onClose} className="w-full rounded-xl bg-theme-accent px-4 py-3 text-xs font-bold text-white">Cerrar</button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <label className="block flex-1 text-xs font-semibold text-theme-text">
                  Folio
                  <input value={folio} onChange={(event) => setFolio(event.target.value)} inputMode="numeric" className="mt-1 h-10 w-full rounded-xl border border-theme-border bg-theme-bg px-3 font-mono text-sm text-theme-text outline-none focus:border-theme-accent" />
                </label>
                <button type="button" onClick={() => void lookup()} disabled={busy || !folio.trim()} className="mt-5 rounded-xl border border-theme-accent px-4 text-xs font-bold text-theme-accent disabled:opacity-40">Validar</button>
              </div>

              {candidate && (
                <div className="grid grid-cols-3 gap-2 rounded-xl border border-theme-border bg-theme-bg px-3 py-3">
                  <Metric label="Folio" value={String(candidate.document_number)} />
                  <Metric label="Fecha" value={candidate.emission_date ?? "Sin fecha"} />
                  <Metric label="Monto" value={formatMoney(candidate.total_amount)} />
                  <span className="col-span-3 text-xs font-bold text-amber-700 dark:text-amber-300">SIN CLIENTE</span>
                </div>
              )}

              <label className="block text-xs font-semibold text-theme-text">
                Trabajador ACTIVO
                <input value={employeeSearch} onChange={(event) => { setEmployeeSearch(event.target.value); setSelectedEmployee(null); }} placeholder="Buscar por nombre o RUT" className="mt-1 h-10 w-full rounded-xl border border-theme-border bg-theme-bg px-3 text-sm text-theme-text outline-none focus:border-theme-accent" />
              </label>
              <div className="max-h-32 overflow-y-auto rounded-xl border border-theme-border">
                {loadingEmployees ? <p className="px-3 py-2 text-xs text-theme-text-muted">Buscando...</p> : employees.map((employee) => (
                  <button key={employee.id} type="button" onClick={() => setSelectedEmployee(employee)} className={`block w-full border-b border-theme-border/60 px-3 py-2 text-left last:border-b-0 ${selectedEmployee?.id === employee.id ? "bg-theme-accent/10" : "hover:bg-theme-text/5"}`}>
                    <span className="block text-xs font-semibold text-theme-text">{employee.display_name}</span>
                    <span className="font-mono text-[11px] text-theme-text-muted">{employee.rut}</span>
                  </button>
                ))}
              </div>
              {selectedEmployee && <p className="text-xs text-theme-text-muted">Seleccionado: <strong className="text-theme-text">{selectedEmployee.display_name}</strong></p>}

              <label className="block text-xs font-semibold text-theme-text">
                Motivo obligatorio
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent" />
              </label>

              {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>}
              <button type="button" onClick={() => void submit()} disabled={busy || !candidate || !selectedEmployee || !reason.trim()} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 py-3 text-xs font-bold uppercase tracking-wide text-white disabled:cursor-not-allowed disabled:opacity-40">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Confirmar regularización
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Filas del listado ───────────────────────────────────────────────────────

function AccountRow({ account, onClick }: { account: WorkerAccountV2; onClick: () => void }) {
  const hasDebt = account.official_balance > 0;
  return (
    <tr onClick={onClick} className="cursor-pointer hover:bg-theme-accent/[0.04]">
      <td className="px-4 py-2.5">
        <span className="font-semibold text-theme-text">{account.employee_name}</span>
        <span className="ml-2 text-[10px] text-theme-text-muted">{account.employee_status}</span>
      </td>
      <td className="px-4 py-2.5 font-mono text-xs text-theme-text-muted">{account.rut}</td>
      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-theme-text">
        {formatMoney(account.merma_balance)}
      </td>
      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-theme-text">
        {formatMoney(account.bsale_boleta_balance)}
      </td>
      <td className={`px-4 py-2.5 text-right text-sm font-bold tabular-nums ${hasDebt ? "text-theme-accent" : "text-theme-text-muted"}`}>
        {hasDebt ? formatMoney(account.official_balance) : "Sin deuda"}
      </td>
      <td className="px-4 py-2.5 text-right">
        {account.open_charge_count > 0 ? (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500/10 text-[10px] font-bold text-red-700 dark:text-red-300">
            {account.open_charge_count}
          </span>
        ) : (
          <span className="text-xs text-theme-text-muted">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs text-theme-text-muted">{formatDate(lastMovementAt(account))}</td>
    </tr>
  );
}

function AccountMobileRow({ account, onClick }: { account: WorkerAccountV2; onClick: () => void }) {
  const hasDebt = account.official_balance > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border border-theme-border bg-theme-bg p-3 text-left transition-colors hover:bg-theme-accent/[0.04]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-theme-text">{account.employee_name}</p>
          <p className="mt-0.5 font-mono text-xs text-theme-text-muted">
            {account.rut} · {account.employee_status}
          </p>
        </div>
        <p className={`text-sm font-bold tabular-nums ${hasDebt ? "text-theme-accent" : "text-theme-text-muted"}`}>
          {hasDebt ? formatMoney(account.official_balance) : "Sin deuda"}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-theme-border/50 pt-3 text-xs">
        <div>
          <p className="text-theme-text-muted">Mermas</p>
          <p className="mt-0.5 font-semibold tabular-nums text-theme-text">{formatMoney(account.merma_balance)}</p>
        </div>
        <div>
          <p className="text-theme-text-muted">Boletas</p>
          <p className="mt-0.5 font-semibold tabular-nums text-theme-text">
            {formatMoney(account.bsale_boleta_balance)}
          </p>
        </div>
        <div>
          <p className="text-theme-text-muted">Docs. abiertos</p>
          <p className="mt-0.5 font-semibold text-theme-text">{account.open_charge_count}</p>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-theme-text-muted">
        Último movimiento: {formatDate(lastMovementAt(account))}
      </p>
    </button>
  );
}

// ─── Modal de detalle ────────────────────────────────────────────────────────

function WorkerAccountDetailPanel({
  detail,
  onClose,
  onPayment,
  onVoidPayment,
}: {
  detail: WorkerAccountDetailV2;
  onClose: () => void;
  onPayment: () => void;
  onVoidPayment: (payment: WorkerAccountDetailV2["payments"][number]) => void;
}) {
  const charges = [...detail.charges].sort((a, b) => {
    const openDiff = Number(b.outstanding_amount > 0) - Number(a.outstanding_amount > 0);
    return (
      openDiff ||
      new Date(b.document_date ?? "1970-01-01").getTime() - new Date(a.document_date ?? "1970-01-01").getTime()
    );
  });
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worker-account-detail"
    >
      <section className="mx-auto min-h-screen max-w-5xl bg-theme-surface shadow-2xl sm:min-h-0 sm:rounded-2xl sm:border sm:border-theme-border">
        <header className="sticky top-0 z-10 border-b border-theme-border bg-theme-surface px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2
                id="worker-account-detail"
                className="truncate text-base font-semibold leading-tight text-theme-text sm:text-lg"
              >
                {detail.employee.name}
              </h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-xs text-theme-text-muted">{detail.employee.rut}</span>
                <span className="h-3 w-px bg-theme-border" />
                <span
                  className={`text-[10px] font-bold uppercase tracking-wide ${detail.employee.status === "ACTIVO" ? "text-emerald-600 dark:text-emerald-400" : "text-theme-text-muted"}`}
                >
                  {detail.employee.status}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onPayment}
                disabled={detail.summary.official_balance <= 0}
                className="rounded-lg bg-theme-accent px-3 py-1.5 text-xs font-bold text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Registrar pago
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar detalle"
                className="rounded-lg p-1.5 text-theme-text-muted hover:bg-theme-text/5"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-theme-border bg-theme-bg px-3 py-2">
            <Metric label="Saldo pendiente" value={formatMoney(detail.summary.official_balance)} accent />
            <span className="hidden h-6 w-px bg-theme-border/60 sm:block" />
            <Metric label="Mermas" value={formatMoney(detail.summary.merma_balance)} />
            <Metric label="Boletas Bsale" value={formatMoney(detail.summary.bsale_boleta_balance)} />
            <span className="hidden h-6 w-px bg-theme-border/60 sm:block" />
            <Metric label="Pagos vigentes" value={formatMoney(detail.summary.approved_payments)} />
          </div>
        </header>

        <div className="space-y-6 p-4 sm:p-6">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-theme-accent">
                  Detalle financiero
                </p>
                <h3 className="mt-0.5 text-sm font-semibold text-theme-text">Deudas y documentos</h3>
              </div>
              <span className="text-xs text-theme-text-muted">
                {detail.summary.open_charge_count} abiertos · {detail.summary.paid_charge_count} pagados
              </span>
            </div>
            <div className="space-y-2">
              {charges.map((charge) => (
                <ChargeCard key={charge.charge_id} charge={charge} />
              ))}
            </div>
          </section>

          <PaymentsSection payments={detail.payments} onVoidPayment={onVoidPayment} />
          <KardexSection movements={detail.movements} />
        </div>
      </section>
    </div>
  );
}

// ─── ChargeCard ──────────────────────────────────────────────────────────────

function ChargeCard({ charge }: { charge: WorkerAccountChargeV2 }) {
  const [itemsOpen, setItemsOpen] = useState(false);
  const status = chargeStatus(charge);
  const isDimmed = status === "PAGADO" || status === "SALDADO" || status === "SALDADO POR NC" || status === "REVERSADO";
  const hasDescription = (item: WorkerAccountChargeV2["items"][number]) =>
    Boolean(
      item.variant_description &&
        item.variant_description.trim().toLowerCase() !== item.product_name?.trim().toLowerCase(),
    );

  return (
    <article
      className={`rounded-xl border border-theme-border bg-theme-bg transition-opacity ${isDimmed ? "opacity-60" : ""}`}
    >
      <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${sourceClass(charge.source_type)}`}>
              {sourceLabel(charge.source_type)}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${chargeStatusClass(status)}`}>
              {status}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-theme-text">
            <FileText className="h-3.5 w-3.5 shrink-0 text-theme-text-muted" />
            <span>{charge.document_number ?? charge.source_id}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-theme-text-muted">
            {charge.document_type ?? "Documento"} · {formatDate(charge.document_date)}
          </p>
        </div>
        <div className="grid grid-cols-4 gap-3 text-right text-xs sm:min-w-[360px]">
          <MoneyStat label="Original" value={charge.original_amount} />
          <MoneyStat label="NC" value={charge.credit_note_amount} />
          <MoneyStat label="Pagado" value={charge.approved_paid_amount} />
          <MoneyStat label="Pendiente" value={charge.outstanding_amount} strong={charge.outstanding_amount > 0} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-theme-border/60 px-3 py-2">
        <button
          type="button"
          onClick={() => setItemsOpen((open) => !open)}
          className="flex items-center gap-1 text-[11px] font-semibold text-theme-accent hover:underline"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${itemsOpen ? "rotate-180" : ""}`} />
          {itemsOpen ? "Ocultar productos" : "Ver productos"}
        </button>
        {charge.allocations.length > 0 && (
          <span className="text-[11px] text-theme-text-muted">
            {charge.allocations.length} pago{charge.allocations.length === 1 ? "" : "s"} aplicado
            {charge.allocations.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {itemsOpen && (
        <div className="border-t border-theme-border/60 px-3 py-2.5">
          {charge.items.length === 0 ? (
            <p className="text-xs text-theme-text-muted">Sin detalle de productos disponible.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-xs">
                <thead className="text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                  <tr>
                    <th className="pb-1.5 pr-3">SKU</th>
                    <th className="pb-1.5 pr-3">Producto</th>
                    <th className="pb-1.5 pr-3 text-right">Cant.</th>
                    <th className="pb-1.5 pr-3 text-right">P. unit.</th>
                    <th className="pb-1.5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/50">
                  {charge.items.map((item, index) => (
                    <tr key={`${item.sku}-${index}`}>
                      <td className="py-1.5 pr-3 font-mono text-theme-text-muted">{item.sku ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-theme-text">
                        <span>{item.product_name ?? "Producto sin nombre"}</span>
                        {hasDescription(item) && (
                          <span className="block text-[10px] text-theme-text-muted">{item.variant_description}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-theme-text">{item.quantity ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-theme-text">
                        {item.unit_price == null ? "—" : formatMoney(item.unit_price)}
                      </td>
                      <td className="py-1.5 text-right font-semibold tabular-nums text-theme-text">
                        {item.line_total == null ? "—" : formatMoney(item.line_total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {charge.allocations.length > 0 && (
        <div className="border-t border-theme-border/60 px-3 py-2.5">
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">Pagos aplicados</p>
          <div className="space-y-1">
            {charge.allocations.map((allocation) => (
              <div
                key={`${allocation.payment_id}-${allocation.amount}`}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="text-theme-text-muted">
                  {formatDate(allocation.payment_date)} · {allocation.payment_number ?? "Pago sin correlativo"}
                </span>
                <span className="font-semibold tabular-nums text-theme-text">{formatMoney(allocation.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

// ─── PaymentsSection ─────────────────────────────────────────────────────────

function PaymentsSection({
  payments,
  onVoidPayment,
}: {
  payments: WorkerAccountDetailV2["payments"];
  onVoidPayment: (payment: WorkerAccountDetailV2["payments"][number]) => void;
}) {
  return (
    <section>
      <div className="mb-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-theme-accent">Flujo de pagos</p>
        <h3 className="mt-0.5 text-sm font-semibold text-theme-text">Pagos registrados</h3>
      </div>
      {payments.length === 0 ? (
        <p className="rounded-xl border border-dashed border-theme-border px-4 py-5 text-xs text-theme-text-muted">
          No hay pagos registrados.
        </p>
      ) : (
        <div className="space-y-1.5">
          {payments.map((payment) => (
            <div key={payment.payment_id} className="rounded-xl border border-theme-border px-4 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-theme-text">
                    {payment.payment_number ?? "Pago sin correlativo"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-theme-text-muted">{formatDate(payment.submitted_at)}</p>
                </div>
                <div className="flex items-end gap-3 text-right">
                   <button
                     type="button"
                     onClick={async () => {
                       const evidenceWindow = window.open("about:blank", "_blank");
                       const response = await getWorkerPaymentEvidenceUrl(payment.payment_id);
                       if (response.url && evidenceWindow) evidenceWindow.location.href = response.url;
                       else evidenceWindow?.close();
                     }}
                     className="inline-flex items-center gap-1 text-[11px] font-semibold text-theme-accent hover:underline"
                   >
                     <ExternalLink className="h-3.5 w-3.5" />
                     Comprobante
                   </button>
                   {payment.status === "ACTIVE" && (
                     <button
                       type="button"
                       onClick={() => onVoidPayment(payment)}
                       className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600 hover:underline"
                     >
                       <Ban className="h-3.5 w-3.5" />
                       Anular pago
                     </button>
                   )}
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold tabular-nums text-theme-text">{formatMoney(payment.amount)}</p>
                  <span
                    className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${paymentStatusClass(payment.status)}`}
                  >
                    {paymentStatus(payment.status)}
                  </span>
                </div>
              </div>
              {payment.status === "ACTIVE" && payment.allocations.length > 0 && (
                <div className="mt-2 border-t border-theme-border/60 pt-2">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
                    Aplicado a:
                  </p>
                  <div className="space-y-0.5">
                    {payment.allocations.map((allocation) => (
                      <div
                        key={`${allocation.charge_id}-${allocation.amount}`}
                        className="flex justify-between gap-3 text-xs text-theme-text-muted"
                      >
                        <span>
                          {allocation.source_type === "MERMA" ? "Venta Mermas" : "Boleta Bsale"}{" "}
                          {allocation.document_number ?? ""}
                        </span>
                        <span className="font-semibold tabular-nums text-theme-text">
                          {formatMoney(allocation.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {payment.status === "VOIDED" && (
                <div className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  <strong>ANULADO</strong> · {formatDate(payment.voided_at)}
                  <span className="ml-1">· Motivo: {payment.void_reason || "Sin motivo informado"}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Kardex de deuda ─────────────────────────────────────────────────────────

type Movement = WorkerAccountDetailV2["movements"][number];

const movementPriority: Record<Movement["movement_type"], number> = {
  CHARGE: 0,
  ADJUSTMENT: 1,
  PAYMENT: 2,
};

interface KardexRow {
  movement: Movement;
  cargo: number;
  abono: number;
  runningBalance: number;
}

function buildKardex(movements: Movement[]): KardexRow[] {
  const sorted = [...movements]
    .filter((m) => {
      if (m.movement_type === "CHARGE" && m.status === "REVERSED") return false;
      return true;
    })
    .sort((a, b) => {
      const occurredAtDifference = new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime();
      if (occurredAtDifference !== 0) return occurredAtDifference;

      const priorityDifference = movementPriority[a.movement_type] - movementPriority[b.movement_type];
      if (priorityDifference !== 0) return priorityDifference;

      const referenceDifference = a.reference_number.localeCompare(b.reference_number);
      if (referenceDifference !== 0) return referenceDifference;

      return (a.charge_id ?? a.payment_id ?? "").localeCompare(b.charge_id ?? b.payment_id ?? "");
    });

  let balance = 0;
  return sorted.map((m) => {
    const cargo = m.movement_type === "CHARGE" ? m.amount : 0;
    const abono =
      m.movement_type === "PAYMENT" && m.status === "ACTIVE"
        ? m.amount
        : m.movement_type === "ADJUSTMENT" && m.source_type === "BSALE_NOTA_CREDITO"
        ? Math.abs(m.amount)
        : 0;
    balance = Math.max(balance + cargo - abono, 0);
    return { movement: m, cargo, abono, runningBalance: balance };
  });
}

function KardexSection({ movements }: { movements: WorkerAccountDetailV2["movements"] }) {
  const [open, setOpen] = useState(true);
  const rows = buildKardex(movements);

  return (
    <section className="border-t border-theme-border pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-sm font-semibold text-theme-text"
      >
        <span className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-theme-text-muted" />
          Kardex de deuda
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3">
          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-theme-border px-4 py-5 text-xs text-theme-text-muted">
              Sin movimientos para mostrar en el kardex.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-theme-border">
              <table className="w-full min-w-[680px] text-xs">
                <thead className="bg-theme-bg text-left text-[10px] uppercase tracking-wider text-theme-text-muted">
                  <tr>
                    <th className="px-3 py-2">Fecha</th>
                    <th className="px-3 py-2">Concepto</th>
                    <th className="px-3 py-2">Referencia</th>
                    <th className="px-3 py-2 text-right">Cargo</th>
                    <th className="px-3 py-2 text-right">Abono</th>
                    <th className="px-3 py-2 text-right">Saldo</th>
                    <th className="px-3 py-2">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/60">
                  {rows.map((row, index) => (
                    <KardexRowItem key={`kardex-${index}`} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function KardexRowItem({ row }: { row: KardexRow }) {
  const { movement, cargo, abono, runningBalance } = row;
  const isCharge = movement.movement_type === "CHARGE";
  const conceptLabel = isCharge
    ? movement.source_type
      ? sourceLabel(movement.source_type)
      : "Cargo"
    : movement.movement_type === "ADJUSTMENT" && movement.source_type === "BSALE_NOTA_CREDITO"
    ? "Nota de crédito Bsale"
    : "Pago";

  return (
    <tr className={`${movement.status === "VOIDED" ? "bg-red-500/[0.04]" : ""} hover:bg-theme-accent/[0.03]`}>
      <td className="px-3 py-2 text-theme-text-muted">{formatDate(movement.occurred_at)}</td>
      <td className="px-3 py-2">
        <span className="flex items-center gap-1.5 font-semibold text-theme-text">
          {isCharge ? (
            <TrendingUp className="h-3.5 w-3.5 text-red-500" />
          ) : (
            <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />
          )}
          {conceptLabel}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-theme-accent">{movement.reference_number}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {cargo > 0 ? (
          <span className="font-semibold text-red-700 dark:text-red-400">{formatMoney(cargo)}</span>
        ) : (
          <span className="text-theme-text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {abono > 0 ? (
          <span className="font-semibold text-emerald-700 dark:text-emerald-400">{formatMoney(abono)}</span>
        ) : (
          <span className="text-theme-text-muted">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        <span className={`font-bold ${runningBalance > 0 ? "text-theme-accent" : "text-theme-text-muted"}`}>
          {formatMoney(runningBalance)}
        </span>
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
            movement.movement_type === "PAYMENT"
              ? paymentStatusClass(movement.status)
              : movement.movement_type === "ADJUSTMENT"
              ? "bg-sky-500/10 text-sky-700 dark:text-sky-300"
              : "bg-theme-text/[0.06] text-theme-text-muted"
          }`}
        >
          {movement.movement_type === "PAYMENT"
            ? paymentStatus(movement.status)
            : movement.movement_type === "ADJUSTMENT"
            ? "Abono NC"
            : "Cargo"}
        </span>
      </td>
    </tr>
  );
}

// ─── Modal de pago ───────────────────────────────────────────────────────────

async function uploadWorkerPaymentEvidence(upload: WorkerPaymentUpload, file: File) {
  const client = createBrowserSupabaseClient();
  const { error } = await client.storage
    .from("mermas-worker-payments")
    .uploadToSignedUrl(upload.storage_path, upload.upload_token, file, { contentType: upload.mime_type });
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

function WorkerPaymentModal({
  detail,
  onClose,
  onSubmitted,
}: {
  detail: WorkerAccountDetailV2;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const available = detail.summary.official_balance;
  const [amount, setAmount] = useState(String(available));
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [paymentNumber, setPaymentNumber] = useState("");
  const numericAmount = Number(amount);
  const validAmount = Number.isInteger(numericAmount) && numericAmount > 0 && numericAmount <= available;
  const validFile = Boolean(file);

  function selectFile(nextFile: File | null) {
    setError("");
    if (!nextFile) return;
    if (!["application/pdf", "image/jpeg", "image/png"].includes(nextFile.type)) {
      setFile(null);
      return setError("El comprobante debe ser PDF, JPG o PNG.");
    }
    if (nextFile.size <= 0 || nextFile.size > 10 * 1024 * 1024) {
      setFile(null);
      return setError("El comprobante debe pesar entre 1 byte y 10 MB.");
    }
    setFile(nextFile);
  }

  async function submit() {
    if (!file || !validAmount || uploading || submitting) return;
    setSubmitting(true);
    setError("");
    let upload: WorkerPaymentUpload | null = null;
    try {
      const prepared = await prepareWorkerPaymentUpload({
        employee_id: detail.employee.id,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      });
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
      if (!response.success) throw new Error(response.error ?? "No se pudo registrar el pago.");
      setPaymentNumber(response.data?.payment_number ?? "");
      onSubmitted();
    } catch (submitError) {
      if (upload) await cleanupWorkerPaymentUpload(upload);
      setError(submitError instanceof Error ? submitError.message : "No se pudo registrar el pago.");
    } finally {
      setUploading(false);
      setSubmitting(false);
    }
  }

  if (paymentNumber)
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4">
        <section className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-6 text-center shadow-2xl">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-600">Pago registrado</p>
          <h2 className="mt-2 text-xl font-bold text-theme-text">{paymentNumber}</h2>
          <p className="mt-3 text-sm text-theme-text-muted">
            El pago quedó vigente y el saldo fue actualizado inmediatamente.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-6 rounded-xl bg-theme-accent px-4 py-2.5 text-xs font-semibold text-white"
          >
            Cerrar
          </button>
        </section>
      </div>
    );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4">
      <section className="w-full max-w-lg rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <header className="flex items-start justify-between border-b border-theme-border px-5 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">Cuenta corriente</p>
            <h2 className="mt-1 text-base font-semibold text-theme-text">Registrar pago</h2>
            <p className="mt-0.5 text-xs text-theme-text-muted">
              {detail.employee.name} · {detail.employee.rut}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Cerrar"
            className="rounded-lg p-1 text-theme-text-muted hover:bg-theme-text/5"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-5 rounded-xl border border-theme-border bg-theme-bg px-3 py-2">
            <Metric label="Deuda actual" value={formatMoney(available)} accent />
            <Metric label="Pago ingresado" value={validAmount ? formatMoney(numericAmount) : "—"} />
            <Metric label="Saldo pendiente" value={validAmount ? formatMoney(available - numericAmount) : "—"} />
          </div>

          <label className="block text-xs font-semibold text-theme-text">
            Monto del abono
            <input
              type="number"
              min="1"
              max={available}
              step="1"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-1 h-10 w-full rounded-xl border border-theme-border bg-theme-bg px-3 font-mono text-sm text-theme-text outline-none focus:border-theme-accent"
            />
            {validAmount && (
              <span className="mt-1 block font-normal text-theme-text-muted">
                Saldo pendiente después del pago:{" "}
                <strong>{formatMoney(available - numericAmount)}</strong>
              </span>
            )}
          </label>

          <label className="block text-xs font-semibold text-theme-text">
            <span className="inline-flex items-center gap-1">
              <Upload className="h-3.5 w-3.5" />
              Comprobante obligatorio
            </span>
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-xs text-theme-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-theme-text/5 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-theme-text"
            />
            <span className="mt-1 block font-normal text-theme-text-muted">PDF, JPG o PNG · máximo 10 MB.</span>
            {file && (
              <span className="mt-1 flex items-center justify-between gap-2 font-normal text-theme-text">
                <span className="truncate">
                  {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
                </span>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  disabled={submitting}
                  className="font-semibold text-red-600"
                >
                  Quitar
                </button>
              </span>
            )}
          </label>

          {error && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!validAmount || !validFile || uploading || submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 py-3 text-xs font-bold uppercase tracking-wide text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {(uploading || submitting) && <Loader2 className="h-4 w-4 animate-spin" />}
            {uploading ? "Subiendo comprobante..." : submitting ? "Registrando pago..." : "Registrar pago"}
          </button>
        </div>
      </section>
    </div>
  );
}

function VoidWorkerPaymentModal({
  payment,
  employeeName,
  onClose,
  onCompleted,
}: {
  payment: WorkerAccountDetailV2["payments"][number];
  employeeName: string;
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    const cleanReason = reason.trim();
    if (!cleanReason) {
      setError("El motivo de anulación es obligatorio.");
      return;
    }
    setBusy(true);
    setError("");
    const response = await voidWorkerPayment(payment.payment_id, cleanReason);
    if (!response.success) {
      setError(response.error ?? "No se pudo anular el pago.");
      setBusy(false);
      return;
    }
    await onCompleted();
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4">
      <section className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
        <header className="flex items-start justify-between border-b border-theme-border px-5 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-red-600">Anular pago</p>
            <h2 className="mt-1 text-base font-semibold text-theme-text">
              {payment.payment_number ?? "Pago sin correlativo"}
            </h2>
            <p className="mt-0.5 text-xs text-theme-text-muted">
              {employeeName} · {formatMoney(payment.amount)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Cerrar"
            className="rounded-lg p-1 text-theme-text-muted hover:bg-theme-text/5"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 p-5">
          <label className="block text-xs font-semibold text-theme-text">
            Motivo de anulación
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              autoFocus
              placeholder="Indica por qué se anula este pago..."
              className="mt-1 w-full resize-none rounded-xl border border-theme-border bg-theme-bg px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-accent"
            />
          </label>
          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600">{error}</p>}
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-xs font-bold uppercase tracking-wide text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar anulación
          </button>
        </div>
      </section>
    </div>
  );
}
