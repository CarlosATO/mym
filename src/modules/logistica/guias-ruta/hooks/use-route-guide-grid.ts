import { useState, useCallback, useMemo } from 'react';
import { RouteGuideItem } from '../types';
import { validateRouteGuideGrid, parseChileanMoney, ensureTrailingEmptyRow, isEmptyRouteGuideRow } from '../utils/route-guide-validation';

// Columnas en el orden exacto en que se presentan en la UI/Grilla para poder mapear el pegado
const GRID_COLUMNS = [
  'invoice_number',
  'customer_name',
  'customer_address',
  'commune',
  'amount',
  'payment_method_original',
  'notes'
] as const;

type GridColumnKey = typeof GRID_COLUMNS[number];

export function useRouteGuideGrid(initialItems: RouteGuideItem[] = []) {
  const [items, setItems] = useState<RouteGuideItem[]>(() => {
    let initial = initialItems.length > 0 ? initialItems : [];
    // Ensure always trailing row
    return ensureTrailingEmptyRow(validateRouteGuideGrid(initial));
  });

  function createEmptyItem(): Partial<RouteGuideItem> {
    return {
      invoice_number: '',
      customer_name: '',
      customer_address: '',
      commune: '',
      amount: '',
      payment_method_original: '',
      notes: ''
    };
  }

  const handleCellChange = useCallback((rowIndex: number, columnId: GridColumnKey, value: string) => {
    setItems(prevItems => {
      const newItems = [...prevItems];
      newItems[rowIndex] = {
        ...newItems[rowIndex],
        [columnId]: value
      };
      
      return ensureTrailingEmptyRow(validateRouteGuideGrid(newItems));
    });
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent, startRow: number, startColKey: GridColumnKey) => {
    e.preventDefault();
    const start = performance.now();

    const clipboardData = e.clipboardData.getData('text/plain');
    if (!clipboardData) return;

    // Parsear tabuladores y saltos de línea
    const rows = clipboardData.split(/\r?\n/);
    const startColIndex = GRID_COLUMNS.indexOf(startColKey);

    if (startColIndex === -1) return;

    setItems(prevItems => {
      const newItems = [...prevItems];
      let hasMutated = false;

      for (let r = 0; r < rows.length; r++) {
        const rowData = rows[r];
        if (rowData.trim() === '' && r === rows.length - 1) continue; // ignorar última fila vacía a veces copiada de excel

        const cells = rowData.split('\t');
        const targetRow = startRow + r;

        // Si excedemos el tamaño actual, crear nueva fila
        if (targetRow >= newItems.length) {
          newItems.push(createEmptyItem() as RouteGuideItem);
        }

        const currentItem = { ...newItems[targetRow] };

        // Mapear por posición de celda
        for (let c = 0; c < cells.length; c++) {
          const targetColIndex = startColIndex + c;
          
          if (targetColIndex < GRID_COLUMNS.length) {
            const colKey = GRID_COLUMNS[targetColIndex];
            currentItem[colKey] = cells[c].trim();
            hasMutated = true;
          }
        }
        
        newItems[targetRow] = currentItem as RouteGuideItem;
      }

      if (process.env.NODE_ENV === 'development') {
        console.log('pasteRouteGuideGrid', Math.round(performance.now() - start), 'ms');
      }
      return ensureTrailingEmptyRow(validateRouteGuideGrid(newItems));
    });
  }, []);

  const addRow = useCallback(() => {
    setItems(prev => {
      // Si el botón se presiona y la última ya estaba vacía, el ensureTrailingEmptyRow la borraría.
      // Así que bypass para permitir forzar la adición si el usuario realmente insiste (aunque va contra la regla pura, es UX normal).
      const validated = validateRouteGuideGrid([...prev, createEmptyItem() as RouteGuideItem]);
      // Pero el usuario pidió estrictamente: "Si hay múltiples filas vacías al final, dejar solo una."
      return ensureTrailingEmptyRow(validated);
    });
  }, []);

  const removeRow = useCallback((indexToRemove: number) => {
    setItems(prev => {
      const newItems = prev.filter((_, idx) => idx !== indexToRemove);
      return ensureTrailingEmptyRow(validateRouteGuideGrid(newItems));
    });
  }, []);

  const clearGrid = useCallback(() => {
    setItems(ensureTrailingEmptyRow(validateRouteGuideGrid([])));
  }, []);

  // Calcular totales en vivo
  const totals = useMemo(() => {
    let totalInvoices = 0;
    let totalAmount = 0;
    let totalCash = 0;
    let totalCheck = 0;
    let totalCredit = 0;
    let totalTransfer = 0;
    let totalUnknown = 0;
    let errorCount = 0;
    let duplicateCount = 0;

    items.forEach(item => {
      const hasData = item.invoice_number || item.customer_name || item.amount || item.payment_method_original;
      if (!hasData) return; // Skip completely empty lines

      if (item.validation_status === 'INVALID') {
        errorCount++;
      }
      
      if (item.validation_errors.includes('Factura duplicada en la grilla')) {
        duplicateCount++;
      }

      // Sólo sumamos si el item es válido o al menos si tiene un invoice (podríamos decidir sumar todo lo que tiene monto)
      const amount = parseChileanMoney(item.amount);
      
      if (item.invoice_number && amount > 0) {
        totalInvoices++;
        totalAmount += amount;
        
        switch (item.payment_method_normalized) {
          case 'CASH': totalCash += amount; break;
          case 'CHECK': totalCheck += amount; break;
          case 'CREDIT': totalCredit += amount; break;
          case 'TRANSFER': totalTransfer += amount; break;
          case 'UNKNOWN': totalUnknown += amount; break;
        }
      }
    });

    return {
      total_invoices: totalInvoices,
      total_amount: totalAmount,
      total_cash_expected: totalCash,
      total_check_expected: totalCheck,
      total_credit: totalCredit,
      total_transfer: totalTransfer,
      total_unknown_payment: totalUnknown,
      error_count: errorCount,
      duplicate_count: duplicateCount
    };
  }, [items]);

  return {
    items,
    totals,
    handleCellChange,
    handlePaste,
    addRow,
    removeRow,
    clearGrid,
    setItems
  };
}
