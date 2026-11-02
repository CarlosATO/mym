import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { PendingPurchaseOrdersReport, PendingPurchaseOrderReportLine } from '@/app/actions/adquisiciones/purchase-orders'
import { formatCivilDate, formatInstantInSantiago } from '@/lib/datetime'

const NAVY: [number, number, number] = [30, 58, 95]
const BURGUNDY: [number, number, number] = [114, 56, 61]
const TEXT: [number, number, number] = [50, 45, 41]
const MUTED: [number, number, number] = [109, 98, 91]
const BORDER: [number, number, number] = [226, 221, 212]
const LIGHT: [number, number, number] = [250, 247, 244]
const PENDING: [number, number, number] = [247, 235, 220]
const WHITE: [number, number, number] = [255, 255, 255]

const REPORT_NOTE = 'Este informe presenta órdenes de compra pendientes de recepción a la fecha de generación. No constituye confirmación de disponibilidad ni fecha de entrega.'

function quantity(value: number): string {
  return value.toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    EMITIDA: 'Emitida',
    APROBADA: 'Aprobada',
    ENVIADA_PROVEEDOR: 'Enviada al proveedor',
    CONFIRMADA: 'Confirmada',
    RECEPCION_PARCIAL: 'Recepción parcial',
    FACTURADA_PARCIAL: 'Facturada parcial',
    FACTURADA_TOTAL: 'Facturada total',
  }
  return labels[status] ?? status
}

function addLogo(doc: jsPDF, logoBase64?: string): void {
  if (!logoBase64) return
  try {
    const format = logoBase64.startsWith('data:image/jpeg') || logoBase64.startsWith('data:image/jpg') ? 'JPEG' : 'PNG'
    doc.addImage(logoBase64, format, 15, 6, 24, 15)
  } catch {
    // The report remains valid when the optional logo cannot be decoded.
  }
}

function drawFooter(doc: jsPDF, page: number, totalPages: number): void {
  const width = doc.internal.pageSize.getWidth()
  const height = doc.internal.pageSize.getHeight()
  doc.setDrawColor(...BORDER)
  doc.setLineWidth(0.3)
  doc.line(15, height - 16, width - 15, height - 16)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text(REPORT_NOTE, 15, height - 11, { maxWidth: width - 30 })
  doc.text(`Generado el ${formatInstantInSantiago(new Date().toISOString())} | Página ${page} de ${totalPages}`, width - 15, height - 5.5, { align: 'right' })
}

function drawContinuationHeader(doc: jsPDF, report: PendingPurchaseOrdersReport): void {
  const width = doc.internal.pageSize.getWidth()
  doc.setFillColor(...NAVY)
  doc.rect(0, 0, width, 18, 'F')
  addLogo(doc, undefined)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...WHITE)
  doc.text(report.company_name || 'MYM/PetGroup', 15, 8)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.text('REPORTE DE PEDIDOS PENDIENTES DE RECEPCIÓN', width - 15, 8, { align: 'right' })
}

function groupLines(lines: PendingPurchaseOrderReportLine[]) {
  const suppliers = new Map<string, { supplierName: string; orders: Map<string, { header: PendingPurchaseOrderReportLine; lines: PendingPurchaseOrderReportLine[] }> }>()
  for (const line of lines) {
    const supplier = suppliers.get(line.supplier_id) ?? { supplierName: line.supplier_name, orders: new Map() }
    const order = supplier.orders.get(line.purchase_order_id) ?? { header: line, lines: [] }
    order.lines.push(line)
    supplier.orders.set(line.purchase_order_id, order)
    suppliers.set(line.supplier_id, supplier)
  }
  return Array.from(suppliers.values()).sort((left, right) => left.supplierName.localeCompare(right.supplierName, 'es'))
}

export function generatePendingPurchaseOrdersReportPdf(report: PendingPurchaseOrdersReport, logoBase64?: string): Blob {
  const doc = new jsPDF('p', 'mm', 'a4')
  const width = doc.internal.pageSize.getWidth()
  const height = doc.internal.pageSize.getHeight()
  const margin = 15
  let y = 15

  doc.setFillColor(...NAVY)
  doc.rect(0, 0, width, 31, 'F')
  addLogo(doc, logoBase64)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(...WHITE)
  doc.text(report.company_name || 'MYM/PetGroup', width - margin, 10, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.text('Documento interno de adquisiciones', width - margin, 16, { align: 'right' })

  y = 43
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(17)
  doc.setTextColor(...NAVY)
  doc.text('REPORTE DE PEDIDOS PENDIENTES DE RECEPCIÓN', margin, y)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text(`Generado: ${formatInstantInSantiago(report.generated_at)}`, margin, y + 6)
  doc.setDrawColor(...BURGUNDY)
  doc.setLineWidth(1)
  doc.line(margin, y + 11, width - margin, y + 11)
  y += 22

  const providerCount = new Set(report.data.map(line => line.supplier_id)).size
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...BURGUNDY)
  doc.text('RESUMEN', margin, y)
  y += 3
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Órdenes de compra pendientes', 'Proveedores involucrados', 'Líneas pendientes']],
    body: [[String(report.total_orders), String(providerCount), String(report.total_lines)]],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 3, textColor: TEXT, lineColor: BORDER, lineWidth: 0.3, halign: 'center' },
    headStyles: { fillColor: NAVY, textColor: WHITE, fontStyle: 'bold', fontSize: 7, halign: 'center' },
    bodyStyles: { fillColor: LIGHT, fontStyle: 'bold', fontSize: 12 },
  })
  y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 10

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(...MUTED)
  doc.text(doc.splitTextToSize(REPORT_NOTE, width - margin * 2), margin, y)
  y += 13

  for (const supplier of groupLines(report.data)) {
    if (y > height - 48) {
      doc.addPage()
      y = 25
    }
    doc.setFillColor(...BURGUNDY)
    doc.roundedRect(margin, y - 5, width - margin * 2, 8, 1.5, 1.5, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(...WHITE)
    doc.text(`PROVEEDOR: ${supplier.supplierName}`, margin + 3, y)
    y += 10

    for (const order of Array.from(supplier.orders.values()).sort((left, right) => left.header.correlative.localeCompare(right.header.correlative, 'es', { numeric: true }))) {
      if (y > height - 48) {
        doc.addPage()
        y = 25
      }
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8.5)
      doc.setTextColor(...NAVY)
      doc.text(`OC ${order.header.correlative}`, margin, y)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(...MUTED)
      doc.text(`Fecha de emisión: ${formatCivilDate(order.header.issue_date)} | Estado: ${statusLabel(order.header.status)}`, margin + 32, y)
      y += 3

      autoTable(doc, {
        startY: y,
        margin: { left: margin, right: margin, top: 23, bottom: 21 },
        pageBreak: 'auto',
        head: [['SKU', 'Descripción', 'Unidad', 'Solicitada', 'Recibida', 'Pendiente']],
        body: order.lines.map(line => [
          line.sku || '—',
          line.description,
          line.unit || '—',
          quantity(line.quantity_ordered),
          quantity(line.quantity_received),
          quantity(line.quantity_pending),
        ]),
        styles: { font: 'helvetica', fontSize: 7, cellPadding: 2, textColor: TEXT, lineColor: BORDER, lineWidth: 0.3, overflow: 'linebreak' },
        headStyles: { fillColor: NAVY, textColor: WHITE, fontStyle: 'bold', fontSize: 7, halign: 'center' },
        alternateRowStyles: { fillColor: LIGHT },
        columnStyles: {
          0: { cellWidth: 22 },
          1: { cellWidth: 72 },
          2: { cellWidth: 18, halign: 'center' },
          3: { cellWidth: 24, halign: 'right' },
          4: { cellWidth: 24, halign: 'right' },
          5: { cellWidth: 25, halign: 'right', fontStyle: 'bold', textColor: BURGUNDY },
        },
        didParseCell: data => {
          if (data.section === 'body' && data.column.index === 5) data.cell.styles.fillColor = PENDING
        },
        willDrawPage: data => {
          if (data.pageNumber > 1) drawContinuationHeader(doc, report)
        },
      })
      y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 9
    }
  }

  const totalPages = doc.getNumberOfPages()
  for (let page = 1; page <= totalPages; page++) {
    doc.setPage(page)
    drawFooter(doc, page, totalPages)
  }
  doc.setProperties({
    title: 'Reporte de pedidos pendientes de recepción',
    subject: 'Órdenes de compra pendientes de recepción',
    author: report.company_name || 'MYM/PetGroup',
  })
  return doc.output('blob')
}

async function loadReportLogo(): Promise<string | undefined> {
  for (const path of ['/logo-transparent.png', '/logo.png']) {
    try {
      const response = await fetch(path)
      if (!response.ok) continue
      const blob = await response.blob()
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    } catch {
      // Try the fallback logo path.
    }
  }
  return undefined
}

export async function downloadPendingPurchaseOrdersReportPdf(report: PendingPurchaseOrdersReport, filename: string): Promise<void> {
  const blob = generatePendingPurchaseOrdersReportPdf(report, await loadReportLogo())
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
