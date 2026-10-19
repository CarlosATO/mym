import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type {
  SalesOrderClientData,
  SalesOrderPreparationCardInfo,
  SalesOrderPreparationItem,
} from '@/app/actions/logistica/sales-order-preparation'

export type PreparationOrderPdfEntry = {
  card: SalesOrderPreparationCardInfo
  items: SalesOrderPreparationItem[]
  clientData?: SalesOrderClientData | null
}

const BRAND: [number, number, number] = [114, 56, 61]
const TEXT: [number, number, number] = [50, 45, 41]
const MUTED: [number, number, number] = [107, 98, 92]
const BORDER: [number, number, number] = [209, 199, 189]
const PALE: [number, number, number] = [245, 240, 234]
const WHITE: [number, number, number] = [255, 255, 255]

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatMoney(value: number | null | undefined): string {
  if (value == null) return '—'
  return `$ ${Math.round(value).toLocaleString('es-CL')}`
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    PENDING_ROUTE_PREP: 'Pendiente',
    IN_PREPARATION: 'En preparación',
    IN_AUDIT: 'En auditoría',
  }
  return labels[status] ?? status
}

function drawDocumentHeader(doc: jsPDF, card: SalesOrderPreparationCardInfo, margin: number, width: number): number {
  doc.setFillColor(...BRAND)
  doc.rect(0, 0, width, 26, 'F')

  doc.setTextColor(...WHITE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('DISTRIBUIDORA MYM / PetGroup', margin, 11)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.text('PREPARACIÓN DE BODEGA · DOCUMENTO OPERACIONAL', margin, 16.5)
  doc.text('Venta de alimentos y accesorios para mascotas · Transporte', margin, 21)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(`NV N° ${card.nv_folio}`, width - margin, 12, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.text(`Estado: ${statusLabel(card.status)}`, width - margin, 18, { align: 'right' })

  return 34
}

function drawInfoBlock(
  doc: jsPDF,
  card: SalesOrderPreparationCardInfo,
  clientData: SalesOrderClientData | null | undefined,
  margin: number,
  width: number,
  startY: number,
): number {
  const contentWidth = width - margin * 2
  const colWidth = contentWidth / 2
  const leftX = margin
  const rightX = margin + colWidth + 4

  const rowsLeft: Array<[string, string]> = [
    ['Cliente', card.client_name || '—'],
    ['RUT', clientData?.rut || 'No disponible'],
    ['Dirección', card.address_raw || '—'],
    ['Comuna', card.normalized_city || card.municipality_raw || card.city_raw || '—'],
    ['Ciudad', card.city_raw || '—'],
    ['Vendedor', card.seller_name || '—'],
  ]
  const rowsRight: Array<[string, string]> = [
    ['Fecha emisión', formatDate(card.nv_emission_date)],
    ['Fecha ruta', formatDate(card.route_date)],
    ['Estado PetGroup', statusLabel(card.status)],
    ['Unidades', String(card.total_quantity)],
    ['Neto', formatMoney(card.net_amount)],
    ['Total', formatMoney(card.gross_amount ?? card.total_amount)],
  ]

  const boxHeight = 44
  doc.setDrawColor(...BORDER)
  doc.setLineWidth(0.3)
  doc.rect(margin, startY, contentWidth, boxHeight)
  doc.line(leftX + colWidth + 2, startY, leftX + colWidth + 2, startY + boxHeight)

  const drawRows = (rows: Array<[string, string]>, x: number, y: number) => {
    for (const [label, value] of rows) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(7)
      doc.setTextColor(...MUTED)
      doc.text(label.toUpperCase(), x, y)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      doc.setTextColor(...TEXT)
      doc.text(doc.splitTextToSize(value, colWidth - 4), x, y + 3.6)
      y += 6
    }
    return y
  }

  drawRows(rowsLeft, leftX + 3, startY + 6)
  drawRows(rowsRight, rightX + 2, startY + 6)

  return startY + boxHeight + 6
}

export function generatePreparationOrdersPdf(entries: PreparationOrderPdfEntry[]): Blob {
  if (entries.length === 0) {
    throw new Error('No hay Notas de Venta para generar el documento.')
  }

  const doc = new jsPDF('p', 'mm', 'a4')
  const width = doc.internal.pageSize.getWidth()
  const margin = 12

  entries.forEach((entry, index) => {
    if (index > 0) doc.addPage()

    let cursorY = drawDocumentHeader(doc, entry.card, margin, width)
    cursorY = drawInfoBlock(doc, entry.card, entry.clientData, margin, width, cursorY)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...BRAND)
    doc.text('PRODUCTOS A PREPARAR', margin, cursorY)
    cursorY += 3

    autoTable(doc, {
      head: [['SKU', 'Descripción / presentación', 'Cantidad']],
      body: entry.items.length > 0
        ? entry.items.map(item => [
            item.sku || '—',
            item.product_name || '—',
            String(item.quantity),
          ])
        : [['—', 'Sin líneas disponibles para esta Nota de Venta', '—']],
      startY: cursorY,
      margin: { left: margin, right: margin, bottom: 20 },
      styles: {
        font: 'helvetica',
        fontSize: 8,
        cellPadding: 2.2,
        textColor: TEXT,
        lineColor: BORDER,
        lineWidth: 0.2,
      },
      headStyles: {
        fillColor: BRAND,
        textColor: WHITE,
        fontStyle: 'bold',
        fontSize: 7.5,
      },
      columnStyles: {
        0: { cellWidth: 30, font: 'courier' },
        1: { cellWidth: width - margin * 2 - 52 },
        2: { cellWidth: 22, halign: 'center', fontStyle: 'bold' },
      },
      alternateRowStyles: { fillColor: PALE },
    })

    const lastTable = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
    let finalY = (lastTable?.finalY ?? cursorY) + 8

    if (finalY > 245) {
      doc.addPage()
      finalY = 20
    }

    doc.setDrawColor(...BORDER)
    doc.setLineWidth(0.3)
    doc.line(margin, finalY, width - margin, finalY)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text(`Líneas: ${entry.items.length} · Unidades: ${entry.card.total_quantity}`, margin, finalY + 5)
    doc.text(`Neto: ${formatMoney(entry.card.net_amount)} · Total: ${formatMoney(entry.card.gross_amount ?? entry.card.total_amount)}`, margin, finalY + 9)

    doc.setDrawColor(...TEXT)
    doc.line(margin + 8, finalY + 28, margin + 50, finalY + 28)
    doc.line(width - margin - 50, finalY + 28, width - margin - 8, finalY + 28)
    doc.setFontSize(7)
    doc.text('Preparado por', margin + 29, finalY + 32, { align: 'center' })
    doc.text('Revisado por', width - margin - 29, finalY + 32, { align: 'center' })
  })

  const totalPages = doc.getNumberOfPages()
  const generatedAt = new Date().toLocaleString('es-CL')
  for (let page = 1; page <= totalPages; page++) {
    doc.setPage(page)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(...MUTED)
    doc.text(
      `Documento generado el ${generatedAt} · Página ${page} de ${totalPages}`,
      width / 2,
      doc.internal.pageSize.getHeight() - 7,
      { align: 'center' },
    )
  }

  doc.setProperties({
    title: entries.length === 1
      ? `Preparación NV ${entries[0].card.nv_folio}`
      : `Preparación ${entries.length} Notas de Venta`,
    subject: 'Documento operacional de preparación de pedidos',
    author: 'Distribuidora MYM / PetGroup',
  })

  return doc.output('blob')
}

export function openPreparationOrdersPdf(
  blob: Blob,
  existingWindow?: Window | null,
  filename = 'preparacion-pedidos.pdf',
): void {
  const url = URL.createObjectURL(blob)

  if (existingWindow && !existingWindow.closed) {
    existingWindow.location.href = url
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return
  }

  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (opened) {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return
  }

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000)
}
