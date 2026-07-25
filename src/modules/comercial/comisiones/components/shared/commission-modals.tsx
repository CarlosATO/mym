import { Download, X } from "lucide-react";

export function ConfirmModal({
  action,
  reason,
  onReason,
  busy,
  onConfirm,
  onCancel,
}: {
  action: {
    type: "create_draft" | "cancel" | "issue" | "annul";
    settlementId?: string;
  };
  reason: string;
  onReason: (v: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const messages = {
    create_draft: {
      title: "Crear borrador",
      body: "Se creará un borrador y las líneas quedarán reservadas. No aparecerán en nuevas simulaciones hasta cancelar el borrador.",
      needsReason: false,
      confirmLabel: "Crear borrador",
    },
    cancel: {
      title: "Cancelar borrador",
      body: "Las líneas asociadas quedarán liberadas para futuras simulaciones.",
      needsReason: true,
      confirmLabel: "Cancelar borrador",
    },
    issue: {
      title: "Emitir liquidación",
      body: "Al emitir, las líneas quedarán bloqueadas definitivamente. Esta acción no se puede deshacer automáticamente.",
      needsReason: false,
      confirmLabel: "Emitir liquidación",
    },
    annul: {
      title: "Anular liquidación emitida",
      body: "Esta liquidación emitida será anulada. El correlativo se mantendrá consumido y las líneas volverán a estar disponibles para una nueva liquidación.",
      needsReason: true,
      confirmLabel: "Anular liquidación",
    },
  };
  const msg = messages[action.type];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-xl">
        <h3 className="font-semibold">{msg.title}</h3>
        <p className="mt-2 text-sm text-theme-text-muted">{msg.body}</p>
        {msg.needsReason && (
          <textarea
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            placeholder="Motivo de cancelación *"
            className="mt-3 h-20 w-full resize-none rounded-lg border border-theme-border bg-theme-bg/50 p-2 text-xs"
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary" disabled={busy}>
            Volver
          </button>
          <button
            onClick={onConfirm}
            className="btn-primary"
            disabled={busy || (msg.needsReason && !reason.trim())}
          >
            {busy ? "Procesando..." : msg.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function PdfPreviewModal({
  base64,
  filename,
  onClose,
  onDownload,
}: {
  base64: string;
  filename: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="mx-4 flex h-[90vh] w-full max-w-5xl flex-col rounded-xl border border-theme-border bg-theme-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-theme-border px-4 py-2">
          <span className="text-sm font-semibold">{filename}</span>
          <div className="flex items-center gap-2">
            <button onClick={onDownload} className="btn-primary">
              <Download className="h-3.5 w-3.5" />
              Descargar
            </button>
            <button onClick={onClose} className="btn-secondary">
              <X className="h-3.5 w-3.5" />
              Cerrar
            </button>
          </div>
        </div>
        <div className="flex-1">
          <iframe
            src={`data:application/pdf;base64,${base64}`}
            className="h-full w-full"
            title="Vista previa PDF"
          />
        </div>
      </div>
    </div>
  );
}
