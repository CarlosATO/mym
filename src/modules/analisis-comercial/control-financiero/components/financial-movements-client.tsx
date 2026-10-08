"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import {
  createFinancialLoan,
  createFinancialLoanPayment,
  voidFinancialLoan,
  voidFinancialLoanPayment,
  type Loan,
} from "@/app/actions/control-financiero/financial-movements";
import {
  createAndPostFinancialInflow,
  voidFinancialInflow,
  type FinancialInflow,
  type FinancialInflowCategory,
  type FinancialInflowType,
} from "@/app/actions/control-financiero/financial-inflows";
import { RecognizedExpensesClient } from "./recognized-expenses-client";
import type {
  ExpenseCategory,
  RecognizedExpense,
} from "@/app/actions/control-financiero/recognized-expenses";

type Tab = "movements" | "loans";
type EntryType = "loan" | FinancialInflowType;
type Dashboard = {
  loans: Loan[];
  monthFinancialExpenses: number;
  financialDebt: number;
};
const money = (value: number | string) =>
  `$${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(Number(value))}`;
const today = () => new Date().toISOString().slice(0, 10);

export function FinancialMovementsClient({
  initialData,
  categories,
  inflowCategories,
  dashboard,
  year,
  month,
}: {
  initialData: {
    rows: RecognizedExpense[];
    count: number;
    inflows: FinancialInflow[];
  };
  categories: ExpenseCategory[];
  inflowCategories: FinancialInflowCategory[];
  dashboard: Dashboard;
  year: number;
  month: number;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("movements");
  const [modal, setModal] = useState<
    | "recognized-expense"
    | "entry"
    | "loan-payment"
    | null
  >(null);
  const [entryType, setEntryType] = useState<EntryType>("loan");
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const close = () => {
    setModal(null);
    setSelectedLoan(null);
    setEntryType("loan");
    setError("");
  };
  const run = (operation: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      setError("");
      setMessage("");
      const result = await operation();
      if (!result.ok)
        setError(result.message ?? "No se pudo completar la operación.");
      else {
        setMessage("Movimiento guardado.");
        close();
        router.refresh();
      }
    });
  const askVoidReason = (label: string) =>
    window.prompt(`Motivo obligatorio para anular ${label}`)?.trim() || null;
  const tabLabel: Record<Tab, string> = {
    movements: "Movimientos",
    loans: "Préstamos",
  };
  const postedExpenses = initialData.rows
    .filter((row) => row.status === "POSTED")
    .reduce((sum, row) => sum + Number(row.recognized_amount), 0);
  return (
    <main className="min-h-[calc(100vh-8rem)] bg-[#EFE9E1] px-3 py-3 text-[#322D29] sm:px-4 sm:py-4 lg:px-6">
      <section className="mx-auto max-w-[1500px] border border-[#D1C7BD] bg-[#FCFBF9] p-3 shadow-[0_8px_24px_rgba(50,45,41,0.05)] sm:p-4 lg:p-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#D1C7BD] pb-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#72383D]">
              MOVIMIENTOS FINANCIEROS
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-[-0.03em] sm:text-xl">
              Control de movimientos no automatizados
            </h2>
            <p className="mt-1 text-xs text-[#322D29]/60">
              Registra salidas y entradas no automatizadas sin mezclar la cartola bancaria.
            </p>
          </div>
          <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
            <button
              type="button"
              onClick={() => {
                setTab("movements");
                setModal("recognized-expense");
              }}
              className="inline-flex min-h-8 items-center gap-1.5 bg-[#72383D] px-2.5 py-1.5 text-xs font-semibold text-white"
            >
              <Plus className="h-3.5 w-3.5" />
              Registrar gasto
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("movements");
                setModal("entry");
              }}
              className="inline-flex min-h-8 items-center gap-1.5 border border-[#72383D]/30 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#72383D]"
            >
              <Plus className="h-3.5 w-3.5" />
              Registrar entrada
            </button>
          </div>
        </header>
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Gastos manuales del mes" value={money(postedExpenses)} />
          <Kpi
            label="Deuda financiera"
            value={money(dashboard.financialDebt)}
          />
          <Kpi
            label="Gastos financieros del mes"
            value={money(dashboard.monthFinancialExpenses)}
          />
        </div>
        <div
          id="movement-actions"
          className="mt-3 flex max-w-full overflow-x-auto border-b border-[#D1C7BD]"
          role="tablist"
          aria-label="Movimientos financieros"
        >
          {(Object.keys(tabLabel) as Tab[]).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`whitespace-nowrap border-b-2 px-3 py-1.5 text-xs font-semibold ${tab === value ? "border-[#72383D] text-[#72383D]" : "border-transparent text-[#322D29]/55 hover:text-[#72383D]"}`}
            >
              {tabLabel[value]}
            </button>
          ))}
        </div>
        {message && (
          <p className="mt-3 border border-[#66856B]/40 bg-[#EDF4EC] px-3 py-2 text-xs text-[#426247]">
            {message}
          </p>
        )}
        {error && (
          <p className="mt-3 border border-[#A45B58]/30 bg-[#F8EDEA] px-3 py-2 text-xs text-[#8A4B4B]">
            {error}
          </p>
        )}
        {tab === "movements" && (
          <div className="mt-3">
            <RecognizedExpensesClient
              initialData={initialData}
              categories={categories}
              year={year}
              month={month}
              initialFilters={{ status: "", source: "", search: "" }}
              formOpen={modal === "recognized-expense"}
              onFormOpenChange={(open) => setModal(open ? "recognized-expense" : null)}
            />
            <FinancialInflowsHistory
              inflows={initialData.inflows}
              onVoid={(inflow) => {
                const reason = askVoidReason("la entrada");
                if (reason) run(() => voidFinancialInflow(inflow.id, reason));
              }}
            />
          </div>
        )}
        {tab === "loans" && (
          <LoansTab
            loans={dashboard.loans}
            onPayment={(loan) => {
              setSelectedLoan(loan);
              setModal("loan-payment");
            }}
            onVoidPayment={(payment) => {
              const reason = askVoidReason("la cuota");
              if (reason)
                run(() => voidFinancialLoanPayment(payment.id, reason));
            }}
            onVoidLoan={(loan) => {
              const reason = askVoidReason("el préstamo");
              if (reason) run(() => voidFinancialLoan(loan.id, reason));
            }}
          />
        )}
      </section>
      {modal && modal !== "recognized-expense" && (
        <Modal
          title={
            modal === "entry"
              ? "Registrar entrada"
              : `Registrar pago · ${selectedLoan?.loan_name ?? ""}`
          }
          onClose={close}
        >
          {modal === "entry" && (
            <EntryForm
              entryType={entryType}
              onEntryTypeChange={setEntryType}
              busy={isPending}
              year={year}
              month={month}
              categories={inflowCategories}
              onLoanSubmit={(input) => run(() => createFinancialLoan(input))}
              onInflowSubmit={(input) => run(() => createAndPostFinancialInflow(input))}
            />
          )}
          {modal === "loan-payment" && selectedLoan && (
            <LoanPaymentForm
              loan={selectedLoan}
              busy={isPending}
              onSubmit={(input) =>
                run(() =>
                  createFinancialLoanPayment({
                    ...input,
                    loanId: selectedLoan.id,
                  }),
                )
              }
            />
          )}
        </Modal>
      )}
    </main>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border border-[#D1C7BD] bg-white/70 px-2.5 py-2 sm:px-3">
      <p className="break-words text-[9px] font-bold uppercase leading-tight tracking-wider text-[#322D29]/55">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums sm:text-base">
        {value}
      </p>
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-[#322D29]/35">
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-[#D1C7BD] bg-[#FCFBF9] shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[#D1C7BD] p-4 sm:p-5">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>
      </div>
    </div>
  );
}
function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-[10px] font-bold uppercase tracking-wider text-[#322D29]/60">
      {label}
      <span className="mt-1 block text-xs font-normal normal-case tracking-normal [&>input]:w-full [&>input]:border [&>input]:border-[#D1C7BD] [&>input]:bg-white [&>input]:px-2 [&>input]:py-2 [&>select]:w-full [&>select]:border [&>select]:border-[#D1C7BD] [&>select]:bg-white [&>select]:px-2 [&>select]:py-2 [&>textarea]:w-full [&>textarea]:resize-none [&>textarea]:border [&>textarea]:border-[#D1C7BD] [&>textarea]:bg-white [&>textarea]:px-2 [&>textarea]:py-2">
        {children}
      </span>
    </label>
  );
}
function ModalActions({ busy }: { busy: boolean }) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button
        type="submit"
        disabled={busy}
        className="bg-[#72383D] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
      >
        {busy ? "Guardando…" : "Guardar"}
      </button>
    </div>
  );
}
function EntryForm({
  entryType,
  onEntryTypeChange,
  busy,
  onLoanSubmit,
  onInflowSubmit,
  year,
  month,
  categories,
}: {
  entryType: EntryType;
  onEntryTypeChange: (value: EntryType) => void;
  busy: boolean;
  year: number;
  month: number;
  categories: FinancialInflowCategory[];
  onLoanSubmit: (input: {
    lenderName: string;
    loanName: string;
    originalPrincipal: number;
    disbursementDate: string;
    contractReference: string;
    notes: string;
    idempotencyKey: string;
  }) => void;
  onInflowSubmit: (input: {
    entryType: FinancialInflowType;
    periodYear: number;
    periodMonth: number;
    amount: number;
    categoryId?: string;
    description: string;
    counterpartyName: string;
    documentDate: string;
    documentNumber: string;
    notes: string;
    idempotencyKey: string;
  }) => void;
}) {
  return (
    <div className="mt-5 space-y-4">
      <FormField label="Tipo de entrada">
        <select
          value={entryType}
          onChange={(event) => onEntryTypeChange(event.target.value as EntryType)}
        >
          <option value="loan">Préstamo recibido</option>
          <option value="OWNER_CONTRIBUTION">Aporte de socio</option>
          <option value="OTHER_INCOME">Otro ingreso</option>
        </select>
      </FormField>
      {entryType === "loan" ? (
        <LoanForm busy={busy} onSubmit={onLoanSubmit} />
      ) : (
        <ExternalInflowForm
          entryType={entryType}
          year={year}
          month={month}
          categories={categories}
          busy={busy}
          onSubmit={onInflowSubmit}
        />
      )}
    </div>
  );
}

function ExternalInflowForm({
  entryType,
  year,
  month,
  categories,
  busy,
  onSubmit,
}: {
  entryType: FinancialInflowType;
  year: number;
  month: number;
  categories: FinancialInflowCategory[];
  busy: boolean;
  onSubmit: (input: {
    entryType: FinancialInflowType;
    periodYear: number;
    periodMonth: number;
    amount: number;
    categoryId?: string;
    description: string;
    counterpartyName: string;
    documentDate: string;
    documentNumber: string;
    notes: string;
    idempotencyKey: string;
  }) => void;
}) {
  const [periodYear, setPeriodYear] = useState(String(year));
  const [periodMonth, setPeriodMonth] = useState(String(month));
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return (
    <form
      className="mt-5 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          entryType,
          periodYear: Number(periodYear),
          periodMonth: Number(periodMonth),
          amount: Number(amount),
          categoryId: entryType === "OTHER_INCOME" ? categoryId : undefined,
          description,
          counterpartyName: counterparty,
          documentDate,
          documentNumber,
          notes,
          idempotencyKey,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Período año *">
          <input required min="2000" max="2100" type="number" value={periodYear} onChange={(event) => setPeriodYear(event.target.value)} />
        </FormField>
        <FormField label="Período mes *">
          <select required value={periodMonth} onChange={(event) => setPeriodMonth(event.target.value)}>
            {Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
          </select>
        </FormField>
      </div>
      {entryType === "OTHER_INCOME" && (
        <FormField label="Categoría de ingreso *">
          <select required value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            <option value="">Seleccionar categoría</option>
            {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </FormField>
      )}
      <FormField label="Monto *">
        <input required min="1" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} />
      </FormField>
      <FormField label="Descripción *">
        <textarea required rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      </FormField>
      <FormField label="Aportante / contraparte">
        <input value={counterparty} onChange={(event) => setCounterparty(event.target.value)} />
      </FormField>
      <FormField label="Fecha documento / comprobante">
        <input type="date" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} />
      </FormField>
      <FormField label="Nº documento opcional">
        <input value={documentNumber} onChange={(event) => setDocumentNumber(event.target.value)} />
      </FormField>
      <FormField label="Observaciones">
        <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </FormField>
      <p className="text-xs text-[#322D29]/60">
        {entryType === "OWNER_CONTRIBUTION" ? "El aporte no crea deuda ni afecta el Estado de Resultados." : "El Otro ingreso se reconoce en EERR por el período seleccionado."}
      </p>
      <ModalActions busy={busy} />
    </form>
  );
}
function LoanForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: {
    lenderName: string;
    loanName: string;
    originalPrincipal: number;
    disbursementDate: string;
    contractReference: string;
    notes: string;
    idempotencyKey: string;
  }) => void;
}) {
  const [lender, setLender] = useState("");
  const [name, setName] = useState("");
  const [principal, setPrincipal] = useState("");
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return (
    <form
      className="mt-5 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          lenderName: lender,
          loanName: name,
          originalPrincipal: Number(principal),
          disbursementDate: date,
          contractReference: reference,
          notes,
          idempotencyKey,
        });
      }}
    >
      <FormField label="Banco / acreedor *">
        <input
          required
          value={lender}
          onChange={(event) => setLender(event.target.value)}
        />
      </FormField>
      <FormField label="Nombre del préstamo *">
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </FormField>
      <FormField label="Monto original *">
        <input
          required
          min="1"
          type="number"
          value={principal}
          onChange={(event) => setPrincipal(event.target.value)}
        />
      </FormField>
      <FormField label="Fecha desembolso *">
        <input
          required
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </FormField>
      <FormField label="Referencia contractual">
        <input
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
      </FormField>
      <FormField label="Notas">
        <textarea
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>
      <p className="text-xs text-[#322D29]/60">
        El registro representa deuda financiera y no crea ingreso ni gasto en el
        Estado de Resultados.
      </p>
      <ModalActions busy={busy} />
    </form>
  );
}
function LoanPaymentForm({
  loan,
  busy,
  onSubmit,
}: {
  loan: Loan;
  busy: boolean;
  onSubmit: (input: {
    paymentDate: string;
    totalAmount: number;
    principalAmount: number;
    interestAmount: number;
    feeAmount: number;
    notes: string;
    idempotencyKey: string;
    bankMovementId?: string;
  }) => void;
}) {
  const [date, setDate] = useState(today());
  const [principal, setPrincipal] = useState("");
  const [interest, setInterest] = useState("");
  const [fee, setFee] = useState("");
  const [bankMovementId, setBankMovementId] = useState("");
  const [notes, setNotes] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const total =
    Number(principal || 0) + Number(interest || 0) + Number(fee || 0);
  return (
    <form
      className="mt-5 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          paymentDate: date,
          totalAmount: total,
          principalAmount: Number(principal),
          interestAmount: Number(interest),
          feeAmount: Number(fee),
          notes,
          idempotencyKey,
          bankMovementId: bankMovementId || undefined,
        });
      }}
    >
      <p className="text-xs text-[#322D29]/60">
        Saldo de capital: {money(loan.balance_principal)}
      </p>
      <FormField label="Fecha *">
        <input
          required
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </FormField>
      <FormField label="Capital *">
        <input
          required
          min="0"
          max={loan.balance_principal}
          type="number"
          value={principal}
          onChange={(event) => setPrincipal(event.target.value)}
        />
      </FormField>
      <FormField label="Interés">
        <input
          min="0"
          type="number"
          value={interest}
          onChange={(event) => setInterest(event.target.value)}
        />
      </FormField>
      <FormField label="Comisión / gasto financiero">
        <input
          min="0"
          type="number"
          value={fee}
          onChange={(event) => setFee(event.target.value)}
        />
      </FormField>
      <FormField label="ID movimiento bancario opcional">
        <input
          value={bankMovementId}
          onChange={(event) => setBankMovementId(event.target.value)}
        />
      </FormField>
      <p className="text-xs font-semibold">Total cuota: {money(total)}</p>
      <FormField label="Notas">
        <textarea
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FormField>
      <ModalActions busy={busy} />
    </form>
  );
}

function FinancialInflowsHistory({
  inflows,
  onVoid,
}: {
  inflows: FinancialInflow[];
  onVoid: (inflow: FinancialInflow) => void;
}) {
  return (
    <section className="mt-5 border-t border-[#D1C7BD] pt-4">
      <div>
        <p className="text-sm font-semibold">Entradas externas</p>
        <p className="mt-0.5 text-xs text-[#322D29]/60">
          Aportes de socios y otros ingresos, separados de ventas y préstamos.
        </p>
      </div>
      {inflows.length === 0 ? (
        <p className="mt-3 text-xs text-[#322D29]/55">No hay entradas externas para este período.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {inflows.map(inflow => (
            <article key={inflow.id} className="border border-[#D1C7BD] bg-white/70 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">
                    {inflow.entry_type === "OWNER_CONTRIBUTION" ? "Aporte de socio" : "Otro ingreso"}
                  </p>
                  <p className="mt-0.5 text-[#322D29]/65">
                    {inflow.description}{inflow.counterparty_name ? ` · ${inflow.counterparty_name}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold tabular-nums">{money(inflow.amount)}</p>
                  <p className="text-[10px] text-[#72383D]">{inflow.status}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#322D29]/55">
                <span>Período {inflow.period_year}-{String(inflow.period_month).padStart(2, "0")}</span>
                {inflow.category?.name && <span>{inflow.category.name}</span>}
                {inflow.document_number && <span>Doc. {inflow.document_number}</span>}
                {inflow.document_date && <span>Fecha {inflow.document_date}</span>}
                {inflow.notes && <span>{inflow.notes}</span>}
              </div>
              {inflow.status !== "VOIDED" && (
                <button type="button" onClick={() => onVoid(inflow)} className="mt-2 text-[10px] font-semibold text-[#72383D]">
                  Anular entrada
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LoansTab({
  loans,
  onPayment,
  onVoidPayment,
  onVoidLoan,
}: {
  loans: Loan[];
  onPayment: (loan: Loan) => void;
  onVoidPayment: (payment: Loan["payments"][number]) => void;
  onVoidLoan: (loan: Loan) => void;
}) {
  return (
    <section className="mt-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Préstamos</p>
          <p className="mt-0.5 text-xs text-[#322D29]/60">
            El principal reduce deuda; sólo intereses y comisiones se reconocen
            como gasto.
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {loans.map((loan) => (
          <article
            key={loan.id}
            className="border border-[#D1C7BD] bg-white/70 p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-[#322D29]/55">
                  {loan.lender_name}
                </p>
                <h3 className="mt-1 text-sm font-semibold">{loan.loan_name}</h3>
              </div>
              <span className="text-[10px] font-semibold text-[#72383D]">
                {loan.status}
              </span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div>
                <dt className="text-[#322D29]/55">Original</dt>
                <dd className="mt-1 font-semibold">
                  {money(loan.original_principal)}
                </dd>
              </div>
              <div>
                <dt className="text-[#322D29]/55">Saldo capital</dt>
                <dd className="mt-1 font-semibold">
                  {money(loan.balance_principal)}
                </dd>
              </div>
              <div>
                <dt className="text-[#322D29]/55">Capital pagado</dt>
                <dd className="mt-1">{money(loan.principal_paid)}</dd>
              </div>
              <div>
                <dt className="text-[#322D29]/55">Intereses pagados</dt>
                <dd className="mt-1">{money(loan.interest_paid)}</dd>
              </div>
            </dl>
            <div className="mt-3 space-y-1">
              {loan.payments.map(
                (payment) =>
                  payment.status === "POSTED" && (
                    <button
                      key={payment.id}
                      type="button"
                      onClick={() => onVoidPayment(payment)}
                      className="block text-[10px] font-semibold text-[#72383D]"
                    >
                      Anular cuota {payment.payment_date}
                    </button>
                  ),
              )}
            </div>
            <button
              type="button"
              disabled={loan.status !== "ACTIVE"}
              onClick={() => onPayment(loan)}
              className="mt-3 w-full border border-[#72383D]/30 px-3 py-1.5 text-xs font-semibold text-[#72383D] disabled:opacity-40"
            >
              Registrar pago
            </button>
            <button
              type="button"
              disabled={
                loan.payments.some((payment) => payment.status === "POSTED") ||
                loan.status === "VOIDED"
              }
              onClick={() => onVoidLoan(loan)}
              className="mt-1.5 w-full border border-[#A45B58]/30 px-3 py-1.5 text-xs font-semibold text-[#A45B58] disabled:opacity-40"
            >
              Anular préstamo
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
