import { RouteGuideItem } from '../types';
import { normalizePaymentMethod } from './payment-normalizer';

export function parseChileanMoney(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return raw;
  if (!raw) return 0;
  
  // Soporte para: 12500, 12.500, $12.500, 12,500, " $26.629 "
  const cleaned = String(raw).replace(/[^\d]/g, '');
  const parsed = parseInt(cleaned, 10);
  return isNaN(parsed) ? 0 : parsed;
}

export function isEmptyRouteGuideRow(item: Partial<RouteGuideItem>): boolean {
  return !item.invoice_number && 
         !item.customer_name && 
         !item.customer_address && 
         !item.commune && 
         !item.amount && 
         !item.payment_method_original && 
         !item.notes;
}

export function ensureTrailingEmptyRow(items: RouteGuideItem[]): RouteGuideItem[] {
  const result = [...items];
  
  // Remove trailing empty rows
  while (result.length > 0 && isEmptyRouteGuideRow(result[result.length - 1])) {
    result.pop();
  }
  
  // Add one empty row
  result.push({
    line_number: result.length + 1,
    invoice_number: '',
    customer_name: '',
    customer_address: '',
    commune: '',
    amount: '',
    payment_method_original: '',
    payment_method_normalized: 'UNKNOWN',
    requires_settlement: false,
    validation_status: 'VALID',
    validation_errors: [],
    notes: ''
  });
  
  // Fix line numbers
  return result.map((item, idx) => ({ ...item, line_number: idx + 1 }));
}

export function validateRouteGuideGrid(items: Partial<RouteGuideItem>[]): RouteGuideItem[] {
  const start = performance.now();
  
  const validatedItems: RouteGuideItem[] = [];
  const invoiceSet = new Set<string>();

  items.forEach((item, index) => {
    if (isEmptyRouteGuideRow(item)) {
      validatedItems.push({
        line_number: index + 1,
        invoice_number: '',
        customer_name: '',
        customer_address: '',
        commune: '',
        amount: '',
        payment_method_original: '',
        payment_method_normalized: 'UNKNOWN',
        requires_settlement: false,
        validation_status: 'VALID',
        validation_errors: [],
        notes: ''
      });
      return;
    }

    const errors: string[] = [];
    
    // Factura
    if (!item.invoice_number || item.invoice_number.trim() === '') {
      errors.push('Factura obligatoria');
    } else {
      if (invoiceSet.has(item.invoice_number)) {
        errors.push('Factura duplicada en la grilla');
      }
      invoiceSet.add(item.invoice_number);
    }

    // Cliente
    if (!item.customer_name || item.customer_name.trim() === '') {
      errors.push('Cliente obligatorio');
    }

    // Dirección
    if (!item.customer_address || item.customer_address.trim() === '') {
      errors.push('Dirección obligatoria');
    }

    // Comuna
    if (!item.commune || item.commune.trim() === '') {
      errors.push('Comuna obligatoria');
    }

    // Monto
    const parsedAmount = parseChileanMoney(item.amount);
    if (parsedAmount <= 0) {
      errors.push('Monto inválido');
    }

    // Forma de Pago
    if (!item.payment_method_original || item.payment_method_original.trim() === '') {
      errors.push('Forma de pago obligatoria');
    }
    
    const normalizedPayment = normalizePaymentMethod(item.payment_method_original);
    if (normalizedPayment === 'UNKNOWN' && item.payment_method_original) {
      errors.push('Forma de pago no reconocida');
    }

    validatedItems.push({
      line_number: index + 1,
      invoice_number: item.invoice_number || '',
      customer_name: item.customer_name || '',
      customer_address: item.customer_address || '',
      commune: item.commune || '',
      amount: item.amount || '', // Guardamos el valor crudo original en UI
      payment_method_original: item.payment_method_original || '',
      payment_method_normalized: normalizedPayment,
      requires_settlement: normalizedPayment === 'CASH' || normalizedPayment === 'CHECK',
      validation_status: errors.length > 0 ? 'INVALID' : 'VALID',
      validation_errors: errors,
      notes: item.notes || '',
    });
  });

  if (process.env.NODE_ENV === 'development') {
    console.log('validateRouteGuideGrid', Math.round(performance.now() - start), 'ms');
  }
  return validatedItems;
}
