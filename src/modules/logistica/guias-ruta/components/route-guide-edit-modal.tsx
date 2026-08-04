'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { RouteGuide, CatalogOptions, DeliveryRoute, RouteGuideItem, RoutePersonnel, RouteVehicle } from '../types';
import { editRouteGuideUnsettled } from '@/app/actions/logistica/guias-ruta';
import { useRouteGuideGrid } from '../hooks/use-route-guide-grid';
import { RouteGuideCombobox, ComboboxOption } from './route-guide-combobox';
import { formatCurrency } from '../utils/route-guide-formatters';

interface RouteGuideEditModalProps {
  guide: RouteGuide;
  catalogOptions: CatalogOptions;
  onClose: () => void;
  onSaved: () => void;
}

type CatalogEntry = DeliveryRoute | RouteVehicle | RoutePersonnel;

function dedupOptions(items: CatalogEntry[], type?: string): ComboboxOption[] {
  const map = new Map<string, ComboboxOption>();
  items.forEach(item => {
    if (type && (item as RoutePersonnel).person_type !== type) return;
    const label = (item as RoutePersonnel).person_name || (item as DeliveryRoute).route_name || (item as RouteVehicle).vehicle_name || '';
    const normalized = label.trim().toUpperCase();
    if (normalized && !map.has(normalized)) {
      map.set(normalized, { value: item.id, label });
    }
  });
  return Array.from(map.values());
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Borrador',
  DISPATCHED: 'Despachada',
  CANCELLED: 'Cancelada',
};

function normalizeLine(line: RouteGuideItem) {
  const amount = typeof line.amount === 'number' ? line.amount : parseFloat(String(line.amount ?? '').replace(/[^\d.-]/g, '')) || 0;
  return {
    id: line.id && line.id.trim() ? line.id.trim() : null,
    invoice_number: (line.invoice_number ?? '').trim(),
    customer_name: (line.customer_name ?? '').trim(),
    customer_address: (line.customer_address ?? '').trim(),
    commune: (line.commune ?? '').trim(),
    amount,
    payment_method_original: (line.payment_method_original ?? '').trim(),
    notes: (line.notes ?? '').trim(),
  };
}

function translateError(err: Error & { code?: string }): string {
  switch (err.code) {
    case 'ROUTE_GUIDE_CONCURRENT_MODIFICATION':
      return 'Esta guía fue modificada por otro usuario. Recarga la información antes de continuar.';
    case 'ROUTE_GUIDE_SETTLEMENT_STARTED':
      return 'Esta guía tiene una rendición o evidencia relacionada y se encuentra en modo solo lectura.';
    case 'ROUTE_GUIDE_DATE_YEAR_MISMATCH':
      return 'La fecha debe pertenecer al mismo año de la guía.';
    case 'ROUTE_GUIDE_IDEMPOTENCY_CONFLICT':
      return 'La solicitud ya fue procesada con otro contenido. Recarga la información e intenta de nuevo.';
    case 'INV_PERMISSION_REQUIRED':
      return 'No tienes permisos para editar guías de ruta.';
    default:
      return err.message && !err.message.startsWith('INV_') && !err.message.startsWith('ROUTE_')
        ? err.message
        : 'No se pudo editar la guía.';
  }
}

export function RouteGuideEditModal({ guide, catalogOptions, onClose, onSaved }: RouteGuideEditModalProps) {
  const { items, handlePaste, handleCellChange, addRow, removeRow, totals } = useRouteGuideGrid(
    (guide.items || []).map(i => ({ ...i })) as RouteGuideItem[]
  );

  const [routeId, setRouteId] = useState(guide.route_id || '');
  const [vehicleId, setVehicleId] = useState(guide.vehicle_id || '');
  const [driverId, setDriverId] = useState(guide.driver_id || '');
  const [sellerId, setSellerId] = useState(guide.seller_id || '');
  const [dispatcherId, setDispatcherId] = useState(guide.dispatcher_id || '');
  const [guideDate, setGuideDate] = useState(guide.guide_date);
  const [notes, setNotes] = useState(guide.notes || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // Reiniciar scroll interno y enfocar titulo al abrir
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // ---- Estado inicial normalizado (valores persistibles, no etiquetas) ----
  const normalizeId = (value: string | null | undefined): string | null =>
    value && value.trim() ? value.trim() : null;

  const initialHeader = useMemo(
    () => ({
      guide_date: (guide.guide_date || '').slice(0, 10),
      route_id: normalizeId(guide.route_id),
      vehicle_id: normalizeId(guide.vehicle_id),
      driver_id: normalizeId(guide.driver_id),
      seller_id: normalizeId(guide.seller_id),
      dispatcher_id: normalizeId(guide.dispatcher_id),
      notes: (guide.notes ?? '').trim(),
    }),
    [guide]
  );

  const currentHeader = {
    guide_date: (guideDate || '').slice(0, 10),
    route_id: normalizeId(routeId),
    vehicle_id: normalizeId(vehicleId),
    driver_id: normalizeId(driverId),
    seller_id: normalizeId(sellerId),
    dispatcher_id: normalizeId(dispatcherId),
    notes: (notes ?? '').trim(),
  };

  const hasHeaderChanges = useMemo(() => {
    return (
      currentHeader.guide_date !== initialHeader.guide_date
      || currentHeader.route_id !== initialHeader.route_id
      || currentHeader.vehicle_id !== initialHeader.vehicle_id
      || currentHeader.driver_id !== initialHeader.driver_id
      || currentHeader.seller_id !== initialHeader.seller_id
      || currentHeader.dispatcher_id !== initialHeader.dispatcher_id
      || currentHeader.notes !== initialHeader.notes
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideDate, routeId, vehicleId, driverId, sellerId, dispatcherId, notes, initialHeader]);

  // ---- Normalizacion de lineas para comparacion persistible ----
  const initialLines = useMemo(
    () => (guide.items || []).map(normalizeLine),
    [guide]
  );

  const lineChanges = useMemo(() => {
    const current = items
      .filter(i => i.invoice_number || i.customer_name || i.amount || i.payment_method_original)
      .map(normalizeLine);

    const byId = new Map<string, typeof current[number]>();
    current.forEach(l => { if (l.id) byId.set(l.id, l); });

    const added = current.filter(l => !l.id);
    const modified: string[] = [];
    const deleted: string[] = [];

    initialLines.forEach(orig => {
      const cur = orig.id ? byId.get(orig.id) : undefined;
      if (!cur) {
        deleted.push(orig.invoice_number || orig.id || '');
      } else {
        const same =
          cur.invoice_number === orig.invoice_number
          && cur.customer_name === orig.customer_name
          && cur.customer_address === orig.customer_address
          && cur.commune === orig.commune
          && cur.amount === orig.amount
          && cur.payment_method_original === orig.payment_method_original
          && cur.notes === orig.notes;
        if (!same) modified.push(cur.invoice_number || cur.id || '');
      }
    });

    // Lineas nuevas con id pero que no existian (no deberia pasar, pero defensivo)
    current.forEach(l => {
      if (l.id && !initialLines.some(o => o.id === l.id)) added.push(l);
    });

    return { added, modified, deleted, hasChanges: added.length > 0 || modified.length > 0 || deleted.length > 0 };
  }, [items, initialLines]);

  const hasChanges = hasHeaderChanges || lineChanges.hasChanges;


  const routeOptions = useMemo(() => dedupOptions(catalogOptions.routes), [catalogOptions.routes]);
  const vehicleOptions = useMemo(() => dedupOptions(catalogOptions.vehicles), [catalogOptions.vehicles]);
  const driverOptions = useMemo(() => dedupOptions(catalogOptions.personnel, 'DRIVER'), [catalogOptions.personnel]);
  const sellerOptions = useMemo(() => dedupOptions(catalogOptions.personnel, 'SELLER'), [catalogOptions.personnel]);
  const dispatcherOptions = useMemo(() => dedupOptions(catalogOptions.personnel, 'DISPATCHER'), [catalogOptions.personnel]);

  const optionLabel = (options: ComboboxOption[], value: string): string =>
    options.find(o => o.value === value)?.label || '—';

  const headerChanges = useMemo(() => {
    const changes: string[] = [];
    if (currentHeader.route_id !== initialHeader.route_id) {
      changes.push(`Ruta: ${optionLabel(routeOptions, initialHeader.route_id || '')} → ${optionLabel(routeOptions, currentHeader.route_id || '')}`);
    }
    if (currentHeader.vehicle_id !== initialHeader.vehicle_id) {
      changes.push(`Vehículo: ${optionLabel(vehicleOptions, initialHeader.vehicle_id || '')} → ${optionLabel(vehicleOptions, currentHeader.vehicle_id || '')}`);
    }
    if (currentHeader.driver_id !== initialHeader.driver_id) {
      changes.push(`Conductor: ${optionLabel(driverOptions, initialHeader.driver_id || '')} → ${optionLabel(driverOptions, currentHeader.driver_id || '')}`);
    }
    if (currentHeader.seller_id !== initialHeader.seller_id) {
      changes.push(`Vendedor: ${optionLabel(sellerOptions, initialHeader.seller_id || '')} → ${optionLabel(sellerOptions, currentHeader.seller_id || '')}`);
    }
    if (currentHeader.dispatcher_id !== initialHeader.dispatcher_id) {
      changes.push(`Despachador: ${optionLabel(dispatcherOptions, initialHeader.dispatcher_id || '')} → ${optionLabel(dispatcherOptions, currentHeader.dispatcher_id || '')}`);
    }
    if (currentHeader.guide_date !== initialHeader.guide_date) {
      changes.push(`Fecha: ${initialHeader.guide_date} → ${currentHeader.guide_date}`);
    }
    if (currentHeader.notes !== initialHeader.notes) {
      changes.push(`Observaciones: ${initialHeader.notes || 'Sin observación'} → ${currentHeader.notes || 'Sin observación'}`);
    }
    return changes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideDate, routeId, vehicleId, driverId, sellerId, dispatcherId, notes, initialHeader, currentHeader, routeOptions, vehicleOptions, driverOptions, sellerOptions, dispatcherOptions]);

  const handleSave = async () => {
    if (busy || !hasChanges) return;
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 5 || trimmedReason.length > 1000) {
      setError('El motivo de la edición es obligatorio (mínimo 5 caracteres).');
      reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
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
        route_id: routeId,
        vehicle_id: vehicleId,
        driver_id: driverId,
        seller_id: sellerId || null,
        dispatcher_id: dispatcherId,
        notes,
      };
      await editRouteGuideUnsettled(guide.id, header, payloadItems, reason, guide.version_number || 1);
      onSaved();
    } catch (e) {
      setError(translateError(e as Error & { code?: string }));
    } finally {
      setBusy(false);
    }
  };

  const modal = (
    <div className="fixed inset-0 z-[99999] flex items-start justify-center bg-black/50 p-2 sm:p-4">
      <div
        className="flex w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-2xl"
        style={{ maxHeight: 'calc(100dvh - 16px)', minHeight: 'min(100dvh - 16px, 480px)' }}
      >
        {/* Encabezado fijo */}
        <header className="shrink-0 border-b border-theme-border bg-theme-surface/95 px-4 py-3 backdrop-blur sm:px-5">
          <div className="flex items-center justify-between gap-2">
            <h3
              ref={titleRef}
              tabIndex={-1}
              className="text-base font-bold text-theme-text outline-none"
            >
              Editar guía de ruta
            </h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-theme-border text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-theme-text-muted">
            <span className="font-mono font-semibold text-theme-text">{guide.guide_number}</span>
            <span className="rounded-full border border-theme-border bg-theme-text/2 px-2 py-0.5 font-medium">
              {STATUS_LABELS[guide.status] || guide.status}
            </span>
            <span>Versión {guide.version_number || 1}</span>
          </div>
          {guide.status === 'DISPATCHED' && (
            <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Esta guía ya fue despachada. Si modifica sus datos o documentos, deberá volver a imprimirla y entregar la versión actualizada.
            </p>
          )}
        </header>

        {/* Cuerpo con scroll */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {/* Cabecera editable */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Ruta</label>
              <RouteGuideCombobox
                options={routeOptions}
                value={routeId}
                onChange={setRouteId}
                placeholder="Seleccionar ruta…"
                entityName="ruta"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Fecha de la guía</label>
              <input
                type="date"
                value={guideDate}
                onChange={e => setGuideDate(e.target.value)}
                className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text outline-none focus:border-theme-border-accent"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Vehículo</label>
              <RouteGuideCombobox
                options={vehicleOptions}
                value={vehicleId}
                onChange={setVehicleId}
                placeholder="Seleccionar vehículo…"
                entityName="vehículo"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Conductor</label>
              <RouteGuideCombobox
                options={driverOptions}
                value={driverId}
                onChange={setDriverId}
                placeholder="Seleccionar conductor…"
                entityName="conductor"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Vendedor</label>
              <RouteGuideCombobox
                options={sellerOptions}
                value={sellerId}
                onChange={setSellerId}
                placeholder="Sin asignar"
                entityName="vendedor"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Despachador</label>
              <RouteGuideCombobox
                options={dispatcherOptions}
                value={dispatcherId}
                onChange={setDispatcherId}
                placeholder="Seleccionar despachador…"
                entityName="despachador"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Observaciones</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-xs text-theme-text outline-none focus:border-theme-border-accent"
              />
            </div>
          </div>

          {/* Líneas */}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-theme-text">Líneas</h4>
              <button
                type="button"
                onClick={addRow}
                className="rounded-lg bg-theme-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-theme-accent-hover"
              >
                + Agregar línea
              </button>
            </div>
            <div
              className="overflow-x-auto rounded-lg border border-theme-border"
              onPaste={e => handlePaste(e, 0, 'invoice_number')}
            >
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-theme-border/60 bg-theme-text/2 text-left text-[10px] uppercase tracking-wider text-theme-text-muted/70">
                    <th className="sticky left-0 z-10 bg-theme-text/2 px-2 py-2">#</th>
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
                      <td className="sticky left-0 z-10 bg-theme-surface px-2 py-1.5 text-theme-text-muted">{idx + 1}</td>
                      <td className="px-2 py-1.5">
                        <input
                          value={item.invoice_number}
                          onChange={e => handleCellChange(idx, 'invoice_number', e.target.value)}
                          className="h-8 w-full min-w-[120px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={item.customer_name}
                          onChange={e => handleCellChange(idx, 'customer_name', e.target.value)}
                          className="h-8 w-full min-w-[180px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={item.customer_address}
                          onChange={e => handleCellChange(idx, 'customer_address', e.target.value)}
                          className="h-8 w-full min-w-[160px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={item.commune}
                          onChange={e => handleCellChange(idx, 'commune', e.target.value)}
                          className="h-8 w-full min-w-[110px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={String(item.amount ?? '')}
                          onChange={e => handleCellChange(idx, 'amount', e.target.value)}
                          className="h-8 w-full min-w-[100px] rounded border border-theme-border bg-theme-surface px-2 text-right text-xs"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          value={item.payment_method_original}
                          onChange={e => handleCellChange(idx, 'payment_method_original', e.target.value)}
                          placeholder="Efectivo / Cheque / …"
                          className="h-8 w-full min-w-[120px] rounded border border-theme-border bg-theme-surface px-2 text-xs"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <button type="button" onClick={() => removeRow(idx)} className="whitespace-nowrap text-xs text-red-600 hover:underline dark:text-red-400">
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-theme-text-muted/70">
              Copia desde Excel y pega sobre la tabla para llenar varias líneas.
            </p>
          </div>

          {/* Resumen de cambios */}
          <div className="mt-5 rounded-lg border border-theme-border/60 bg-theme-text/2 p-3">
            <p className="text-xs font-semibold text-theme-text-muted">Resumen de cambios</p>
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <span className="text-theme-text-muted">Total anterior: <strong className="text-theme-text">{formatCurrency(guide.total_amount)}</strong></span>
              <span className="text-theme-text-muted">Total nuevo: <strong className="text-theme-text">{formatCurrency(totals.total_amount)}</strong></span>
              <span className="text-theme-text-muted">Facturas: <strong className="text-theme-text">{totals.total_invoices}</strong></span>
              <span className="text-theme-text-muted">Versión: <strong className="text-theme-text">{guide.version_number || 1}</strong></span>
            </div>
            {headerChanges.length > 0 && (
              <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs text-theme-text-muted">
                {headerChanges.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
            {lineChanges.added.length > 0 && (
              <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                {lineChanges.added.length} línea(s) agregada(s)
              </p>
            )}
            {lineChanges.modified.length > 0 && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                {lineChanges.modified.length} línea(s) modificada(s)
              </p>
            )}
            {lineChanges.deleted.length > 0 && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {lineChanges.deleted.length} línea(s) eliminada(s)
              </p>
            )}
            {totals.total_amount !== guide.total_amount && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                Los totales se recalcularán automáticamente según las líneas.
              </p>
            )}
          </div>

          {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        {/* Pie fijo */}
        <footer className="shrink-0 border-t border-theme-border bg-theme-surface/95 px-4 py-3 backdrop-blur sm:px-5">
          <label className="block text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">Motivo de la edición (obligatorio)</label>
          <textarea
            ref={reasonRef}
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
              disabled={busy || !hasChanges}
              className="rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-white hover:bg-theme-accent-hover disabled:opacity-40"
            >
              {busy ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(modal, document.body);
}
