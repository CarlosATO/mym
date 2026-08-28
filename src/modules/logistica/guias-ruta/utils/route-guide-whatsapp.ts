import type { RouteGuide, RouteGuideItem, RouteGuideProfitabilityV1 } from '../types';

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;
}

function formatDate(value: string): string {
  const [year, month, day] = value.split('T')[0].split('-');
  return year && month && day ? `${day}-${month}-${year}` : value;
}

function formatPaymentCondition(item: RouteGuideItem): string {
  const original = item.payment_method_original?.trim();
  const normalized = item.payment_method_normalized;
  const technicalValues = new Set(['CASH', 'AL_DIA', 'CHECK', 'TRANSFER', 'CREDIT', 'UNKNOWN']);
  if (original && !technicalValues.has(original.toUpperCase())) return original;

  return {
    AL_DIA: 'Al día',
    CASH: 'Efectivo',
    CHECK: 'Cheque',
    TRANSFER: 'Transferencia bancaria',
    CREDIT: 'Crédito',
    UNKNOWN: original || 'Condición no especificada',
  }[normalized] || original || 'Condición no especificada';
}

function invoiceProfitability(profitability: RouteGuideProfitabilityV1) {
  const byInvoice = new Map<string, { profit: number; netSales: number }>();
  for (const line of profitability.lines) {
    const current = byInvoice.get(line.document) || { profit: 0, netSales: 0 };
    if (line.estimated_profit !== null) current.profit += line.estimated_profit;
    current.netSales += line.net_sales;
    byInvoice.set(line.document, current);
  }
  return byInvoice;
}

export function buildRouteGuideWhatsAppSummary(
  guide: RouteGuide,
  profitability: RouteGuideProfitabilityV1,
): string {
  const profits = invoiceProfitability(profitability);
  const lines = (guide.items || []).map(item => {
    const invoice = profits.get(item.invoice_number) || { profit: 0, netSales: 0 };
    const gain = invoice.netSales > 0 ? invoice.profit / invoice.netSales * 100 : null;
    const address = [item.customer_address, item.commune].filter(Boolean).join(' - ');
    return `${item.invoice_number} | ${item.customer_name} | ${address} | ${formatCurrency(Number(item.amount))} | Utilidad ${formatCurrency(invoice.profit)} | Ganancia ${formatPercent(gain)} | ${formatPaymentCondition(item)}`;
  });

  const summary = [
    '',
    'RESUMEN',
    `Documentos: ${guide.total_invoices}`,
    `Total guía: ${formatCurrency(guide.total_amount)}`,
    `Venta neta: ${formatCurrency(profitability.sales_net_total)}`,
    `Costo: ${formatCurrency(profitability.last_purchase_cost_total)}`,
    `Utilidad estimada: ${formatCurrency(profitability.estimated_gross_profit)}`,
    `Margen estimado: ${formatPercent(profitability.estimated_margin_pct)}`,
  ];

  return [
    `GUÍA DE RUTA ${guide.guide_number}`,
    `Fecha: ${formatDate(guide.guide_date)}`,
    `Ruta: ${guide.route_name_snapshot}`,
    '',
    ...lines,
    ...summary,
  ].join('\n');
}

export async function copyRouteGuideWhatsAppSummary(
  clipboard: Pick<Clipboard, 'writeText'>,
  guide: RouteGuide,
  profitability: RouteGuideProfitabilityV1,
): Promise<string> {
  const text = buildRouteGuideWhatsAppSummary(guide, profitability);
  await clipboard.writeText(text);
  return text;
}
