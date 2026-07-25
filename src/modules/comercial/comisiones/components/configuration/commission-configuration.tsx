import { Save } from "lucide-react";
import { useState } from "react";
import type {
  CommissionGroup,
  CommissionRule,
  CommissionSeller,
  CommissionSellerType,
  CommissionSettings,
} from "@/app/actions/comercial/commissions";
import { cn, formatPercent, parsePercent } from "@/lib/utils";
import { CommissionGroupsConfig } from "../../commission-groups-config";
import { CommissionRulesWizard } from "../../commission-rules-wizard";
import type { ConfigTab, SellerDraft } from "../../commissions-panel-types";
import { sellerDraft, sellerTypes } from "../../commissions-panel-utils";

export function CommissionConfiguration({
  tab,
  setTab,
  sellers,
  drafts,
  settings,
  groups,
  rules,
  busy,
  onSellerChange,
  onSaveSeller,
  onSettingsChange,
  onSaveSettings,
  onRefresh,
  setError,
}: {
  tab: ConfigTab;
  setTab: (tab: ConfigTab) => void;
  sellers: CommissionSeller[];
  drafts: Record<number, SellerDraft>;
  settings: CommissionSettings | null;
  groups: CommissionGroup[];
  rules: CommissionRule[];
  busy: boolean;
  onSellerChange: (id: number, changes: Partial<SellerDraft>) => void;
  onSaveSeller: (seller: CommissionSeller) => void;
  onSettingsChange: (percent: number) => void;
  onSaveSettings: (percent?: number) => void;
  onRefresh: () => Promise<void>;
  setError: (message: string | null) => void;
}) {
  return (
    <main className="min-h-0 flex-1 overflow-auto bg-theme-bg/50">
      <div className="flex gap-1 border-b border-theme-border bg-theme-surface px-4 pt-3 sticky top-0 z-10">
        {(["sellers", "general", "groups", "rules"] as ConfigTab[]).map(
          (item) => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={cn(
                "rounded-t-lg px-3 py-2 text-xs font-semibold",
                tab === item
                  ? "bg-theme-accent-muted text-theme-text"
                  : "text-theme-text-muted hover:bg-theme-surface-hover",
              )}
            >
              {
                {
                  sellers: "Vendedores",
                  general: "General",
                  groups: "Grupos",
                  rules: "Reglas",
                }[item]
              }
            </button>
          ),
        )}
      </div>
      <div className="p-4">
        {tab === "sellers" ? (
          <SellerTable
            sellers={sellers}
            drafts={drafts}
            busy={busy}
            onSellerChange={onSellerChange}
            onSaveSeller={onSaveSeller}
          />
        ) : tab === "general" ? (
          <General
            settings={settings}
            busy={busy}
            onSettingsChange={onSettingsChange}
            onSaveSettings={onSaveSettings}
          />
        ) : tab === "groups" ? (
          <CommissionGroupsConfig
            groups={groups}
            onSaved={onRefresh}
            setError={(message) => setError(message)}
          />
        ) : (
          <CommissionRulesWizard
            sellers={sellers}
            groups={groups}
            rules={rules}
            onSaved={onRefresh}
            onError={(message) => setError(message)}
          />
        )}
      </div>
    </main>
  );
}

function SellerTable({
  sellers,
  drafts,
  busy,
  onSellerChange,
  onSaveSeller,
}: {
  sellers: CommissionSeller[];
  drafts: Record<number, SellerDraft>;
  busy: boolean;
  onSellerChange: (id: number, changes: Partial<SellerDraft>) => void;
  onSaveSeller: (seller: CommissionSeller) => void;
}) {
  return (
    <div className="overflow-auto rounded-xl border border-theme-border">
      <table className="min-w-[900px] w-full text-xs">
        <thead>
          <tr>
            <th>Vendedor</th>
            <th>Tipo</th>
            <th>Comisionable</th>
            <th>Activo</th>
            <th>Notas</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sellers.map((seller) => {
            const row = drafts[seller.seller_bsale_id] || sellerDraft(seller);
            return (
              <tr key={seller.seller_bsale_id}>
                <td>
                  <b>{seller.seller_name}</b>
                  <div>{seller.paid_invoices_count} facturas pagadas</div>
                </td>
                <td>
                  <select
                    value={row.seller_type}
                    onChange={(e) =>
                      onSellerChange(seller.seller_bsale_id, {
                        seller_type: e.target.value as CommissionSellerType,
                      })
                    }
                  >
                    {sellerTypes.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    checked={row.is_commissionable}
                    onChange={(e) =>
                      onSellerChange(seller.seller_bsale_id, {
                        is_commissionable: e.target.checked,
                      })
                    }
                  />
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    checked={row.active}
                    onChange={(e) =>
                      onSellerChange(seller.seller_bsale_id, {
                        active: e.target.checked,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    value={row.notes}
                    onChange={(e) =>
                      onSellerChange(seller.seller_bsale_id, {
                        notes: e.target.value,
                      })
                    }
                  />
                </td>
                <td>
                  <button
                    disabled={busy}
                    onClick={() => onSaveSeller(seller)}
                    className="btn-primary"
                  >
                    <Save className="h-3.5 w-3.5" />
                    Guardar
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function General({
  settings,
  busy,
  onSettingsChange,
  onSaveSettings,
}: {
  settings: CommissionSettings | null;
  busy: boolean;
  onSettingsChange: (percent: number) => void;
  onSaveSettings: (percent?: number) => void;
}) {
  const initVal = String(settings?.default_commission_percent ?? "");
  const [raw, setRaw] = useState(initVal);
  const [prevSettings, setPrevSettings] = useState(settings);
  if (
    settings !== prevSettings &&
    JSON.stringify(settings) !== JSON.stringify(prevSettings)
  ) {
    setPrevSettings(settings);
    const newVal = String(settings?.default_commission_percent ?? "");
    if (raw !== newVal) setRaw(newVal);
  }
  if (!settings) {
    return <div className="flex h-40 items-center justify-center">Cargando...</div>;
  }
  const parsed = parsePercent(raw);

  return (
    <div className="w-full rounded-xl border border-theme-border bg-theme-bg/30 p-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Comisión general (%)">
          <input
            type="text"
            inputMode="decimal"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
            }}
            placeholder="Ej: 1,5"
          />
        </Field>
        <div className="text-sm">
          <b>Valor:</b> {formatPercent(parsed)}
          <br />
          <b>Base:</b> NET
          <br />
          <b>Pago completo:</b> Sí
        </div>
        <div className="text-sm">
          <b>Cierre histórico:</b> {settings.historical_cutoff_date}
          <br />
          <b>Primer día elegible:</b> {settings.first_eligible_date}
        </div>
        <button
          disabled={busy}
          onClick={() => {
            const pct = parsePercent(raw);
            onSettingsChange(pct);
            onSaveSettings(pct);
          }}
          className="btn-primary self-end"
        >
          <Save className="h-3.5 w-3.5" />
          Guardar
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
