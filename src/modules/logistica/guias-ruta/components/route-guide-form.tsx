import React, { useState, useEffect, useRef } from 'react';
import { CatalogOptions, RouteGuide } from '../types';
import { RouteGuideGrid } from './route-guide-grid';
import { useRouteGuideGrid } from '../hooks/use-route-guide-grid';
import { RouteGuideCombobox } from './route-guide-combobox';
import { Save, Send, AlertTriangle, XCircle } from 'lucide-react';
import { createDeliveryRouteInline, createRouteVehicleInline, createRoutePersonInline } from '@/app/actions/logistica/guias-ruta';
import type { RouteSaveDuplicateWarning, RouteDuplicateInvoice, SaveRouteGuideDraftResult } from '@/app/actions/logistica/guias-ruta';
import { generateRouteGuidePdfBlob, downloadRouteGuidePdf } from '@/lib/pdf/generate-route-guide-pdf';
import { parseChileanMoney, isEmptyRouteGuideRow } from '../utils/route-guide-validation';

function formatStatus(status: string) {
  if (status === 'DRAFT') return 'Borrador';
  if (status === 'DISPATCHED') return 'Despachada';
  return status;
}

interface RouteGuideFormProps {
  initialData?: RouteGuide;
  catalogOptions: CatalogOptions;
  onSaveDraft: (guideData: any, itemsData: any[]) => Promise<SaveRouteGuideDraftResult>;
  onDispatch: (guideId: string) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
  isDispatching: boolean;
}

export function RouteGuideForm({
  initialData,
  catalogOptions: initialCatalog,
  onSaveDraft,
  onDispatch,
  onCancel,
  isSaving,
  isDispatching
}: RouteGuideFormProps) {
  const [catalogs, setCatalogs] = useState(initialCatalog);
  const [guideDate, setGuideDate] = useState(initialData?.guide_date || new Date().toISOString().split('T')[0]);
  const [routeId, setRouteId] = useState(initialData?.route_id || '');
  const [vehicleId, setVehicleId] = useState(initialData?.vehicle_id || '');
  const [driverId, setDriverId] = useState(initialData?.driver_id || '');
  const [sellerId, setSellerId] = useState(initialData?.seller_id || '');
  const [dispatcherId, setDispatcherId] = useState(initialData?.dispatcher_id || '');
  const [notes, setNotes] = useState(initialData?.notes || '');
  const [guideId, setGuideId] = useState(initialData?.id || '');
  const [guideNumber, setGuideNumber] = useState(initialData?.guide_number || '');
  const [status, setStatus] = useState(initialData?.status || '');
  
  const [errorMsg, setErrorMsg] = useState('');
  const [draftWarnings, setDraftWarnings] = useState<RouteSaveDuplicateWarning[]>([]);
  const [dispatchDuplicates, setDispatchDuplicates] = useState<RouteDuplicateInvoice[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [showPrintView, setShowPrintView] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewGuideRef = useRef<RouteGuide | null>(null);

  const grid = useRouteGuideGrid(initialData?.items || []);
  const readOnly = status === 'DISPATCHED' || status === 'CANCELLED';

  // Deduplicate options by normalized name (case-insensitive visual dedup)
  const dedupOptions = (items: any[], type?: string) => {
    const map = new Map<string, any>();
    items.forEach(item => {
      if (type && item.person_type !== type) return;
      const normalized = (item.person_name || item.route_name || item.vehicle_name || '').trim().toUpperCase();
      if (!map.has(normalized)) {
        map.set(normalized, { value: item.id, label: item.person_name || item.route_name || item.vehicle_name });
      }
    });
    return Array.from(map.values());
  };

  const routeOptions = dedupOptions(catalogs.routes);
  const vehicleOptions = dedupOptions(catalogs.vehicles);
  const driverOptions = dedupOptions(catalogs.personnel, 'DRIVER');
  const sellerOptions = dedupOptions(catalogs.personnel, 'SELLER');
  const dispatcherOptions = dedupOptions(catalogs.personnel, 'DISPATCHER');

  // Inline creations
  const handleCreateRoute = async (name: string) => {
    try {
      const newId = await createDeliveryRouteInline(name);
      setCatalogs(prev => ({
        ...prev,
        routes: [...prev.routes, { id: newId, route_name: name, company_id: '', description: '', is_active: true }]
      }));
      setRouteId(newId);
    } catch (e: any) {
      setErrorMsg(e.message);
    }
  };

  const handleCreateVehicle = async (name: string) => {
    try {
      const newId = await createRouteVehicleInline(name);
      setCatalogs(prev => ({
        ...prev,
        vehicles: [...prev.vehicles, { id: newId, vehicle_name: name, company_id: '', plate_number: '', description: '', is_active: true }]
      }));
      setVehicleId(newId);
    } catch (e: any) {
      setErrorMsg(e.message);
    }
  };

  const handleCreateDriver = async (name: string) => {
    try {
      const newId = await createRoutePersonInline(name, 'DRIVER');
      setCatalogs(prev => ({
        ...prev,
        personnel: [...prev.personnel, { id: newId, person_name: name, person_type: 'DRIVER', company_id: '', phone: '', email: '', is_active: true }]
      }));
      setDriverId(newId);
    } catch (e: any) {
      setErrorMsg(e.message);
    }
  };

  const handleCreateDispatcher = async (name: string) => {
    try {
      const newId = await createRoutePersonInline(name, 'DISPATCHER');
      setCatalogs(prev => ({
        ...prev,
        personnel: [...prev.personnel, { id: newId, person_name: name, person_type: 'DISPATCHER', company_id: '', phone: '', email: '', is_active: true }]
      }));
      setDispatcherId(newId);
    } catch (e: any) {
      setErrorMsg(e.message);
    }
  };

  const handleCreateSeller = async (name: string) => {
    try {
      const newId = await createRoutePersonInline(name, 'SELLER');
      // If returning existing ID, it might not be appended nicely if it was hidden, but we reload catalogs ideally. 
      // For immediate UX:
      setCatalogs(prev => ({
        ...prev,
        personnel: [...prev.personnel, { id: newId, person_name: name, person_type: 'SELLER', company_id: '', phone: '', email: '', is_active: true }]
      }));
      setSellerId(newId);
    } catch (e: any) {
      setErrorMsg(e.message);
    }
  };

  const handleSaveDraft = async () => {
    if (!guideDate || !routeId || !vehicleId) {
      setErrorMsg('Por favor completa al menos los campos básicos (Fecha, Ruta, Vehículo) para el borrador.');
      return;
    }

    const routeName = catalogs.routes.find(r => r.id === routeId)?.route_name || '';
    const vehicleName = catalogs.vehicles.find(v => v.id === vehicleId)?.vehicle_name || '';
    const driverName = catalogs.personnel.find(p => p.id === driverId)?.person_name || null;
    const sellerName = catalogs.personnel.find(p => p.id === sellerId)?.person_name || null;
    const dispatcherName = catalogs.personnel.find(p => p.id === dispatcherId)?.person_name || null;

    const guideData = {
      guide_date: guideDate,
      route_id: routeId,
      route_name_snapshot: routeName,
      vehicle_id: vehicleId,
      vehicle_name_snapshot: vehicleName,
      driver_id: driverId || null,
      driver_name_snapshot: driverName,
      seller_id: sellerId || null,
      seller_name_snapshot: sellerName,
      dispatcher_id: dispatcherId || null,
      dispatcher_name_snapshot: dispatcherName,
      notes: notes,
      ...grid.totals
    };

    // Filtramos las filas que están completamente vacías y parseamos el monto
    const validItems = grid.items
      .filter(i => !isEmptyRouteGuideRow(i))
      .map(i => ({
        ...i,
        amount: parseChileanMoney(i.amount)
      }));

    try {
      setErrorMsg('');
      setDraftWarnings([]);
      setDispatchDuplicates([]);
      const res = await onSaveDraft(guideData, validItems);
      
      // Update local state to reflect the successfully saved state
      setGuideId(res.id);
      setGuideNumber(res.guide_number || '');
      setStatus(res.status || 'DRAFT');

      if (res.warnings && res.warnings.length > 0) {
        setDraftWarnings(res.warnings);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Ocurrió un error al guardar');
    }
  };

  const unknownPayments = React.useMemo(() => {
    return grid.items.filter(item => 
      item.payment_method_normalized === 'UNKNOWN' && 
      item.payment_method_original?.trim()
    );
  }, [grid.items]);

  const handleDispatch = async () => {
    if (isSaving || isDispatching) return;
    if (!guideId) {
      setErrorMsg('Debe guardar el borrador antes de despachar.');
      return;
    }
    
    // Si hay errores reales (montos invalidos, vacios criticos, duplicados)
    if (grid.totals.error_count > 0 || grid.totals.duplicate_count > 0) {
      setErrorMsg('No puedes despachar una guía que contiene errores o duplicados.');
      return;
    }

    // Si hay pagos UNKNOWN
    if (unknownPayments.length > 0) {
      setErrorMsg('No se puede despachar la guía porque hay formas de pago no reconocidas.');
      return;
    }
    
    if (!guideDate || !routeId || !vehicleId || !driverId || !sellerId || !dispatcherId) {
      setErrorMsg('Por favor completa todos los campos de cabecera obligatorios (Fecha, Ruta, Vehículo, Conductor, Vendedor, Despachador) para despachar.');
      setShowErrors(true);
      return;
    }

    try {
      setErrorMsg('');
      setDraftWarnings([]);
      setDispatchDuplicates([]);
      await onDispatch(guideId);
    } catch (err: any) {
      // Render duplicates detail if available
      if (err.duplicates && err.duplicates.length > 0) {
        setDispatchDuplicates(err.duplicates);
      }
      setErrorMsg(err.message || 'Ocurrió un error al despachar');
    }
  };

  return (
    <div className="w-full max-w-7xl mx-auto space-y-6 px-4 py-4 animate-in fade-in duration-200">
      {/* Header Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-theme-border/60">
        <div>
          <h2 className="text-xl font-bold text-theme-text flex items-center gap-3">
            {guideNumber ? `Guía ${guideNumber}` : 'Nueva Guía de Ruta'}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2.5 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-xs font-semibold text-theme-text transition-all"
            disabled={isSaving || isDispatching}
          >
            {readOnly ? 'Volver' : 'Cancelar'}
          </button>
          
          {!readOnly && (
            <>
              <button
                onClick={async () => {
                  try {
                    const guideObj = {
                      id: guideId,
                      company_id: '',
                      guide_number: guideNumber,
                      guide_date: guideDate,
                      route_id: routeId,
                      route_name_snapshot: catalogs.routes.find(r => r.id === routeId)?.route_name || '',
                      vehicle_id: vehicleId,
                      vehicle_name_snapshot: catalogs.vehicles.find(v => v.id === vehicleId)?.vehicle_name || '',
                      driver_id: driverId,
                      driver_name_snapshot: catalogs.personnel.find(p => p.id === driverId)?.person_name || '',
                      seller_id: sellerId,
                      seller_name_snapshot: catalogs.personnel.find(p => p.id === sellerId)?.person_name || '',
                      dispatcher_id: dispatcherId,
                      dispatcher_name_snapshot: catalogs.personnel.find(p => p.id === dispatcherId)?.person_name || '',
                      notes: notes,
                      status: status || 'DRAFT',
                      ...grid.totals,
                      items: grid.items as any
                    } as RouteGuide;
                    const blob = await generateRouteGuidePdfBlob(guideObj);
                    const url = URL.createObjectURL(blob);
                    previewGuideRef.current = guideObj;
                    setPreviewUrl(url);
                    setShowPrintView(true);
                  } catch (e: any) {
                    setErrorMsg('Error al generar vista previa: ' + e.message);
                  }
                }}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-xs font-semibold text-theme-text transition-all"
              >
                Imprimir Borrador
              </button>
              <button
                type="button"
                onClick={handleSaveDraft}
                disabled={isSaving || isDispatching}
                className="flex items-center gap-2 bg-theme-accent hover:bg-theme-accent-hover disabled:bg-theme-accent/50 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg shadow-theme-accent/20"
              >
                <Save className="w-4 h-4" /> {isSaving ? 'Guardando...' : (guideId ? 'Guardar Cambios' : 'Guardar Borrador')}
              </button>
              
              {guideId && (
                <button
                  onClick={handleDispatch}
                  disabled={isSaving || isDispatching || grid.totals.error_count > 0}
                  className="flex items-center gap-1.5 px-6 py-2.5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-lg shadow-theme-accent/20 disabled:opacity-50"
                >
                  <Send className="w-4 h-4" /> {isDispatching ? 'Despachando...' : 'Confirmar Despacho'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Error Panel General y de Duplicados en Despacho */}
      {errorMsg && (
        <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5 text-xs text-red-600 dark:text-red-400 font-medium">
          <div className="flex items-start gap-2 mb-2">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="font-bold">{errorMsg}</span>
          </div>
          {/* Dispatch duplicates detail */}
          {dispatchDuplicates.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-red-500/20 pt-3">
              {dispatchDuplicates.map((d, i) => (
                <div key={i} className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                  <span className="font-bold">Factura {d.invoice_number}</span>
                  <span>→ {d.existing_guide_number}</span>
                  <span className="opacity-70">Estado: {formatStatus(d.existing_status)}</span>
                  {d.route_name_snapshot && <span className="opacity-70">Ruta: {d.route_name_snapshot}</span>}
                  {d.existing_guide_date && <span className="opacity-70">Fecha: {d.existing_guide_date}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Draft Warnings Panel (orange, non-blocking) */}
      {draftWarnings.length > 0 && draftWarnings[0]?.duplicates?.length > 0 && (
        <div className="p-4 rounded-xl border border-orange-500/30 bg-orange-500/5 text-xs font-medium">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-orange-500" />
            <span className="font-bold text-orange-700 dark:text-orange-400">
              Borrador guardado con advertencias. Algunas facturas ya existen en otras guías activas.
            </span>
          </div>
          <div className="mt-3 space-y-1.5 border-t border-orange-500/20 pt-3 text-orange-700 dark:text-orange-300">
            {draftWarnings[0].duplicates.map((d, i) => (
              <div key={i} className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                <span className="font-bold">Factura {d.invoice_number}</span>
                <span>→ {d.existing_guide_number}</span>
                <span className="opacity-80">Estado: {formatStatus(d.existing_status)}</span>
                {d.route_name_snapshot && <span className="opacity-80">Ruta: {d.route_name_snapshot}</span>}
                {d.existing_guide_date && <span className="opacity-80">Fecha: {d.existing_guide_date}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Form Content */}
      <div className="space-y-6">
        
        {/* Cabecera */}
        <div className="p-5 rounded-2xl border border-theme-border bg-theme-surface/50 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Fecha de Ruta <span className="text-red-500">*</span></label>
              <input
                type="date"
                value={guideDate}
                onChange={e => setGuideDate(e.target.value)}
                className="w-full h-8 px-3 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30 disabled:bg-theme-text/5"
                disabled={readOnly}
              />
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Ruta <span className="text-red-500">*</span></label>
              <div className="h-8">
                <RouteGuideCombobox
              options={routeOptions}
              value={routeId}
              onChange={setRouteId}
              placeholder="Seleccionar ruta..."
              onCreateNew={handleCreateRoute}
              disabled={readOnly}
            />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Vehículo <span className="text-red-500">*</span></label>
              <div className="h-8">
                <RouteGuideCombobox
              options={vehicleOptions}
              value={vehicleId}
              onChange={setVehicleId}
              placeholder="Seleccionar vehículo..."
              onCreateNew={handleCreateVehicle}
              disabled={readOnly}
            />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Conductor <span className="text-red-500">*</span></label>
              <div className="h-8">
                <RouteGuideCombobox
                  options={driverOptions}
                  value={driverId}
                  onChange={setDriverId}
                  placeholder="Seleccionar conductor..."
                  onCreateNew={handleCreateDriver}
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Vendedor <span className="text-red-500">*</span></label>
              <div className="h-8">
                <RouteGuideCombobox
                  options={sellerOptions}
                  value={sellerId}
                  onChange={setSellerId}
                  placeholder="Seleccionar vendedor..."
                  onCreateNew={handleCreateSeller}
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Despachador (Armador) <span className="text-red-500">*</span></label>
              <div className="h-8">
                <RouteGuideCombobox
              options={dispatcherOptions}
              value={dispatcherId}
              onChange={setDispatcherId}
              placeholder="Seleccionar despachador..."
              onCreateNew={handleCreateDispatcher}
              disabled={readOnly}
            />
              </div>
            </div>

            <div className="space-y-1 md:col-span-3">
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Observaciones Generales</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="w-full h-8 px-3 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30 disabled:bg-theme-text/5 placeholder:text-theme-text-muted/50"
                placeholder="Notas opcionales..."
                disabled={readOnly}
              />
            </div>
          </div>
        </div>

        <RouteGuideGrid
          items={grid.items}
          totals={grid.totals}
          onCellChange={grid.handleCellChange}
          onPaste={grid.handlePaste}
          onRemoveRow={grid.removeRow}
          onClearGrid={grid.clearGrid}
          readOnly={readOnly}
        />

      </div>

      {showPrintView && previewUrl && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center" onClick={() => { setShowPrintView(false); URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }}>
          <div className="relative w-[90vw] h-[90vh] bg-theme-surface rounded-2xl border border-theme-border shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-3 border-b border-theme-border bg-theme-text/5 shrink-0">
              <h2 className="text-sm font-bold text-theme-text">Vista previa — Guía de Ruta</h2>
              <div className="flex items-center gap-2">
                <button onClick={() => { downloadRouteGuidePdf(previewGuideRef.current!, `Guia_${guideNumber || 'Borrador'}`); }} className="px-4 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-colors shadow-lg shadow-theme-accent/20">
                  Descargar PDF
                </button>
                <button onClick={() => { setShowPrintView(false); URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }} className="px-4 py-1.5 rounded-lg border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-xs font-semibold transition-colors">
                  Cerrar
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <iframe src={previewUrl} className="w-full h-full" title="Vista previa Guía de Ruta" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
