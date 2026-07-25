import { useEffect, useState } from "react";
import {
  archiveCommissionRuleBatch,
  getCommissionRuleBatchDetail,
  restoreCommissionRuleBatch,
  setCommissionRuleBatchActive,
  type CommissionRule,
} from "@/app/actions/comercial/commissions";
import { formatPercent } from "@/lib/utils";
import { RuleDetail } from "./rule-detail-modal";

export function ExistingRules({
  rules,
  onSaved,
  onError,
}: {
  rules: CommissionRule[];
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<
    ReturnType<typeof getCommissionRuleBatchDetail>
  > | null>(null);
  const [detailMode, setDetailMode] = useState<"view" | "edit">("view");
  const [status, setStatus] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [showArchived, setShowArchived] = useState(false);
  const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    if (!actionMessage) return;
    const timer = window.setTimeout(() => {
      setActionMessage("");
      onError("");
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [actionMessage, onError]);

  const batches = Array.from(
    rules
      .reduce((map, rule) => {
        const id = rule.rule_batch_id || rule.id;
        map.set(id, [...(map.get(id) || []), rule]);
        return map;
      }, new Map<string, CommissionRule[]>())
      .entries(),
  );

  const setActive = async (id: string, isActive: boolean) => {
    setActionMessage("");
    setBusy(id);
    try {
      await setCommissionRuleBatchActive(id, isActive);
      await onSaved();
      const message = isActive
        ? "Condición activada correctamente."
        : "Condición desactivada correctamente.";
      setActionMessage(message);
      onError(message);
    } catch {
      onError(
        isActive
          ? "No se pudo activar la condición."
          : "No se pudo desactivar la condición.",
      );
    } finally {
      setBusy(null);
    }
  };

  const view = async (
    id: string,
    rule: CommissionRule,
    mode: "view" | "edit" = "view",
  ) => {
    if (!rule.rule_batch_id)
      return onError(
        "Esta condición antigua no tiene un lote agrupado para mostrar detalle.",
      );
    setBusy(id);
    try {
      setDetailMode(mode);
      setDetail(await getCommissionRuleBatchDetail(rule.rule_batch_id));
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "No se pudo cargar el detalle.",
      );
    } finally {
      setBusy(null);
    }
  };

  const archive = async (id: string) => {
    if (
      !window.confirm(
        "Esta condición se ocultará de la lista principal y dejará de aplicar. No será eliminada.",
      )
    )
      return;
    setActionMessage("");
    setBusy(id);
    try {
      await archiveCommissionRuleBatch({ ruleBatchId: id });
      await onSaved();
      const message = "Condición archivada correctamente.";
      setActionMessage(message);
      onError(message);
    } catch {
      onError("No se pudo archivar la condición.");
    } finally {
      setBusy(null);
    }
  };

  const restore = async (id: string) => {
    if (
      !window.confirm(
        "La condición volverá a la lista como inactiva. Luego podrás activarla manualmente.",
      )
    )
      return;
    setActionMessage("");
    setBusy(id);
    try {
      await restoreCommissionRuleBatch(id);
      await onSaved();
      const message = "Condición restaurada correctamente.";
      setActionMessage(message);
      onError(message);
    } catch {
      onError("No se pudo restaurar la condición.");
    } finally {
      setBusy(null);
    }
  };

  const visible = batches.filter(([, batch]) => {
    const rule = batch[0];
    if (rule.is_archived && !showArchived) return false;
    if (status === "ACTIVE") return !rule.is_archived && rule.is_active;
    if (status === "INACTIVE") return !rule.is_archived && !rule.is_active;
    return true;
  });

  return (
    <section className="sim-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Condiciones existentes</h3>
        <div className="flex items-center gap-3">
          <select
            className="h-7 text-[11px]"
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="ALL">Todas</option>
            <option value="ACTIVE">Activas</option>
            <option value="INACTIVE">Inactivas</option>
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Mostrar archivadas
          </label>
        </div>
      </div>
      {visible.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Aplica sobre</th>
                <th>Tipo</th>
                <th>Comisión</th>
                <th>Vigencia</th>
                <th>Estado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map(([id, batch]) => {
                const rule = batch[0];
                const archived = Boolean(rule.is_archived);
                const canEditProducts =
                  Boolean(rule.rule_batch_id) &&
                  !archived &&
                  rule.is_active &&
                  rule.rule_scope === "PRODUCT";
                const editHelp = archived
                  ? "No disponible en condiciones archivadas."
                  : !rule.is_active
                    ? "Activa la condición para agregar productos."
                    : rule.rule_scope !== "PRODUCT"
                      ? "Edición disponible para reglas por producto."
                      : "";
                return (
                  <tr key={id}>
                    <td><b>{rule.rule_name || "Condición de comisión"}</b></td>
                    <td>
                      {rule.rule_scope === "GENERAL"
                        ? "General"
                        : rule.rule_scope === "SUPPLIER"
                          ? "Proveedor"
                          : rule.rule_scope === "GROUP"
                            ? "Grupo"
                            : `${batch.length} producto(s)`}
                    </td>
                    <td>
                      {rule.rule_type === "FIXED_PERCENT"
                        ? "Fija"
                        : rule.rule_type === "RANGE_BY_QUANTITY"
                          ? "Por cantidad"
                          : "Por monto"}
                    </td>
                    <td>
                      {rule.commission_percent != null
                        ? formatPercent(Number(rule.commission_percent))
                        : "-"}
                    </td>
                    <td>
                      {rule.valid_from}
                      {rule.valid_to ? ` a ${rule.valid_to}` : " en adelante"}
                    </td>
                    <td>
                      <span className="rounded-full border border-theme-border px-2 py-1 text-xs">
                        {archived ? "Archivada" : rule.is_active ? "Activa" : "Inactiva"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          disabled={busy === id}
                          onClick={() => void view(id, rule)}
                          className="btn-secondary"
                        >
                          Ver detalle
                        </button>
                        <span className="inline-flex" title={editHelp || undefined}>
                          <button
                            type="button"
                            disabled={busy === id || !canEditProducts}
                            onClick={() => void view(id, rule, "edit")}
                            className="btn-secondary"
                          >
                            Agregar productos
                          </button>
                        </span>
                      </div>
                      {!canEditProducts && !archived && rule.is_active && (
                        <p className="mt-1 text-[11px] text-theme-text-muted">{editHelp}</p>
                      )}
                      {rule.rule_batch_id &&
                        (archived ? (
                          <button
                            type="button"
                            disabled={busy === id}
                            onClick={() => void restore(id)}
                            className="btn-secondary ml-2"
                          >
                            Restaurar
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={busy === id}
                              onClick={() => void setActive(id, !rule.is_active)}
                              className="btn-secondary ml-2"
                            >
                              {busy === id
                                ? "Guardando..."
                                : rule.is_active
                                  ? "Desactivar"
                                  : "Activar"}
                            </button>
                            <button
                              type="button"
                              disabled={busy === id}
                              onClick={() => void archive(id)}
                              className="btn-secondary ml-2"
                            >
                              Archivar
                            </button>
                          </>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-sm text-theme-text-muted">
          No hay condiciones que coincidan con los filtros.
        </p>
      )}
      {detail && (
        <RuleDetail
          detail={detail}
          initialMode={detailMode}
          onClose={() => setDetail(null)}
          onRefresh={() => {
            setDetail(null);
            void onSaved();
          }}
        />
      )}
    </section>
  );
}
