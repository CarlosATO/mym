import { PaymentMethodNormalized } from '../types';

export interface PaymentNormalizationResult {
  normalized: PaymentMethodNormalized;
  label: string;
  requiresSettlement: boolean;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  warning?: string;
}

export function normalizePaymentText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,]/g, '') // remove irrelevant punctuation
    .replace(/\s+/g, ' '); // collapse spaces
}

export function normalizePaymentMethodAdvanced(rawMethod: string | null | undefined): PaymentNormalizationResult {
  const normalized = normalizePaymentText(rawMethod);
  
  if (!normalized) {
    return {
      normalized: 'UNKNOWN',
      label: 'No reconocido',
      requiresSettlement: false,
      warning: 'No se ingresó forma de pago'
    };
  }

  // CASH
  if (
    normalized === 'al dia' || 
    normalized === 'aldia' || 
    normalized === 'efectivo' || 
    normalized === 'contado' || 
    normalized === 'cash'
  ) {
    return { normalized: 'CASH', label: 'Efectivo', requiresSettlement: true, confidence: 'HIGH' };
  }
  
  // CHECK
  if (
    normalized === 'cheque' || 
    normalized === 'chq' || 
    normalized === 'cheq' ||
    normalized === 'documento cheque'
  ) {
    return { normalized: 'CHECK', label: 'Cheque', requiresSettlement: true, confidence: 'HIGH' };
  }

  // TRANSFER
  if (
    normalized === 'transferencia' ||
    normalized === 'transferencia bancaria' ||
    normalized === 'transfer' ||
    normalized === 'trans bancaria' ||
    normalized === 'trans banc' ||
    normalized === 'transf' ||
    normalized === 'transf bancaria' ||
    normalized === 'transfer banc' ||
    normalized === 'deposito' ||
    normalized === 'dep bancario'
  ) {
    return { normalized: 'TRANSFER', label: 'Transferencia', requiresSettlement: false, confidence: 'HIGH' };
  }

  // CREDIT
  if (
    normalized === 'credito' ||
    normalized === 'credito 12 dias' ||
    normalized === 'cred 12' ||
    normalized === 'a credito' ||
    normalized === 'cta cte'
  ) {
    return { normalized: 'CREDIT', label: 'Crédito', requiresSettlement: false, confidence: 'HIGH' };
  }

  // Desconocido
  return {
    normalized: 'UNKNOWN',
    label: 'No reconocido',
    requiresSettlement: false,
    confidence: 'LOW',
    warning: `Forma de pago no reconocida: '${rawMethod}'`
  };
}

export function normalizePaymentMethod(rawMethod: string | null | undefined): PaymentMethodNormalized {
  return normalizePaymentMethodAdvanced(rawMethod).normalized;
}

export function requiresSettlement(method: PaymentMethodNormalized): boolean {
  return method === 'CASH' || method === 'CHECK';
}

export function formatPaymentMethodLabel(value: PaymentMethodNormalized, originalValue?: string): string {
  if (value === 'CASH') return 'Efectivo';
  if (value === 'CHECK') return 'Cheque';
  if (value === 'TRANSFER') return 'Transferencia';
  if (value === 'CREDIT') return 'Crédito';
  
  return originalValue || 'No reconocido';
}

export function getPaymentMethodHelp(): string[] {
  return [
    'Efectivo: "Al día", "Efectivo", "Contado"',
    'Cheque: "Cheque", "Chq"',
    'Transferencia: "Transferencia bancaria", "Transferencia", "Trans bancaria", "Transf"',
    'Crédito: "Crédito", "Crédito 12 días"'
  ];
}
