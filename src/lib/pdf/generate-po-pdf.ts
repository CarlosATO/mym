import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

interface POItem {
  line_number: number
  item_type: string
  product_id?: string
  product_description: string
  unit?: string
  quantity: number
  unit_price: number
  discount_percent: number
  discount_amount: number
  tax_rate: number
  tax_amount: number
  line_total: number
  warehouse_name?: string
  cost_center?: string
  notes?: string
}

interface PODetail {
  po: {
    id: string
    correlative: string
    issue_date: string
    required_date?: string
    supplier_name: string
    supplier_rut?: string
    supplier_contact?: string
    supplier_email?: string
    supplier_phone?: string
    supplier_address?: string
    warehouse_name?: string
    po_type: string
    currency: string
    payment_terms?: string
    requester_name: string
    authorized_name?: string
    notes?: string
    net_total: number
    discount_total: number
    tax_total: number
    exempt_total: number
    grand_total: number
    status: string
    receipt_status?: string
    invoice_status?: string
    created_at: string
    company_name?: string | null
    company_rut?: string | null
    company_logo_url?: string | null
    company_phone?: string | null
    company_email?: string | null
    company_address?: string | null
    company_giro?: string | null
    company_region?: string | null
    company_comuna?: string | null
    company_city?: string | null
    company_purchase_terms?: string | null
    company_document_footer?: string | null
  }
  items: POItem[]
}

const DARK_HEADER: [number, number, number] = [30, 58, 95]
const EMERALD: [number, number, number] = [16, 185, 129]
const DARK_TEXT: [number, number, number] = [30, 41, 59]
const LIGHT_GRAY: [number, number, number] = [248, 250, 252]
const WHITE: [number, number, number] = [255, 255, 255]
const MID_GRAY: [number, number, number] = [100, 116, 139]
const LIGHT_BORDER: [number, number, number] = [226, 232, 240]
const GREEN: [number, number, number] = [16, 185, 129]
const AMBER: [number, number, number] = [245, 158, 11]
const RED: [number, number, number] = [239, 68, 68]

function formatCurrency(amount: number): string {
  return `$ ${Math.round(amount).toLocaleString('es-CL')}`
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  return `${day}/${month}/${year}`
}

function getStatusColor(status: string): [number, number, number] {
  const s = status.toLowerCase()
  if (s === 'aprobada' || s === 'approved' || s === 'completada' || s === 'completed') return GREEN
  if (s === 'pendiente' || s === 'pending') return AMBER
  if (s === 'rechazada' || s === 'rejected' || s === 'cancelada' || s === 'cancelled') return RED
  return MID_GRAY
}

function getStatusText(status: string): string {
  const map: Record<string, string> = {
    borrador: 'Borrador',
    draft: 'Borrador',
    pendiente: 'Pendiente',
    pending: 'Pendiente',
    aprobada: 'Aprobada',
    approved: 'Aprobada',
    rechazada: 'Rechazada',
    rejected: 'Rechazada',
    cancelada: 'Cancelada',
    cancelled: 'Cancelada',
    completada: 'Completada',
    completed: 'Completada',
  }
  return map[status.toLowerCase()] || status
}

function drawPageFooter(doc: jsPDF, pageNum: number, totalPages: number, footerText?: string | null): void {
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 15

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6)
  doc.setTextColor(...MID_GRAY)
  doc.setDrawColor(...LIGHT_BORDER)
  doc.setLineWidth(0.3)
  doc.line(margin, 282, pageWidth - margin, 282)

  if (footerText) {
    const splitFooter = doc.splitTextToSize(footerText, pageWidth - 2 * margin)
    let y = 280.5 - (splitFooter.length - 1) * 2.5
    for (const line of splitFooter) {
      doc.text(line, margin, y)
      y += 2.5
    }
  }

  doc.text(
    `Documento generado el ${formatDate(new Date().toISOString())} | Página ${pageNum} de ${totalPages}`,
    pageWidth / 2,
    288.5,
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

    // Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      const width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19]
      const height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23]
      return { width, height }
    }

    // Check JPEG signature: FF D8
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let i = 2
      while (i < buffer.length) {
        if (i + 4 > buffer.length) break
        const marker = (buffer[i] << 8) | buffer[i + 1]
        if ((marker & 0xFF00) !== 0xFF00) {
          i++
          continue
        }
        i += 2
        if (marker === 0xFFD9) break // EOI
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

export function generatePdfBlob(detail: PODetail, logoBase64?: string): Blob {
  const doc = new jsPDF('p', 'mm', 'a4')
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 15
  const usableWidth = pageWidth - 2 * margin
  let cursorY = margin

  let totalPages = 1

  // ── HEADER BAR ──
  const headerHeight = 32
  doc.setFillColor(...DARK_HEADER)
  doc.rect(0, 0, pageWidth, headerHeight, 'F')

  if (logoBase64) {
    try {
      let format = 'PNG'
      if (logoBase64.startsWith('data:image/')) {
        const parts = logoBase64.split(';')[0].split(':')
        const mime = parts.length > 1 ? parts[1].split(';')[0] : ''
        if (mime === 'image/jpeg' || mime === 'image/jpg') {
          format = 'JPEG'
        } else if (mime === 'image/png') {
          format = 'PNG'
        } else if (mime === 'image/webp') {
          format = 'WEBP'
        } else {
          format = mime.split('/')[1]?.toUpperCase() || 'PNG'
        }
      }

      let logoW = 20
      let logoH = 17

      const imgSize = getImageSizeFromBase64(logoBase64)
      if (imgSize) {
        const aspectRatio = imgSize.width / imgSize.height
        // Contenedor máximo: 120 pt (42.33 mm) de ancho por 55 pt (19.4 mm) de alto
        const maxW = 42.33
        const maxH = 19.4
        if (aspectRatio > maxW / maxH) {
          logoW = maxW
          logoH = maxW / aspectRatio
        } else {
          logoH = maxH
          logoW = maxH * aspectRatio
        }
      }

      // Alinear logo arriba izquierda dentro del header azul
      doc.addImage(logoBase64, format, margin + 2, 5, logoW, logoH)
    } catch (err) {
      console.error('Error adding logo to PDF:', err)
      // proceed without logo
    }
  }

  const compName = detail.po.company_name || 'DISTRIBUIDORA MYM'
  const compRut = detail.po.company_rut || '76.123.456-7'
  const compPhone = detail.po.company_phone || '+56 2 1234 5678'
  const compEmail = detail.po.company_email || 'contacto@mym.cl'
  const compGiro = detail.po.company_giro ? `Giro: ${detail.po.company_giro}` : ''
  const compAddr = [
    detail.po.company_address,
    detail.po.company_comuna,
    detail.po.company_city,
    detail.po.company_region
  ].filter(Boolean).join(', ')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(...WHITE)
  doc.text(compName, pageWidth - margin, 8, { align: 'right' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  let headerY = 13
  doc.text(`RUT: ${compRut} | Tel: ${compPhone} | Email: ${compEmail}`, pageWidth - margin, headerY, { align: 'right' })
  
  if (compGiro) {
    headerY += 4.2
    doc.text(compGiro, pageWidth - margin, headerY, { align: 'right' })
  }
  
  if (compAddr) {
    headerY += 4.2
    doc.text(compAddr, pageWidth - margin, headerY, { align: 'right' })
  }

  // ── TITLE ──
  cursorY = headerHeight + 8
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.setTextColor(...DARK_HEADER)
  doc.text('ORDEN DE COMPRA', margin, cursorY)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...MID_GRAY)
  doc.text(`N° ${detail.po.correlative || ''}`, margin, cursorY + 5.5)

  // Status badge
  const statusText = getStatusText(detail.po.status)
  const statusColor = getStatusColor(detail.po.status)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  const badgeTextWidth = doc.getTextWidth(statusText)
  const badgeWidth = badgeTextWidth + 8
  const badgeX = pageWidth - margin - badgeWidth
  const badgeY = cursorY - 4
  doc.setFillColor(...statusColor)
  doc.roundedRect(badgeX, badgeY, badgeWidth, 6.5, 2, 2, 'F')
  doc.setTextColor(...WHITE)
  doc.text(statusText, badgeX + badgeWidth / 2, badgeY + 4.5, { align: 'center' })

  cursorY += 12

  // ── EMERALD DIVIDER ──
  doc.setDrawColor(...EMERALD)
  doc.setLineWidth(1.2)
  doc.line(margin, cursorY, pageWidth - margin, cursorY)
  cursorY += 6

  // ── TWO-COLUMN INFO ──
  const leftColX = margin
  const rightColX = margin + usableWidth / 2 + 3

  // Left: Supplier
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...EMERALD)
  doc.text('PROVEEDOR', leftColX, cursorY)

  const supplierRows: [string, string][] = [
    ['Nombre:', detail.po.supplier_name],
    ['RUT:', detail.po.supplier_rut || '-'],
    ['Contacto:', detail.po.supplier_contact || '-'],
    ['Email:', detail.po.supplier_email || '-'],
    ['Teléfono:', detail.po.supplier_phone || '-'],
    ['Dirección:', detail.po.supplier_address || '-'],
  ]

  doc.setFontSize(8)
  doc.setTextColor(...DARK_TEXT)
  let leftY = cursorY + 5
  for (const [label, value] of supplierRows) {
    doc.setFont('helvetica', 'bold')
    doc.text(label, leftColX, leftY)
    const labelW = doc.getTextWidth(label)
    doc.setFont('helvetica', 'normal')
    const maxValWidth = usableWidth / 2 - 4 - labelW - 3
    const text = doc.splitTextToSize(value || '-', maxValWidth)
    doc.text(text, leftColX + labelW + 2, leftY)
    leftY += text.length > 1 ? 4.5 * text.length : 4.5
  }

  // Right: PO Details
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...EMERALD)
  doc.text('DATOS DE LA OC', rightColX, cursorY)

  const detailRows: [string, string][] = [
    ['Tipo:', detail.po.po_type || '-'],
    ['Moneda:', detail.po.currency || '-'],
    ['Fecha Emisión:', formatDate(detail.po.issue_date)],
    ['Fecha Requerida:', detail.po.required_date ? formatDate(detail.po.required_date) : '-'],
    ['Bodega Destino:', detail.po.warehouse_name || '-'],
    ['Solicitante:', detail.po.requester_name],
    ['Autorizado por:', detail.po.authorized_name || '-'],
    ['Cond. Pago:', detail.po.payment_terms || '-'],
  ]

  doc.setFontSize(8)
  doc.setTextColor(...DARK_TEXT)
  let rightY = cursorY + 5
  for (const [label, value] of detailRows) {
    doc.setFont('helvetica', 'bold')
    doc.text(label, rightColX, rightY)
    const labelW = doc.getTextWidth(label)
    doc.setFont('helvetica', 'normal')
    const maxValWidth = usableWidth / 2 - 4 - labelW - 3
    const text = doc.splitTextToSize(value || '-', maxValWidth)
    doc.text(text, rightColX + labelW + 2, rightY)
    rightY += text.length > 1 ? 4.5 * text.length : 4.5
  }

  cursorY = Math.max(leftY, rightY) + 6

  // ── ITEMS TABLE ──
  const tableHeaders = [
    'Línea',
    'Tipo',
    'Producto / Servicio',
    'Unidad',
    'Cant.',
    'P.Unitario',
    'Dto%',
    'Descuento',
    'IVA%',
    'Total Línea',
  ]

  const tableBody = detail.items.map((item) => [
    item.line_number.toString(),
    item.item_type,
    item.product_description,
    item.unit || '-',
    item.quantity.toString(),
    formatCurrency(item.unit_price),
    item.discount_percent ? `${item.discount_percent}%` : '-',
    item.discount_amount ? formatCurrency(item.discount_amount) : '-',
    item.tax_rate ? `${item.tax_rate}%` : '-',
    formatCurrency(item.line_total),
  ])

  autoTable(doc, {
    head: [tableHeaders],
    body: tableBody,
    startY: cursorY,
    margin: { left: margin, right: margin },
    styles: {
      font: 'helvetica',
      fontSize: 7,
      cellPadding: { top: 2, right: 2, bottom: 2, left: 2 },
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: [30, 58, 95],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7,
      halign: 'center',
    },
    columnStyles: {
      0: { halign: 'center', cellWidth: 10 },
      1: { halign: 'center', cellWidth: 12 },
      2: { cellWidth: 55 },
      3: { halign: 'center', cellWidth: 11 },
      4: { halign: 'center', cellWidth: 11 },
      5: { halign: 'right', cellWidth: 18 },
      6: { halign: 'center', cellWidth: 9 },
      7: { halign: 'right', cellWidth: 18 },
      8: { halign: 'center', cellWidth: 9 },
      9: { halign: 'right', cellWidth: 20 },
    },
    alternateRowStyles: {
      fillColor: [248, 250, 252],
    },
    didDrawPage: (data) => {
      totalPages = doc.getNumberOfPages()
      drawPageFooter(doc, data.pageNumber, totalPages, detail.po.company_document_footer)
    },
  })

  const finalY = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY) ?? cursorY + 10

  // ── TOTALS ──
  let totalsY = finalY + 8

  if (totalsY > pageHeight - 50) {
    doc.addPage()
    totalsY = 20
  }

  const totalsWidth = 80
  const totalsX = pageWidth - margin - totalsWidth

  // Background box
  doc.setFillColor(...LIGHT_GRAY)
  doc.roundedRect(totalsX - 3, totalsY - 3, totalsWidth + 6, 34, 3, 3, 'F')

  const totalsData: [string, string, boolean][] = [
    ['Neto', formatCurrency(detail.po.net_total), false],
    ['Descuentos', formatCurrency(detail.po.discount_total), false],
    ['IVA', formatCurrency(detail.po.tax_total), false],
    ['TOTAL', formatCurrency(detail.po.grand_total), true],
  ]

  let ty = totalsY
  for (let i = 0; i < totalsData.length; i++) {
    const [label, value, isBold] = totalsData[i]
    if (isBold) {
      doc.setDrawColor(...EMERALD)
      doc.setLineWidth(0.5)
      doc.line(totalsX, ty + 1, totalsX + totalsWidth, ty + 1)
      ty += 3
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.setTextColor(...EMERALD)
    } else {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(...DARK_TEXT)
    }
    doc.text(label, totalsX + 2, ty + 4)
    doc.text(value, totalsX + totalsWidth - 2, ty + 4, { align: 'right' })
    ty += 7
  }

  // ── NOTES & CONDITIONS ──
  let bottomY = ty + 10
  
  const checkPageOverflow = (heightNeeded: number) => {
    if (bottomY + heightNeeded > pageHeight - 25) {
      doc.addPage()
      bottomY = 20
    }
  }

  if (detail.po.notes) {
    const splitNotes = doc.splitTextToSize(detail.po.notes, usableWidth)
    const notesHeight = 5 + splitNotes.length * 4.5
    checkPageOverflow(notesHeight + 8)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...EMERALD)
    doc.text('OBSERVACIONES', margin, bottomY)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...DARK_TEXT)
    doc.text(splitNotes, margin, bottomY + 5)
    bottomY += notesHeight + 6
  }

  if (detail.po.company_purchase_terms) {
    const splitTerms = doc.splitTextToSize(detail.po.company_purchase_terms, usableWidth)
    const termsHeight = 5 + splitTerms.length * 4.5
    checkPageOverflow(termsHeight + 8)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...EMERALD)
    doc.text('CONDICIONES DE COMPRA', margin, bottomY)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...DARK_TEXT)
    doc.text(splitTerms, margin, bottomY + 5)
    bottomY += termsHeight + 6
  }

  // ── FINAL PAGE FOOTER ──
  totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    drawPageFooter(doc, i, totalPages, detail.po.company_document_footer)
  }

  // Document properties
  doc.setProperties({
    title: `Orden de Compra N° ${detail.po.correlative || ''}`,
    subject: `OC ${detail.po.correlative || ''} - ${detail.po.supplier_name}`,
    author: compName,
  })

  return doc.output('blob')
}

export async function downloadPOBooklet(detail: PODetail, filename: string, preloadedLogo?: string): Promise<void> {
  let logoBase64 = preloadedLogo

  if (!logoBase64) {
    const urlsToTry = [
      detail.po.company_logo_url,
      '/logo-transparent.png'
    ].filter(Boolean) as string[]

    for (const url of urlsToTry) {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Fetch failed for ${url}`)
        const blob = await response.blob()
        logoBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
        break // Stop on first successful load
      } catch (err) {
        console.error(`Error loading logo from ${url}:`, err)
      }
    }
  }

  const blob = generatePdfBlob(detail, logoBase64)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
