import * as XLSX from 'xlsx'
import type { PurchaseOrderDocumentDetail } from '@/app/actions/adquisiciones/purchase-orders'
import { buildPurchaseOrderFileNameBase } from '@/lib/adquisiciones/purchase-order-file-name'
import { documentLineValues } from '@/lib/adquisiciones/purchase-order-document'

function formatSource(source: PurchaseOrderDocumentDetail['document_source']) {
  return source === 'CONFIRMED' ? 'Versión confirmada' : source === 'ORIGINAL_SENT' ? 'Original enviada' : 'Actual persistida'
}

export function buildPurchaseOrderWorkbook(detail: PurchaseOrderDocumentDetail) {
  const { po } = detail
  const commercial = po.commercial_managed || detail.items.some(item => item.purchase_unit_factor_snapshot != null)
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
    ['Bruto', Math.round((Number(po.net_total) + Number(po.discount_total)) * 100) / 100],
    ['Neto', po.net_total],
    ['Descuentos', po.discount_total],
    ['IVA', po.tax_total],
    ['Total', po.grand_total],
    ['Fuente documental', formatSource(detail.document_source)],
  ]
  const detailRows = detail.items.map(item => {
    const line = documentLineValues(item)
    return [
    item.line_number,
    item.sku || '',
    item.product_description,
    item.unit || '',
    item.quantity,
    item.unit_price,
    line.factor === null ? (commercial && item.item_type !== 'SERVICE' ? 'Pendiente' : '') : line.commercialUnit,
    line.factor,
    line.commercialQuantity,
    line.commercialPrice,
    line.gross,
    item.discount_percent,
    item.discount_amount,
    line.net,
    item.tax_rate,
    item.tax_amount,
    item.line_total,
  ] })

  const workbook = XLSX.utils.book_new()
  const summarySheet = XLSX.utils.aoa_to_sheet(summary)
  const detailSheet = XLSX.utils.aoa_to_sheet([
    ['Línea', 'SKU', 'Descripción', 'Unidad interna', 'Cantidad interna', 'Precio interno', 'Presentación compra', 'Factor', 'Cantidad comercial', 'Precio comercial', 'Bruto', 'Descuento %', 'Descuento $', 'Neto', 'IVA %', 'IVA $', 'Total línea'],
    ...detailRows,
  ])

  summarySheet['!cols'] = [{ wch: 24 }, { wch: 34 }]
  detailSheet['!cols'] = [
    { wch: 9 }, { wch: 18 }, { wch: 40 }, { wch: 16 }, { wch: 17 },
    { wch: 16 }, { wch: 22 }, { wch: 10 }, { wch: 19 }, { wch: 18 },
    { wch: 18 }, { wch: 13 }, { wch: 16 }, { wch: 18 }, { wch: 9 }, { wch: 16 }, { wch: 18 },
  ]
  detailSheet['!freeze'] = { xSplit: 0, ySplit: 1 }

  for (const sheet of [summarySheet, detailSheet]) {
    for (const cellAddress of Object.keys(sheet)) {
      if (cellAddress.startsWith('!')) continue
      const cell = sheet[cellAddress] as XLSX.CellObject
      if (typeof cell.v === 'number') cell.z = '#,##0.00'
    }
  }
  for (let row = 2; row <= detailRows.length + 1; row++) {
    for (const column of ['E', 'F', 'I', 'J']) {
      const cell = detailSheet[`${column}${row}`] as XLSX.CellObject | undefined
      if (cell && typeof cell.v === 'number') cell.z = '#,##0.00##'
    }
    for (const column of ['A', 'H']) {
      const cell = detailSheet[`${column}${row}`] as XLSX.CellObject | undefined
      if (cell && typeof cell.v === 'number') cell.z = '0'
    }
  }

  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Resumen')
  XLSX.utils.book_append_sheet(workbook, detailSheet, 'Detalle')
  return workbook
}

export function generatePurchaseOrderExcel(detail: PurchaseOrderDocumentDetail) {
  const { po } = detail
  const workbook = buildPurchaseOrderWorkbook(detail)
  XLSX.writeFile(workbook, `${buildPurchaseOrderFileNameBase(po.supplier_name, po.correlative)}${detail.document_source === 'ORIGINAL_SENT' ? '_Original_Enviada' : ''}.xlsx`)
}
