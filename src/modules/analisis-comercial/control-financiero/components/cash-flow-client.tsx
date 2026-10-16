"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  confirmFinancialBankStatement,
  confirmOpenFinancialBankStatement,
  confirmFinalFinancialBankStatement,
  createFinancialBankAccount,
  previewFinancialBankStatement,
  updateFinancialBankReconciliationDifference,
  type CashFlowDashboard,
  type FinancialBankAccount,
} from "@/app/actions/control-financiero/bank-statements";
import {
  getFinancialMovementClassificationContext as loadMovementContext,
  classifyFinancialMovement as saveClassification,
  confirmFinancialMovementClassification,
  updateFinancialMovementObservationAction,
  updateFinancialMovementCategoryAction,
  classifyPendingDebitMovements,
  classifyPendingDebitAudit,
  classifyOffBookPersonnelMovements,
  createFinancialPersonnelBeneficiary,
  createFinancialClassificationRule as saveRule,
  getPendingDebitGroupMovements,
  getPendingDebitAudit,
  previewFinancialClassificationRule as loadRulePreview,
  type FinancialCategory,
  type PersonnelBeneficiary,
} from "@/app/actions/control-financiero/classification";
import {
  bankMovementDirection,
  categoryTreatment,
  eligibleFinancialCategories,
  filterCategoriesByTreatment,
  type CategoryTreatment,
} from "@/lib/control-financiero/classification";
import {
  completeFinancialPayrollPaymentDraftAction,
  getFinancialPayrollPaymentDraftAction,
  saveFinancialPayrollPaymentDraftAction,
} from "@/app/actions/control-financiero/payroll";

const MONTHS = [
  "ENE",
  "FEB",
  "MAR",
  "ABR",
  "MAY",
  "JUN",
  "JUL",
  "AGO",
  "SEP",
  "OCT",
  "NOV",
  "DIC",
];
const ALL_ACCOUNTS = "all";
const money = (value: number | null | undefined) =>
  value === null || value === undefined
    ? "—"
    : `$${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(value)}`;
const date = (value: string | null) =>
  value ? value.split("-").reverse().join("-") : "—";
const bankDisplayName = (value: string) =>
  value.replace(/^Caylo\s+/i, "").replace(/^Itau$/i, "Itaú");
const accountLabel = (account: FinancialBankAccount) =>
  `${bankDisplayName(account.bank_name)} · •••• ${account.account_number.slice(-4)}`;
const isItauBank = (bankName: string | undefined) => /ita[uú]/i.test(bankName ?? "");
const isBancoChileBank = (bankName: string | undefined) => /banco\s+de\s+chile/i.test(bankName ?? "");
const PAYROLL_MONTHS: Record<string, number> = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6,
  JUL: 7, AGO: 8, SEP: 9, OCT: 10, NOV: 11, DIC: 12,
};
type PayrollAllocationDraft = {
  id: string;
  workerNameSnapshot: string;
  workerRut: string;
  amount: string;
};
function payrollPeriodFromDescription(description: string | null, transactionDate: string) {
  const match = description?.toUpperCase().match(/\b(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\w*\s+(20\d{2})\b/);
  if (match && PAYROLL_MONTHS[match[1]]) return { year: match[2], month: String(PAYROLL_MONTHS[match[1]]) };
  return { year: transactionDate.slice(0, 4), month: String(Number(transactionDate.slice(5, 7))) };
}
function payrollStatusLabel(status: string | null | undefined) {
  return {
    PENDING_PAYROLL: "Pendiente de Libro",
    MATCHED: "Conciliado",
    AMOUNT_DIFFERENCE: "Diferencia de monto",
    NOT_FOUND_IN_PAYROLL: "No encontrado en Libro",
    NOT_APPLICABLE: "Fuera de libro",
    DRAFT: "Borrador",
    COMPLETE: "Desglose completo",
  }[status ?? ""] ?? status ?? "Pendiente";
}
const categoryRootOrder = [
  "INCOME",
  "EXPENSE",
  "INCOME_NON_OPERATING",
  "EXPENSE_NON_OPERATING",
];
function categoryGroups(categories: FinancialCategory[]) {
  const roots = new Map(
    categories
      .filter((category) => !category.parent_id)
      .map((category) => [category.code, category]),
  );
  return categoryRootOrder
    .map((code) => ({
      root: roots.get(code),
      children: categories
        .filter((category) => category.parent_id === roots.get(code)?.id)
        .sort(
          (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
        ),
    }))
    .filter((group) => group.root);
}
function debitCategoryGroups(categories: FinancialCategory[]) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const roots = new Map(
    categories
      .filter((category) => !category.parent_id)
      .map((category) => [category.code, category]),
  );
  const pathToRoot = (category: FinancialCategory) => {
    const path: FinancialCategory[] = [];
    const visited = new Set<string>();
    let current: FinancialCategory | undefined = category;
    while (current && !visited.has(current.id)) {
      path.unshift(current);
      visited.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return path;
  };
  const leaves = categories.filter(
    (category) =>
      category.parent_id &&
      !categories.some((child) => child.parent_id === category.id) &&
      (category.direction === "EXPENSE" || category.direction === "BOTH") &&
      (category.cash_direction === "DEBIT" || category.cash_direction === "BOTH") &&
      category.affects_cash_flow,
  );

  return categoryRootOrder
    .map((code) => {
      const root = roots.get(code);
      if (!root) return null;
      const children = leaves
        .map((category) => ({ category, path: pathToRoot(category) }))
        .filter(({ path }) => path[0]?.id === root.id)
        .sort(
          (a, b) =>
            a.category.sort_order - b.category.sort_order ||
            a.category.name.localeCompare(b.category.name),
        )
        .map(({ category, path }) => ({
          ...category,
          displayName: path.slice(1).map((item) => item.name).join(" / "),
        }));
      return { root, children };
    })
    .filter((group): group is { root: FinancialCategory; children: Array<FinancialCategory & { displayName: string }> } => Boolean(group?.children.length));
}
function categoryPath(category: FinancialCategory, categories: FinancialCategory[]) {
  const byId = new Map(categories.map((item) => [item.id, item]));
  const path: FinancialCategory[] = [];
  const visited = new Set<string>();
  let current: FinancialCategory | undefined = category;
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path.map((item) => item.name).join(" / ");
}
type Preview = Extract<
  Awaited<ReturnType<typeof previewFinancialBankStatement>>,
  { ok: true }
>;
type Reconciliation = NonNullable<
  NonNullable<CashFlowDashboard["monthly"]>["reconciliation"]
>;
type ClassificationContext = Awaited<ReturnType<typeof loadMovementContext>>;
type RulePreview = Awaited<ReturnType<typeof loadRulePreview>>;
type PendingDebitAudit = Awaited<ReturnType<typeof getPendingDebitAudit>>;
type PendingDebitAuditDetail = Awaited<ReturnType<typeof getPendingDebitGroupMovements>>;

export function CashFlowClient({
  data,
  categories: initialCategories,
  beneficiaries: initialBeneficiaries,
  canClassify,
  year,
  month,
  accountId,
}: {
  data: CashFlowDashboard;
  categories: FinancialCategory[];
  beneficiaries: PersonnelBeneficiary[];
  canClassify: boolean;
  year: number;
  month: number;
  accountId?: string;
}) {
  const router = useRouter();
  const [isFiltering, startFiltering] = useTransition();
  const [importOpen, setImportOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditData, setAuditData] = useState<PendingDebitAudit | null>(null);
  const [auditAccountId, setAuditAccountId] = useState(ALL_ACCOUNTS);
  const [auditCategoryId, setAuditCategoryId] = useState("");
  const [auditCreateRule, setAuditCreateRule] = useState(false);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditSelected, setAuditSelected] = useState<string[]>([]);
  const [auditPreviewOpen, setAuditPreviewOpen] = useState(false);
  const [auditMessage, setAuditMessage] = useState("");
  const [auditLoading, startAudit] = useTransition();
  const [auditApplying, startAuditApply] = useTransition();
  const [auditDetailGroup, setAuditDetailGroup] = useState<PendingDebitAudit["groups"][number] | null>(null);
  const [auditDetailData, setAuditDetailData] = useState<PendingDebitAuditDetail | null>(null);
  const [auditDetailSelected, setAuditDetailSelected] = useState<string[]>([]);
  const [auditDetailCategoryId, setAuditDetailCategoryId] = useState("");
  const [auditDetailCreateRule, setAuditDetailCreateRule] = useState(false);
  const [auditDetailBeneficiaries, setAuditDetailBeneficiaries] = useState<Record<string, string>>({});
  const [auditDetailConcepts, setAuditDetailConcepts] = useState<Record<string, "SUELDO" | "QUINCENA" | "BONO" | "ANTICIPO" | "OTRO">>({});
  const [auditDetailPreviewOpen, setAuditDetailPreviewOpen] = useState(false);
  const [auditDetailMessage, setAuditDetailMessage] = useState("");
  const [auditDetailLoading, startAuditDetail] = useTransition();
  const [auditDetailApplying, startAuditDetailApply] = useTransition();
  const [bankAccounts, setBankAccounts] = useState(data.accounts);
  const categories = initialCategories;
  const [beneficiaries, setBeneficiaries] = useState(initialBeneficiaries);
  const [beneficiaryModalOpen, setBeneficiaryModalOpen] = useState(false);
  const [beneficiaryMessage, setBeneficiaryMessage] = useState("");
  const [beneficiarySaving, startBeneficiarySave] = useTransition();
  const [selectedMovement, setSelectedMovement] = useState<
    CashFlowDashboard["movements"][number] | null
  >(null);
  const [classificationContext, setClassificationContext] =
    useState<ClassificationContext | null>(null);
  const [classificationLoading, startClassification] = useTransition();
  const [classificationMessage, setClassificationMessage] = useState("");
  const [payrollAllocations, setPayrollAllocations] = useState<PayrollAllocationDraft[]>([]);
  const [payrollPeriodYear, setPayrollPeriodYear] = useState("");
  const [payrollPeriodMonth, setPayrollPeriodMonth] = useState("");
  const [payrollComplete, setPayrollComplete] = useState(false);
  const [payrollBatchStatus, setPayrollBatchStatus] = useState<"DRAFT" | "COMPLETE" | null>(null);
  const [payrollFormalStatus, setPayrollFormalStatus] = useState<string | null>(null);
  const [payrollFormalAmount, setPayrollFormalAmount] = useState<number | null>(null);
  const [payrollFormalDifference, setPayrollFormalDifference] = useState<number | null>(null);
  const [payrollMessage, setPayrollMessage] = useState("");
  const [payrollSaving, startPayrollSave] = useTransition();
  const payrollContextCache = useRef(new Map<string, ClassificationContext>());
  const payrollDraftCache = useRef(new Map<string, Awaited<ReturnType<typeof getFinancialPayrollPaymentDraftAction>>>());
  const payrollDraftPromiseCache = useRef(new Map<string, Promise<Awaited<ReturnType<typeof getFinancialPayrollPaymentDraftAction>>>>());
  const selectedPayrollMovementId = useRef<string | null>(null);
  const [categoryEditOpen, setCategoryEditOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [categoryTreatmentTab, setCategoryTreatmentTab] = useState<CategoryTreatment>("CASH");
  const [categoryChangeReason, setCategoryChangeReason] = useState("");
  const [differenceOpen, setDifferenceOpen] = useState(false);
  const [differenceReason, setDifferenceReason] = useState("");
  const [differenceCounterparty, setDifferenceCounterparty] = useState("");
  const [differenceNote, setDifferenceNote] = useState("");
  const [differenceMessage, setDifferenceMessage] = useState("");
  const [differenceSaving, startDifference] = useTransition();
  const serverReconciliation = data.monthly?.reconciliation ?? null;
  const [reconciliationOverride, setReconciliationOverride] =
    useState<Reconciliation | null>(null);
  const reconciliation =
    reconciliationOverride &&
    serverReconciliation?.id === reconciliationOverride.id &&
    serverReconciliation.status === "PENDING"
      ? reconciliationOverride
      : serverReconciliation;
  const [classificationCategoryId, setClassificationCategoryId] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [note, setNote] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [ruleType, setRuleType] = useState<
    "EXACT" | "CONTAINS" | "STARTS_WITH"
  >("EXACT");
  const [ruleValue, setRuleValue] = useState("");
  const [ruleApply, setRuleApply] = useState(false);
  const [rulePreview, setRulePreview] = useState<RulePreview | null>(null);
  const [ruleLoading, startRule] = useTransition();
  const initialImportAccountId =
    accountId && data.accounts.some((account) => account.id === accountId)
      ? accountId
      : data.accounts.length === 1
        ? data.accounts[0].id
        : "";
  const [importAccountId, setImportAccountId] = useState(
    initialImportAccountId,
  );
  const pendingAccountRef = useRef<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState(
    accountId ?? ALL_ACCOUNTS,
  );
  const selectedAccount = data.accounts.find(
    (account) => account.id === accountId,
  );
  const [classificationFilter, setClassificationFilter] = useState(
    data.pageFilters.classificationFilter,
  );
  const [locallyReviewedMovementIds, setLocallyReviewedMovementIds] = useState<Set<string>>(
    new Set(),
  );
  const [search, setSearch] = useState(data.pageFilters.search);
  const [categoryFilter, setCategoryFilter] = useState(
    data.pageFilters.categoryId ?? "",
  );
  const scope = data.pageFilters.scope;
  const direction = data.pageFilters.direction;
  const groups = categoryGroups(categories);

  useEffect(() => {
    const nextAccountId = accountId ?? ALL_ACCOUNTS;
    if (
      pendingAccountRef.current === null ||
      pendingAccountRef.current === nextAccountId
    ) {
      pendingAccountRef.current = null;
      setSelectedAccountId(nextAccountId);
    }
    setClassificationFilter(data.pageFilters.classificationFilter);
    setLocallyReviewedMovementIds(new Set());
    setSearch(data.pageFilters.search);
    setCategoryFilter(data.pageFilters.categoryId ?? "");
  }, [accountId, data.pageFilters]);

  const loadAudit = (nextPage = 1, nextSearch = auditSearch, nextAccountId = auditAccountId) =>
    startAudit(async () => {
      try {
        const result = await getPendingDebitAudit({
          year,
          bankAccountId: nextAccountId === ALL_ACCOUNTS ? undefined : nextAccountId,
          search: nextSearch,
          page: nextPage,
          pageSize: 50,
        });
        setAuditData(result);
        setAuditSelected([]);
        setAuditPreviewOpen(false);
        setAuditMessage("");
      } catch (error) {
        setAuditMessage(
          error instanceof Error
            ? error.message
            : "No se pudo cargar la auditoría.",
        );
      }
    });

  const openAudit = () => {
    setAuditOpen(true);
    setAuditAccountId(ALL_ACCOUNTS);
    setAuditCategoryId("");
    setAuditCreateRule(false);
    setAuditSearch("");
    loadAudit(1, "", ALL_ACCOUNTS);
  };

  const openAuditGroup = (group: PendingDebitAudit["groups"][number]) => {
    setAuditDetailGroup(group);
    setAuditDetailData(null);
    setAuditDetailSelected([]);
    setAuditDetailCategoryId("");
    setAuditDetailCreateRule(false);
    setAuditDetailBeneficiaries({});
    setAuditDetailConcepts({});
    setAuditDetailPreviewOpen(false);
    setAuditDetailMessage("");
    setAuditDetailBeneficiaries({});
    setAuditDetailConcepts({});
    startAuditDetail(async () => {
      try {
        const result = await getPendingDebitGroupMovements({
          year,
          bankAccountId: auditAccountId === ALL_ACCOUNTS ? group.bankAccountId : auditAccountId,
          groupKey: group.groupKey,
          page: 1,
          pageSize: 100,
        });
        setAuditDetailData(result);
        setAuditDetailMessage("");
      } catch (error) {
        setAuditDetailMessage(
          error instanceof Error
            ? error.message
            : "No se pudo cargar el detalle del grupo.",
        );
      }
    });
  };

  const closeAuditDetail = () => {
    setAuditDetailGroup(null);
    setAuditDetailData(null);
    setAuditDetailSelected([]);
    setAuditDetailPreviewOpen(false);
    setAuditDetailMessage("");
  };

  const applyAuditDetail = () => {
    if (!auditData || !auditDetailData || !auditDetailSelected.length || !auditDetailCategoryId) return;
    startAuditDetailApply(async () => {
      const selectedCategory = categories.find((category) => category.id === auditDetailCategoryId);
      const result = selectedCategory?.code === "EXPENSE_PERSONNEL_OFF_BOOK"
        ? await classifyOffBookPersonnelMovements({
             year, bankAccountId: auditAccountId === ALL_ACCOUNTS ? auditDetailGroup?.bankAccountId : auditAccountId, categoryId: auditDetailCategoryId,
            details: auditDetailSelected.map((movementId) => ({
              movementId,
              beneficiaryId: auditDetailBeneficiaries[movementId] ?? "",
              paymentConcept: auditDetailConcepts[movementId] ?? "OTRO",
            })),
          })
        : await classifyPendingDebitMovements({ year, bankAccountId: auditAccountId === ALL_ACCOUNTS ? auditDetailGroup?.bankAccountId : auditAccountId, movementIds: auditDetailSelected, categoryId: auditDetailCategoryId, createRule: auditDetailCreateRule });
      if (!result.ok) {
        setAuditDetailMessage(result.message || "No se pudo completar la clasificación. No se realizaron cambios.");
        return;
      }
      setAuditDetailMessage(
        `Clasificados: ${result.result.classifiedCount}. Omitidos por clasificación concurrente: ${result.result.omittedCount}.`,
      );
      closeAuditDetail();
      setAuditSelected([]);
      setAuditOpen(false);
      setAuditData(null);
      navigate(
        query(
          year,
          month,
          accountId,
          data.page,
          data.pageFilters.classificationFilter,
          data.pageFilters.search,
          data.pageFilters.categoryId ?? "",
          scope,
          direction,
        ),
      );
    });
  };

  const applyAudit = () => {
    if (!auditData || !auditSelected.length) return;
    startAuditApply(async () => {
      const result = await classifyPendingDebitAudit({
        year,
        bankAccountId: auditAccountId === ALL_ACCOUNTS ? undefined : auditAccountId,
        groupKeys: auditSelected,
        categoryId: auditCategoryId,
        createRule: auditCreateRule,
      });
      if (!result.ok) {
        setAuditMessage(result.message);
        return;
      }
      setAuditMessage(
        `Clasificados: ${result.result.classifiedCount}. Omitidos por clasificación concurrente: ${result.result.omittedCount}.`,
      );
      setAuditSelected([]);
      setAuditPreviewOpen(false);
      setAuditOpen(false);
      setAuditData(null);
      navigate(
        query(
          year,
          month,
          accountId,
          data.page,
          data.pageFilters.classificationFilter,
          data.pageFilters.search,
          data.pageFilters.categoryId ?? "",
          scope,
          direction,
        ),
      );
    });
  };

  const query = (
    nextYear: number,
    nextMonth: number,
    nextAccount = accountId,
    nextPage = 1,
    nextFilter = data.pageFilters.classificationFilter,
    nextSearch = data.pageFilters.search,
    nextCategory = data.pageFilters.categoryId ?? "",
    nextScope = scope,
    nextDirection = direction,
  ) => {
    const params = new URLSearchParams({
      year: String(nextYear),
      month: String(nextMonth),
    });
    if (nextAccount && nextAccount !== ALL_ACCOUNTS)
      params.set("account", nextAccount);
    if (nextPage > 1) params.set("page", String(nextPage));
    if (nextFilter !== "ALL") params.set("classification", nextFilter);
    if (nextSearch.trim()) params.set("search", nextSearch.trim());
    if (nextCategory) params.set("category", nextCategory);
    params.set("scope", nextScope);
    params.set("direction", nextDirection);
    return `?${params.toString()}`;
  };
  const navigate = (url: string) => {
    if (isFiltering) return;
    startFiltering(() => router.push(url));
  };
  const navigateQuery = (
    nextYear: number,
    nextMonth: number,
    nextAccount = accountId,
    nextPage = 1,
    nextFilter = data.pageFilters.classificationFilter,
    nextSearch = data.pageFilters.search,
    nextCategory = data.pageFilters.categoryId ?? "",
    nextScope = scope,
    nextDirection = direction,
  ) => navigate(query(
    nextYear,
    nextMonth,
    nextAccount,
    nextPage,
    nextFilter,
    nextSearch,
    nextCategory,
    nextScope,
    nextDirection,
  ));
  const loadPayrollDraft = (movementId: string) => {
    const cachedDraft = payrollDraftCache.current.get(movementId);
    if (cachedDraft) return Promise.resolve(cachedDraft);
    const pendingDraft = payrollDraftPromiseCache.current.get(movementId);
    if (pendingDraft) return pendingDraft;
    const request = getFinancialPayrollPaymentDraftAction(movementId).then((draft) => {
      payrollDraftCache.current.set(movementId, draft);
      payrollDraftPromiseCache.current.delete(movementId);
      return draft;
    }).catch((error) => {
      payrollDraftPromiseCache.current.delete(movementId);
      throw error;
    });
    payrollDraftPromiseCache.current.set(movementId, request);
    return request;
  };
  const hydratePayrollDraft = async (movementId: string) => {
    const result = await loadPayrollDraft(movementId);
    if (selectedPayrollMovementId.current !== movementId || !result.ok || !result.draft) return;
    const { batch, allocations } = result.draft;
    setPayrollPeriodYear(String(batch.period_year));
    setPayrollPeriodMonth(String(batch.period_month));
    setPayrollAllocations(allocations.filter((allocation) => allocation.allocationType === "OFF_BOOK").map((allocation) => ({
      id: allocation.id,
      workerNameSnapshot: allocation.workerNameSnapshot ?? "",
      workerRut: allocation.workerRut ?? "",
      amount: String(allocation.amount),
    })));
    setPayrollBatchStatus(batch.status);
    setPayrollComplete(batch.status === "COMPLETE");
    setPayrollFormalStatus(batch.formal_reconciliation_status ?? null);
    setPayrollFormalAmount(batch.formal_payroll_amount ?? null);
    setPayrollFormalDifference(batch.formal_difference ?? null);
  };
  useEffect(() => {
    for (const movement of data.movements) {
      if (movement.direction !== "DEBE" || movement.category_code !== "EXPENSE_SALARIES_WAGES") continue;
      if (payrollContextCache.current.has(movement.id)) continue;
      void loadMovementContext(movement.id).then((context) => {
        payrollContextCache.current.set(movement.id, context);
      }).catch(() => undefined);
      void loadPayrollDraft(movement.id).catch(() => undefined);
    }
  }, [data.movements]);
  const applyFilters = (event: React.FormEvent) => {
    event.preventDefault();
    navigateQuery(year, month, accountId, 1, classificationFilter, search, categoryFilter);
  };
  const openMovement = (movement: CashFlowDashboard["movements"][number]) => {
    const payrollPeriod = payrollPeriodFromDescription(movement.operation_description, movement.transaction_date);
    selectedPayrollMovementId.current = movement.id;
    setSelectedMovement(movement);
    setClassificationContext(payrollContextCache.current.get(movement.id) ?? null);
    setClassificationMessage("");
    setClassificationCategoryId(movement.category_id ?? "");
    const existingCategory = movement.category_id
      ? categories.find((category) => category.id === movement.category_id)
      : null;
    setCategoryTreatmentTab(existingCategory ? categoryTreatment(existingCategory) : "CASH");
    setCategoryEditOpen(false);
    setCategorySearch("");
    setCategoryChangeReason("");
    setCounterparty(movement.counterparty ?? "");
    setNote(movement.classification_note ?? "");
    setRuleName(`Clasificar ${movement.normalized_description ?? movement.operation_description}`);
    setRuleValue(movement.normalized_description ?? movement.operation_description);
    setRulePreview(null);
    setPayrollMessage("");
    setPayrollAllocations([]);
    setPayrollPeriodYear(payrollPeriod.year);
    setPayrollPeriodMonth(payrollPeriod.month);
    setPayrollComplete(false);
    setPayrollBatchStatus(null);
    setPayrollFormalStatus(null);
    setPayrollFormalAmount(null);
    setPayrollFormalDifference(null);
    void hydratePayrollDraft(movement.id).catch(() => undefined);
    if (payrollContextCache.current.has(movement.id)) return;
    startClassification(async () => {
      try {
        setClassificationContext(await loadMovementContext(movement.id));
      } catch (error) {
        setClassificationMessage(error instanceof Error ? error.message : "No se pudo cargar equivalencias.");
      }
    });
  };
  const closeMovement = () => {
    selectedPayrollMovementId.current = null;
    setSelectedMovement(null);
    setClassificationContext(null);
    setRulePreview(null);
    setCategoryEditOpen(false);
    setCategorySearch("");
    setCategoryChangeReason("");
    setClassificationMessage("");
    setPayrollMessage("");
    setPayrollAllocations([]);
    setPayrollBatchStatus(null);
    setPayrollFormalStatus(null);
    setPayrollFormalAmount(null);
    setPayrollFormalDifference(null);
  };
  const openDifference = () => {
    const difference = reconciliation;
    if (!difference) return;
    setDifferenceReason(difference.reason_type ?? "");
    setDifferenceCounterparty(difference.counterparty ?? "");
    setDifferenceNote(difference.note ?? "");
    setDifferenceMessage("");
    setDifferenceOpen(true);
  };
  const identifyDifference = () => {
    const difference = reconciliation;
    if (!difference) return;
    setDifferenceMessage("");
    startDifference(async () => {
      try {
        const result = await updateFinancialBankReconciliationDifference({
          id: difference.id,
          status: "IDENTIFIED",
          reasonType: differenceReason,
          counterparty: differenceCounterparty,
          note: differenceNote,
        });
        if (!result.ok) {
          setDifferenceMessage(
            `No se pudo identificar la diferencia: ${result.message}`,
          );
          return;
        }
        setReconciliationOverride({
          ...difference,
          status: "IDENTIFIED",
          reason_type: differenceReason || null,
          counterparty: differenceCounterparty.trim() || null,
          note: differenceNote.trim() || null,
        });
      } catch (error) {
        setDifferenceMessage(
          `No se pudo identificar la diferencia: ${
            error instanceof Error ? error.message : "error desconocido"
          }`,
        );
      }
    });
  };
  const saveMovement = (bulk: boolean) =>
    startClassification(async () => {
      if (!selectedMovement || !classificationCategoryId)
        return setClassificationMessage("Selecciona una categoría.");
      if (!bulk) {
        const result = await updateFinancialMovementCategoryAction({
          movementId: selectedMovement.id,
          categoryId: classificationCategoryId,
          currentCategoryId: selectedMovement.category_id,
          reason: categoryChangeReason,
        });
        if (!result.ok) return setClassificationMessage(result.message);
        closeMovement();
        return;
      }
      const result = await saveClassification({
        movementId: selectedMovement.id,
        categoryId: classificationCategoryId,
        counterparty,
        note,
        applyToPending: bulk,
        pendingMovementIds: classificationContext?.pendingMovementIds,
        });
        if (result.ok) {
          setRulePreview(null);
          setClassificationMessage("Regla creada correctamente.");
          try {
            setClassificationContext(
              await loadMovementContext(selectedMovement.id),
            );
          } catch (error) {
            setClassificationMessage(
              error instanceof Error
                ? error.message
                : "La regla se creó, pero no se pudo actualizar el inspector.",
            );
          }
        } else setClassificationMessage(result.message);
    });
  const getRulePreview = () =>
    startRule(async () => {
      if (!selectedMovement || !classificationCategoryId)
        return setClassificationMessage(
          "Selecciona una categoría antes de crear la regla.",
        );
      try {
        setRulePreview(
          await loadRulePreview({
            movementId: selectedMovement.id,
            matchType: ruleType,
            matchValue: ruleValue,
          }),
        );
      } catch (error) {
        setClassificationMessage(
          error instanceof Error
            ? error.message
            : "No se pudo preparar el preview de la regla.",
        );
      }
    });
  const createRule = () =>
    startRule(async () => {
      if (!selectedMovement || !classificationCategoryId || !rulePreview)
        return;
      const result = await saveRule({
        movementId: selectedMovement.id,
        name: ruleName || `Regla ${rulePreview.matchValue}`,
        matchType: ruleType,
        matchValue: rulePreview.matchValue,
        categoryId: classificationCategoryId,
        counterparty,
        applyToPending: ruleApply,
      });
      if (result.ok) {
        closeMovement();
      } else setClassificationMessage(result.message);
    });
  const confirmMovement = () =>
    startClassification(async () => {
      if (!selectedMovement || selectedMovement.direction !== "DEBE") return;
      const result = await confirmFinancialMovementClassification(selectedMovement.id);
      if (!result.ok) return setClassificationMessage(result.message);
      setLocallyReviewedMovementIds((current) => {
        const next = new Set(current);
        next.add(selectedMovement.id);
        return next;
      });
      closeMovement();
    });
  const saveObservation = () =>
    startClassification(async () => {
      if (!selectedMovement || selectedMovement.direction !== "DEBE") return;
      const result = await updateFinancialMovementObservationAction({ movementId: selectedMovement.id, observation: note });
      if (!result.ok) return setClassificationMessage(result.message);
      setClassificationMessage("Observación guardada.");
    });
  const payrollInputAllocations = () => payrollAllocations.map((allocation) => ({
    allocationType: "OFF_BOOK" as const,
    workerRut: allocation.workerRut,
    workerNameSnapshot: allocation.workerNameSnapshot,
    amount: Number(allocation.amount),
  }));
  const savePayrollDraft = () => startPayrollSave(async () => {
    if (!selectedMovement) return;
    try {
      const result = await saveFinancialPayrollPaymentDraftAction({
        bankMovementId: selectedMovement.id,
        periodYear: Number(payrollPeriodYear),
        periodMonth: Number(payrollPeriodMonth),
        allocations: payrollInputAllocations(),
      });
      if (!result.ok) return setPayrollMessage(result.message);
      setPayrollBatchStatus("DRAFT");
      setPayrollFormalStatus("PENDING_PAYROLL");
      setPayrollFormalAmount(null);
      setPayrollFormalDifference(null);
      setPayrollMessage("Borrador guardado");
      payrollDraftCache.current.set(selectedMovement.id, await getFinancialPayrollPaymentDraftAction(selectedMovement.id));
    } catch (error) {
      setPayrollMessage(error instanceof Error ? error.message : "No se pudo guardar el borrador.");
    }
  });
  const completePayroll = () => startPayrollSave(async () => {
    if (!selectedMovement || !payrollOffBookValid) return;
    try {
      const draft = await saveFinancialPayrollPaymentDraftAction({
        bankMovementId: selectedMovement.id,
        periodYear: Number(payrollPeriodYear),
        periodMonth: Number(payrollPeriodMonth),
        allocations: payrollInputAllocations(),
      });
      if (!draft.ok) return setPayrollMessage(draft.message);
      const result = await completeFinancialPayrollPaymentDraftAction({ bankMovementId: selectedMovement.id });
      if (!result.ok) return setPayrollMessage(result.message);
      setPayrollComplete(true);
      setPayrollBatchStatus("COMPLETE");
      setPayrollFormalStatus("PENDING_PAYROLL");
      setPayrollFormalAmount(null);
      setPayrollFormalDifference(null);
      setPayrollMessage("Desglose completo");
      payrollDraftCache.current.set(selectedMovement.id, await getFinancialPayrollPaymentDraftAction(selectedMovement.id));
    } catch (error) {
      setPayrollMessage(error instanceof Error ? error.message : "No se pudo completar el desglose.");
    }
  });
  const addPayrollAllocation = () => setPayrollAllocations((current) => [
    ...current,
    { id: crypto.randomUUID(), workerNameSnapshot: "", workerRut: "", amount: "" },
  ]);
  const updatePayrollAllocation = (id: string, patch: Partial<PayrollAllocationDraft>) =>
    setPayrollAllocations((current) => current.map((allocation) => allocation.id === id ? { ...allocation, ...patch } : allocation));
  const removePayrollAllocation = (id: string) =>
    setPayrollAllocations((current) => current.filter((allocation) => allocation.id !== id));
  const payrollAssignedTotal = payrollAllocations.reduce((total, allocation) => total + (Number(allocation.amount) || 0), 0);
  const payrollReadOnly = payrollBatchStatus === "COMPLETE";
  const payrollBankAmount = Number(selectedMovement?.debit_amount ?? 0);
  const payrollFormalExpectedAmount = payrollBankAmount - payrollAssignedTotal;
  const payrollOffBookValid = payrollAssignedTotal <= payrollBankAmount && payrollBankAmount > 0;
  const annualNet = data.annual.credits - data.annual.debits;
  const monthlyNet = data.monthly
    ? data.monthly.credits - data.monthly.debits
    : null;
  const coverage = data.annual.openMonths
    ? `Cobertura: ${data.annual.closedMonths} meses cerrados · ${data.annual.openMonths} en curso`
    : `Cobertura: ${data.annual.closedMonths} / 12 meses cerrados`;
  const locallyReviewedPendingCount = data.movements.filter(
    (movement) =>
      movement.review_status === "PENDING" &&
      locallyReviewedMovementIds.has(movement.id),
  ).length;
  const pendingReviewCount = Math.max(
    0,
    data.pendingMovements - locallyReviewedPendingCount,
  );
  const tableData = {
    ...data,
    movements: data.movements
      .filter(
        (movement) =>
          classificationFilter !== "PENDING" ||
          (movement.review_status === "PENDING" &&
            !locallyReviewedMovementIds.has(movement.id)),
      )
      .map((movement) =>
        locallyReviewedMovementIds.has(movement.id)
          ? { ...movement, review_status: "REVIEWED" as const }
          : movement,
      ),
    pendingMovements: pendingReviewCount,
  };
  const eligibleCategories = selectedMovement
    ? eligibleFinancialCategories(
        categories,
        selectedMovement.direction ??
          bankMovementDirection(selectedMovement.credit_amount, selectedMovement.debit_amount),
      )
    : [];
  const treatmentEligibleCategories = filterCategoriesByTreatment(eligibleCategories, categoryTreatmentTab);
  const filteredEligibleCategories = treatmentEligibleCategories.filter((category) => {
    const query = categorySearch.trim().toLocaleLowerCase();
    return !query || category.name.toLocaleLowerCase().includes(query) || category.code.toLocaleLowerCase().includes(query);
  });
  const currentCategory = selectedMovement?.category_id
    ? categories.find((category) => category.id === selectedMovement.category_id)
    : null;
  const destinationCategory = categories.find((category) => category.id === classificationCategoryId);
  const pnlTreatmentChanges = Boolean(
    currentCategory && destinationCategory && currentCategory.affects_pnl_directly !== destinationCategory.affects_pnl_directly,
  );
  const selectClassificationCategory = (categoryId: string) => {
    setClassificationCategoryId(categoryId);
    const category = categories.find((item) => item.id === categoryId);
    if (category) setCategoryTreatmentTab(categoryTreatment(category));
  };
  const changeCategoryTreatmentTab = (treatment: CategoryTreatment) => {
    setCategoryTreatmentTab(treatment);
    if (destinationCategory && categoryTreatment(destinationCategory) !== treatment) {
      setClassificationCategoryId("");
    }
  };

  return (
    <main className="min-h-[430px] bg-[#EFE9E1] px-4 py-2 sm:px-6 sm:py-3">
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-[#AC9C8D]/60 pb-1.5">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">
            Tesorería · Cartola bancaria
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Cuenta bancaria"
            value={selectedAccountId}
            disabled={isFiltering}
            onChange={(event) => {
              const next = event.target.value;
              const nextAccount = next === ALL_ACCOUNTS ? ALL_ACCOUNTS : next;
              const accountForImport =
                nextAccount === ALL_ACCOUNTS ? undefined : nextAccount;
              pendingAccountRef.current = next;
              setSelectedAccountId(next);
              setImportAccountId(
                accountForImport ??
                  (bankAccounts.length === 1 ? bankAccounts[0].id : ""),
              );
              navigateQuery(year, month, nextAccount, 1, classificationFilter, search, categoryFilter, scope, direction);
            }}
            className="h-8 min-w-64 border border-[#AC9C8D] bg-white px-2 text-xs"
          >
            <option value={ALL_ACCOUNTS}>Todas las cuentas</option>
            {bankAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
           <Button type="button" size="sm" disabled={isFiltering} onClick={() => setImportOpen(true)}>
             <Upload /> Importar cartola
           </Button>
           <Button type="button" size="sm" variant="outline" disabled={isFiltering} onClick={openAudit}>
             Auditar pendientes
           </Button>
        </div>
      </div>
      <section className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        <div className="border border-[#72383D] bg-[#72383D] px-3 py-2 text-white sm:col-span-2 xl:col-span-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/65">
            Saldo total bancos
          </p>
          <p className="mt-0 text-2xl font-semibold leading-7 tabular-nums">
            {money(data.currentBalance)}
          </p>
          <p className="text-[11px] text-white/70">
            Actualizado al {date(data.currentDate)} · cobertura bancaria confirmada
          </p>
        </div>
        {data.accountBalances.map((account) => (
          <div
            key={account.accountId}
            className="border border-[#D1C7BD] bg-white px-3 py-2"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#72383D]">
              {bankDisplayName(account.bankName)} · {account.maskedAccountNumber}
            </p>
            <p className="mt-0 text-xl font-semibold leading-6 tabular-nums">
              {money(account.balance)}
            </p>
            <p className="text-[11px] text-[#322D29]/55">
              Actualizado al {date(account.balanceDate)}
            </p>
            {(account.creditLineUsed !== null || account.creditLineAvailable !== null) && (
              <div className="mt-1 flex flex-wrap gap-x-3 border-t border-[#D1C7BD] pt-1 text-[11px] leading-4 text-[#322D29]/70">
                <span>Línea utilizada: {money(account.creditLineUsed)}</span>
                <span>Disponible: {money(account.creditLineAvailable)}</span>
              </div>
            )}
          </div>
        ))}
      </section>
      <section className="mt-2 border border-[#D1C7BD] bg-white px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#AC9C8D]">
              Resumen anual · {year}
            </p>
            <p className="text-xs text-[#322D29]/60">{coverage}</p>
          </div>
          <p className="text-xs text-[#322D29]/60">
            {data.annual.movements.toLocaleString("es-CL")} movimientos
          </p>
        </div>
        <div className="mt-1.5 grid gap-px border border-[#D1C7BD] bg-[#D1C7BD] sm:grid-cols-4">
          {[
            ["Saldo inicial", money(data.annual.openingBalance)],
            ["Haber YTD", money(data.annual.credits)],
            ["Debe YTD", money(data.annual.debits)],
            ["Flujo neto YTD", money(annualNet)],
          ].map(([label, value]) => (
            <div key={label} className="bg-[#FAF8F5] px-2.5 py-1.5">
              <p className="text-[10px] uppercase text-[#AC9C8D]">{label}</p>
              <p className="mt-0.5 font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
      </section>
      {isFiltering && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed left-1/2 top-[45%] z-[60] inline-flex -translate-x-1/2 items-center gap-2.5 rounded-xl border border-[#D1C7BD] bg-white/95 px-5 py-3 text-sm font-semibold text-[#72383D] shadow-xl backdrop-blur-sm"
        >
          <LoaderCircle aria-hidden="true" className="h-5 w-5 animate-spin text-[#72383D]" />
          Actualizando…
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1 border-b border-[#D1C7BD] pb-1">
        <form className="flex flex-wrap gap-1" onSubmit={applyFilters}>
          <input
            aria-label="Buscar operación"
            placeholder="Buscar operación"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            disabled={isFiltering}
            className="h-8 w-44 border border-[#AC9C8D] bg-white px-2 text-xs"
          />
          <select
            aria-label="Ámbito de búsqueda"
            value={scope}
            disabled={isFiltering}
            onChange={(event) => {
              const nextScope = event.target.value as "month" | "year";
              navigateQuery(year, month, accountId, 1, classificationFilter, search, categoryFilter, nextScope, direction);
            }}
            className="h-8 border border-[#AC9C8D] bg-white px-2 text-xs"
          >
            <option value="month">Buscar en: Mes seleccionado</option>
            <option value="year">Buscar en: Año completo</option>
          </select>
          <label className="flex h-8 items-center border border-[#AC9C8D] bg-white px-2 text-xs">
            <span className="mr-1 text-[#322D29]/60">Revisión:</span>
            <select
              aria-label="Revisión"
              value={classificationFilter}
              disabled={isFiltering}
              onChange={(event) => {
                const nextFilter = event.target.value as typeof classificationFilter;
                setClassificationFilter(nextFilter);
                navigateQuery(year, month, accountId, 1, nextFilter, search, categoryFilter, scope, direction);
              }}
              className="bg-transparent text-xs outline-none"
            >
              <option value="ALL">Todos</option>
              <option value="PENDING">Pendientes</option>
              <option value="REVIEWED">Revisados</option>
              <option value="HISTORICAL">Histórico</option>
             </select>
           </label>
           <button
             type="button"
             aria-pressed={classificationFilter === "PENDING"}
             disabled={isFiltering}
             onClick={() => {
               const nextFilter =
                 classificationFilter === "PENDING" ? "ALL" : "PENDING";
               setClassificationFilter(nextFilter);
               navigateQuery(year, month, accountId, 1, nextFilter, search, categoryFilter, scope, direction);
             }}
             className={`inline-flex h-8 items-center gap-1.5 border px-2 text-xs font-semibold transition-colors ${
               classificationFilter === "PENDING"
                 ? "border-[#66856B]/50 bg-[#EDF4EC] text-[#426247] hover:bg-[#E2EEE0] ring-1 ring-[#66856B]/30"
                 : pendingReviewCount > 0
                   ? "border-[#A23E48]/50 bg-[#FFF8F6] text-[#A23E48] hover:bg-[#FDECEA]"
                   : "border-[#AC9C8D] bg-white text-[#322D29]/65 hover:bg-[#FAF8F5]"
             }`}
           >
             <span
               className={`h-1.5 w-1.5 rounded-full ${
                 classificationFilter === "PENDING"
                   ? "bg-[#426247]"
                   : pendingReviewCount > 0
                     ? "bg-[#A23E48]"
                     : "bg-[#AC9C8D]"
               }`}
               aria-hidden="true"
             />
             Pendientes de revisión · {pendingReviewCount}
           </button>
           <select
            aria-label="Tipo de movimiento"
            value={direction}
            disabled={isFiltering}
            onChange={(event) => {
              const nextDirection = event.target.value as "all" | "credit" | "debit";
              navigateQuery(year, month, accountId, 1, classificationFilter, search, categoryFilter, scope, nextDirection);
            }}
            className="h-8 border border-[#AC9C8D] bg-white px-2 text-xs"
          >
            <option value="all">Todos los movimientos</option>
            <option value="credit">Solo Haber</option>
            <option value="debit">Solo Debe</option>
          </select>
          <select
            aria-label="Categoría financiera"
            value={categoryFilter}
            disabled={isFiltering}
            onChange={(event) => {
              const nextCategory = event.target.value;
              setCategoryFilter(nextCategory);
              navigateQuery(year, month, accountId, 1, classificationFilter, search, nextCategory, scope, direction);
            }}
            className="h-8 max-w-56 border border-[#AC9C8D] bg-white px-2 text-xs"
          >
            <option value="">Todas las categorías</option>
            {groups.map((group) => (
              <optgroup key={group.root!.id} label={group.root!.name}>
                {group.children.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Button type="submit" size="sm" variant="outline" disabled={isFiltering}>
            Filtrar
          </Button>
        </form>
        <div className="flex flex-wrap gap-0.5">
          {MONTHS.map((label, index) =>
            month === index + 1 ? (
              <span
                key={label}
                aria-current="page"
                 className="bg-[#72383D] px-1.5 py-0.5 text-[11px] font-semibold text-white"
              >
                {label}
              </span>
            ) : (
              <a
                key={label}
                href={query(year, index + 1)}
                aria-disabled={isFiltering}
                onClick={(event) => {
                  event.preventDefault();
                  navigateQuery(year, index + 1);
                }}
                 className="px-1.5 py-0.5 text-[11px] font-semibold text-[#322D29]/55"
              >
                {label}
              </a>
            ),
          )}
        </div>
      </div>
       <section className={`mt-2 border border-[#D1C7BD] bg-white transition-opacity ${isFiltering ? "opacity-60" : ""}`}>
         <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[#D1C7BD] px-3 py-1.5">
           <div className="flex flex-wrap items-baseline gap-x-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#72383D]">
              {scope === "year"
                ? `Resultados de búsqueda · ${year}`
                : `${MONTHS[month - 1]} ${year}`}
            </p>
              <p className="text-xs text-[#322D29]/60">
              Estado:{" "}
              {data.monthly
                ? data.monthly.status === "OPEN"
                  ? "ABIERTO"
                  : "CERRADO"
                : "sin cartola importada"}
              {selectedAccount ? ` · ${accountLabel(selectedAccount)}` : ""}
            </p>
          </div>
          {data.monthly && (
             <div className="text-right text-xs leading-4">
              Haber {money(data.monthly.credits)} · Debe{" "}
              {money(data.monthly.debits)}
            </div>
          )}
        </div>
        {data.monthly && (
          <div className="grid gap-px border-b border-[#D1C7BD] bg-[#D1C7BD] sm:grid-cols-5">
            {[
              ["Saldo inicial", money(data.monthly.openingBalance)],
              ["Flujo neto", money(monthlyNet)],
                [
                  data.monthly.status === "OPEN"
                    ? "Saldo actual banco"
                    : "Saldo cierre",
                money(
                  data.monthly.status === "OPEN"
                    ? data.monthly.currentBalance
                    : data.monthly.closingBalance,
                ),
              ],
              ["Movimientos", String(data.monthly.movements)],
              [
                "Pendientes de revisión",
                String(data.monthly.pendingMovements),
              ],
            ].map(([label, value]) => (
                <div key={label} className="bg-[#FAF8F5] px-2.5 py-1.5">
                <p className="text-[10px] uppercase text-[#AC9C8D]">{label}</p>
                <p className="mt-0.5 font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </div>
        )}
        {reconciliation &&
          reconciliation.status !== "RESOLVED" &&
          Number(reconciliation.amount_signed) !== 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#D1C7BD] bg-[#FFF7ED] px-4 py-3 text-xs">
              <div>
                <p className="font-semibold text-[#8A4B08]">
                  Diferencia de conciliación{" "}
                  {reconciliation.status === "PENDING"
                    ? "pendiente"
                    : reconciliation.status === "IDENTIFIED"
                      ? "identificada"
                      : "resuelta"}{" "}
                  {money(Number(reconciliation.amount_signed))}
                </p>
                <p className="mt-1 text-[#8A4B08]/75">
                   Saldo actual banco{" "}
                   {money(Number(reconciliation.reported_balance))}{" "}
                   · Saldo explicado{" "}
                   {money(Number(reconciliation.expected_balance))}
                    {" "}· Diferencia{" "}
                   {money(Number(reconciliation.amount_signed))}
                </p>
              </div>
                <Button type="button" size="sm" variant="outline" onClick={openDifference}>
                 Revisar diferencia
              </Button>
            </div>
          )}
         {!data.monthly && scope === "month" ? (
          <div className="px-4 py-10 text-center text-xs text-[#322D29]/60">
            No hay cartola para este mes.
          </div>
        ) : (
           <MovementTable
             data={tableData}
            year={year}
            month={month}
           accountId={accountId}
           scope={scope}
           query={query}
           onNavigate={navigate}
           isNavigating={isFiltering}
           onSelect={openMovement}
          />
        )}
      </section>
      {importOpen && (
        <ImportCartola
          accounts={bankAccounts}
          selectedAccountId={importAccountId}
          onAccountSelected={setImportAccountId}
          onAccountCreated={(account) => {
            setBankAccounts((current) => [
              ...current.filter((item) => item.id !== account.id),
              account,
             ]);
             setImportAccountId(account.id);
           }}
          onClose={() => setImportOpen(false)}
           onConfirmed={() => {
             setImportOpen(false);
           }}
        />
      )}
      {auditOpen && auditData && (
        <PendingDebitAuditPanel
           data={auditData}
           accounts={bankAccounts}
           accountId={auditAccountId}
           categories={categories}
           categoryId={auditCategoryId}
           createRule={auditCreateRule}
          search={auditSearch}
          selected={auditSelected}
          previewOpen={auditPreviewOpen}
          message={auditMessage}
          loading={auditLoading}
          applying={auditApplying}
           onSearchChange={setAuditSearch}
           onAccountChange={(value) => { setAuditAccountId(value); loadAudit(1, auditSearch, value); }}
           onCategoryChange={setAuditCategoryId}
           onCreateRuleChange={setAuditCreateRule}
          onSearch={() => loadAudit(1, auditSearch)}
          onClose={() => setAuditOpen(false)}
          onToggle={(key) =>
            setAuditSelected((current) =>
              current.includes(key)
                ? current.filter((item) => item !== key)
                : [...current, key],
            )
          }
          onSelectVisible={() =>
            setAuditSelected(auditData.groups.map((group) => group.groupKey))
          }
          onDeselect={() => setAuditSelected([])}
          onPreview={() => setAuditPreviewOpen(true)}
          onCancelPreview={() => setAuditPreviewOpen(false)}
          onApply={applyAudit}
          onPage={(page) => loadAudit(page, auditSearch)}
          onViewMovements={openAuditGroup}
        />
      )}
      {auditDetailGroup && auditDetailData && (
        <PendingDebitAuditDetailPanel
          group={auditDetailGroup}
          account={bankAccounts.find((account) => account.id === auditDetailGroup.bankAccountId)}
          data={auditDetailData}
           categories={categories}
            beneficiaries={beneficiaries}
            categoryId={auditDetailCategoryId}
            createRule={auditDetailCreateRule}
           beneficiaryValues={auditDetailBeneficiaries}
           conceptValues={auditDetailConcepts}
          selected={auditDetailSelected}
          previewOpen={auditDetailPreviewOpen}
          message={auditDetailMessage}
          loading={auditDetailLoading}
          applying={auditDetailApplying}
          onClose={closeAuditDetail}
           onToggle={(id) =>
            setAuditDetailSelected((current) =>
              current.includes(id)
                ? current.filter((item) => item !== id)
                : [...current, id],
            )
           }
            onCategoryChange={setAuditDetailCategoryId}
            onCreateRuleChange={setAuditDetailCreateRule}
           onBeneficiaryChange={(id, value) => setAuditDetailBeneficiaries((current) => ({ ...current, [id]: value }))}
           onConceptChange={(id, value) => setAuditDetailConcepts((current) => ({ ...current, [id]: value }))}
           onApplyBulkDetails={(beneficiaryId, concept) => {
             setAuditDetailBeneficiaries((current) => ({ ...current, ...Object.fromEntries(auditDetailSelected.map((id) => [id, beneficiaryId])) }));
             setAuditDetailConcepts((current) => ({ ...current, ...Object.fromEntries(auditDetailSelected.map((id) => [id, concept])) }));
           }}
           onCreateBeneficiary={() => { setBeneficiaryMessage(""); setBeneficiaryModalOpen(true); }}
          onSelectVisible={() =>
            setAuditDetailSelected(
              auditDetailData.movements.map((movement) => movement.id),
            )
          }
          onDeselect={() => setAuditDetailSelected([])}
          onPreview={() => setAuditDetailPreviewOpen(true)}
          onCancelPreview={() => setAuditDetailPreviewOpen(false)}
          onApply={applyAuditDetail}
          onPage={(page) => {
            if (!auditDetailGroup) return;
            startAuditDetail(async () => {
              try {
                const result = await getPendingDebitGroupMovements({
                  year,
                  bankAccountId: accountId,
                  groupKey: auditDetailGroup.groupKey,
                  page,
                  pageSize: auditDetailData.pageSize,
                });
                setAuditDetailData(result);
                setAuditDetailPreviewOpen(false);
              } catch (error) {
                setAuditDetailMessage(
                  error instanceof Error
                    ? error.message
                    : "No se pudo cargar la página del detalle.",
                );
              }
            });
          }}
        />
      )}
      {beneficiaryModalOpen && (
        <BeneficiaryModal
          saving={beneficiarySaving}
          message={beneficiaryMessage}
          onClose={() => setBeneficiaryModalOpen(false)}
          onSave={(input) => startBeneficiarySave(async () => {
            const result = await createFinancialPersonnelBeneficiary(input);
            if (!result.ok) { setBeneficiaryMessage(result.message); return; }
            setBeneficiaries((current) => [...current.filter((item) => item.id !== result.beneficiary.id), result.beneficiary].sort((a, b) => a.display_name.localeCompare(b.display_name)));
            setAuditDetailBeneficiaries((current) => ({ ...current, ...Object.fromEntries(auditDetailSelected.map((id) => [id, result.beneficiary.id])) }));
            setBeneficiaryModalOpen(false);
          })}
        />
      )}
      {auditDetailGroup && !auditDetailData && auditDetailMessage && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center bg-[#322D29]/50 p-4 sm:pt-24">
          <div className="w-full max-w-lg border border-[#D1C7BD] bg-[#FAF8F5] p-5 shadow-xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Detalle del grupo</p>
            <h3 className="mt-1 text-lg font-semibold">No se pudo cargar el detalle</h3>
            <p className="mt-3 border border-red-200 bg-red-50 p-3 text-xs text-red-800">{auditDetailMessage}</p>
            <div className="mt-4 flex gap-2"><Button type="button" size="sm" disabled={auditDetailLoading} onClick={() => openAuditGroup(auditDetailGroup)}>Reintentar</Button><Button type="button" size="sm" variant="outline" onClick={closeAuditDetail}>Cerrar</Button></div>
          </div>
        </div>
      )}
      <Sheet
        open={selectedMovement !== null}
        onOpenChange={(open) => !open && closeMovement()}
      >
        <SheetContent
          side="right"
          className="w-full overflow-y-auto border-[#D1C7BD] bg-[#EFE9E1] sm:max-w-[820px]"
        >
          <SheetHeader className="border-b border-[#D1C7BD] bg-white">
            <SheetTitle>Revisión del movimiento</SheetTitle>
            <SheetDescription>
              Equivalencias exactas basadas en la cuenta, dirección y
              descripción normalizada. Las clasificaciones existentes nunca se
              sobrescriben en bloque.
            </SheetDescription>
          </SheetHeader>
          {selectedMovement && (
            <div className="space-y-4 p-5 text-xs">
              <div className="border border-[#D1C7BD] bg-white p-4">
                <p className="font-semibold">{selectedMovement.operation_description}</p>
                <p className="mt-1 text-[#322D29]/65">
                  {bankDisplayName(data.accounts.find((account) => account.id === selectedMovement.bank_account_id)?.bank_name ?? "Cuenta bancaria")} · {date(selectedMovement.transaction_date)}
                </p>
                <p className="mt-2">Pago: {money(Number(selectedMovement.debit_amount))}</p>
                <p className="mt-1 text-[#322D29]/60">
                  Estado{" "}
                  {selectedMovement.review_status === "HISTORICAL"
                    ? "Histórico"
                    : selectedMovement.review_status === "REVIEWED"
                      ? "Revisado"
                      : selectedMovement.review_status === "PENDING"
                        ? "Pendiente de revisión"
                      : selectedMovement.category_id ? "Clasificado" : "Pendiente de clasificación"}
                </p>
              </div>
              {selectedMovement.direction === "DEBE" && selectedMovement.category_code === "EXPENSE_SALARIES_WAGES" && (
                <div className="border border-[#AC9C8D] bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold">Desglose de nómina</p>
                    <span className="border border-[#AC9C8D] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]">{payrollPeriodMonth ? MONTHS[Number(payrollPeriodMonth) - 1] : "—"} {payrollPeriodYear}</span>
                  </div>
                  <p className="mt-1 text-[#322D29]/65">
                    Todo el pago se considera asociado al Libro de Remuneraciones. Agrega sólo las personas que no aparecerán en el Libro.
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                     <label className="text-[10px] font-semibold uppercase tracking-[0.08em]">Año económico<input className="mt-1 w-full border border-[#D1C7BD] bg-[#FCFBF9] p-2 text-xs" type="number" value={payrollPeriodYear} disabled={payrollReadOnly} onChange={(event) => setPayrollPeriodYear(event.target.value)} /></label>
                     <label className="text-[10px] font-semibold uppercase tracking-[0.08em]">Mes económico<input className="mt-1 w-full border border-[#D1C7BD] bg-[#FCFBF9] p-2 text-xs" type="number" min="1" max="12" value={payrollPeriodMonth} disabled={payrollReadOnly} onChange={(event) => setPayrollPeriodMonth(event.target.value)} /></label>
                  </div>
                  <div className="mt-4 border border-[#D1C7BD]">
                    {payrollAllocations.length > 0 && <div className="divide-y divide-[#EEE8E0]">
                      {payrollAllocations.map((allocation) => <div key={allocation.id} className="grid gap-2 p-3 sm:grid-cols-[1.3fr_1fr_0.8fr_1fr_auto] sm:items-end">
                         <label className="text-[10px] font-semibold uppercase tracking-[0.08em]">Nombre<input className="mt-1 h-9 w-full border border-[#D1C7BD] bg-[#FCFBF9] px-2 text-xs" value={allocation.workerNameSnapshot} disabled={payrollReadOnly} onChange={(event) => updatePayrollAllocation(allocation.id, { workerNameSnapshot: event.target.value })} /></label>
                         <label className="text-[10px] font-semibold uppercase tracking-[0.08em]">RUT<input className="mt-1 h-9 w-full border border-[#D1C7BD] bg-[#FCFBF9] px-2 text-xs" value={allocation.workerRut} disabled={payrollReadOnly} onChange={(event) => updatePayrollAllocation(allocation.id, { workerRut: event.target.value })} /></label>
                         <label className="text-[10px] font-semibold uppercase tracking-[0.08em]">Monto<input className="mt-1 h-9 w-full border border-[#D1C7BD] bg-[#FCFBF9] px-2 text-xs tabular-nums" type="number" min="0" value={allocation.amount} disabled={payrollReadOnly} onChange={(event) => updatePayrollAllocation(allocation.id, { amount: event.target.value })} /></label>
                         <button type="button" className="h-9 px-2 text-xs text-[#72383D] underline" disabled={payrollReadOnly} onClick={() => removePayrollAllocation(allocation.id)}>Eliminar</button>
                      </div>)}
                    </div>}
                     <button type="button" className="m-3 border border-[#AC9C8D] px-3 py-2 text-xs font-semibold" disabled={payrollReadOnly} onClick={addPayrollAllocation}>+ Agregar persona fuera de libro</button>
                  </div>
                  <div className="mt-4 grid gap-2 border-t border-[#D1C7BD] pt-3 text-xs sm:grid-cols-3">
                    <p>Nómina bancaria <strong className="block tabular-nums">{money(payrollBankAmount)}</strong></p>
                    <p>Fuera de libro <strong className="block tabular-nums">{money(payrollAssignedTotal)}</strong></p>
                    <p className={payrollFormalExpectedAmount < 0 ? "text-[#72383D]" : ""}>Estimado en libro <strong className="block tabular-nums">{money(payrollFormalExpectedAmount)}</strong></p>
                  </div>
                  <div className="mt-3 border-t border-[#D1C7BD] pt-3 text-xs">
                    {payrollFormalAmount === null ? (
                      <p>Conciliación <strong>Pendiente de Libro</strong></p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <p>Libro líquido <strong className="block tabular-nums">{money(payrollFormalAmount)}</strong></p>
                        <p>Diferencia <strong className="block tabular-nums">{money(payrollFormalDifference ?? 0)}</strong></p>
                        <p>Estado <strong className="block">{payrollStatusLabel(payrollFormalStatus)}</strong></p>
                      </div>
                    )}
                  </div>
                  {payrollBatchStatus && <p className={`mt-3 text-xs font-semibold ${payrollBatchStatus === "COMPLETE" ? "text-[#53705C]" : ""}`}>{payrollStatusLabel(payrollBatchStatus)}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={savePayrollDraft} disabled={payrollSaving || payrollComplete}>Guardar desglose</Button>
                    <Button type="button" size="sm" onClick={completePayroll} disabled={payrollSaving || payrollComplete || !payrollOffBookValid}>
                      {payrollSaving ? "Guardando…" : "Completar desglose"}
                    </Button>
                  </div>
                  {payrollMessage && <p className="mt-2 border border-[#D1C7BD] bg-[#F3E8E4] p-2">{payrollMessage}</p>}
                </div>
              )}
              <details open={selectedMovement.category_code !== "EXPENSE_SALARIES_WAGES"} className="border border-[#D1C7BD] bg-[#FAF8F5]">
                <summary className="cursor-pointer px-4 py-3 font-semibold">Clasificación bancaria</summary>
                <div className="space-y-4 border-t border-[#D1C7BD] p-4">
              {classificationContext && (
                <div className="border border-[#AC9C8D] bg-white p-4">
                  <p className="font-semibold">
                    Coincidencias exactas: {classificationContext.total}
                  </p>
                  <p className="mt-1">
                    {classificationContext.pendingCount} pendientes ·{" "}
                    {classificationContext.classifiedCount} ya clasificados
                  </p>
                  {classificationContext.pendingCount > 0 && classificationContext.ruleSuggestion && (
                    <p className="mt-3 border border-[#72383D] bg-[#F3E8E4] p-3">
                      <strong>Sugerencia por regla</strong>
                      <br />
                      {classificationContext.ruleSuggestion.category_name}
                      <br />
                      <span className="text-[#322D29]/65">
                        Regla:{" "}
                        {classificationContext.ruleSuggestion.match_value}
                      </span>
                      <br />
                      <button
                        type="button"
                        className="mt-2 underline"
                        onClick={() =>
                           selectClassificationCategory(
                             classificationContext.ruleSuggestion!.category_id,
                           )
                        }
                      >
                        Usar sugerencia
                      </button>
                    </p>
                  )}
                   {classificationContext.pendingCount > 0 &&
                     !classificationContext.ruleSuggestion &&
                     classificationContext.suggestion && (
                      <p className="mt-3 border border-[#AC9C8D] bg-[#F3E8E4] p-3">
                        Sugerencia basada en{" "}
                        {classificationContext.suggestion.count} movimientos
                        equivalentes:{" "}
                        <strong>{classificationContext.suggestion.name}</strong>
                        <br />
                        <button
                          type="button"
                          className="mt-2 underline"
                          onClick={() =>
                             selectClassificationCategory(
                               classificationContext.suggestion!.categoryId,
                             )
                          }
                        >
                          Aplicar clasificación sugerida
                        </button>
                      </p>
                    )}
                   {classificationContext.pendingCount > 0 &&
                     !classificationContext.ruleSuggestion &&
                     classificationContext.hasClassificationConflict && (
                      <p className="mt-3 border border-red-200 bg-red-50 p-3 text-red-800">
                        Existen clasificaciones diferentes para movimientos
                        equivalentes. No se sugiere una categoría automática.
                      </p>
                    )}
                </div>
              )}
              {classificationContext?.matchingRules?.length ? (
                <div className="border-t border-[#D1C7BD] pt-4">
                  <p className="font-semibold">Regla existente</p>
                  {classificationContext.matchingRules.map(
                    (rule: {
                      id: string;
                      match_type: string;
                      match_value: string;
                      category_name: string | null;
                    }) => (
                      <p
                        key={rule.id}
                        className="mt-2 border border-[#AC9C8D] bg-white p-3"
                      >
                        {rule.match_type} · {rule.match_value}
                        <br />→ {rule.category_name}
                      </p>
                    ),
                  )}
                </div>
              ) : null}
               <div className="border border-[#D1C7BD] bg-white p-4">
                 <div className="flex items-start justify-between gap-3">
                   <div>
                     <p className="font-semibold">Categoría</p>
                     <p className="mt-1">{currentCategory ? categoryPath(currentCategory, categories) : "Pendiente de clasificación"}</p>
                     {selectedMovement.classification_source && (
                        <p className="mt-1 text-[#322D29]/60">Origen: {selectedMovement.classification_source}</p>
                      )}
                      {selectedMovement.review_status && <p className="mt-1 text-[#322D29]/60">Revisión: {selectedMovement.review_status === "HISTORICAL" ? "Histórico" : selectedMovement.review_status === "REVIEWED" ? "Revisado" : "Pendiente"}</p>}
                   </div>
                    {canClassify && (
                      <Button type="button" size="sm" variant="outline" onClick={() => setCategoryEditOpen((open) => !open)}>
                        {categoryEditOpen ? "Cancelar" : "Cambiar categoría"}
                      </Button>
                    )}
                 </div>
                  {categoryEditOpen && (
                    <div className="mt-4 border-t border-[#D1C7BD] pt-4">
                      <p className="font-semibold">Nueva categoría</p>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2" role="tablist" aria-label="Naturaleza de la categoría">
                        {([
                          ["PNL", "AFECTA RESULTADO", "Se incorpora directamente como ingreso o gasto en el Estado de Resultados."],
                          ["CASH", "SÓLO CAJA", "Mueve dinero, pero no afecta directamente el Estado de Resultados."],
                        ] as const).map(([treatment, label, help]) => (
                          <button
                            key={treatment}
                            type="button"
                            role="tab"
                            aria-selected={categoryTreatmentTab === treatment}
                            onClick={() => changeCategoryTreatmentTab(treatment)}
                            className={`min-h-10 border px-3 py-2 text-left text-xs font-bold tracking-[0.08em] transition-colors ${categoryTreatmentTab === treatment ? "border-[#72383D] bg-[#72383D] text-white" : "border-[#AC9C8D] bg-white text-[#72383D] hover:bg-[#F5F0EA]"}`}
                          >
                            <span className="block">{label}</span>
                            <span className={`mt-1 block text-[11px] font-normal normal-case tracking-normal ${categoryTreatmentTab === treatment ? "text-white/85" : "text-[#322D29]/60"}`}>{help}</span>
                          </button>
                        ))}
                      </div>
                      <input
                       value={categorySearch}
                       onChange={(event) => setCategorySearch(event.target.value)}
                       placeholder="Buscar por nombre o código"
                       className="mt-2 h-9 w-full border border-[#AC9C8D] bg-white px-2"
                     />
                     <select
                        value={classificationCategoryId}
                        onChange={(event) => selectClassificationCategory(event.target.value)}
                        className="mt-2 h-9 w-full border border-[#AC9C8D] bg-white px-2"
                      >
                        <option value="">Selecciona una categoría</option>
                        {filteredEligibleCategories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {categoryPath(category, categories)} · {category.code}
                          </option>
                        ))}
                      </select>
                     <p className="mt-2 text-[11px] text-[#322D29]/60">Sólo se muestran hojas activas compatibles con {selectedMovement.direction ?? "la dirección bancaria"}.</p>
                     {classificationCategoryId !== selectedMovement.category_id && destinationCategory && (
                       <div className="mt-3 border border-[#AC9C8D] bg-[#FAF8F5] p-3">
                         <p>{currentCategory?.name ?? "Pendiente"} → {destinationCategory.name}</p>
                          {pnlTreatmentChanges && <p className="mt-2 text-[#8A4B08]">Este cambio modificará si el movimiento afecta directamente el Estado de Resultados.</p>}
                       </div>
                     )}
                     <label className="mt-3 block">
                       Motivo del cambio <span className="text-[#322D29]/50">(opcional)</span>
                       <textarea
                         value={categoryChangeReason}
                         onChange={(event) => setCategoryChangeReason(event.target.value)}
                         className="mt-1 min-h-16 w-full border border-[#AC9C8D] bg-white p-2"
                       />
                     </label>
                     <Button
                       type="button"
                       size="sm"
                       className="mt-3"
                       disabled={classificationLoading || !classificationCategoryId || classificationCategoryId === selectedMovement.category_id}
                       onClick={() => saveMovement(false)}
                     >
                       Guardar cambio
                     </Button>
                   </div>
                 )}
               </div>
                {canClassify && <label className="block">
                 Contraparte opcional
                 <input
                   value={counterparty}
                   onChange={(event) => setCounterparty(event.target.value)}
                   className="mt-1 h-9 w-full border border-[#AC9C8D] bg-white px-2"
                 />
               </label>}
               {canClassify && <label className="block">
                 Observación
                 <textarea
                   value={note}
                   onChange={(event) => setNote(event.target.value)}
                   className="mt-1 min-h-20 w-full border border-[#AC9C8D] bg-white p-2"
                 />
                </label>}
                {canClassify && selectedMovement.direction === "DEBE" && <div className="flex flex-wrap gap-2">
                  {selectedMovement.review_status === "PENDING" && selectedMovement.category_id && <Button type="button" size="sm" onClick={confirmMovement} disabled={classificationLoading}>Confirmar clasificación</Button>}
                  <Button type="button" size="sm" variant="outline" onClick={saveObservation} disabled={classificationLoading}>Guardar observación</Button>
                  <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    classificationLoading ||
                    !classificationCategoryId ||
                    !classificationContext?.pendingCount
                  }
                  onClick={() => saveMovement(true)}
                >
                  Aplicar a {classificationContext?.pendingCount ?? 0}{" "}
                  pendientes
                </Button>
                </div>}
               {canClassify && !classificationContext?.matchingRules?.length && (
                <div className="border-t border-[#D1C7BD] pt-4">
                  <p className="font-semibold">
                    Crear regla para movimientos similares
                  </p>
                  <label className="mt-2 block">
                    Nombre
                    <input
                      value={ruleName}
                      onChange={(event) => setRuleName(event.target.value)}
                      className="mt-1 h-8 w-full border border-[#AC9C8D] bg-white px-2"
                    />
                  </label>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <select
                      value={ruleType}
                      onChange={(event) =>
                        setRuleType(event.target.value as typeof ruleType)
                      }
                      className="h-8 border border-[#AC9C8D] bg-white px-2"
                    >
                      <option value="EXACT">EXACT</option>
                      <option value="CONTAINS">CONTAINS</option>
                      <option value="STARTS_WITH">STARTS_WITH</option>
                    </select>
                    <input
                      value={ruleValue}
                      onChange={(event) => setRuleValue(event.target.value)}
                      className="h-8 border border-[#AC9C8D] bg-white px-2"
                    />
                  </div>
                  <label className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={ruleApply}
                      onChange={(event) => setRuleApply(event.target.checked)}
                    />{" "}
                    Crear regla y aplicar a pendientes
                  </label>
                  <div className="mt-3 flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={ruleLoading || !classificationCategoryId}
                      onClick={getRulePreview}
                    >
                      Previsualizar regla
                    </Button>
                    {rulePreview && (
                      <Button
                        type="button"
                        size="sm"
                        disabled={ruleLoading}
                        onClick={createRule}
                      >
                        Crear regla
                      </Button>
                    )}
                  </div>
                  {rulePreview && (
                    <p className="mt-3 border border-[#AC9C8D] bg-white p-3">
                      Esta regla coincide con {rulePreview.matches.length}{" "}
                      movimientos: {rulePreview.pendingCount} pendientes,{" "}
                      {rulePreview.existingCount} ya clasificados
                      {rulePreview.conflict
                        ? ". Hay clasificación diferente."
                        : "."}
                    </p>
                  )}
                </div>
              )}
              {classificationMessage && (
                <p className="border border-red-200 bg-red-50 p-3 text-red-800">
                  {classificationMessage}
                </p>
              )}
                </div>
              </details>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <Sheet open={differenceOpen} onOpenChange={setDifferenceOpen}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto border-[#D1C7BD] bg-[#EFE9E1] sm:max-w-xl"
        >
          <SheetHeader className="border-b border-[#D1C7BD] bg-white">
            <SheetTitle>Incidencia de conciliación</SheetTitle>
            <SheetDescription>
              Esta diferencia representa saldo bancario real no explicado por
              movimientos importados. No crea ni modifica un movimiento
              bancario.
            </SheetDescription>
          </SheetHeader>
          {reconciliation && (
            <div className="space-y-4 p-5 text-xs">
              <div className="border border-[#D1C7BD] bg-white p-4">
                <p>
                  Fecha/cobertura:{" "}
                  <strong>
                    {date(reconciliation.financial_date)}
                  </strong>
                </p>
                <p className="mt-2">
                  Saldo inicial del período:{" "}
                  <strong>{money(data.monthly?.openingBalance)}</strong>
                </p>
                <p className="mt-1">
                  Saldo conocido antes de actualización:{" "}
                  <strong>
                    {money(data.monthly?.knownBalanceBefore)}
                  </strong>
                </p>
                <p className="mt-1">
                  Saldo explicado:{" "}
                  <strong>
                    {money(
                       Number(reconciliation.expected_balance),
                    )}
                  </strong>
                </p>
                <p className="mt-1">
                  Saldo informado por banco:{" "}
                  <strong>
                    {money(
                       Number(reconciliation.reported_balance),
                    )}
                  </strong>
                </p>
                <p className="mt-1">
                  Diferencia:{" "}
                  <strong>
                    {money(Number(reconciliation.amount_signed))}
                  </strong>
                </p>
                <p className="mt-1">
                  Estado: <strong>{reconciliation.status}</strong>
                </p>
              </div>
              <label className="block">
                Motivo
                <select
                  value={differenceReason}
                  onChange={(event) => setDifferenceReason(event.target.value)}
                  className="mt-1 h-9 w-full border border-[#AC9C8D] bg-white px-2"
                >
                  <option value="">Pendiente de identificar</option>
                   <option value="CLIENT_COLLECTION_NOT_LISTED">
                     Cobro de cliente no listado en cartola
                  </option>
                  <option value="UNLISTED_PAYMENT">
                    Pago/salida no listada
                  </option>
                  <option value="BANK_ADJUSTMENT">Ajuste bancario</option>
                  <option value="UNLISTED_TRANSFER">
                    Transferencia no listada
                  </option>
                  <option value="OTHER">Otro</option>
                </select>
              </label>
              <label className="block">
                Contraparte
                <input
                  value={differenceCounterparty}
                  onChange={(event) =>
                    setDifferenceCounterparty(event.target.value)
                  }
                  className="mt-1 h-9 w-full border border-[#AC9C8D] bg-white px-2"
                />
              </label>
              <label className="block">
                Observación
                <textarea
                  value={differenceNote}
                  onChange={(event) => setDifferenceNote(event.target.value)}
                  className="mt-1 min-h-24 w-full border border-[#AC9C8D] bg-white p-2"
                />
              </label>
              <p className="border border-[#AC9C8D] bg-white p-3">
                Afecta flujo de caja: <strong>Sí</strong>
                <br />
                Afecta P&amp;L directamente: <strong>No</strong>
              </p>
              {reconciliation.status === "PENDING" ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={differenceSaving}
                  onClick={identifyDifference}
                >
                  {differenceSaving
                    ? "Guardando..."
                    : "Marcar como identificado"}
                </Button>
              ) : (
                <p className="font-semibold text-[#52735A]">
                  Incidencia identificada
                </p>
              )}
              {differenceMessage && (
                <p className="border border-red-200 bg-red-50 p-3 text-red-800">
                  {differenceMessage}
                </p>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}

function MovementTable({
  data,
  year,
  month,
  accountId,
  scope,
  query,
  onNavigate,
  isNavigating,
  onSelect,
}: {
  data: CashFlowDashboard;
  year: number;
  month: number;
  accountId?: string;
  scope: "month" | "year";
  query: (
    year: number,
    month: number,
    account?: string,
    page?: number,
    classification?: "ALL" | "PENDING" | "REVIEWED" | "HISTORICAL",
    search?: string,
    category?: string,
    scope?: "month" | "year",
    direction?: "all" | "credit" | "debit",
  ) => string;
  onNavigate: (url: string) => void;
  isNavigating: boolean;
  onSelect: (movement: CashFlowDashboard["movements"][number]) => void;
}) {
  const pages = Math.max(1, Math.ceil(data.movementTotal / data.pageSize));
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-xs">
          <thead className="bg-[#F3EFEA] text-[10px] uppercase tracking-[0.1em] text-[#322D29]/55">
            <tr>
              <th className="px-4 py-3">Fecha</th>
              <th className="px-4 py-3">Operación / cuenta</th>
              <th className="px-4 py-3 text-right">Haber</th>
              <th className="px-4 py-3 text-right">Debe</th>
              <th className="px-4 py-3 text-right">Saldo</th>
               <th className="px-4 py-3">Categoría</th>
                <th className="px-4 py-3">Origen</th>
                <th className="px-4 py-3">Revisión</th>
                <th className="px-4 py-3">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {data.movements.map((row) => (
              <tr key={row.id} className="border-t border-[#EEE8E1]">
                <td className={`px-4 py-3 tabular-nums ${row.review_status === "PENDING" ? "border-l-4 border-l-[#A23E48] bg-[#FFF8F6]" : ""}`}>
                  {date(row.transaction_date)}
                </td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    className="text-left hover:text-[#72383D] hover:underline"
                    onClick={() => onSelect(row)}
                  >
                    {row.operation_description}
                  </button>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {money(Number(row.credit_amount))}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {money(Number(row.debit_amount))}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {money(Number(row.balance_after))}
                </td>
                <td className="px-4 py-3">{row.category_name ?? "—"}</td>
                 <td className="px-4 py-3">
                   {row.category_id
                     ? (row.classification_source ?? "Clasificado")
                     : "Pendiente de clasificación"}
                 </td>
                   <td className="px-4 py-3">
                     {row.direction === "HABER" ? "—" : row.review_status === "HISTORICAL" ? "Histórico" : row.review_status === "REVIEWED" ? "Revisado" : row.review_status === "PENDING" ? (
                       <span className="inline-flex items-center gap-1.5 font-semibold text-[#A23E48]" title="Clasificación pendiente de confirmación">
                         <span className="h-1.5 w-1.5 rounded-full bg-[#A23E48]" aria-hidden="true" />
                         Pendiente
                       </span>
                     ) : "—"}
                   </td>
                  <td className="px-4 py-3">
                    {row.direction === "DEBE" && row.category_code === "EXPENSE_SALARIES_WAGES" ? (
                      <button
                        type="button"
                        className="font-semibold text-[#72383D] underline underline-offset-2 hover:text-[#4F2529]"
                        onClick={() => onSelect(row)}
                      >
                        Desglosar nómina
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
               </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-[#D1C7BD] px-4 py-3 text-xs">
        <span>
          Página {data.page} de {pages}
        </span>
        <div className="flex gap-2">
          <a
            className="border border-[#AC9C8D] px-2 py-1"
            aria-disabled={isNavigating || data.page <= 1}
            onClick={(event) => {
              event.preventDefault();
              if (isNavigating || data.page <= 1) return;
              onNavigate(query(year, month, accountId, Math.max(1, data.page - 1), data.pageFilters.classificationFilter, data.pageFilters.search, data.pageFilters.categoryId ?? "", scope, data.pageFilters.direction));
            }}
            href={query(year, month, accountId, Math.max(1, data.page - 1), data.pageFilters.classificationFilter, data.pageFilters.search, data.pageFilters.categoryId ?? "", scope, data.pageFilters.direction)}
          >
            Anterior
          </a>
          <a
            className="border border-[#AC9C8D] px-2 py-1"
            aria-disabled={isNavigating || data.page >= pages}
            onClick={(event) => {
              event.preventDefault();
              if (isNavigating || data.page >= pages) return;
              onNavigate(query(year, month, accountId, Math.min(pages, data.page + 1), data.pageFilters.classificationFilter, data.pageFilters.search, data.pageFilters.categoryId ?? "", scope, data.pageFilters.direction));
            }}
            href={query(year, month, accountId, Math.min(pages, data.page + 1), data.pageFilters.classificationFilter, data.pageFilters.search, data.pageFilters.categoryId ?? "", scope, data.pageFilters.direction)}
          >
            Siguiente
          </a>
        </div>
      </div>
    </>
  );
}

function PendingDebitAuditPanel({
  data,
  accounts,
  accountId,
  categories,
  categoryId,
  createRule,
  search,
  selected,
  previewOpen,
  message,
  loading,
  applying,
  onSearchChange,
  onAccountChange,
  onCategoryChange,
  onCreateRuleChange,
  onSearch,
  onClose,
  onToggle,
  onSelectVisible,
  onDeselect,
  onPreview,
  onCancelPreview,
  onApply,
  onPage,
  onViewMovements,
}: {
  data: PendingDebitAudit
  accounts: FinancialBankAccount[]
  accountId: string
  categories: FinancialCategory[]
  categoryId: string
  createRule: boolean
  search: string
  selected: string[]
  previewOpen: boolean
  message: string
  loading: boolean
  applying: boolean
  onSearchChange: (value: string) => void
  onAccountChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onCreateRuleChange: (value: boolean) => void
  onSearch: () => void
  onClose: () => void
  onToggle: (key: string) => void
  onSelectVisible: () => void
  onDeselect: () => void
  onPreview: () => void
  onCancelPreview: () => void
  onApply: () => void
  onPage: (page: number) => void
  onViewMovements: (group: PendingDebitAudit["groups"][number]) => void
}) {
  const pages = Math.max(1, Math.ceil(data.totalGroups / data.pageSize))
  const selectedGroups = data.groups.filter((group) => selected.includes(group.groupKey))
  const selectedMovements = selectedGroups.reduce((sum, group) => sum + group.movementCount, 0)
  const selectedAmount = selectedGroups.reduce((sum, group) => sum + Number(group.totalDebit), 0)
  const monthLabels = (months: number[]) => months.map((month) => MONTHS[month - 1]).join(" · ")

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#322D29]/40 p-4 sm:pt-10">
      <div className="w-full max-w-6xl border border-[#D1C7BD] bg-[#FAF8F5] shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#D1C7BD] bg-white px-5 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Auditoría de tesorería</p>
            <h3 className="mt-1 text-lg font-semibold">Débitos pendientes por contraparte / operación</h3>
           <p className="mt-1 text-xs text-[#322D29]/65">{data.totalGroups.toLocaleString("es-CL")} grupos pendientes en el alcance actual · sólo DEBE, año seleccionado y movimientos sin categoría.</p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-[#322D29]/55">Cerrar</button>
        </div>
        <div className="border-b border-[#D1C7BD] px-5 py-3">
          <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
            <input aria-label="Buscar grupo pendiente" placeholder="Buscar nombre o descripción" value={search} onChange={(event) => onSearchChange(event.target.value)} className="h-8 w-64 border border-[#AC9C8D] bg-white px-2 text-xs" />
            <select aria-label="Cuenta bancaria de auditoría" value={accountId} onChange={(event) => onAccountChange(event.target.value)} className="h-8 border border-[#AC9C8D] bg-white px-2 text-xs">
              <option value={ALL_ACCOUNTS}>Todas las cuentas</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
            </select>
            <Button type="submit" size="sm" variant="outline" disabled={loading}>Buscar</Button>
            <Button type="button" size="sm" variant="outline" onClick={onSelectVisible} disabled={loading || !data.groups.length}>Seleccionar visibles</Button>
            <Button type="button" size="sm" variant="outline" onClick={onDeselect} disabled={!selected.length}>Deseleccionar</Button>
            <span className="ml-auto text-xs text-[#322D29]/65">Página {data.page} de {pages} · {selected.length} seleccionados</span>
          </form>
        </div>
        <div className="max-h-[58vh] overflow-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="sticky top-0 bg-[#F3EFEA] text-[10px] uppercase tracking-[0.1em] text-[#322D29]/55">
              <tr><th className="w-10 px-4 py-3" /><th className="px-4 py-3">Banco</th><th className="px-4 py-3">Contraparte / operación</th><th className="px-4 py-3 text-right">Mov.</th><th className="px-4 py-3 text-right">Total débito</th><th className="px-4 py-3">Período</th><th className="px-4 py-3">Montos observados</th><th className="px-4 py-3">Acción</th></tr>
            </thead>
            <tbody>
              {data.groups.map((group) => (
                <tr key={group.groupKey} className="border-t border-[#EEE8E1] bg-white">
                  <td className="px-4 py-3"><input type="checkbox" aria-label={`Seleccionar ${group.counterparty}`} checked={selected.includes(group.groupKey)} onChange={() => onToggle(group.groupKey)} /></td>
                  <td className="px-4 py-3"><p className="font-semibold">{group.bankName}</p><p className="mt-1 text-[11px] text-[#322D29]/55">{group.maskedAccountNumber}</p></td>
                  <td className="px-4 py-3"><p className="font-semibold">{group.counterparty}</p><p className="mt-1 text-[11px] text-[#322D29]/55">{group.operationDescription}</p><p className="mt-1 text-[11px] text-[#322D29]/55">{date(group.firstDate)} a {date(group.lastDate)}</p></td>
                  <td className="px-4 py-3 text-right tabular-nums">{group.movementCount}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(Number(group.totalDebit))}</td>
                  <td className="px-4 py-3">{monthLabels(group.months)}</td>
                  <td className="px-4 py-3 tabular-nums">{group.sampleAmounts.map((amount) => money(Number(amount))).join(" · ")}</td>
                  <td className="px-4 py-3"><button type="button" className="font-semibold text-[#72383D] underline" onClick={() => onViewMovements(group)}>Ver movimientos</button></td>
                </tr>
              ))}
              {!data.groups.length && <tr><td colSpan={8} className="px-4 py-10 text-center text-[#322D29]/60">No hay grupos pendientes para este alcance.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-[#D1C7BD] px-5 py-3 text-xs">
          <div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={loading || data.page <= 1} onClick={() => onPage(data.page - 1)}>Anterior</Button><Button type="button" size="sm" variant="outline" disabled={loading || data.page >= pages} onClick={() => onPage(data.page + 1)}>Siguiente</Button></div>
          <Button type="button" size="sm" disabled={!selected.length || applying} onClick={onPreview}>Previsualizar aplicación</Button>
        </div>
        {previewOpen && (
          <div className="border-t border-[#72383D] bg-[#F3E8E4] px-5 py-4 text-xs">
             <p className="font-semibold">Confirmar clasificación histórica</p>
             <p className="mt-2">Grupos seleccionados: <strong>{selected.length}</strong> · Movimientos pendientes afectados: <strong>{selectedMovements}</strong> · Monto total: <strong>{money(selectedAmount)}</strong></p>
             <div className="mt-2 max-h-28 overflow-auto border border-[#D1C7BD] bg-white p-2">{selectedGroups.map((group) => <p key={group.groupKey}>{group.bankName} · {group.maskedAccountNumber} · {group.counterparty} · {group.movementCount} movimientos · {money(Number(group.totalDebit))}</p>)}</div>
             <label className="mt-3 block font-semibold">Categoría destino:
               <select value={categoryId} onChange={(event) => onCategoryChange(event.target.value)} className="mt-1 h-9 w-full border border-[#AC9C8D] bg-white px-2 font-normal">
                 <option value="">Selecciona una categoría leaf</option>
                 {debitCategoryGroups(categories).map((group) => <optgroup key={group.root.id} label={group.root.name}>{group.children.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</optgroup>)}
               </select>
             </label>
             <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={createRule} onChange={(event) => onCreateRuleChange(event.target.checked)} />Crear regla EXACTA AUTO por banco y descripción normalizada</label>
             <p className="mt-3 text-[#322D29]/75">Sólo movimientos pendientes; ninguna clasificación existente será sobrescrita y no se crearán movimientos. Las reglas conflictivas no se aplican automáticamente.</p>
             <div className="mt-3 flex gap-2"><Button type="button" size="sm" disabled={applying || !categoryId} onClick={onApply}>{applying ? "Aplicando..." : "Confirmar y clasificar"}</Button><Button type="button" size="sm" variant="outline" onClick={onCancelPreview}>Cancelar</Button></div>
          </div>
        )}
        {message && <p className="border-t border-[#D1C7BD] px-5 py-3 text-xs text-[#52735A]">{message}</p>}
      </div>
    </div>
  )
}

function PendingDebitAuditDetailPanel({
  group,
  account,
  data,
  categories,
  beneficiaries,
  categoryId,
  createRule,
  beneficiaryValues,
  conceptValues,
  selected,
  previewOpen,
  message,
  loading,
  applying,
  onClose,
  onToggle,
  onCategoryChange,
  onCreateRuleChange,
  onBeneficiaryChange,
  onConceptChange,
  onApplyBulkDetails,
  onCreateBeneficiary,
  onSelectVisible,
  onDeselect,
  onPreview,
  onCancelPreview,
  onApply,
  onPage,
}: {
  group: PendingDebitAudit["groups"][number]
  account?: FinancialBankAccount
  data: PendingDebitAuditDetail
  categories: FinancialCategory[]
  beneficiaries: PersonnelBeneficiary[]
  categoryId: string
  createRule: boolean
  beneficiaryValues: Record<string, string>
  conceptValues: Record<string, "SUELDO" | "QUINCENA" | "BONO" | "ANTICIPO" | "OTRO">
  selected: string[]
  previewOpen: boolean
  message: string
  loading: boolean
  applying: boolean
  onClose: () => void
  onToggle: (id: string) => void
  onCategoryChange: (categoryId: string) => void
  onCreateRuleChange: (value: boolean) => void
  onBeneficiaryChange: (movementId: string, beneficiaryId: string) => void
  onConceptChange: (movementId: string, concept: "SUELDO" | "QUINCENA" | "BONO" | "ANTICIPO" | "OTRO") => void
  onApplyBulkDetails: (beneficiaryId: string, concept: "SUELDO" | "QUINCENA" | "BONO" | "ANTICIPO" | "OTRO") => void
  onCreateBeneficiary: () => void
  onSelectVisible: () => void
  onDeselect: () => void
  onPreview: () => void
  onCancelPreview: () => void
  onApply: () => void
  onPage: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(data.totalMovements / data.pageSize))
  const selectedMovements = data.movements.filter((movement) => selected.includes(movement.id))
  const selectedAmount = selectedMovements.reduce((sum, movement) => sum + Number(movement.debitAmount), 0)
  const counterparty = group.counterparty
  const category = categories.find((item) => item.id === categoryId)
  const selectableGroups = debitCategoryGroups(categories)
  const isOffBook = category?.code === "EXPENSE_PERSONNEL_OFF_BOOK"
  const [bulkBeneficiary, setBulkBeneficiary] = useState("")
  const [bulkConcept, setBulkConcept] = useState<"SUELDO" | "QUINCENA" | "BONO" | "ANTICIPO" | "OTRO">("SUELDO")
  const concepts = ["SUELDO", "QUINCENA", "BONO", "ANTICIPO", "OTRO"] as const
  const detailsReady = !isOffBook || selectedMovements.every((movement) => beneficiaryValues[movement.id] && conceptValues[movement.id])

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-[#322D29]/50 p-4 sm:pt-16">
      <div className="w-full max-w-5xl border border-[#D1C7BD] bg-[#FAF8F5] shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#D1C7BD] bg-white px-5 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Detalle lazy del grupo</p>
             <h3 className="mt-1 text-lg font-semibold">{counterparty}</h3>
             <p className="mt-1 text-xs font-semibold text-[#322D29]/70">{account ? accountLabel(account) : `${group.bankName} · ${group.maskedAccountNumber}`}</p>
             <p className="mt-1 text-xs text-[#322D29]/65">Sólo movimientos DEBE que siguen pendientes · {data.totalMovements} movimientos.</p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-[#322D29]/55">Cerrar detalle</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-[#D1C7BD] px-5 py-3 text-xs">
          <Button type="button" size="sm" variant="outline" onClick={onSelectVisible} disabled={loading || !data.movements.length}>Seleccionar visibles</Button>
          <Button type="button" size="sm" variant="outline" onClick={onDeselect} disabled={!selected.length}>Deseleccionar todos</Button>
          <span className="ml-auto">{selected.length} seleccionados · Página {data.page} de {pages}</span>
        </div>
        <div className="max-h-[55vh] overflow-auto">
          <table className="w-full min-w-[950px] text-left text-xs">
            <thead className="sticky top-0 bg-[#F3EFEA] text-[10px] uppercase tracking-[0.1em] text-[#322D29]/55">
              <tr><th className="w-10 px-4 py-3" /><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Descripción bancaria</th><th className="px-4 py-3 text-right">Haber</th><th className="px-4 py-3 text-right">Debe</th><th className="px-4 py-3 text-right">Saldo</th><th className="px-4 py-3">Categoría / estado</th></tr>
            </thead>
            <tbody>
              {data.movements.map((movement) => (
                <tr key={movement.id} className="border-t border-[#EEE8E1] bg-white">
                  <td className="px-4 py-3"><input type="checkbox" aria-label={`Seleccionar movimiento ${movement.id}`} checked={selected.includes(movement.id)} onChange={() => onToggle(movement.id)} /></td>
                  <td className="px-4 py-3 tabular-nums">{date(movement.transactionDate)}</td>
                  <td className="px-4 py-3"><p>{movement.operationDescription}</p><p className="mt-1 text-[10px] text-[#322D29]/45">Fila {movement.sourceRowNumber}</p></td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(Number(movement.creditAmount))}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(Number(movement.debitAmount))}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(Number(movement.balanceAfter))}</td>
                  <td className="px-4 py-3">
                    {isOffBook ? <div className="min-w-[270px] space-y-1">
                      <span className="block text-[10px] text-[#322D29]/55">Receptor bancario: {counterparty}</span>
                      <select value={beneficiaryValues[movement.id] ?? ""} onChange={(event) => onBeneficiaryChange(movement.id, event.target.value)} className="h-8 w-full border border-[#AC9C8D] bg-white px-1">
                        <option value="">Beneficiario real *</option>
                        {beneficiaries.map((beneficiary) => <option key={beneficiary.id} value={beneficiary.id}>{beneficiary.display_name}</option>)}
                      </select>
                      <select value={conceptValues[movement.id] ?? ""} onChange={(event) => onConceptChange(movement.id, event.target.value as typeof concepts[number])} className="h-8 w-full border border-[#AC9C8D] bg-white px-1">
                        <option value="">Concepto *</option>{concepts.map((concept) => <option key={concept} value={concept}>{concept}</option>)}
                      </select>
                    </div> : `${movement.categoryName ?? "Sin categoría"} · ${movement.classificationStatus === "PENDING" ? "Pendiente" : movement.classificationStatus}`}
                  </td>
                </tr>
              ))}
              {!data.movements.length && <tr><td colSpan={7} className="px-4 py-10 text-center text-[#322D29]/60">No quedan movimientos pendientes en este grupo.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="border-t border-[#D1C7BD] bg-white px-5 py-4 text-xs">
           <label className="block font-semibold">
             Categoría destino:
             <select value={categoryId} onChange={(event) => onCategoryChange(event.target.value)} className="mt-1 h-9 w-full border border-[#AC9C8D] bg-white px-2 font-normal">
               <option value="">Selecciona una categoría leaf</option>
               {selectableGroups.map((categoryGroup) => (
                 <optgroup key={categoryGroup.root!.id} label={categoryGroup.root!.name}>
                   {categoryGroup.children.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
                 </optgroup>
               ))}
             </select>
           </label>
             {category && <p className="mt-2 text-[#322D29]/70">Afecta flujo de caja: <strong>{category.affects_cash_flow ? "Sí" : "No"}</strong> · Afecta P&amp;L directamente: <strong>{category.affects_pnl_directly ? "Sí" : "No"}</strong></p>}
             {!isOffBook && <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={createRule} onChange={(event) => onCreateRuleChange(event.target.checked)} />Crear regla EXACTA AUTO por banco y descripción normalizada</label>}
            {isOffBook && <div className="mt-3 border-t border-[#D1C7BD] pt-3">
              <p className="font-semibold">Aplicar a seleccionados ({selected.length})</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <select value={bulkBeneficiary} onChange={(event) => setBulkBeneficiary(event.target.value)} className="h-8 min-w-[220px] border border-[#AC9C8D] bg-white px-2"><option value="">Beneficiario para seleccionados</option>{beneficiaries.map((beneficiary) => <option key={beneficiary.id} value={beneficiary.id}>{beneficiary.display_name}</option>)}</select>
                <select value={bulkConcept} onChange={(event) => setBulkConcept(event.target.value as typeof concepts[number])} className="h-8 border border-[#AC9C8D] bg-white px-2">{concepts.map((concept) => <option key={concept} value={concept}>{concept}</option>)}</select>
                <Button type="button" size="sm" variant="outline" disabled={!selected.length || !bulkBeneficiary} onClick={() => onApplyBulkDetails(bulkBeneficiary, bulkConcept)}>Aplicar a seleccionados</Button>
                <Button type="button" size="sm" variant="outline" onClick={onCreateBeneficiary}>+ Crear beneficiario</Button>
              </div>
            </div>}
         </div>
        <div className="flex items-center justify-between border-t border-[#D1C7BD] px-5 py-3 text-xs">
          <div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={loading || data.page <= 1} onClick={() => onPage(data.page - 1)}>Anterior</Button><Button type="button" size="sm" variant="outline" disabled={loading || data.page >= pages} onClick={() => onPage(data.page + 1)}>Siguiente</Button></div>
           <Button type="button" size="sm" disabled={!selected.length || !categoryId || !detailsReady || applying} onClick={onPreview}>Previsualizar aplicación</Button>
        </div>
         {previewOpen && (
          <div className="border-t border-[#72383D] bg-[#F3E8E4] px-5 py-4 text-xs">
            <p className="font-semibold">Confirmar clasificación de movimientos seleccionados</p>
            <p className="mt-2">Movimientos seleccionados: <strong>{selected.length}</strong> · Monto total: <strong>{money(selectedAmount)}</strong></p>
            <div className="mt-2 max-h-28 overflow-auto border border-[#D1C7BD] bg-white p-2">{selectedMovements.map((movement) => <p key={movement.id}>{date(movement.transactionDate)} · {counterparty} · {money(Number(movement.debitAmount))}</p>)}</div>
             <p className="mt-3 text-[#322D29]/75">Destino: <strong>{category?.name}</strong>. Flujo de caja: <strong>{category?.affects_cash_flow ? "Sí" : "No"}</strong> · P&amp;L directo: <strong>{category?.affects_pnl_directly ? "Sí" : "No"}</strong> · Fuente: Cartola bancaria · Estado remuneraciones: <strong>{isOffBook ? "Fuera de libro / no conciliado" : "Pendiente"}</strong>.</p>
              <div className="mt-2 max-h-32 overflow-auto border border-[#D1C7BD] bg-white p-2">{selectedMovements.map((movement) => <p key={movement.id}>{date(movement.transactionDate)} · receptor {counterparty} · {isOffBook ? `${beneficiaries.find((item) => item.id === beneficiaryValues[movement.id])?.display_name ?? "—"} · ${conceptValues[movement.id] ?? "—"}` : category?.name} · {money(Number(movement.debitAmount))}</p>)}</div>
              <div className="mt-3 flex gap-2"><Button type="button" size="sm" disabled={applying || !selected.length || !categoryId || !detailsReady} onClick={onApply}>{applying ? "Aplicando..." : "Confirmar y clasificar"}</Button><Button type="button" size="sm" variant="outline" onClick={onCancelPreview}>Cancelar</Button></div>
          </div>
        )}
        {message && <p className="border-t border-[#D1C7BD] px-5 py-3 text-xs text-[#52735A]">{message}</p>}
      </div>
    </div>
  )
}

function BeneficiaryModal({
  saving,
  message,
  onClose,
  onSave,
}: {
  saving: boolean
  message: string
  onClose: () => void
  onSave: (input: { displayName: string; rut?: string; note?: string }) => void
}) {
  const [displayName, setDisplayName] = useState("")
  const [rut, setRut] = useState("")
  const [note, setNote] = useState("")
  return <div className="fixed inset-0 z-[80] flex items-start justify-center bg-[#322D29]/50 p-4 sm:pt-24">
    <form className="w-full max-w-md border border-[#D1C7BD] bg-[#FAF8F5] p-5 shadow-xl" onSubmit={(event) => { event.preventDefault(); if (displayName.trim()) onSave({ displayName, rut, note }) }}>
      <div className="flex items-start justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Catálogo reusable</p><h3 className="mt-1 text-lg font-semibold">Crear beneficiario real</h3></div><button type="button" onClick={onClose} className="text-xs text-[#322D29]/55">Cerrar</button></div>
      <label className="mt-4 block text-xs font-semibold">Nombre *<input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-1 h-9 w-full border border-[#AC9C8D] bg-white px-2 font-normal" /></label>
      <label className="mt-3 block text-xs font-semibold">RUT opcional<input value={rut} onChange={(event) => setRut(event.target.value)} className="mt-1 h-9 w-full border border-[#AC9C8D] bg-white px-2 font-normal" /></label>
      <label className="mt-3 block text-xs font-semibold">Observación opcional<textarea value={note} onChange={(event) => setNote(event.target.value)} className="mt-1 min-h-20 w-full border border-[#AC9C8D] bg-white p-2 font-normal" /></label>
      {message && <p className="mt-3 border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{message}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button type="button" size="sm" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit" size="sm" disabled={saving || !displayName.trim()}>{saving ? "Guardando..." : "Crear beneficiario"}</Button></div>
    </form>
  </div>
}

function ImportCartola({
  accounts,
  selectedAccountId,
  onAccountSelected,
  onAccountCreated,
  onClose,
  onConfirmed,
}: {
  accounts: FinancialBankAccount[];
  selectedAccountId: string;
  onAccountSelected: (accountId: string) => void;
  onAccountCreated: (account: FinancialBankAccount) => void;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"OPEN" | "CLOSED" | "FINAL_CLOSE">("OPEN");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const [newAccount, setNewAccount] = useState({
    bankName: "",
    accountNumber: "",
  });
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const selectedBankName = selectedAccount?.bank_name;
  const isItau = isItauBank(selectedBankName);
  const isBancoChile = isBancoChileBank(selectedBankName);
  const acceptedExtensions = isItau
    ? ".pdf"
    : isBancoChile
      ? mode === "OPEN"
        ? ".xls,.xlsx"
        : ".csv,.txt,.text"
      : "";
  const resetFileState = () => {
    setSelectedFile(null);
    setPreview(null);
    setMessage("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const changeMode = (nextMode: "OPEN" | "CLOSED" | "FINAL_CLOSE") => {
    setMode(nextMode);
    resetFileState();
  };
  const analyze = () =>
    startTransition(async () => {
      if (!selectedFile)
        return setMessage("Selecciona una cartola antes de analizar.");
      try {
        const formData = new FormData();
        formData.set("file", selectedFile);
        formData.set("mode", mode);
        formData.set("accountId", selectedAccountId);
        const result = await previewFinancialBankStatement(formData);
        if (result.ok) {
          setPreview(result);
          setMessage("");
        } else setMessage(result.message);
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "No se pudo analizar el archivo.",
        );
      }
    });
  const confirm = () => {
    if (!preview) return;
    startTransition(async () => {
      try {
        const input = {
          accountId: selectedAccountId,
          filename: preview.filename,
          fileHash: preview.fileHash,
          parsed: preview.parsed,
        };
        const result =
          preview.mode === "OPEN"
            ? await confirmOpenFinancialBankStatement(input)
            : preview.mode === "FINAL_CLOSE"
              ? await confirmFinalFinancialBankStatement(input)
              : await confirmFinancialBankStatement(input);
        if (result.ok) onConfirmed();
        else setMessage(result.message);
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "No se pudo confirmar la cartola.",
        );
      }
    });
  };
  const addAccount = () =>
    startTransition(async () => {
      try {
        const result = await createFinancialBankAccount({
          bankName: newAccount.bankName,
          accountType: "CHECKING",
          accountNumber: newAccount.accountNumber,
        });
        if (result.ok) {
          onAccountCreated(result.account);
          setNewAccount({ bankName: "", accountNumber: "" });
          setMessage("Cuenta creada y seleccionada.");
        } else setMessage(result.message);
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "No se pudo crear la cuenta.",
        );
      }
    });
  const openPreview = preview?.mode === "OPEN" ? preview.openPreview : null;
  const finalPreview = preview?.mode === "FINAL_CLOSE" ? preview.finalPreview : null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#322D29]/40 p-4 sm:pt-12">
      <div className="w-full max-w-3xl border border-[#D1C7BD] bg-[#FAF8F5] p-5 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">
              Importación
            </p>
            <h3 className="mt-1 text-lg font-semibold">
              Actualizar cartola bancaria
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-[#322D29]/55"
          >
            Cerrar
          </button>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => changeMode("OPEN")}
            className={`border p-3 text-left text-xs ${mode === "OPEN" ? "border-[#72383D] bg-[#F3E8E4]" : "border-[#D1C7BD] bg-white"}`}
          >
            <strong>Actualizar mes actual</strong>
            <span className="mt-1 block text-[#322D29]/60">
              {isBancoChile
                ? "Banco de Chile: XLS/XLSX acumulado de movimientos del mes actual."
                : isItau
                  ? "Itaú: PDF de consulta de movimientos del mes actual."
                  : "Selecciona una cuenta para ver el formato compatible."}
            </span>
          </button>
          <button
            type="button"
            onClick={() => changeMode("FINAL_CLOSE")}
            className={`border p-3 text-left text-xs ${mode === "FINAL_CLOSE" ? "border-[#72383D] bg-[#F3E8E4]" : "border-[#D1C7BD] bg-white"}`}
          >
            <strong>Cerrar mes con cartola definitiva</strong>
            <span className="mt-1 block text-[#322D29]/60">
              {isBancoChile
                ? "Banco de Chile: cartola definitiva en CSV o texto separado por punto y coma."
                : isItau
                  ? "Itaú: PDF definitivo."
                  : "Selecciona una cuenta para ver el formato compatible."}
            </span>
          </button>
          <button
            type="button"
            onClick={() => changeMode("CLOSED")}
            className={`border p-3 text-left text-xs ${mode === "CLOSED" ? "border-[#72383D] bg-[#F3E8E4]" : "border-[#D1C7BD] bg-white"}`}
          >
            <strong>Importar mes histórico cerrado</strong>
            <span className="mt-1 block text-[#322D29]/60">
              {isBancoChile
                ? "Banco de Chile: cartola definitiva histórica en CSV o texto separado por punto y coma."
                : isItau
                  ? "Itaú: PDF definitivo histórico."
                  : "Selecciona una cuenta para ver el formato compatible."}
            </span>
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs">
            Cuenta bancaria
            <select
              value={selectedAccountId}
              onChange={(event) => {
                onAccountSelected(event.target.value);
                resetFileState();
              }}
              className="mt-1 block h-9 w-full border border-[#AC9C8D] bg-white px-2"
            >
              <option value="" disabled>
                {accounts.length
                  ? "Selecciona una cuenta"
                  : "No hay cuentas creadas"}
              </option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {accountLabel(account)}
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs">
            <input
              ref={fileInputRef}
              type="file"
              accept={acceptedExtensions}
              hidden
              onChange={(event) => {
                setSelectedFile(event.target.files?.[0] ?? null);
                setPreview(null);
                setMessage("");
              }}
            />
            <p>Archivo de cartola{acceptedExtensions ? ` (${acceptedExtensions.replaceAll(",", ", ")})` : ""}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload /> Seleccionar archivo
            </Button>
            {selectedFile && (
              <p className="mt-2 truncate text-[11px] text-[#322D29]/65">
                {selectedFile.name}
              </p>
            )}
            <Button
              type="button"
              size="sm"
              className="mt-2"
              disabled={pending || !selectedFile || !selectedAccountId}
              onClick={analyze}
            >
              Analizar archivo
            </Button>
          </div>
        </div>
        {openPreview && (
          <div className="mt-4 grid gap-2 border border-[#AC9C8D] bg-white p-4 text-xs sm:grid-cols-2">
            <p className="sm:col-span-2 font-semibold uppercase tracking-[0.1em]">
              {MONTHS[openPreview.month - 1]} {openPreview.year} · ABIERTO
            </p>
            <p>
              Movimientos guardados previamente: <strong>{openPreview.existingCount}</strong>
            </p>
            <p>
              Filas archivo: <strong>{openPreview.rowsInFile}</strong>
            </p>
             <p>Coincidencias exactas: <strong>{openPreview.exactMatchCount}</strong></p>
             <p>Saldos reexpresados por el banco: <strong>{openPreview.balanceRestatementCount}</strong></p>
            <p>
              Nuevos: <strong>{openPreview.newCount}</strong>
            </p>
             <p>
               Conflictos reales:{" "}
              <strong
                className={openPreview.conflictCount ? "text-red-700" : ""}
              >
                {openPreview.conflictCount}
              </strong>
             </p>
             {openPreview.balanceRestatementCount > 0 && (
               <p className="sm:col-span-2 border border-[#D1C7BD] bg-[#F8F4EE] p-2">
                 El banco actualizó el saldo acumulado mostrado para {openPreview.balanceRestatementCount} movimientos ya registrados. Los movimientos originales y sus clasificaciones no serán modificados.
               </p>
             )}
            <p>
              Saldo cierre período anterior:{" "}
              <strong>{money(openPreview.previousClosingBalance)}</strong>
            </p>
            <p>
              Saldo inicial detectado:{" "}
              <strong>{money(openPreview.detectedOpeningBalance)}</strong>
            </p>
            <p>
              Diferencia:{" "}
              <strong>{money(openPreview.openingDifference)}</strong>
            </p>
            <p>
              Cobertura anterior:{" "}
              <strong>{date(openPreview.coveragePrevious)}</strong>
            </p>
            <p>
              Nueva cobertura: <strong>{date(openPreview.coverageNew)}</strong>
            </p>
            <p>
              Saldo conocido antes:{" "}
              <strong>{money(openPreview.currentBalanceBefore)}</strong>
            </p>
            <p>
              Saldo informado después:{" "}
              <strong>{money(openPreview.resultingBalance)}</strong>
            </p>
            <p>
              {openPreview.balanceRestatementCount > 0
                ? "Saldo según base anterior + movimientos nuevos: "
                : "Saldo explicado: "}
              <strong>{money(openPreview.explainedBalance)}</strong>
            </p>
            <p>
              Haber acumulado:{" "}
              <strong>{money(openPreview.totalCredits)}</strong>
            </p>
            <p>
              Debe acumulado: <strong>{money(openPreview.totalDebits)}</strong>
            </p>
            <p>
              Haber nuevos: <strong>{money(openPreview.newCredits)}</strong>
            </p>
            <p>
              Debe nuevos: <strong>{money(openPreview.newDebits)}</strong>
            </p>
            <p>
              Neto nuevos: <strong>{money(openPreview.newNet)}</strong>
            </p>
            {openPreview.conflictCount > 0 && (
              <div className="sm:col-span-2 mt-2 border-t border-red-200 pt-3">
                <p className="font-semibold text-red-700">Movimientos en conflicto</p>
                <div className="mt-2 space-y-2">
                  {openPreview.conflicts.map((conflict) => (
                    <div key={conflict.index} className="border border-red-200 bg-red-50 p-2 text-[11px]">
                      <p className="font-semibold">Fila {conflict.file.sourceRowNumber} · índice {conflict.index}</p>
                      <div className="mt-1 grid gap-1 sm:grid-cols-2">
                        <div>
                          <p className="font-semibold">Archivo</p>
                          <p>{date(conflict.file.date)} · {conflict.file.description}</p>
                          <p>Cargo: {money(conflict.file.debit)} · Abono: {money(conflict.file.credit)} · Saldo: {money(conflict.file.balance)}</p>
                          <p>Documento: {conflict.file.documentNumber ?? "—"} · Sucursal: {conflict.file.branch ?? "—"}</p>
                        </div>
                        <div>
                          <p className="font-semibold">Registro actual</p>
                          {conflict.existing ? (
                            <>
                              <p>{date(conflict.existing.date)} · {conflict.existing.description}</p>
                              <p>Cargo: {money(conflict.existing.debit)} · Abono: {money(conflict.existing.credit)} · Saldo: {money(conflict.existing.balance)}</p>
                              <p>Documento: {conflict.existing.documentNumber ?? "—"} · Sucursal: {conflict.existing.branch ?? "—"}</p>
                            </>
                          ) : <p>No se encontró el registro actual asociado.</p>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="sm:col-span-2 mt-2 border-t border-[#D1C7BD] pt-3">
              <p className="font-semibold">Conciliación bancaria del archivo</p>
              <p className="mt-1">
                Saldo inicial + Haber - Debe = Saldo final · Diferencia:{" "}
                <strong
                  className={
                    openPreview.fileGlobalDifference
                      ? "text-red-700"
                      : "text-green-700"
                  }
                >
                  {money(openPreview.fileGlobalDifference)}
                </strong>
              </p>
               {openPreview.balanceRestatementCount > 0 && (
                 <p className="mt-2 font-semibold">
                   Reexpresión de saldo detectada · Ajuste respecto del saldo previamente informado:{" "}
                   <strong>{money(openPreview.restatementAdjustment)}</strong>
                 </p>
               )}
               {openPreview.balanceRestatementCount > 0 && !openPreview.restatementDeltasUniform && (
                 <p className="mt-2 text-red-700">
                   La reexpresión de saldos es compleja porque los ajustes no son uniformes.
                 </p>
               )}
               <p className="mt-2 font-semibold">
                 Diferencia inexplicada:{" "}
                 <strong className={openPreview.unexplainedDifference ? "text-red-700" : "text-green-700"}>
                   {money(openPreview.unexplainedDifference)}
                 </strong>
               </p>
              {openPreview.existingNotInFileCount > 0 && (
                <p className="mt-2 text-red-700">
                   Movimientos existentes ausentes del archivo:{" "}
                  {openPreview.existingNotInFileCount}
                </p>
              )}
            </div>
          </div>
        )}
        {preview?.mode === "CLOSED" && (
          <div className="mt-4 border border-[#AC9C8D] bg-white p-4 text-xs">
            <strong>
              {preview.parsed.bankName ?? "Banco no identificado"} · {MONTHS[preview.parsed.month - 1]} {preview.parsed.year} · CERRADO
            </strong>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              <p>Cuenta: {preview.parsed.accountNumber ? `•••• ${preview.parsed.accountNumber.slice(-4)}` : "—"}</p>
              <p>Movimientos: {preview.parsed.rowCount}</p>
              <p>Saldo inicial: {money(preview.parsed.openingBalance)}</p>
              <p>Créditos: {money(preview.parsed.totalCredits)}</p>
              <p>Débitos: {money(preview.parsed.totalDebits)}</p>
              <p>Saldo final: {money(preview.parsed.closingBalance)}</p>
            </div>
            {(preview.parsed.creditLineUsed !== null && preview.parsed.creditLineUsed !== undefined || preview.parsed.creditLineAvailable !== null && preview.parsed.creditLineAvailable !== undefined) && (
              <p className="mt-2 border-t border-[#D1C7BD] pt-2">
                Línea utilizada: {money(preview.parsed.creditLineUsed)} · Línea disponible: {money(preview.parsed.creditLineAvailable)}
              </p>
            )}
          </div>
        )}
        {finalPreview && (
          <div className="mt-4 grid gap-2 border border-[#AC9C8D] bg-white p-4 text-xs sm:grid-cols-2">
            <p className="sm:col-span-2 font-semibold uppercase tracking-[0.1em]">
              {MONTHS[finalPreview.month - 1]} {finalPreview.year} · CIERRE DEFINITIVO
            </p>
            <p>Existentes: <strong>{finalPreview.existingCount}</strong></p>
            <p>Coincidentes: <strong>{finalPreview.matchedCount}</strong></p>
            <p>Filas en cartola: <strong>{finalPreview.rowsInFile}</strong></p>
            <p>Nuevas: <strong>{finalPreview.newCount}</strong></p>
            <p>Conflictos: <strong className={finalPreview.conflictCount ? "text-red-700" : ""}>{finalPreview.conflictCount}</strong></p>
            <p>Ambiguos: <strong className={finalPreview.ambiguousCount ? "text-red-700" : ""}>{finalPreview.ambiguousCount}</strong></p>
            <p>Saldo inicial: <strong>{money(finalPreview.detectedOpeningBalance)}</strong></p>
            <p>Saldo cierre: <strong>{money(finalPreview.closingBalance)}</strong></p>
            <p>Diferencia inicial: <strong className={finalPreview.openingDifference ? "text-red-700" : "text-green-700"}>{money(finalPreview.openingDifference)}</strong></p>
            <p>Diferencia global: <strong className={finalPreview.globalDifference ? "text-red-700" : "text-green-700"}>{money(finalPreview.globalDifference)}</strong></p>
            <p>Diferencia fila a fila: <strong className={finalPreview.rowDifference ? "text-red-700" : "text-green-700"}>{money(finalPreview.rowDifference)}</strong></p>
            {finalPreview.existingNotInFileCount > 0 && <p className="sm:col-span-2 text-red-700">Movimientos existentes ausentes: {finalPreview.existingNotInFileCount}</p>}
          </div>
        )}
        <div className="mt-4 border-t border-[#D1C7BD] pt-4">
          <p className="text-[10px] uppercase tracking-[0.13em] text-[#AC9C8D]">
            ¿No existe la cuenta?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              placeholder="Banco"
              value={newAccount.bankName}
              onChange={(event) =>
                setNewAccount({ ...newAccount, bankName: event.target.value })
              }
              className="h-8 border border-[#AC9C8D] bg-white px-2 text-xs"
            />
            <input
              placeholder="Número de cuenta"
              value={newAccount.accountNumber}
              onChange={(event) =>
                setNewAccount({
                  ...newAccount,
                  accountNumber: event.target.value,
                })
              }
              className="h-8 border border-[#AC9C8D] bg-white px-2 text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={addAccount}
            >
              <Plus /> Crear
            </Button>
          </div>
        </div>
        {message && (
          <p className="mt-4 border border-red-200 bg-red-50 p-3 text-xs text-red-800">
            {message}
          </p>
        )}
        {((openPreview && !openPreview.canConfirm) || (finalPreview && !finalPreview.canConfirm)) && (
          <p className="mt-4 border border-red-200 bg-red-50 p-3 text-xs text-red-800">
            Confirmación bloqueada: existen conflictos, faltantes o una
            inconsistencia de movimientos.
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={
              pending ||
              !preview ||
              (preview.mode === "OPEN" && !preview.openPreview.canConfirm) ||
              (preview.mode === "FINAL_CLOSE" && !preview.finalPreview.canConfirm)
            }
            onClick={confirm}
          >
            Confirmar importación
          </Button>
        </div>
      </div>
    </div>
  );
}
