import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { CommissionSettlementHeader, CommissionSettlementLine } from '@/app/actions/comercial/commissions'

const DARK_HEADER: [number, number, number] = [30, 58, 95]
const EMERALD: [number, number, number] = [16, 185, 129]
const DARK_TEXT: [number, number, number] = [30, 41, 59]
const MID_GRAY: [number, number, number] = [100, 116, 139]
const LIGHT_BORDER: [number, number, number] = [226, 232, 240]
const AMBER: [number, number, number] = [245, 158, 11]
const RED: [number, number, number] = [239, 68, 68]

function formatCurrency(amount: number): string {
  return `$ ${Math.round(amount).toLocaleString('es-CL')}`
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

function drawPageFooter(doc: jsPDF, pageNum: number, totalPages: number, isDraft: boolean): void {
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 15
  doc.setDrawColor(...LIGHT_BORDER)
  doc.setLineWidth(0.3)
  doc.line(margin, 282, pageWidth - margin, 282)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6)
  doc.setTextColor(...MID_GRAY)
  if (isDraft) {
    doc.setTextColor(...AMBER)
    doc.setFontSize(7)
    doc.text('BORRADOR — NO EMITIDO. Este documento es un borrador y no representa una liquidación oficial.', pageWidth / 2, 284.5, { align: 'center' })
    doc.setTextColor(...MID_GRAY)
    doc.setFontSize(6)
  }
  doc.text(`Documento generado desde PetGroup/MYM | Página ${pageNum} de ${totalPages}`, pageWidth / 2, 288.5, { align: 'center' })
}

function addLogo(doc: jsPDF, logoBase64: string | undefined): void {
  if (!logoBase64) return
  try {
    let format = 'PNG'
    if (logoBase64.startsWith('data:image/')) {
      const parts = logoBase64.split(';')[0].split(':')
      const mime = parts.length > 1 ? parts[1].split(';')[0] : ''
      if (mime === 'image/jpeg' || mime === 'image/jpg') format = 'JPEG'
      else if (mime === 'image/png') format = 'PNG'
      else if (mime === 'image/webp') format = 'WEBP'
      else format = mime.split('/')[1]?.toUpperCase() || 'PNG'
    }
    doc.addImage(logoBase64, format, 17, 5, 22, 17)
  } catch { /* proceed without logo */ }
}

export function generateCommissionSettlementPdfBlob(
  header: CommissionSettlementHeader,
  lines: CommissionSettlementLine[],
  logoBase64?: string,
  companyName?: string,
  companyRut?: string,
): Blob {
  const doc = new jsPDF('p', 'mm', 'a4')
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 15
  const usableWidth = pageWidth - 2 * margin
  const isDraft = header.status === 'DRAFT'
  const isIssued = header.status === 'ISSUED'
  let totalPages = 1

  const invoicesCount = new Set(lines.map(l => l.original_invoice_bsale_id || l.invoice_bsale_id)).size
  const linesCount = lines.length
  const ncLinesCount = lines.filter(l => l.line_type === 'CREDIT_NOTE').length
  const netoPositivo = lines.reduce((s, l) => s + (l.net_amount > 0 ? l.net_amount : 0), 0)
  const netoNc = lines.reduce((s, l) => s + (l.line_type === 'CREDIT_NOTE' ? l.net_amount : 0), 0)
  const netoFinal = lines.reduce((s, l) => s + l.net_amount, 0)
  const comisionFinal = lines.reduce((s, l) => s + (l.commission_amount || 0), 0)

  // ── HEADER BAR ──
  const headerHeight = 32
  doc.setFillColor(...DARK_HEADER)
  doc.rect(0, 0, pageWidth, headerHeight, 'F')
  addLogo(doc, logoBase64)

  const cName = companyName || 'DISTRIBUIDORA MYM'
  const cRut = companyRut || ''

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(255, 255, 255)
  doc.text(cName, pageWidth - margin, 8, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  if (cRut) doc.text(`RUT: ${cRut}`, pageWidth - margin, 13, { align: 'right' })

  // ── TITLE + STATUS BADGE ──
  let cursorY = headerHeight + 10
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(...DARK_HEADER)
  const titleStr = 'LIQUIDACIÓN DE COMISIONES'
  doc.text(titleStr, margin, cursorY)

  const statusText = isDraft ? 'BORRADOR' : isIssued ? 'EMITIDA' : 'ANULADA'
  const statusColor = isDraft ? AMBER : isIssued ? EMERALD : RED
  const statusWidth = doc.getTextWidth(statusText) + 4
  const badgeX = pageWidth - margin - statusWidth - 2
  doc.setFillColor(...statusColor)
  doc.roundedRect(badgeX, cursorY - 3, statusWidth, 5.5, 1, 1, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(7)
  doc.text(statusText, badgeX + statusWidth / 2, cursorY + 1.5, { align: 'center' })

  // ── CODE + NUMBER ──
  cursorY += 7
  doc.setTextColor(...MID_GRAY)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  const codeStr = `Código: ${header.settlement_code || '-'}`
  const numStr = header.settlement_number ? `N° ${header.settlement_number}` : 'Pendiente de emisión'
  doc.text(codeStr, margin, cursorY)
  doc.text(numStr, pageWidth - margin, cursorY, { align: 'right' })

  // ── INFO PANEL (collapsible height based on content) ──
  cursorY += 8
  const infoBoxHeight = 32
  doc.setDrawColor(...LIGHT_BORDER)
  doc.setFillColor(248, 250, 252)
  doc.roundedRect(margin, cursorY, usableWidth, infoBoxHeight, 2, 2, 'FD')

  doc.setTextColor(...DARK_TEXT)
  doc.setFontSize(7)
  const col1 = margin + 5
  const col2 = margin + 85
  const col3 = margin + 145
  let iy = cursorY + 5

  doc.setFont('helvetica', 'bold'); doc.text('VENDEDOR', col1, iy)
  doc.setFont('helvetica', 'normal'); doc.text(header.seller_name || '-', col1 + 20, iy)
  doc.setFont('helvetica', 'bold'); doc.text('PERÍODO', col2, iy)
  doc.setFont('helvetica', 'normal'); doc.text(header.period_label || '-', col2 + 18, iy)
  doc.setFont('helvetica', 'bold'); doc.text('CREACIÓN', col3, iy)
  doc.setFont('helvetica', 'normal'); doc.text(formatDate(header.created_at), col3 + 18, iy)

  iy += 5
  doc.setFont('helvetica', 'bold'); doc.text('CÓDIGO', col1, iy)
  doc.setFont('helvetica', 'normal'); doc.text(header.settlement_code || '-', col1 + 20, iy)
  doc.setFont('helvetica', 'bold'); doc.text('ESTADO', col2, iy)
  doc.setFont('helvetica', 'normal'); doc.text(statusText, col2 + 18, iy)
  doc.setFont('helvetica', 'bold'); doc.text('EMISIÓN', col3, iy)
  doc.setFont('helvetica', 'normal'); doc.text(header.issued_at ? formatDate(header.issued_at) : 'Pendiente', col3 + 18, iy)

  iy += 7
  doc.setDrawColor(...LIGHT_BORDER)
  doc.line(margin + 3, iy, pageWidth - margin - 3, iy)

  // ── KPI ROW (inside the same box) ──
  iy += 2.5
  const kpis = [
    { label: 'Facturas', value: String(invoicesCount) },
    { label: 'Líneas', value: String(linesCount) },
    { label: 'Líneas NC', value: String(ncLinesCount) },
    { label: 'Neto +', value: formatCurrency(netoPositivo) },
    { label: 'Neto NC', value: formatCurrency(netoNc) },
    { label: 'Neto final', value: formatCurrency(netoFinal) },
    { label: 'Comisión', value: formatCurrency(comisionFinal) },
    { label: '% efectivo', value: netoFinal ? `${(comisionFinal / netoFinal * 100).toFixed(2)}%` : '0.00%' },
  ]
  const kpiCol = usableWidth / kpis.length
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(6.5)
  kpis.forEach((k, i) => {
    const cx = margin + kpiCol * i + kpiCol / 2
    doc.text(k.label, cx, iy, { align: 'center' })
  })
  iy += 3.5
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  kpis.forEach((k, i) => {
    const cx = margin + kpiCol * i + kpiCol / 2
    doc.text(k.value, cx, iy, { align: 'center' })
  })
  cursorY += infoBoxHeight + 4

  // ── CANCELLATION REASON (only for annulled) ──
  if (!isDraft && !isIssued && header.cancellation_reason) {
    doc.setFillColor(254, 242, 242)
    doc.setDrawColor(...RED)
    doc.roundedRect(margin, cursorY, usableWidth, 8, 1, 1, 'FD')
    doc.setTextColor(...RED)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6.5)
    doc.text(`MOTIVO DE ANULACIÓN: ${header.cancellation_reason}`, margin + 4, cursorY + 5)
    doc.setTextColor(...DARK_TEXT)
    cursorY += 12
  }

  cursorY += 4

  // ── INVOICE SUMMARY TABLE ──
  const invoices = new Map<number | string, {
    invoiceNumber: number | string
    customerName: string
    paymentDate: string
    netoVenta: number
    netoNc: number
    comision: number
    ncCount: number
    ncSkuPartial: boolean
  }>()

  for (const line of lines) {
    const invId = line.original_invoice_bsale_id || line.invoice_bsale_id || 0
    if (!invoices.has(invId)) {
      invoices.set(invId, {
        invoiceNumber: line.original_invoice_number || line.invoice_number || invId,
        customerName: line.customer_name || '',
        paymentDate: line.payment_completed_at || '',
        netoVenta: 0,
        netoNc: 0,
        comision: 0,
        ncCount: 0,
        ncSkuPartial: false,
      })
    }
    const inv = invoices.get(invId)!
    if (line.line_type === 'CREDIT_NOTE') {
      inv.netoNc += line.net_amount
      inv.ncCount++
    } else {
      inv.netoVenta += line.net_amount
    }
    inv.comision += line.commission_amount || 0
  }

  const invoiceRows = Array.from(invoices.values()).map(inv => {
    let obs = '-'
    if (inv.ncCount > 0) {
      obs = inv.ncCount === 1 ? '1 NC asociada' : `${inv.ncCount} NC asociadas`
    }
    return [
      String(inv.invoiceNumber),
      inv.customerName,
      formatDate(inv.paymentDate),
      formatCurrency(inv.netoVenta),
      inv.ncCount > 0 ? formatCurrency(inv.netoNc) : '-',
      formatCurrency(inv.netoVenta + inv.netoNc),
      formatCurrency(inv.comision),
      obs,
    ]
  })

  autoTable(doc, {
    startY: cursorY,
    head: [['Factura', 'Cliente', 'Pago', 'Neto venta', 'Neto NC', 'Neto final', 'Comisión', 'Observación']],
    body: invoiceRows,
    margin: { left: margin, right: margin },
    styles: { fontSize: 6.5, textColor: [...DARK_TEXT], lineColor: [...LIGHT_BORDER], lineWidth: 0.3 },
    headStyles: { fillColor: [...DARK_HEADER], textColor: 255, fontSize: 7, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 16 }, 1: { cellWidth: 50 }, 2: { cellWidth: 16 },
      3: { cellWidth: 22, halign: 'right' }, 4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 22, halign: 'right' }, 6: { cellWidth: 22, halign: 'right' },
      7: { cellWidth: 18, halign: 'center' },
    },
    didDrawPage: () => {
      drawPageFooter(doc, doc.getCurrentPageInfo().pageNumber, totalPages, isDraft)
    },
  })

  // ── TOTALS BOX ──
  const finalY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6
  doc.setDrawColor(...LIGHT_BORDER)
  doc.setFillColor(248, 250, 252)
  const boxH = 24
  doc.roundedRect(margin, finalY, usableWidth, boxH, 2, 2, 'FD')

  const totals = [
    { label: 'Neto positivo', value: formatCurrency(netoPositivo), bold: false },
    { label: 'Neto NC', value: formatCurrency(netoNc), bold: false },
    { label: '', value: '', bold: false },
    { label: 'NETO FINAL', value: formatCurrency(netoFinal), bold: true },
    { label: 'COMISIÓN TOTAL', value: formatCurrency(comisionFinal), bold: true, color: [...EMERALD] as [number, number, number] },
  ]

  let ty = finalY + 4.5
  for (const t of totals) {
    if (!t.label) { ty += 1.5; continue }
    doc.setFont('helvetica', t.bold ? 'bold' : 'normal')
    doc.setFontSize(t.bold ? 9 : 7)
    if (t.color) doc.setTextColor(...t.color)
    else doc.setTextColor(t.bold ? DARK_TEXT[0] : MID_GRAY[0], t.bold ? DARK_TEXT[1] : MID_GRAY[1], t.bold ? DARK_TEXT[2] : MID_GRAY[2])
    doc.text(t.label, margin + 8, ty)
    doc.text(t.value, pageWidth - margin - 8, ty, { align: 'right' })
    ty += t.bold ? 6 : 5
  }

  doc.setTextColor(...DARK_TEXT)

  // ── FOOTER ──
  totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    drawPageFooter(doc, i, totalPages, isDraft)
  }

  doc.setProperties({
    title: `Liquidación de Comisiones ${header.settlement_code || ''}`,
    subject: `Liquidación ${header.settlement_code || ''} - ${header.seller_name || ''}`,
    author: cName,
  })

  return doc.output('blob')
}
