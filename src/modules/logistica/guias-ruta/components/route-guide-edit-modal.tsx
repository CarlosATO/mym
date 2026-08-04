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

  // Reiniciar scroll interno y enfocar titulo al abrir
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const routeOptions = useMemo(() => dedupOptions(catalogOptions.routes), [catalogOptions.routes]);
  const vehicleOptions = useMemo(() => dedupOptions(catalogOptions.vehicles), [catalogOptions.vehicles]);
  const driverOptions = useMemo(() => dedupOptions(catalogOptions.personnel, 'DRIVER'), [catalogOptions.personnel]);
  const sellerOptions = useMemo(() => dedupOptions(catalogOptions.personnel, 'SELLER'), [catalogOptions.personnel]);
  const dispatcherOptions = useMemo(() => dedupOptions(catalogOptions.personnel, 'DISPATCHER'), [catalogOptions.personnel]);

  const optionLabel = (options: ComboboxOption[], value: string): string =>
    options.find(o => o.value === value)?.label || '—';

  const headerChanges = useMemo(() => {
    const changes: string[] = [];
    if (routeId !== guide.route_id) {
      changes.push(`Ruta: ${optionLabel(routeOptions, guide.route_id)} → ${optionLabel(routeOptions, routeId)}`);
    }
    if (vehicleId !== guide.vehicle_id) {
      changes.push(`Vehículo: ${optionLabel(vehicleOptions, guide.vehicle_id)} → ${optionLabel(vehicleOptions, vehicleId)}`);
    }
    if (driverId !== guide.driver_id) {
      changes.push(`Conductor: ${optionLabel(driverOptions, guide.driver_id)} → ${optionLabel(driverOptions, driverId)}`);
    }
    if ((sellerId || '') !== (guide.seller_id || '')) {
      changes.push(`Vendedor: ${optionLabel(sellerOptions, guide.seller_id || '')} → ${optionLabel(sellerOptions, sellerId)}`);
    }
    if (dispatcherId !== guide.dispatcher_id) {
      changes.push(`Despachador: ${optionLabel(dispatcherOptions, guide.dispatcher_id)} → ${optionLabel(dispatcherOptions, dispatcherId)}`);
    }
    if (guideDate !== guide.guide_date) {
      changes.push(`Fecha: ${guide.guide_date} → ${guideDate}`);
    }
    if (notes !== (guide.notes || '')) {
      changes.push('Observaciones: modificadas');
    }
    return changes;
  }, [routeId, vehicleId, driverId, sellerId, dispatcherId, guideDate, notes, guide, routeOptions, vehicleOptions, driverOptions, sellerOptions, dispatcherOptions]);

  const handleSave = async () => {
    if (busy || reason.trim().length < 5) return;
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
