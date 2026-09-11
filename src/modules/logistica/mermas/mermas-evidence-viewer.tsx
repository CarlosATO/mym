"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

export type MermaEvidenceViewerItem = {
  id: string;
  file_name: string;
  mime_type: string;
  signed_url: string;
};

export function MermaEvidenceViewer({
  evidence,
}: {
  evidence: MermaEvidenceViewerItem[];
}) {
  const [selected, setSelected] = useState<MermaEvidenceViewerItem | null>(null);

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  if (!evidence.length) {
    return <span className="text-xs text-theme-text-muted">Sin evidencia</span>;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {evidence.map((photo) => (
          <button
            key={photo.id}
            type="button"
            onClick={() => setSelected(photo)}
            className="h-10 w-10 overflow-hidden rounded-md border border-theme-border bg-theme-text/5 focus:outline-none focus:ring-2 focus:ring-theme-accent"
            aria-label={`Ver evidencia ${photo.file_name}`}
          >
            <img
              src={photo.signed_url}
              alt=""
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>
      {selected && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Evidencia fotográfica"
          onClick={() => setSelected(null)}
        >
          <div
            className="relative flex max-h-[90vh] max-w-[95vw] items-center justify-center rounded-xl bg-black/20 p-2"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={selected.signed_url}
              alt={selected.file_name}
              className="max-h-[85vh] max-w-full object-contain"
            />
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="absolute -right-3 -top-3 rounded-full bg-theme-surface p-2 text-theme-text shadow-lg"
              aria-label="Cerrar evidencia"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
