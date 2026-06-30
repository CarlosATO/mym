'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { getRouteGuides, getRouteGuideCatalogOptions, saveRouteGuideDraft, dispatchRouteGuideAction, deleteRouteGuideDraftAction, RouteSaveDuplicateWarning, RouteDuplicateInvoice } from '@/app/actions/logistica/guias-ruta';
import { RouteGuidesTrayTable } from './components/route-guides-tray-table';
import { RouteGuidesTraySkeleton } from './components/route-guide-skeletons';
import { RouteGuideForm } from './components/route-guide-form';
import { RouteGuideDetailPanel } from './components/route-guide-detail-panel';
import { useRouteGuideDetailCache } from './hooks/use-route-guide-detail-cache';
import { Plus } from 'lucide-react';
import { CatalogOptions } from './types';
import { toast } from 'sonner';

// Shapes passed back to the form via re-throw (success path with warnings)
export type { RouteSaveDuplicateWarning, RouteDuplicateInvoice };

export function RouteGuidesPanel() {
  const [guides, setGuides] = useState<any[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogOptions | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'DRAFT' | 'DISPATCHED'>('ALL');
  
  const [activeView, setActiveView] = useState<'TRAY' | 'NEW' | 'EDIT' | 'DETAIL'>('TRAY');
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [formSessionId, setFormSessionId] = useState<string>('');

  // Operations State
  const [isSaving, setIsSaving] = useState(false);
  const [isDispatching, setIsDispatching] = useState(false);

  const { cache, loadingIds, error, fetchDetail, invalidateCache } = useRouteGuideDetailCache();

  const loadTray = useCallback(async () => {
    const start = performance.now();
    try {
      const data = await getRouteGuides({ status: filterStatus });
      setGuides(data || []);
    } catch (e: any) {
      toast.error('Error cargando guías de ruta: ' + e.message);
    } finally {
      if (process.env.NODE_ENV === 'development') {
        console.log('loadRouteGuides', Math.round(performance.now() - start), 'ms');
      }
    }
  }, []);

  const loadCatalogs = useCallback(async () => {
    try {
      const data = await getRouteGuideCatalogOptions();
      setCatalogs(data);
    } catch (e: any) {
      toast.error('Error cargando catálogos: ' + e.message);
    }
  }, []);

  useEffect(() => {
    Promise.all([loadTray(), loadCatalogs()]).finally(() => setIsLoading(false));
  }, [loadTray, loadCatalogs, filterStatus]);

  const handleOpenNew = () => {
    setActiveView('NEW');
    setSelectedGuideId(null);
    setFormSessionId(`new-${Date.now()}`);
  };

  const handleOpenDetail = async (id: string) => {
    setActiveView('DETAIL');
    setSelectedGuideId(id);
    try {
      await fetchDetail(id);
    } catch (err) {
      console.warn('Error al abrir detalle (capturado en UI):', err);
      // El error ya fue seteado en el hook (setError), así que la UI mostrará el panel rojo
    }
  };

  const handleCloseDetail = () => {
    setActiveView('TRAY');
    setSelectedGuideId(null);
  };

  const handleEdit = () => {
    setActiveView('EDIT');
    setFormSessionId(`edit-${selectedGuideId}`);
  };

  const handleSaveDraft = async (guideData: any, itemsData: any[]) => {
    if (isSaving || isDispatching) throw new Error('Operación en progreso');
    setIsSaving(true);
    try {
      // --- BLOCK 1: The actual save (must not swallow errors) ---
      const res = await saveRouteGuideDraft(selectedGuideId, guideData, itemsData);

      // Promote new guide state immediately after successful save
      if (!selectedGuideId) {
        setSelectedGuideId(res.id);
        setActiveView('EDIT');
      }

      toast.success(selectedGuideId ? 'Borrador actualizado' : `Borrador creado (${res.guide_number})`);

      // --- BLOCK 2: Refresh tray only (do not force detail load) ---
      loadTray().catch(err => {
        console.warn('Error en loadTray posterior a guardar:', err);
        // It's non-critical, we don't disrupt the user's form
      });

      // Return full response so the form can render warnings and update its local headers
      return res;
    } catch (e: any) {
      // Re-throw so the form can display the save error panel
      throw e;
    } finally {
      setIsSaving(false);
    }
  };

  const handleDispatch = async (guideId: string): Promise<void> => {
    if (isSaving || isDispatching) return;
    setIsDispatching(true);
    try {
      // --- BLOCK 1: The actual dispatch (must not swallow errors) ---
      await dispatchRouteGuideAction(guideId);
      toast.success('Guía despachada correctamente');

      // --- BLOCK 2: Refresh data (non-critical) ---
      try {
        invalidateCache(guideId);
        await loadTray();
        handleCloseDetail(); // Return cleanly to the tray
      } catch (err) {
        // Even if refresh fails, dispatch was successful — just return to tray
        console.warn('Error refrescando bandeja tras despachar:', err);
        handleCloseDetail();
      }
    } catch (e: any) {
      // Re-throw so the form can display the dispatch error panel (with duplicates)
      throw e;
    } finally {
      setIsDispatching(false);
    }
  };

  const handleDeleteDraft = async (guideId: string, guideNumber: string) => {
    if (!window.confirm(`¿Eliminar borrador ${guideNumber}?\nEsta acción eliminará la guía y sus facturas.\nEl correlativo no se reutilizará.`)) {
      return;
    }
    
    try {
      await deleteRouteGuideDraftAction(guideId);
      toast.success('Borrador eliminado correctamente');
      
      if (selectedGuideId === guideId) {
        handleCloseDetail();
      }
      
      await loadTray();
    } catch (e: any) {
      toast.error('Error eliminando borrador: ' + e.message);
    }
  };

  if (isLoading || !catalogs) {
    return (
      <div className="p-6">
        <RouteGuidesTraySkeleton />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-6rem)] overflow-hidden bg-theme-surface relative">
      
      {/* Bandeja Principal (siempre de fondo excepto en NEW o EDIT) */}
      <div className={`flex-1 p-6 overflow-y-auto ${
        (activeView === 'NEW' || activeView === 'EDIT') ? 'hidden' : 
        activeView === 'DETAIL' ? 'hidden md:block md:pr-96 lg:pr-[800px]' : ''
      }`}>
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-theme-text">Guías de Ruta</h1>
            <p className="text-theme-text-muted">Gestión y control de despachos en ruta.</p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
              className="px-3 py-2 rounded-xl border border-theme-border bg-theme-surface text-xs font-semibold text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30"
            >
              <option value="ALL">Todas las guías</option>
              <option value="DRAFT">Solo Borradores</option>
              <option value="DISPATCHED">Solo Despachadas</option>
            </select>
            <button
              onClick={handleOpenNew}
              className="flex items-center gap-2 bg-theme-accent hover:bg-theme-accent-hover text-white px-4 py-2 rounded-xl text-xs font-bold shadow-lg shadow-theme-accent/20 transition-all"
            >
              <Plus className="w-5 h-5" />
              Nueva Guía
            </button>
          </div>
        </div>

        <RouteGuidesTrayTable 
          guides={guides} 
          onSelectGuide={handleOpenDetail} 
          onDeleteGuide={handleDeleteDraft}
        />
      </div>

      {/* Vista de Creación o Edición (Full Screen) */}
      {(activeView === 'NEW' || activeView === 'EDIT') && (
        <div className="flex-1 overflow-y-auto bg-theme-surface w-full h-full relative">
          
          {/* Non-blocking loading overlay during background refresh */}
          {activeView === 'EDIT' && selectedGuideId && loadingIds.has(selectedGuideId) && (
            <div className="absolute top-4 right-4 z-50 pointer-events-none">
              <span className="px-3 py-1.5 bg-theme-accent/10 text-theme-accent border border-theme-accent/20 rounded-lg shadow-sm font-bold text-[10px] uppercase tracking-wider animate-pulse">
                Sincronizando...
              </span>
            </div>
          )}

          <RouteGuideForm 
            key={formSessionId}
            initialData={activeView === 'EDIT' && selectedGuideId && cache[selectedGuideId] ? cache[selectedGuideId] : undefined}
            catalogOptions={catalogs}
            onSaveDraft={handleSaveDraft}
            onDispatch={handleDispatch}
            onCancel={handleCloseDetail}
            isSaving={isSaving}
            isDispatching={isDispatching}
          />
        </div>
      )}

      {/* Panel Lateral (Solo para Detalle) */}
      {activeView === 'DETAIL' && (
        <div className="absolute inset-y-0 right-0 w-full md:w-[800px] bg-theme-surface text-theme-text shadow-2xl border-l border-theme-border flex flex-col z-10 transition-transform duration-300">
          
          {selectedGuideId && (
            <>
              {loadingIds.has(selectedGuideId) ? (
                <div className="p-12 text-center text-theme-text-muted">Cargando detalle...</div>
              ) : cache[selectedGuideId] ? (
                <RouteGuideDetailPanel 
                  guide={cache[selectedGuideId]}
                  catalogOptions={catalogs}
                  onClose={handleCloseDetail}
                  onEdit={handleEdit}
                  onSaveDraft={handleSaveDraft}
                  onDispatch={handleDispatch}
                  isSaving={isSaving}
                  isDispatching={isDispatching}
                />
              ) : (
                <div className="p-12 text-center text-red-500 flex flex-col items-center justify-center">
                  <h3 className="text-xl font-bold mb-4">Error: No se pudo cargar la guía.</h3>
                  <div className="bg-red-50 text-red-900 p-4 rounded text-left text-sm w-full max-w-md break-all">
                    <p><strong>ID consultado:</strong> {selectedGuideId}</p>
                    {error && (
                      <div className="mt-2">
                        <p><strong>Causa del error:</strong></p>
                        <pre className="mt-1 whitespace-pre-wrap">{error.message || JSON.stringify(error)}</pre>
                      </div>
                    )}
                    <div className="mt-2 text-xs">
                      <p><strong>Keys en caché:</strong> {Object.keys(cache).join(', ') || 'Vacio'}</p>
                      <p><strong>¿Está cargando?:</strong> {loadingIds.has(selectedGuideId) ? 'Sí' : 'No'}</p>
                    </div>
                  </div>
                  <button 
                    onClick={handleCloseDetail}
                    className="mt-6 px-4 py-2 bg-theme-surface border border-theme-border rounded-lg text-theme-text hover:bg-theme-text/5"
                  >
                    Volver a la bandeja
                  </button>
                </div>
              )}
            </>
          )}

        </div>
      )}

      {/* Backdrop en mobile para Detalle */}
      {activeView === 'DETAIL' && (
        <div 
          className="fixed inset-0 bg-black/20 z-0 md:hidden"
          onClick={handleCloseDetail}
        />
      )}

    </div>
  );
}
