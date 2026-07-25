"use client";

import { Check, ChevronLeft, ChevronRight, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import {
  createGuidedCommissionRule,
  searchCommissionProducts,
  searchCommissionSuppliers,
  type CommissionGroup,
  type CommissionRule,
  type CommissionRuleType,
  type CommissionSeller,
} from "@/app/actions/comercial/commissions";
import { cn, formatPercent, parsePercent } from "@/lib/utils";
import { ExistingRules } from "./components/rules/rules-list";
import {
  Chips,
  Field,
  Item,
  Mode,
  ProductResults,
  SearchBox,
  SupplierResults,
  Title,
} from "./components/rules/rule-ui";
import type {
  Product,
  Supplier,
  TargetMode,
} from "./commission-rules-wizard-types";

const stepNames = [
  "Identificación",
  "Alcance y selección",
  "Vendedores",
  "Comisión",
  "Resumen",
];
const today = () => new Date().toISOString().slice(0, 10);

export function CommissionRulesWizard({
  sellers,
  groups,
  rules,
  onSaved,
  onError,
}: {
  sellers: CommissionSeller[];
  groups: CommissionGroup[];
  rules: CommissionRule[];
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState("");
  const [mode, setMode] = useState<TargetMode>("SUPPLIER_ALL_PRODUCTS");
  const [allSellers, setAllSellers] = useState(true);
  const [sellerIds, setSellerIds] = useState<string[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierResults, setSupplierResults] = useState<Supplier[]>([]);
  const [supplierQuery, setSupplierQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [productQuery, setProductQuery] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [type, setType] = useState<CommissionRuleType>("FIXED_PERCENT");
  const [percent, setPercent] = useState("");
  const [minQuantity, setMinQuantity] = useState("");
  const [maxQuantity, setMaxQuantity] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [loading, setLoading] = useState<
    "suppliers" | "products" | "save" | null
  >(null);
  const eligibleSellers = sellers.filter(
    (seller) =>
      seller.is_commissionable &&
      seller.profile_active === true &&
      seller.seller_profile_id,
  );
  const supplierMode =
    mode === "SUPPLIER_ALL_PRODUCTS" || mode === "SUPPLIER_SELECTED_PRODUCTS";

  const validate = () => {
    if (step === 0 && !name.trim()) {
      onError("Ingresa un nombre para la condición.");
      return false;
    }
    if (step === 0 && (!from || (to && to < from))) {
      onError(
        to && to < from
          ? "La fecha final no puede ser anterior a la fecha inicial."
          : "Indica la fecha de inicio.",
      );
      return false;
    }
    if (step === 2 && !allSellers && !sellerIds.length) {
      onError("Selecciona al menos un vendedor comisionable.");
      return false;
    }
    if (step === 1 && supplierMode && !suppliers.length) {
      onError("Selecciona al menos un proveedor.");
      return false;
    }
    if (
      step === 1 &&
      (mode === "SUPPLIER_SELECTED_PRODUCTS" || mode === "SELECTED_PRODUCTS") &&
      !products.length
    ) {
      onError("Selecciona al menos un producto.");
      return false;
    }
    if (step === 1 && mode === "EXISTING_GROUP" && !groupIds.length) {
      onError("Selecciona al menos un grupo de productos.");
      return false;
    }
    if (step === 3 && !percent) {
      onError("Indica un porcentaje de comisión.");
      return false;
    }
    if (
      step === 3 &&
      type === "RANGE_BY_QUANTITY" &&
      !(Number(minQuantity) > 0)
    ) {
      onError("Debes indicar una cantidad mínima.");
      return false;
    }
    if (step === 3 && type === "RANGE_BY_AMOUNT" && !(Number(minAmount) > 0)) {
      onError("Debes indicar un monto mínimo.");
      return false;
    }
    return true;
  };

  const add = <T extends { id: string }>(
    item: T,
    update: React.Dispatch<React.SetStateAction<T[]>>,
  ) =>
    update((current) =>
      current.some((value) => value.id === item.id) ? current : [...current, item],
    );

  const next = () => {
    if (validate()) setStep((current) => Math.min(current + 1, 4));
  };

  const cancel = () => {
    setStep(0);
    setName("");
    setDescription("");
    setFrom(today());
    setTo("");
    setMode("SUPPLIER_ALL_PRODUCTS");
    setAllSellers(true);
    setSellerIds([]);
    setSuppliers([]);
    setProducts([]);
    setGroupIds([]);
    setPercent("");
    setMinQuantity("");
    setMaxQuantity("");
    setMinAmount("");
    setMaxAmount("");
  };

  const findSuppliers = async () => {
    setLoading("suppliers");
    try {
      setSupplierResults(await searchCommissionSuppliers(supplierQuery));
    } catch {
      onError("No se pudieron buscar proveedores reales.");
    } finally {
      setLoading(null);
    }
  };

  const findProducts = async () => {
    if (productQuery.trim().length < 2) {
      setProductResults([]);
      return;
    }
    setLoading("products");
    try {
      setProductResults(
        await searchCommissionProducts(
          productQuery,
          mode === "SUPPLIER_SELECTED_PRODUCTS"
            ? suppliers.map((supplier) => supplier.id)
            : undefined,
        ),
      );
    } catch {
      onError("No se pudieron buscar productos.");
    } finally {
      setLoading(null);
    }
  };

  const save = async () => {
    if (!validate()) return;
    setLoading("save");
    try {
      await createGuidedCommissionRule({
        ruleName: name,
        description,
        effectiveFrom: from,
        effectiveTo: to || undefined,
        appliesToAllSellers: allSellers,
        sellerProfileIds: sellerIds,
        targetMode: mode,
        supplierIds: suppliers.map((supplier) => supplier.id),
        groupIds,
        productIds: products.map((product) => product.id),
        commissionType: type,
        minQuantity: minQuantity ? Number(minQuantity) : null,
        maxQuantity: maxQuantity ? Number(maxQuantity) : null,
        minAmount: minAmount ? Number(minAmount) : null,
        maxAmount: maxAmount ? Number(maxAmount) : null,
        commissionPercent: parsePercent(percent),
      });
      await onSaved();
      cancel();
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "No se pudo guardar la condición.",
      );
    } finally {
      setLoading(null);
    }
  };

  let content: React.ReactNode;
  if (step === 0) {
    content = (
      <>
        <Title
          value="1. Identificación y vigencia"
          help="Usa un nombre claro, por ejemplo: Promoción ANASAC agosto o Fiestas Patrias."
        />
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Nombre de regla o campaña">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Descripción opcional">
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label="Vigente desde">
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="Vigente hasta opcional">
            <input
              type="date"
              min={from}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
        </div>
      </>
    );
  } else if (step === 1) {
    content = (
      <ScopeAndSelection
        mode={mode}
        setMode={setMode}
        groups={groups}
        groupIds={groupIds}
        setGroupIds={setGroupIds}
        suppliers={suppliers}
        supplierResults={supplierResults}
        supplierQuery={supplierQuery}
        setSupplierQuery={setSupplierQuery}
        findSuppliers={findSuppliers}
        supplierLoading={loading === "suppliers"}
        addSupplier={(supplier) => add(supplier, setSuppliers)}
        removeSupplier={(id) =>
          setSuppliers((current) => current.filter((item) => item.id !== id))
        }
        products={products}
        productResults={productResults}
        productQuery={productQuery}
        setProductQuery={setProductQuery}
        findProducts={findProducts}
        productLoading={loading === "products"}
        addProduct={(product) => add(product, setProducts)}
        removeProduct={(id) =>
          setProducts((current) => current.filter((item) => item.id !== id))
        }
      />
    );
  } else if (step === 2) {
    content = (
      <>
        <Title
          value="3. Vendedores"
          help="Define si la condición se aplica a todos los vendedores comisionables o solo a algunos."
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <Mode
            selected={allSellers}
            onClick={() => setAllSellers(true)}
            title="Todos los vendedores comisionables"
            text="La condición se evaluará para todos."
          />
          <Mode
            selected={!allSellers}
            onClick={() => setAllSellers(false)}
            title="Seleccionar vendedores"
            text="Restringe la condición a vendedores específicos."
          />
        </div>
        {!allSellers && (
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {eligibleSellers.map((seller) => (
              <label
                key={seller.seller_profile_id}
                className="flex items-center gap-2 rounded-lg border border-theme-border p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={sellerIds.includes(seller.seller_profile_id!)}
                  onChange={() =>
                    setSellerIds((current) =>
                      current.includes(seller.seller_profile_id!)
                        ? current.filter((id) => id !== seller.seller_profile_id)
                        : [...current, seller.seller_profile_id!],
                    )
                  }
                />
                {seller.seller_name}
              </label>
            ))}
          </div>
        )}
      </>
    );
  } else if (step === 3) {
    content = (
      <Commission
        type={type}
        setType={setType}
        percent={percent}
        setPercent={setPercent}
        minQuantity={minQuantity}
        setMinQuantity={setMinQuantity}
        maxQuantity={maxQuantity}
        setMaxQuantity={setMaxQuantity}
        minAmount={minAmount}
        setMinAmount={setMinAmount}
        maxAmount={maxAmount}
        setMaxAmount={setMaxAmount}
      />
    );
  } else {
    content = (
      <Summary
        name={name}
        mode={mode}
        supplierCount={suppliers.length}
        productCount={products.length}
        groupCount={groupIds.length}
        allSellers={allSellers}
        sellerCount={sellerIds.length}
        type={type}
        percent={percent}
        from={from}
        to={to}
        minQuantity={minQuantity}
        minAmount={minAmount}
      />
    );
  }

  return (
    <section className="w-full space-y-4">
      <header>
        <h3 className="text-base font-semibold">Nueva condición de comisión</h3>
        <p className="mt-1 text-sm text-theme-text-muted">
          Define cuándo una venta debe pagar una comisión distinta a la comisión general.
        </p>
      </header>
      <div className="sim-card">
        <ol className="flex overflow-x-auto rounded-lg p-1">
          {stepNames.map((label, index) => (
            <li
              key={label}
              className={cn(
                "min-w-28 flex-1 px-2 py-1 text-center text-xs font-medium",
                index === step
                  ? "rounded bg-theme-accent-muted text-theme-text"
                  : index < step
                    ? "text-theme-text"
                    : "text-theme-text-muted",
              )}
            >
              {index + 1} {label}
            </li>
          ))}
        </ol>
      </div>
      <section className="sim-card p-4">{content}</section>
      <div className="flex justify-between gap-3">
        <button type="button" onClick={cancel} className="btn-secondary">
          <X className="h-3.5 w-3.5" />
          Cancelar
        </button>
        <div className="flex gap-2">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((current) => current - 1)}
              className="btn-secondary"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Atrás
            </button>
          )}
          {step < 4 ? (
            <button type="button" onClick={next} className="btn-primary">
              Siguiente
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void save()}
              disabled={loading === "save"}
              className="btn-primary"
            >
              {loading === "save" ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  Guardando...
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Guardar condición
                </>
              )}
            </button>
          )}
        </div>
      </div>
      <ExistingRules rules={rules} onSaved={onSaved} onError={onError} />
    </section>
  );
}

function ScopeAndSelection(props: Parameters<typeof Selection>[0]) {
  const supplierMode =
    props.mode === "SUPPLIER_ALL_PRODUCTS" ||
    props.mode === "SUPPLIER_SELECTED_PRODUCTS";
  return (
    <>
      <Title
        value="2. Alcance y selección"
        help="Elige qué quieres comisionar y configura la selección inmediatamente."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Mode
          selected={props.mode === "GENERAL"}
          onClick={() => props.setMode("GENERAL")}
          title="General"
          text="Aplica si no existe una condición más específica."
        />
        <Mode
          selected={supplierMode}
          onClick={() => props.setMode("SUPPLIER_ALL_PRODUCTS")}
          title="Proveedor"
          text="Uno o más proveedores, todos sus productos o algunos."
        />
        <Mode
          selected={props.mode === "EXISTING_GROUP"}
          onClick={() => props.setMode("EXISTING_GROUP")}
          title="Grupo de productos"
          text="Usa un grupo creado previamente."
        />
        <Mode
          selected={props.mode === "SELECTED_PRODUCTS"}
          onClick={() => props.setMode("SELECTED_PRODUCTS")}
          title="Productos específicos"
          text="Elige productos individuales por SKU."
        />
      </div>
      <div className="mt-5 border-t border-theme-border pt-5">
        <Selection {...props} />
      </div>
    </>
  );
}

function Selection(props: {
  mode: TargetMode;
  setMode: (mode: TargetMode) => void;
  groups: CommissionGroup[];
  groupIds: string[];
  setGroupIds: (ids: string[]) => void;
  suppliers: Supplier[];
  supplierResults: Supplier[];
  supplierQuery: string;
  setSupplierQuery: (query: string) => void;
  findSuppliers: () => Promise<void>;
  supplierLoading: boolean;
  addSupplier: (supplier: Supplier) => void;
  removeSupplier: (id: string) => void;
  products: Product[];
  productResults: Product[];
  productQuery: string;
  setProductQuery: (query: string) => void;
  findProducts: () => Promise<void>;
  productLoading: boolean;
  addProduct: (product: Product) => void;
  removeProduct: (id: string) => void;
}) {
  const supplierMode =
    props.mode === "SUPPLIER_ALL_PRODUCTS" ||
    props.mode === "SUPPLIER_SELECTED_PRODUCTS";
  if (props.mode === "GENERAL") {
    return (
      <>
        <Title
          value="Selección"
          help="Esta condición aplicará de forma general, salvo que exista una regla más específica."
        />
      </>
    );
  }
  if (props.mode === "EXISTING_GROUP") {
    return (
      <>
        <Title
          value="Selección de grupos"
          help="Elige los grupos que usará la condición."
        />
        {props.groups.length ? (
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {props.groups.map((group) => (
              <label
                key={group.id}
                className="flex items-center gap-2 rounded-lg border border-theme-border p-3"
              >
                <input
                  type="checkbox"
                  checked={props.groupIds.includes(group.id)}
                  onChange={() =>
                    props.setGroupIds(
                      props.groupIds.includes(group.id)
                        ? props.groupIds.filter((id) => id !== group.id)
                        : [...props.groupIds, group.id],
                    )
                  }
                />
                <span>
                  <b>{group.name}</b>
                  <small className="block text-theme-text-muted">
                    {group.description || "Sin descripción"}
                  </small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-theme-text-muted">
            No hay grupos creados. Crea un grupo antes de usar esta opción.
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <Title
        value={supplierMode ? "Selección de proveedor" : "Selección de productos"}
        help={
          supplierMode
            ? "Busca y selecciona proveedores reales de PetGroup."
            : "Busca productos por SKU o descripción."
        }
      />
      {supplierMode && (
        <>
          <SearchBox
            value={props.supplierQuery}
            setValue={props.setSupplierQuery}
            search={props.findSuppliers}
            loading={props.supplierLoading}
            placeholder="Buscar proveedor real"
          />
          <SupplierResults
            items={props.supplierResults}
            selected={new Set(props.suppliers.map((item) => item.id))}
            add={props.addSupplier}
          />
          <Chips
            items={props.suppliers}
            label={(item) => item.name}
            remove={props.removeSupplier}
            empty="Selecciona uno o más proveedores reales."
          />
          {props.suppliers.length > 0 && (
            <div className="mt-3 rounded-lg border border-theme-border p-3">
              <p className="text-sm font-medium">
                ¿La comisión aplica a todos los productos de estos proveedores?
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => props.setMode("SUPPLIER_ALL_PRODUCTS")}
                  className={
                    props.mode === "SUPPLIER_ALL_PRODUCTS" ? "btn-primary" : "btn-secondary"
                  }
                >
                  Sí, todos los productos
                </button>
                <button
                  type="button"
                  onClick={() => props.setMode("SUPPLIER_SELECTED_PRODUCTS")}
                  className={
                    props.mode === "SUPPLIER_SELECTED_PRODUCTS"
                      ? "btn-primary"
                      : "btn-secondary"
                  }
                >
                  No, solo algunos productos
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {(!supplierMode || props.mode === "SUPPLIER_SELECTED_PRODUCTS") && (
        <div className="mt-4">
          <SearchBox
            value={props.productQuery}
            setValue={props.setProductQuery}
            search={props.findProducts}
            loading={props.productLoading}
            placeholder="Buscar por SKU o descripción"
          />
          <ProductResults
            items={props.productResults}
            selected={new Set(props.products.map((item) => item.id))}
            add={props.addProduct}
          />
          <Chips
            items={props.products}
            label={(item) => `${item.sku} · ${item.description}`}
            remove={props.removeProduct}
            empty="No hay productos seleccionados."
          />
          <p className="mt-3 text-sm text-theme-text-muted">
            Cada SKU se evalúa individualmente. No se suman todos los productos
            del proveedor para cumplir el mínimo.
          </p>
        </div>
      )}
    </>
  );
}

function Commission(props: {
  type: CommissionRuleType;
  setType: (type: CommissionRuleType) => void;
  percent: string;
  setPercent: (value: string) => void;
  minQuantity: string;
  setMinQuantity: (value: string) => void;
  maxQuantity: string;
  setMaxQuantity: (value: string) => void;
  minAmount: string;
  setMinAmount: (value: string) => void;
  maxAmount: string;
  setMaxAmount: (value: string) => void;
}) {
  return (
    <>
      <Title
        value="5. Tipo de comisión"
        help="Las condiciones variables se evalúan por SKU individual."
      />
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <Mode
          selected={props.type === "FIXED_PERCENT"}
          onClick={() => props.setType("FIXED_PERCENT")}
          title="Comisión fija"
          text="Un porcentaje fijo por venta."
        />
        <Mode
          selected={props.type === "RANGE_BY_QUANTITY"}
          onClick={() => props.setType("RANGE_BY_QUANTITY")}
          title="Variable por cantidad"
          text="Exige una cantidad mínima por SKU."
        />
        <Mode
          selected={props.type === "RANGE_BY_AMOUNT"}
          onClick={() => props.setType("RANGE_BY_AMOUNT")}
          title="Variable por monto"
          text="Exige un neto mínimo por SKU."
        />
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {props.type === "RANGE_BY_QUANTITY" && (
          <>
            <Field label="Cantidad mínima">
              <input
                type="number"
                min="1"
                value={props.minQuantity}
                onChange={(event) => props.setMinQuantity(event.target.value)}
              />
            </Field>
            <Field label="Cantidad máxima opcional">
              <input
                type="number"
                min="1"
                value={props.maxQuantity}
                onChange={(event) => props.setMaxQuantity(event.target.value)}
              />
            </Field>
          </>
        )}
        {props.type === "RANGE_BY_AMOUNT" && (
          <>
            <Field label="Monto mínimo">
              <input
                type="number"
                min="1"
                value={props.minAmount}
                onChange={(event) => props.setMinAmount(event.target.value)}
              />
            </Field>
            <Field label="Monto máximo opcional">
              <input
                type="number"
                min="1"
                value={props.maxAmount}
                onChange={(event) => props.setMaxAmount(event.target.value)}
              />
            </Field>
          </>
        )}
        <Field label="Porcentaje de comisión">
          <input
            type="text"
            inputMode="decimal"
            value={props.percent}
            onChange={(event) => props.setPercent(event.target.value)}
            placeholder="Ej: 2,25"
          />
        </Field>
      </div>
      {props.type !== "FIXED_PERCENT" && (
        <p className="mt-3 text-sm text-theme-text-muted">
          Cada producto incluido debe alcanzar esta condición dentro del período
          para comisionar. No se suman los productos del proveedor.
        </p>
      )}
    </>
  );
}

function Summary({
  name,
  mode,
  supplierCount,
  productCount,
  groupCount,
  allSellers,
  sellerCount,
  type,
  percent,
  from,
  to,
  minQuantity,
  minAmount,
}: {
  name: string;
  mode: TargetMode;
  supplierCount: number;
  productCount: number;
  groupCount: number;
  allSellers: boolean;
  sellerCount: number;
  type: CommissionRuleType;
  percent: string;
  from: string;
  to: string;
  minQuantity: string;
  minAmount: string;
}) {
  const target =
    mode === "GENERAL"
      ? "General"
      : mode === "SUPPLIER_ALL_PRODUCTS"
        ? `Todos los productos de ${supplierCount} proveedor(es)`
        : mode === "SUPPLIER_SELECTED_PRODUCTS"
          ? `${productCount} productos seleccionados`
          : mode === "EXISTING_GROUP"
            ? `${groupCount} grupo(s)`
            : `${productCount} productos específicos`;
  const condition =
    type === "FIXED_PERCENT"
      ? "Sin condición adicional"
      : type === "RANGE_BY_QUANTITY"
        ? `Cada SKU debe alcanzar ${minQuantity} unidades`
        : `Cada SKU debe alcanzar $${minAmount} netos`;
  const percentVal = parsePercent(percent);

  return (
    <>
      <Title
        value="6. Resumen antes de guardar"
        help="Revisa la condición antes de crearla."
      />
      <dl className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Item label="Nombre" value={name} />
        <Item label="Aplica sobre" value={target} />
        <Item
          label="Vendedores"
          value={
            allSellers ? "Todos los vendedores comisionables" : `${sellerCount} vendedor(es)`
          }
        />
        <Item
          label="Tipo"
          value={
            type === "FIXED_PERCENT"
              ? "Comisión fija"
              : type === "RANGE_BY_QUANTITY"
                ? "Variable por cantidad"
                : "Variable por monto"
          }
        />
        <Item label="Condición" value={condition} />
        <Item label="Comisión" value={formatPercent(percentVal)} />
        <Item label="Vigencia" value={`${from}${to ? ` a ${to}` : " en adelante"}`} />
      </dl>
    </>
  );
}
