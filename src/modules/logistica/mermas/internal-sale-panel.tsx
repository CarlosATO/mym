"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Loader2,
  Plus,
  Printer,
  Search,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import {
  createInternalSale,
  getInternalSaleCatalog,
  getInternalSaleWorkerContext,
  searchInternalSaleEmployees,
  type InternalSaleEmployee,
  type InternalSaleProduct,
  type InternalSaleWorkerContext,
} from "@/app/actions/logistica/mermas";
import { formatCivilDate } from "@/lib/datetime";
import { useMermasModule } from "./mermas-module-provider";
import {
  buildInternalSalePrintHtml,
  MAX_INTERNAL_SALE_PRINT_LINES,
  type InternalSalePrintDraft,
} from "./internal-sale-print-document";
import {
  calculateMinimumUnitPrice,
} from "./worker-pricing";

type CartLine = {
  product: InternalSaleProduct;
  quantity: number | null;
  unitPrice: number | null;
};
type SaleResult = Record<string, unknown>;

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

function formatMoney(value: number | null | undefined) {
  return money.format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function displayResultEmployee(result: SaleResult) {
  const employee = result.employee as { name?: string } | undefined;
  return employee?.name ?? "Trabajador";
}

function readableError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "No se pudo cargar la información.";
}

function isValidQuantity(
  line: CartLine,
): line is CartLine & { quantity: number } {
  return (
    line.quantity !== null &&
    Number.isFinite(line.quantity) &&
    line.quantity > 0 &&
    line.quantity <= line.product.eligible_stock
  );
}

function isValidUnitPrice(
  line: CartLine,
): line is CartLine & { unitPrice: number } {
  const minimum = calculateMinimumUnitPrice(line.product.average_cost);
  return line.unitPrice !== null
    && Number.isInteger(line.unitPrice)
    && line.unitPrice > 0
    && minimum !== null
    && line.unitPrice >= minimum;
}

export function InternalSalePanel() {
  const { invalidateWarehouse, invalidateWorkerAccounts } = useMermasModule();
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [employeeOptionsOpen, setEmployeeOptionsOpen] = useState(true);
  const [employees, setEmployees] = useState<InternalSaleEmployee[]>([]);
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [selectedEmployee, setSelectedEmployee] =
    useState<InternalSaleEmployee | null>(null);
  const [workerContext, setWorkerContext] =
    useState<InternalSaleWorkerContext | null>(null);
  const [employeeError, setEmployeeError] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [catalog, setCatalog] = useState<InternalSaleProduct[]>([]);
  const [productLoading, setProductLoading] = useState(true);
  const [productError, setProductError] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshingAfterSale, setRefreshingAfterSale] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SaleResult | null>(null);
  const [printError, setPrintError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setEmployeeLoading(true);
      setEmployeeError("");
      try {
        const response = await searchInternalSaleEmployees(employeeSearch);
        setEmployees(response.data);
        if (response.error) setEmployeeError(response.error);
      } catch (loadError) {
        setEmployeeError(readableError(loadError));
      } finally {
        setEmployeeLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [employeeSearch]);

  useEffect(() => {
    let cancelled = false;
    void getInternalSaleCatalog()
      .then((response) => {
        if (cancelled) return;
        setCatalog(response.data);
        if (response.error) setProductError(response.error);
      })
      .catch((loadError) => {
        if (!cancelled) setProductError(readableError(loadError));
      })
      .finally(() => {
        if (!cancelled) setProductLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const products = useMemo(() => {
    const normalized = productSearch.trim().toLocaleLowerCase("es-CL");
    return catalog
      .filter((product) =>
        !normalized ||
        `${product.sku} ${product.product_name}`
          .toLocaleLowerCase("es-CL")
          .includes(normalized),
      )
      .slice(0, 50);
  }, [catalog, productSearch]);

  const total = useMemo(
    () =>
      cart.reduce(
        (sum, line) =>
          sum +
          (isValidQuantity(line) && isValidUnitPrice(line)
            ? line.unitPrice * line.quantity
            : 0),
        0,
      ),
    [cart],
  );
  const afterSale =
    workerContext?.monthly_limit === null || !workerContext
      ? null
      : workerContext.monthly_limit - workerContext.monthly_used - total;
  const cartHasInvalidQuantity = cart.some((line) => !isValidQuantity(line));
  const cartHasInvalidUnitPrice = cart.some((line) => !isValidUnitPrice(line));
  const canConfirm =
    Boolean(
      selectedEmployee && workerContext && workerContext.monthly_limit !== null,
    ) &&
    cart.length > 0 &&
    !cartHasInvalidQuantity &&
    !cartHasInvalidUnitPrice &&
    total > 0 &&
    !productLoading &&
    !refreshingAfterSale &&
    (afterSale ?? -1) >= 0;
  const printLineLimitExceeded = cart.length > MAX_INTERNAL_SALE_PRINT_LINES;
  const canGenerate = canConfirm && !printLineLimitExceeded;

  function selectEmployee(employee: InternalSaleEmployee) {
    setEmployeeOptionsOpen(false);
    setPrintError("");
    setSelectedEmployee(employee);
    setEmployeeSearch(employee.display_name);
    setEmployees([]);
    setWorkerContext(null);
    setError("");
    void getInternalSaleWorkerContext(employee.id)
      .then((response) => {
        if (response.data) setWorkerContext(response.data);
        else setError(response.error ?? "No se pudo cargar el cupo mensual.");
      })
      .catch((loadError) => setError(readableError(loadError)));
  }

  function addProduct(product: InternalSaleProduct) {
    setError("");
    setPrintError("");
    setCart((current) => {
      const existing = current.find(
        (line) => line.product.bsale_variant_id === product.bsale_variant_id,
      );
      if (existing) return current;
      return [
        ...current,
        { product, quantity: 1, unitPrice: product.worker_unit_price },
      ];
    });
  }

  function updateQuantity(variantId: number, value: string) {
    const quantity = value.trim() === "" ? null : Number(value);
    setPrintError("");
    setCart((current) =>
      current.map((line) =>
        line.product.bsale_variant_id === variantId
          ? { ...line, quantity }
          : line,
      ),
    );
  }

  function updateUnitPrice(variantId: number, value: string) {
    const unitPrice = value.trim() === "" ? null : Number(value);
    setPrintError("");
    setCart((current) =>
      current.map((line) => {
        if (line.product.bsale_variant_id !== variantId) return line;
        return {
          ...line,
          unitPrice,
        };
      }),
    );
  }

  function removeLine(variantId: number) {
    setPrintError("");
    setCart((current) =>
      current.filter((line) => line.product.bsale_variant_id !== variantId),
    );
  }

  async function generatePrintDocument() {
    if (!selectedEmployee || !canGenerate) return;
    setPrintError("");
    const draft: InternalSalePrintDraft = {
      employee: selectedEmployee,
      lines: cart
        .filter(isValidQuantity)
        .filter(isValidUnitPrice)
        .map((line) => ({
          product: line.product,
          quantity: line.quantity,
          unitPrice: line.unitPrice as number,
        })),
      total,
      generatedAt: new Date().toISOString(),
    };
    await printDraftInIsolatedFrame(draft);
  }

  async function printDraftInIsolatedFrame(draft: InternalSalePrintDraft) {
    const existingFrame = document.getElementById("print-frame");
    existingFrame?.remove();
    const frame = document.createElement("iframe");
    frame.id = "print-frame";
    frame.title = "Documento de impresión";
    frame.setAttribute("aria-hidden", "true");
    frame.style.position = "fixed";
    frame.style.width = "1px";
    frame.style.height = "1px";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.border = "0";
    frame.style.opacity = "0";
    frame.style.pointerEvents = "none";
    document.body.appendChild(frame);

    const printDocument = frame.contentDocument;
    const printWindow = frame.contentWindow;
    if (!printDocument || !printWindow) {
      frame.remove();
      setPrintError(
        "No se pudo preparar el documento para impresión. Inténtalo nuevamente.",
      );
      return;
    }

    printDocument.open();
    printDocument.write(buildInternalSalePrintHtml(draft));
    printDocument.close();

    try {
      await printDocument.fonts.ready;
      await new Promise<void>((resolve) =>
        printWindow.requestAnimationFrame(() =>
          printWindow.requestAnimationFrame(() => resolve()),
        ),
      );
      const sheet = printDocument.querySelector(".print-sheet");
      const content = printDocument.querySelector(
        ".print-content",
      ) as HTMLElement | null;
      if (!sheet || !content)
        throw new Error("No se pudo medir el documento de impresión.");
      const sheetHeight = sheet.getBoundingClientRect().height;
      const availableHeight = sheetHeight * (277 / 297);
      const contentHeight = content.scrollHeight;
      const scale = Math.min(1, availableHeight / contentHeight);
      if (!Number.isFinite(scale) || scale < 0.82) {
        frame.remove();
        setPrintError(
          "Esta venta contiene demasiados productos para generar el comprobante en una sola hoja. Divide la venta en dos operaciones.",
        );
        return;
      }
      content.style.transform = `scale(${scale})`;
      content.style.height = `${contentHeight}px`;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        window.clearTimeout(cleanupTimer);
        frame.remove();
      };
      const cleanupTimer = window.setTimeout(cleanup, 120000);
      printWindow.onafterprint = cleanup;
      printWindow.focus();
      printWindow.print();
    } catch {
      frame.remove();
      setPrintError("No se pudo preparar el documento para impresión.");
    }
  }

  async function refreshAfterConflict() {
    setProductLoading(true);
    try {
      const [catalogResponse, contextResponse] = await Promise.all([
        getInternalSaleCatalog(),
        selectedEmployee
          ? getInternalSaleWorkerContext(selectedEmployee.id)
          : Promise.resolve({ data: null }),
      ]);
      setCatalog(catalogResponse.data);
      setCart((current) =>
        current.map((line) => {
          const refreshedProduct = catalogResponse.data.find(
            (product) =>
              product.bsale_variant_id === line.product.bsale_variant_id,
          );
          return refreshedProduct
            ? {
                ...line,
                product: {
                  ...refreshedProduct,
                  worker_unit_price: line.unitPrice ?? refreshedProduct.worker_unit_price,
                },
              }
            : line;
        }),
      );
      if (contextResponse.data) setWorkerContext(contextResponse.data);
      if (catalogResponse.error) setProductError(catalogResponse.error);
    } catch (loadError) {
      setProductError(readableError(loadError));
    } finally {
      setProductLoading(false);
    }
  }

  async function refreshAfterSale() {
    setProductLoading(true);
    setProductError("");
    try {
      const [catalogResponse, contextResponse] = await Promise.all([
        getInternalSaleCatalog(),
        selectedEmployee
          ? getInternalSaleWorkerContext(selectedEmployee.id)
          : Promise.resolve({ data: null }),
      ]);
      setCatalog(catalogResponse.data);
      if (contextResponse.data) setWorkerContext(contextResponse.data);
      if (catalogResponse.error) setProductError(catalogResponse.error);
    } catch (loadError) {
      setProductError(readableError(loadError));
    } finally {
      setProductLoading(false);
    }
  }

  async function confirmSale() {
    if (!selectedEmployee || !canConfirm) return;
    setSubmitting(true);
    setError("");
    const response = await createInternalSale(
      selectedEmployee.id,
      cart.filter(isValidQuantity).map((line) => ({
        bsale_variant_id: line.product.bsale_variant_id,
        quantity: line.quantity,
        unit_price: line.unitPrice,
      })),
    );
    if (response.success) {
      invalidateWarehouse();
      invalidateWorkerAccounts();
      setConfirmOpen(false);
      setResult(response.data ?? {});
      setRefreshingAfterSale(true);
      void refreshAfterSale().finally(() => setRefreshingAfterSale(false));
    } else {
      setConfirmOpen(false);
      setError(response.error ?? "No se pudo registrar la venta.");
      await refreshAfterConflict();
    }
    setSubmitting(false);
  }

  function resetSale() {
    if (refreshingAfterSale) return;
    setResult(null);
    setEmployeeOptionsOpen(true);
    setSelectedEmployee(null);
    setWorkerContext(null);
    setEmployeeSearch("");
    setCart([]);
    setError("");
    setProductError("");
    setPrintError("");
    setRefreshingAfterSale(true);
    void refreshAfterSale().finally(() => setRefreshingAfterSale(false));
  }

  if (result) {
    const monthlyRemaining = Number(result.monthly_remaining ?? 0);
    return (
      <div className="min-h-[calc(100vh-7.5rem)] bg-theme-surface">
        <div className="border-b border-theme-border/60 bg-theme-text/[0.012] px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-theme-accent">
            Venta a trabajadores
          </p>
          <h1 className="mt-1 text-base font-semibold text-theme-text">
            Venta registrada
          </h1>
        </div>
        <div className="mx-auto max-w-3xl p-5">
          <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-6 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
            <p className="mt-3 text-xs font-bold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">
              Venta registrada
            </p>
            <p className="mt-2 font-mono text-2xl font-bold text-theme-text">
              {String(result.sale_number ?? "-")}
            </p>
            <p className="mt-3 text-sm text-theme-text-muted">
              {displayResultEmployee(result)}
            </p>
            <p className="mt-1 text-xl font-semibold text-theme-text">
              {formatMoney(Number(result.total ?? total))}
            </p>
            <span className="mt-4 inline-flex rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
              PENDIENTE DE RENDICIÓN
            </span>
            <div className="mx-auto mt-6 grid max-w-md grid-cols-2 gap-3 text-left text-sm">
              <Metric
                label="Utilizado después"
                value={formatMoney(Number(result.monthly_used_after ?? 0))}
              />
              <Metric
                label="Cupo restante"
                value={formatMoney(monthlyRemaining)}
              />
            </div>
            <button
              type="button"
              onClick={resetSale}
              disabled={refreshingAfterSale}
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-theme-accent px-4 py-2.5 text-xs font-semibold text-white hover:bg-theme-accent-hover disabled:cursor-wait disabled:opacity-60"
            >
              {refreshingAfterSale && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {refreshingAfterSale
                ? "Actualizando disponibilidad..."
                : "Nueva venta"}
            </button>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-7.5rem)] bg-theme-bg p-3 sm:p-5">
      <header className="mb-4 flex flex-col gap-3 rounded-2xl border border-theme-border bg-theme-surface px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <Link
            href="/dashboard/logistica/mermas"
            className="text-xs font-semibold text-theme-text-accent hover:underline"
          >
            ← Volver a Mermas
          </Link>
          <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.22em] text-theme-accent">
            Mermas · Punto de venta
          </p>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-theme-text">
            Venta a trabajadores
          </h1>
          <p className="mt-1 text-xs text-theme-text-muted">
            Selecciona un trabajador, agrega productos y prepara la operación.
          </p>
        </div>
        <div className="rounded-xl border border-theme-border bg-theme-text/[0.025] px-3 py-2 text-right">
          <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">
            Estado
          </p>
          <p className="mt-0.5 text-xs font-semibold text-theme-accent">
            Venta interna · Stock elegible
          </p>
        </div>
      </header>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_410px]">
        <main className="space-y-4">
          <section className="rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <SectionHeading eyebrow="01" title="Trabajador" />
              {selectedEmployee && (
                <span className="rounded-full bg-theme-accent/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-theme-accent">
                  Seleccionado
                </span>
              )}
            </div>
            <div className="relative mt-4">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-theme-text-muted" />
              <input
                value={employeeSearch}
                onChange={(event) => {
                  setEmployeeOptionsOpen(true);
                  setEmployeeSearch(event.target.value);
                  if (
                    selectedEmployee &&
                    event.target.value !== selectedEmployee.display_name
                  ) {
                    setPrintError("");
                    setSelectedEmployee(null);
                    setWorkerContext(null);
                  }
                }}
                placeholder="Buscar por nombre, apellido o RUT"
                className="w-full rounded-xl border border-theme-border bg-theme-bg py-3 pl-9 pr-3 text-sm text-theme-text outline-none transition focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/15"
              />
              {employeeOptionsOpen &&
                (employeeLoading || employees.length > 0) && (
                  <div className="absolute z-20 mt-2 max-h-64 w-full overflow-auto rounded-xl border border-theme-border bg-theme-surface p-1.5 shadow-xl">
                    {employeeLoading && (
                      <div className="px-3 py-3 text-xs text-theme-text-muted">
                        Buscando trabajadores...
                      </div>
                    )}
                    {!employeeLoading &&
                      employees.map((employee) => (
                        <button
                          key={employee.id}
                          type="button"
                          onClick={() => selectEmployee(employee)}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-theme-accent/10"
                        >
                          <UserRound className="h-4 w-4 shrink-0 text-theme-accent" />
                          <span>
                            <strong className="block text-xs text-theme-text">
                              {employee.display_name}
                            </strong>
                            <span className="text-[11px] text-theme-text-muted">
                              {employee.rut}
                              {employee.cargo ? ` · ${employee.cargo}` : ""}
                            </span>
                          </span>
                        </button>
                      ))}
                    {!employeeLoading && employees.length === 0 && (
                      <div className="px-3 py-3 text-xs text-theme-text-muted">
                        No hay trabajadores ACTIVO que coincidan.
                      </div>
                    )}
                  </div>
                )}
            </div>
            {employeeError && (
              <p className="mt-2 text-xs text-red-600">{employeeError}</p>
            )}
            {selectedEmployee && workerContext && (
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <Metric
                  label="Límite mensual"
                  value={
                    workerContext.monthly_limit === null
                      ? "No configurado"
                      : formatMoney(workerContext.monthly_limit)
                  }
                />
                <Metric
                  label="Utilizado"
                  value={formatMoney(workerContext.monthly_used)}
                />
                <Metric
                  label="Disponible"
                  value={
                    workerContext.monthly_available === null
                      ? "-"
                      : formatMoney(workerContext.monthly_available)
                  }
                />
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <SectionHeading eyebrow="02" title="Catálogo elegible" />
                <p className="mt-1 text-xs text-theme-text-muted">
                  Precios de trabajador y stock actualizado.
                </p>
                {productLoading && catalog.length > 0 && (
                  <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-theme-text-muted">
                    <Loader2 className="h-3 w-3 animate-spin" /> Actualizando stock...
                  </p>
                )}
              </div>
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-theme-text-muted" />
                <input
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                  placeholder="Buscar SKU o producto"
                  className="w-full rounded-xl border border-theme-border bg-theme-bg py-2 pl-9 pr-3 text-xs text-theme-text outline-none focus:border-theme-accent"
                />
              </div>
            </div>
            {productError && (
              <p className="mt-3 text-xs text-red-600">{productError}</p>
            )}
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {productLoading && catalog.length === 0 && (
                <div className="col-span-full flex items-center gap-2 rounded-xl border border-dashed border-theme-border px-3 py-8 text-xs text-theme-text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Cargando stock elegible...
                </div>
              )}
              {!productLoading &&
                products.map((product) => {
                  const inCart = cart.some(
                    (line) =>
                      line.product.bsale_variant_id ===
                      product.bsale_variant_id,
                  );
                  return (
                    <article
                      key={product.bsale_variant_id}
                      className="group flex min-h-[190px] flex-col justify-between rounded-2xl border border-theme-border bg-theme-bg p-3 transition hover:-translate-y-0.5 hover:border-theme-accent/50 hover:shadow-md"
                    >
                      <div>
                        <div className="flex h-24 items-center justify-center rounded-xl border border-theme-border/60 bg-theme-accent/[0.07] text-2xl font-black text-theme-accent/50">
                          <span className="font-mono text-sm">
                            {product.sku}
                          </span>
                        </div>
                        <p className="mt-3 line-clamp-2 min-h-9 text-sm font-bold text-theme-text">
                          {product.product_name}
                        </p>
                        <p className="mt-1 text-[11px] text-theme-text-muted">
                          Stock:{" "}
                          <strong className="text-theme-text">
                            {product.eligible_stock}
                          </strong>{" "}
                          · Vence:{" "}
                          {formatCivilDate(product.next_eligible_expiration)}
                        </p>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <span className="text-base font-black text-theme-accent">
                          {formatMoney(product.worker_unit_price)}
                        </span>
                        <button
                          type="button"
                          disabled={inCart}
                          onClick={() => addProduct(product)}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-theme-accent px-3 py-2 text-[11px] font-bold text-white transition hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:bg-theme-text/15 disabled:text-theme-text-muted"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {inCart ? "Agregado" : "Agregar"}
                        </button>
                      </div>
                    </article>
                  );
                })}
              {!productLoading && products.length === 0 && (
                <p className="col-span-full px-2 py-8 text-center text-xs text-theme-text-muted">
                  No hay productos elegibles para venta.
                </p>
              )}
            </div>
          </section>
        </main>

        <aside className="h-fit rounded-2xl border border-theme-border bg-theme-surface shadow-lg xl:sticky xl:top-4">
          <div className="flex items-center justify-between border-b border-theme-border px-4 py-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-theme-accent">
                03 · Checkout
              </p>
              <h2 className="mt-1 text-lg font-bold text-theme-text">
                Resumen de venta
              </h2>
            </div>
            <span className="rounded-full bg-theme-text/[0.05] px-2.5 py-1 text-[11px] font-bold text-theme-text-muted">
              {cart.length} {cart.length === 1 ? "producto" : "productos"}
            </span>
          </div>
          <div className="border-b border-theme-border px-4 py-3">
            {selectedEmployee ? (
              <p className="truncate text-xs text-theme-text-muted">
                Trabajador{" "}
                <strong className="text-theme-text">
                  {selectedEmployee.display_name}
                </strong>
              </p>
            ) : (
              <p className="text-xs text-theme-text-muted">
                Selecciona un trabajador para comenzar.
              </p>
            )}
          </div>
          <div className="max-h-[430px] overflow-y-auto px-4">
            {cart.length === 0 && (
              <div className="my-4 rounded-xl border border-dashed border-theme-border px-4 py-10 text-center text-xs text-theme-text-muted">
                Agrega productos del catálogo para preparar la venta.
              </div>
            )}
            {cart.map((line) => {
              const validQuantity = isValidQuantity(line);
              const minimumUnitPrice = calculateMinimumUnitPrice(line.product.average_cost);
              const validUnitPrice = isValidUnitPrice(line);
              return (
                <div
                  key={line.product.bsale_variant_id}
                  className="border-b border-theme-border/70 py-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-[10px] font-bold text-theme-accent">
                        {line.product.sku}
                      </p>
                      <p className="mt-0.5 truncate text-xs font-bold text-theme-text">
                        {line.product.product_name}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Quitar ${line.product.product_name}`}
                      onClick={() => removeLine(line.product.bsale_variant_id)}
                      className="rounded-lg p-1 text-theme-text-muted hover:bg-red-500/10 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-3">
                    <label className="text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted">
                      Cantidad
                      <input
                        type="number"
                        min="0.001"
                        step="any"
                        value={
                          line.quantity !== null &&
                          Number.isFinite(line.quantity)
                            ? line.quantity
                            : ""
                        }
                        aria-invalid={!validQuantity}
                        onChange={(event) =>
                          updateQuantity(
                            line.product.bsale_variant_id,
                            event.target.value,
                          )
                        }
                        className={`mt-1 block w-20 rounded-lg border bg-theme-bg px-2 py-1.5 text-xs text-theme-text outline-none ${validQuantity ? "border-theme-border" : "border-red-500"}`}
                      />
                      {line.quantity !== null &&
                      line.quantity > line.product.eligible_stock ? (
                        <span className="mt-1 block text-[10px] font-medium normal-case text-red-600">
                          Máximo disponible: {line.product.eligible_stock}
                        </span>
                      ) : !validQuantity ? (
                        <span className="mt-1 block text-[10px] font-medium normal-case text-red-600">
                          Cantidad inválida.
                        </span>
                      ) : (
                        <span className="mt-1 block text-[10px] font-normal normal-case">
                          máx. {line.product.eligible_stock}
                        </span>
                      )}
                    </label>
                    <div className="text-right">
                      <label className="block text-left text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted">
                        Precio unitario
                        <input
                          type="number"
                          min={minimumUnitPrice ?? undefined}
                          step="1"
                          value={line.unitPrice ?? ""}
                          inputMode="numeric"
                          aria-invalid={!validUnitPrice}
                          onChange={(event) => updateUnitPrice(line.product.bsale_variant_id, event.target.value)}
                          className={`mt-1 block w-28 rounded-lg border bg-theme-bg px-2 py-1.5 text-right text-xs text-theme-text outline-none ${validUnitPrice ? "border-theme-border" : "border-red-500"}`}
                        />
                      </label>
                      <p className="mt-1 text-[10px] text-theme-text-muted">
                        Mínimo: {minimumUnitPrice === null ? "-" : formatMoney(minimumUnitPrice)}
                      </p>
                      <p className="text-[10px] text-theme-text-muted">
                        Sugerido: {formatMoney(line.product.worker_unit_price)}
                      </p>
                      <p className="mt-1 text-sm font-black text-theme-text">
                        {validQuantity && validUnitPrice
                          ? formatMoney(line.unitPrice * line.quantity)
                          : "—"}
                      </p>
                      {!validUnitPrice && (
                        <p className="mt-1 max-w-28 text-[10px] font-medium normal-case text-red-600">
                          El precio mínimo permitido es {minimumUnitPrice === null ? "-" : formatMoney(minimumUnitPrice)}.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-theme-border px-4 py-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-theme-text">
                Total
              </span>
              <strong className="text-2xl font-black text-theme-accent">
                {formatMoney(total)}
              </strong>
            </div>
            {workerContext && (
              <div className="mt-4 grid grid-cols-3 gap-2 text-[10px]">
                <Metric
                  label="Límite"
                  value={
                    workerContext.monthly_limit === null
                      ? "-"
                      : formatMoney(workerContext.monthly_limit)
                  }
                />
                <Metric
                  label="Utilizado"
                  value={formatMoney(workerContext.monthly_used)}
                />
                <Metric
                  label="Después"
                  value={afterSale === null ? "-" : formatMoney(afterSale)}
                />
              </div>
            )}
            {afterSale !== null && afterSale < 0 && (
              <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300">
                La venta supera el cupo mensual disponible.
              </p>
            )}
            {cartHasInvalidQuantity && (
              <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300">
                Corrige las cantidades marcadas antes de confirmar.
              </p>
            )}
            {cartHasInvalidUnitPrice && (
              <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300">
                Corrige los precios unitarios: deben ser pesos enteros iguales o superiores al mínimo.
              </p>
            )}
            {error && (
              <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300">
                {error}
              </p>
            )}
            {printError && (
              <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300">
                {printError}
              </p>
            )}
            {printLineLimitExceeded && (
              <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-800 dark:text-amber-300">
                Esta venta contiene demasiados productos para generar el
                comprobante en una sola hoja. Divide la venta en dos
                operaciones.
              </p>
            )}
            <div className="mt-5 grid gap-2">
              <button
                type="button"
                disabled={!canGenerate}
                onClick={() => void generatePrintDocument()}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-theme-accent px-4 py-3 text-xs font-bold uppercase tracking-wide text-theme-accent hover:bg-theme-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Printer className="h-4 w-4" />
                Generar documento
              </button>
              <button
                type="button"
                disabled={!canConfirm || submitting}
                onClick={() => setConfirmOpen(true)}
                className="rounded-xl bg-theme-accent px-4 py-3 text-xs font-bold uppercase tracking-wide text-white hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Confirmar venta
              </button>
            </div>
          </div>
        </aside>
      </div>
      {confirmOpen && (
        <ConfirmationDialog
          employee={selectedEmployee}
          cart={cart}
          total={total}
          afterSale={afterSale}
          submitting={submitting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void confirmSale()}
        />
      )}
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
}: {
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] font-bold text-theme-accent">
        {eyebrow}
      </span>
      <h2 className="text-sm font-semibold text-theme-text">{title}</h2>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-theme-border bg-theme-surface px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-theme-text-muted">
        {label}
      </p>
      <p className="mt-1 text-xs font-bold text-theme-text">{value}</p>
    </div>
  );
}

function ConfirmationDialog({
  employee,
  cart,
  total,
  afterSale,
  submitting,
  onCancel,
  onConfirm,
}: {
  employee: InternalSaleEmployee | null;
  cart: CartLine[];
  total: number;
  afterSale: number | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-internal-sale"
    >
      <div className="w-full max-w-md rounded-2xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-theme-accent">
              Confirmar operación
            </p>
            <h2
              id="confirm-internal-sale"
              className="mt-1 text-lg font-semibold text-theme-text"
            >
              Confirmar venta a trabajador
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1 text-theme-text-muted hover:bg-theme-text/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="mt-5 space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-theme-text-muted">Trabajador</dt>
            <dd className="text-right font-semibold text-theme-text">
              {employee?.display_name}
              <span className="block text-xs font-normal">{employee?.rut}</span>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-theme-text-muted">Productos</dt>
            <dd className="font-semibold text-theme-text">{cart.length}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-theme-text-muted">Total</dt>
            <dd className="font-bold text-theme-text">{formatMoney(total)}</dd>
          </div>
          <div className="flex justify-between border-t border-theme-border pt-3">
            <dt className="text-theme-text-muted">Disponible después</dt>
            <dd className="font-bold text-theme-text">
              {afterSale === null ? "-" : formatMoney(afterSale)}
            </dd>
          </div>
        </dl>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-xl border border-theme-border px-4 py-2.5 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-theme-accent px-4 py-2.5 text-xs font-bold text-white hover:bg-theme-accent-hover disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar venta
          </button>
        </div>
      </div>
    </div>
  );
}
