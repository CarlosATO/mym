import { Edit2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  addProductsToCommissionRuleBatch,
  getCommissionRuleBatchDetail,
  searchCommissionRuleProductCandidates,
  type CommissionRuleProductCandidate,
} from "@/app/actions/comercial/commissions";
import {
  Chips,
  Detail,
  DetailList,
  RuleProductResults,
  SearchBox,
} from "./rule-ui";

type RuleDetailData = Awaited<ReturnType<typeof getCommissionRuleBatchDetail>>;
type RuleProductCandidate = CommissionRuleProductCandidate;

export function RuleDetail({
  detail,
  initialMode,
  onClose,
  onRefresh,
}: {
  detail: RuleDetailData;
  initialMode: "view" | "edit";
  onClose: () => void;
  onRefresh: () => void;
}) {
  const type =
    detail.type === "FIXED_PERCENT"
      ? "Comisión fija"
      : detail.type === "RANGE_BY_QUANTITY"
        ? "Variable por cantidad"
        : "Variable por monto";
  const [editing, setEditing] = useState(initialMode === "edit");
  const canEditProducts = detail.scope === "PRODUCT" && detail.isActive;
  const editHelp = !detail.isActive
    ? "Activa la condición para agregar productos."
    : detail.scope !== "PRODUCT"
      ? "Edición disponible para reglas por producto."
      : "";
  if (editing)
    return (
      <EditRuleModal
        detail={detail}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onRefresh();
        }}
      />
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <section className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-theme-border bg-theme-surface p-5 text-theme-text">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">{detail.name}</h3>
            <p className="mt-1 text-sm text-theme-text-muted">
              {detail.description || "Sin descripción"}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              <span className="inline-flex" title={editHelp || undefined}>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  disabled={!canEditProducts}
                  className="btn-secondary"
                >
                  <Edit2 className="h-3.5 w-3.5" />
                  Agregar productos
                </button>
              </span>
              <button type="button" onClick={onClose} className="btn-secondary">
                Cerrar
              </button>
            </div>
            {!canEditProducts && detail.isActive && (
              <p className="text-[11px] text-theme-text-muted">{editHelp}</p>
            )}
          </div>
        </div>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Estado" value={detail.isActive ? "Activa" : "Inactiva"} />
          <Detail
            label="Vigencia"
            value={`${detail.validFrom}${detail.validTo ? ` a ${detail.validTo}` : " en adelante"}`}
          />
          <Detail label="Comisión" value={`${detail.commissionPercent}%`} />
          <Detail label="Tipo" value={type} />
          <Detail
            label="Alcance"
            value={
              detail.scope === "GENERAL"
                ? "General"
                : detail.scope === "SUPPLIER"
                  ? "Proveedor"
                  : detail.scope === "GROUP"
                    ? "Grupo de productos"
                    : "Productos seleccionados"
            }
          />
          {detail.type === "RANGE_BY_QUANTITY" && (
            <Detail
              label="Cantidad"
              value={`${detail.minQuantity ?? 0}${detail.maxQuantity ? ` a ${detail.maxQuantity}` : "+"}`}
            />
          )}
          {detail.type === "RANGE_BY_AMOUNT" && (
            <Detail
              label="Monto"
              value={`${detail.minAmount ?? 0}${detail.maxAmount ? ` a ${detail.maxAmount}` : "+"}`}
            />
          )}
        </dl>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <DetailList
            title="Vendedores"
            items={detail.sellers.map((seller) => `${seller.name} (${seller.bsaleId})`)}
            empty="Todos los vendedores comisionables"
          />
          <DetailList
            title="Proveedores"
            items={detail.suppliers.map((supplier) => supplier.name)}
            empty="No aplica"
          />
          <DetailList
            title="Grupos"
            items={detail.groups.map((group) => group.name)}
            empty="No aplica"
          />
          <div>
            <h4 className="font-semibold">Productos incluidos</h4>
            {detail.products.length ? (
              <div className="mt-2 overflow-x-auto rounded-lg border border-theme-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Producto</th>
                      <th>Proveedor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.products.map((product) => (
                      <tr key={product.sku}>
                        <td className="font-mono text-xs">{product.sku}</td>
                        <td>{product.name}</td>
                        <td>{product.supplierName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-sm text-theme-text-muted">No aplica</p>
            )}
          </div>
        </div>
        <p className="mt-5 text-xs text-theme-text-muted">
          Para cambiar productos, proveedor, vendedor, alcance o tipo de
          comisión, desactiva esta condición y crea una nueva.
        </p>
      </section>
    </div>
  );
}

function EditRuleModal({
  detail,
  onClose,
  onSaved,
}: {
  detail: RuleDetailData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<RuleProductCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<RuleProductCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  const doSearch = async () => {
    const normalizedQuery = productQuery.trim();
    if (normalizedQuery.length < 2) {
      setProductResults([]);
      setHasSearched(false);
      return;
    }
    setSearching(true);
    setError("");
    try {
      setProductResults(
        await searchCommissionRuleProductCandidates(normalizedQuery, detail.id),
      );
      setHasSearched(true);
    } catch {
      setError("Error al buscar productos");
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    const normalizedQuery = productQuery.trim();
    if (normalizedQuery.length < 2) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setError("");
      void searchCommissionRuleProductCandidates(normalizedQuery, detail.id)
        .then((results) => {
          if (cancelled) return;
          setProductResults(results);
          setHasSearched(true);
        })
        .catch(() => {
          if (cancelled) return;
          setError("Error al buscar productos");
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [detail.id, productQuery]);

  const existingIds = new Set(detail.products.map((p) => p.id));
  const toAddIds = new Set(selected.map((p) => p.id));

  const save = async () => {
    if (!selected.length) return;
    setBusy(true);
    setError("");
    try {
      await addProductsToCommissionRuleBatch(detail.id, Array.from(toAddIds));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al guardar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <section className="max-h-[90vh] w-full max-w-3xl overflow-auto flex flex-col rounded-xl border border-theme-border bg-theme-surface p-5 text-theme-text">
        <div>
          <h3 className="text-lg font-semibold">Agregar productos a {detail.name}</h3>
          <p className="mt-1 text-sm text-theme-text-muted">
            Busca y selecciona los nuevos productos que deseas incluir en esta
            condición.
          </p>
        </div>
        {error && (
          <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-600">
            {error}
          </div>
        )}
        <div className="mt-4 rounded-lg border border-theme-border p-3">
          <h4 className="font-semibold">Productos actuales</h4>
          {detail.products.length ? (
            <div className="mt-3 overflow-x-auto rounded-lg border border-theme-border">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Producto</th>
                    <th>Proveedor</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.products.map((product) => (
                    <tr key={product.id}>
                      <td className="font-mono text-xs">{product.sku}</td>
                      <td>{product.name}</td>
                      <td>{product.supplierName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-sm text-theme-text-muted">
              Esta condición aún no tiene productos cargados.
            </p>
          )}
        </div>
        <SearchBox
          value={productQuery}
          setValue={(value) => {
            setProductQuery(value);
            if (value.trim().length < 2) {
              setProductResults([]);
              setHasSearched(false);
              setSearching(false);
            }
          }}
          search={doSearch}
          loading={searching}
          placeholder="Buscar por SKU, producto, proveedor o pseudoproveedor..."
        />
        <RuleProductResults
          query={productQuery.trim()}
          items={productResults}
          searching={searching}
          hasSearched={hasSearched}
          selected={new Set([...Array.from(existingIds), ...Array.from(toAddIds)])}
          add={(p) =>
            setSelected((current) =>
              current.some((item) => item.id === p.id) ? current : [...current, p],
            )
          }
        />
        <Chips
          items={selected}
          label={(p) => `${p.sku} · ${p.description}`}
          remove={(id) => setSelected((c) => c.filter((p) => p.id !== id))}
          empty="No has seleccionado nuevos productos aún."
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn-secondary"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !selected.length}
            className="btn-primary"
          >
            {busy ? "Guardando..." : `Agregar ${selected.length} producto(s)`}
          </button>
        </div>
      </section>
    </div>
  );
}
