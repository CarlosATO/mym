import type { InternalSaleEmployee, InternalSaleProduct } from "@/app/actions/logistica/mermas";
import { formatCivilDate } from "@/lib/datetime";

export type InternalSalePrintLine = {
  product: InternalSaleProduct;
  quantity: number;
  unitPrice: number;
};
export type InternalSalePrintDraft = {
  employee: InternalSaleEmployee;
  lines: InternalSalePrintLine[];
  total: number;
  generatedAt: string;
};

export const MAX_INTERNAL_SALE_PRINT_LINES = 6;

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

export function buildInternalSalePrintHtml(draft: InternalSalePrintDraft) {
  const density = draft.lines.length <= 3 ? "normal" : draft.lines.length <= 5 ? "compact" : "extra-compact";
  const rows = draft.lines.map(({ product, quantity, unitPrice }) => `
    <tr>
      <td class="sku">${escapeHtml(product.sku)}</td>
      <td><span class="product-name">${escapeHtml(product.product_name)}</span><span class="expiry-info">Próximo vencimiento elegible: ${escapeHtml(formatCivilDate(product.next_eligible_expiration))}</span></td>
      <td class="number">${quantity}</td>
       <td class="number">${money.format(unitPrice)}</td>
       <td class="number strong">${money.format(Math.round(unitPrice * quantity))}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Autorización de compra interna de Mermas</title><style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 210mm; height: 297mm; overflow: hidden; background: #fff; }
  body { color: #18252d; font-family: Arial, Helvetica, sans-serif; font-size: 10pt; line-height: 1.25; }
  .print-root, .print-sheet { width: 210mm; height: 297mm; overflow: hidden; }
  .print-sheet { position: relative; }
  .print-content { position: absolute; top: 10mm; left: 10mm; width: 190mm; margin: 0; padding: 10mm; transform-origin: top left; }
  .print-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8mm; padding-bottom: 5mm; border-bottom: 2px solid #173b4d; }
  .brand { color: #173b4d; font-size: 11pt; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
  h1 { max-width: 115mm; margin: 3mm 0 0; color: #173b4d; font-family: Georgia, "Times New Roman", serif; font-size: 23pt; line-height: 1.05; text-transform: uppercase; }
  .status { min-width: 38mm; padding: 3mm; border: 2px solid #b87928; color: #8b5b1c; text-align: center; }
  .status-label { font-size: 8pt; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .status-date { margin-top: 2mm; color: #18252d; font-size: 9pt; font-weight: 600; }
  .worker-card { margin-top: 7mm; border: 1px solid #9aaeb8; break-inside: avoid; page-break-inside: avoid; }
  .section-title { padding: 2mm 4mm; border-bottom: 1px solid #9aaeb8; background: #edf3f5; color: #173b4d; font-size: 8pt; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
  .worker-grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2mm 8mm; padding: 4mm; }
  .worker-grid p { margin: 0; }
  .worker-grid p:first-child { white-space: nowrap; }
  .worker-grid p:last-child { grid-column: 1 / -1; }
  .detail { margin-top: 7mm; break-inside: avoid; page-break-inside: avoid; }
  .detail-heading { margin: 0 0 3mm; color: #173b4d; font-size: 8pt; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; }
  th { padding: 2mm; border-top: 2px solid #173b4d; border-bottom: 1px solid #9aaeb8; background: #edf3f5; color: #173b4d; font-size: 8pt; text-align: left; text-transform: uppercase; }
  td { padding: 3mm 2mm; border-bottom: 1px solid #d7e0e4; vertical-align: top; }
  th.number, td.number { text-align: right; }
  td.sku { width: 20%; font-family: "Courier New", monospace; font-size: 8.5pt; }
  td.number { width: 16%; white-space: nowrap; }
  .product-name, .expiry-info { display: block; }
  .product-name { font-weight: 700; }
  .expiry-info { margin-top: 1mm; color: #596a72; font-size: 8pt; }
  .strong { font-weight: 700; }
  tfoot { break-inside: avoid; page-break-inside: avoid; }
  .total-label, .total-value { padding: 4mm 2mm; border-top: 2px solid #173b4d; font-size: 12pt; font-weight: 800; text-transform: uppercase; }
  .total-label { text-align: right; }
  .total-value { color: #173b4d; text-align: right; white-space: nowrap; }
  .declaration-box { margin-top: 7mm; padding: 4mm; border-left: 4px solid #b87928; background: #faf7f0; break-inside: avoid; page-break-inside: avoid; }
  .declaration-box p { margin: 0 0 2mm; font-size: 9pt; }
  .declaration-box p:last-child { margin-bottom: 0; }
  .signatures-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16mm; margin-top: 15mm; break-inside: avoid; page-break-inside: avoid; }
  .signature-block h2 { margin: 0 0 4mm; color: #173b4d; font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; }
  .signature-block p { margin: 0 0 3mm; padding-bottom: 1mm; border-bottom: 1px solid #18252d; font-size: 9pt; }
  .signature-line { margin-top: 13mm; padding-top: 2mm; border-top: 1px solid #18252d; text-align: center; font-size: 9pt; font-weight: 700; }
  .final-date { margin-top: 10mm; padding-top: 3mm; border-top: 1px solid #9aaeb8; color: #596a72; font-size: 8pt; text-align: center; }
  .internal-sale-print-compact { font-size: 9.5pt; }
  .internal-sale-print-compact .worker-card, .internal-sale-print-compact .detail, .internal-sale-print-compact .declaration-box { margin-top: 5mm; }
  .internal-sale-print-compact .signatures-grid { margin-top: 10mm; }
  .internal-sale-print-extra-compact { font-size: 9pt; }
  .internal-sale-print-extra-compact .worker-card, .internal-sale-print-extra-compact .detail, .internal-sale-print-extra-compact .declaration-box { margin-top: 4mm; }
  .internal-sale-print-extra-compact td { padding-top: 2mm; padding-bottom: 2mm; }
  .internal-sale-print-extra-compact .signatures-grid { margin-top: 7mm; }
  .internal-sale-print-extra-compact .signature-line { margin-top: 9mm; }
  @media print { .print-content { transform-origin: top left; } }
</style></head><body><main class="print-root"><div class="print-sheet"><article class="print-content internal-sale-print-${density}">
  <header class="print-header"><div><div class="brand">MYM / Petgroup</div><h1>Autorización de compra interna de Mermas</h1></div><div class="status"><div class="status-label">Documento previo</div><div class="status-date">Fecha: ${escapeHtml(formatDate(draft.generatedAt))}</div></div></header>
  <section class="worker-card"><div class="section-title">Datos del trabajador</div><div class="worker-grid"><p><strong>Nombre completo:</strong> ${escapeHtml(draft.employee.display_name)}</p><p><strong>RUT:</strong> ${escapeHtml(draft.employee.rut)}</p><p><strong>Cargo / Área:</strong> ${escapeHtml(draft.employee.cargo || "—")}</p></div></section>
  <section class="detail"><h2 class="detail-heading">Detalle de compra</h2><table><thead><tr><th>SKU</th><th>Producto</th><th class="number">Cantidad</th><th class="number">Precio unitario</th><th class="number">Subtotal</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="4" class="total-label">Total a pagar</td><td class="total-value">${money.format(draft.total)}</td></tr></tfoot></table></section>
  <section class="declaration-box"><p>“Declaro que he sido informado(a) de que los productos detallados en este documento corresponden a una venta interna de productos provenientes de Mermas de la empresa.</p><p>Declaro conocer y aceptar la condición informada de los productos al momento de la compra, incluyendo su fecha de vencimiento cuando corresponda.</p><p>Asimismo, manifiesto mi voluntad de adquirir los productos detallados por el monto total señalado en este documento.”</p></section>
  <section class="signatures-grid"><div class="signature-block"><h2>Trabajador comprador</h2><p>Nombre: ${escapeHtml(draft.employee.display_name)}</p><p>RUT: ${escapeHtml(draft.employee.rut)}</p><div class="signature-line">Firma</div></div><div class="signature-block"><h2>Responsable de entrega</h2><p>Nombre:</p><p>Cargo:</p><div class="signature-line">Firma</div></div></section>
  <p class="final-date">Fecha: ____ / ____ / ______</p>
</article></div></main></body></html>`;
}
