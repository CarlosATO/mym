export function formatCurrency(amount: number | string | undefined | null): string {
  if (amount === undefined || amount === null) return '';
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return '';
  
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(num);
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat('es-CL', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch {
    return dateStr;
  }
}

export function formatRouteGuideLineAmount(amount: string | number | undefined | null): string {
  if (amount === undefined || amount === null || amount === '') return '—';
  
  if (typeof amount === 'number') {
    if (isNaN(amount)) return '—';
    return formatCurrency(amount);
  }
  
  const cleanStr = amount.replace(/[^\d]/g, '');
  if (!cleanStr) return '—';
  
  const parsed = parseInt(cleanStr, 10);
  if (isNaN(parsed)) return '—';
  
  return formatCurrency(parsed);
}

export function formatPaymentMethodLabel(normalizedValue?: string, originalValue?: string): string {
  if (!normalizedValue) return originalValue || 'No reconocido';
  
  const v = normalizedValue.toUpperCase();
  if (v === 'CASH') return 'Efectivo';
  if (v === 'CHECK') return 'Cheque';
  if (v === 'CREDIT') return 'Crédito';
  if (v === 'TRANSFER') return 'Transferencia';
  if (v === 'UNKNOWN') return originalValue || 'No reconocido';
  
  return originalValue || 'No reconocido';
}
