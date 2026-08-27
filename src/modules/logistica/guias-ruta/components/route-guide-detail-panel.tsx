import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RouteGuide, CatalogOptions } from '../types';
import { RouteGuideStatusBadge } from './route-guide-badges';
import { formatCurrency, formatDate, formatPaymentMethodLabel } from '../utils/route-guide-formatters';
import { RouteGuideForm } from './route-guide-form';
import { RouteGuideEditModal } from './route-guide-edit-modal';
import { Printer, Edit, Download } from 'lucide-react';
import { generateRouteGuidePdfBlob, downloadRouteGuidePdf, type RouteGuidePdfOrientation } from '@/lib/pdf/generate-route-guide-pdf';

import { getRouteGuideProfitabilityV1, type RouteSaveDuplicateWarning, type SaveRouteGuideDraftResult } from '@/app/actions/logistica/guias-ruta';
import type { RouteGuideProfitabilityV1 } from '../types';

interface RouteGuideDetailPanelProps {
  guide: RouteGuide;
  catalogOptions: CatalogOptions;
  onClose: () => void;
  onEdit?: () => void;
  onSaveDraft: (guideData: any, itemsData: any[]) => Promise<SaveRouteGuideDraftResult>;
  onDispatch: (guideId: string) => Promise<void>;
  onGuideEdited?: (guideId: string) => Promise<void> | void;
  isSaving: boolean;
  isDispatching: boolean;
}

export function RouteGuideDetailPanel({
  guide,
  catalogOptions,
  onClose,
  onEdit,
  onSaveDraft,
  onDispatch,
  onGuideEdited,
  isSaving,
  isDispatching
}: RouteGuideDetailPanelProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pdfOrientation, setPdfOrientation] = useState<RouteGuidePdfOrientation>('portrait');
  const [profitability, setProfitability] = useState<RouteGuideProfitabilityV1 | null>(null);
  const [profitabilityLoading, setProfitabilityLoading] = useState(true);
  const [profitabilityError, setProfitabilityError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getRouteGuideProfitabilityV1(guide.id)
      .then(data => {
        if (active) setProfitability(data);
      })
      .catch(error => {
        if (active) setProfitabilityError(error instanceof Error ? error.message : 'No se pudo cargar la rentabilidad V1.');
      })
      .finally(() => {
        if (active) setProfitabilityLoading(false);
      });
    return () => { active = false; };
  }, [guide.id]);



  const handlePrint = async () => {
    try {
      const blob = await generateRouteGuidePdfBlob(guide, undefined, undefined, pdfOrientation);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
    } catch (e: any) {
      console.error(e);
    }
  };

  const handleGuideSaved = async () => {
    // Cerrar el modal y recargar la guía canónica antes de mostrar nada.
    setEditModalOpen(false);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    if (!onGuideEdited) return;
    setIsRefreshing(true);
    try {
      await onGuideEdited(guide.id);
    } catch (e) {
      console.warn('No se pudo actualizar el detalle tras guardar:', e);
    } finally {
      setIsRefreshing(false);
    }
  };

  const renderPreviewModal = () => {
    if (!previewUrl || typeof document === 'undefined') return null;

    return createPortal(
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[99999] flex items-center justify-center" onClick={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }}>
        <div className="relative w-[90vw] h-[90vh] bg-theme-surface rounded-2xl border border-theme-border shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-3 border-b border-theme-border bg-theme-text/5 shrink-0">
            <h2 className="text-sm font-bold text-theme-text">Vista previa — Guía de Ruta</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => { const win = window.open(previewUrl, '_blank'); win?.print(); }} className="px-4 py-1.5 rounded-lg bg-theme-surface border border-theme-border text-theme-text hover:bg-theme-text/5 text-xs font-bold transition-colors shadow-sm flex items-center gap-1.5">
                <Printer className="w-4 h-4" /> Imprimir PDF
              </button>
               <button onClick={() => { downloadRouteGuidePdf(guide, `Guia_${guide.guide_number}`, pdfOrientation); }} className="px-4 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-colors shadow-lg shadow-theme-accent/20 flex items-center gap-1.5">
                <Download className="w-4 h-4" /> Descargar PDF
              </button>
              <button onClick={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }} className="px-4 py-1.5 rounded-lg border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-xs font-semibold transition-colors">
                Cerrar
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <iframe src={previewUrl} className="w-full h-full bg-white" title="Vista previa Guía de Ruta" />
          </div>
        </div>
      </div>,
      document.body
    );
  };

  const formatPercent = (value: number | null | undefined) => value === null || value === undefined
    ? '—'
    : `${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;

  const profitabilityStatusLabel = (status: RouteGuideProfitabilityV1['cost_status']) => {
    if (status === 'COMPLETE') return 'Cobertura 100%';
    if (status === 'PARTIAL') return `Parcial · ${formatPercent(profitability?.cost_coverage_pct)}`;
    return 'Sin costo disponible';
  };

  return (
    <div className="flex flex-col h-full bg-theme-surface text-theme-text relative">
      
      {renderPreviewModal()}

      {editModalOpen && (
        <RouteGuideEditModal
          key={guide.id}
          guide={guide}
          catalogOptions={catalogOptions}
          onClose={() => setEditModalOpen(false)}
          onSaved={handleGuideSaved}
        />
      )}

      {/* Header Actions */}
      <div className="flex justify-between items-center px-6 py-4 border-b border-theme-border print:hidden">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-bold text-theme-text">Guía {guide.guide_number}</h2>
          <RouteGuideStatusBadge status={guide.status} />
          {isRefreshing && (
            <span className="px-2 py-1 rounded-lg bg-theme-accent/10 text-theme-accent border border-theme-accent/20 text-[10px] font-bold uppercase tracking-wider animate-pulse">
              Actualizando guía…
            </span>
          )}
        </div>
         <div className="flex items-center gap-3">
           <label className="flex items-center gap-2 text-xs font-semibold text-theme-text-muted">
             <span>Orientación</span>
             <select
               value={pdfOrientation}
               onChange={event => setPdfOrientation(event.target.value as RouteGuidePdfOrientation)}
               className="rounded-lg border border-theme-border bg-theme-surface px-2 py-2 text-xs text-theme-text outline-none focus:border-theme-accent"
             >
               <option value="portrait">Vertical</option>
               <option value="landscape">Horizontal</option>
             </select>
           </label>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-theme-border rounded-lg text-theme-text hover:bg-theme-text/5 text-sm font-semibold transition-colors"
          >
            Cerrar
          </button>
          
          <button
            onClick={handlePrint}
            className="px-4 py-2 border border-theme-border rounded-lg text-theme-text hover:bg-theme-text/5 flex items-center gap-2 text-sm font-semibold transition-colors"
          >
            <Printer className="w-4 h-4" /> Imprimir
          </button>
          
          {guide.status === 'DRAFT' && (
            <button
              onClick={() => onEdit && onEdit()}
              className="px-4 py-2 bg-theme-accent text-white rounded-lg hover:bg-theme-accent-hover flex items-center gap-2 text-sm font-bold shadow-sm transition-colors"
            >
              <Edit className="w-4 h-4" /> Editar / Despachar
            </button>
          )}

          {(guide.status === 'DRAFT' || guide.status === 'DISPATCHED') && (
            <button
              onClick={() => setEditModalOpen(true)}
              title="Editar guía no rendida"
              className="px-4 py-2 border border-theme-border rounded-lg text-theme-text hover:bg-theme-text/5 flex items-center gap-2 text-sm font-semibold transition-colors"
            >
              <Edit className="w-4 h-4" /> Editar guía
            </button>
          )}
        </div>
      </div>

      {/* Detail Content (Read Only View) */}
      <div className="p-6 overflow-y-auto space-y-8 print:hidden">
        
        {/* Resumen Cabecera */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 bg-theme-surface p-6 rounded-2xl border border-theme-border shadow-sm">
          <div>
            <p className="text-[10px] text-theme-text-muted font-bold uppercase tracking-wider mb-1">Fecha</p>
            <p className="font-semibold text-theme-text text-sm">{formatDate(guide.guide_date)}</p>
          </div>
          <div>
            <p className="text-[10px] text-theme-text-muted font-bold uppercase tracking-wider mb-1">Ruta</p>
            <p className="font-semibold text-theme-text text-sm">{guide.route_name_snapshot || '-'}</p>
          </div>
          <div>
            <p className="text-[10px] text-theme-text-muted font-bold uppercase tracking-wider mb-1">Vehículo</p>
            <p className="font-semibold text-theme-text text-sm">{guide.vehicle_name_snapshot || '-'}</p>
          </div>
          <div>
            <p className="text-[10px] text-theme-text-muted font-bold uppercase tracking-wider mb-1">Conductor</p>
            <p className="font-semibold text-theme-text text-sm">{guide.driver_name_snapshot || '-'}</p>
          </div>
          <div>
            <p className="text-[10px] text-theme-text-muted font-bold uppercase tracking-wider mb-1">Vendedor</p>
            <p className="font-semibold text-theme-text text-sm">{guide.seller_name_snapshot || '-'}</p>
          </div>
          <div>
            <p className="text-[10px] text-theme-text-muted font-bold uppercase tracking-wider mb-1">Despachador (Armador)</p>
            <p className="font-semibold text-theme-text text-sm">{guide.dispatcher_name_snapshot || '-'}</p>
          </div>
          <div className="md:col-span-3">
            <p className="text-[10px] text-theme-text-muted font-bold uppercase tracking-wider mb-1">Observaciones</p>
            <p className="font-semibold text-theme-text text-sm">{guide.notes || '-'}</p>
          </div>
        </div>

        {/* Resumen Totales */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="p-4 border border-theme-border rounded-2xl bg-theme-surface">
            <p className="text-[10px] text-theme-text-muted font-bold uppercase tracking-wider">Monto Total</p>
            <p className="text-xl font-bold text-theme-accent">{formatCurrency(guide.total_amount)}</p>
            <p className="text-[10px] text-theme-text-muted/70 font-semibold mt-1">{guide.total_invoices} facturas</p>
          </div>
          <div className="p-4 border border-theme-border rounded-2xl bg-theme-surface">
            <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold uppercase tracking-wider">Total Efectivo</p>
            <p className="text-xl font-bold text-emerald-700 dark:text-emerald-500">{formatCurrency(guide.total_cash_expected)}</p>
          </div>
          <div className="p-4 border border-theme-border rounded-2xl bg-theme-surface">
            <p className="text-[10px] text-blue-600 dark:text-blue-400 font-bold uppercase tracking-wider">Total Cheques</p>
            <p className="text-xl font-bold text-blue-700 dark:text-blue-500">{formatCurrency(guide.total_check_expected)}</p>
          </div>
          <div className="p-4 border border-theme-border rounded-2xl bg-theme-surface">
            <p className="text-[10px] text-orange-600 dark:text-orange-400 font-bold uppercase tracking-wider">Total Crédito</p>
            <p className="text-xl font-bold text-orange-700 dark:text-orange-500">{formatCurrency(guide.total_credit)}</p>
          </div>
          <div className="p-4 border border-theme-border rounded-2xl bg-theme-surface">
            <p className="text-[10px] text-purple-600 dark:text-purple-400 font-bold uppercase tracking-wider">Total Transferencias</p>
            <p className="text-xl font-bold text-purple-700 dark:text-purple-500">{formatCurrency(guide.total_transfer)}</p>
          </div>
        </div>

        <section className="rounded-2xl border border-theme-border bg-theme-surface shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-theme-border">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wider text-theme-text">Rentabilidad V1</h3>
              <p className="text-[11px] text-theme-text-muted mt-1">Costo última compra y utilidad estimada</p>
            </div>
            {profitability && (
              <span className="rounded-full border border-theme-accent/20 bg-theme-accent/5 px-2 py-1 text-[10px] font-bold text-theme-accent">
                {profitabilityStatusLabel(profitability.cost_status)}
              </span>
            )}
          </div>
          <div className="p-5">
            {profitabilityLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 animate-pulse">
                {[1, 2, 3, 4, 5].map(item => <div key={item} className="h-12 rounded-lg bg-theme-text/5" />)}
              </div>
            ) : profitabilityError ? (
              <p className="text-xs text-theme-text-muted">La rentabilidad V1 no está disponible en este momento. La guía se puede consultar normalmente.</p>
            ) : profitability ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  {[
                    ['Venta neta', formatCurrency(profitability.sales_net_total)],
                    ['Costo última compra', formatCurrency(profitability.last_purchase_cost_total)],
                    ['Utilidad estimada', formatCurrency(profitability.estimated_gross_profit)],
                    ['Margen estimado', formatPercent(profitability.estimated_margin_pct)],
                    ['Cobertura de costo', formatPercent(profitability.cost_coverage_pct)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">{label}</p>
                      <p className="mt-1 text-base font-bold tabular-nums text-theme-text">{value}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-[11px] font-medium text-theme-text-muted">Margen calculado sobre las líneas con costo disponible.</p>
                {profitability.cost_status === 'PARTIAL' && (
                  <p className="mt-1 text-[11px] text-theme-text-muted">
                    {profitability.uncovered_lines} líneas sin costo · {formatCurrency(profitability.uncovered_sales_net)} de venta no incluida en el margen.
                  </p>
                )}
                <details className="mt-5 group">
                  <summary className="cursor-pointer select-none text-xs font-bold text-theme-accent hover:text-theme-accent-hover">
                    Ver líneas utilizadas ({profitability.total_lines})
                  </summary>
                  <div className="mt-3 overflow-x-auto rounded-xl border border-theme-border">
                    <table className="min-w-[920px] w-full text-[11px] text-left">
                      <thead className="bg-theme-text/[0.03] text-[10px] uppercase tracking-wider text-theme-text-muted border-b border-theme-border">
                        <tr>
                          <th className="px-3 py-2">Factura</th>
                          <th className="px-3 py-2">SKU / Producto</th>
                          <th className="px-3 py-2 text-right">Cantidad</th>
                          <th className="px-3 py-2 text-right">Venta neta</th>
                          <th className="px-3 py-2 text-right">Último costo</th>
                          <th className="px-3 py-2 text-right">Costo total</th>
                          <th className="px-3 py-2 text-right">Utilidad</th>
                          <th className="px-3 py-2 text-right">Margen</th>
                          <th className="px-3 py-2 text-center">Estado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-theme-border">
                        {profitability.lines.map((line, index) => (
                          <tr key={`${line.document}-${line.bsale_variant_id}-${index}`} className="hover:bg-theme-text/[0.02]">
                            <td className="px-3 py-2 font-mono font-semibold text-theme-accent">{line.document}</td>
                            <td className="px-3 py-2 max-w-[230px]">
                              <p className="font-semibold text-theme-text">{line.sku || 'Sin SKU'}</p>
                              <p className="truncate text-theme-text-muted">{line.product_name || 'Producto desconocido'}</p>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-theme-text">{line.quantity}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-theme-text">{formatCurrency(line.net_sales)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-theme-text">{line.last_purchase_unit_cost === null ? 'Sin costo' : formatCurrency(line.last_purchase_unit_cost)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-theme-text">{line.line_cost === null ? 'Sin costo' : formatCurrency(line.line_cost)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-theme-text">{line.estimated_profit === null ? '—' : formatCurrency(line.estimated_profit)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-theme-text">{formatPercent(line.estimated_margin_pct)}</td>
                            <td className="px-3 py-2 text-center">
                              <span className="rounded-full border border-theme-border px-2 py-0.5 font-semibold text-theme-text-muted">
                                {line.cost_status === 'COSTED' ? 'Con costo' : 'Sin costo'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : null}
          </div>
        </section>

        {/* Detalle Items (Read Only) */}
        <div>
          <h3 className="text-sm font-bold mb-4 text-theme-text flex items-center gap-1.5 uppercase tracking-wider">Detalle de Facturas</h3>
          <div className="border border-theme-border rounded-2xl overflow-hidden bg-theme-surface shadow-sm">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="bg-theme-text/[0.03] text-theme-text-muted font-bold text-[10px] uppercase tracking-wider border-b border-theme-border">
                <tr>
                  <th className="px-4 py-3 w-12 text-center">#</th>
                  <th className="px-4 py-3 w-32">Factura</th>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3 w-40">Comuna</th>
                  <th className="px-4 py-3 w-32 text-right">Monto</th>
                  <th className="px-4 py-3 w-40 text-center">Forma de Pago</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-theme-border">
                {guide.items && guide.items.length > 0 ? (
                  guide.items.map((item, idx) => (
                    <tr key={idx} className="hover:bg-theme-text/[0.02] transition-colors">
                      <td className="px-4 py-2.5 text-center text-theme-text-muted font-bold">{item.line_number}</td>
                      <td className="px-4 py-2.5 font-mono font-semibold text-theme-accent">{item.invoice_number}</td>
                      <td className="px-4 py-2.5 font-medium text-theme-text">{item.customer_name}</td>
                      <td className="px-4 py-2.5 text-theme-text">{item.commune}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-theme-text">{formatCurrency(item.amount)}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className="bg-theme-text/[0.05] text-theme-text px-2 py-0.5 rounded text-[10px] font-bold border border-theme-border/50">
                          {formatPaymentMethodLabel(item.payment_method_normalized, item.payment_method_original)}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-theme-text-muted/70 font-medium">
                      No hay ítems cargados
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
