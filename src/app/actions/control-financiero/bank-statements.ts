"use server";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getActiveCompanyId } from "@/app/actions/companies";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseBankStatement,
  parseDefinitiveBankStatement,
  parseCurrentBankStatementXls,
  parseItauStatementText,
  extractItauPdfText,
  type ParsedBankMovement,
  type ParsedBankStatement,
} from "@/lib/control-financiero/bank-statement-parser";
import {
  buildOpenMovementKeys,
  compareFinalCloseMovements,
  compareOpenMovements,
  type ExistingFinalCloseMovement,
} from "@/lib/control-financiero/open-bank-statement";
import { resolveLatestKnownBalances } from "@/lib/control-financiero/current-balance";
import { todayInSantiago } from "@/lib/datetime";
import { FINANCIAL_DAILY_REVIEW_CUTOFF } from "@/lib/control-financiero/config";

type Db = any;
const db = () => createAdminClient().schema("comercial") as Db;
const CASH_FLOW_PATH = "/dashboard/analisis-comercial/control-financiero/flujo-caja";

export type FinancialBankAccount = {
  id: string;
  bank_name: string;
  account_type: string;
  account_number: string;
  currency: string;
  is_active: boolean;
};
export type FinancialAccountBalance = {
  accountId: string;
  bankName: string;
  maskedAccountNumber: string;
  balance: number | null;
  balanceDate: string | null;
  creditLineUsed: number | null;
  creditLineAvailable: number | null;
};
export type CashFlowMovement = {
  id: string;
  bank_account_id: string;
  transaction_date: string;
  operation_description: string;
  credit_amount: number | string;
  debit_amount: number | string;
  balance_after: number | string;
  source_row_number: number;
  direction: string | null;
  normalized_description: string | null;
  classification_signature: string | null;
  category_id: string | null;
  category_name: string | null;
  counterparty: string | null;
  classification_note: string | null;
  classification_source: string | null;
  classification_rule_id: string | null;
  classified_at: string | null;
  review_status: "HISTORICAL" | "PENDING" | "REVIEWED" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
};
export type ImportMode = "CLOSED" | "OPEN" | "FINAL_CLOSE";
export type FinancialBankReconciliationDifference = {
  id: string;
  company_id: string;
  bank_account_id: string;
  statement_period_id: string;
  detected_import_id: string;
  detected_at: string;
  financial_date: string;
  amount_signed: number | string;
  expected_balance: number | string;
  reported_balance: number | string;
  previous_known_balance: number | string | null;
  status: "PENDING" | "IDENTIFIED" | "RESOLVED";
  reason_type: string | null;
  category_id: string | null;
  counterparty: string | null;
  note: string | null;
  resolved_movement_id: string | null;
  resolved_at: string | null;
};

function hasConsistentOpenRowBalances(parsed: ParsedBankStatement) {
  return (
    parsed.validations.rowDifference === 0 ||
    (parsed.validations.rowDifferenceCount === 1 &&
      parsed.validations.rowDifferenceTotal === parsed.validations.globalDifference)
  );
}

async function authenticatedContext() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const companyId = await getActiveCompanyId(user);
  if (!user || !companyId)
    throw new Error("La sesión o la empresa activa no están disponibles.");
  return { user, companyId };
}

function normalizeAccount(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

function buildBankMovementFingerprint(
  accountId: string,
  row: ParsedBankMovement,
) {
  return createHash("sha256")
    .update(
      [
        accountId,
        row.date,
        row.description,
        row.debit,
        row.credit,
        row.balance,
        row.documentNumber ?? "",
        row.transactionNumber ?? "",
        row.branch ?? "",
        row.cashier ?? "",
      ].join("|"),
    )
    .digest("hex");
}

function periodKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export async function getFinancialBankAccounts(): Promise<
  FinancialBankAccount[]
> {
  const { companyId } = await authenticatedContext();
  const { data, error } = await db()
    .from("financial_bank_accounts")
    .select("id,bank_name,account_type,account_number,currency,is_active")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("bank_name");
  if (error) throw new Error(error.message);
  return (data ?? []) as FinancialBankAccount[];
}

export async function createFinancialBankAccount(input: {
  bankName: string;
  accountType: string;
  accountNumber: string;
  currency?: string;
}) {
  const { companyId } = await authenticatedContext();
  const accountNumber = normalizeAccount(input.accountNumber);
  if (!input.bankName.trim() || !accountNumber)
    return {
      ok: false as const,
      message: "Banco y número de cuenta son obligatorios.",
    };
  const { data, error } = await db()
    .from("financial_bank_accounts")
    .insert({
      company_id: companyId,
      bank_name: input.bankName.trim(),
      account_type: input.accountType || "CHECKING",
      account_number: accountNumber,
      currency: input.currency || "CLP",
    })
    .select("id,bank_name,account_type,account_number,currency,is_active")
    .single();
  if (error)
    return {
      ok: false as const,
      message:
        error.code === "23505"
          ? "La cuenta ya existe para esta empresa."
          : error.message,
    };
  revalidatePath(CASH_FLOW_PATH);
  return { ok: true as const, account: data };
}

function parseHistoricalFile(bytes: Uint8Array) {
  return parseBankStatement(new TextDecoder("windows-1252").decode(bytes));
}

function parseDefinitiveFile(bytes: Uint8Array) {
  return parseDefinitiveBankStatement(new TextDecoder("windows-1252").decode(bytes));
}

async function parseItauFile(bytes: Uint8Array) {
  return parseItauStatementText(await extractItauPdfText(bytes));
}

function importMetadata(parsed: ParsedBankStatement, accountId: string) {
  return {
    parser: parsed.sourceFormat,
    order: parsed.order,
    account_holder: parsed.accountHolder,
    bank_name: parsed.bankName,
    bank_account_id: accountId,
    ...(parsed.creditLineTotal !== null && parsed.creditLineTotal !== undefined
      ? { credit_line_total: parsed.creditLineTotal }
      : {}),
    ...(parsed.creditLineUsed !== null && parsed.creditLineUsed !== undefined
      ? { credit_line_used: parsed.creditLineUsed }
      : {}),
    ...(parsed.creditLineAvailable !== null && parsed.creditLineAvailable !== undefined
      ? { credit_line_available: parsed.creditLineAvailable }
      : {}),
  };
}

type ExistingOpenRow = {
  movement_identity: string;
  movement_content_hash: string;
  credit_amount: number | string;
  debit_amount: number | string;
  transaction_date: string;
  operation_description: string;
  balance_after: number | string;
  source_row_number: number;
  document_number: string | null;
};

async function loadOpenContext(
  companyId: string,
  accountId: string,
  year: number,
  month: number,
) {
  const accountResult = await db()
    .from("financial_bank_accounts")
    .select("id,account_number,bank_name,account_type,currency,is_active")
    .eq("id", accountId)
    .eq("company_id", companyId)
    .eq("is_active", true)
    .maybeSingle();
  if (accountResult.error || !accountResult.data)
    throw new Error("La cuenta no pertenece a la empresa activa.");
  const { data: period, error: periodError } = await db()
    .from("financial_statement_periods")
    .select(
      "id,status,opening_balance,total_credits,total_debits,current_balance,coverage_through,first_transaction_date,last_transaction_date,movement_count",
    )
    .eq("company_id", companyId)
    .eq("bank_account_id", accountId)
    .eq("year", year)
    .eq("month", month)
    .maybeSingle();
  if (periodError) throw new Error(periodError.message);
  if (period?.status === "CLOSED")
    throw new Error("El período seleccionado ya está cerrado.");
  const { data: closedPeriods, error: closedError } = await db()
    .from("financial_statement_periods")
    .select("year,month,closing_balance,last_transaction_date")
    .eq("company_id", companyId)
    .eq("bank_account_id", accountId)
    .eq("status", "CLOSED")
    .order("year", { ascending: false })
    .order("month", { ascending: false });
  if (closedError) throw new Error(closedError.message);
  const previous =
    (closedPeriods ?? []).find(
      (row: any) => periodKey(row.year, row.month) < periodKey(year, month),
    ) ?? null;
  let existingRows: ExistingOpenRow[] = [];
  if (period) {
    const result = await db()
      .from("financial_bank_movements")
      .select(
        "movement_identity,movement_content_hash,credit_amount,debit_amount,transaction_date,operation_description,balance_after,source_row_number,document_number",
      )
      .eq("company_id", companyId)
      .eq("bank_account_id", accountId)
      .eq("statement_period_id", period.id);
    if (result.error) throw new Error(result.error.message);
    existingRows = (result.data ?? []) as ExistingOpenRow[];
  }
  return { account: accountResult.data, period, previous, existingRows };
}

export async function previewFinancialBankStatement(formData: FormData) {
  const { companyId } = await authenticatedContext();
  const file = formData.get("file");
  const requestedMode = formData.get("mode");
  const mode =
    requestedMode === "OPEN"
      ? ("OPEN" as const)
      : requestedMode === "FINAL_CLOSE"
        ? ("FINAL_CLOSE" as const)
        : ("CLOSED" as const);
  if (!(file instanceof File))
    return { ok: false as const, message: "Selecciona una cartola." };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const accountId = String(formData.get("accountId") ?? "");
    if (!accountId)
      return {
        ok: false as const,
        message: "Selecciona una cuenta para analizar la cartola.",
      };
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const { data: alreadyProcessed } = await db()
      .from("financial_imports")
      .select("id")
      .eq("company_id", companyId)
      .eq("file_hash", fileHash)
      .maybeSingle();
    if (alreadyProcessed)
      return { ok: false as const, message: "Este archivo ya fue procesado." };
    const isItauPdf = file.name.toLowerCase().endsWith(".pdf");
    const parsed = isItauPdf
      ? await parseItauFile(bytes)
      : mode === "FINAL_CLOSE"
        ? parseDefinitiveFile(bytes)
        : mode === "OPEN"
          ? parseCurrentBankStatementXls(bytes)
          : parseHistoricalFile(bytes);
    const accountResult = await db()
      .from("financial_bank_accounts")
      .select("account_number")
      .eq("id", accountId)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .maybeSingle();
    if (accountResult.error || !accountResult.data)
      return {
        ok: false as const,
        message: "La cuenta seleccionada no pertenece a la empresa activa.",
      };
    if (
      parsed.accountNumber &&
      normalizeAccount(parsed.accountNumber) !==
        normalizeAccount(accountResult.data.account_number)
    )
      return {
        ok: false as const,
        message: "La cuenta de la cartola no coincide con la cuenta seleccionada.",
      };
    if (mode === "CLOSED") {
      if (
        parsed.validations.globalDifference !== 0 ||
        parsed.validations.rowDifference !== 0
      )
        return {
          ok: false as const,
          message: `La cartola no concilia. Diferencia global: ${parsed.validations.globalDifference}; fila a fila: ${parsed.validations.rowDifference}.`,
        };
      return { ok: true as const, mode, filename: file.name, fileHash, parsed };
    }

    if (mode === "FINAL_CLOSE") {
      const context = await loadOpenContext(
        companyId,
        accountId,
        parsed.year,
        parsed.month,
      );
      if (context.period?.status !== "OPEN")
        return {
          ok: false as const,
          message: "El cierre definitivo sólo aplica a un período OPEN existente.",
        };
      if (
        parsed.sourceFormat !== "HISTORICAL_SEMICOLON" &&
        parsed.sourceFormat !== "ITAU_PDF"
      )
        return {
          ok: false as const,
          message: "El archivo no corresponde a una cartola definitiva.",
        };
      const diff = compareFinalCloseMovements(
        accountId,
        parsed.movements,
        context.existingRows as ExistingFinalCloseMovement[],
      );
      const previousClosingBalance = Number(
        context.previous?.closing_balance ?? context.period.opening_balance,
      );
      const openingDifference = parsed.openingBalance - previousClosingBalance;
      const canConfirm =
        diff.conflictIndexes.length === 0 &&
        diff.existingMissingIndexes.length === 0 &&
        diff.ambiguousIndexes.length === 0 &&
        parsed.validations.globalDifference === 0 &&
        parsed.validations.rowDifference === 0 &&
        openingDifference === 0;
      return {
        ok: true as const,
        mode,
        filename: file.name,
        fileHash,
        parsed,
        finalPreview: {
          year: parsed.year,
          month: parsed.month,
          account: context.account,
          periodStatus: "OPEN" as const,
          existingCount: context.existingRows.length,
          rowsInFile: parsed.rowCount,
          matchedCount: diff.matchedExisting,
          newCount: diff.newIndexes.length,
          conflictCount: diff.conflictIndexes.length,
          ambiguousCount: diff.ambiguousIndexes.length,
          previousClosingBalance,
          detectedOpeningBalance: parsed.openingBalance,
          openingDifference,
          closingBalance: parsed.closingBalance,
          globalDifference: parsed.validations.globalDifference,
          rowDifference: parsed.validations.rowDifference,
          existingNotInFileCount: diff.existingMissingIndexes.length,
          movementCount: parsed.rowCount,
          canConfirm,
          conflictIndexes: [...diff.conflictIndexes, ...diff.ambiguousIndexes],
          conflicts: [...diff.conflictIndexes, ...diff.ambiguousIndexes].map((index) => ({
            index,
            date: parsed.movements[index].date,
            description: parsed.movements[index].description,
            balance: parsed.movements[index].balance,
          })),
        },
      };
    }
    const currentDate = todayInSantiago();
    const currentYear = Number(currentDate.slice(0, 4));
    const currentMonth = Number(currentDate.slice(5, 7));
    if (parsed.year !== currentYear || parsed.month !== currentMonth)
      return {
        ok: false as const,
        message: `El archivo corresponde a ${periodKey(parsed.year, parsed.month)}, pero el mes actual es ${periodKey(currentYear, currentMonth)}.`,
      };
    const context = await loadOpenContext(
      companyId,
      accountId,
      parsed.year,
      parsed.month,
    );
    if (
      parsed.sourceFormat !== "CURRENT_XLS" &&
      parsed.sourceFormat !== "ITAU_PDF"
    )
      return {
        ok: false as const,
        message: "El archivo no corresponde a una actualización mensual.",
      };
    const keys = buildOpenMovementKeys(accountId, parsed.movements);
    const diff = compareOpenMovements(keys, context.existingRows);
    const previousClosingBalance = Number(
      context.previous?.closing_balance ?? parsed.openingBalance,
    );
    const openingDifference = parsed.openingBalance - previousClosingBalance;
    const newRows = diff.newIndexes.map((index) => parsed.movements[index]);
    const newCredits = newRows.reduce((sum, row) => sum + row.credit, 0);
    const newDebits = newRows.reduce((sum, row) => sum + row.debit, 0);
    const knownBalanceBefore = Number(
      context.period?.current_balance ?? context.previous?.closing_balance ?? 0,
    );
    const coveragePrevious = context.period?.coverage_through ?? null;
    const resultingBalance =
      !context.period || parsed.lastTransactionDate >= (coveragePrevious ?? "")
        ? parsed.closingBalance
        : knownBalanceBefore;
    const explainedBalance = knownBalanceBefore + newCredits - newDebits;
    const fileGlobalDifference =
      parsed.closingBalance -
      (parsed.openingBalance + parsed.totalCredits - parsed.totalDebits);
    const incrementalDifference = resultingBalance - explainedBalance;
    const fileIdentitySet = new Set(keys.map((key) => key.movement_identity));
    const existingNotInFileCount = context.existingRows.filter(
      (row) => !fileIdentitySet.has(row.movement_identity),
    ).length;
    const reconciliationConsistent =
      fileGlobalDifference === incrementalDifference;
    const canConfirm =
      diff.conflicts === 0 &&
      existingNotInFileCount === 0 &&
      hasConsistentOpenRowBalances(parsed) &&
      openingDifference === 0 &&
      reconciliationConsistent;
    return {
      ok: true as const,
      mode,
      filename: file.name,
      fileHash,
      parsed,
      openPreview: {
        year: parsed.year,
        month: parsed.month,
        account: context.account,
        periodStatus: "OPEN" as const,
        existingCount: context.existingRows.length,
        rowsInFile: parsed.rowCount,
        newCount: diff.new,
        conflictCount: diff.conflicts,
        previousClosingBalance,
        detectedOpeningBalance: parsed.openingBalance,
        openingDifference,
        coveragePrevious,
        coverageNew: parsed.lastTransactionDate,
        currentBalanceBefore: knownBalanceBefore,
        resultingBalance,
        explainedBalance,
        reconciliationDifference: incrementalDifference,
        totalCredits: parsed.totalCredits,
        totalDebits: parsed.totalDebits,
        newCredits,
        newDebits,
        newNet: newCredits - newDebits,
        knownBalanceBefore,
        fileGlobalDifference,
        fileRowDifference: parsed.validations.rowDifference,
        incrementalDifference,
        reconciliationConsistent,
        existingNotInFileCount,
        movementCount: context.existingRows.length + diff.new,
        canConfirm,
        conflictIndexes: diff.conflictIndexes,
        conflicts: diff.conflictIndexes.map((index) => ({
          index,
          date: parsed.movements[index].date,
          description: parsed.movements[index].description,
          balance: parsed.movements[index].balance,
        })),
      },
    };
  } catch (error) {
    return {
      ok: false as const,
      message:
        error instanceof Error
          ? error.message
          : "No se pudo analizar la cartola.",
    };
  }
}

export async function confirmFinancialBankStatement(input: {
  accountId: string;
  filename: string;
  fileHash: string;
  parsed: ParsedBankStatement;
}) {
  const { companyId, user } = await authenticatedContext();
  const accountResult = await db()
    .from("financial_bank_accounts")
    .select("id,account_number")
    .eq("id", input.accountId)
    .eq("company_id", companyId)
    .eq("is_active", true)
    .maybeSingle();
  if (accountResult.error || !accountResult.data)
    return {
      ok: false as const,
      message: "La cuenta no pertenece a la empresa activa.",
    };
  if (
    input.parsed.accountNumber &&
    normalizeAccount(input.parsed.accountNumber) !==
      normalizeAccount(accountResult.data.account_number)
  )
    return {
      ok: false as const,
      message:
        "La cuenta de la cartola no coincide con la cuenta seleccionada.",
    };
  if (input.parsed.validations.rowDifference !== 0)
    return {
      ok: false as const,
      message: "La cartola no concilia y no puede confirmarse.",
    };
  const keys = buildOpenMovementKeys(input.accountId, input.parsed.movements);
  const movements = input.parsed.movements.map((row, index) => ({
    transaction_date: row.date,
    operation_description: row.description,
    credit_amount: row.credit,
    debit_amount: row.debit,
    balance_after: row.balance,
    document_number: row.documentNumber,
    transaction_number: row.transactionNumber,
    branch: row.branch,
    cashier: row.cashier,
    source_row_number: row.sourceRowNumber,
    fingerprint: buildBankMovementFingerprint(input.accountId, row),
    movement_identity: keys[index].movement_identity,
    movement_content_hash: keys[index].movement_content_hash,
    raw_payload: row.raw,
  }));
  const { data, error } = await db().rpc("confirm_financial_bank_statement", {
    p_company_id: companyId,
    p_bank_account_id: input.accountId,
    p_import: {
      original_filename: input.filename,
      file_hash: input.fileHash,
        metadata: importMetadata(input.parsed, input.accountId),
    },
    p_period: {
      year: input.parsed.year,
      month: input.parsed.month,
      opening_balance: input.parsed.openingBalance,
      total_credits: input.parsed.totalCredits,
      total_debits: input.parsed.totalDebits,
      closing_balance: input.parsed.closingBalance,
      first_transaction_date: input.parsed.firstTransactionDate,
      last_transaction_date: input.parsed.lastTransactionDate,
    },
    p_movements: movements,
    p_imported_by: user.id,
  });
  if (error) return { ok: false as const, message: error.message };
  revalidatePath(CASH_FLOW_PATH);
  return { ok: true as const, result: data };
}

export async function confirmOpenFinancialBankStatement(input: {
  accountId: string;
  filename: string;
  fileHash: string;
  parsed: ParsedBankStatement;
}) {
  const { companyId, user } = await authenticatedContext();
  if (
    input.parsed.sourceFormat !== "CURRENT_XLS" &&
    input.parsed.sourceFormat !== "ITAU_PDF"
  )
    return {
      ok: false as const,
      message: "El archivo no corresponde al formato de actualización mensual.",
    };
  const context = await loadOpenContext(
    companyId,
    input.accountId,
    input.parsed.year,
    input.parsed.month,
  );
  if (
    input.parsed.accountNumber &&
    normalizeAccount(input.parsed.accountNumber) !==
      normalizeAccount(context.account.account_number)
  )
    return {
      ok: false as const,
      message:
        "La cuenta de la cartola no coincide con la cuenta seleccionada.",
    };
  if (
    !context.period &&
    (!context.previous ||
      input.parsed.openingBalance !== Number(context.previous.closing_balance))
  )
    return {
      ok: false as const,
      message:
        "El saldo inicial no coincide con el cierre del período anterior.",
    };
  if (!hasConsistentOpenRowBalances(input.parsed))
    return {
      ok: false as const,
      message: "La cartola no concilia y no puede confirmarse.",
    };
  const keys = buildOpenMovementKeys(input.accountId, input.parsed.movements);
  const diff = compareOpenMovements(keys, context.existingRows);
  if (diff.conflicts)
    return {
      ok: false as const,
      message: `Hay ${diff.conflicts} conflicto(s) de contenido. Resuélvelos antes de confirmar.`,
    };
  const newRows = diff.newIndexes.map((index) => ({
    row: input.parsed.movements[index],
    key: keys[index],
  }));
  const newCredits = newRows.reduce((sum, item) => sum + item.row.credit, 0);
  const newDebits = newRows.reduce((sum, item) => sum + item.row.debit, 0);
  const knownBalanceBefore = Number(
    context.period?.current_balance ?? context.previous?.closing_balance ?? 0,
  );
  const coveragePrevious = context.period?.coverage_through ?? null;
  const currentBalance =
    !context.period ||
    input.parsed.lastTransactionDate >= (coveragePrevious ?? "")
      ? input.parsed.closingBalance
      : knownBalanceBefore;
  const explainedBalance = knownBalanceBefore + newCredits - newDebits;
  const fileGlobalDifference =
    input.parsed.closingBalance -
    (input.parsed.openingBalance +
      input.parsed.totalCredits -
      input.parsed.totalDebits);
  const incrementalDifference = currentBalance - explainedBalance;
  const fileIdentitySet = new Set(keys.map((key) => key.movement_identity));
  const existingNotInFileCount = context.existingRows.filter(
    (row) => !fileIdentitySet.has(row.movement_identity),
  ).length;
  const previousClosingBalance = Number(
    context.previous?.closing_balance ?? input.parsed.openingBalance,
  );
  const openingDifference =
    input.parsed.openingBalance - previousClosingBalance;
  if (
    existingNotInFileCount ||
    !hasConsistentOpenRowBalances(input.parsed) ||
    openingDifference !== 0 ||
    fileGlobalDifference !== incrementalDifference
  ) {
    return {
      ok: false as const,
      message: `La conciliación OPEN no es válida. Archivo: ${fileGlobalDifference}; incremental: ${incrementalDifference}; filas fuera del archivo: ${existingNotInFileCount}.`,
    };
  }
  const firstDate = context.period
    ? [
        context.period.first_transaction_date,
        input.parsed.firstTransactionDate,
      ].sort()[0]
    : input.parsed.firstTransactionDate;
  const lastDate = context.period
    ? [context.period.last_transaction_date, input.parsed.lastTransactionDate]
        .sort()
        .at(-1)!
    : input.parsed.lastTransactionDate;
  const movements = newRows.map(({ row, key }) => ({
    transaction_date: row.date,
    operation_description: row.description,
    credit_amount: row.credit,
    debit_amount: row.debit,
    balance_after: row.balance,
    document_number: row.documentNumber,
    transaction_number: row.transactionNumber,
    branch: row.branch,
    cashier: row.cashier,
    source_row_number: row.sourceRowNumber,
    movement_identity: key.movement_identity,
    movement_content_hash: key.movement_content_hash,
    raw_payload: row.raw,
  }));
  const { data, error } = await db().rpc(
    "confirm_financial_bank_statement_open",
    {
      p_company_id: companyId,
      p_bank_account_id: input.accountId,
      p_import: {
        original_filename: input.filename,
        file_hash: input.fileHash,
        rows_in_file: input.parsed.rowCount,
        metadata: {
          ...importMetadata(input.parsed, input.accountId),
          parser:
            input.parsed.sourceFormat === "ITAU_PDF"
              ? "ITAU_PDF"
              : "bank-statement-current-xls-v1",
          existing_count: diff.existing,
          new_count: diff.new,
          conflict_count: diff.conflicts,
          coverage_from: input.parsed.firstTransactionDate,
          coverage_to: input.parsed.lastTransactionDate,
          resulting_balance: currentBalance,
        },
      },
      p_period: {
        year: input.parsed.year,
        month: input.parsed.month,
        opening_balance: context.period
          ? Number(context.period.opening_balance)
          : Number(context.previous?.closing_balance),
        total_credits: input.parsed.totalCredits,
        total_debits: input.parsed.totalDebits,
        current_balance: currentBalance,
        coverage_through:
          context.period &&
          coveragePrevious &&
          input.parsed.lastTransactionDate < coveragePrevious
            ? coveragePrevious
            : input.parsed.lastTransactionDate,
        first_transaction_date: firstDate,
        last_transaction_date: lastDate,
        movement_count: context.existingRows.length + newRows.length,
      },
      p_movements: movements,
      p_imported_by: user.id,
      p_reconciliation: {
        coverage_date: input.parsed.lastTransactionDate,
        expected_balance: explainedBalance,
        reported_balance: currentBalance,
        amount_signed: incrementalDifference,
      },
    },
  );
  if (error) return { ok: false as const, message: error.message };
  revalidatePath(CASH_FLOW_PATH);
  return { ok: true as const, result: data };
}

export async function confirmFinalFinancialBankStatement(input: {
  accountId: string;
  filename: string;
  fileHash: string;
  parsed: ParsedBankStatement;
}) {
  const { companyId, user } = await authenticatedContext();
  if (
    input.parsed.sourceFormat !== "HISTORICAL_SEMICOLON" &&
    input.parsed.sourceFormat !== "ITAU_PDF"
  )
    return { ok: false as const, message: "La cartola no corresponde al formato definitivo." };
  const context = await loadOpenContext(
    companyId,
    input.accountId,
    input.parsed.year,
    input.parsed.month,
  );
  if (context.period?.status !== "OPEN")
    return { ok: false as const, message: "El período debe estar OPEN para cerrarlo definitivamente." };
  if (
    input.parsed.accountNumber &&
    normalizeAccount(input.parsed.accountNumber) !==
      normalizeAccount(context.account.account_number)
  )
    return { ok: false as const, message: "La cuenta de la cartola no coincide con la cuenta seleccionada." };
  if (
    input.parsed.validations.globalDifference !== 0 ||
    input.parsed.validations.rowDifference !== 0
  )
    return { ok: false as const, message: "La cartola definitiva no concilia." };
  const diff = compareFinalCloseMovements(
    input.accountId,
    input.parsed.movements,
    context.existingRows as ExistingFinalCloseMovement[],
  );
  const previousClosingBalance = Number(
    context.previous?.closing_balance ?? context.period.opening_balance,
  );
  const openingDifference = input.parsed.openingBalance - previousClosingBalance;
  if (
    diff.conflictIndexes.length ||
    diff.ambiguousIndexes.length ||
    diff.existingMissingIndexes.length ||
    openingDifference !== 0
  )
    return {
      ok: false as const,
      message: `La cartola definitiva no coincide con el período OPEN. Conflictos: ${diff.conflictIndexes.length}; ambiguos: ${diff.ambiguousIndexes.length}; filas ausentes: ${diff.existingMissingIndexes.length}; diferencia inicial: ${openingDifference}.`,
    };
  const generatedKeys = buildOpenMovementKeys(input.accountId, input.parsed.movements);
  const movements = input.parsed.movements.map((row, index) => {
    const matched = diff.matchedByFile.get(index);
    const key = matched
      ? {
          movement_identity: matched.movement_identity,
          movement_content_hash: matched.movement_content_hash,
        }
      : generatedKeys[index];
    return {
    transaction_date: row.date,
    operation_description: row.description,
    credit_amount: row.credit,
    debit_amount: row.debit,
    balance_after: row.balance,
    document_number: row.documentNumber,
    transaction_number: row.transactionNumber,
    branch: row.branch,
    cashier: row.cashier,
    source_row_number: row.sourceRowNumber,
    fingerprint: buildBankMovementFingerprint(input.accountId, row),
    movement_identity: key.movement_identity,
    movement_content_hash: key.movement_content_hash,
    raw_payload: row.raw,
    };
  });
  const { data, error } = await db().rpc("finalize_financial_bank_statement_open", {
    p_company_id: companyId,
    p_bank_account_id: input.accountId,
    p_import: {
      original_filename: input.filename,
      file_hash: input.fileHash,
        metadata: {
          ...importMetadata(input.parsed, input.accountId),
          parser:
            input.parsed.sourceFormat === "ITAU_PDF"
              ? "ITAU_PDF"
              : "bank-statement-definitive-semicolon-v1",
        existing_count: diff.matchedExisting,
        new_count: diff.newIndexes.length,
        conflict_count: diff.conflictIndexes.length + diff.ambiguousIndexes.length,
      },
    },
    p_period: {
      year: input.parsed.year,
      month: input.parsed.month,
      opening_balance: input.parsed.openingBalance,
      total_credits: input.parsed.totalCredits,
      total_debits: input.parsed.totalDebits,
      closing_balance: input.parsed.closingBalance,
      first_transaction_date: input.parsed.firstTransactionDate,
      last_transaction_date: input.parsed.lastTransactionDate,
    },
    p_movements: movements,
    p_imported_by: user.id,
  });
  if (error) return { ok: false as const, message: error.message };
  revalidatePath(CASH_FLOW_PATH);
  return { ok: true as const, result: data };
}

export async function updateFinancialBankReconciliationDifference(input: {
  id: string;
  status: "IDENTIFIED";
  reasonType?: string;
  counterparty?: string;
  note?: string;
}) {
  const { companyId } = await authenticatedContext();
  if (input.status !== "IDENTIFIED")
    return {
      ok: false as const,
      message: "Solo se permite pasar una incidencia PENDING a IDENTIFIED.",
    };
  const { data, error } = await db()
    .from("financial_bank_reconciliation_differences")
    .update({
      status: input.status,
      reason_type: input.reasonType || null,
      counterparty: input.counterparty?.trim() || null,
      note: input.note?.trim() || null,
    })
    .eq("company_id", companyId)
    .eq("id", input.id)
    .eq("status", "PENDING")
    .select("id,status,reason_type,counterparty,note,resolved_at")
    .maybeSingle();
  if (error) return { ok: false as const, message: error.message };
  if (!data)
    return {
      ok: false as const,
      message:
        "La incidencia no pertenece a la empresa activa o ya no está PENDING.",
    };
  revalidatePath(CASH_FLOW_PATH);
  return { ok: true as const, difference: data };
}

export type CashFlowDashboard = Awaited<
  ReturnType<typeof getCashFlowDashboard>
>;

export async function getCashFlowDashboard(
  year: number,
  month: number,
  accountId?: string,
  page = 1,
  classificationFilter: "ALL" | "PENDING" | "REVIEWED" | "HISTORICAL" = "ALL",
  search = "",
  categoryId?: string,
  scope: "month" | "year" = "month",
  direction: "all" | "credit" | "debit" = "all",
): Promise<{
  companyId: string;
  accounts: FinancialBankAccount[];
  accountBalances: FinancialAccountBalance[];
  currentBalance: number;
  currentDate: string | null;
  annual: {
    openingBalance: number | null;
    credits: number;
    debits: number;
    movements: number;
    monthsImported: number;
    closedMonths: number;
    openMonths: number;
  };
  monthly: {
    openingBalance: number;
    credits: number;
    debits: number;
    closingBalance: number | null;
    currentBalance: number;
    movements: number;
    pendingMovements: number;
    knownBalanceBefore: number | null;
    explainedBalance: number;
    reconciliationDifference: number;
    reconciliation: FinancialBankReconciliationDifference | null;
    status: "CLOSED" | "OPEN";
  } | null;
  movements: CashFlowMovement[];
  pageSize: number;
  page: number;
  movementTotal: number;
  pendingMovements: number;
  pageFilters: {
    classificationFilter: "ALL" | "PENDING" | "REVIEWED" | "HISTORICAL";
    search: string;
    categoryId: string | null;
    scope: "month" | "year";
    direction: "all" | "credit" | "debit";
  };
  coverage: number[];
}> {
  const { companyId } = await authenticatedContext();
  const accountsQuery = db()
    .from("financial_bank_accounts")
    .select("id,bank_name,account_type,account_number,currency,is_active")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("bank_name");
  const periodsQuery = db()
    .from("financial_statement_periods")
    .select(
      "id,bank_account_id,year,month,status,opening_balance,total_credits,total_debits,closing_balance,current_balance,coverage_through,first_transaction_date,last_transaction_date,movement_count",
    )
    .eq("company_id", companyId)
    .eq("year", year);
  const currentPeriodsQuery = db()
    .from("financial_statement_periods")
    .select(
      "bank_account_id,year,month,status,closing_balance,current_balance,coverage_through,last_transaction_date",
    )
    .eq("company_id", companyId);
  if (accountId) {
    periodsQuery.eq("bank_account_id", accountId);
  }
  const { data: accounts, error: accountsError } = await accountsQuery;
  const { data: periods, error: periodsError } =
    await periodsQuery.order("month");
  const { data: currentPeriods, error: currentPeriodsError } =
    await currentPeriodsQuery;
  if (accountsError || periodsError || currentPeriodsError)
    throw new Error(
      accountsError?.message ??
        periodsError?.message ??
        currentPeriodsError?.message,
    );
  const latest = resolveLatestKnownBalances(
    accounts ?? [],
    currentPeriods ?? [],
    accountId,
  );
  const latestAll = resolveLatestKnownBalances(accounts ?? [], currentPeriods ?? []);
  const { data: imports, error: importsError } = await db()
    .from("financial_imports")
    .select("metadata,imported_at")
    .eq("company_id", companyId)
    .order("imported_at", { ascending: false })
    .limit(500);
  if (importsError) throw new Error(importsError.message);
  const latestCreditLineByAccount = new Map<
    string,
    { used: number | null; available: number | null }
  >();
  for (const imported of imports ?? []) {
    const metadata = imported.metadata as Record<string, unknown> | null;
    const importedAccountId =
      typeof metadata?.bank_account_id === "string"
        ? metadata.bank_account_id
        : null;
    if (!importedAccountId || latestCreditLineByAccount.has(importedAccountId))
      continue;
    const used = Number(metadata?.credit_line_used);
    const available = Number(metadata?.credit_line_available);
    if (Number.isFinite(used) || Number.isFinite(available))
      latestCreditLineByAccount.set(importedAccountId, {
        used: Number.isFinite(used) ? used : null,
        available: Number.isFinite(available) ? available : null,
      });
  }
  const accountBalances = (accounts ?? []).map((account: FinancialBankAccount) => {
    const latestAccount = latestAll.get(account.id);
    const creditLine = latestCreditLineByAccount.get(account.id);
    return {
      accountId: account.id,
      bankName: account.bank_name,
      maskedAccountNumber: `•••• ${account.account_number.slice(-4)}`,
      balance: latestAccount?.balance ?? null,
      balanceDate: latestAccount?.date ?? null,
      creditLineUsed: creditLine?.used ?? null,
      creditLineAvailable: creditLine?.available ?? null,
    };
  });
  const selectedPeriods = (periods ?? []).filter(
    (row: any) => row.month === month,
  );
  const selectedPeriodIds = selectedPeriods.map((row: any) => row.id);
  const differencesResult = selectedPeriodIds.length
    ? await db()
        .from("financial_bank_reconciliation_differences")
      .select(
        "id,company_id,bank_account_id,statement_period_id,detected_import_id,detected_at,financial_date,amount_signed,expected_balance,reported_balance,previous_known_balance,status,reason_type,category_id,counterparty,note,resolved_movement_id,resolved_at",
      )
        .eq("company_id", companyId)
        .in("statement_period_id", selectedPeriodIds)
        .order("detected_at", { ascending: false })
    : { data: [], error: null };
  if (differencesResult.error) throw new Error(differencesResult.error.message);
  const reconciliation = (differencesResult.data?.[0] ??
    null) as FinancialBankReconciliationDifference | null;
  let knownBalanceBefore: number | null = null;
  if (reconciliation?.previous_known_balance !== null && reconciliation?.previous_known_balance !== undefined)
    knownBalanceBefore = Number(reconciliation.previous_known_balance);
  const start = scope === "year"
    ? `${year}-01-01`
    : `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = scope === "year"
    ? `${year + 1}-01-01`
    : new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const countQuery = db()
    .from("financial_bank_movements")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .gte("transaction_date", start)
    .lt("transaction_date", endDate);
  if (accountId) countQuery.eq("bank_account_id", accountId);
  if (classificationFilter === "PENDING") countQuery.eq("review_status", "PENDING").eq("direction", "DEBE");
  if (classificationFilter === "REVIEWED") countQuery.eq("review_status", "REVIEWED").eq("direction", "DEBE");
  if (classificationFilter === "HISTORICAL") countQuery.eq("review_status", "HISTORICAL").eq("direction", "DEBE");
  if (categoryId) countQuery.eq("category_id", categoryId);
  if (direction === "credit") countQuery.gt("credit_amount", 0);
  if (direction === "debit") countQuery.gt("debit_amount", 0);
  const normalizedSearch = search.trim().replace(/[%_]/g, "");
  if (normalizedSearch)
    countQuery.ilike("operation_description", `%${normalizedSearch}%`);
  const { count: movementTotal } = await countQuery;
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil((movementTotal ?? 0) / pageSize));
  const safePage = Math.min(totalPages, Math.max(1, Math.floor(page)));
  const movementQuery = db()
    .from("financial_bank_movements")
    .select(
      "id,bank_account_id,transaction_date,operation_description,credit_amount,debit_amount,balance_after,source_row_number,direction,normalized_description,classification_signature,category_id,counterparty,classification_note,classification_source,classification_rule_id,classified_at,review_status,reviewed_by,reviewed_at",
    )
    .eq("company_id", companyId)
    .gte("transaction_date", start)
    .lt("transaction_date", endDate)
    .order("transaction_date")
    .order("source_row_number")
    .range((safePage - 1) * pageSize, safePage * pageSize - 1);
  if (accountId) movementQuery.eq("bank_account_id", accountId);
  if (classificationFilter === "PENDING") movementQuery.eq("review_status", "PENDING").eq("direction", "DEBE");
  if (classificationFilter === "REVIEWED") movementQuery.eq("review_status", "REVIEWED").eq("direction", "DEBE");
  if (classificationFilter === "HISTORICAL") movementQuery.eq("review_status", "HISTORICAL").eq("direction", "DEBE");
  if (categoryId) movementQuery.eq("category_id", categoryId);
  if (direction === "credit") movementQuery.gt("credit_amount", 0);
  if (direction === "debit") movementQuery.gt("debit_amount", 0);
  if (normalizedSearch)
    movementQuery.ilike("operation_description", `%${normalizedSearch}%`);
  const { data: movements, error: movementError } = await movementQuery;
  if (movementError) throw new Error(movementError.message);
  const annualPeriods = periods ?? [];
  const firstPeriodByAccount = new Map<string, any>();
  for (const period of annualPeriods)
    if (!firstPeriodByAccount.has(period.bank_account_id))
      firstPeriodByAccount.set(period.bank_account_id, period);
  const initial = annualPeriods.length
    ? Array.from(firstPeriodByAccount.values()).reduce(
        (sum, period) => sum + Number(period.opening_balance),
        0,
      )
    : null;
  const annual = {
    openingBalance: initial,
    credits: annualPeriods.reduce(
      (n: number, row: any) => n + Number(row.total_credits),
      0,
    ),
    debits: annualPeriods.reduce(
      (n: number, row: any) => n + Number(row.total_debits),
      0,
    ),
    movements: annualPeriods.reduce(
      (n: number, row: any) => n + Number(row.movement_count),
      0,
    ),
    monthsImported: new Set(annualPeriods.map((row: any) => row.month)).size,
    closedMonths: new Set(
      annualPeriods
        .filter((row: any) => row.status === "CLOSED")
        .map((row: any) => row.month),
    ).size,
    openMonths: new Set(
      annualPeriods
        .filter((row: any) => row.status === "OPEN")
        .map((row: any) => row.month),
    ).size,
  };
  const pendingCountQuery = db()
    .from("financial_bank_movements")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .gte("transaction_date", start)
    .lt("transaction_date", endDate)
    .eq("review_status", "PENDING")
    .eq("direction", "DEBE")
    .gte("transaction_date", FINANCIAL_DAILY_REVIEW_CUTOFF);
  if (accountId) pendingCountQuery.eq("bank_account_id", accountId);
  const { count: pendingMovements } = await pendingCountQuery;
  const monthly = selectedPeriods.length
    ? selectedPeriods.reduce(
        (sum: any, row: any) => ({
          openingBalance: sum.openingBalance + Number(row.opening_balance),
          credits: sum.credits + Number(row.total_credits),
          debits: sum.debits + Number(row.total_debits),
          closingBalance:
            sum.closingBalance === null || row.closing_balance === null
              ? null
              : sum.closingBalance + Number(row.closing_balance),
          currentBalance: sum.currentBalance + Number(row.current_balance),
          movements: sum.movements + Number(row.movement_count),
           pendingMovements: pendingMovements ?? 0,
           knownBalanceBefore: reconciliation ? knownBalanceBefore : null,
           explainedBalance: reconciliation
            ? Number(reconciliation.expected_balance)
            : sum.explainedBalance + Number(row.current_balance),
          reconciliationDifference: reconciliation
            ? Number(reconciliation.amount_signed)
            : 0,
          reconciliation,
          status: row.status === "OPEN" ? "OPEN" : sum.status,
        }),
        {
          openingBalance: 0,
          credits: 0,
          debits: 0,
          closingBalance: 0,
          currentBalance: 0,
          movements: 0,
          pendingMovements: 0,
          knownBalanceBefore: null,
          explainedBalance: 0,
          reconciliationDifference: 0,
          reconciliation: null,
          status: "CLOSED",
        },
      )
    : null;
  const { data: categories } = await db()
    .from("financial_categories")
    .select("id,name")
    .eq("company_id", companyId)
    .eq("is_active", true);
  const categoryNames = new Map(
    (categories ?? []).map((category: any) => [category.id, category.name]),
  );
  const classifiedMovements = (movements ?? []).map((movement: any) => ({
    ...movement,
    category_name: movement.category_id
      ? (categoryNames.get(movement.category_id) ?? null)
      : null,
  }));
  return {
    companyId,
    accounts: (accounts ?? []) as FinancialBankAccount[],
    accountBalances,
    currentBalance: Array.from(latest.values()).reduce(
      (n, row) => n + row.balance,
      0,
    ),
    currentDate:
      Array.from(latest.values())
        .map((row) => row.date)
        .sort()
        .at(-1) ?? null,
    annual,
    monthly,
    movements: classifiedMovements as CashFlowMovement[],
    pageSize,
    page: safePage,
    movementTotal: movementTotal ?? 0,
    pendingMovements: pendingMovements ?? 0,
    pageFilters: {
      classificationFilter,
      search,
      categoryId: categoryId ?? null,
      scope,
      direction,
    },
    coverage: annualPeriods.map((row: any) => row.month),
  };
}
