import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type {
  SalesOrderClientData,
  SalesOrderPreparationCardInfo,
  SalesOrderPreparationItem,
  SalesOrderPreparationLine,
} from '@/app/actions/logistica/sales-order-preparation'

export type PreparationOrderPdfEntry = {
  card: SalesOrderPreparationCardInfo
  items: SalesOrderPreparationItem[]
  preparationLines?: SalesOrderPreparationLine[]
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
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (match) {
    const [, y, m, d] = match
    return `${d}/${m}/${y}`
  }
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
  const headerHeight = 16
  doc.setFillColor(...BRAND)
  doc.rect(0, 0, width, headerHeight, 'F')

  doc.setTextColor(...WHITE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.text('DISTRIBUIDORA MYM / PetGroup', margin, 7)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  doc.text(
    card.status === 'IN_PREPARATION'
      ? 'PREPARACIÓN DE BODEGA · EN PREPARACIÓN'
      : 'PREPARACIÓN DE BODEGA · DOCUMENTO OPERACIONAL',
    margin,
    11.5,
  )

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text(`NV N° ${card.nv_folio}`, width - margin, 7.5, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.text(`Estado: ${statusLabel(card.status)}`, width - margin, 12, { align: 'right' })

  return 20
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
  const boxHeight = 22
  const comuna = card.normalized_city || card.municipality_raw || card.city_raw || '—'
  const colSplit = 0.55
  const col1Width = contentWidth * colSplit
  const leftX = margin + 3
  const rightX = margin + col1Width + 3

  // Recuadro exterior
  doc.setDrawColor(...BORDER)
  doc.setLineWidth(0.3)
  doc.setFillColor(...WHITE)
  doc.rect(margin, startY, contentWidth, boxHeight)
  doc.line(margin + col1Width, startY, margin + col1Width, startY + boxHeight)

  // Columna Izquierda: Cliente, Dirección, RUT / Comuna
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('CLIENTE:', leftX, startY + 4.5)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...TEXT)
  doc.text(doc.splitTextToSize(card.client_name || '—', col1Width - 18), leftX + 14, startY + 4.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('DIRECCIÓN:', leftX, startY + 10.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(...TEXT)
  doc.text(doc.splitTextToSize(card.address_raw || '—', col1Width - 20), leftX + 16, startY + 10.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('RUT / COMUNA:', leftX, startY + 16.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(...TEXT)
  const locDetail = `${clientData?.rut ? `${clientData.rut}  ·  ` : ''}${comuna}${card.city_raw && card.city_raw !== comuna ? ` (${card.city_raw})` : ''}`
  doc.text(doc.splitTextToSize(locDetail, col1Width - 25), leftX + 22, startY + 16.5)

  // Columna Derecha: Vendedor, Emisión, Ruta, Cantidad, Totales
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('VENDEDOR:', rightX, startY + 4.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(...TEXT)
  doc.text(doc.splitTextToSize(card.seller_name || 'Sin asignar', 36), rightX + 16, startY + 4.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('EMISIÓN:', width - margin - 35, startY + 4.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(...TEXT)
  doc.text(formatDate(card.nv_emission_date), width - margin - 20, startY + 4.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('FECHA RUTA:', rightX, startY + 10.5)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(...BRAND)
  doc.text(formatDate(card.route_date), rightX + 18, startY + 10.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('ESTADO:', width - margin - 35, startY + 10.5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(...TEXT)
  doc.text(statusLabel(card.status), width - margin - 20, startY + 10.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('UNIDADES:', rightX, startY + 16.5)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...TEXT)
  doc.text(String(card.total_quantity), rightX + 16, startY + 16.5)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  doc.text('TOTAL:', width - margin - 35, startY + 16.5)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(7.5)
  doc.setTextColor(...TEXT)
  doc.text(formatMoney(card.gross_amount ?? card.total_amount), width - margin - 23, startY + 16.5)

  return startY + boxHeight + 4
}

function preparationLineStatusLabel(line: SalesOrderPreparationLine): string {
  if (line.excluded_from_dispatch) return 'Excluida / Con incidencia'
  if (line.line_status === 'INCIDENT') return 'Con incidencia'
  if (line.line_status === 'CONFIRMED') return 'Confirmada'
  return 'Pendiente'
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

    const isOperational = entry.card.status === 'IN_PREPARATION'
    const preparationLines = entry.preparationLines ?? []
    const lineCount = isOperational ? preparationLines.length : entry.items.length

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...BRAND)
    doc.text(isOperational ? 'PRODUCTOS EN PREPARACIÓN' : 'PRODUCTOS A PREPARAR', margin, cursorY)
    cursorY += 3

    autoTable(doc, {
      head: [isOperational
        ? ['SKU', 'Descripción / presentación', 'Solicitado', 'Preparado', 'Estado']
        : ['SKU', 'Descripción / presentación', 'Cantidad']],
      body: isOperational
        ? preparationLines.length > 0
          ? preparationLines.map(line => [
              line.sku || '—',
              line.product_name || '—',
              String(line.requested_quantity),
              line.prepared_quantity == null ? '—' : String(line.prepared_quantity),
              preparationLineStatusLabel(line),
            ])
          : [['—', 'Sin líneas operacionales disponibles para esta Nota de Venta', '—', '—', '—']]
        : entry.items.length > 0
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
        1: { cellWidth: isOperational ? width - margin * 2 - 93 : width - margin * 2 - 52 },
        2: { cellWidth: 20, halign: 'center', fontStyle: 'bold' },
        ...(isOperational ? {
          3: { cellWidth: 20, halign: 'center', fontStyle: 'bold' },
          4: { cellWidth: 23, halign: 'center', fontSize: 7 },
        } : { }),
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
    if (isOperational) {
      const requestedTotal = preparationLines.reduce((sum, line) => sum + line.requested_quantity, 0)
      const preparedTotal = preparationLines.reduce((sum, line) => sum + (line.prepared_quantity == null ? 0 : line.prepared_quantity), 0)
      const pendingCount = preparationLines.filter(line => line.prepared_quantity == null || line.line_status === 'PENDING').length
      const incidentCount = preparationLines.filter(line => line.line_status === 'INCIDENT').length
      doc.text(`Líneas: ${lineCount} · Solicitadas: ${requestedTotal} · Preparadas: ${preparedTotal}`, margin, finalY + 5)
      doc.text(`Pendientes de confirmar: ${pendingCount} líneas · Incidencias: ${incidentCount}`, margin, finalY + 9)
    } else {
      doc.text(`Líneas: ${lineCount} · Unidades: ${entry.card.total_quantity}`, margin, finalY + 5)
    }
    doc.text(`Neto: ${formatMoney(entry.card.net_amount)} · Total: ${formatMoney(entry.card.gross_amount ?? entry.card.total_amount)}`, margin, finalY + (isOperational ? 13 : 9))

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
