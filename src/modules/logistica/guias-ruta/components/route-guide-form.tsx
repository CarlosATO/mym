/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import React, { useState, useEffect, useRef } from 'react';
import { CatalogOptions, RouteGuide } from '../types';
import { RouteGuideGrid, type SaleConditionOption } from './route-guide-grid';
import { useRouteGuideGrid } from '../hooks/use-route-guide-grid';
import { RouteGuideCombobox } from './route-guide-combobox';
import { Save, Send, AlertTriangle, XCircle } from 'lucide-react';
import { createDeliveryRouteInline, createRouteVehicleInline, createRoutePersonInline } from '@/app/actions/logistica/guias-ruta';
import { getActiveCompanyId } from '@/app/actions/companies';
import type { RouteSaveDuplicateWarning, RouteDuplicateInvoice, SaveRouteGuideDraftResult } from '@/app/actions/logistica/guias-ruta';
import { syncBsaleDocumentsForRouteGuide, type DirectedBsaleSyncResult } from '@/app/actions/integraciones/bsale-sync';
import { generateRouteGuidePdfBlob, downloadRouteGuidePdf, type RouteGuidePdfOrientation } from '@/lib/pdf/generate-route-guide-pdf';
import { parseChileanMoney, isEmptyRouteGuideRow } from '../utils/route-guide-validation';
import { dedupOptions, injectCurrentOption } from '../utils/route-guide-catalogs';
import { getSaleConditions } from '@/app/actions/integraciones/sale-conditions';
import { todayInSantiago } from '@/lib/datetime';

function formatStatus(status: string) {
  if (status === 'DRAFT') return 'Borrador';
  if (status === 'DISPATCHED') return 'Despachada';
  return status;
}

function formatBsaleVerificationStatus(status: string) {
  if (status === 'NOT_FOUND') return 'Factura aún no disponible en Bsale.';
  if (status === 'INVALID_DOCUMENT') return 'La factura no está vigente o no es válida.';
  if (status === 'AMBIGUOUS') return 'Hay más de una factura vigente para este folio.';
  if (status === 'DETAILS_UNAVAILABLE') return 'No fue posible obtener el detalle de la factura.';
  if (status === 'CUSTOMER_UNAVAILABLE') return 'No fue posible identificar el cliente de la factura.';
  return 'No fue posible verificar la factura. Intenta nuevamente.';
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
  const [guideDate, setGuideDate] = useState(initialData?.guide_date || todayInSantiago());
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
  const [bsaleVerification, setBsaleVerification] = useState<DirectedBsaleSyncResult | null>(null);
  const [isVerifyingBsale, setIsVerifyingBsale] = useState(false);
  const verificationSequence = useRef(0);
  const verificationRef = useRef<{ key: string; promise: Promise<DirectedBsaleSyncResult> } | null>(null);
  const actionInProgress = useRef(false);
  const [pdfOrientation, setPdfOrientation] = useState<RouteGuidePdfOrientation>('landscape');
  const previewGuideRef = useRef<RouteGuide | null>(null);

  const grid = useRouteGuideGrid(initialData?.items || []);
  const readOnly = status === 'DISPATCHED' || status === 'CANCELLED';
  const invoiceNumbers = React.useMemo(() => [...new Set(
    grid.items
      .filter(item => !isEmptyRouteGuideRow(item))
      .map(item => String(item.invoice_number || '').trim())
      .filter(Boolean)
  )], [grid.items]);
  const invoiceSetKey = invoiceNumbers.join('|');

  const [saleConditions, setSaleConditions] = useState<SaleConditionOption[]>([]);
  useEffect(() => {
    getSaleConditions().then(setSaleConditions).catch(() => {});
  }, []);

  const routeOptions = injectCurrentOption(
    dedupOptions(catalogs?.routes || []),
    initialData?.route_id,
    initialData?.route_name_snapshot
  );
  
  const vehicleOptions = injectCurrentOption(
    dedupOptions(catalogs?.vehicles || []),
    initialData?.vehicle_id,
    initialData?.vehicle_name_snapshot
  );
  
  const driverOptions = injectCurrentOption(
    dedupOptions(catalogs?.personnel || [], 'DRIVER'),
    initialData?.driver_id,
    initialData?.driver_name_snapshot
  );
  
  const sellerOptions = injectCurrentOption(
    dedupOptions(catalogs?.personnel || [], 'SELLER'),
    initialData?.seller_id,
    initialData?.seller_name_snapshot
  );
  
  const dispatcherOptions = injectCurrentOption(
    dedupOptions(catalogs?.personnel || [], 'DISPATCHER'),
    initialData?.dispatcher_id,
    initialData?.dispatcher_name_snapshot
  );

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

  const startBsaleVerification = async (numbers: string[]) => {
    const key = numbers.join('|');
    const previous = verificationRef.current;
    if (previous?.key === key) return previous.promise;

    const sequence = ++verificationSequence.current;
    setIsVerifyingBsale(true);
    setBsaleVerification({ success: true, requested: numbers.length, ready: 0, missing: numbers.length, documents: [] });
    const promise = getActiveCompanyId()
      .then(companyId => {
        if (!companyId) throw new Error('No se encontró empresa activa para verificar las facturas.');
        return syncBsaleDocumentsForRouteGuide({
          company_id: companyId,
          invoice_numbers: numbers,
        });
      })
      .then(result => {
        if (sequence === verificationSequence.current) {
          setBsaleVerification(result);
          setIsVerifyingBsale(false);
        }
        return result;
      })
      .catch(error => {
        const result: DirectedBsaleSyncResult = {
          success: false,
          requested: numbers.length,
          ready: 0,
          missing: numbers.length,
          documents: [],
          error: error instanceof Error ? error.message : String(error),
        };
        if (sequence === verificationSequence.current) {
          setBsaleVerification(result);
          setIsVerifyingBsale(false);
        }
        return result;
      })
      .finally(() => {
        if (verificationRef.current?.key === key) verificationRef.current = null;
      });
    verificationRef.current = { key, promise };
    return promise;
  };

  useEffect(() => {
    if (guideId || readOnly) return;
    verificationSequence.current += 1;
    verificationRef.current = null;
    const timer = window.setTimeout(() => {
      const numbers = invoiceSetKey ? invoiceSetKey.split('|') : [];
      if (numbers.length === 0) {
        setBsaleVerification(null);
        setIsVerifyingBsale(false);
        return;
      }
      setBsaleVerification(null);
      void startBsaleVerification(numbers);
    }, !invoiceSetKey ? 0 : 500);
    return () => window.clearTimeout(timer);
  }, [guideId, readOnly, invoiceSetKey]);

  const handleSaveDraft = async () => {
    if (isSaving || isDispatching || actionInProgress.current) return;
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

    actionInProgress.current = true;
    try {
      setErrorMsg('');
      setDraftWarnings([]);
      setDispatchDuplicates([]);
      if (!guideId) {
        if (validItems.length === 0) throw new Error('Agrega al menos una factura antes de crear la guía.');
        const verification = await startBsaleVerification(invoiceNumbers);
        if (!verification.success || verification.ready !== verification.requested || verification.documents.some(document => document.status !== 'READY')) {
          return;
        }
      }
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
    } finally {
      setIsVerifyingBsale(false);
      actionInProgress.current = false;
    }
  };

  const verifyBeforeDispatch = async () => {
    if (invoiceNumbers.length === 0) throw new Error('La guía no contiene facturas para verificar.');
    const verification = await startBsaleVerification(invoiceNumbers);
    if (!verification.success || verification.ready !== verification.requested || verification.documents.some(document => document.status !== 'READY')) return false;
    return true;
  };

  const unknownPayments = React.useMemo(() => {
    return grid.items.filter(item => 
      item.payment_method_normalized === 'UNKNOWN' && 
      item.payment_method_original?.trim()
    );
  }, [grid.items]);

  const handleDispatch = async () => {
    if (isSaving || isDispatching || actionInProgress.current) return;
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

    actionInProgress.current = true;
    try {
      setErrorMsg('');
      setDraftWarnings([]);
      setDispatchDuplicates([]);
      if (!(await verifyBeforeDispatch())) return;
      await onDispatch(guideId);
    } catch (err: any) {
      // Render duplicates detail if available
      if (err.duplicates && err.duplicates.length > 0) {
        setDispatchDuplicates(err.duplicates);
      }
      setErrorMsg(err.message || 'Ocurrió un error al despachar');
    } finally {
      setIsVerifyingBsale(false);
      actionInProgress.current = false;
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
                     const blob = await generateRouteGuidePdfBlob(guideObj, undefined, undefined, pdfOrientation);
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
              <label className="flex items-center gap-2 text-xs font-semibold text-theme-text-muted">
                <span>Orientación</span>
                <select
                  value={pdfOrientation}
                  onChange={event => setPdfOrientation(event.target.value as RouteGuidePdfOrientation)}
                  className="rounded-lg border border-theme-border bg-theme-surface px-2 py-2.5 text-xs text-theme-text outline-none focus:border-theme-accent"
                >
                  <option value="portrait">Vertical</option>
                  <option value="landscape">Horizontal</option>
                </select>
              </label>
              <button
                type="button"
                onClick={handleSaveDraft}
                disabled={isSaving || isDispatching}
                className="flex items-center gap-2 bg-theme-accent hover:bg-theme-accent-hover disabled:bg-theme-accent/50 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg shadow-theme-accent/20"
              >
                <Save className="w-4 h-4" /> {isVerifyingBsale ? 'Verificando facturas...' : isSaving ? 'Guardando...' : (guideId ? 'Guardar Cambios' : 'Crear Guía')}
              </button>
              
              {guideId && (
                <button
                  onClick={handleDispatch}
                  disabled={isSaving || isDispatching || grid.totals.error_count > 0}
                  className="flex items-center gap-1.5 px-6 py-2.5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-lg shadow-theme-accent/20 disabled:opacity-50"
                >
                  <Send className="w-4 h-4" /> {isVerifyingBsale ? 'Verificando facturas...' : isDispatching ? 'Despachando...' : 'Confirmar Despacho'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {bsaleVerification && (
        <div className={`p-4 rounded-xl border text-xs font-medium ${bsaleVerification.ready === bsaleVerification.requested && bsaleVerification.success ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400' : 'border-orange-500/30 bg-orange-500/5 text-orange-700 dark:text-orange-300'}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-bold">{bsaleVerification.ready} de {bsaleVerification.requested} facturas verificadas.</div>
              {bsaleVerification.ready !== bsaleVerification.requested && <div className="mt-1">No fue posible verificar todas las facturas en Bsale.</div>}
            </div>
            {bsaleVerification.ready !== bsaleVerification.requested && !isVerifyingBsale && (
              <button type="button" onClick={guideId ? handleDispatch : handleSaveDraft} className="shrink-0 rounded-lg border border-current px-3 py-1.5 text-[11px] font-bold hover:bg-current/10">
                Reintentar verificación
              </button>
            )}
          </div>
          {bsaleVerification.ready !== bsaleVerification.requested && (
            <div className="mt-3 space-y-1 border-t border-current/20 pt-3">
              {bsaleVerification.documents.filter(document => document.status !== 'READY').map(document => (
                <div key={document.invoice_number}>
                  <span className="font-bold">Factura {document.invoice_number}</span>
                  <span> — {formatBsaleVerificationStatus(document.status)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
          saleConditions={saleConditions}
        />

      </div>

      {showPrintView && previewUrl && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center" onClick={() => { setShowPrintView(false); URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }}>
          <div className="relative w-[90vw] h-[90vh] bg-theme-surface rounded-2xl border border-theme-border shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-3 border-b border-theme-border bg-theme-text/5 shrink-0">
              <h2 className="text-sm font-bold text-theme-text">Vista previa — Guía de Ruta</h2>
              <div className="flex items-center gap-2">
                 <button onClick={() => { downloadRouteGuidePdf(previewGuideRef.current!, `Guia_${guideNumber || 'Borrador'}`, pdfOrientation); }} className="px-4 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-colors shadow-lg shadow-theme-accent/20">
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
