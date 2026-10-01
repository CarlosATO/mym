"use client";

import { Fragment, useState } from "react";
import {
  cleanupMermaEvidenceUploads,
  prepareDirectBsaleEvidenceUploads,
  regularizeDirectBsaleConsumption,
  type DirectBsaleIncidentLineInput,
  type MermaBsaleIncident,
  type MermaEvidenceMetadata,
} from "@/app/actions/logistica/mermas";
import {
  applyBulkExpiration,
  applyBulkObservation,
  applyBulkReason,
  getIncompleteLineCount,
  isValidDirectBsaleDate,
} from "@/lib/integraciones/direct-bsale-regularization-core";
import { uploadMermaEvidence } from "./new-merma-form-with-evidence";

type DraftLine = MermaBsaleIncident["details"][number] & {
  reason: string;
  expiration_date: string;
  lot: string;
  observation: string;
  evidence: File[];
  has_difference: boolean;
};

function draftLinesFor(incident: MermaBsaleIncident | null, reason: string) {
  return incident?.details.map((detail) => ({
    ...detail,
    reason,
    expiration_date: "",
    lot: "",
    observation: "",
    evidence: [],
    has_difference: false,
  })) ?? [];
}

export function DirectBsaleIncidentsDialog({
  incidents,
  canAuthorize,
  onClose,
  onCreated,
}: {
  incidents: MermaBsaleIncident[];
  canAuthorize: boolean;
  onClose: () => void;
  onCreated: (requestCode: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(incidents[0]?.consumption_id ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [generalReason, setGeneralReason] = useState("Regularización consumo directo Bsale");
  const [generalExpiration, setGeneralExpiration] = useState("");
  const [generalObservation, setGeneralObservation] = useState("");
  const [bulkFeedback, setBulkFeedback] = useState("");
  const [confirmedReview, setConfirmedReview] = useState(false);
  const [draftLines, setDraftLines] = useState<DraftLine[]>(draftLinesFor(incidents[0] ?? null, "Regularización consumo directo Bsale"));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const selected = incidents.find((incident) => incident.consumption_id === selectedId) ?? null;

  function selectIncident(incident: MermaBsaleIncident) {
    setSelectedId(incident.consumption_id);
    setFormOpen(false);
    setEditingIndex(null);
    setConfirmedReview(false);
    setSaveError("");
    setBulkFeedback("");
    setDraftLines(draftLinesFor(incident, generalReason));
  }

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setSaveError("");
    setDraftLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line));
  }

  function applyReason() {
    if (!generalReason.trim()) {
      setBulkFeedback("Ingresa un motivo general antes de aplicarlo.");
      return;
    }
    setDraftLines((current) => applyBulkReason(current, generalReason));
    setBulkFeedback(`Motivo aplicado a ${draftLines.length} líneas.`);
  }

  function applyExpiration(value: string) {
    const nextLines = applyBulkExpiration(draftLines, value);
    if (!nextLines) {
      setBulkFeedback("Ingresa un vencimiento válido en formato YYYY-MM-DD.");
      return;
    }
    setDraftLines(nextLines);
    setBulkFeedback(`Vencimiento aplicado a ${nextLines.length} líneas.`);
  }

  function applyObservation() {
    setDraftLines((current) => applyBulkObservation(current, generalObservation));
    setBulkFeedback(`Observación aplicada a ${draftLines.length} líneas.`);
  }

  const hasDifferences = draftLines.some((line) => line.has_difference);
  const incompleteCount = getIncompleteLineCount(draftLines);
  const missingExpirationCount = draftLines.filter((line) => !isValidDirectBsaleDate(line.expiration_date)).length;
  const missingReasonCount = draftLines.filter((line) => !line.reason.trim()).length;
  const saveDisabled = saving || Boolean(uploadStatus) || !canAuthorize || !confirmedReview || hasDifferences || incompleteCount > 0;

  async function saveIncident() {
    if (!selected || saveDisabled) return;
    setSaveError("");
    const sourceFiles = draftLines.flatMap((line, lineIndex) => line.evidence.map((file) => ({ file, lineIndex })));
    const fileMetadata = sourceFiles.map(({ file, lineIndex }) => ({
      line_index: lineIndex,
      file_name: file.name,
      mime_type: file.type,
      file_size: file.size,
    }));
    let session: { session_id: string; session_token: string; finalize_token: string } | null = null;
    const uploadedPaths: string[] = [];
    setSaving(true);
    try {
      setUploadStatus(fileMetadata.length ? "Preparando evidencia opcional..." : "Validando revisión...");
      if (fileMetadata.length) {
        const prepared = await prepareDirectBsaleEvidenceUploads(selected.consumption_id, fileMetadata);
        if (prepared.error || !prepared.data) throw new Error(prepared.error ?? "No se pudo preparar la evidencia");
        session = prepared.data;
        const evidence: MermaEvidenceMetadata[] = [];
        for (const [index, upload] of prepared.data.uploads.entries()) {
          setUploadStatus(`Subiendo evidencia ${index + 1} de ${prepared.data.uploads.length}...`);
          await uploadMermaEvidence(upload, sourceFiles[index].file);
          uploadedPaths.push(upload.storage_path);
          evidence.push({
            line_index: upload.line_index,
            storage_path: upload.storage_path,
            file_name: upload.file_name,
            mime_type: upload.mime_type,
            file_size: upload.file_size,
          });
        }
        setUploadStatus("Ingresando regularización a Bodega...");
        const result = await regularize(evidence, session);
        if (result.error) throw new Error(result.error);
        onCreated(result.request_code ?? "Nueva solicitud");
        return;
      }
      setUploadStatus("Ingresando regularización a Bodega...");
      const result = await regularize([], null);
      if (result.error) throw new Error(result.error);
      onCreated(result.request_code ?? "Nueva solicitud");
    } catch (error) {
      if (session && uploadedPaths.length) await cleanupMermaEvidenceUploads(session.session_id, session.session_token, uploadedPaths);
      setSaveError(error instanceof Error ? error.message : "No se pudo regularizar el consumo Bsale");
    } finally {
      setUploadStatus("");
      setSaving(false);
    }

    async function regularize(evidence: MermaEvidenceMetadata[], evidenceSession: typeof session) {
      const lines: DirectBsaleIncidentLineInput[] = draftLines.map((line) => ({
        detail_id: line.detail_id,
        variant_id: line.variant_id,
        quantity: line.quantity,
        reason: line.reason,
        expiration_date: line.expiration_date,
        lot: line.lot,
        observation: line.observation,
        has_difference: line.has_difference,
      }));
      return regularizeDirectBsaleConsumption({
        consumptionId: selected!.consumption_id,
        lines,
        evidence,
        confirmedReview,
        sessionId: evidenceSession?.session_id,
        sessionToken: evidenceSession?.session_token,
        finalizeToken: evidenceSession?.finalize_token,
      });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex h-[min(820px,calc(100vh-2rem))] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-theme-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-theme-text">Consumos Bsale pendientes de regularización</h2>
            <p className="mt-1 text-xs text-theme-text-muted">La regularización directa consolida la revisión y no modifica el consumo histórico de Bsale.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-theme-text-muted hover:bg-theme-text/5" aria-label="Cerrar incidencias">×</button>
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,0.34fr)_minmax(0,0.66fr)]">
          <div className="min-h-0 overflow-auto border-b border-theme-border lg:border-b-0 lg:border-r">
            <table className="w-full table-fixed text-xs">
              <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">Consumo</th><th className="px-3 py-2">Productos</th><th className="px-3 py-2">Unidades</th><th className="px-3 py-2">Estado</th></tr></thead>
              <tbody>{incidents.map((incident) => <tr key={incident.consumption_id} onClick={() => selectIncident(incident)} className={`cursor-pointer border-t border-theme-border/70 ${selectedId === incident.consumption_id ? "bg-theme-accent/10" : "hover:bg-theme-text/[0.025]"}`}><td className="px-3 py-2 font-mono font-semibold text-theme-text">#{incident.consumption_id}</td><td className="px-3 py-2 tabular-nums text-theme-text-muted">{incident.product_count}</td><td className="px-3 py-2 tabular-nums text-theme-text-muted">{incident.total_quantity}</td><td className="px-3 py-2 text-[10px] text-theme-text-muted">{incident.status}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="flex min-h-0 min-w-0 flex-col p-4">
            {selected && (formOpen ? <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 border-b border-theme-border pb-3">
                <div className="flex items-start justify-between gap-3"><div><h3 className="font-mono text-sm font-semibold text-theme-text">Regularizar consumo Bsale #{selected.consumption_id}</h3><p className="mt-1 text-xs text-theme-text-muted">{selected.product_count} productos · {selected.total_quantity} unidades</p></div><button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border border-theme-border px-2.5 py-1.5 text-[10px] font-semibold text-theme-text-muted">Volver</button></div>
                <p className="mt-2 rounded-lg bg-theme-accent/10 px-3 py-2 text-xs text-theme-text-muted">Producto y cantidad provienen directamente de Bsale y no pueden modificarse.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="text-xs text-theme-text-muted">Motivo general *<input value={generalReason} onChange={(event) => setGeneralReason(event.target.value)} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text" /></label><button type="button" onClick={applyReason} className="self-end rounded-md border border-theme-border px-2 py-2 text-[10px] font-semibold text-theme-text-muted">Aplicar motivo a todas</button><label className="text-xs text-theme-text-muted">Vencimiento común<input type="date" value={generalExpiration} onChange={(event) => setGeneralExpiration(event.target.value)} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text" /></label><button type="button" onClick={() => applyExpiration(generalExpiration)} className="self-end rounded-md border border-theme-border px-2 py-2 text-[10px] font-semibold text-theme-text-muted">Aplicar vencimiento a todas</button><label className="text-xs text-theme-text-muted sm:col-span-2">Observación general<textarea value={generalObservation} onChange={(event) => setGeneralObservation(event.target.value)} className="mt-1 min-h-16 w-full rounded-md border border-theme-border bg-theme-surface px-2 py-2 text-xs text-theme-text" /></label><button type="button" onClick={applyObservation} className="sm:col-span-2 justify-self-start rounded-md border border-theme-border px-2 py-2 text-[10px] font-semibold text-theme-text-muted">Aplicar observación a todas</button></div>
                {bulkFeedback && <p className="mt-2 rounded-md bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">{bulkFeedback}</p>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto py-3">
                <div className="overflow-x-auto rounded-lg border border-theme-border">
                  <table className="w-full min-w-[760px] text-xs">
                    <thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2">Cantidad</th><th className="px-3 py-2">Vencimiento</th><th className="px-3 py-2">Lote</th><th className="px-3 py-2">Evidencia</th><th className="px-3 py-2">Acción</th></tr></thead>
                    <tbody>{draftLines.map((line, index) => <Fragment key={line.detail_id}>
                      <tr className={`border-t border-theme-border/70 ${line.has_difference ? "bg-amber-500/10" : ""}`}>
                        <td className="px-3 py-2 font-mono font-semibold text-theme-text">{line.sku}</td>
                        <td className="px-3 py-2 text-theme-text-muted">{line.product_name}</td>
                        <td className="px-3 py-2 tabular-nums font-semibold text-theme-text">{line.quantity}</td>
                        <td className="px-3 py-2 text-theme-text-muted">{line.expiration_date || "Pendiente"}</td>
                        <td className="px-3 py-2 text-theme-text-muted">{line.lot || "—"}</td>
                        <td className="px-3 py-2 text-theme-text-muted">{line.evidence.length ? `${line.evidence.length} foto(s)` : "Sin evidencia disponible"}</td>
                        <td className="px-3 py-2"><button type="button" onClick={() => setEditingIndex(editingIndex === index ? null : index)} className="font-semibold text-theme-text-accent hover:underline">{editingIndex === index ? "Cerrar" : "Editar"}</button></td>
                      </tr>
                      {editingIndex === index && <tr className="bg-theme-accent/5"><td colSpan={7} className="p-3"><div className="rounded-lg border border-theme-accent/30 p-3"><div className="grid gap-2 sm:grid-cols-2"><label className="text-xs text-theme-text-muted">Motivo *<input value={line.reason} onChange={(event) => updateLine(index, { reason: event.target.value })} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text" /></label><label className="text-xs text-theme-text-muted">Vencimiento *<input type="date" value={line.expiration_date} onChange={(event) => updateLine(index, { expiration_date: event.target.value })} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text" /></label><label className="text-xs text-theme-text-muted">Lote opcional<input value={line.lot} onChange={(event) => updateLine(index, { lot: event.target.value })} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text" /></label><label className="text-xs text-theme-text-muted">Observación opcional<input value={line.observation} onChange={(event) => updateLine(index, { observation: event.target.value })} className="mt-1 h-8 w-full rounded-md border border-theme-border bg-theme-surface px-2 text-xs text-theme-text" /></label></div><label className="mt-2 block text-xs text-theme-text-muted">Evidencia opcional<input type="file" accept="image/jpeg,image/png,image/webp,image/heic" multiple onChange={(event) => updateLine(index, { evidence: Array.from(event.target.files ?? []) })} className="mt-1 block w-full text-xs text-theme-text file:mr-2 file:rounded-md file:border-0 file:bg-theme-text/5 file:px-2 file:py-1 file:text-xs file:font-semibold file:text-theme-text" /></label><p className="mt-1 text-[11px] text-theme-text-muted">{line.evidence.length ? `${line.evidence.length} archivo(s) seleccionado(s)` : "Sin evidencia disponible es válido para DIRECTO_BSALE."}</p><label className="mt-3 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300"><input type="checkbox" checked={line.has_difference} onChange={(event) => updateLine(index, { has_difference: event.target.checked })} />Marcar diferencia: requiere revisión manual y bloquea la regularización.</label></div></td></tr>}
                    </Fragment>)}</tbody>
                  </table>
                </div>
              </div>
              {saveError && <p className="mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-600">{saveError}</p>}
              {!canAuthorize && <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Puedes revisar el consumo, pero necesitas permiso para autorizar su ingreso a Bodega.</p>}
              {hasDifferences && <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Existe una diferencia pendiente de revisión.</p>}
              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-theme-border pt-3"><label className="flex items-center gap-2 text-xs text-theme-text-muted"><input type="checkbox" checked={confirmedReview} onChange={(event) => setConfirmedReview(event.target.checked)} />Confirmo que revisé los productos y cantidades del consumo Bsale.</label>{canAuthorize ? <button type="button" disabled={saveDisabled} onClick={() => void saveIncident()} className="rounded-lg bg-theme-accent px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? "INGRESANDO..." : "REGULARIZAR E INGRESAR A BODEGA"}</button> : <span className="text-right text-[11px] text-theme-text-muted">Permiso de autorización requerido para finalizar.</span>}</div>
              <p className="mt-2 text-right text-[11px] text-theme-text-muted">{uploadStatus || (hasDifferences ? "Existe una diferencia pendiente de revisión." : missingExpirationCount > 0 ? `Faltan vencimientos en ${missingExpirationCount} líneas.` : missingReasonCount > 0 ? `Faltan motivos en ${missingReasonCount} líneas.` : incompleteCount > 0 ? `Faltan datos obligatorios en ${incompleteCount} líneas.` : "Una sola confirmación · evidencia opcional para DIRECTO_BSALE.")}</p>
            </div> : <div className="flex min-h-0 flex-1 flex-col"><div className="border-b border-theme-border pb-3"><h3 className="font-mono text-sm font-semibold text-theme-text">Consumo Bsale #{selected.consumption_id}</h3><p className="mt-2 text-xs text-theme-text-muted">{selected.product_count} productos · {selected.total_quantity} unidades</p><p className="mt-2 text-xs text-theme-text-muted">Revisión consolidada: motivo, vencimiento y observación pueden aplicarse en masa; las excepciones se editan por línea.</p></div><div className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-theme-border"><table className="w-full min-w-[560px] text-xs"><thead className="bg-theme-text/[0.025] text-left text-[10px] uppercase tracking-wider text-theme-text-muted"><tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Producto</th><th className="px-3 py-2">Cantidad</th><th className="px-3 py-2">Solicitud</th></tr></thead><tbody>{selected.details.map((detail) => <tr key={detail.detail_id} className="border-t border-theme-border/70"><td className="px-3 py-2 font-mono text-theme-text">{detail.sku}</td><td className="px-3 py-2 text-theme-text-muted">{detail.product_name}</td><td className="px-3 py-2 tabular-nums text-theme-text">{detail.quantity}</td><td className="px-3 py-2 text-theme-text-muted">{detail.match_status}</td></tr>)}</tbody></table></div><div className="mt-3 flex justify-end border-t border-theme-border pt-3"><button type="button" disabled={selected.status !== "SIN SOLICITUD"} onClick={() => { setDraftLines(draftLinesFor(selected, generalReason)); setFormOpen(true); }} className="rounded-lg border border-theme-accent bg-theme-accent/10 px-3 py-2 text-[10px] font-semibold text-theme-text-accent disabled:cursor-not-allowed disabled:border-theme-border disabled:bg-transparent disabled:text-theme-text-muted">REVISAR REGULARIZACIÓN</button></div></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
