"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listComisionesV2CustomerCommissionability,
  setComisionesV2CustomerCommissionability,
  type ComisionesV2CustomerCommissionability,
} from "@/app/actions/comisiones-v2";

export function ComisionesV2CustomerCommissionability({
  onCommissionabilityChanged,
}: {
  onCommissionabilityChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ComisionesV2CustomerCommissionability[]>([]);
  const [excluded, setExcluded] = useState<ComisionesV2CustomerCommissionability[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextQuery: string) => {
    setLoading(true);
    const response = await listComisionesV2CustomerCommissionability(nextQuery);
    setLoading(false);
    if (response.error) {
      setError(response.error);
      return;
    }
    setError(null);
    setResults(response.data.results);
    setExcluded(response.data.excluded);
  }, []);

  useEffect(() => {
    let active = true;
    void listComisionesV2CustomerCommissionability("")
      .then((response) => {
        if (!active) return;
        if (response.error) {
          setError(response.error);
          return;
        }
        setResults(response.data.results);
        setExcluded(response.data.excluded);
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "No se pudieron cargar los clientes.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const nextQuery = query.trim();
    if (nextQuery.length < 3) return;
    const timer = setTimeout(() => {
      void load(nextQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [load, query]);

  const changeCommissionability = async (
    customer: ComisionesV2CustomerCommissionability,
  ) => {
    if (customer.is_internal_account) return;
    setSaving(customer.bsale_client_id);
    setError(null);
    const response = await setComisionesV2CustomerCommissionability({
      bsaleClientId: customer.bsale_client_id,
      isCommissionable: !customer.is_commissionable,
    });
    if (response.error) {
      setError(response.error);
    } else {
      onCommissionabilityChanged();
      await load(query.trim());
    }
    setSaving(null);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3 md:p-4">
      <div className="rounded-xl border border-theme-border bg-theme-surface p-4">
        <h2 className="text-sm font-semibold text-theme-text">
          Clientes no comisionables
        </h2>
        <p className="mt-1 text-xs text-theme-text-muted">
          Administra únicamente la condición de comisión del cliente.
        </p>
        <div className="mt-3 w-full max-w-[30rem]">
          <input
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              if (nextQuery.trim().length < 3) setResults([]);
            }}
            placeholder="Buscar por nombre o RUT"
            aria-label="Buscar cliente por nombre o RUT"
            className="h-9 min-w-0 flex-1 rounded-lg border border-theme-border bg-theme-bg px-3 text-xs text-theme-text outline-none focus:border-theme-accent"
          />
          {query.trim().length > 0 && query.trim().length < 3 && (
            <p className="mt-1 text-[11px] text-theme-text-muted">
              Escribe al menos 3 caracteres.
            </p>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {query.trim() && (
        <CustomerTable
          customers={results}
          loading={loading}
          saving={saving}
          onChange={changeCommissionability}
        />
      )}

      <div className="rounded-xl border border-theme-border bg-theme-surface p-4">
        <h3 className="text-sm font-semibold text-theme-text">
          Clientes no comisionables
        </h3>
        <div className="mt-3">
          {loading && excluded.length === 0 ? (
            <p className="text-xs text-theme-text-muted">Cargando...</p>
          ) : excluded.length === 0 ? (
            <p className="text-xs text-theme-text-muted">No hay clientes excluidos.</p>
          ) : (
            <CustomerTable
              customers={excluded}
              saving={saving}
              onChange={changeCommissionability}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function CustomerTable({
  customers,
  loading = false,
  saving,
  onChange,
}: {
  customers: ComisionesV2CustomerCommissionability[];
  loading?: boolean;
  saving: number | null;
  onChange: (customer: ComisionesV2CustomerCommissionability) => void;
}) {
  if (loading) return <p className="text-xs text-theme-text-muted">Buscando...</p>;
  if (customers.length === 0) {
    return <p className="text-xs text-theme-text-muted">No se encontraron clientes.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-theme-border bg-theme-surface">
      <table className="w-full min-w-[560px] table-fixed text-xs">
        <thead>
          <tr>
            <th className="w-[34%] px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
              Cliente
            </th>
            <th className="w-[20%] px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
              RUT
            </th>
            <th className="w-[30%] px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
              Estado
            </th>
            <th className="w-[16%] px-2 py-2 text-right text-[10px] font-bold uppercase tracking-wide text-theme-text-muted">
              Acción
            </th>
          </tr>
        </thead>
        <tbody>
          {customers.map((customer) => (
            <tr
              key={customer.bsale_client_id}
              className="border-t border-theme-border/70 hover:bg-theme-text/[0.03]"
            >
              <td className="px-2 py-2 font-semibold text-theme-text">{customer.name}</td>
              <td className="px-2 py-2 text-theme-text">{customer.rut || "Sin RUT"}</td>
              <td className="px-2 py-2 text-theme-text">
                {customer.is_internal_account
                  ? "Cuenta interna · No comisionable"
                  : customer.is_commissionable
                    ? "Comisionable"
                    : "No comisionable"}
              </td>
              <td className="px-2 py-2 text-right">
                {!customer.is_internal_account && (
                  <button
                    type="button"
                    className="rounded-md border border-theme-border bg-theme-surface px-2.5 py-1.5 text-[11px] font-semibold text-theme-text hover:bg-theme-text/5 disabled:opacity-60"
                    disabled={saving === customer.bsale_client_id}
                    onClick={() => void onChange(customer)}
                  >
                    {customer.is_commissionable
                      ? "Excluir de comisión"
                      : "Volver a incluir"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
