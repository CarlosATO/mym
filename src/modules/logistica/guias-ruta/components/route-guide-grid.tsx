import React, { useRef, useEffect } from 'react';
import { RouteGuideItem } from '../types';
import { formatCurrency } from '../utils/route-guide-formatters';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SaleConditionOption {
  id: string;
  bsale_id: number;
  name: string;
  normalized: 'CASH' | 'CHECK' | 'TRANSFER' | 'CREDIT' | 'UNKNOWN';
  label: string;
}

interface RouteGuideGridProps {
  items: RouteGuideItem[];
  totals: any;
  onCellChange: (rowIndex: number, columnId: any, value: string) => void;
  onPaste: (e: React.ClipboardEvent, startRow: number, startColKey: any) => void;
  onRemoveRow: (index: number) => void;
  onClearGrid: () => void;
  readOnly?: boolean;
  saleConditions?: SaleConditionOption[];
}

export function RouteGuideGrid({
  items,
  totals,
  onCellChange,
  onPaste,
  onRemoveRow,
  onClearGrid,
  readOnly = false,
  saleConditions = []
}: RouteGuideGridProps) {
  const tableRef = useRef<HTMLTableElement>(null);

  // Helper para navegar con flechas — respeta la posición del cursor dentro del texto
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, rowIndex: number, colIndex: number) => {
    if (readOnly) return;

    const input = e.currentTarget;
    const { selectionStart, selectionEnd, value } = input;

    // Tab always moves to next cell
    if (e.key === 'Tab') {
      e.preventDefault();
      const form = tableRef.current;
      if (!form) return;
      const inputs = Array.from(form.querySelectorAll('input:not([disabled])')) as HTMLInputElement[];
      const colsCount = 7;
      const currentIndex = rowIndex * colsCount + colIndex;
      const nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;
      if (nextIndex >= 0 && nextIndex < inputs.length) {
        inputs[nextIndex].focus();
      }
      return;
    }

    // Enter moves down
    if (e.key === 'Enter') {
      e.preventDefault();
      const form = tableRef.current;
      if (!form) return;
      const inputs = Array.from(form.querySelectorAll('input:not([disabled])')) as HTMLInputElement[];
      const colsCount = 7;
      const currentIndex = rowIndex * colsCount + colIndex;
      const nextIndex = currentIndex + colsCount;
      if (nextIndex < inputs.length) {
        inputs[nextIndex].focus();
      }
      return;
    }

    // ArrowUp / ArrowDown always navigate between rows
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const form = tableRef.current;
      if (!form) return;
      const inputs = Array.from(form.querySelectorAll('input:not([disabled])')) as HTMLInputElement[];
      const colsCount = 7;
      const currentIndex = rowIndex * colsCount + colIndex;
      const nextIndex = e.key === 'ArrowDown' ? currentIndex + colsCount : currentIndex - colsCount;
      if (nextIndex >= 0 && nextIndex < inputs.length) {
        inputs[nextIndex].focus();
      }
      return;
    }

    // ArrowLeft: only navigate to previous cell if cursor is at position 0 with no selection
    if (e.key === 'ArrowLeft') {
      if (selectionStart === 0 && selectionEnd === 0) {
        e.preventDefault();
        const form = tableRef.current;
        if (!form) return;
        const inputs = Array.from(form.querySelectorAll('input:not([disabled])')) as HTMLInputElement[];
        const colsCount = 7;
        const currentIndex = rowIndex * colsCount + colIndex;
        const nextIndex = currentIndex - 1;
        if (nextIndex >= 0) {
          const target = inputs[nextIndex];
          target.focus();
          // Move cursor to end of previous cell
          const len = target.value.length;
          target.setSelectionRange(len, len);
        }
      }
      // else: let browser handle cursor movement within text
      return;
    }

    // ArrowRight: only navigate to next cell if cursor is at the end with no selection
    if (e.key === 'ArrowRight') {
      if (selectionStart === value.length && selectionEnd === value.length) {
        e.preventDefault();
        const form = tableRef.current;
        if (!form) return;
        const inputs = Array.from(form.querySelectorAll('input:not([disabled])')) as HTMLInputElement[];
        const colsCount = 7;
        const currentIndex = rowIndex * colsCount + colIndex;
        const nextIndex = currentIndex + 1;
        if (nextIndex < inputs.length) {
          const target = inputs[nextIndex];
          target.focus();
          target.setSelectionRange(0, 0);
        }
      }
      // else: let browser handle cursor movement within text
      return;
    }
  };


  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-theme-border/60 pb-2">
        <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider flex items-center gap-1.5">Detalle de Facturas</h3>
        {!readOnly && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClearGrid}
              className="text-[10px] text-red-500 hover:text-red-600 font-bold"
            >
              Limpiar Grilla
            </button>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-theme-border bg-theme-surface shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table ref={tableRef} className="w-full text-xs text-left border-collapse whitespace-nowrap min-w-max">
            <thead>
              <tr className="border-b border-theme-border bg-theme-text/[0.03] text-theme-text-muted font-bold text-[10px] uppercase tracking-wider">
              <th className="px-3 py-3 w-12 text-center">#</th>
              <th className="px-3 py-3 w-[110px]">Factura</th>
              <th className="px-3 py-3 w-[240px]">Cliente</th>
              <th className="px-3 py-3 min-w-[380px]">Dirección</th>
              <th className="px-3 py-3 w-[160px]">Comuna</th>
              <th className="px-3 py-3 w-[130px] text-right">Monto</th>
              <th className="px-3 py-3 w-[180px]">Forma de Pago</th>
              <th className="px-3 py-3 w-[180px]">Obs.</th>
              {!readOnly && <th className="px-3 py-3 w-12 text-center"></th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => {
              const isInvalid = item.validation_status === 'INVALID';
              const hasData = item.invoice_number || item.customer_name || item.amount || item.payment_method_original;
              const rowClass = isInvalid && hasData ? 'bg-red-500/[0.02] hover:bg-red-500/[0.04]' : 'bg-theme-text/[0.02] hover:bg-theme-text/[0.04]';
              
              return (
                <tr key={idx} className={`border-b border-theme-border transition-colors font-medium last:border-b-0 group ${rowClass}`}>
                  <td className="px-3 py-2 text-center text-theme-text-muted/70 font-bold">{idx + 1}</td>
                  
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      className={`w-full h-8 px-2 rounded-lg border border-transparent focus:border-theme-accent/50 focus:ring-1 focus:ring-theme-accent/30 bg-transparent text-xs text-theme-text placeholder:text-theme-text-muted/50 ${isInvalid && !item.invoice_number && hasData ? 'border-red-500/50 bg-red-500/5' : ''}`}
                      value={item.invoice_number}
                      onChange={(e) => onCellChange(idx, 'invoice_number', e.target.value)}
                      onPaste={(e) => onPaste(e, idx, 'invoice_number')}
                      onKeyDown={(e) => handleKeyDown(e, idx, 0)}
                      disabled={readOnly}
                      placeholder="N° Fact."
                    />
                  </td>
                  
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      className={`w-full h-8 px-2 rounded-lg border border-transparent focus:border-theme-accent/50 focus:ring-1 focus:ring-theme-accent/30 bg-transparent text-xs text-theme-text placeholder:text-theme-text-muted/50 ${isInvalid && !item.customer_name && hasData ? 'border-red-500/50 bg-red-500/5' : ''}`}
                      value={item.customer_name}
                      onChange={(e) => onCellChange(idx, 'customer_name', e.target.value)}
                      onPaste={(e) => onPaste(e, idx, 'customer_name')}
                      onKeyDown={(e) => handleKeyDown(e, idx, 1)}
                      disabled={readOnly}
                      placeholder="Nombre Cliente"
                    />
                  </td>

                  <td className="px-1 py-1">
                    <input
                      type="text"
                      className={`w-full h-8 px-2 rounded-lg border border-transparent focus:border-theme-accent/50 focus:ring-1 focus:ring-theme-accent/30 bg-transparent text-xs text-theme-text placeholder:text-theme-text-muted/50 ${isInvalid && !item.customer_address && hasData ? 'border-red-500/50 bg-red-500/5' : ''}`}
                      value={item.customer_address}
                      onChange={(e) => onCellChange(idx, 'customer_address', e.target.value)}
                      onPaste={(e) => onPaste(e, idx, 'customer_address')}
                      onKeyDown={(e) => handleKeyDown(e, idx, 2)}
                      disabled={readOnly}
                      placeholder="Dirección"
                    />
                  </td>

                  <td className="px-1 py-1">
                    <input
                      type="text"
                      className={`w-full h-8 px-2 rounded-lg border border-transparent focus:border-theme-accent/50 focus:ring-1 focus:ring-theme-accent/30 bg-transparent text-xs text-theme-text placeholder:text-theme-text-muted/50 ${isInvalid && !item.commune && hasData ? 'border-red-500/50 bg-red-500/5' : ''}`}
                      value={item.commune}
                      onChange={(e) => onCellChange(idx, 'commune', e.target.value)}
                      onPaste={(e) => onPaste(e, idx, 'commune')}
                      onKeyDown={(e) => handleKeyDown(e, idx, 3)}
                      disabled={readOnly}
                      placeholder="Comuna"
                    />
                  </td>

                  <td className="px-1 py-1">
                    <input
                      type="text"
                      className={`w-full h-8 px-2 text-right rounded-lg border border-transparent focus:border-theme-accent/50 focus:ring-1 focus:ring-theme-accent/30 bg-transparent text-xs text-theme-text placeholder:text-theme-text-muted/50 font-semibold ${isInvalid && (!item.amount || item.amount === '0') && hasData ? 'border-red-500/50 bg-red-500/5' : ''}`}
                      value={readOnly ? formatCurrency(item.amount) : item.amount}
                      onChange={(e) => onCellChange(idx, 'amount', e.target.value)}
                      onPaste={(e) => onPaste(e, idx, 'amount')}
                      onKeyDown={(e) => handleKeyDown(e, idx, 4)}
                      disabled={readOnly}
                      placeholder="0"
                    />
                  </td>

                  <td className="px-1 py-1 relative group">
                    {saleConditions.length > 0 && !readOnly ? (
                      <select
                        className={cn(
                          "w-full h-8 px-2 rounded-lg border border-transparent focus:border-theme-accent/50 focus:ring-1 focus:ring-theme-accent/30 bg-transparent text-xs text-theme-text appearance-none cursor-pointer",
                          !item.payment_method_original ? "text-theme-text-muted/50" : "",
                          isInvalid && !item.payment_method_original && hasData ? "border-red-500/50 bg-red-500/5" : "",
                          item.payment_method_normalized === 'UNKNOWN' && item.payment_method_original?.trim() ? "border-orange-500/50 bg-orange-500/5" : ""
                        )}
                        value={item.payment_method_original}
                        onChange={(e) => onCellChange(idx, 'payment_method_original', e.target.value)}
                        disabled={readOnly}
                      >
                        <option value="">Seleccionar...</option>
                        {saleConditions.map((sc) => (
                          <option key={sc.id} value={sc.name}>{sc.label}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="relative">
                        <input
                          type="text"
                          className={cn(
                            "w-full h-8 px-2 rounded-lg border border-transparent focus:border-theme-accent/50 focus:ring-1 focus:ring-theme-accent/30 bg-transparent text-xs text-theme-text placeholder:text-theme-text-muted/50",
                            isInvalid && !item.payment_method_original && hasData ? "border-red-500/50 bg-red-500/5" : "",
                            item.payment_method_normalized === 'UNKNOWN' && item.payment_method_original?.trim() ? "border-orange-500/50 bg-orange-500/5 pr-6" : ""
                          )}
                          value={item.payment_method_original}
                          onChange={(e) => onCellChange(idx, 'payment_method_original', e.target.value)}
                          onPaste={(e) => onPaste(e, idx, 'payment_method_original')}
                          onKeyDown={(e) => handleKeyDown(e, idx, 5)}
                          disabled={readOnly || saleConditions.length > 0}
                          placeholder="Efectivo/Cheque..."
                        />
                        {item.payment_method_normalized === 'UNKNOWN' && item.payment_method_original?.trim() && (
                          <div 
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-orange-500 cursor-help"
                            title="Forma de pago no reconocida. Será guardada como advertencia, pero debe corregirse para despachar."
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </div>
                        )}
                      </div>
                    )}
                  </td>

                  <td className="px-1 py-1">
                    <input
                      type="text"
                      className="w-full h-8 px-2 rounded-lg border border-transparent focus:border-theme-accent/50 focus:ring-1 focus:ring-theme-accent/30 bg-transparent text-xs text-theme-text placeholder:text-theme-text-muted/50"
                      value={item.notes || ''}
                      onChange={(e) => onCellChange(idx, 'notes', e.target.value)}
                      onPaste={(e) => onPaste(e, idx, 'notes')}
                      onKeyDown={(e) => handleKeyDown(e, idx, 6)}
                      disabled={readOnly}
                      placeholder="..."
                    />
                  </td>

                  {!readOnly && (
                    <td className="px-2 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => onRemoveRow(idx)}
                        className="text-theme-text-muted/70 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Eliminar fila"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>

      {/* Panel de Totales y Errores */}
      <div className="p-5 rounded-2xl border border-theme-border bg-theme-surface/50 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
        <div className="space-y-1">
          <p className="text-theme-text-muted font-bold uppercase tracking-wider text-[10px]">Total Facturas Válidas</p>
          <p className="text-xl font-bold text-theme-text">{totals.total_invoices}</p>
        </div>
        <div className="space-y-1">
          <p className="text-theme-text-muted font-bold uppercase tracking-wider text-[10px]">Monto Total</p>
          <p className="text-xl font-bold text-theme-accent">{formatCurrency(totals.total_amount)}</p>
        </div>
        
        <div className="space-y-1 md:col-span-2 grid grid-cols-2 gap-2 text-[11px]">
          <div className="flex justify-between border-b border-theme-border/60 pb-1">
            <span className="text-theme-text-muted font-bold uppercase">Efectivo:</span>
            <span className="font-bold text-emerald-600 dark:text-emerald-400">{formatCurrency(totals.total_cash_expected)}</span>
          </div>
          <div className="flex justify-between border-b border-theme-border/60 pb-1">
            <span className="text-theme-text-muted font-bold uppercase">Cheque:</span>
            <span className="font-bold text-blue-600 dark:text-blue-400">{formatCurrency(totals.total_check_expected)}</span>
          </div>
          <div className="flex justify-between border-b border-theme-border/60 pb-1">
            <span className="text-theme-text-muted font-bold uppercase">Crédito:</span>
            <span className="font-bold text-orange-600 dark:text-orange-400">{formatCurrency(totals.total_credit)}</span>
          </div>
          <div className="flex justify-between border-b border-theme-border/60 pb-1">
            <span className="text-theme-text-muted font-bold uppercase">Transf.:</span>
            <span className="font-bold text-purple-600 dark:text-purple-400">{formatCurrency(totals.total_transfer)}</span>
          </div>
        </div>

        {(totals.error_count > 0 || totals.duplicate_count > 0 || totals.total_unknown_payment > 0) && (
          <div className="md:col-span-4 bg-red-500/5 text-red-600 dark:text-red-400 p-3 rounded-xl space-y-1 border border-red-500/20 mt-2 font-medium">
            <p className="font-bold text-[11px] uppercase tracking-wider mb-2 text-red-700 dark:text-red-500">Problemas detectados:</p>
            {totals.error_count > 0 && <p className="text-[11px]">• Hay {totals.error_count} fila(s) con errores o incompletas.</p>}
            {totals.duplicate_count > 0 && <p className="text-[11px]">• Hay {totals.duplicate_count} factura(s) duplicada(s).</p>}
            {totals.total_unknown_payment > 0 && <p className="text-[11px]">• Hay formas de pago no reconocidas que suman {formatCurrency(totals.total_unknown_payment)}.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
