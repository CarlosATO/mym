import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { RouteGuide, CatalogOptions } from '../types';
import { RouteGuideStatusBadge } from './route-guide-badges';
import { formatCurrency, formatDate, formatPaymentMethodLabel } from '../utils/route-guide-formatters';
import { RouteGuideForm } from './route-guide-form';
import { Printer, Edit, Download } from 'lucide-react';
import { generateRouteGuidePdfBlob, downloadRouteGuidePdf } from '@/lib/pdf/generate-route-guide-pdf';

import type { RouteSaveDuplicateWarning, SaveRouteGuideDraftResult } from '@/app/actions/logistica/guias-ruta';

interface RouteGuideDetailPanelProps {
  guide: RouteGuide;
  catalogOptions: CatalogOptions;
  onClose: () => void;
  onEdit?: () => void;
  onSaveDraft: (guideData: any, itemsData: any[]) => Promise<SaveRouteGuideDraftResult>;
  onDispatch: (guideId: string) => Promise<void>;
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
  isSaving,
  isDispatching
}: RouteGuideDetailPanelProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);



  const handlePrint = async () => {
    try {
      const blob = await generateRouteGuidePdfBlob(guide);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
    } catch (e: any) {
      console.error(e);
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
              <button onClick={() => { downloadRouteGuidePdf(guide, `Guia_${guide.guide_number}`); }} className="px-4 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-colors shadow-lg shadow-theme-accent/20 flex items-center gap-1.5">
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

  return (
    <div className="flex flex-col h-full bg-theme-surface text-theme-text relative">
      
      {renderPreviewModal()}

      {/* Header Actions */}
      <div className="flex justify-between items-center px-6 py-4 border-b border-theme-border print:hidden">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-bold text-theme-text">Guía {guide.guide_number}</h2>
          <RouteGuideStatusBadge status={guide.status} />
        </div>
        <div className="flex gap-3">
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
