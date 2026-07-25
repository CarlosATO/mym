"use client";

import { useEffect, useState } from "react";
import { AlertCircle, RefreshCw, Settings2, UsersRound } from "lucide-react";
import {
  getCommissionGroups,
  getCommissionRules,
  getCommissionSettings,
  getCommissionSellers,
  getCommissionAnnulledSettlements,
  getCommissionSettlementById,
  getCommissionSettlementDrafts,
  getCommissionSettlements,
  previewCommissionSettlement,
  searchCommissionSuppliers,
  updateCommissionSettings,
  upsertCommissionSellerProfile,
  annulCommissionSettlement,
  cancelCommissionSettlementDraft,
  createCommissionSettlementDraft,
  issueCommissionSettlement,
  getCommissionsSyncHealth,
  triggerManualCommissionsSync,
  type CommissionSyncHealth,
  type CommissionGroup,
  type CommissionPreview,
  type CommissionRule,
  type CommissionSeller,
  type CommissionSettings,
  type CommissionSettlementHeader,
} from "@/app/actions/comercial/commissions";
import {
  ConfigTab,
  MainTab,
  SettlementDetail,
  View,
} from "./commissions-panel-types";
import { errorMessage, sellerDraft } from "./commissions-panel-utils";
import { CommissionSyncStatusHeader } from "./components/sync/commission-sync-status";
import { ConfirmModal, PdfPreviewModal } from "./components/shared/commission-modals";
import { SimulateTab } from "./components/simulation/simulate-tab";
import {
  AnnulledTab,
  DraftsTab,
  IssuedTab,
} from "./components/settlements/settlement-views";
import { CommissionConfiguration } from "./components/configuration/commission-configuration";

export function CommissionsPanel({ isSuperUser }: { isSuperUser: boolean }) {
  const [view, setView] = useState<View>("main");
  const [tab, setTab] = useState<ConfigTab>("sellers");
  const [mainTab, setMainTab] = useState<MainTab>("simulate");
  const [sellers, setSellers] = useState<CommissionSeller[]>([]);
  const [drafts, setDrafts] = useState<Record<number, ReturnType<typeof sellerDraft>>>({});
  const [settings, setSettings] = useState<CommissionSettings | null>(null);
  const [groups, setGroups] = useState<CommissionGroup[]>([]);
  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [sellerId, setSellerId] = useState("");
  const [periodFrom, setPeriodFrom] = useState("2026-06-26");
  const [periodTo, setPeriodTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<CommissionPreview | null>(null);
  const [syncHealth, setSyncHealth] = useState<CommissionSyncHealth | null>(null);
  const [syncHealthLoading, setSyncHealthLoading] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftList, setDraftList] = useState<CommissionSettlementHeader[]>([]);
  const [issuedList, setIssuedList] = useState<CommissionSettlementHeader[]>([]);
  const [annulledList, setAnnulledList] = useState<CommissionSettlementHeader[]>([]);
  const [settlementDetail, setSettlementDetail] = useState<SettlementDetail | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: "create_draft" | "cancel" | "issue" | "annul";
    settlementId?: string;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [pdfPreview, setPdfPreview] = useState<{
    base64: string;
    filename: string;
  } | null>(null);
  const [busyPdf, setBusyPdf] = useState<string | null>(null);
  const [busyExcel, setBusyExcel] = useState<string | null>(null);

  const loadSellers = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await getCommissionSellers();
      setSellers(rows);
      setDrafts(
        Object.fromEntries(rows.map((row) => [row.seller_bsale_id, sellerDraft(row)])),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const loadSyncHealth = async () => {
    setSyncHealthLoading(true);
    try {
      setSyncHealth(await getCommissionsSyncHealth());
    } catch (err) {
      console.error("Failed to load sync health", err);
      setSyncHealth(null);
    } finally {
      setSyncHealthLoading(false);
    }
  };

  const handleManualSync = async () => {
    setSyncBusy(true);
    setError(null);
    try {
      await triggerManualCommissionsSync();
      await loadSyncHealth();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncBusy(false);
    }
  };

  const loadConfig = async () => {
    setBusy(true);
    setError(null);
    try {
      const [nextSettings, nextGroups, nextRules] = await Promise.all([
        getCommissionSettings(),
        getCommissionGroups(),
        getCommissionRules(),
        searchCommissionSuppliers(""),
      ]);
      setSettings(nextSettings);
      setGroups(nextGroups);
      setRules(nextRules);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadDraftList = async () => {
    setBusy(true);
    setError(null);
    try {
      setDraftList(await getCommissionSettlementDrafts());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadIssuedList = async () => {
    setBusy(true);
    setError(null);
    try {
      setIssuedList(await getCommissionSettlements({ status: "ISSUED" }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadAnnulledList = async () => {
    setBusy(true);
    setError(null);
    try {
      setAnnulledList(await getCommissionAnnulledSettlements());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const handle = setTimeout(() => {
      void loadSellers();
      void loadSyncHealth();
    }, 0);
    return () => clearTimeout(handle);
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(
      () => setError(null),
      error.includes("éxito") || error.includes("exitosamente") ? 3000 : 7000,
    );
    return () => clearTimeout(t);
  }, [error]);

  const commissionable = sellers.filter(
    (seller) => seller.is_commissionable && seller.profile_active === true,
  );

  const openConfig = () => {
    setView("configuration");
    void loadConfig();
  };

  const simulate = async (id = sellerId) => {
    if (!id || id !== sellerId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await previewCommissionSettlement({
        seller_bsale_id: Number(id),
        period_from: periodFrom,
        period_to: periodTo,
      });
      setPreview(result);
      if (result.summary.period_from) setPeriodFrom(result.summary.period_from);
    } catch (err) {
      setError(errorMessage(err));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const saveSeller = async (seller: CommissionSeller) => {
    const input = drafts[seller.seller_bsale_id];
    if (!input) return;
    setBusy(true);
    try {
      await upsertCommissionSellerProfile({
        seller_bsale_id: seller.seller_bsale_id,
        ...input,
      });
      await loadSellers();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doCreateDraft = async () => {
    if (!sellerId) return;
    setConfirmAction(null);
    setBusy(true);
    setError(null);
    try {
      await createCommissionSettlementDraft({
        seller_bsale_id: Number(sellerId),
        period_from: periodFrom,
        period_to: periodTo,
      });
      setPreview(null);
      await loadDraftList();
      setMainTab("drafts");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doCancelDraft = async () => {
    if (!confirmAction?.settlementId || !cancelReason.trim()) return;
    const sid = confirmAction.settlementId;
    setConfirmAction(null);
    setCancelReason("");
    setBusy(true);
    setError(null);
    try {
      await cancelCommissionSettlementDraft({
        settlement_id: sid,
        reason: cancelReason,
      });
      setSettlementDetail(null);
      await loadDraftList();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doIssue = async () => {
    if (!confirmAction?.settlementId) return;
    const sid = confirmAction.settlementId;
    setConfirmAction(null);
    setBusy(true);
    setError(null);
    try {
      await issueCommissionSettlement({ settlement_id: sid });
      setSettlementDetail(null);
      await loadIssuedList();
      setMainTab("issued");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doAnnul = async () => {
    if (!confirmAction?.settlementId || !cancelReason.trim()) return;
    const sid = confirmAction.settlementId;
    const reason = cancelReason;
    setConfirmAction(null);
    setCancelReason("");
    setBusy(true);
    setError(null);
    try {
      await annulCommissionSettlement({ settlement_id: sid, reason });
      setSettlementDetail(null);
      await loadIssuedList();
      await loadAnnulledList();
      setMainTab("annulled");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setSettlementDetail(await getCommissionSettlementById(id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doPdf = async (id: string) => {
    setBusyPdf(id);
    setError(null);
    try {
      const { exportCommissionSettlementPdf } =
        await import("@/app/actions/comercial/commissions");
      const result = await exportCommissionSettlementPdf(id);
      setPdfPreview(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyPdf(null);
    }
  };

  const downloadPdf = () => {
    if (!pdfPreview) return;
    const binary = atob(pdfPreview.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = pdfPreview.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doExcel = async (id: string) => {
    setBusyExcel(id);
    setError(null);
    try {
      const { exportCommissionSettlementXlsx } =
        await import("@/app/actions/comercial/commissions");
      const result = await exportCommissionSettlementXlsx(id);
      const binary = atob(result.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyExcel(null);
    }
  };

  return (
    <div className="commission-panel flex h-full min-h-0 flex-col overflow-hidden bg-theme-surface text-theme-text">
      <CommissionSyncStatusHeader
        view={view}
        onConfig={openConfig}
        onBack={() => setView("main")}
        mainTab={mainTab}
        onMainTab={setMainTab}
        syncHealth={syncHealth}
        syncHealthLoading={syncHealthLoading}
        syncBusy={syncBusy}
        onManualSync={isSuperUser ? handleManualSync : undefined}
      />
      {error && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-theme-text">
          <AlertCircle className="h-4 w-4 text-red-600" />
          {error}
        </div>
      )}
      {confirmAction && (
        <ConfirmModal
          action={confirmAction}
          reason={cancelReason}
          onReason={setCancelReason}
          busy={busy}
          onConfirm={
            confirmAction.type === "create_draft"
              ? doCreateDraft
              : confirmAction.type === "cancel"
                ? doCancelDraft
                : confirmAction.type === "issue"
                  ? doIssue
                  : doAnnul
          }
          onCancel={() => {
            setConfirmAction(null);
            setCancelReason("");
          }}
        />
      )}
      {pdfPreview && (
        <PdfPreviewModal
          base64={pdfPreview.base64}
          filename={pdfPreview.filename}
          onClose={() => setPdfPreview(null)}
          onDownload={downloadPdf}
        />
      )}
      {view === "main" ? (
        <main className="flex-1 overflow-auto bg-theme-bg/50 px-4 py-4 md:px-6">
          {loading ? (
            <Loading />
          ) : commissionable.length === 0 ? (
            <Empty onConfig={openConfig} />
          ) : mainTab === "simulate" ? (
            <SimulateTab
              sellerId={sellerId}
              setSellerId={setSellerId}
              periodFrom={periodFrom}
              setPeriodFrom={setPeriodFrom}
              periodTo={periodTo}
              setPeriodTo={setPeriodTo}
              busy={busy}
              sellers={commissionable}
              preview={preview}
              onSimulate={simulate}
              onCreateDraft={() => setConfirmAction({ type: "create_draft" })}
            />
          ) : mainTab === "drafts" ? (
            <DraftsTab
              drafts={draftList}
              busy={busy}
              detail={settlementDetail}
              onLoad={loadDraftList}
              onDetail={openDetail}
              onCancel={(id) => {
                setConfirmAction({ type: "cancel", settlementId: id });
              }}
              onIssue={(id) => {
                setConfirmAction({ type: "issue", settlementId: id });
              }}
              onBack={() => setSettlementDetail(null)}
              onPdf={doPdf}
              onExcel={doExcel}
              busyPdf={busyPdf}
              busyExcel={busyExcel}
            />
          ) : mainTab === "annulled" ? (
            <AnnulledTab
              annulled={annulledList}
              busy={busy}
              detail={settlementDetail}
              onLoad={loadAnnulledList}
              onDetail={openDetail}
              onBack={() => setSettlementDetail(null)}
              onPdf={doPdf}
              onExcel={doExcel}
              busyPdf={busyPdf}
              busyExcel={busyExcel}
            />
          ) : (
            <IssuedTab
              issued={issuedList}
              busy={busy}
              detail={settlementDetail}
              onLoad={loadIssuedList}
              onDetail={openDetail}
              onBack={() => setSettlementDetail(null)}
              onPdf={doPdf}
              onExcel={doExcel}
              busyPdf={busyPdf}
              busyExcel={busyExcel}
              onAnnul={(id) => {
                setCancelReason("");
                setConfirmAction({ type: "annul", settlementId: id });
              }}
            />
          )}
        </main>
      ) : (
        <CommissionConfiguration
          tab={tab}
          setTab={setTab}
          sellers={sellers}
          drafts={drafts}
          settings={settings}
          groups={groups}
          rules={rules}
          busy={busy}
          onSellerChange={(id, changes) =>
            setDrafts((current) => ({
              ...current,
              [id]: { ...current[id], ...changes },
            }))
          }
          onSaveSeller={saveSeller}
          onSettingsChange={(percent) =>
            setSettings((current) =>
              current ? { ...current, default_commission_percent: percent } : current,
            )
          }
          onSaveSettings={async (percent?: number) => {
            const pct = percent ?? settings?.default_commission_percent;
            if (pct == null) return;
            setBusy(true);
            try {
              setSettings(
                await updateCommissionSettings({
                  default_commission_percent: pct,
                }),
              );
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
          onRefresh={loadConfig}
          setError={setError}
        />
      )}
      <CommissionStyles />
    </div>
  );
}

function CommissionStyles() {
  return (
    <style jsx global>{`
      .commission-panel .btn-primary,
      .commission-panel .btn-secondary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
        min-height: 2rem;
        border-radius: 0.5rem;
        padding: 0.35rem 0.7rem;
        font-size: 0.75rem;
        font-weight: 700;
        transition:
          opacity 0.15s,
          background 0.15s;
      }
      .commission-panel .btn-primary {
        background: var(--theme-accent);
        color: #fff;
      }
      .commission-panel .btn-primary:hover {
        opacity: 0.9;
      }
      .commission-panel .btn-secondary {
        border: 1px solid var(--theme-border);
        background: var(--theme-surface);
        color: var(--theme-text);
      }
      .commission-panel .btn-secondary:hover {
        background: var(--theme-surface-hover);
      }
      .commission-panel input,
      .commission-panel select,
      .commission-panel textarea {
        width: 100%;
        border: 1px solid var(--theme-border);
        border-radius: 0.5rem;
        background: var(--theme-surface);
        color: var(--theme-text);
        padding: 0.4rem 0.55rem;
        font-size: 0.75rem;
        transition:
          border-color 0.15s,
          box-shadow 0.15s;
      }
      .commission-panel input:focus,
      .commission-panel select:focus,
      .commission-panel textarea:focus {
        outline: none;
        border-color: var(--theme-accent);
        box-shadow: 0 0 0 2px
          color-mix(in srgb, var(--theme-accent) 20%, transparent);
      }
      .commission-panel .sim-card input,
      .commission-panel .sim-card select,
      .commission-panel .sim-card textarea {
        background: var(--theme-bg);
      }
      .commission-panel .sim-card input:focus,
      .commission-panel .sim-card select:focus,
      .commission-panel .sim-card textarea:focus {
        background: var(--theme-surface);
      }
      .commission-panel table,
      .commission-panel th,
      .commission-panel td {
        color: var(--theme-text) !important;
      }
      .commission-panel th {
        background: var(--theme-bg);
        padding: 0.4rem 0.5rem;
        text-align: left;
        font-size: 0.65rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        color: var(--theme-text-muted);
      }
      .commission-panel td {
        padding: 0.35rem 0.5rem;
        border-top: 1px solid var(--theme-border);
        font-size: 0.7rem;
      }
      .commission-panel tbody tr {
        transition: background 0.1s;
      }
      .commission-panel tbody tr:hover {
        background: var(--theme-surface-hover);
      }
      .commission-panel .sim-card {
        background: var(--theme-surface);
        border: 1px solid var(--theme-border);
        border-radius: 0.75rem;
        box-shadow:
          0 1px 3px rgba(0, 0, 0, 0.06),
          0 1px 2px rgba(0, 0, 0, 0.04);
      }
      .commission-panel .sim-kpi {
        display: flex;
        flex-direction: column;
        padding: 0.35rem 0.6rem;
        border-radius: 0.5rem;
        background: var(--theme-bg);
        min-width: 0;
      }
      .commission-panel .sim-kpi-label {
        font-size: 0.6rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--theme-text-muted);
        white-space: nowrap;
      }
      .commission-panel .sim-kpi-value {
        font-size: 0.8rem;
        font-weight: 700;
        color: var(--theme-text);
        line-height: 1.3;
        white-space: nowrap;
      }
      .commission-panel .overflow-auto.rounded-xl.border,
      .commission-panel .sim-card,
      .commission-panel .rounded-xl.border.bg-theme-bg {
        background: var(--theme-surface);
      }
    `}</style>
  );
}

function Loading() {
  return (
    <div className="flex h-40 items-center justify-center">
      <RefreshCw className="h-5 w-5 animate-spin text-theme-accent" />
    </div>
  );
}

function Empty({ onConfig }: { onConfig: () => void }) {
  return (
    <section className="mx-auto mt-10 max-w-xl rounded-xl border border-theme-border bg-theme-bg/35 p-7 text-center">
      <UsersRound className="mx-auto h-8 w-8 text-theme-text-muted" />
      <h3 className="mt-4 font-semibold">
        No hay vendedores comisionables configurados.
      </h3>
      <p className="mt-2 text-sm text-theme-text-muted">
        Configura vendedores para comenzar a simular comisiones.
      </p>
      <button onClick={onConfig} className="btn-primary mt-5">
        <Settings2 className="h-3.5 w-3.5" />
        Configurar vendedores
      </button>
    </section>
  );
}
