import { LoaderCircle, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Product, RuleProductCandidate, Supplier } from "../../commission-rules-wizard-types";

export function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-theme-text-muted">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{value}</dd>
    </div>
  );
}

export function DetailList({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <div>
      <h4 className="font-semibold">{title}</h4>
      {items.length ? (
        <ul className="mt-2 space-y-1 text-sm">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-theme-text-muted">{empty}</p>
      )}
    </div>
  );
}

export function SearchBox({
  value,
  setValue,
  search,
  loading,
  placeholder,
}: {
  value: string;
  setValue: (value: string) => void;
  search: () => Promise<void>;
  loading: boolean;
  placeholder: string;
}) {
  return (
    <div className="mt-4 flex gap-2">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void search();
          }
        }}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={() => void search()}
        className="btn-secondary"
      >
        {loading ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Search className="h-3.5 w-3.5" />
        )}
        Buscar
      </button>
    </div>
  );
}

export function RuleProductResults({
  query,
  items,
  searching,
  hasSearched,
  selected,
  add,
}: {
  query: string;
  items: RuleProductCandidate[];
  searching: boolean;
  hasSearched: boolean;
  selected: Set<string>;
  add: (item: RuleProductCandidate) => void;
}) {
  const showNoResults = hasSearched && !searching && query.length >= 2 && !items.length;
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-theme-border">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Producto</th>
            <th>Proveedor real</th>
            <th>Pseudoproveedor</th>
            <th>Stock</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="font-mono text-xs">{item.sku}</td>
              <td>
                <div>{item.description}</div>
                {item.bsale_product_id && (
                  <div className="text-[10px] text-theme-text-muted">
                    Bsale #{item.bsale_product_id}
                  </div>
                )}
              </td>
              <td>{item.real_supplier_name || "Sin proveedor real"}</td>
              <td>{item.operative_supplier_name || "Sin pseudoproveedor"}</td>
              <td className="text-right">
                {item.stock_available != null
                  ? item.stock_available.toLocaleString("es-CL")
                  : "-"}
              </td>
              <td>
                {item.already_included ? (
                  <span className="text-xs font-semibold text-amber-600">
                    Ya incluido en la regla
                  </span>
                ) : selected.has(item.id) ? (
                  <span className="text-xs font-semibold text-theme-text-muted">
                    Seleccionado
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => add(item)}
                    className="btn-secondary"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Agregar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {searching && (
        <p className="p-4 text-center text-sm text-theme-text-muted">
          Buscando productos...
        </p>
      )}
      {showNoResults && (
        <div className="p-4 text-center text-sm text-theme-text-muted">
          <p>No se encontraron productos para &lsquo;{query}&rsquo;.</p>
          <p className="mt-1">Busca por SKU, producto, proveedor o pseudoproveedor.</p>
        </div>
      )}
      {!searching && !hasSearched && query.length < 2 && (
        <p className="p-4 text-center text-sm text-theme-text-muted">
          Escribe al menos 2 caracteres para buscar productos.
        </p>
      )}
    </div>
  );
}

export function SupplierResults({
  items,
  selected,
  add,
}: {
  items: Supplier[];
  selected: Set<string>;
  add: (item: Supplier) => void;
}) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-theme-border">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr>
            <th>Proveedor</th>
            <th>RUT</th>
            <th>Tipo</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              <td>{item.rut || "Sin RUT"}</td>
              <td>{item.type_label || "Proveedor real"}</td>
              <td>
                {selected.has(item.id) ? (
                  "Agregado"
                ) : (
                  <button
                    type="button"
                    onClick={() => add(item)}
                    className="btn-secondary"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Agregar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <p className="p-4 text-center text-sm text-theme-text-muted">
          Sin proveedores reales para mostrar.
        </p>
      )}
    </div>
  );
}

export function ProductResults({
  items,
  selected,
  add,
}: {
  items: Product[];
  selected: Set<string>;
  add: (item: Product) => void;
}) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-theme-border">
      <table className="w-full min-w-[600px] text-sm">
        <thead>
          <tr>
            <th>SKU</th>
            <th>Producto</th>
            <th>Proveedor</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="font-mono text-xs">{item.sku}</td>
              <td>{item.description}</td>
              <td>{item.supplier_name || "Sin proveedor asociado"}</td>
              <td>
                {selected.has(item.id) ? (
                  "Agregado"
                ) : (
                  <button
                    type="button"
                    onClick={() => add(item)}
                    className="btn-secondary"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Agregar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <p className="p-4 text-center text-sm text-theme-text-muted">
          Sin productos para mostrar.
        </p>
      )}
    </div>
  );
}

export function Chips<T extends { id: string }>({
  items,
  label,
  remove,
  empty,
}: {
  items: T[];
  label: (item: T) => string;
  remove: (id: string) => void;
  empty: string;
}) {
  return (
    <div className="mt-3 rounded-lg border border-theme-border p-3">
      {items.length ? (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <span
              key={item.id}
              className="inline-flex items-center gap-2 rounded-full bg-theme-accent-muted px-3 py-1 text-xs"
            >
              {label(item)}
              <button type="button" onClick={() => remove(item.id)}>
                Quitar
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-sm text-theme-text-muted">{empty}</p>
      )}
    </div>
  );
}

export function Title({ value, help }: { value: string; help: string }) {
  const title =
    value === "5. Tipo de comisión"
      ? "4. Tipo de comisión"
      : value === "6. Resumen antes de guardar"
        ? "5. Resumen antes de guardar"
        : value;
  return (
    <>
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-1 text-sm text-theme-text-muted">{help}</p>
    </>
  );
}

export function Mode({
  selected,
  onClick,
  title,
  text,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  text: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border p-3 text-left",
        selected
          ? "border-theme-accent bg-theme-accent-muted"
          : "border-theme-border bg-theme-surface",
      )}
    >
      <b className="block text-sm">{title}</b>
      <span className="mt-1 block text-xs text-theme-text-muted">{text}</span>
    </button>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="text-sm font-medium">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

export function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-theme-text-muted">
        {label}
      </dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}
