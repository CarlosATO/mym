import * as XLSX from 'xlsx'
import type { PurchaseOrderDocumentDetail } from '@/app/actions/adquisiciones/purchase-orders'
import { buildPurchaseOrderFileNameBase } from '@/lib/adquisiciones/purchase-order-file-name'

function formatSource(source: PurchaseOrderDocumentDetail['document_source']) {
  return source === 'CONFIRMED' ? 'Versión confirmada' : 'Actual'
}

export function generatePurchaseOrderExcel(detail: PurchaseOrderDocumentDetail) {
  const { po } = detail
  const summary = [
    ['Orden de compra', po.correlative],
    ['Estado actual', po.status],
    ['Proveedor', po.supplier_name],
    ['RUT proveedor', po.supplier_rut || ''],
    ['Fecha emisión', po.issue_date],
    ['Fecha requerida', po.required_date || ''],
    ['Bodega', po.warehouse_name || ''],
    ['Moneda', po.currency],
    ['Condición de pago', po.payment_terms || ''],
    ['Solicitante', po.requester_name],
    ['Autorizado por', po.authorized_name || ''],
    ['Observaciones', po.notes || ''],
    ['Neto', po.net_total],
    ['Descuentos', po.discount_total],
    ['IVA', po.tax_total],
    ['Total', po.grand_total],
    ['Fuente documental', formatSource(detail.document_source)],
  ]
  const detailRows = detail.items.map(item => [
    item.line_number,
    item.sku || '',
    item.product_description,
    item.unit || '',
    item.quantity,
    item.unit_price,
    item.discount_percent,
    item.discount_amount,
    item.tax_rate,
    item.tax_amount,
    item.line_total,
  ])

  const workbook = XLSX.utils.book_new()
  const summarySheet = XLSX.utils.aoa_to_sheet(summary)
  const detailSheet = XLSX.utils.aoa_to_sheet([
    ['Línea', 'SKU', 'Descripción', 'Unidad', 'Cantidad', 'Precio unitario', 'Descuento %', 'Descuento $', 'IVA %', 'IVA $', 'Total línea'],
    ...detailRows,
  ])

  summarySheet['!cols'] = [{ wch: 24 }, { wch: 34 }]
  detailSheet['!cols'] = [
    { wch: 9 }, { wch: 18 }, { wch: 40 }, { wch: 14 }, { wch: 12 },
    { wch: 16 }, { wch: 13 }, { wch: 15 }, { wch: 9 }, { wch: 12 }, { wch: 15 },
  ]
  detailSheet['!freeze'] = { xSplit: 0, ySplit: 1 }

  for (const sheet of [summarySheet, detailSheet]) {
    for (const cellAddress of Object.keys(sheet)) {
      if (cellAddress.startsWith('!')) continue
      const cell = sheet[cellAddress] as XLSX.CellObject
      if (typeof cell.v === 'number') cell.z = '#,##0.00'
    }
  }

  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Resumen')
  XLSX.utils.book_append_sheet(workbook, detailSheet, 'Detalle')
  XLSX.writeFile(workbook, `${buildPurchaseOrderFileNameBase(po.supplier_name, po.correlative)}.xlsx`)
}
