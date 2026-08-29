import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { RouteGuide } from '@/modules/logistica/guias-ruta/types'
import { formatRouteGuideLineAmount, formatPaymentMethodLabel } from '@/modules/logistica/guias-ruta/utils/route-guide-formatters'
import { isEmptyRouteGuideRow } from '@/modules/logistica/guias-ruta/utils/route-guide-validation'
import { formatCivilDate, todayInSantiago } from '@/lib/datetime'

const DARK_HEADER: [number, number, number] = [30, 58, 95]
const EMERALD: [number, number, number] = [16, 185, 129]
const DARK_TEXT: [number, number, number] = [30, 41, 59]
const WHITE: [number, number, number] = [255, 255, 255]
const MID_GRAY: [number, number, number] = [100, 116, 139]
const LIGHT_BORDER: [number, number, number] = [226, 232, 240]

export type RouteGuidePdfOrientation = 'portrait' | 'landscape'

function formatCurrency(amount: number): string {
  return `$ ${Math.round(amount).toLocaleString('es-CL')}`
}

function formatDate(dateStr: string): string {
  const civilDate = formatCivilDate(dateStr)
  return civilDate ? civilDate.replaceAll('-', '/') : '-'
}

function drawPageFooter(doc: jsPDF, pageNum: number, totalPages: number): void {
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 15

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6)
  doc.setTextColor(...MID_GRAY)
  doc.setDrawColor(...LIGHT_BORDER)
  doc.setLineWidth(0.3)
  doc.line(margin, pageHeight - 15, pageWidth - margin, pageHeight - 15)

  doc.text(
    `Documento generado el ${formatDate(todayInSantiago())} | Página ${pageNum} de ${totalPages}`,
    pageWidth / 2,
    pageHeight - 8.5,
    { align: 'center' },
  )
}

function getImageSizeFromBase64(base64: string): { width: number; height: number } | null {
  try {
    const base64Data = base64.split(',')[1] || base64
    const binaryString = typeof window !== 'undefined' 
      ? window.atob(base64Data) 
      : Buffer.from(base64Data, 'base64').toString('binary')
    const buffer = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      buffer[i] = binaryString.charCodeAt(i)
    }

    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      const width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19]
      const height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23]
      return { width, height }
    }

    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let i = 2
      while (i < buffer.length) {
        if (i + 4 > buffer.length) break
        const marker = (buffer[i] << 8) | buffer[i + 1]
        if ((marker & 0xFF00) !== 0xFF00) { i++; continue }
        i += 2
        if (marker === 0xFFD9) break
        const length = (buffer[i] << 8) | buffer[i + 1]
        if (marker >= 0xFFC0 && marker <= 0xFFC3) {
          const height = (buffer[i + 3] << 8) | buffer[i + 4]
          const width = (buffer[i + 5] << 8) | buffer[i + 6]
          return { width, height }
        }
        i += length
      }
    }
  } catch (err) {
    console.error('Error parsing image size from base64:', err)
  }
  return null
}

export async function generateRouteGuidePdfBlob(
  guide: RouteGuide,
  logoBase64?: string,
  secondLogoBase64?: string,
  orientation: RouteGuidePdfOrientation = 'portrait',
): Promise<Blob> {
  const doc = new jsPDF(orientation === 'landscape' ? 'l' : 'p', 'mm', 'a4')
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 15
  const usableWidth = pageWidth - 2 * margin
  let cursorY = margin
  let totalPages = 1

  // HEADER BAR
  const headerHeight = 32
  doc.setFillColor(...DARK_HEADER)
  doc.rect(0, 0, pageWidth, headerHeight, 'F')

  let fetchedLogo1 = logoBase64
  let fetchedLogo2 = secondLogoBase64

  if (!fetchedLogo1 || !fetchedLogo2) {
    try {
      const fetchBase64 = async (url: string) => {
        const res = await fetch(url)
        if (!res.ok) return null
        const b = await res.blob()
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(b)
        })
      }
      if (!fetchedLogo1) fetchedLogo1 = await fetchBase64('/logo.png') || undefined
      if (!fetchedLogo2) fetchedLogo2 = await fetchBase64('/Logo_AmiMascota.jpeg') || undefined
    } catch (err) {
      console.error('Error fetching logos:', err)
    }
  }

  if (fetchedLogo1 || fetchedLogo2) {
    try {
      const renderLogo = (base64: string, xPos: number) => {
        let format = 'PNG'
        if (base64.startsWith('data:image/')) {
          const parts = base64.split(';')[0].split(':')
          const mime = parts.length > 1 ? parts[1].split(';')[0] : ''
          if (mime === 'image/jpeg' || mime === 'image/jpg') format = 'JPEG'
          else if (mime === 'image/webp') format = 'WEBP'
          else format = mime.split('/')[1]?.toUpperCase() || 'PNG'
        }

        let logoW = 20
        let logoH = 17
        const imgSize = getImageSizeFromBase64(base64)
        if (imgSize) {
          const aspectRatio = imgSize.width / imgSize.height
          const maxW = 30
          const maxH = 15
          if (aspectRatio > maxW / maxH) {
            logoW = maxW
            logoH = maxW / aspectRatio
          } else {
            logoH = maxH
            logoW = maxH * aspectRatio
          }
        }
        doc.addImage(base64, format, xPos, 5 + (15 - logoH) / 2, logoW, logoH)
        return logoW
      }
      
      let currentX = margin + 2
      if (fetchedLogo1) {
        currentX += renderLogo(fetchedLogo1, currentX) + 5
      }
      if (fetchedLogo2) {
        renderLogo(fetchedLogo2, currentX)
      }
    } catch (err) {
      console.error('Error adding logo:', err)
    }
  }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(...WHITE)
  doc.text("DISTRIBUIDORA MYM", pageWidth - margin, 12, { align: 'right' })

  // TITLE
  cursorY = headerHeight + 8
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.setTextColor(...DARK_HEADER)
  const title = guide.status === 'DISPATCHED' ? 'GUÍA DESPACHADA' : 'GUÍA DE RUTA'
  doc.text(title, margin, cursorY)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MID_GRAY)
  
  if (guide.status === 'DRAFT' && !guide.id) {
    doc.text(`BORRADOR NO GUARDADO`, margin, cursorY + 5.5)
  } else {
    doc.text(`N° ${guide.guide_number || '---'}  |  Fecha: ${formatDate(guide.guide_date)}`, margin, cursorY + 5.5)
  }

  cursorY += 12

  // EMERALD DIVIDER
  doc.setDrawColor(...EMERALD)
  doc.setLineWidth(1.2)
  doc.line(margin, cursorY, pageWidth - margin, cursorY)
  cursorY += 6

  // TWO-COLUMN INFO
  const leftColX = margin
  const rightColX = margin + usableWidth / 2 + 3

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...EMERALD)
  doc.text('INFORMACIÓN DE RUTA', leftColX, cursorY)
  doc.text('PERSONAL ASIGNADO', rightColX, cursorY)

  const leftRows: [string, string][] = [
    ['Ruta:', guide.route_name_snapshot || '-'],
    ['Vehículo:', guide.vehicle_name_snapshot || '-']
  ]
  const rightRows: [string, string][] = [
    ['Vendedor:', guide.seller_name_snapshot || '-'],
    ['Conductor:', guide.driver_name_snapshot || '-'],
    ['Despachador:', guide.dispatcher_name_snapshot || '-']
  ]

  doc.setFontSize(8)
  doc.setTextColor(...DARK_TEXT)
  let leftY = cursorY + 5
  for (const [label, value] of leftRows) {
    doc.setFont('helvetica', 'bold')
    doc.text(label, leftColX, leftY)
    doc.setFont('helvetica', 'normal')
    doc.text(value, leftColX + 15, leftY)
    leftY += 5
  }

  let rightY = cursorY + 5
  for (const [label, value] of rightRows) {
    doc.setFont('helvetica', 'bold')
    doc.text(label, rightColX, rightY)
    doc.setFont('helvetica', 'normal')
    doc.text(value, rightColX + 20, rightY)
    rightY += 5
  }

  cursorY = Math.max(leftY, rightY) + 6

  // TABLE
  const validItems = guide.items?.filter(i => !isEmptyRouteGuideRow(i)) || []
  
  const tableHeaders = ['Factura', 'Cliente', 'Dirección / Ciudad', 'Monto', 'Condición de venta', 'Obs.']
  const tableBody = validItems.map(item => [
    item.invoice_number,
    item.customer_name,
    `${item.customer_address?.trim() || '-'} / ${item.commune || '-'}`,
    formatRouteGuideLineAmount(item.amount),
    formatPaymentMethodLabel(item.payment_method_normalized, item.payment_method_original),
    item.notes || '',
  ])

  const blockHeight = 55
  const blockStartY = pageHeight - margin - blockHeight
  const tableColumnWidths = orientation === 'landscape'
    ? [24, 58, 72, 29, 48, 36]
    : [22, 34, 38, 22, 34, 30]

  const autoTableOptions = {
    head: [tableHeaders],
    startY: cursorY,
    margin: { left: margin, right: margin, bottom: 15 },
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 2, textColor: [30, 41, 59], lineColor: [226, 232, 240], lineWidth: 0.3, overflow: 'linebreak' },
    headStyles: { fillColor: [30, 58, 95], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, halign: 'center', cellPadding: 2 },
    columnStyles: {
      0: { halign: 'center', cellWidth: tableColumnWidths[0] },
      1: { cellWidth: tableColumnWidths[1] },
      2: { cellWidth: tableColumnWidths[2] },
      3: { halign: 'right', cellWidth: tableColumnWidths[3] },
      4: { halign: 'center', cellWidth: tableColumnWidths[4] },
      5: { cellWidth: tableColumnWidths[5] }
    },
    alternateRowStyles: { fillColor: [248, 250, 252] }
  } as Parameters<typeof autoTable>[1];

  // Let autoTable paginate and repeat the header. Reserve the final summary
  // block only after knowing where the last table page actually ended.
  autoTable(doc, { ...autoTableOptions, body: tableBody })
  const tableFinalY = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY
  let summaryStartY = blockStartY
  if (tableFinalY > blockStartY) {
    doc.addPage()
    summaryStartY = margin
  }

  // OPERATIONAL SUMMARY
  doc.setPage(doc.getNumberOfPages()); // Nos aseguramos de estar en la última página
  
  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...DARK_TEXT);
  doc.text(`Resumen de guía: ${guide.total_invoices || 0} Facturas`, margin, summaryStartY);
  const summaryTableBody = [
    ['Efectivo esperado', formatCurrency(guide.total_cash_expected || 0), ''],
    ['Cheques esperados', formatCurrency(guide.total_check_expected || 0), ''],
    ['Crédito', formatCurrency(guide.total_credit || 0), ''],
    ['Transferencia', formatCurrency(guide.total_transfer || 0), ''],
  ]

  const totalUnknown = guide.items?.filter(i => i.payment_method_normalized === 'UNKNOWN').reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0) || 0
  if (totalUnknown > 0) summaryTableBody.push(['No reconocido', formatCurrency(totalUnknown), ''])
  
  autoTable(doc, {
    head: [['Concepto', 'Emitido', 'Recibido / Rendido']],
    body: summaryTableBody,
    startY: summaryStartY + 3,
    margin: { left: margin },
    tableWidth: 100,
     styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.8, textColor: [30, 41, 59], lineColor: [226, 232, 240], lineWidth: 0.3 },
     headStyles: { fillColor: [30, 58, 95], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, halign: 'center' },
    columnStyles: {
      0: { cellWidth: 35, fontStyle: 'bold' },
      1: { cellWidth: 25, halign: 'right' },
      2: { cellWidth: 40 }
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  // SIGNATURES
  const totalsX = margin + 100 + 10
  let ty = summaryStartY + 10
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(...DARK_TEXT)
  doc.text('Monto total ruta:', totalsX, ty)
  doc.text(formatCurrency(guide.total_amount || 0), pageWidth - margin, ty, { align: 'right' })
  ty += 8
  doc.setDrawColor(...EMERALD)
  doc.setLineWidth(0.5)
  doc.line(totalsX, ty - 4, pageWidth - margin, ty - 4)
  doc.setFontSize(9)
  doc.setTextColor(...EMERALD)
  doc.text('Total a rendir:', totalsX, ty + 1)
  doc.setFontSize(10)
  doc.text(formatCurrency((guide.total_cash_expected || 0) + (guide.total_check_expected || 0)), pageWidth - margin, ty + 1, { align: 'right' })

  // SIGNATURES
  const sigY = summaryStartY + 45;
  
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...DARK_TEXT)
  doc.setDrawColor(...DARK_TEXT)
  doc.setLineWidth(0.3)
  
  const third = usableWidth / 3
  doc.line(margin + 10, sigY, margin + third - 10, sigY)
  doc.text('Firma Despachador', margin + third / 2, sigY + 4, { align: 'center' })

  doc.line(margin + third + 10, sigY, margin + third * 2 - 10, sigY)
  doc.text('Firma Conductor', margin + third + third / 2, sigY + 4, { align: 'center' })

  doc.line(margin + third * 2 + 10, sigY, margin + usableWidth - 10, sigY)
  doc.text('Firma Rendición / Caja', margin + third * 2 + third / 2, sigY + 4, { align: 'center' })

  totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    drawPageFooter(doc, i, totalPages)
  }

  doc.setProperties({
    title: `Guia de Ruta N° ${guide.guide_number || 'BORRADOR'}`,
  })

  return doc.output('blob')
}

export async function downloadRouteGuidePdf(
  guide: RouteGuide,
  filename: string,
  orientation: RouteGuidePdfOrientation = 'portrait',
): Promise<void> {
  const blob = await generateRouteGuidePdfBlob(guide, undefined, undefined, orientation)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
