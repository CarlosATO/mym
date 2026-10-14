import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { formatCivilDate, todayInSantiago } from '@/lib/datetime'

export interface OperationalPurchaseOrderItem {
  line_number: number
  item_type: string
  sku: string | null
  product_description: string
  unit: string | null
  quantity: number
  notes: string | null
}

export interface OperationalPurchaseOrderDetail {
  company: {
    name: string
    rut: string | null
    phone: string | null
    email: string | null
    address: string | null
    logo_url: string | null
  }
  po: {
    correlative: string
    issue_date: string
    required_date: string | null
    supplier_name: string
    warehouse_name: string | null
    po_type: string
    requester_name: string
    notes: string | null
    status: string
  }
  items: OperationalPurchaseOrderItem[]
}

const NAVY: [number, number, number] = [30, 58, 95]
const TEAL: [number, number, number] = [13, 148, 136]
const TEXT: [number, number, number] = [30, 41, 59]
const MUTED: [number, number, number] = [100, 116, 139]
const BORDER: [number, number, number] = [226, 232, 240]
const PALE: [number, number, number] = [248, 250, 252]
const WHITE: [number, number, number] = [255, 255, 255]

function civilDate(value?: string | null): string {
  return formatCivilDate(value) || '-'
}

function footer(doc: jsPDF, page: number, pages: number): void {
  const width = doc.internal.pageSize.getWidth()
  doc.setDrawColor(...BORDER)
  doc.setLineWidth(0.3)
  doc.line(15, 282, width - 15, 282)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('Copia operacional para bodega · Sin información económica', width / 2, 288, { align: 'center' })
  doc.text(`Generado el ${civilDate(todayInSantiago())} · Página ${page} de ${pages}`, width / 2, 292, { align: 'center' })
}

export function generateOperationalPurchaseOrderPdf(detail: OperationalPurchaseOrderDetail, logoBase64?: string): Blob {
  const doc = new jsPDF('p', 'mm', 'a4')
  const width = doc.internal.pageSize.getWidth()
  const margin = 15
  const contentWidth = width - margin * 2
  let y = 15

  doc.setFillColor(...NAVY)
  doc.rect(0, 0, width, 34, 'F')
  if (logoBase64) {
    try { doc.addImage(logoBase64, 'PNG', margin, 7, 24, 16) } catch { /* Logo is optional. */ }
  }
  doc.setTextColor(...WHITE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text(detail.company.name, width - margin, 10, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  const companyMeta = [detail.company.rut && `RUT: ${detail.company.rut}`, detail.company.phone, detail.company.email, detail.company.address]
    .filter(Boolean)
    .join(' · ')
  if (companyMeta) doc.text(companyMeta, width - margin, 16, { align: 'right', maxWidth: contentWidth - 30 })

  y = 48
  doc.setTextColor(...NAVY)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(19)
  doc.text('ORDEN DE COMPRA', margin, y)
  doc.setFillColor(...TEAL)
  doc.roundedRect(width - margin - 61, y - 9, 61, 9, 2, 2, 'F')
  doc.setTextColor(...WHITE)
  doc.setFontSize(7.5)
  doc.text('COPIA OPERACIONAL · BODEGA', width - margin - 30.5, y - 3.3, { align: 'center' })
  doc.setTextColor(...MUTED)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text(`N° ${detail.po.correlative}`, margin, y + 6)
  doc.setDrawColor(...TEAL)
  doc.setLineWidth(1)
  doc.line(margin, y + 13, width - margin, y + 13)

  y += 25
  const col2 = margin + contentWidth / 2 + 3
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8.5)
  doc.setTextColor(...TEAL)
  doc.text('PROVEEDOR', margin, y)
  doc.text('DATOS OPERATIVOS', col2, y)

  const leftRows: [string, string][] = [['Nombre:', detail.po.supplier_name]]
  const rightRows: [string, string][] = [
    ['Fecha emisión:', civilDate(detail.po.issue_date)],
    ['Fecha requerida:', civilDate(detail.po.required_date)],
    ['Bodega destino:', detail.po.warehouse_name || '-'],
    ['Tipo:', detail.po.po_type || '-'],
    ['Solicitante:', detail.po.requester_name || '-'],
    ['Estado:', detail.po.status || '-'],
  ]
  const drawRows = (rows: [string, string][], x: number, startY: number) => {
    let rowY = startY
    doc.setFontSize(8)
    doc.setTextColor(...TEXT)
    for (const [label, value] of rows) {
      doc.setFont('helvetica', 'bold')
      doc.text(label, x, rowY)
      const labelWidth = doc.getTextWidth(label)
      doc.setFont('helvetica', 'normal')
      doc.text(doc.splitTextToSize(value || '-', contentWidth / 2 - labelWidth - 8), x + labelWidth + 2, rowY)
      rowY += 5
    }
    return rowY
  }
  y = Math.max(drawRows(leftRows, margin, y + 6), drawRows(rightRows, col2, y + 6)) + 8

  const headers = ['Línea', 'SKU', 'Producto / descripción', 'Unidad', 'Cantidad solicitada', 'Observación']
  const body = detail.items.map(item => [
    String(item.line_number),
    item.item_type === 'SERVICE' ? '—' : item.sku || '—',
    item.product_description,
    item.unit || '—',
    String(item.quantity),
    item.notes || '—',
  ])
  autoTable(doc, {
    head: [headers],
    body,
    startY: y,
    margin: { left: margin, right: margin, bottom: 22 },
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 2, textColor: TEXT, lineColor: BORDER, lineWidth: 0.3 },
    headStyles: { fillColor: NAVY, textColor: WHITE, fontStyle: 'bold', fontSize: 7, halign: 'center' },
    columnStyles: {
      0: { halign: 'center', cellWidth: 10 },
      1: { cellWidth: 25 },
      2: { cellWidth: 60 },
      3: { halign: 'center', cellWidth: 15 },
      4: { halign: 'right', cellWidth: 25 },
      5: { cellWidth: 42 },
    },
    alternateRowStyles: { fillColor: PALE },
    didDrawPage: data => footer(doc, data.pageNumber, doc.getNumberOfPages()),
  })

  const finalY = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y) + 9
  let notesY = finalY
  if (detail.po.notes) {
    if (notesY > 255) { doc.addPage(); notesY = 20 }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...TEAL)
    doc.text('OBSERVACIONES OPERATIVAS', margin, notesY)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...TEXT)
    doc.text(doc.splitTextToSize(detail.po.notes, contentWidth), margin, notesY + 6)
  }

  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) { doc.setPage(page); footer(doc, page, pages) }
  doc.setProperties({
    title: `Copia operacional OC ${detail.po.correlative}`,
    subject: 'Orden de compra para bodega',
    author: detail.company.name,
  })
  return doc.output('blob')
}

export async function downloadOperationalPurchaseOrderPdf(detail: OperationalPurchaseOrderDetail, filename: string): Promise<void> {
  let logoBase64: string | undefined
  if (detail.company.logo_url) {
    try {
      const response = await fetch(detail.company.logo_url)
      if (response.ok) {
        const blob = await response.blob()
        logoBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      }
    } catch { /* Logo is optional. */ }
  }
  const blob = generateOperationalPurchaseOrderPdf(detail, logoBase64)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
