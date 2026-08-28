import type { RouteGuide, RouteGuideItem, RouteGuideProfitabilityV1 } from '../types';

export interface RouteGuideWhatsAppImages {
  detail: Blob;
}

interface InvoiceSummary {
  profit: number;
  netSales: number;
}

const colors = {
  ink: '#172033',
  muted: '#5d687c',
  accent: '#0f766e',
  accentLight: '#dff5ef',
  border: '#dbe3e8',
  surface: '#ffffff',
  soft: '#f4f7f8',
  warning: '#9a5b08',
  warningLight: '#fff3d9',
};

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shorten(value: unknown, length: number): string {
  const text = String(value ?? '').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function currency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}%`;
}

function date(value: string): string {
  const [year, month, day] = value.split('T')[0].split('-');
  return year && month && day ? `${day}-${month}-${year}` : value;
}

function condition(item: RouteGuideItem): string {
  if (item.payment_method_normalized === 'TRANSFER') return 'Transferencia';
  const original = item.payment_method_original?.trim();
  if (original && !['CASH', 'AL_DIA', 'CHECK', 'TRANSFER', 'CREDIT', 'UNKNOWN'].includes(original.toUpperCase())) return original;
  return ({
    AL_DIA: 'Al día',
    CASH: 'Efectivo',
    CHECK: 'Cheque',
    TRANSFER: 'Transferencia bancaria',
    CREDIT: 'Crédito',
    UNKNOWN: original || 'No especificada',
  } as Record<string, string>)[item.payment_method_normalized] || original || 'No especificada';
}

function invoiceSummaries(profitability: RouteGuideProfitabilityV1): Map<string, InvoiceSummary> {
  const result = new Map<string, InvoiceSummary>();
  for (const line of profitability.lines) {
    const current = result.get(line.document) || { profit: 0, netSales: 0 };
    if (line.estimated_profit !== null) current.profit += line.estimated_profit;
    current.netSales += line.net_sales;
    result.set(line.document, current);
  }
  return result;
}

function text(x: number, y: number, value: unknown, size: number, weight = 400, fill = colors.ink, anchor = 'start'): string {
  return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}px" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function shell(width: number, height: number, content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${colors.soft}"/>${content}</svg>`;
}

function detailSvg(guide: RouteGuide, profitability: RouteGuideProfitabilityV1): string {
  const profits = invoiceSummaries(profitability);
  const rows = (guide.items || []).map((item, index) => {
    const row = profits.get(item.invoice_number) || { profit: 0, netSales: 0 };
    const gainPercent = row.netSales > 0 ? row.profit / row.netSales * 100 : null;
    const y = 285 + index * 62;
    const fill = index % 2 === 0 ? colors.surface : colors.soft;
    return [
      `<rect x="40" y="${y - 35}" width="1520" height="62" fill="${fill}"/>`,
      text(62, y, shorten(item.invoice_number, 12), 17, 700, colors.accent),
      text(190, y, shorten(item.customer_name, 30), 16, 600),
      text(520, y, shorten(item.customer_address, 28), 15, 400, colors.muted),
      text(820, y, shorten(item.commune, 18), 15, 400, colors.muted),
      text(1025, y, currency(Number(item.amount)), 16, 700, colors.ink, 'end'),
      text(1225, y, currency(row.profit), 16, 700, colors.ink, 'end'),
      text(1375, y, percent(gainPercent), 16, 700, colors.ink, 'end'),
      text(1535, y, shorten(condition(item), 20), 15, 600, colors.ink, 'end'),
    ].join('');
  }).join('');
  const rowsHeight = Math.max((guide.items || []).length, 1) * 62;
  const metrics = [
    ['DOCUMENTOS', guide.total_invoices],
    ['TOTAL GUÍA', currency(guide.total_amount)],
    ['VENTA NETA', currency(profitability.sales_net_total)],
    ['COSTO', currency(profitability.last_purchase_cost_total)],
    ['UTILIDAD ESTIMADA', currency(profitability.estimated_gross_profit)],
    ['MARGEN ESTIMADO', percent(profitability.estimated_margin_pct)],
  ];
  const metricMarkup = metrics.map(([label, value], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 850 + column * 230;
    const y = 48 + row * 68;
    return [
      `<rect x="${x}" y="${y}" width="212" height="54" rx="12" fill="${colors.accentLight}"/>`,
      text(x + 14, y + 19, label, 10, 700, colors.accent),
      text(x + 14, y + 41, value, 17, 700, colors.ink),
    ].join('');
  }).join('');
  const height = 285 + rowsHeight + 30;
  return shell(1600, height, [
    '<rect x="40" y="32" width="1520" height="165" rx="22" fill="white" stroke="#dbe3e8"/>',
    text(72, 72, `GUÍA ${shorten(guide.guide_number, 28)}`, 25, 700),
    text(72, 108, `${date(guide.guide_date)}  ·  ${shorten(guide.route_name_snapshot, 72)}`, 17, 400, colors.muted),
    text(72, 140, 'RESUMEN DE LA GUÍA', 12, 700, colors.accent),
    text(72, 164, 'Detalle operativo y rentabilidad estimada', 14, 400, colors.muted),
    metricMarkup,
    '<rect x="40" y="215" width="1520" height="40" rx="10" fill="#dff5ef"/>',
    text(62, 241, 'FACTURA', 13, 700, colors.accent),
    text(190, 241, 'CLIENTE', 13, 700, colors.accent),
    text(520, 241, 'DIRECCIÓN', 13, 700, colors.accent),
    text(820, 241, 'CIUDAD / COMUNA', 13, 700, colors.accent),
    text(1025, 241, 'MONTO', 13, 700, colors.accent, 'end'),
    text(1225, 241, 'UTILIDAD', 13, 700, colors.accent, 'end'),
    text(1375, 241, 'GANANCIA %', 13, 700, colors.accent, 'end'),
    text(1535, 241, 'CONDICIÓN', 13, 700, colors.accent, 'end'),
    rows,
    `<rect x="40" y="${height - 34}" width="1520" height="2" fill="${colors.border}"/>`,
  ].join(''));
}

async function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = source;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('No se pudo preparar la imagen'));
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('El navegador no permite preparar imágenes');
    context.scale(2, 2);
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo exportar la imagen')), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(source);
  }
}

export async function createRouteGuideWhatsAppImages(
  guide: RouteGuide,
  profitability: RouteGuideProfitabilityV1,
): Promise<RouteGuideWhatsAppImages> {
  const detailHeight = Math.max(190 + Math.max((guide.items || []).length, 1) * 62 + 32 + 190, 520);
  return {
    detail: await svgToPng(detailSvg(guide, profitability), 1600, detailHeight),
  };
}
