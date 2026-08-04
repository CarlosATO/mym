'use client';

import { useState } from 'react';
import { RouteGuide, RouteGuideItem } from '../types';
import { editRouteGuideUnsettled } from '@/app/actions/logistica/guias-ruta';
import { useRouteGuideGrid } from '../hooks/use-route-guide-grid';
import { formatCurrency } from '../utils/route-guide-formatters';

interface RouteGuideEditModalProps {
  guide: RouteGuide;
  onClose: () => void;
  onSaved: () => void;
}

export function RouteGuideEditModal({ guide, onClose, onSaved }: RouteGuideEditModalProps) {
  const { items, handlePaste, handleCellChange, addRow, removeRow, totals } = useRouteGuideGrid(
    (guide.items || []).map(i => ({ ...i })) as RouteGuideItem[]
  );

  const [guideDate, setGuideDate] = useState(guide.guide_date);
  const [notes, setNotes] = useState(guide.notes || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (busy || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      // Normalizar: omitir ids de lineas nuevas (sin id) y enviar estado final
      const payloadItems = items
        .filter(i => i.invoice_number || i.customer_name || i.amount || i.payment_method_original)
        .map(i => ({
          id: i.id || null,
          invoice_number: i.invoice_number,
          customer_name: i.customer_name,
          customer_address: i.customer_address || '',
          commune: i.commune || '',
          amount: String(i.amount ?? ''),
          payment_method_original: i.payment_method_original || '',
          notes: i.notes || '',
        }));
      const header = {
        guide_date: guideDate,
        route_id: guide.route_id,
        vehicle_id: guide.vehicle_id,
        driver_id: guide.driver_id,
        seller_id: guide.seller_id || null,
        dispatcher_id: guide.dispatcher_id,
        notes,
      };
      await editRouteGuideUnsettled(guide.id, header, payloadItems, reason, guide.version_number || 1);
      onSaved();
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(
        err.code === 'ROUTE_GUIDE_CONCURRENT_MODIFICATION'
          ? 'Esta guía fue modificada por otro usuario. Recarga la información antes de continuar.'
          : err.message || 'No se pudo editar la guía.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-theme-border bg-theme-surface p-5 shadow-2xl">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-bold text-theme-text">Editar Guía {guide.guide_number}</h3>
          <button type="button" onClick={onClose} className="rounded-lg border border-theme-border px-3 py-1.5 text-sm text-theme-text-muted hover:bg-theme-text/5">
            Cerrar
          </button>
        </div>

        {guide.status === 'DISPATCHED' && (
          <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Si esta guía ya fue impresa o entregada, deberá volver a imprimirse después de guardar.
          </p>
        )}

        {/* Cabecera editable */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-semibold text-theme-text-muted">Fecha de la guía</label>
            <input
              type="date"
              value={guideDate}
              onChange={e => setGuideDate(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-border-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-theme-text-muted">Observaciones</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-border-accent"
            />
          </div>
        </div>

        {/* Tabla de líneas editable con paste */}
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-theme-text">Líneas</h4>
            <div className="flex gap-2">
              <button type="button" onClick={addRow} className="rounded-lg bg-theme-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-theme-accent-hover">
                + Agregar línea
              </button>
            </div>
          </div>
          <div
            className="overflow-x-auto rounded-lg border border-theme-border"
            onPaste={e => handlePaste(e, 0, 'invoice_number')}
          >
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-theme-border/60 bg-theme-text/2 text-left text-[11px] uppercase tracking-wider text-theme-text-muted/70">
                  <th className="px-2 py-2">#</th>
                  <th className="px-2 py-2">Factura</th>
                  <th className="px-2 py-2">Cliente</th>
                  <th className="px-2 py-2">Dirección</th>
                  <th className="px-2 py-2">Comuna</th>
                  <th className="px-2 py-2 text-right">Monto</th>
                  <th className="px-2 py-2">Forma de pago</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={idx} className="border-b border-theme-border/40 last:border-0">
                    <td className="px-2 py-1.5 text-xs text-theme-text-muted">{idx + 1}</td>
                    <td className="px-2 py-1.5">
                      <input
                        value={item.invoice_number}
                        onChange={e => handleCellChange(idx, 'invoice_number', e.target.value)}
                        className="h-8 w-full min-w-[80px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={item.customer_name}
                        onChange={e => handleCellChange(idx, 'customer_name', e.target.value)}
                        className="h-8 w-full min-w-[120px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={item.customer_address}
                        onChange={e => handleCellChange(idx, 'customer_address', e.target.value)}
                        className="h-8 w-full min-w-[100px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={item.commune}
                        onChange={e => handleCellChange(idx, 'commune', e.target.value)}
                        className="h-8 w-full min-w-[80px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={String(item.amount ?? '')}
                        onChange={e => handleCellChange(idx, 'amount', e.target.value)}
                        className="h-8 w-full min-w-[80px] rounded border border-theme-border bg-theme-surface px-2 text-right text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={item.payment_method_original}
                        onChange={e => handleCellChange(idx, 'payment_method_original', e.target.value)}
                        placeholder="Efectivo / Cheque / …"
                        className="h-8 w-full min-w-[100px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <button type="button" onClick={() => removeRow(idx)} className="text-xs text-red-600 dark:text-red-400 hover:underline">
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-theme-text-muted/70">Copia desde Excel y pega sobre la tabla para llenar varias líneas.</p>
        </div>

        {/* Resumen de cambios */}
        <div className="mt-4 rounded-lg border border-theme-border/60 bg-theme-text/2 p-3">
          <p className="text-xs font-semibold text-theme-text-muted">Resumen</p>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-4">
            <span className="text-theme-text-muted">Total anterior: <strong className="text-theme-text">{formatCurrency(guide.total_amount)}</strong></span>
            <span className="text-theme-text-muted">Total nuevo: <strong className="text-theme-text">{formatCurrency(totals.total_amount)}</strong></span>
            <span className="text-theme-text-muted">Facturas: <strong className="text-theme-text">{totals.total_invoices}</strong></span>
            <span className="text-theme-text-muted">Versión: <strong className="text-theme-text">{guide.version_number || 1}</strong></span>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {/* Motivo + guardar */}
        <div className="mt-4">
          <label className="block text-xs font-semibold text-theme-text-muted">Motivo de la edición (obligatorio)</label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            placeholder="Describe el motivo del cambio (mínimo 5 caracteres)"
            className="mt-1 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text outline-none focus:border-theme-border-accent"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-theme-border px-4 py-2 text-sm text-theme-text-muted hover:bg-theme-text/5">
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy || reason.trim().length < 5}
              className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-40"
            >
              {busy ? 'Guardando…' : 'Guardar edición'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
